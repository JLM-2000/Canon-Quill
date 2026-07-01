import { loadWorkflow } from "./workflow/load.js";
import { validateWorkflow } from "./workflow/validate.js";
import { archiveProject } from "./project/archive.js";
import { generateDocx } from "./project/docx.js";
import { initializeProject } from "./project/init.js";
import { logError } from "./project/logs.js";

async function main() {
  const [command, path = "workflows/book-writing.workflow.yaml"] = process.argv.slice(2);

  if (!command || command === "help") {
    console.log("Usage: canon-quill <validate|init|docx|archive> [workflow.yaml]");
    return;
  }

  if (command === "init") {
    const result = await initializeProject();
    console.log(`Initialized Canon Quill state at ${result.statePath}`);
    return;
  }

  if (command === "docx") {
    const result = await generateDocx();
    console.log(`Generated DOCX: ${result.outputPath}`);
    return;
  }

  if (command === "archive") {
    const result = await archiveProject();
    console.log(`Archived project: ${result.archivePath}`);
    console.log(`Reset state: ${result.resetStatePath}`);
    return;
  }

  if (command === "validate") {
    const workflow = await loadWorkflow(path);
    const result = validateWorkflow(workflow);

    if (!result.ok) {
      for (const issue of result.issues) console.error(`- ${issue}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Workflow valid: ${workflow.name}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(async (error) => {
  await logError(error, { stage: "cli", stageName: "CLI", agent: "system", event: "command_failed" }).catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
