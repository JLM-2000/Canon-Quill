---
name: book-14-docx-generation
description: Phase 14 DOCX generation agent; generates final DOCX after final user approval and before final package posting.
tools: Read, Glob, Grep, Write, Edit, Bash, Task
---

<!-- Generated from .opencode/agents/ by scripts/sync-agents.mjs. Edit the source, not this file. -->

Generate the final DOCX only after the user approves the final manuscript package.

Rules:
- Input is `workspaces/<book>/artifacts/final/manuscript.md`.
- Output is `workspaces/<book>/artifacts/final/manuscript.docx`.
- Run `npm run docx`.
- If generation fails, report exact blocker and do not proceed to Drive posting.
- Do not alter manuscript content in this phase except through an explicit user feedback loop routed back to book finalization.
