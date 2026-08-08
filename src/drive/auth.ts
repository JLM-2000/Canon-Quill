import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { explainMissingPath, resolveExistingPath } from "../config/env.js";

const defaultScopes = ["https://www.googleapis.com/auth/drive.file"];
const tokenRefreshSkewMs = 60_000;

interface OAuthClientConfig {
  client_id: string;
  client_secret?: string;
  auth_uri: string;
  token_uri: string;
}

interface OAuthCredentialsFile {
  installed?: OAuthClientConfig;
  web?: OAuthClientConfig;
}

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

interface TokenEndpointResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface DriveAuth {
  getAccessToken(): Promise<string>;
}

export async function createDriveAuth(): Promise<DriveAuth> {
  const credentials = await loadOAuthCredentials();
  const scopes = configuredScopes();
  const tokenPath = resolveTokenPath();
  let token = await loadStoredToken(tokenPath);

  return {
    async getAccessToken(): Promise<string> {
      token = await ensureToken(credentials, scopes, tokenPath, token);
      return token.access_token;
    }
  };
}

async function ensureToken(
  credentials: OAuthClientConfig,
  scopes: string[],
  tokenPath: string,
  token: StoredToken | undefined
): Promise<StoredToken> {
  if (token && isUsable(token)) return token;
  if (token?.refresh_token) {
    return refreshAccessToken(credentials, tokenPath, token);
  }
  return requestInitialToken(credentials, scopes, tokenPath);
}

function isUsable(token: StoredToken): boolean {
  if (!token.access_token) return false;
  if (!token.expiry_date) return true;
  return token.expiry_date - tokenRefreshSkewMs > Date.now();
}

async function loadOAuthCredentials(): Promise<OAuthClientConfig> {
  const configured = process.env.GOOGLE_OAUTH_CLIENT_JSON?.trim();

  if (!configured) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_JSON is not set.\n" +
        "  Add it to .env in the project root, or export it before starting the Studio:\n" +
        "    GOOGLE_OAUTH_CLIENT_JSON=/absolute/path/to/credentials.json\n" +
        "  Then restart the Studio so it picks up the change."
    );
  }

  const file = resolveExistingPath(configured);
  if (!file) {
    throw new Error(explainMissingPath("GOOGLE_OAUTH_CLIENT_JSON", configured));
  }

  let raw: OAuthCredentialsFile;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as OAuthCredentialsFile;
  } catch (error) {
    throw new Error(
      `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}\n` +
        "  If this is a permissions error on a Windows drive, copy the file into the project instead."
    );
  }

  const credentials = raw.installed ?? raw.web;
  if (!credentials?.client_id || !credentials.auth_uri || !credentials.token_uri) {
    // Being specific here matters: a service-account key is the usual mistake,
    // and it is a valid JSON file, so a generic parse error would mislead.
    const hint =
      "type" in (raw as Record<string, unknown>) &&
      (raw as unknown as { type?: string }).type === "service_account"
        ? "\n  That file is a service account key. Canon Quill needs an OAuth client ID of type Desktop app."
        : "\n  Expected a top-level \"installed\" (Desktop app) or \"web\" key. Re-download the OAuth client JSON from the Google Cloud console.";
    throw new Error(`${file} is not an OAuth client credentials file.${hint}`);
  }

  return credentials;
}

function configuredScopes(): string[] {
  const scopes = (process.env.CANON_QUILL_DRIVE_SCOPES ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : defaultScopes;
}

function resolveTokenPath(): string {
  // Drive auth is one Google account across every book, so it sits outside
  // the per-book workspaces.
  return resolve(process.env.GOOGLE_OAUTH_TOKEN_JSON ?? ".auth/google-drive-token.json");
}

async function loadStoredToken(tokenPath: string): Promise<StoredToken | undefined> {
  try {
    return JSON.parse(await readFile(tokenPath, "utf8")) as StoredToken;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function refreshAccessToken(
  credentials: OAuthClientConfig,
  tokenPath: string,
  previous: StoredToken
): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: credentials.client_id,
    refresh_token: previous.refresh_token ?? "",
    grant_type: "refresh_token"
  });
  if (credentials.client_secret) body.set("client_secret", credentials.client_secret);

  const response = await postToken(credentials.token_uri, body);
  const token = normalizeToken(response, previous);
  await saveStoredToken(tokenPath, token);
  return token;
}

