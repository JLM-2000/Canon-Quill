import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "./paths.js";

export type LogKind = "phase" | "audit" | "error";

export interface BaseLogEntry {
  timestamp: string;
  stage: string;
  stageName: string;
  agent: string;
  event: string;
  message?: string;
  data?: unknown;
}

export interface ErrorLogEntry extends BaseLogEntry {
  errorName?: string;
  errorMessage: string;
  stack?: string;
}

const logFiles: Record<LogKind, string> = {
  phase: "phase-log.json",
  audit: "audit-log.json",
  error: "errors-log.json"
};

export async function initializeLogs(): Promise<void> {
  await mkdir(projectPaths.logs, { recursive: true });
  await Promise.all([
    ensureJsonArray(logPath("phase")),
    ensureJsonArray(logPath("audit")),
    ensureJsonArray(logPath("error"))
  ]);
}

export async function writeCurrentPhase(entry: BaseLogEntry & { mode?: string }): Promise<string> {
  await mkdir(projectPaths.state, { recursive: true });
  const phasePath = path.join(projectPaths.state, "current-phase.json");
  await writeFile(phasePath, JSON.stringify({ ...entry, timestamp: entry.timestamp || new Date().toISOString() }, null, 2));
  return phasePath;
}

export async function appendLog(kind: LogKind, entry: BaseLogEntry | ErrorLogEntry): Promise<void> {
  await initializeLogs();
  const filePath = logPath(kind);
  const entries = await readJsonArray(filePath);
  entries.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
  await writeFile(filePath, JSON.stringify(entries, null, 2));
}

export async function logError(error: unknown, context: Partial<BaseLogEntry> = {}): Promise<void> {
  const normalized = normalizeError(error);
  await appendLog("error", {
    timestamp: new Date().toISOString(),
    stage: context.stage ?? "unknown",
    stageName: context.stageName ?? "Unknown",
    agent: context.agent ?? "system",
    event: context.event ?? "error",
    message: context.message,
    errorName: normalized.name,
    errorMessage: normalized.message,
    stack: normalized.stack,
    data: context.data
  });
}

export function logPath(kind: LogKind): string {
  return path.join(projectPaths.logs, logFiles[kind]);
}

async function ensureJsonArray(filePath: string): Promise<void> {
  if (existsSync(filePath)) return;
  await writeFile(filePath, "[]\n");
}

async function readJsonArray(filePath: string): Promise<unknown[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array.`);
  return parsed;
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "UnknownError", message: String(error) };
}
