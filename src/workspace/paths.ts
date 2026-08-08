/** Paths for one book workspace. */

import path from "node:path";

/** Resolve the workspace root, with a test/runtime override. */
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
