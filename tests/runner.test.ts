import { describe, expect, it } from "vitest";
import {
  buildCommand,
  buildPrompt,
  describeClaudeEvent,
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

  it("passes the tool allowlist as one value so it cannot swallow the prompt", () => {
    const { args } = buildCommand("claude-code", base);
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed.split(",")).toContain("Read");
    expect(args.filter((arg) => arg === "Read")).toHaveLength(0);
  });

  it("confines writing to the workspaces the agent file allows", () => {
    const rules = orchestratorRules(process.cwd());
    expect(rules).toContain("Edit(workspaces/**)");
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

  it("tells the agent which book and carries the author's note", () => {
    const prompt = buildPrompt({ projectName: "The Tide House", slug: "the-tide-house", note: "Start at chapter one." });
    expect(prompt).toContain("The Tide House");
    expect(prompt).toContain("workspaces/the-tide-house/project.json");
    expect(prompt).toContain("Start at chapter one.");
  });
});

describe("reading the runtime stream", () => {
  it("turns tool calls into something a person can follow", () => {
    const described = describeClaudeEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Building the chapter plan." },
          { type: "tool_use", name: "Task", input: { subagent_type: "book-04-preparation", description: "Draft the plan" } },
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

  it("ignores events with nothing to say", () => {
    expect(describeClaudeEvent({ type: "stream_event" })).toEqual([]);
    expect(describeClaudeEvent(null)).toEqual([]);
  });
});

describe("why a run stopped", () => {
  it("maps provider trouble onto the halt reasons the board knows", () => {
    expect(inferReason("Error: 429 rate limit exceeded")).toBe("rate_limited");
    expect(inferReason("Your credit balance is too low")).toBe("no_credit");
    expect(inferReason("invalid api key")).toBe("invalid_credentials");
    expect(inferReason("Overloaded")).toBe("provider_error");
    expect(inferReason("it just stopped")).toBe("other");
  });
});
