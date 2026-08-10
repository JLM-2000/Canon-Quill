// Spawns the runtime the author chose on the orchestrator agent, and turns its
// output into lines a person can follow. No credential is read or passed here:
// the runtime uses its own login, as it does when started by hand.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "./redact.js";

export type RuntimeId = "claude-code" | "opencode";
export type ProviderId = "anthropic" | "openai";
export type AuthMethod = "subscription" | "api_key";

export interface RunEvent {
  seq: number;
  at: string;
  kind: "system" | "step" | "note" | "error";
  text: string;
  sessionId?: string;
  agent?: string;
  depth?: number;
}

export interface RunSnapshot {
  active: boolean;
  runtime: RuntimeId | null;
  command: string | null;
  startedAt: string | null;
  events: RunEvent[];
  agents: RunAgentSnapshot[];
  providerSessionId: string | null;
  latest: number;
  progress: RunProgress | null;
}

export type RunAgentStatus = "working" | "waiting" | "done";

export interface RunAgentSnapshot {
  key: string;
  agent: string;
  depth: number;
  status: RunAgentStatus;
  done: boolean;
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
  activity: "working" | "waiting";
}

export interface StartOptions {
  slug: string;
  projectName: string;
  provider: ProviderId;
  authMethod?: AuthMethod | null;
  model?: string | null;
  chapter?: number | null;
  note?: string;
  resumeSessionId?: string | null;
  cwd?: string;
  onExit: (outcome: RunOutcome) => void;
  onProgress?: (progress: RunProgress) => void;
  onEvent?: (event: RunEvent) => void;
}

export interface RunOutcome {
  ok: boolean;
  code: number | null;
  signal: string | null;
  reason: "cancelled" | "stalled" | "no_credit" | "rate_limited" | "invalid_credentials" | "provider_error" | "other" | null;
  detail: string | null;
  /** Everything the run said, for the phase log. */
  trace: RunEvent[];
  progress: RunProgress | null;
  providerSessionId: string | null;
}

const AGENT = "book-orchestrator";
const MAX_EVENTS = 4000;
const NESTED_POLL_MS = 1500;
const NESTED_STALL_MS = 5 * 60_000;
const PARENT_WATCHDOG_MS = 30_000;
// A provider tool call can be quiet while a large read or edit is in flight.
const PARENT_STALL_MS = 15 * 60_000;

interface NestedMonitor {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  url: string;
  startedAt: number;
  sessions: Map<string, {
    agent: string;
    depth: number;
    status: RunAgentStatus;
    lastActivityAt: number;
  }>;
  parts: Map<string, string>;
  lastNestedUpdateAt: number;
  lastParentEventAt: number;
  stallReported: boolean;
}

interface ActiveRun {
  slug: string;
  child: ChildProcess | null;
  heartbeat?: NodeJS.Timeout;
  watchdog?: NodeJS.Timeout;
  nested?: NestedMonitor;
  runtime: RuntimeId;
  command: string;
  startedAt: string;
  stopping: boolean;
  stopReason?: "cancelled" | "stalled";
  onProgress?: (progress: RunProgress) => void;
  onEvent?: (event: RunEvent) => void;
  lastOutputAt: number;
  lastMeaningfulAt: number;
  repeatedLookup: { text: string; since: number } | null;
}

let active: ActiveRun | null = null;
let events: RunEvent[] = [];
let seq = 0;
let lastRuntime: RuntimeId | null = null;
let lastCommand: string | null = null;
let lastStartedAt: string | null = null;
let progress: RunProgress | null = null;
let agentStates = new Map<string, RunAgentSnapshot>();
let claudeTaskAgents = new Map<string, { agent: string; depth: number }>();
let providerSessionId: string | null = null;
let runAuthMethod: AuthMethod | null = null;

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
    agents: [...agentStates.values()],
    providerSessionId,
    latest: seq,
    progress
  };
}

interface EventMeta {
  sessionId?: string;
  agent?: string;
  depth?: number;
  done?: boolean;
}

