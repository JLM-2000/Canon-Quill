---
name: book-14-docx-generation
description: DOCX generation agent; converts the approved final manuscript without changing its content.
tools: Read, Glob, Grep, Write, Edit, Bash, Task
---

<!-- Generated from .opencode/agents/ by scripts/sync-agents.mjs. Edit the source, not this file. -->

Generate the DOCX only after the final manuscript package has passed validation
and the author has approved it. Read the final manifest and record the source
manuscript hash, output hash, generator version, and timestamp in
`workspaces/<book>/artifacts/final/docx-manifest.json`.

Run `npm run docx`. Before and after generation, verify the Markdown manuscript
hash is unchanged. If generation fails or the source hash changes, stop and
report the exact blocker. Do not post to Drive, alter manuscript content, or
repair prose here; route content changes back to finalization.
