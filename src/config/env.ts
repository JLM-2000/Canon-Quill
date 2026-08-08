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

/** Strip one optional layer of surrounding quotes and trim. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Every place a user-supplied path might really live, most likely first.
 *
 * The same `.env` should work whether it is read by Node on Windows, in WSL,
 * on macOS or on Linux, so a path written for one is translated for whichever
 * is actually running. Platform is passed in so this is testable off-platform.
 */
export function candidatePaths(raw: string, platform: NodeJS.Platform = process.platform): string[] {
  let value = unquote(raw);
  if (!value) return [];

  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = homedir() + value.slice(1).replace(/\\/g, "/");
  }

  const onWindows = platform === "win32";
  const windowsDrive = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  const wslMount = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(value);
  const unc = /^\\\\wsl(?:\$|\.localhost)[\\/][^\\/]+[\\/](.*)$/.exec(value);

  if (windowsDrive) {
    const drive = windowsDrive[1];
    const rest = windowsDrive[2].replace(/\\/g, "/");
    if (onWindows) return [`${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`];
    // Linux or macOS reading a Windows path: try the usual mount points.
    return [
      `/mnt/${drive.toLowerCase()}/${rest}`,
      `/${drive.toLowerCase()}/${rest}`,
      `/mnt/${drive.toUpperCase()}/${rest}`
    ];
  }

  if (wslMount && onWindows) {
    // A WSL path handed to native Windows: map the mount back to a drive.
    const rest = wslMount[2].replace(/\//g, "\\");
    return [`${wslMount[1].toUpperCase()}:\\${rest}`, path.resolve(value)];
  }

  if (unc && !onWindows) {
    // \\wsl$\Distro\home\me\x is just /home/me/x from inside the distro.
    return [`/${unc[1].replace(/\\/g, "/")}`];
  }

  if (onWindows) return [path.resolve(value)];
  // POSIX: backslashes are legal filename characters, so leave them alone.
  return [path.resolve(value)];
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
