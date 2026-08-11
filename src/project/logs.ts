/** Per-workspace structured logs. */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { workspacePaths } from "../workspace/paths.js";

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
  resolvedAt?: string;
  resolution?: string;
}

const logFiles: Record<LogKind, string> = {
  phase: "phase-log.json",
  audit: "audit-log.json",
  error: "errors-log.json"
};

let logWriteQueue = Promise.resolve();

export function logPath(slug: string, kind: LogKind): string {
  return path.join(workspacePaths(slug).logs, logFiles[kind]);
}

export async function initializeLogs(slug: string): Promise<void> {
  await mkdir(workspacePaths(slug).logs, { recursive: true });
  await Promise.all([
    ensureJsonArray(logPath(slug, "phase")),
    ensureJsonArray(logPath(slug, "audit")),
    ensureJsonArray(logPath(slug, "error"))
  ]);
}

export async function appendLog(slug: string, kind: LogKind, entry: BaseLogEntry | ErrorLogEntry): Promise<void> {
  const filePath = logPath(slug, kind);
  const operation = logWriteQueue.catch(() => undefined).then(async () => {
    await initializeLogs(slug);
    const entries = await readJsonArray(filePath);
    entries.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
    await writeFile(filePath, JSON.stringify(entries, null, 2));
  });
  logWriteQueue = operation.catch(() => undefined);
  await operation;
}

export async function readLog(slug: string, kind: LogKind): Promise<unknown[]> {
  return readJsonArray(logPath(slug, kind));
}

export async function resolveErrors(slug: string, matches: (entry: ErrorLogEntry) => boolean, resolution: string): Promise<number> {
  await initializeLogs(slug);
  const filePath = logPath(slug, "error");
  const entries = await readJsonArray(filePath) as ErrorLogEntry[];
  const resolvedAt = new Date().toISOString();
  let count = 0;
  for (const entry of entries) {
    if (entry.resolvedAt || !matches(entry)) continue;
    entry.resolvedAt = resolvedAt;
    entry.resolution = resolution;
    count += 1;
  }
  if (count) await writeFile(filePath, JSON.stringify(entries, null, 2));
  return count;
}

export async function logError(slug: string, error: unknown, context: Partial<BaseLogEntry> = {}): Promise<void> {
  const normalized = normalizeError(error);
  await appendLog(slug, "error", {
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

async function ensureJsonArray(filePath: string): Promise<void> {
  if (existsSync(filePath)) return;
  await writeFile(filePath, "[]\n");
}

async function readJsonArray(filePath: string): Promise<unknown[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    // A pre-queue runtime could have appended a second JSON value after the array.
    // Keep the valid history and let the next append rewrite the file cleanly.
    const position = Number(/position (\d+)/.exec(String(error))?.[1] ?? -1);
    const boundary = position >= 0 ? text.lastIndexOf("]", position) : -1;
    if (boundary < 0) throw error;
    parsed = JSON.parse(text.slice(0, boundary + 1)) as unknown;
  }
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array.`);
  return parsed;
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "UnknownError", message: String(error) };
}
