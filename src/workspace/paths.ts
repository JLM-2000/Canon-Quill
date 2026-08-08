/**
 * Workspace layout.
 *
 * Canon Quill used to keep one book in a single `.canon-quill/` directory, and
 * "archiving" a finished project meant copying it away and then deleting the
 * original so the next book could reuse the same path. That made a second book
 * impossible to start without ending the first, and made a finished book
 * harder to reopen than it should be.
 *
 * Now every book is a workspace under `workspaces/<slug>/`, and finishing one
 * is a status change rather than a destructive move. Nothing is ever deleted to
 * make room.
 *
 *   workspaces/
 *     registry.json                  which projects exist, which is active
 *     the-tide-house/
 *       project.json                 Studio state for this book
 *       logs/                        phase, audit and error logs
 *       drive-cache/                 fetched Drive documents, by file id
 *       artifacts/
 *         style-corpus.json          beat-tagged passages + fingerprint
 *         style-fingerprint.md
 *         chapters/                  drafts, edits, per-chapter reports
 *         continuity/                ledger.json + per-chapter handoffs
 *         final/                     manuscript.md, manuscript.docx, reports
 *
 * The whole `workspaces/` tree is gitignored. The repo holds the engine; your
 * books live beside it, never in it.
 */

import path from "node:path";

/**
 * Root of the workspaces tree.
 *
 * `CANON_QUILL_WORKSPACES_ROOT` overrides it. The test suite sets that to a
 * temp directory, because it deletes this root between cases and previously
 * did so against the author's real books.
 */
export function workspacesRoot(): string {
  const override = process.env.CANON_QUILL_WORKSPACES_ROOT?.trim();
  return override ? path.resolve(override) : path.join(process.cwd(), "workspaces");
}

export function registryPath(): string {
  return path.join(workspacesRoot(), "registry.json");
}

export interface WorkspacePaths {
  slug: string;
  root: string;
  stateFile: string;
  logs: string;
  driveCache: string;
  artifacts: string;
  chapters: string;
  continuity: string;
  final: string;
}

/** Every path belonging to one book. */
export function workspacePaths(slug: string): WorkspacePaths {
  const root = path.join(workspacesRoot(), slug);
  const artifacts = path.join(root, "artifacts");
  return {
    slug,
    root,
    stateFile: path.join(root, "project.json"),
    logs: path.join(root, "logs"),
    driveCache: path.join(root, "drive-cache"),
    artifacts,
    chapters: path.join(artifacts, "chapters"),
    continuity: path.join(artifacts, "continuity"),
    final: path.join(artifacts, "final")
  };
}

/**
 * Turn a book title into a directory name.
 *
 * Rejects rather than sanitises anything that could escape the workspaces
 * tree: a title of `../../etc` must not silently become a path traversal.
 */
export function toSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  if (!slug) throw new Error(`Cannot derive a folder name from the title "${title}".`);
  return slug;
}

/** Guard against a slug that would resolve outside `workspaces/`. */
export function assertSafeSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Unsafe workspace name: "${slug}".`);
  }
  const resolved = path.resolve(workspacesRoot(), slug);
  const root = path.resolve(workspacesRoot());
  if (resolved !== path.join(root, slug) || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Unsafe workspace path: "${slug}".`);
  }
}
