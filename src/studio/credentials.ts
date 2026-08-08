// Keys are stored outside project state, written with mode 0600, and returned
// only as masks.

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

/** Why a provider call failed, so the UI can say something useful. */
export type FailureKind =
  | "invalid"       // rejected outright: wrong, revoked or cancelled
  | "no_credit"     // authenticated, but nothing left to spend
  | "rate_limited"  // too fast, or a plan cap reached
  | "network"       // never reached the provider
  | "unknown";

export interface VerifyResult {
  ok: boolean;
  detail: string;
  kind?: FailureKind;
  /** Whether waiting and trying the same thing again might work. */
  retryable?: boolean;
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

  const label = provider === "anthropic" ? "Anthropic" : "OpenAI";

  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(15_000)
    });

    if (response.ok) return { ok: true, detail: `Verified against ${label}. The key works.` };

    // The body carries the distinction that matters most: a key that is
    // rejected outright needs replacing, one that is out of credit needs
    // topping up, and neither is a rate limit you can wait out.
    const body = await response.text().catch(() => "");
    const lower = body.toLowerCase();
    const outOfCredit =
      lower.includes("insufficient_quota") ||
      lower.includes("credit balance") ||
      lower.includes("billing") ||
      lower.includes("exceeded your current quota");

    if (outOfCredit) {
      return {
        ok: false,
        kind: "no_credit",
        retryable: false,
        detail: `${label} accepted the key but there is nothing left to spend on it. Add credit or raise the billing limit, then try again.`
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        kind: "invalid",
        retryable: false,
        detail: `${label} rejected this key (HTTP ${response.status}). It may be mistyped, revoked or deleted. Create a new one and paste it again.`
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        kind: "rate_limited",
        retryable: true,
        detail: `${label} is rate limiting this key, or a usage cap has been reached. Waiting usually clears it; a plan cap may need until the period resets.`
      };
    }
    return {
      ok: false,
      kind: "unknown",
      retryable: true,
      detail: `Unexpected response from ${label} (HTTP ${response.status}).`
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "network",
      retryable: true,
      detail: `Could not reach ${label}: ${reason}. This is a network problem, not necessarily a bad key.`
    };
  }
}