async function requestInitialToken(
  credentials: OAuthClientConfig,
  scopes: string[],
  tokenPath: string
): Promise<StoredToken> {
  const state = randomUUID();
  const receiver = await startOAuthReceiver(state);
  const authUrl = new URL(credentials.auth_uri);
  authUrl.searchParams.set("client_id", credentials.client_id);
  authUrl.searchParams.set("redirect_uri", receiver.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  console.error("Opening Google OAuth consent in your browser.");
  console.error(`If the browser does not open, visit this URL:\n${authUrl.toString()}`);
  openBrowser(authUrl.toString());

  try {
    const code = await receiver.code;
    const body = new URLSearchParams({
      client_id: credentials.client_id,
      code,
      grant_type: "authorization_code",
      redirect_uri: receiver.redirectUri
    });
    if (credentials.client_secret) body.set("client_secret", credentials.client_secret);

    const response = await postToken(credentials.token_uri, body);
    const token = normalizeToken(response);
    await saveStoredToken(tokenPath, token);
    return token;
  } finally {
    await closeServer(receiver.server);
  }
}

async function postToken(tokenUri: string, body: URLSearchParams): Promise<TokenEndpointResponse> {
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as TokenEndpointResponse) : {};

  if (!response.ok || parsed.error) {
    const detail = parsed.error_description ?? parsed.error ?? response.statusText;
    throw new Error(`Google OAuth token request failed: ${detail}`);
  }

  return parsed;
}

function normalizeToken(response: TokenEndpointResponse, previous?: StoredToken): StoredToken {
  if (!response.access_token) throw new Error("Google OAuth response did not include an access token.");
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? previous?.refresh_token,
    scope: response.scope ?? previous?.scope,
    token_type: response.token_type ?? previous?.token_type,
    expiry_date: response.expires_in ? Date.now() + response.expires_in * 1000 : previous?.expiry_date
  };
}

async function saveStoredToken(tokenPath: string, token: StoredToken): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

async function startOAuthReceiver(state: string): Promise<{
  redirectUri: string;
  code: Promise<string>;
  server: Server;
}> {
  let redirectUri = "";
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;

  const code = new Promise<string>((resolveCodePromise, rejectCodePromise) => {
    resolveCode = resolveCodePromise;
    rejectCode = rejectCodePromise;
  });

  const server = createServer((request, response) => {
    if (!request.url) return;
    const url = new URL(request.url, redirectUri);

    if (url.pathname !== "/oauth2callback") {
      response.writeHead(404).end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    const codeParam = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (error) {
      finish(new Error(`Google OAuth failed: ${error}`));
      response.writeHead(400).end("Canon Quill authorization failed. You can close this tab.");
      return;
    }

    if (returnedState !== state) {
      finish(new Error("Google OAuth returned an invalid state value."));
      response.writeHead(400).end("Canon Quill authorization failed. You can close this tab.");
      return;
    }

    if (!codeParam) {
      finish(new Error("Google OAuth did not return an authorization code."));
      response.writeHead(400).end("Canon Quill authorization failed. You can close this tab.");
      return;
    }

    finish(undefined, codeParam);
    response.writeHead(200).end("Canon Quill is authorized. You can close this tab.");
  });

  server.on("error", (error) => finish(error));

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  return { redirectUri, code, server };

  function finish(error?: Error, receivedCode?: string): void {
    if (settled) return;
    settled = true;
    if (error) rejectCode(error);
    else resolveCode(receivedCode ?? "");
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function openBrowser(url: string): void {
  const command = browserCommand(url);
  const child = spawn(command.executable, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    console.error("Could not open the browser automatically. Use the URL printed above.");
  });
  child.unref();
}

function browserCommand(url: string): { executable: string; args: string[] } {
  if (process.platform === "win32") return { executable: "cmd", args: ["/c", "start", "", url] };
  if (process.platform === "darwin") return { executable: "open", args: [url] };
  if (process.env.WSL_DISTRO_NAME) return { executable: "cmd.exe", args: ["/c", "start", "", url] };
  return { executable: "xdg-open", args: [url] };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
