/**
 * Generate Claude Code subagents from the OpenCode agent definitions.
 *
 * The prompt bodies are the valuable part and are identical across both tools.
 * Only the frontmatter differs, so `.opencode/agents/` stays the authored
 * source and `.claude/agents/` is generated. Edit the OpenCode files and run
 * `npm run sync:agents`.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, ".opencode", "agents");
const target = path.join(root, ".claude", "agents");

/** Read-only baseline every agent gets. */
const baseTools = ["Read", "Glob", "Grep"];

function splitFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: match[2] };
}

/** Pull a top-level scalar out of the OpenCode frontmatter. */
function scalar(frontmatter, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * A permission is "denied" only when the whole capability is off. OpenCode
 * writes either `bash: deny` or a `bash:` block with per-command rules; the
 * block form means the agent can run something, so the tool must be granted.
 */
function isDenied(frontmatter, key) {
  const flat = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, "m").exec(frontmatter);
  if (flat) return flat[1] === "deny";

  const block = new RegExp(`^\\s*${key}:\\s*\\n((?:\\s+.*\\n?)*)`, "m").exec(frontmatter);
  if (!block) return true;
  // A block that denies "*" with no allow entries is still a full denial.
  const lines = block[1].split("\n").filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /:\s*deny\s*$/.test(line));
}

function toolsFor(frontmatter) {
  const tools = [...baseTools];
  if (!isDenied(frontmatter, "edit")) tools.push("Write", "Edit");
  if (!isDenied(frontmatter, "bash")) tools.push("Bash");
  if (!isDenied(frontmatter, "task")) tools.push("Task");
  if (!isDenied(frontmatter, "webfetch")) tools.push("WebFetch");
  if (!isDenied(frontmatter, "websearch")) tools.push("WebSearch");
  return tools;
}

/** Quote for YAML only when the value needs it. */
function yamlString(value) {
  return /[:#]/.test(value) ? JSON.stringify(value) : value;
}

const files = (await readdir(source)).filter((name) => name.endsWith(".md")).sort();
await mkdir(target, { recursive: true });
const current = new Set(files);
await Promise.all(
  (await readdir(target))
    .filter((name) => name.endsWith(".md") && !current.has(name))
    .map((name) => unlink(path.join(target, name)))
);

const written = [];
for (const file of files) {
  const raw = await readFile(path.join(source, file), "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = file.replace(/\.md$/, "");
  const description = scalar(frontmatter, "description") ?? name;
  const tools = toolsFor(frontmatter);

  const output = [
    "---",
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    `tools: ${tools.join(", ")}`,
    "---",
    "",
    "<!-- Generated from .opencode/agents/ by scripts/sync-agents.mjs. Edit the source, not this file. -->",
    "",
    body.trim(),
    ""
  ].join("\n");

  await writeFile(path.join(target, file), output, "utf8");
  written.push(`${name} [${tools.length} tools]`);
}

console.log(`Synced ${written.length} agents to .claude/agents/`);
