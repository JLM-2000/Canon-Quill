import path from "node:path";

export const projectPaths = {
  root: process.cwd(),
  workspace: path.join(process.cwd(), ".canon-quill"),
  archives: path.join(process.cwd(), ".canon-quill-archives"),
  state: path.join(process.cwd(), ".canon-quill", "state"),
  logs: path.join(process.cwd(), ".canon-quill", "logs"),
  artifacts: path.join(process.cwd(), ".canon-quill", "artifacts"),
  chapters: path.join(process.cwd(), ".canon-quill", "artifacts", "chapters"),
  continuity: path.join(process.cwd(), ".canon-quill", "artifacts", "continuity"),
  final: path.join(process.cwd(), ".canon-quill", "artifacts", "final"),
  targetStaging: path.join(process.cwd(), ".canon-quill", "target-staging")
};
