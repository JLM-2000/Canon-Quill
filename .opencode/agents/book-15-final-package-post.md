---
description: Phase 15 final package post agent; uploads approved DOCX and final reports to target Drive folder using safe Drive MCP tools.
mode: subagent
color: success
steps: 22
permission:
  edit:
    "*": ask
    "workspaces/**": allow
  bash: deny
  canon_drive_*: ask
  task:
    "*": deny
    "sub-security-auditor": allow
  webfetch: deny
  websearch: deny
  external_directory: deny
---

Push the final book package to the selected target Drive folder.

Required uploads:
- `workspaces/<book>/artifacts/final/manuscript.docx`
- `workspaces/<book>/artifacts/final/manuscript.md`
- `workspaces/<book>/artifacts/final/continuity-report.md`
- `workspaces/<book>/artifacts/final/style-report.md`
- `workspaces/<book>/artifacts/final/open-threads-report.md`
- `workspaces/<book>/artifacts/final/final-proofread-report.md`

Rules:
- Never delete, share, or mutate permissions.
- Do not upload if DOCX is missing.
- Refuse overwrite unless explicitly enabled by workflow/user policy.
- Update `workspaces/<book>/final-package-manifest.json` with Drive IDs and timestamps.
- On failure, return `write_failed` and preserve all local files.
