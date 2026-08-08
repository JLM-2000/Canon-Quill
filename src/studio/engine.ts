// Provider and model selection for the writing runtime.
//
// Canon Quill never accepts, stores, or transmits a credential. The Studio
// records which provider and auth method you chose and detects whether a
// usable credential already exists; the credential itself stays in your
// environment or in your runtime's own store. Detection reads only the
// provider names and the `type` discriminator out of a runtime's auth file,
// never the token or key values.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";

export type ProviderId = "anthropic" | "openai";
export type AuthMethod = "subscription" | "api_key";

export interface ModelEntry {
  id: string;
  label: string;
  context: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  verified: string | null;
  notes?: string;
}

export interface ProviderEntry {
  label: string;
  auth: Record<AuthMethod, { label: string; env?: string; setup: string }>;
  models: ModelEntry[];
}

export interface RoleEntry {
  description: string;
  anthropic: string;
  openai: string;
}

export interface ModelCatalog {
  roles: Record<string, RoleEntry>;
  providers: Record<ProviderId, ProviderEntry>;
  estimates?: Record<string, unknown>;
}

export interface CredentialStatus {
  ready: boolean;
  /** What was found, or what to do about it. */
  detail: string;
  /** Which runtime holds it, when one does. */
  runtime?: "claude-code" | "opencode" | "environment" | "studio";
  /** The env var checked, for the api_key method. */
  env?: string;
}

let cached: ModelCatalog | undefined;

export async function loadCatalog(): Promise<ModelCatalog> {
  if (cached) return cached;
  const raw = await readFile(path.join(process.cwd(), "config", "models.yaml"), "utf8");
  cached = parse(raw) as ModelCatalog;
  return cached;
}

export function defaultModels(catalog: ModelCatalog, provider: ProviderId): Record<string, string> {
  const models: Record<string, string> = {};
  for (const [role, entry] of Object.entries(catalog.roles)) {
    models[role] = entry[provider];
  }
  return models;
}

/**
 * What OpenCode has stored, by provider.
 *
 * `oauth` means a plan sign-in (`opencode auth login`), `api` means a key.
 * Only those two fields are read; the tokens are never touched.
 */
export function readOpenCodeAuth(): Record<string, "oauth" | "api"> {
  const file = path.join(homedir(), ".local", "share", "opencode", "auth.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { type?: string }>;
    const summary: Record<string, "oauth" | "api"> = {};
    for (const [provider, entry] of Object.entries(parsed)) {
      if (entry?.type === "oauth" || entry?.type === "api") summary[provider] = entry.type;
    }
    return summary;
  } catch {
    return {};
  }
}

/** True when Claude Code has been signed in on this machine. */
export function hasClaudeCodeLogin(): boolean {
  return existsSync(path.join(homedir(), ".claude"));
}

/**
 * Check whether the chosen provider and method can actually be used.
 *
 * Both runtimes are considered, because either can drive Canon Quill and they
 * store credentials in different places.
 */
export async function checkCredentials(
  provider: ProviderId,
  method: AuthMethod
): Promise<CredentialStatus> {
  const openCode = readOpenCodeAuth();
  const stored = openCode[provider];

  if (method === "api_key") {
    const env = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const { readApiKey } = await import("./credentials.js");
    if (await readApiKey(provider)) {
      return {
        ready: true,
        env,
        runtime: "studio",
        detail: "A key entered in the Studio is stored in .auth/credentials.json (gitignored, 0600)."
      };
    }
    if (process.env[env]?.trim()) {
      return { ready: true, env, runtime: "environment", detail: `${env} is set in this process's environment.` };
    }
    if (stored === "api") {
      return {
        ready: true,
        env,
        runtime: "opencode",
        detail: `OpenCode has an API key stored for ${provider}. Run it through OpenCode, or export ${env} to use it elsewhere.`
      };
    }
    return {
      ready: false,
      env,
      detail: `No key found for ${provider}. Paste one below, export ${env}, or run \`opencode auth login\` and choose the API key option.`
    };
  }

  // Subscription.
  if (stored === "oauth") {
    return {
      ready: true,
      runtime: "opencode",
      detail: `OpenCode is signed in to ${provider} with a plan. Nothing else to do.`
    };
  }

  if (provider === "anthropic" && hasClaudeCodeLogin()) {
    return {
      ready: true,
      runtime: "claude-code",
      detail:
        "Claude Code has a login stored in ~/.claude. Canon Quill cannot see inside it, so if writing fails on auth, run `claude` and sign in again."
    };
  }

  return {
    ready: false,
    detail:
      provider === "anthropic"
        ? "No plan sign-in found. Run `claude` and sign in once. A Claude plan cannot be used through OpenCode; use an API key on that runtime."
        : "No plan sign-in found. Run `opencode auth login`, pick OpenAI, and choose the ChatGPT sign-in option. Claude Code cannot use a ChatGPT plan."
  };
}
