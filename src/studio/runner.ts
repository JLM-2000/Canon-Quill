// Spawns the runtime the author chose on the orchestrator agent, and turns its
// output into lines a person can follow. No credential is read or passed here:
// the runtime uses its own login, as it does when started by hand.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "./redact.js";

export type RuntimeId = "claude-code" | "opencode";
export type ProviderId = "anthropic" | "openai";

export interface RunEvent {
  seq: number;
  at: string;
  kind: "system" | "step" | "note" | "error";
  text: string;
}

export interface RunSnapshot {
  active: boolean;
  runtime: RuntimeId | null;
  command: string | null;
  startedAt: string | null;
  events: RunEvent[];
  latest: number;
  progress: RunProgress | null;
}

export type RunProgressPhase =
  | "gathering_info"
  | "preparing_characters"
  | "planning_chapters"
  | "writing_chapter"
  | "editing_chapter"
  | "validating_chapter"
  | "compiling_book"
  | "finishing";

export interface RunProgress {
  phase: RunProgressPhase;
  label: string;
  percent: number;
  detail: string;
  chapter: number | null;
}

export interface StartOptions {
  slug: string;
  projectName: string;
  provider: ProviderId;
  model?: string | null;
  chapter?: number | null;
  note?: string;
  cwd?: string;
  onExit: (outcome: RunOutcome) => void;
  onProgress?: (progress: RunProgress) => void;
  onEvent?: (event: RunEvent) => void;
}

export interface RunOutcome {
  ok: boolean;
  code: number | null;
  signal: string | null;
  reason: "cancelled" | "no_credit" | "rate_limited" | "invalid_credentials" | "provider_error" | "other" | null;
  detail: string | null;
  /** Everything the run said, for the phase log. */
  trace: RunEvent[];
  progress: RunProgress | null;
}

const AGENT = "book-orchestrator";
const MAX_EVENTS = 4000;

interface ActiveRun {
  slug: string;
  child: ChildProcess | null;
  runtime: RuntimeId;
  command: string;
  startedAt: string;
  stopping: boolean;
  onProgress?: (progress: RunProgress) => void;
  onEvent?: (event: RunEvent) => void;
}

let active: ActiveRun | null = null;
let events: RunEvent[] = [];
let seq = 0;
let lastRuntime: RuntimeId | null = null;
let lastCommand: string | null = null;
let lastStartedAt: string | null = null;
let progress: RunProgress | null = null;

/** Tests and dry runs record the command without starting anything. */
function dryRun(): boolean {
  return process.env.CANON_QUILL_RUNTIME_DRYRUN === "1";
}

export function isRunning(): boolean {
  return active !== null;
}

export function runSnapshot(since = 0): RunSnapshot {
  return {
    active: active !== null,
    runtime: active?.runtime ?? lastRuntime,
    command: active?.command ?? lastCommand,
    startedAt: active?.startedAt ?? lastStartedAt,
    events: events.filter((event) => event.seq > since),
    latest: seq,
    progress
  };
}

