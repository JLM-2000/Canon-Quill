// API keys entered through the Studio.
//
// I would rather these lived only in the environment, and said so. Since they
// are being entered in the UI, the storage is built to limit the blast radius
// rather than to be convenient:
//
//   - a dedicated file, never the project state that the UI renders and that
//     agents read
//   - .auth/ is gitignored, and the file is written 0600
//   - the key is never sent back to the browser; only a mask is
//   - "verify" makes a real, free call to the provider so a typo is caught
//     here instead of halfway through drafting a chapter

import { chmod, mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { ProviderId } from "./engine.js";

interface CredentialFile {
  anthropic?: string;
  openai?: string;
}

const dir = () => path.join(process.cwd(), ".auth");
const file = () => path.join(dir(), "credentials.json");

async function readAll(): Promise<CredentialFile> {
  try {
    return JSON.parse(await readFile(file(), "utf8")) as CredentialFile;
  } catch {
    return {};
  }
}

async function writeAll(data: CredentialFile): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, target);
}

/** The stored key for a provider, for server-side use only. */
export async function readApiKey(provider: ProviderId): Promise<string | undefined> {
  return (await readAll())[provider]?.trim() || undefined;
}

export async function saveApiKey(provider: ProviderId, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Key is empty.");
  await writeAll({ ...(await readAll()), [provider]: trimmed });
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  const all = await readAll();
  delete all[provider];
  if (Object.keys(all).length === 0) {
    await unlink(file()).catch(() => undefined);
    return;
  }
  await writeAll(all);
}

/**
 * Enough of the key to recognise it, never enough to use it.
 * Keeps the prefix, which is what distinguishes a provider and a key type.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return `${trimmed.slice(0, 2)}...`;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

/**
 * Check a key against the provider.
 *
 * Both endpoints list models: authenticated, free, and no tokens generated.
 * A 401 means the key is wrong; anything else is reported as-is rather than
 * being reduced to "invalid", because a network failure is not a bad key.
 */
export async function verifyApiKey(provider: ProviderId, key: string): Promise<VerifyResult> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, detail: "No key to verify." };

  const request: { url: string; headers: Record<string, string> } =
    provider === "anthropic"
      ? {
          url: "https://api.anthropic.com/v1/models?limit=1",
          headers: { "x-api-key": trimmed, "anthropic-version": "2023-06-01" }
        }
      : { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${trimmed}` } };

  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(15_000)
    });

    if (response.ok) {
      return { ok: true, detail: `Verified against ${provider === "anthropic" ? "Anthropic" : "OpenAI"}. The key works.` };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: `The provider rejected this key (HTTP ${response.status}). Check you copied all of it.` };
    }
    if (response.status === 429) {
      return { ok: false, detail: "Rate limited while checking. The key may be fine; try again shortly." };
    }
    return { ok: false, detail: `Unexpected response from the provider (HTTP ${response.status}).` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Could not reach the provider: ${reason}. This is a network problem, not necessarily a bad key.` };
  }
}
