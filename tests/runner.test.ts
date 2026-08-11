import { describe, expect, it } from "vitest";
import {
  buildCommand,
  buildPrompt,
  describeClaudeEvent,
  describeNestedPart,
  humanizeRuntimeText,
  inferReason,
  orchestratorRules
} from "../src/studio/runner.js";

describe("runtime command", () => {
  const base = { provider: "anthropic" as const, prompt: "Write the book.", cwd: process.cwd() };

  it("runs Claude Code headless on the orchestrator", () => {
    const { file, args } = buildCommand("claude-code", { ...base, model: "claude-opus-5" });
    expect(file).toBe("claude");
    expect(args).toContain("--print");
    expect(args[args.indexOf("--agent") + 1]).toBe("book-orchestrator");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(args[args.length - 1]).toBe("Write the book.");
  });

  it("resumes Claude Code in the saved provider session", () => {
    const { args } = buildCommand("claude-code", { ...base, resumeSessionId: "session-123" });
    expect(args[args.indexOf("--resume") + 1]).toBe("session-123");
  });

  it("passes the tool allowlist as one value so it cannot swallow the prompt", () => {
    const { args } = buildCommand("claude-code", base);
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed.split(",")).toContain("Read");
    expect(args.filter((arg) => arg === "Read")).toHaveLength(0);
  });

  it("confines writing to the workspaces the agent file allows", () => {
    const rules = orchestratorRules(process.cwd());
     expect(rules).toContain("Edit(workspaces/**/artifacts/**)");
     expect(rules).not.toContain("Edit(workspaces/**)");
    // Only Edit rules are matched by file permission checks, so a Write rule
    // would silently grant nothing and every write would be refused.
    expect(rules.some((rule) => rule.startsWith("Write("))).toBe(false);
    expect(rules).not.toContain("Edit");
  });

  it("never hands over a mode that would auto-approve edits anywhere", () => {
    const { args } = buildCommand("claude-code", base);
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("acceptEdits");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("grants only the bash commands the agent file already allows", () => {
    const rules = orchestratorRules(process.cwd());
    expect(rules).toContain("Bash(npm test)");
    expect(rules).toContain("Bash(git status:*)");
    expect(rules).not.toContain("Bash(*)");
    expect(rules.some((rule) => /python|node -e|curl/.test(rule))).toBe(false);
    // The task allowlist sits directly below bash: in the same block.
    expect(rules.some((rule) => rule.includes("book-") || rule.includes("sub-"))).toBe(false);
  });

  it("addresses the model by provider for OpenCode", () => {
    const { file, args } = buildCommand("opencode", { ...base, provider: "openai", model: "gpt-5.6-sol" });
    expect(file).toBe("opencode");
    expect(args[0]).toBe("run");
    expect(args[args.indexOf("-m") + 1]).toBe("openai/gpt-5.6-sol");
  });

  it("resumes OpenCode in the saved provider session", () => {
    const { args } = buildCommand("opencode", { ...base, provider: "openai", resumeSessionId: "session-456" });
    expect(args[args.indexOf("--session") + 1]).toBe("session-456");
  });

  it("tells the agent which book and carries the author's note", () => {
    const prompt = buildPrompt({ projectName: "The Tide House", slug: "the-tide-house", note: "Start at chapter one." });
    expect(prompt).toContain("The Tide House");
    expect(prompt).toContain("workspaces/the-tide-house/project.json");
    expect(prompt).toContain("Start at chapter one.");
    expect(prompt).toContain("CANON_QUILL_PROGRESS");
    expect(prompt).toContain("formatting-references.md");
    expect(prompt).toContain("Drive-extracted references");
    expect(prompt).toContain("Never edit or write anything under logs");
    expect(buildPrompt({ projectName: "The Tide House", slug: "the-tide-house", resumeSessionId: "session-123" }))
      .toContain("resuming the provider conversation");
  });

  it("carries unfinished delegated conversations into a resumed prompt", () => {
    const prompt = buildPrompt({
      projectName: "The Tide House",
      slug: "the-tide-house",
      resumeSessionId: "session-123",
      resumeDelegatedSessions: [{
        sessionId: "handoff-1",
        conversationId: "agent-1",
        agent: "book-08-chapter-editing",
        depth: 1,
        status: "working",
        runtime: "claude-code"
      }]
    });
    expect(prompt).toContain("agent-1");
    expect(prompt).toContain("Continue those conversations");
  });

  it("forbids delegated scratch files outside the workspace", () => {
    expect(buildPrompt({ projectName: "The Tide House", slug: "the-tide-house" })).toContain("Never write scratch files to /tmp");
  });
});

describe("reading the runtime stream", () => {
  it("describes nested agent text and tool activity without exposing tool output", () => {
    expect(describeNestedPart({ type: "text", text: "Reading the selected material." })).toBe("Reading the selected material.");
    expect(describeNestedPart({ type: "tool", tool: "Read", state: { status: "running", input: { file_path: "/tmp/source.md" } } }))
      .toBe("Reading source.md.");
    expect(describeNestedPart({ type: "reasoning", text: "private reasoning" })).toBeNull();
  });

  it("hides cache filenames from the runtime activity log", () => {
    expect(humanizeRuntimeText("Reading 1a7c6Etd4EvPmW-Qdi3Aaqrr0vCbJZ-wj1ukfLfbKWQI.json.")).toBe("Reading a selected source document.");
  });

  it("hides historical contract times and shell details", () => {
    expect(humanizeRuntimeText("Entry contract for `chapter_drafting` is satisfied: author unlocked writing at 08:46 (`writing_unlocked`)."))
      .toBe("The saved writing contract and required preparation files are present.");
    expect(humanizeRuntimeText("Running ls -la /workspace/book/.")).toBe("Checking workspace contents.");
    expect(humanizeRuntimeText("Using Agent.")).toBe("Handing over to a specialist.");
    expect(humanizeRuntimeText("Done. Cost so far: $11.01.")).toBe("Done.");
  });

  it("turns orchestrator CLI noise into short activity labels", () => {
    expect(humanizeRuntimeText('✱ Glob "workspaces/example/artifacts/*" in . · 3 matches')).toBe("Searching the workspace.");
    expect(humanizeRuntimeText("[•] Delegate the next phase")).toBe("Delegating the next phase");
  });

  it("turns tool calls into something a person can follow", () => {
    const described = describeClaudeEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Building the chapter plan." },
          { type: "tool_use", id: "task-1", name: "Task", input: { subagent_type: "book-04-preparation", description: "Draft the plan" } },
          { type: "tool_use", name: "Write", input: { file_path: "/books/the-tide-house/artifacts/plan.md" } }
        ]
      }
    });

    expect(described.map((event) => event.text)).toEqual([
      "Building the chapter plan.",
      "Handing over to book-04-preparation: Draft the plan.",
      "Writing plan.md."
    ]);
    expect(described[1].kind).toBe("step");
    expect(described[1].sessionId).toBe("task-1");
  });

  it("keeps delegation tool names out of the author-facing activity", () => {
    const [event] = describeClaudeEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Agent", input: { agent: "book-04-preparation" } }] }
    });
    expect(event.text).toContain("Handing over to book-04-preparation");
  });

  it("recognizes an explicit agent completion signal", () => {
    expect(humanizeRuntimeText("done: true")).toBe("Finished.");
  });

  it("reports a failed step as an error", () => {
    const described = describeClaudeEvent({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "file not found" }] }
    });
    expect(described).toHaveLength(1);
    expect(described[0].kind).toBe("error");
    expect(described[0].text).toContain("file not found");
  });

  it("closes on the result, with what it cost", () => {
    const [done] = describeClaudeEvent({ type: "result", subtype: "success", total_cost_usd: 1.234 });
    expect(done.kind).toBe("system");
    expect(done.text).toContain("$1.23");
  });

  it("hides provider cost telemetry for subscription runs", () => {
    const [done] = describeClaudeEvent({ type: "result", subtype: "success", total_cost_usd: 11.01 }, { includeCost: false });
    expect(done.text).toBe("Done.");
  });

  it("captures the provider session from Claude initialization", () => {
    const [ready] = describeClaudeEvent({ type: "system", subtype: "init", model: "claude-opus-5", session_id: "session-789" });
    expect(ready.runtimeSessionId).toBe("session-789");
  });

  it("ignores events with nothing to say", () => {
    expect(describeClaudeEvent({ type: "stream_event" })).toEqual([]);
    expect(describeClaudeEvent(null)).toEqual([]);
  });
});

describe("why a run stopped", () => {
  it("maps provider trouble onto the halt reasons the board knows", () => {
    expect(inferReason("Error: 429 rate limit exceeded")).toBe("rate_limited");
    expect(inferReason("You've hit your session limit. Reset and try again.")).toBe("rate_limited");
    expect(inferReason("Your credit balance is too low")).toBe("no_credit");
    expect(inferReason("invalid api key")).toBe("invalid_credentials");
    expect(inferReason("Overloaded")).toBe("provider_error");
    expect(inferReason("it just stopped")).toBe("other");
  });
});
