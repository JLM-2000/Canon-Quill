import { randomUUID } from "node:crypto";
import { createDriveAuth, type DriveAuth } from "./auth.js";
import type { DriveFileSummary, DriveTreeNode, UploadBinaryFileInput, WriteTextFileInput } from "./types.js";

const driveApiBase = "https://www.googleapis.com/drive/v3/";
const driveUploadBase = "https://www.googleapis.com/upload/drive/v3/";
const googleDocMime = "application/vnd.google-apps.document";
const googleFolderMime = "application/vnd.google-apps.folder";

interface DriveApiFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  modifiedTime?: string | null;
  size?: string | null;
  capabilities?: {
    canDownload?: boolean | null;
  };
}

export class SafeDriveClient {
  private authPromise: Promise<DriveAuth> | undefined;

  /**
   * List a folder's immediate children, following pagination.
   *
   * Drive caps `pageSize` at 1000 and returns a `nextPageToken` for the rest.
   * Ignoring that token silently truncates large reference folders, which is
   * the worst possible failure here: the book would be written against a
   * partial view of the author's canon with nothing reporting a problem.
   */
  async listFolder(folderId: string): Promise<DriveFileSummary[]> {
    const files: DriveFileSummary[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.requestJson<{ files?: DriveApiFile[]; nextPageToken?: string }>(
        driveUrl("files", {
          q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
          pageSize: 1000,
          orderBy: "folder,name",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          ...(pageToken ? { pageToken } : {})
        })
      );

      for (const file of response.files ?? []) files.push(toSummary(file));
      pageToken = response.nextPageToken;
    } while (pageToken);

    return files;
  }

  /**
   * Walk a folder recursively.
   *
   * Bounded by `maxDepth` and `maxFiles` so a mistakenly selected Drive root
   * cannot turn into an unbounded crawl. Cycles are impossible in Drive's
   * folder graph via `in parents`, but shortcuts can produce repeats, so
   * visited ids are tracked.
   */
  async walkFolder(
    folderId: string,
    options: { maxDepth?: number; maxFiles?: number } = {}
  ): Promise<DriveTreeNode[]> {
    const maxDepth = options.maxDepth ?? 6;
    const maxFiles = options.maxFiles ?? 5000;
    const visited = new Set<string>();
    let count = 0;

    const walk = async (id: string, depth: number, path: string): Promise<DriveTreeNode[]> => {
      if (depth > maxDepth || count >= maxFiles || visited.has(id)) return [];
      visited.add(id);

      const children = await this.listFolder(id);
      const nodes: DriveTreeNode[] = [];

      for (const child of children) {
        if (count >= maxFiles) break;
        count += 1;
        const childPath = `${path}/${child.name}`;
        const isFolder = child.mimeType === googleFolderMime;
        nodes.push({
          ...child,
          path: childPath,
          isFolder,
          children: isFolder ? await walk(child.id, depth + 1, childPath) : undefined
        });
      }

      return nodes;
    };

    return walk(folderId, 0, "");
  }

  /** Fetch metadata for a single file or folder. */
  async getMetadata(fileId: string): Promise<DriveFileSummary> {
    const file = await this.requestJson<DriveApiFile>(
      driveUrl(`files/${encodeURIComponent(fileId)}`, {
        fields: "id,name,mimeType,modifiedTime,size",
        supportsAllDrives: true
      })
    );
    return toSummary(file);
  }

  async readFileText(fileId: string): Promise<string> {
    const meta = await this.requestJson<DriveApiFile>(
      driveUrl(`files/${encodeURIComponent(fileId)}`, {
        fields: "id,name,mimeType,capabilities(canDownload)",
        supportsAllDrives: true
      })
    );
    const mimeType = meta.mimeType ?? "";

    if (mimeType === googleFolderMime) throw new Error("Cannot read a folder as text.");

    if (mimeType.startsWith("application/vnd.google-apps.")) {
      return this.requestText(
        driveUrl(`files/${encodeURIComponent(fileId)}/export`, { mimeType: "text/plain" })
      );
    }

    if (meta.capabilities?.canDownload === false) {
      throw new Error(`Drive file '${meta.name ?? fileId}' cannot be downloaded by this user.`);
    }

    return this.requestText(driveUrl(`files/${encodeURIComponent(fileId)}`, { alt: "media" }));
  }

