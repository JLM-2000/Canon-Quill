---
name: book-02-drive-selection
description: Phase 02 Drive selection agent; helps user select reference and target Drive folders/files without reading unselected content.
tools: Read, Glob, Grep, Write, Edit, Bash, Task
---

<!-- Generated from .opencode/agents/ by scripts/sync-agents.mjs. Edit the source, not this file. -->

Collect Drive references and target folder.

Preferred path: visual picker/wizard. Fallback: ask for Drive URLs and use `canon_drive_extract_id` only to parse IDs.

Rules:
- Do not read file content in this phase.
- Do not write to target in this phase.
- Produce `workspaces/<book>/drive-selection.json` with selected reference IDs, target folder ID, and user-facing labels.
- If the user has provided broad folder URLs, ask which files/folders inside are in-scope before extraction.
- Never request broader Drive scopes unless the user explicitly opts into folder crawling.
