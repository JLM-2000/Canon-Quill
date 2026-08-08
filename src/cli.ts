import { loadWorkflow } from "./workflow/load.js";
import { validateWorkflow } from "./workflow/validate.js";
import { generateDocx } from "./project/docx.js";
import { logError } from "./project/logs.js";
import {
  activeSlug,
  createProject,
  deleteProject,
  finishProject,
  listProjects,
  setActiveProject
} from "./workspace/registry.js";

const usage = `Canon Quill

  npm run studio                    open the Studio UI
  npm run book:new -- "Title"       create a book workspace
  npm run book:list                 list books
  npm run book:use -- <slug>        switch the active book
  npm run book:finish -- <slug>     mark a book finished
  npm run book:delete -- <slug>     delete a book and its contents
  npm run docx                      build the DOCX for the active book
  npm run validate:workflow         validate the workflow definition
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "help":
      console.log(usage);
      return;

    case "new": {
      const title = args.join(" ").trim();
      if (!title) throw new Error('A title is required: npm run book:new -- "The Tide House"');
      const project = await createProject(title);
      console.log(`Created "${project.title}" at workspaces/${project.slug}`);
      return;
    }

    case "list": {
      const projects = await listProjects();
      const active = await activeSlug();
      if (projects.length === 0) {
        console.log('No books yet. Create one with: npm run book:new -- "Title"');
        return;
      }
      for (const project of projects) {
        const marker = project.slug === active ? "*" : " ";
        console.log(`${marker} ${project.slug.padEnd(28)} ${project.status.padEnd(9)} ${project.title}`);
      }
      return;
    }

    case "use": {
      const project = await setActiveProject(requireArg(args[0], "a book slug"));
      console.log(`Active book: ${project.title}`);
      return;
    }

    case "finish": {
      const slug = args[0] ?? (await activeSlug());
      await finishProject(requireArg(slug, "a book slug"));
      console.log(`Marked ${slug} as finished. Nothing was deleted.`);
      return;
    }

    case "delete": {
      const slug = requireArg(args[0], "a book slug");
      await deleteProject(slug);
      console.log(`Deleted workspaces/${slug}`);
      return;
    }

    case "docx": {
      const slug = args[0] ?? (await activeSlug());
      const result = await generateDocx(requireArg(slug, "a book slug"));
      console.log(`Generated ${result.outputPath}`);
      return;
    }

    case "validate": {
      const workflow = await loadWorkflow(args[0] ?? "workflows/book-writing.workflow.yaml");
      const result = validateWorkflow(workflow);
      if (!result.ok) {
        for (const issue of result.issues) console.error(`- ${issue}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Workflow valid: ${workflow.name}`);
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
}

function requireArg(value: string | null | undefined, what: string): string {
  if (!value) throw new Error(`Expected ${what}.`);
  return value;
}

main().catch(async (error: unknown) => {
  const slug = await activeSlug().catch(() => null);
  if (slug) {
    await logError(slug, error, { stage: "cli", stageName: "CLI", agent: "system", event: "command_failed" }).catch(
      () => undefined
    );
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
