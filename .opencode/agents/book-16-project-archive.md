---
description: Phase 16 project archive agent; archives completed Canon Quill project state and resets local workspace for a fresh book.
mode: subagent
color: success
steps: 18
permission:
  edit:
    "*": ask
    "workspaces/**": allow
    ".canon-quill-archives/**": allow
  bash:
    "*": ask
    "npm run archive:project": allow
  task:
    "*": deny
    "sub-security-auditor": allow
  webfetch: deny
  websearch: deny
  external_directory: deny
---

Archive completed work and reset for the next book.

Rules:
- Run `npm run archive:project` only after final package posting succeeds.
- Archive `.canon-quill` under `.canon-quill-archives/<timestamp>/`.
- Reset `.canon-quill` to a fresh state with `current.json` pointing to `setup`.
- Do not remove `.canon-quill-archives`.
- Do not touch files outside this project.
