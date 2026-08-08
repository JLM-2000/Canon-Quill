import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadWorkflow } from "../src/workflow/load.js";
import { validateWorkflow } from "../src/workflow/validate.js";
import { extractDriveId } from "../src/drive/id.js";
import { generateDocx } from "../src/project/docx.js";
import { createProject } from "../src/workspace/registry.js";
import { workspacePaths, workspacesRoot } from "../src/workspace/paths.js";

afterEach(async () => {
  await rm(workspacesRoot(), { recursive: true, force: true });
});

describe("workflow", () => {
  it("validates the book workflow", async () => {
    const workflow = await loadWorkflow("workflows/book-writing.workflow.yaml");
    const result = validateWorkflow(workflow);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("docx generation", () => {
  it("builds a DOCX from the workspace manuscript", async () => {
    const project = await createProject("Docx Book");
    const paths = workspacePaths(project.slug);
    await mkdir(paths.final, { recursive: true });
    await writeFile(path.join(paths.final, "manuscript.md"), "# Test Book\n\n## Chapter 1\n\nHello *world*.");

    const result = await generateDocx(project.slug);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  it("fails clearly when there is no manuscript", async () => {
    const project = await createProject("Empty Book");
    await expect(generateDocx(project.slug)).rejects.toThrow(/manuscript not found/i);
  });
});

describe("drive id extraction", () => {
  it("extracts folder ids", () => {
    expect(extractDriveId("https://drive.google.com/drive/folders/abc_DEF-123")).toBe("abc_DEF-123");
  });

  it("extracts file ids", () => {
    expect(extractDriveId("https://drive.google.com/file/d/abc_DEF-123/view")).toBe("abc_DEF-123");
  });
});
