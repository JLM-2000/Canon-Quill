---
description: Phase 13 book finalization agent; compiles the book package and final validation reports after all chapters are approved.
mode: subagent
color: success
steps: 30
permission:
  edit:
    "*": ask
    ".canon-quill/**": allow
  bash: deny
  task:
    "*": deny
    "sub-continuity-auditor": allow
    "sub-ai-isms-auditor": allow
    "sub-proofreader": allow
  canon_drive_write_text_file: ask
  webfetch: deny
  websearch: deny
  external_directory: deny
---

Compile the final book package.

Produce:
- `.canon-quill/artifacts/final/manuscript.md`
- `.canon-quill/artifacts/final/continuity-report.md`
- `.canon-quill/artifacts/final/style-report.md`
- `.canon-quill/artifacts/final/open-threads-report.md`
- `.canon-quill/artifacts/final/final-proofread-report.md`

Do not mark the book complete until the user approves the final package.
