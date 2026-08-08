/**
 * Per-workspace structured logs.
 *
 * Every entry belongs to a specific book. The previous version wrote to one
 * global `.canon-quill/logs/` directory, so two projects would have interleaved
 * their phase history into the same file.
 */

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
}

const logFiles: Record<LogKind, string> = {
  phase: "phase-log.json",
  audit: "audit-log.json",
  error: "errors-log.json"
};

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
  await initializeLogs(slug);
  const filePath = logPath(slug, kind);
  const entries = await readJsonArray(filePath);
  entries.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
  await writeFile(filePath, JSON.stringify(entries, null, 2));
}

export async function readLog(slug: string, kind: LogKind): Promise<unknown[]> {
  return readJsonArray(logPath(slug, kind));
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
