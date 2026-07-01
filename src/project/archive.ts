import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { initializeProject } from "./init.js";
import { appendLog } from "./logs.js";
import { projectPaths } from "./paths.js";

export interface ArchiveProjectResult {
  archivePath: string;
  resetStatePath: string;
}

export async function archiveProject(): Promise<ArchiveProjectResult> {
  if (!existsSync(projectPaths.workspace)) {
    throw new Error("No .canon-quill workspace exists to archive. Run npm run init:project first.");
  }

  await mkdir(projectPaths.archives, { recursive: true });
  const archivePath = path.join(projectPaths.archives, timestamp());
  await cp(projectPaths.workspace, archivePath, { recursive: true, force: false, errorOnExist: true });
  await writeFile(
    path.join(archivePath, "archive-manifest.json"),
    JSON.stringify({ archivedAt: new Date().toISOString(), source: ".canon-quill" }, null, 2)
  );

  await appendLog("audit", {
    timestamp: new Date().toISOString(),
    stage: "project_archive",
    stageName: "Project Archive",
    agent: "book-16-project-archive",
    event: "project_archived",
    data: { archivePath }
  });

  await rm(projectPaths.workspace, { recursive: true, force: true });
  const reset = await initializeProject();

  return { archivePath, resetStatePath: reset.statePath };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
