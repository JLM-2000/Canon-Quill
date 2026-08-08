/**
 * The workspace registry: which books exist and which one you are working on.
 *
 * Kept as a small index rather than derived by scanning the directory on every
 * call, so the Studio can list projects with their titles and status without
 * opening each `project.json`. The directory remains the source of truth for
 * content -- `listProjects` reconciles the index against what is actually on
 * disk, so a manually deleted folder does not haunt the UI.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { assertSafeSlug, registryPath, toSlug, workspacePaths, workspacesRoot } from "./paths.js";

export type ProjectStatus = "active" | "finished";

export interface ProjectEntry {
  slug: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Registry {
  version: 1;
  activeSlug: string | null;
  projects: ProjectEntry[];
}

const emptyRegistry = (): Registry => ({ version: 1, activeSlug: null, projects: [] });

async function readRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), "utf8")) as Partial<Registry>;
    return { ...emptyRegistry(), ...parsed, version: 1 };
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistry(registry: Registry): Promise<Registry> {
  await mkdir(workspacesRoot(), { recursive: true });
  const target = registryPath();
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(registry, null, 2), "utf8");
  await rename(temp, target);
  return registry;
}

/**
 * List known projects, reconciled against the directory tree.
 *
 * Drops index entries whose folder is gone, and adopts folders that exist but
 * were never indexed (a project copied in by hand, or a registry lost to a
 * failed write).
 */
export async function listProjects(): Promise<ProjectEntry[]> {
  const registry = await readRegistry();
  const onDisk = await readWorkspaceDirs();

  const known = new Map(registry.projects.map((project) => [project.slug, project]));
  const reconciled: ProjectEntry[] = [];

  for (const slug of onDisk) {
    const existing = known.get(slug);
    if (existing) {
      reconciled.push(existing);
      continue;
    }
    reconciled.push({
      slug,
      title: await titleFromDisk(slug),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  const changed =
    reconciled.length !== registry.projects.length ||
    reconciled.some((project, index) => project.slug !== registry.projects[index]?.slug);

  if (changed) {
    const activeStillExists = registry.activeSlug && reconciled.some((p) => p.slug === registry.activeSlug);
    await writeRegistry({
      ...registry,
      projects: reconciled,
      activeSlug: activeStillExists ? registry.activeSlug : (reconciled[0]?.slug ?? null)
    });
  }

  return reconciled.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The slug of the project currently being worked on, if any. */
export async function activeSlug(): Promise<string | null> {
  const registry = await readRegistry();
  if (!registry.activeSlug) return null;
  if (!existsSync(workspacePaths(registry.activeSlug).root)) return null;
  return registry.activeSlug;
}

/** Create a book, its directory tree, and make it active. */
export async function createProject(title: string): Promise<ProjectEntry> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("A book title is required.");

  const base = toSlug(trimmed);
  const slug = await uniqueSlug(base);
  assertSafeSlug(slug);

  const paths = workspacePaths(slug);
  await Promise.all([
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.driveCache, { recursive: true }),
    mkdir(paths.chapters, { recursive: true }),
    mkdir(paths.continuity, { recursive: true }),
    mkdir(paths.final, { recursive: true })
  ]);

  const now = new Date().toISOString();
  const entry: ProjectEntry = { slug, title: trimmed, status: "active", createdAt: now, updatedAt: now };

  const registry = await readRegistry();
  await writeRegistry({
    ...registry,
    activeSlug: slug,
    projects: [...registry.projects.filter((project) => project.slug !== slug), entry]
  });

  return entry;
}

export async function setActiveProject(slug: string): Promise<ProjectEntry> {
  assertSafeSlug(slug);
  const registry = await readRegistry();
  const project = registry.projects.find((entry) => entry.slug === slug);
  if (!project) throw new Error(`No project named "${slug}".`);
  await writeRegistry({ ...registry, activeSlug: slug });
  return project;
}

/** Update a project's title or status in the index. */
export async function touchProject(
  slug: string,
  patch: Partial<Pick<ProjectEntry, "title" | "status">> = {}
): Promise<void> {
  const registry = await readRegistry();
  const project = registry.projects.find((entry) => entry.slug === slug);
  if (!project) return;
  Object.assign(project, patch, { updatedAt: new Date().toISOString() });
  await writeRegistry(registry);
}

/**
 * Mark a book finished.
 *
 * Deliberately not destructive: the old archive step copied the workspace away
 * and deleted the original, which meant reopening a finished book was a manual
 * restore. Finished projects stay exactly where they are.
 */
export async function finishProject(slug: string): Promise<void> {
  await touchProject(slug, { status: "finished" });
}

/** Permanently delete a project and everything in it. */
export async function deleteProject(slug: string): Promise<void> {
  assertSafeSlug(slug);
  await rm(workspacePaths(slug).root, { recursive: true, force: true });
  const registry = await readRegistry();
  const projects = registry.projects.filter((entry) => entry.slug !== slug);
  await writeRegistry({
    ...registry,
    projects,
    activeSlug: registry.activeSlug === slug ? (projects[0]?.slug ?? null) : registry.activeSlug
  });
}

async function readWorkspaceDirs(): Promise<string[]> {
  try {
    const entries = await readdir(workspacesRoot(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function titleFromDisk(slug: string): Promise<string> {
  try {
    const raw = await readFile(workspacePaths(slug).stateFile, "utf8");
    const parsed = JSON.parse(raw) as { projectName?: string };
    if (parsed.projectName) return parsed.projectName;
  } catch {
    // fall through to the slug
  }
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Two books called "Draft" must not share a folder. */
async function uniqueSlug(base: string): Promise<string> {
  const existing = new Set(await readWorkspaceDirs());
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Too many projects named "${base}".`);
}

/** Resolve the workspace to operate on, defaulting to the active project. */
export async function requireActiveWorkspace(): Promise<string> {
  const slug = await activeSlug();
  if (!slug) {
    throw new Error("No active book. Create one in the Studio, or run `npm run book:new -- \"Title\"`.");
  }
  return slug;
}

export { workspacePaths, toSlug } from "./paths.js";
