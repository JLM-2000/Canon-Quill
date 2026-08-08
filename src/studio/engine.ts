// Provider and model selection for the writing runtime.
//
// Canon Quill never accepts, stores, or transmits an API key. The Studio
// records which provider and auth method you chose and *detects* whether a
// usable credential is present; the credential itself stays in your
// environment or in your agent runtime's own login. A key typed into a web
// form would end up in a plaintext state file, which is not a trade worth
// making for saving one export.

import { readFile } from "node:fs/promises";
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
  estimates?: Record<string, string>;
}

export interface CredentialStatus {
  /** Whether a usable credential was detected for the chosen method. */
  ready: boolean;
  /** What was detected, or what is missing and how to supply it. */
  detail: string;
  /** The env var checked, when the method is api_key. */
  env?: string;
}

let cached: ModelCatalog | undefined;

export async function loadCatalog(): Promise<ModelCatalog> {
  if (cached) return cached;
  const raw = await readFile(path.join(process.cwd(), "config", "models.yaml"), "utf8");
  cached = parse(raw) as ModelCatalog;
  return cached;
}

/** Default model per role for a provider, from the catalog. */
export function defaultModels(catalog: ModelCatalog, provider: ProviderId): Record<string, string> {
  const models: Record<string, string> = {};
  for (const [role, entry] of Object.entries(catalog.roles)) {
    models[role] = entry[provider];
  }
  return models;
}

/**
 * Check whether the chosen provider and auth method can actually be used.
 *
 * For API keys this is an env-var check. For subscriptions it is a check that
 * the runtime's own credential store exists, since the runtime holds the login
 * and Canon Quill has no way to see inside it.
 */
export async function checkCredentials(
  provider: ProviderId,
  method: AuthMethod
): Promise<CredentialStatus> {
  if (method === "api_key") {
    const env = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const present = Boolean(process.env[env]?.trim());
    return {
      ready: present,
      env,
      detail: present
        ? `${env} is set in this process's environment.`
        : `${env} is not set. Export it in the shell you start the Studio from, or add it to .env.`
    };
  }

  if (provider === "openai") {
    return {
      ready: false,
      detail:
        "Claude Code cannot sign in with a ChatGPT plan. Use an API key for OpenAI, or run Canon Quill through a runtime that supports ChatGPT sign-in."
    };
  }

  // Anthropic subscription: the login lives in the runtime's config directory.
  const { existsSync } = await import("node:fs");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [
    path.join(home, ".claude"),
    path.join(home, ".config", "anthropic"),
    path.join(home, ".opencode")
  ];
  const found = candidates.find((dir) => existsSync(dir));

  return {
    ready: Boolean(found),
    detail: found
      ? `Found a runtime config at ${found}. Canon Quill cannot verify the login itself; if writing fails on auth, sign in again with \`claude\`.`
      : "No agent runtime config found. Run `claude` (or `opencode`) once and sign in with your plan."
  };
}
