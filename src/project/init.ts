import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLog, initializeLogs, writeCurrentPhase } from "./logs.js";
import { projectPaths } from "./paths.js";

export interface InitializeProjectResult {
  statePath: string;
}

export async function initializeProject(): Promise<InitializeProjectResult> {
  await Promise.all([
    mkdir(projectPaths.state, { recursive: true }),
    mkdir(projectPaths.logs, { recursive: true }),
    mkdir(projectPaths.chapters, { recursive: true }),
    mkdir(projectPaths.continuity, { recursive: true }),
    mkdir(projectPaths.final, { recursive: true }),
    mkdir(projectPaths.targetStaging, { recursive: true })
  ]);

  await initializeLogs();

  const statePath = path.join(projectPaths.state, "current.json");
  await writeFile(
    statePath,
    JSON.stringify(
      {
        workflow: "canon-quill-book-writing",
        state: "setup",
        stageName: "Setup",
        agent: "book-00-setup",
        mode: "unselected",
        initializedAt: new Date().toISOString(),
        approvals: {},
        currentChapter: null
      },
      null,
      2
    )
  );

  await writeFile(path.join(projectPaths.artifacts, "README.md"), artifactReadme(), { flag: "wx" }).catch((error: unknown) => {
    if (isAlreadyExists(error)) return;
    throw error;
  });

  const timestamp = new Date().toISOString();
  await writeCurrentPhase({
    timestamp,
    stage: "setup",
    stageName: "Setup",
    agent: "book-00-setup",
    event: "initialized",
    mode: "unselected",
    message: "Canon Quill project workspace initialized."
  });
  await appendLog("phase", {
    timestamp,
    stage: "setup",
    stageName: "Setup",
    agent: "book-00-setup",
    event: "initialized",
    message: "Canon Quill project workspace initialized."
  });
  await appendLog("audit", {
    timestamp,
    stage: "setup",
    stageName: "Setup",
    agent: "book-00-setup",
    event: "workspace_initialized",
    data: {
      statePath,
      logs: ["phase-log.json", "errors-log.json", "audit-log.json", "current-phase.json"]
    }
  });

  return { statePath };
}

function artifactReadme(): string {
  return `# Canon Quill Artifacts\n\nGenerated preparation docs, chapters, validation reports, final package files, and continuity state live here.\n`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
