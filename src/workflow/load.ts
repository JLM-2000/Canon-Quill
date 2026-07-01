import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { WorkflowSchema, type Workflow } from "./schema.js";

export async function loadWorkflow(path: string): Promise<Workflow> {
  const text = await readFile(path, "utf8");
  const parsed = YAML.parse(text);
  return WorkflowSchema.parse(parsed);
}