  async writeTextFile(input: WriteTextFileInput): Promise<DriveFileSummary> {
    return this.uploadContent({
      folderId: input.folderId,
      name: input.name,
      content: Buffer.from(input.content, "utf8"),
      mimeType: input.mimeType ?? "text/markdown",
      overwrite: input.overwrite
    });
  }

  async uploadBinaryFile(input: UploadBinaryFileInput): Promise<DriveFileSummary> {
    return this.uploadContent({
      folderId: input.folderId,
      name: input.name,
      content: Buffer.from(input.base64Content, "base64"),
      mimeType: input.mimeType,
      overwrite: input.overwrite
    });
  }

  private async uploadContent(input: {
    folderId: string;
    name: string;
    content: Buffer;
    mimeType: string;
    overwrite?: boolean;
  }): Promise<DriveFileSummary> {
    const allowOverwrite = input.overwrite ?? process.env.CANON_QUILL_ALLOW_OVERWRITE === "true";
    const existing = await this.findByName(input.folderId, input.name);

    if (existing && !allowOverwrite) {
      throw new Error(`Target file '${input.name}' already exists. Refusing overwrite.`);
    }

    const metadata = existing
      ? { name: input.name, mimeType: input.mimeType }
      : { name: input.name, parents: [input.folderId], mimeType: input.mimeType };
    const body = multipartBody(metadata, input.content, input.mimeType);

    const url = existing
      ? uploadUrl(`files/${encodeURIComponent(existing.id)}`, {
          uploadType: "multipart",
          supportsAllDrives: true,
          fields: "id,name,mimeType,modifiedTime"
        })
      : uploadUrl("files", {
          uploadType: "multipart",
          supportsAllDrives: true,
          fields: "id,name,mimeType,modifiedTime"
        });

    const file = await this.requestJson<DriveApiFile>(url, {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": body.contentType },
      body: body.buffer as unknown as BodyInit
    });
    return toSummary(file);
  }

  private async findByName(folderId: string, name: string): Promise<DriveFileSummary | undefined> {
    const response = await this.requestJson<{ files?: DriveApiFile[] }>(
      driveUrl("files", {
        q: `'${escapeDriveQueryValue(folderId)}' in parents and name = '${escapeDriveQueryValue(name)}' and trashed = false`,
        fields: "files(id,name,mimeType,modifiedTime)",
        pageSize: 2,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      })
    );
    const first = response.files?.[0];
    return first ? toSummary(first) : undefined;
  }

  private async requestJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async requestText(url: URL, init: RequestInit = {}): Promise<string> {
    const response = await this.request(url, init);
    return Buffer.from(await response.arrayBuffer()).toString("utf8");
  }

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    const auth = await this.auth();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await auth.getAccessToken()}`);

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      throw new Error(`Google Drive request failed (${response.status}): ${await responseError(response)}`);
    }
    return response;
  }

  private auth(): Promise<DriveAuth> {
    this.authPromise ??= createDriveAuth();
    return this.authPromise;
  }
}

function driveUrl(path: string, params?: Record<string, string | number | boolean>): URL {
  return withParams(new URL(path, driveApiBase), params);
}

function uploadUrl(path: string, params?: Record<string, string | number | boolean>): URL {
  return withParams(new URL(path, driveUploadBase), params);
}

function withParams(url: URL, params?: Record<string, string | number | boolean>): URL {
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function multipartBody(metadata: unknown, content: Buffer, mimeType: string): { contentType: string; buffer: Buffer } {
  const boundary = `canon-quill-${randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8"
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    buffer: Buffer.concat([prefix, content, suffix])
  };
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText;

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}

function requireId(id: string | null | undefined): string {
  if (!id) throw new Error("Drive returned a file without an ID.");
  return id;
}

function toSummary(file: DriveApiFile): DriveFileSummary {
  const size = file.size ? Number(file.size) : undefined;
  return {
    id: requireId(file.id),
    name: file.name ?? "Untitled",
    mimeType: file.mimeType ?? "application/octet-stream",
    modifiedTime: file.modifiedTime ?? undefined,
    size: Number.isFinite(size) ? size : undefined
  };
}
