import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const app = express();
const port = Number(process.env.CANON_QUILL_WIZARD_PORT ?? 4177);

app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Canon Quill Drive Selection</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 860px; line-height: 1.45; }
    textarea, input { width: 100%; box-sizing: border-box; margin: .35rem 0 1rem; padding: .7rem; }
    button { padding: .7rem 1rem; cursor: pointer; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1rem; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Canon Quill Drive Selection</h1>
  <p>This fallback wizard records selected Drive URLs or IDs. Google Picker integration can be added by supplying browser API credentials; the workflow can also use these URLs directly through the Drive MCP.</p>
  <div class="card">
    <label>Reference Drive URLs or IDs, one per line</label>
    <textarea id="references" rows="8"></textarea>
    <label>Target Drive folder URL or ID</label>
    <input id="target" />
    <button id="save">Save Selection</button>
  </div>
  <pre id="output"></pre>
  <script>
    document.getElementById('save').onclick = async () => {
      const references = document.getElementById('references').value.split('\n').map(x => x.trim()).filter(Boolean);
      const target = document.getElementById('target').value.trim();
      const response = await fetch('/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ references, target }) });
      document.getElementById('output').textContent = await response.text();
    };
  </script>
</body>
</html>`);
});

app.post("/selection", async (req, res) => {
  const outputDir = path.join(process.cwd(), ".canon-quill", "state");
  await mkdir(outputDir, { recursive: true });
  const payload = {
    references: Array.isArray(req.body.references) ? req.body.references : [],
    target: typeof req.body.target === "string" ? req.body.target : "",
    savedAt: new Date().toISOString()
  };
  await writeFile(path.join(outputDir, "drive-selection.raw.json"), JSON.stringify(payload, null, 2));
  res.json({ ok: true, path: ".canon-quill/state/drive-selection.raw.json", payload });
});

app.listen(port, () => {
  console.log(`Canon Quill wizard listening on http://localhost:${port}`);
});