function emit(kind: RunEvent["kind"], text: string): void {
  const stripped = stripAnsi(text);
  const explicit = readProgress(stripped);
  const update = explicit ?? inferProgress(stripped);
  if (update) setProgress(update, Boolean(explicit));
  const clean = humanizeRuntimeText(redactSensitiveText(removeProgressMarker(stripped))).trim();
  if (!clean) return;
  const event = { seq: ++seq, at: new Date().toISOString(), kind, text: clean.slice(0, 600) };
  events.push(event);
  active?.onEvent?.(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
}

function setProgress(update: RunProgress, notify = true): void {
  const phaseChanged = progress?.phase !== update.phase;
  const next = {
    ...update,
    percent: Math.max(progress?.percent ?? 0, Math.min(100, update.percent)),
    detail: redactSensitiveText(update.detail).slice(0, 240),
    chapter: update.chapter ?? progress?.chapter ?? null
  };
  if (progress && next.phase === progress.phase && next.percent === progress.percent && next.detail === progress.detail) return;
  progress = next;
  if (notify || phaseChanged) active?.onProgress?.(next);
}

const PROGRESS_PHASES: Record<RunProgressPhase, { label: string; percent: number }> = {
  gathering_info: { label: "Gathering information", percent: 12 },
  preparing_characters: { label: "Preparing characters", percent: 28 },
  planning_chapters: { label: "Planning chapters", percent: 42 },
  writing_chapter: { label: "Writing the chapter", percent: 62 },
  editing_chapter: { label: "Editing the chapter", percent: 76 },
  validating_chapter: { label: "Checking the chapter", percent: 88 },
  compiling_book: { label: "Compiling the book", percent: 94 },
  finishing: { label: "Finishing up", percent: 98 }
};

function readProgress(text: string): RunProgress | null {
  const match = /CANON_QUILL_PROGRESS\s+phase=([a-z_]+)(?:\s+percent=(\d+))?(?:\s+chapter=(\d+))?(?:\s+detail=(.*))?/i.exec(text);
  if (!match || !(match[1].toLowerCase() in PROGRESS_PHASES)) return null;
  const phase = match[1].toLowerCase() as RunProgressPhase;
  const defaults = PROGRESS_PHASES[phase];
  return {
    phase,
    label: defaults.label,
    percent: Number(match[2] ?? defaults.percent),
    detail: (match[4] ?? defaults.label).trim(),
    chapter: match[3] ? Number(match[3]) : null
  };
}

function removeProgressMarker(text: string): string {
  return text.replace(/CANON_QUILL_PROGRESS\s+phase=[a-z_]+(?:\s+percent=\d+)?(?:\s+chapter=\d+)?(?:\s+detail=.*)?/ig, "");
}

function inferProgress(text: string): RunProgress | null {
  const lower = text.toLowerCase();
  const chapterMatch = /chapter[\s-]*(\d+)/i.exec(text);
  const chapter = chapterMatch ? Number(chapterMatch[1]) : null;
  let phase: RunProgressPhase | null = null;
  if (/finalization|final (?:book|manuscript)|compil/.test(lower)) phase = "compiling_book";
  else if (/validat|proofread|continuity check|quality gate/.test(lower)) phase = "validating_chapter";
  else if (/edit|revise/.test(lower)) phase = "editing_chapter";
  else if (/chapter plan|outline|structure|planning/.test(lower)) phase = "planning_chapters";
  else if (/draft(?:ing)? chapter|write (?:chapter|prose)|writing (?:chapter|prose)/.test(lower)) phase = "writing_chapter";
  else if (/character|cast|relationship/.test(lower)) phase = "preparing_characters";
  else if (/read|search|reference|canon|project/.test(lower)) phase = "gathering_info";
  if (!phase) return null;
  const defaults = PROGRESS_PHASES[phase];
  return { phase, label: defaults.label, percent: defaults.percent, detail: text.trim().slice(0, 240), chapter };
}

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

export function humanizeRuntimeText(text: string): string {
  const trimmed = text.trim();
  if (/^(Reading|Writing|Editing)\s+(?:.*[\\/])?[A-Za-z0-9_-]{20,}\.json\.?$/i.test(trimmed)) {
    const action = /^(Reading|Writing|Editing)/i.exec(trimmed)?.[1] ?? "Reading";
    return `${action} a selected source document.`;
  }
  if (/^(Reading|Writing|Editing)\s+.*(?:drive-cache|preparation-manifest|project-brief|book-bible|character-bible|world-bible|plot-bible|style-guide|chapter-plan|validation-rubric)/i.test(trimmed)) {
    const action = /^(Reading|Writing|Editing)/i.exec(trimmed)?.[1] ?? "Reading";
    return `${action} the preparation material.`;
  }
  return text;
}

export function selectRuntime(provider: ProviderId): RuntimeId | null {
  const claude = onPath("claude");
  const opencode = onPath("opencode");
  // Claude Code only speaks to Anthropic; OpenCode speaks to both.
  if (provider === "openai") return opencode ? "opencode" : null;
  if (claude) return "claude-code";
  return opencode ? "opencode" : null;
}

export function runtimeLabel(runtime: RuntimeId): string {
  return runtime === "claude-code" ? "Claude Code" : "OpenCode";
}

function onPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${binary}.cmd`, `${binary}.exe`, binary] : [binary];
  return dirs.some((dir) => names.some((name) => existsSync(path.join(dir, name))));
}

export function buildPrompt(options: { projectName: string; slug: string; note?: string }): string {
  const lines = [
    `Continue the Canon Quill book "${options.projectName}" (workspace ${options.slug}).`,
    `Read workspaces/${options.slug}/project.json first, then carry the book forward from whatever`,
    "phase it is actually in, following workflows/book-writing.workflow.yaml.",
    `Read workspaces/${options.slug}/artifacts/project-analysis.json and`,
    `workspaces/${options.slug}/artifacts/decision-log.md, project-brief.md, chapter-plan.md, and preparation-manifest.json when they exist.`,
    "Read any preparation notes in project.json alongside those documents; treat them as author instructions for what must be corrected or preserved.",
    "Use every question and author answer as authoritative preparation input.",
    `Read workspaces/${options.slug}/logs/phase-log.json, audit-log.json, and errors-log.json when they exist;`,
    "use them as the execution history, including recorded messages from earlier runtime sessions, and stop if they expose an unresolved failure.",
    "A provider switch starts a new session: do not assume the old model's hidden context is available; continue from the recorded workspace, decisions, artifacts, and runtime conversation.",
    "The author approved the preparation gate in the Studio. Honour every author gate that remains:",
    "do not approve a chapter on their behalf, and stop with a clear report if an input is missing.",
    "At each meaningful boundary, report one progress line in exactly this form so the Studio can",
    "show the author what is happening without exposing the whole console:",
    "CANON_QUILL_PROGRESS phase=<phase> percent=<0-100> [chapter=<number>] detail=<short plain-English update>",
    "Use phases gathering_info, preparing_characters, planning_chapters, writing_chapter, editing_chapter,",
    "validating_chapter, compiling_book, and finishing. Report the phase before doing the work, and never",
    "claim a later phase until its required artifact exists.",
    "",
    "You can write only inside workspaces/, and the only shell commands you have are this project's",
    "own checks. That is deliberate. Inspect files with Read, Glob and Grep, never by shelling out to",
    "python, node, curl or a pipeline: those are refused, and retrying them only spends the author's",
    "money. If you genuinely cannot proceed without something you are denied, stop and say so."
  ];
  if (options.note?.trim()) {
    lines.push("", "The author added, for this run:", options.note.trim());
  }
  return lines.join("\n");
}

/** Granted exactly what the agent file already allows, and nothing wider. */
export function orchestratorRules(cwd: string): string[] {
  const allowed = allowedPaths(cwd);
  return [
    "Read", "Glob", "Grep", "Task",
    // Edit rules cover every file-editing tool. A Write rule matches nothing.
    ...allowed("edit").map((glob) => `Edit(${glob})`),
    ...allowed("bash").map((command) => `Bash(${command.endsWith("*") ? `${command.slice(0, -1)}:*` : command})`)
  ];
}

function allowedPaths(cwd: string): (key: string) => string[] {
  let frontmatter = "";
  try {
    const file = readFileSync(path.join(cwd, ".opencode", "agents", `${AGENT}.md`), "utf8");
    frontmatter = /^---\n([\s\S]*?)\n---/.exec(file)?.[1] ?? "";
  } catch {
    return () => [];
  }

  const lines = frontmatter.split("\n");
  return (key: string) => {
    const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
    if (start < 0) return [];
    const depth = lines[start].search(/\S/);
    const rules: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.trim()) continue;
      if (line.search(/\S/) <= depth) break;
      const match = /^\s+"?([^":]+(?::[^":]*)?)"?:\s*allow\s*$/.exec(line);
      if (match && match[1].trim() !== "*") rules.push(match[1].trim());
    }
    return rules;
  };
}

export function buildCommand(runtime: RuntimeId, options: {
  provider: ProviderId;
  model?: string | null;
  prompt: string;
  cwd: string;
}): { file: string; args: string[] } {
  if (runtime === "claude-code") {
    return {
      file: "claude",
      args: [
        "--print",
        "--agent", AGENT,
        "--output-format", "stream-json",
        "--verbose",
        // Variadic flag: one comma-separated value, or it swallows the prompt.
        "--allowedTools", orchestratorRules(options.cwd).join(","),
        ...(options.model ? ["--model", options.model] : []),
        options.prompt
      ]
    };
  }
  return {
    file: "opencode",
    args: [
      "run",
      "--agent", AGENT,
      ...(options.model ? ["-m", `${options.provider}/${options.model}`] : []),
      options.prompt
    ]
  };
}

export function startRun(options: StartOptions): { runtime: RuntimeId; command: string } {
  if (active) throw new Error("A run is already in progress.");
  const runtime = selectRuntime(options.provider);
  if (!runtime) {
    throw new Error(options.provider === "openai"
      ? "OpenCode is not installed, and Claude Code cannot write with OpenAI. Install it with `npm install -g opencode-ai`."
      : "Neither Claude Code nor OpenCode was found. Install one with `npm install -g @anthropic-ai/claude-code`.");
  }

  const cwd = options.cwd ?? process.cwd();
  const prompt = buildPrompt(options);
  const { file, args } = buildCommand(runtime, { provider: options.provider, model: options.model, prompt, cwd });
  const command = `${file} ${args.map((arg) => (arg.includes(" ") ? `"${arg.split("\n")[0]}…"` : arg)).join(" ")}`;

  events = [];
  seq = 0;
  progress = {
    phase: "gathering_info",
    label: PROGRESS_PHASES.gathering_info.label,
    percent: PROGRESS_PHASES.gathering_info.percent,
    detail: "Reading the approved project material and preparation package.",
    chapter: options.chapter ?? null
  };
  lastRuntime = runtime;
  lastCommand = command;
  lastStartedAt = new Date().toISOString();
  active = { slug: options.slug, child: null, runtime, command, startedAt: lastStartedAt, stopping: false, onProgress: options.onProgress, onEvent: options.onEvent };
  active.onProgress?.(progress);

  emit("system", `Starting ${runtimeLabel(runtime)}${options.model ? ` on ${options.model}` : ""}.`);
  emit("system", "It reads this book's workspace first, so it picks up wherever the book actually is.");

  if (dryRun()) {
    emit("system", "Dry run: the command was prepared but not started.");
    // Nothing will exit on its own, so the run ends here. No exit is reported:
    // there was no process, and the caller's own status write stands.
    active = null;
    return { runtime, command };
  }

  const child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  active.child = child;

  const stdout = lineReader((line) => translate(runtime, line));
  const stderr = lineReader((line) => emit("error", line));
  child.stdout?.on("data", (chunk: Buffer) => stdout(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => stderr(chunk.toString("utf8")));

  child.on("error", (error: Error) => {
    emit("error", error.message);
    finish({ ok: false, code: null, signal: null, reason: "other", detail: error.message, trace: [...events], progress }, options.onExit);
  });

  child.on("close", (code, signal) => {
    const cancelled = active?.stopping === true;
    const ok = code === 0 && !cancelled;
    emit("system", cancelled ? "Stopped by you." : ok ? "The run finished." : `The run stopped with code ${code ?? "unknown"}.`);
    finish({
      ok,
      code,
      signal,
      reason: ok ? null : cancelled ? "cancelled" : inferReason(recentText()),
      detail: ok ? null : recentText().slice(-1500) || null,
      trace: [...events],
      progress
    }, options.onExit);
  });

  return { runtime, command };
}

export function stopRun(): boolean {
  if (!active) return false;
  active.stopping = true;
  if (!active.child) {
    finish({ ok: false, code: null, signal: null, reason: "cancelled", detail: null, trace: [...events], progress }, () => undefined);
    return true;
  }
  active.child.kill("SIGTERM");
  return true;
}

function finish(outcome: RunOutcome, onExit: (outcome: RunOutcome) => void): void {
  if (!active) return;
  active = null;
  onExit(outcome);
}

function recentText(): string {
  return events.slice(-40).map((event) => event.text).join("\n");
}

export function inferReason(text: string): RunOutcome["reason"] {
  if (/rate limit|429|too many requests|usage limit|session limit|hit your session/i.test(text)) return "rate_limited";
  if (/credit balance|insufficient (?:funds|quota|credit)|billing/i.test(text)) return "no_credit";
  if (/unauthori[sz]ed|invalid api key|authentication_error|401|not logged in|please (?:run )?login/i.test(text)) {
    return "invalid_credentials";
  }
  if (/overloaded|internal server error|5\d\d\b|api error/i.test(text)) return "provider_error";
  return "other";
}

function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  };
}

function translate(runtime: RuntimeId, line: string): void {
  if (runtime !== "claude-code") {
    // OpenCode's own output is already written for a person to read.
    emit("note", line);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    emit("note", line);
    return;
  }
  for (const event of describeClaudeEvent(parsed)) emit(event.kind, event.text);
}

interface Described { kind: RunEvent["kind"]; text: string }

export function describeClaudeEvent(value: unknown): Described[] {
  const event = value as Record<string, any>;
  if (!event || typeof event !== "object") return [];

  if (event.type === "system" && event.subtype === "init") {
    return [{ kind: "system", text: `Session ready${event.model ? ` on ${event.model}` : ""}.` }];
  }

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const described: Described[] = [];
    for (const block of event.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        const text = block.text.replace(/\s+/g, " ").trim();
        if (text) described.push({ kind: "note", text });
      }
      if (block?.type === "tool_use") described.push({ kind: "step", text: describeTool(block.name, block.input) });
    }
    return described;
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    return event.message.content
      .filter((block: any) => block?.type === "tool_result" && block.is_error)
      .map((block: any) => ({ kind: "error" as const, text: `A step failed: ${flatten(block.content)}` }));
  }

  if (event.type === "result") {
    const cost = typeof event.total_cost_usd === "number" ? ` Cost so far: $${event.total_cost_usd.toFixed(2)}.` : "";
    return event.subtype === "success"
      ? [{ kind: "system", text: `Done.${cost}` }]
      : [{ kind: "error", text: `Stopped: ${event.subtype ?? "unknown reason"}.${cost}` }];
  }

  return [];
}

function describeTool(name: unknown, input: Record<string, any> | undefined): string {
  const file = (value: unknown) => (typeof value === "string" ? path.basename(value) : "a file");
  switch (name) {
    case "Task": return `Handing over to ${input?.subagent_type ?? "a specialist"}: ${input?.description ?? "work in this phase"}.`;
    case "Read": return `Reading ${file(input?.file_path)}.`;
    case "Write": return `Writing ${file(input?.file_path)}.`;
    case "Edit": return `Editing ${file(input?.file_path)}.`;
    case "Bash": return `Running ${String(input?.command ?? "a command").slice(0, 120)}.`;
    case "Glob":
    case "Grep": return `Searching for ${String(input?.pattern ?? "something").slice(0, 80)}.`;
    case "WebFetch":
    case "WebSearch": return `Looking up ${String(input?.url ?? input?.query ?? "a reference").slice(0, 100)}.`;
    default: return `Using ${String(name ?? "a tool")}.`;
  }
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join(" ").slice(0, 300);
  }
  return "no detail";
}