function emit(kind: RunEvent["kind"], text: string, meta?: EventMeta): void {
  const now = Date.now();
  const stripped = stripAnsi(text);
  if (!meta?.sessionId && active?.nested) active.nested.lastParentEventAt = Date.now();
  const key = meta?.sessionId ?? "orchestrator";
  ensureAgent(key, meta?.agent ?? (key === "orchestrator" ? "Orchestrator" : "Subagent"), meta?.depth ?? 0);
  setAgentStatus(key, meta?.done || isDoneSignal(stripped) ? "done" : "working");
  if (meta?.done) setAgentStatus("orchestrator", "working");
  if (progress?.activity === "waiting") setProgress({ ...progress, activity: "working" });
  const priorProgress = progress;
  const explicit = readProgress(stripped);
  const update = explicit ?? inferProgress(stripped);
  if (update) setProgress(update, Boolean(explicit));
  if (!meta?.sessionId && /handing over to|delegating to/i.test(stripped)) setAgentStatus("orchestrator", "waiting");
  const clean = humanizeRuntimeText(redactSensitiveText(removeProgressMarker(stripped))).trim();
  if (!clean) return;
  if (active) {
    active.lastOutputAt = now;
    const progressBoundary = Boolean(update && (!priorProgress || update.phase !== priorProgress.phase || update.percent > priorProgress.percent));
    if (isRepeatedLookup(clean)) {
      if (!active.repeatedLookup || active.repeatedLookup.text !== clean) active.repeatedLookup = { text: clean, since: now };
    } else {
      active.repeatedLookup = null;
    }
    if (!isRepeatedLookup(clean) || progressBoundary) active.lastMeaningfulAt = now;
  }
  const event = { seq: ++seq, at: new Date().toISOString(), kind, text: clean.slice(0, 600), ...meta };
  events.push(event);
  active?.onEvent?.(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
}

function ensureAgent(key: string, agent: string, depth: number): void {
  const existing = agentStates.get(key);
  if (existing) {
    if (agent !== "Subagent" && agent !== "Orchestrator") existing.agent = agent;
    existing.depth = Math.min(existing.depth, depth);
    return;
  }
  agentStates.set(key, { key, agent, depth, status: "working", done: false });
}

function setAgentStatus(key: string, status: RunAgentStatus): void {
  const agent = agentStates.get(key);
  if (!agent) return;
  if (agent.done && status !== "done") return;
  agent.status = status;
  agent.done = status === "done";
}

function isRepeatedLookup(text: string): boolean {
  return /^(?:Searching|Checking) the workspace\.?$/i.test(text.trim());
}

export function isDoneSignal(text: string): boolean {
  return /(?:^|\s)done\s*[:=]\s*true(?:\s|$)/i.test(text.trim());
}

function setProgress(update: RunProgress, notify = true): void {
  const phaseChanged = progress?.phase !== update.phase;
  const next = {
    ...update,
    percent: Math.max(progress?.percent ?? 0, Math.min(100, update.percent)),
    detail: redactSensitiveText(update.detail).slice(0, 240),
    chapter: update.chapter ?? progress?.chapter ?? null
  };
  if (progress && next.phase === progress.phase && next.percent === progress.percent && next.detail === progress.detail && next.activity === progress.activity) return;
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
    chapter: match[3] ? Number(match[3]) : null,
    activity: "working"
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
  return { phase, label: defaults.label, percent: defaults.percent, detail: text.trim().slice(0, 240), chapter, activity: "working" };
}

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

export function humanizeRuntimeText(text: string): string {
  const trimmed = text.trim();
  if (isDoneSignal(trimmed)) return "Finished.";
  if (/^Done\.\s+Cost so far:/i.test(trimmed)) return "Done.";
  if (/^Entry contract for .* is satisfied:/i.test(trimmed)) return "The saved writing contract and required preparation files are present.";
  if (/^# Todos$/.test(trimmed)) return "";
  const todo = /^\[([•✓ ])\]\s*(.+)$/.exec(trimmed);
  if (todo) return humanizeTodo(todo[1], todo[2]);
  if (/^>\s*book-orchestrator\s*[·•]/i.test(trimmed)) return "Orchestrator session ready.";
  if (/^✗\s+(?:Read|Glob|Grep)\b/i.test(trimmed)) return "A workspace lookup failed; checking the available artifacts.";
  const read = /^(?:→|✱)\s+Read\s+(.+?)(?:\s+\[offset=.*)?$/i.exec(trimmed);
  if (read) {
    const target = read[1].trim();
    if (target === "." || target === "workspaces") return "Checking workspace structure.";
    if (/^workflows\//i.test(target)) return "Reading the workflow.";
    if (/^workspaces\/[^/]+\/project\.json$/i.test(target)) return "Reading project state.";
    if (/^workspaces\//i.test(target)) return "Reading selected preparation material.";
  }
  if (/^(?:→|✱)\s+Read\s+workflows\//i.test(trimmed)) return "Reading the workflow.";
  if (/^(?:→|✱)\s+Read\s+workspaces\/[^/]+\/project\.json/i.test(trimmed)) return "Reading project state.";
  if (/^(?:→|✱)\s+Read\s+workspaces\/?$/i.test(trimmed) || /^(?:→|✱)\s+Read\s+\.$/i.test(trimmed)) return "Checking workspace structure.";
  if (/^(?:→|✱)\s+Read\s+workspaces\//i.test(trimmed)) return "Reading selected preparation material.";
  if (/^(?:→|✱)\s+(?:Glob|Grep)\b/i.test(trimmed)) return "Searching the workspace.";
  if (/^Searching for (?:workspaces|artifacts)\//i.test(trimmed)) return "Searching the workspace.";
  if (/^Running\s+(?:ls|dir)\b/i.test(trimmed)) return "Checking workspace contents.";
  if (/^Using Agent\.?$/i.test(trimmed)) return "Handing over to a specialist.";
  if (/^(?:Completed: )?Using\s+(?:read|glob|grep)\.?$/i.test(trimmed)) return "Checking selected material.";
  if (/^(?:Completed: )?Using\s+apply_patch\.?$/i.test(trimmed)) return "Updating a preparation artifact.";
  if (/repair reference extraction.*book-03-reference-extraction agent/i.test(trimmed)) {
    return "Repairing reference extraction.";
  }
  if (/preparation.*book-04-preparation agent/i.test(trimmed)) {
    return "Building the preparation package.";
  }
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

function humanizeTodo(marker: string, item: string): string {
  const action = item
    .replace(/^Read\b/i, "Reading")
    .replace(/^Verify\b/i, "Checking")
    .replace(/^Delegate\b/i, "Delegating")
    .replace(/^Record\b/i, "Recording")
    .replace(/^Run\b/i, "Running")
    .replace(/^Stop\b/i, "Stopping");
  if (marker === "✓") return `Completed: ${action}`;
  if (marker === " ") return `Next: ${action}`;
  return action;
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

export function buildPrompt(options: { projectName: string; slug: string; note?: string; resumeSessionId?: string | null }): string {
  const lines = [
    `Continue the Canon Quill book "${options.projectName}" (workspace ${options.slug}).`,
    `Read workspaces/${options.slug}/project.json first, then carry the book forward from whatever`,
    "phase it is actually in, following workflows/book-writing.workflow.yaml.",
    `Read workspaces/${options.slug}/artifacts/project-analysis.json and`,
    `workspaces/${options.slug}/artifacts/decision-log.md. Use Glob before reading optional preparation artifacts such as`,
    "project-brief.md, chapter-plan.md, and preparation-manifest.json; only Read files that Glob found.",
    `If workspaces/${options.slug}/artifacts/formatting-references.md exists, read it before drafting. It measures formatting from every selected source, including uploaded and Drive-extracted references, not only the voice corpus. Preserve evidence-backed bold dialogue, quotation-mark treatment, italic thoughts, headings, and other marked conventions in the new Markdown prose.`,
    "When the run note begins PREPARATION_REPAIR, missing preparation artifacts are expected work, not errors: continue from the existing source records and delegate the repair.",
    "Read any preparation notes in project.json alongside those documents; treat them as author instructions for what must be corrected or preserved.",
    "The Studio owns workspaces/<book>/logs/**. Never edit or write anything under logs; it records runtime and phase history itself.",
    "Use every question and author answer as authoritative preparation input.",
    `Read workspaces/${options.slug}/logs/phase-log.json, audit-log.json, and errors-log.json when they exist;`,
    "use them as the execution history, including recorded messages from earlier runtime sessions, and stop if they expose an unresolved failure.",
    options.resumeSessionId
      ? "This run is resuming the provider conversation identified by the saved session. Keep using that conversation while treating the workspace and its recorded artifacts as authoritative."
      : "If no saved provider session is available, this is a new provider conversation. Continue from the recorded workspace, decisions, artifacts, and runtime conversation.",
    "The author approved the preparation gate in the Studio. Honour every author gate that remains:",
    "do not approve a chapter on their behalf, and stop with a clear report if an input is missing.",
    "At each meaningful boundary, report one progress line in exactly this form so the Studio can",
    "show the author what is happening without exposing the whole console:",
    "CANON_QUILL_PROGRESS phase=<phase> percent=<0-100> [chapter=<number>] detail=<short plain-English update>",
    "Use phases gathering_info, preparing_characters, planning_chapters, writing_chapter, editing_chapter,",
    "validating_chapter, compiling_book, and finishing. Report the phase before doing the work, and never",
    "claim a later phase until its required artifact exists.",
    "When a delegated agent finishes, require its final response to end with done: true. End your own final response with done: true.",
    "",
    "You can write only inside workspaces/<book>/artifacts/, and the only shell commands you have are this project's",
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
  resumeSessionId?: string | null;
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
        ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
        options.prompt
      ]
    };
  }
  return {
    file: "opencode",
    args: [
      "run",
      "--agent", AGENT,
      ...(options.resumeSessionId ? ["--session", options.resumeSessionId] : []),
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
  const { file, args } = buildCommand(runtime, { provider: options.provider, model: options.model, prompt, cwd, resumeSessionId: options.resumeSessionId });
  const command = `${file} ${args.map((arg) => (arg.includes(" ") ? `"${arg.split("\n")[0]}…"` : arg)).join(" ")}`;

  events = [];
  seq = 0;
  progress = {
    phase: "gathering_info",
    label: PROGRESS_PHASES.gathering_info.label,
    percent: PROGRESS_PHASES.gathering_info.percent,
    detail: "Reading the approved project material and preparation package.",
    chapter: options.chapter ?? null,
    activity: "working"
  };
  agentStates = new Map([["orchestrator", { key: "orchestrator", agent: "Orchestrator", depth: 0, status: "working", done: false }]]);
  claudeTaskAgents = new Map();
  providerSessionId = options.resumeSessionId ?? null;
  runAuthMethod = options.authMethod ?? null;
  lastRuntime = runtime;
  lastCommand = command;
  lastStartedAt = new Date().toISOString();
  const now = Date.now();
  active = {
    slug: options.slug,
    child: null,
    runtime,
    command,
    startedAt: lastStartedAt,
    stopping: false,
    onProgress: options.onProgress,
    onEvent: options.onEvent,
    lastOutputAt: now,
    lastMeaningfulAt: now,
    repeatedLookup: null
  };
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
  if (runtime === "opencode") startNestedMonitor(cwd, Date.parse(active.startedAt));
  active.heartbeat = setInterval(() => {
    if (!active || active.child !== child || !progress) return;
    if (progress.activity !== "waiting") setProgress({ ...progress, activity: "waiting" });
    setAgentStatus("orchestrator", "waiting");
  }, 30_000);
  active.heartbeat.unref();
  active.watchdog = setInterval(() => {
    if (!active || active.child !== child || active.stopping) return;
    const quietFor = Date.now() - active.lastOutputAt;
    const repeatedFor = active.repeatedLookup ? Date.now() - active.repeatedLookup.since : 0;
    const meaningfulQuietFor = Date.now() - active.lastMeaningfulAt;
    if (quietFor > PARENT_STALL_MS || (repeatedFor > PARENT_STALL_MS && meaningfulQuietFor > PARENT_STALL_MS)) {
      active.stopping = true;
      active.stopReason = "stalled";
      emit("error", "The writing runtime stopped making meaningful progress. The run was stopped automatically.");
      child.kill("SIGTERM");
    }
  }, PARENT_WATCHDOG_MS);
  active.watchdog.unref();

  const stdout = lineReader((line) => translate(runtime, line));
  const stderr = lineReader((line) => {
    if (runtime === "opencode") translate(runtime, line);
    else emit("error", line);
  });
  child.stdout?.on("data", (chunk: Buffer) => stdout(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => stderr(chunk.toString("utf8")));

  child.on("error", (error: Error) => {
    emit("error", error.message);
    finish({ ok: false, code: null, signal: null, reason: "other", detail: error.message, trace: [...events], progress, providerSessionId }, options.onExit);
  });

  child.on("close", (code, signal) => {
    const stopReason = active?.stopReason;
    const stopped = active?.stopping === true;
    const ok = code === 0 && !stopped;
    emit("system", stopReason === "stalled" ? "Stopped automatically because the delegated run stalled." : stopped ? "Stopped by you." : ok ? "The run finished." : `The run stopped with code ${code ?? "unknown"}.`);
    finish({
      ok,
      code,
      signal,
      reason: ok ? null : stopped ? stopReason ?? "cancelled" : inferReason(recentText()),
      detail: ok ? null : recentText().slice(-1500) || null,
      trace: [...events],
      progress,
      providerSessionId
    }, options.onExit);
  });

  return { runtime, command };
}

export function stopRun(reason: "cancelled" | "stalled" = "cancelled"): boolean {
  if (!active) return false;
  active.stopping = true;
  active.stopReason = reason;
  if (!active.child) {
    finish({ ok: false, code: null, signal: null, reason, detail: null, trace: [...events], progress, providerSessionId }, () => undefined);
    return true;
  }
  active.child.kill("SIGTERM");
  return true;
}

function finish(outcome: RunOutcome, onExit: (outcome: RunOutcome) => void): void {
  if (!active) return;
  if (active.heartbeat) clearInterval(active.heartbeat);
  if (active.watchdog) clearInterval(active.watchdog);
  stopNestedMonitor(active.nested);
  for (const agent of agentStates.values()) setAgentStatus(agent.key, "done");
  active = null;
  onExit(outcome);
}

function startNestedMonitor(cwd: string, startedAt: number): void {
  if (!active) return;
  const port = 45000 + (process.pid % 1000);
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--pure"], {
    cwd,
    windowsHide: true,
    stdio: "ignore"
  });
  const monitor: NestedMonitor = {
    child,
    timer: setInterval(() => void pollNestedSessions(monitor), NESTED_POLL_MS),
    url: `http://127.0.0.1:${port}`,
    startedAt,
    sessions: new Map(),
    parts: new Map(),
    lastNestedUpdateAt: 0,
    lastParentEventAt: Date.now(),
    stallReported: false
  };
  monitor.timer.unref();
  active.nested = monitor;
  child.once("error", () => stopNestedMonitor(monitor));
  void pollNestedSessions(monitor);
}

function stopNestedMonitor(monitor: NestedMonitor | undefined): void {
  if (!monitor) return;
  clearInterval(monitor.timer);
  if (monitor.child.exitCode === null && !monitor.child.killed) monitor.child.kill("SIGTERM");
}

async function pollNestedSessions(monitor: NestedMonitor): Promise<void> {
  if (!active || active.nested !== monitor) return;
  try {
    const sessions = await fetchJson<Array<Record<string, any>>>(`${monitor.url}/session`);
    const current = new Map(sessions
      .filter((session) => typeof session.id === "string")
      .map((session) => [session.id, session]));
    const nested = sessions.filter((session) => {
      const created = Number(session.time?.created ?? 0);
      return typeof session.id === "string" && Boolean(session.parentID) && created >= monitor.startedAt - 2_000;
    });
    const latestNestedUpdate = nested.reduce((latest, session) => Math.max(latest, Number(session.time?.updated ?? session.time?.created ?? 0)), 0);
    if (latestNestedUpdate > monitor.lastNestedUpdateAt) monitor.lastNestedUpdateAt = latestNestedUpdate;
    if (nested.length && monitor.lastNestedUpdateAt && !monitor.stallReported
      && Date.now() - monitor.lastNestedUpdateAt > NESTED_STALL_MS
      && Date.now() - monitor.lastParentEventAt > NESTED_STALL_MS) {
      monitor.stallReported = true;
      emit("error", "The orchestrator stopped responding after delegated agent activity. The run was stopped automatically.");
      stopRun("stalled");
      return;
    }

    for (const session of nested) {
      const agent = typeof session.agent === "string" ? session.agent : "subagent";
      const depth = sessionDepth(session, current);
      if (!monitor.sessions.has(session.id)) {
        monitor.sessions.set(session.id, { agent, depth, status: "working", lastActivityAt: Date.now() });
        ensureAgent(session.id, agent, depth);
        setAgentStatus("orchestrator", "waiting");
        emit("step", `${agent} started.`, { sessionId: session.id, agent, depth });
      }

      const messages = await fetchJson<Array<Record<string, any>>>(`${monitor.url}/session/${encodeURIComponent(session.id)}/message`);
      const state = monitor.sessions.get(session.id);
      if (!state) continue;
      let changed = false;
      let done = sessionIsDone(session);
      for (const [messageIndex, message] of messages.entries()) {
        if (message.info?.role === "user") continue;
        const messageId = typeof message.info?.id === "string" ? message.info.id : String(messageIndex);
        const parts = Array.isArray(message.parts) ? message.parts : [];
        for (const [partIndex, part] of parts.entries()) {
          if (!part || typeof part !== "object") continue;
          const text = describeNestedPart(part as Record<string, any>);
          if (!text) continue;
          const key = `${session.id}:${messageId}:${part.id ?? partIndex}`;
          const previous = monitor.parts.get(key) ?? "";
          if (text === previous) continue;
          monitor.parts.set(key, text);
          const delta = text.startsWith(previous) ? text.slice(previous.length).trim() : text;
          if (delta) {
            changed = true;
            if (isDoneSignal(delta)) done = true;
            emit(part.type === "tool" ? "step" : "note", delta, { sessionId: session.id, agent, depth, done: isDoneSignal(delta) });
          }
        }
      }
      if (done) {
        state.status = "done";
        setAgentStatus(session.id, "done");
      } else if (changed) {
        state.status = "working";
        state.lastActivityAt = Date.now();
        setAgentStatus(session.id, "working");
      } else if (Date.now() - state.lastActivityAt > 30_000) {
        state.status = "waiting";
        setAgentStatus(session.id, "waiting");
      }
    }
    if ([...monitor.sessions.values()].some((session) => session.status !== "done")) setAgentStatus("orchestrator", "waiting");
    else if (monitor.sessions.size) setAgentStatus("orchestrator", "working");
  } catch {
    // The monitor is best effort. The parent runtime stream remains authoritative.
  }
}

function sessionIsDone(session: Record<string, any>): boolean {
  const status = String(session.status ?? session.state ?? "").toLowerCase();
  if (/^(?:complete|completed|done|success|failed|error|cancelled|canceled|terminated)$/.test(status)) return true;
  return [session.time?.completed, session.time?.finished, session.time?.ended]
    .some((value) => Number(value) > 0);
}

function sessionDepth(session: Record<string, any>, all: Map<string, Record<string, any>>): number {
  let depth = 0;
  let parent = typeof session.parentID === "string" ? session.parentID : null;
  const visited = new Set<string>();
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    depth += 1;
    const parentSession = all.get(parent);
    parent = typeof parentSession?.parentID === "string" ? parentSession.parentID : null;
  }
  return depth;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OpenCode monitor returned ${response.status}.`);
  return response.json() as Promise<T>;
}

export function describeNestedPart(part: Record<string, any>): string | null {
  if (part.type === "text" && typeof part.text === "string") {
    const text = part.text.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 600) : null;
  }
  if (part.type !== "tool") return null;
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const action = describeTool(part.tool, state.input);
  if (state.status === "error") return `Tool failed: ${action}`;
  return action;
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
    emit(isOpenCodeError(line) ? "error" : "note", line);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    emit("note", line);
    return;
  }
  const raw = parsed as Record<string, any>;
  if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
    for (const block of raw.message.content) {
      if (block?.type === "tool_use" && isDelegationTool(block.name) && typeof block.id === "string") {
        claudeTaskAgents.set(block.id, { agent: String(block.input?.subagent_type ?? "Subagent"), depth: 1 });
      }
    }
  }
  for (const event of describeClaudeEvent(parsed, { includeCost: runAuthMethod === "api_key" })) {
    if (event.runtimeSessionId) providerSessionId = event.runtimeSessionId;
    const task = event.sessionId ? claudeTaskAgents.get(event.sessionId) : undefined;
    emit(event.kind, event.text, event.sessionId ? { sessionId: event.sessionId, agent: event.agent ?? task?.agent, depth: event.depth ?? task?.depth, done: event.done } : { done: event.done });
  }
  if (raw.type === "user" && Array.isArray(raw.message?.content)) {
    for (const block of raw.message.content) {
      const task = typeof block?.tool_use_id === "string" ? claudeTaskAgents.get(block.tool_use_id) : undefined;
      if (block?.type !== "tool_result" || !task) continue;
      emit(block.is_error ? "error" : "note", block.is_error ? `A delegated step failed: ${flatten(block.content)}` : "", {
        sessionId: block.tool_use_id,
        agent: task.agent,
        depth: task.depth,
        done: true
      });
    }
  }
}

function isOpenCodeError(line: string): boolean {
  return /^\s*✗\b/.test(line) || /^\s*(?:Error|Failed|Permission denied):/i.test(line);
}

interface Described {
  kind: RunEvent["kind"];
  text: string;
  sessionId?: string;
  agent?: string;
  depth?: number;
  done?: boolean;
  runtimeSessionId?: string;
}

export function describeClaudeEvent(value: unknown, options: { includeCost?: boolean } = {}): Described[] {
  const event = value as Record<string, any>;
  if (!event || typeof event !== "object") return [];

  if (event.type === "system" && event.subtype === "init") {
    return [{
      kind: "system",
      text: `Session ready${event.model ? ` on ${event.model}` : ""}.`,
      runtimeSessionId: typeof event.session_id === "string" ? event.session_id : typeof event.sessionId === "string" ? event.sessionId : undefined
    }];
  }

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const described: Described[] = [];
    for (const block of event.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        const text = block.text.replace(/\s+/g, " ").trim();
        if (text) described.push({ kind: "note", text });
      }
       if (block?.type === "tool_use") described.push({
         kind: "step",
         text: describeTool(block.name, block.input),
          sessionId: isDelegationTool(block.name) && typeof block.id === "string" ? block.id : undefined,
          agent: isDelegationTool(block.name) ? String(block.input?.subagent_type ?? block.input?.agent ?? "Subagent") : undefined,
          depth: isDelegationTool(block.name) ? 1 : undefined
       });
    }
    return described;
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    return event.message.content
      .filter((block: any) => block?.type === "tool_result" && block.is_error)
      .map((block: any) => ({ kind: "error" as const, text: `A step failed: ${flatten(block.content)}` }));
  }

  if (event.type === "result") {
    const cost = options.includeCost !== false && typeof event.total_cost_usd === "number"
      ? ` Provider-reported API usage: $${event.total_cost_usd.toFixed(2)}.` : "";
    return event.subtype === "success"
      ? [{ kind: "system", text: `Done.${cost}`, done: true }]
      : [{ kind: "error", text: `Stopped: ${event.subtype ?? "unknown reason"}.${cost}` }];
  }

  return [];
}

function describeTool(name: unknown, input: Record<string, any> | undefined): string {
  const file = (value: unknown) => (typeof value === "string" ? path.basename(value) : "a file");
  switch (String(name ?? "").toLowerCase()) {
    case "task":
    case "agent": return `Handing over to ${input?.subagent_type ?? input?.agent ?? "a specialist"}: ${input?.description ?? "work in this phase"}.`;
    case "read": return `Reading ${file(input?.file_path ?? input?.filePath)}.`;
    case "write": return `Writing ${file(input?.file_path ?? input?.filePath)}.`;
    case "edit": return `Editing ${file(input?.file_path ?? input?.filePath)}.`;
    case "bash": return describeBash(input?.command);
    case "glob":
    case "grep": return "Searching the workspace.";
    case "webfetch":
    case "websearch": return "Looking up a reference.";
    default: return `Using ${String(name ?? "a tool")}.`;
  }
}

function isDelegationTool(name: unknown): boolean {
  return ["task", "agent"].includes(String(name ?? "").toLowerCase());
}

function describeBash(command: unknown): string {
  const text = String(command ?? "").trim();
  if (/^(?:ls|dir)\b/i.test(text)) return "Checking workspace contents.";
  if (/npm run validate:workflow/i.test(text)) return "Checking the workflow.";
  if (/npm test/i.test(text)) return "Running the project tests.";
  if (/npm run build/i.test(text)) return "Building the project.";
  return "Running an approved project check.";
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join(" ").slice(0, 300);
  }
  return "no detail";
}
