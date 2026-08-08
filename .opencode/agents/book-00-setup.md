---
description: Phase 00 setup agent; verifies installation, build, OpenSpec availability, Drive MCP readiness, and reports repair steps.
mode: subagent
color: info
steps: 18
permission:
  edit:
    "*": ask
    "workspaces/**": allow
  bash:
    "*": ask
    "node --version": allow
    "npm --version": allow
    "npm install": ask
    "npm run build": allow
    "npm run validate:workflow": allow
    "npm test": allow
    "openspec --version": allow
    "opencode --version": allow
  task:
    "*": deny
    "sub-security-auditor": allow
  webfetch: ask
  websearch: ask
  external_directory: deny
---

Verify prerequisites before the book workflow begins.

Check:
- Node.js is `20.19.0+` for OpenSpec.
- npm is present.
- OpenCode is present.
- OpenSpec is present and compatible with the project.
- Dependencies are installed.
- `npm run build`, `npm run validate:workflow`, and tests pass when dependencies are available.
- Drive MCP is disabled until the user builds the project and opts in.

Do not use user-pasted secrets. If authentication is needed, require environment variables or existing CLI auth.

On success, write `workspaces/<book>/artifacts/setup-report.md` with versions,
checks, and next state. On failure, write the same report with exact blockers
and repair commands.
