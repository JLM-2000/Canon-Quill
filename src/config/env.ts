// Loading .env, and making user-supplied paths work.
//
// Two things bit us here. Nothing loaded .env at all, so a correctly filled-in
// file did nothing and Drive reported a missing variable. And on WSL a path
// copied from Windows Explorer (C:\Users\...) is not openable by a Linux Node
// process, which produced the same unhelpful message for a different reason.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Load .env into process.env.
 *
 * Values already present in the environment win, so an explicit export always
 * beats the file. Values are taken literally apart from one optional layer of
 * surrounding quotes: no escape processing, because `C:\Users\...` would
 * otherwise lose its backslashes.
 */
export function loadDotEnv(root: string = process.cwd()): string[] {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return [];

  const loaded: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/** True when this Linux process is running inside WSL. */
export function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"))
  );
}

/**
 * Every place a user-supplied path might really live, most likely first.
 *
 * A Windows path given to a Linux process is translated to its mount point.
 * `/mnt/c` is the WSL default but is configurable, so the common alternatives
 * are tried too rather than assumed.
 */
export function candidatePaths(raw: string): string[] {
  let value = raw.trim();
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return [];

  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(homedir(), value.slice(1).replace(/\\/g, "/"));
  }

  const windowsDrive = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (windowsDrive && process.platform !== "win32") {
    const drive = windowsDrive[1].toLowerCase();
    const rest = windowsDrive[2].replace(/\\/g, "/");
    return [`/mnt/${drive}/${rest}`, `/${drive}/${rest}`, `/mnt/${drive.toUpperCase()}/${rest}`];
  }

  // A UNC path (\\wsl$\...) or a plain relative/absolute path.
  return [path.resolve(value.replace(/\\/g, path.sep === "\\" ? "\\" : "/"))];
}

/** The first candidate that exists, or undefined. */
export function resolveExistingPath(raw: string): string | undefined {
  return candidatePaths(raw).find((candidate) => existsSync(candidate));
}

/**
 * Explain why a path could not be used, in terms the reader can act on.
 * Generic "file not found" is useless when the real problem is that a Windows
 * path needs translating.
 */
export function explainMissingPath(label: string, raw: string): string {
  const candidates = candidatePaths(raw);
  const looksWindows = /^[A-Za-z]:[\\/]/.test(raw.trim().replace(/^["']|["']$/g, ""));

  const lines = [`${label} points to a file that does not exist.`, `  configured: ${raw}`];
  if (candidates.length > 0) lines.push(`  looked in:  ${candidates.join("\n              ")}`);

  if (looksWindows && isWsl()) {
    lines.push(
      "",
      "That is a Windows path and this is a Linux process inside WSL, so it was",
      "translated to the mount point above. If the file really is there, check the",
      "spelling; if your WSL mounts drives somewhere other than /mnt, use the Linux",
      "path directly.",
      "",
      "Tip: copying the file into the project is often simpler than pointing across",
      "the Windows boundary. From WSL:",
      `  cp "${candidates[0]}" ./google-oauth.json`,
      "  then set the variable to ./google-oauth.json"
    );
  } else if (looksWindows) {
    lines.push("", "That is a Windows path but this process cannot see a Windows filesystem.");
  }

  return lines.join("\n");
}
