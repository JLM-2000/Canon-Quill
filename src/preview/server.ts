import express from "express";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, renderMarkdown } from "./markdown.js";

interface PreviewOptions {
  file: string;
  title: string;
  port: number;
  open: boolean;
  detach: boolean;
}

const options = parseArgs(process.argv.slice(2));

if (options.detach) {
  const currentFile = fileURLToPath(import.meta.url);
  const args = [currentFile, "--file", options.file, "--title", options.title, "--port", String(options.port), "--open"];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  console.log(`Preview opening at http://localhost:${options.port}`);
  process.exit(0);
}

if (!existsSync(options.file)) {
  throw new Error(`Preview file not found: ${options.file}`);
}

const app = express();

app.get("/", async (_req, res) => {
  const markdown = await readFile(options.file, "utf8");
  res.type("html").send(renderPage(options.title, markdown));
});

app.listen(options.port, () => {
  const url = `http://localhost:${options.port}`;
  console.log(`Canon Quill preview: ${url}`);
  if (options.open) openBrowser(url);
});

function parseArgs(args: string[]): PreviewOptions {
  const get = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  return {
    file: path.resolve(get("--file", "workspaces/default/artifacts/final/manuscript.md")),
    title: get("--title", "Canon Quill Preview"),
    port: Number(get("--port", process.env.CANON_QUILL_PREVIEW_PORT ?? "4181")),
    open: args.includes("--open") || !args.includes("--no-open"),
    detach: args.includes("--detach")
  };
}

function renderPage(title: string, markdown: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #fffdf8;
      --ink: #201914;
      --muted: #7c6f64;
      --rule: #e8decf;
      --accent: #8f5838;
    }
    body {
      margin: 0;
      background: linear-gradient(135deg, #efe7da, #fbf7ef 38%, #e7dccb);
      color: var(--ink);
      font-family: Georgia, 'Times New Roman', serif;
    }
    header {
      max-width: 840px;
      margin: 0 auto;
      padding: 32px 22px 0;
      color: var(--muted);
      font-family: ui-sans-serif, system-ui, sans-serif;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 12px;
    }
    main {
      max-width: 760px;
      margin: 24px auto 64px;
      padding: 56px clamp(24px, 6vw, 72px);
      background: var(--paper);
      border: 1px solid var(--rule);
      border-radius: 18px;
      box-shadow: 0 24px 80px rgba(64, 45, 26, .18);
    }
    h1, h2, h3 {
      font-weight: 500;
      line-height: 1.1;
      text-wrap: balance;
    }
    h1 {
      margin: 0 0 32px;
      font-size: clamp(38px, 7vw, 68px);
      letter-spacing: -.04em;
    }
    h2 {
      margin-top: 44px;
      padding-top: 28px;
      border-top: 1px solid var(--rule);
      color: var(--accent);
      font-size: clamp(28px, 4vw, 42px);
    }
    h3 { margin-top: 32px; font-size: 24px; }
    p {
      font-size: clamp(18px, 2.2vw, 21px);
      line-height: 1.78;
      margin: 0 0 1.15em;
    }
    blockquote {
      margin: 28px 0;
      padding-left: 24px;
      border-left: 3px solid var(--accent);
      color: #4c3d33;
      font-style: italic;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f3ebdf;
      padding: .12em .32em;
      border-radius: 6px;
    }
    .meta {
      max-width: 760px;
      margin: 0 auto;
      color: var(--muted);
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
      padding: 0 22px 24px;
    }
    @media (max-width: 720px) {
      main { margin: 16px 12px 40px; padding: 32px 22px; border-radius: 14px; }
      header { padding-top: 22px; }
    }
  </style>
</head>
<body>
  <header>Canon Quill Review</header>
  <main>${renderMarkdown(markdown)}</main>
  <div class="meta">Preview source: ${escapeHtml(path.relative(process.cwd(), options.file))}</div>
</body>
</html>`;
}

function openBrowser(url: string): void {
  const commands = browserCommands(url);
  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.unref();
      return;
    } catch {
      continue;
    }
  }
}

function browserCommands(url: string): Array<[string, string[]]> {
  if (process.platform === "win32") return [["cmd", ["/c", "start", "", url]]];
  if (process.platform === "darwin") return [["open", [url]]];
  if (process.env.WSL_DISTRO_NAME) {
    return [
      ["powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url}'`]],
      ["wslview", [url]],
      ["xdg-open", [url]]
    ];
  }
  return [["xdg-open", [url]]];
}
