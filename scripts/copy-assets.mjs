/**
 * Copy non-TypeScript assets into dist.
 *
 * `tsc` only emits .ts files, so the Studio UI would be missing from a built
 * install. The server has a source-tree fallback for `tsx` runs, but a plain
 * `node dist/...` deployment needs the file next to the compiled server.
 */

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const assets = [["src/studio/ui.html", "dist/studio/ui.html"]];

for (const [from, to] of assets) {
  const target = path.join(root, to);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, from), target);
  console.log(`copied ${from} → ${to}`);
}
