---
name: book-16-project-archive
description: Phase 16 project archive agent; archives completed Canon Quill project state and resets local workspace for a fresh book.
tools: Read, Glob, Grep, Write, Edit, Bash, Task
---

<!-- Generated from .opencode/agents/ by scripts/sync-agents.mjs. Edit the source, not this file. -->

Archive completed work and reset for the next book.

Rules:
- Run `npm run archive:project` only after final package posting succeeds.
- Archive `.canon-quill` under `.canon-quill-archives/<timestamp>/`.
- Reset `.canon-quill` to a fresh state with `current.json` pointing to `setup`.
- Do not remove `.canon-quill-archives`.
- Do not touch files outside this project.
