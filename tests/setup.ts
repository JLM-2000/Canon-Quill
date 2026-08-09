// Point every test at a throwaway workspaces root.
//
// The suite deletes this root between cases. Without the override it resolved
// to ./workspaces in the repo, so running the tests destroyed real books. One
// directory per worker keeps parallel files from clearing each other's state.

import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "canon-quill-test-"));
process.env.CANON_QUILL_WORKSPACES_ROOT = path.join(root, "workspaces");
// No test may start a real writing runtime.
process.env.CANON_QUILL_RUNTIME_DRYRUN = "1";

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
