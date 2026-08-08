import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before any test file so the workspaces root is redirected away from
    // the repo before a single rm() can touch it.
    setupFiles: ["tests/setup.ts"]
  }
});
