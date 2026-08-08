import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  activeSlug,
  createProject,
  deleteProject,
  finishProject,
  listProjects,
  setActiveProject,
  touchProject
} from "../src/workspace/registry.js";
import { assertSafeSlug, toSlug, workspacePaths, workspacesRoot } from "../src/workspace/paths.js";

beforeEach(async () => {
  await rm(workspacesRoot(), { recursive: true, force: true });
});

afterEach(async () => {
  await rm(workspacesRoot(), { recursive: true, force: true });
});

describe("slugs", () => {
  it("derives a folder name from a title", () => {
    expect(toSlug("The Tide House")).toBe("the-tide-house");
    expect(toSlug("Ashfall: Book 2!")).toBe("ashfall-book-2");
  });

  it("strips accents", () => {
    expect(toSlug("Canción de Hielo")).toBe("cancion-de-hielo");
  });

  it("refuses a title with no usable characters", () => {
    expect(() => toSlug("!!!")).toThrow(/Cannot derive/);
  });

  it("rejects traversal attempts", () => {
    expect(() => assertSafeSlug("../etc")).toThrow(/Unsafe/);
    expect(() => assertSafeSlug("a/b")).toThrow(/Unsafe/);
    expect(() => assertSafeSlug("")).toThrow(/Unsafe/);
  });
});

describe("projects", () => {
  it("creates a workspace tree and makes it active", async () => {
    const project = await createProject("The Tide House");
    expect(project.slug).toBe("the-tide-house");
    expect(await activeSlug()).toBe("the-tide-house");

    const paths = workspacePaths(project.slug);
    for (const dir of [paths.logs, paths.driveCache, paths.chapters, paths.continuity, paths.final]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("keeps two books with the same title apart", async () => {
    const first = await createProject("Draft");
    const second = await createProject("Draft");
    expect(first.slug).toBe("draft");
    expect(second.slug).toBe("draft-2");
    expect((await listProjects()).length).toBe(2);
  });

  it("switches the active book", async () => {
    await createProject("Book One");
    await createProject("Book Two");
    expect(await activeSlug()).toBe("book-two");
    await setActiveProject("book-one");
    expect(await activeSlug()).toBe("book-one");
  });

  it("refuses to activate a book that does not exist", async () => {
    await expect(setActiveProject("nope")).rejects.toThrow(/No project/);
  });

  it("marks a book finished without deleting anything", async () => {
    const project = await createProject("Done Book");
    await finishProject(project.slug);
    const listed = (await listProjects()).find((entry) => entry.slug === project.slug);
    expect(listed?.status).toBe("finished");
    expect(existsSync(workspacePaths(project.slug).root)).toBe(true);
  });

  it("deletes a book and picks a new active one", async () => {
    await createProject("Keep This");
    const doomed = await createProject("Remove This");
    await deleteProject(doomed.slug);
    expect(existsSync(workspacePaths(doomed.slug).root)).toBe(false);
    expect(await activeSlug()).toBe("keep-this");
  });

  it("returns null when there are no books at all", async () => {
    expect(await activeSlug()).toBeNull();
    expect(await listProjects()).toEqual([]);
  });

  it("adopts a workspace folder that is missing from the registry", async () => {
    await createProject("Indexed");
    const orphan = path.join(workspacesRoot(), "found-on-disk");
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, "project.json"), JSON.stringify({ projectName: "Found On Disk" }));

    const projects = await listProjects();
    expect(projects.map((entry) => entry.slug).sort()).toEqual(["found-on-disk", "indexed"]);
    expect(projects.find((entry) => entry.slug === "found-on-disk")?.title).toBe("Found On Disk");
  });

  it("drops a registry entry whose folder was removed by hand", async () => {
    await createProject("Alpha");
    const gone = await createProject("Beta");
    await rm(workspacePaths(gone.slug).root, { recursive: true, force: true });

    const projects = await listProjects();
    expect(projects.map((entry) => entry.slug)).toEqual(["alpha"]);
    expect(await activeSlug()).toBe("alpha");
  });

  it("records a title change", async () => {
    const project = await createProject("Working Title");
    await touchProject(project.slug, { title: "Real Title" });
    expect((await listProjects())[0].title).toBe("Real Title");
  });
});
