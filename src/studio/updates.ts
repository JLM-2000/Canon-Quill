// Version reporting and self-update.
//
// The Studio is usually left running while the repo moves underneath it, so it
// needs to know what it is running and whether something newer exists. This
// replaces a banner that could only tell you to restart.
//
// Updating runs git and npm against the working copy, so the guardrails matter
// more than the convenience: fast-forward only, refuse to touch a dirty tree,
// and never invoke a shell.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Run a command with no shell, so nothing here can be injected into. */
async function git(args: string[], cwd: string, timeout = 20_000): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout, windowsHide: true });
  return stdout.trim();
}

export interface CommitSummary {
  sha: string;
  subject: string;
  date: string;
}

export interface VersionInfo {
  /** From package.json. */
  version: string;
  /** Short sha of the running checkout, or null outside a git repo. */
  commit: string | null;
  branch: string | null;
  /** Uncommitted changes are present. */
  dirty: boolean;
  /** Commits on the remote that are not here yet. */
  behind: number;
  /** Local commits not pushed. Blocks a fast-forward update. */
  ahead: number;
  /** What is waiting, newest first. */
  pending: CommitSummary[];
  /** Why an update cannot be offered, when it cannot. */
  blocked: string | null;
  /** Source files changed after this process started, so it is running old code. */
  localStale: boolean;
  checkedAt: string;
}

/**
 * Newest mtime under the source directories.
 *
 * The UI file is re-read per request, but everything else is loaded once at
 * startup, so editing a source file leaves a half-updated app. That is what
 * makes a request fail with a message about a field the running code has never
 * heard of.
 */
async function newestSourceChange(cwd: string): Promise<number> {
  const { readdir, stat } = await import("node:fs/promises");
  let newest = 0;

  const walk = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/\.(ts|mjs|yaml)$/.test(entry.name)) {
        const info = await stat(full).catch(() => undefined);
        if (info && info.mtimeMs > newest) newest = info.mtimeMs;
      }
    }
  };

  await Promise.all([walk(path.join(cwd, "src")), walk(path.join(cwd, "config"))]);
  return newest;
}

const processStartedAt = Date.now();

async function packageVersion(cwd: string): Promise<string> {
  try {
    const raw = await readFile(path.join(cwd, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Describe the running checkout and what is available.
 *
 * `fetch` is optional so the common poll stays local and cheap; the UI asks for
 * a remote check on a longer interval and when the panel is opened.
 */
export async function getVersionInfo(fetchRemote = false, cwd: string = process.cwd()): Promise<VersionInfo> {
  const version = await packageVersion(cwd);
  const base: VersionInfo = {
    version,
    commit: null,
    branch: null,
    dirty: false,
    behind: 0,
    ahead: 0,
    pending: [],
    blocked: null,
    localStale: (await newestSourceChange(cwd)) > processStartedAt,
    checkedAt: new Date().toISOString()
  };

  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd, 5000);
  } catch {
    return { ...base, blocked: "Not a git checkout, so updates cannot be applied here." };
  }

  const commit = await git(["rev-parse", "--short", "HEAD"], cwd).catch(() => null);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => null);
  const dirty = Boolean(await git(["status", "--porcelain"], cwd).catch(() => ""));

  if (fetchRemote) {
    // A missing or unreachable remote is not fatal; the rest still reports.
    await git(["fetch", "--quiet", "origin"], cwd, 45_000).catch(() => undefined);
  }

  const upstream = `origin/${branch ?? "main"}`;
  let behind = 0;
  let ahead = 0;
  try {
    const counts = await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], cwd);
    const [aheadRaw, behindRaw] = counts.split(/\s+/);
    ahead = Number(aheadRaw) || 0;
    behind = Number(behindRaw) || 0;
  } catch {
    return { ...base, commit, branch, dirty, blocked: "No matching branch on the remote to compare against." };
  }

  const pending: CommitSummary[] = [];
  if (behind > 0) {
    const log = await git(["log", "--pretty=format:%h%s%cI", `HEAD..${upstream}`], cwd).catch(() => "");
    for (const line of log.split("\n").filter(Boolean)) {
      const [sha, subject, date] = line.split("");
      pending.push({ sha, subject, date });
    }
  }

  let blocked: string | null = null;
  if (behind > 0 && dirty) {
    blocked = "You have uncommitted changes. Commit or stash them first so the update cannot discard your work.";
  } else if (behind > 0 && ahead > 0) {
    blocked = `This branch has ${ahead} local ${ahead === 1 ? "commit" : "commits"} that are not on the remote. Push or rebase first.`;
  }

  return { ...base, commit, branch, dirty, behind, ahead, pending, blocked };
}

export interface UpdateStep {
  label: string;
  ok: boolean;
  output: string;
}

export interface UpdateResult {
  ok: boolean;
  steps: UpdateStep[];
  /** The checkout after a successful update. */
  commit?: string | null;
}

/**
 * Pull, install and rebuild.
 *
 * Fast-forward only: a merge would need conflict resolution that nobody can do
 * from a web page. Each step's output is returned so a failure is legible
 * rather than a spinner that stops.
 */
export async function applyUpdate(cwd: string = process.cwd()): Promise<UpdateResult> {
  const steps: UpdateStep[] = [];

  const info = await getVersionInfo(true, cwd);
  if (info.blocked) return { ok: false, steps: [{ label: "Preflight", ok: false, output: info.blocked }] };
  if (info.behind === 0) return { ok: false, steps: [{ label: "Preflight", ok: false, output: "Already up to date." }] };

  const attempt = async (label: string, command: string, args: string[], timeout: number): Promise<boolean> => {
    try {
      const { stdout, stderr } = await run(command, args, { cwd, timeout, windowsHide: true });
      steps.push({ label, ok: true, output: (stdout + stderr).trim().slice(-4000) });
      return true;
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      steps.push({
        label,
        ok: false,
        output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.trim().slice(-4000)
      });
      return false;
    }
  };

  if (!(await attempt("Pull", "git", ["merge", "--ff-only", `origin/${info.branch ?? "main"}`], 60_000))) {
    return { ok: false, steps };
  }
  if (!(await attempt("Install dependencies", "npm", ["install", "--no-audit", "--no-fund"], 300_000))) {
    return { ok: false, steps };
  }
  if (!(await attempt("Build", "npm", ["run", "build"], 300_000))) {
    return { ok: false, steps };
  }

  return { ok: true, steps, commit: await git(["rev-parse", "--short", "HEAD"], cwd).catch(() => null) };
}
