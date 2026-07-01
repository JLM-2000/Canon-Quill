import { describe, expect, it } from "vitest";
import { loadWorkflow } from "../src/workflow/load.js";
import { validateWorkflow } from "../src/workflow/validate.js";
import { extractDriveId } from "../src/drive/id.js";
import { generateDocx } from "../src/project/docx.js";
import { initializeProject } from "../src/project/init.js";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

describe("workflow", () => {
  it("validates the book workflow", async () => {
    const workflow = await loadWorkflow("workflows/book-writing.workflow.yaml");
    const result = validateWorkflow(workflow);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("project lifecycle", () => {
  it("initializes state and generates docx", async () => {
    await initializeProject();
    expect(existsSync(".canon-quill/state/current-phase.json")).toBe(true);
    expect(existsSync(".canon-quill/logs/phase-log.json")).toBe(true);
    expect(existsSync(".canon-quill/logs/errors-log.json")).toBe(true);
    expect(existsSync(".canon-quill/logs/audit-log.json")).toBe(true);
    await mkdir(".canon-quill/artifacts/final", { recursive: true });
    await writeFile(".canon-quill/artifacts/final/manuscript.md", "# Test Book\n\n## Chapter 1\n\nHello *world*.");
    const result = await generateDocx();
    expect(existsSync(result.outputPath)).toBe(true);
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
