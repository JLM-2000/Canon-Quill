# Canon Quill

Canon Quill is a guided OpenCode workflow for writing books from Google Drive references. It helps an author prepare the book, write it in the selected style, validate every chapter, generate the final DOCX, upload the final package, archive the finished project, and reset for the next book.

The workflow is conversation-first. You do not need to memorize commands. After setup, open OpenCode, switch to the `book-orchestrator` agent, and talk normally.

## Quick Start

1. Clone the repo.

```bash
git clone <repo-url> Canon-Quill
```

2. Enter the folder.

```bash
cd Canon-Quill
```

3. Run the installer.

```bash
npm run setup
```

The installer checks Node, installs OpenCode if missing, installs OpenSpec if missing, installs project dependencies, builds the project, validates the workflow, and initializes the local book workspace.

4. Open OpenCode from this folder.

```bash
opencode
```

5. Press `Tab` until the active agent is `book-orchestrator`.

6. Say something natural, for example:

```text
Begin.
```

or:

```text
I want to start a new book. Use these Drive folders as references and this Drive folder as the target.
```

## Requirements

Canon Quill expects Node.js `20.19.0+`.

If setup says your Node version is too old, upgrade Node, then run the installer again:

```bash
npm run setup
```

Recommended with `nvm`:

```bash
nvm install 20
nvm use 20
```

## What The Installer Does

`npm run setup` runs `scripts/install.sh`.

It performs these steps:

- Confirms Node.js is new enough.
- Installs OpenCode if the `opencode` command is missing.
- Installs OpenSpec if the `openspec` command is missing.
- Installs this project’s npm dependencies.
- Builds the local TypeScript tools.
- Validates the book workflow YAML.
- Creates `.canon-quill/` local state, logs, and artifact folders.

If any step fails, the installer prints the blocker and stops before the writing workflow begins.

## Starting The Workflow

After setup, open OpenCode and select `book-orchestrator` with `Tab`.

Then speak normally. Good starting phrases:

```text
Begin.
```

```text
Start a new book project.
```

```text
Here are the reference folders and the target folder. Start preparation.
```

The orchestrator reads the workflow state and routes you to the correct phase.

## Natural Conversation Examples

Continue work:

```text
Continue.
```

```text
Continue with the next chapter.
```

Choose chapter-by-chapter review:

```text
Let's do this chapter by chapter.
```

Choose full-book mode:

```text
Do the whole book yourself and only ask me when the full manuscript is ready.
```

Approve a chapter:

```text
The chapter is good.
```

Request changes:

```text
Make the dialogue sharper and less explanatory.
```

Approve the final book:

```text
The book is good. Generate the DOCX, upload it, and archive the project.
```

## Review Modes

Canon Quill asks all setup questions before writing begins. Once writing starts, it does not interrupt you in the middle of the drafting loop.

`chapter_by_chapter` mode:

- Draft one chapter.
- Edit it.
- Validate it.
- Ask you to approve that chapter.
- Upload the approved chapter.
- Continue to the next chapter.

`book_by_book` mode:

- Draft every chapter.
- Edit every chapter.
- Validate every chapter.
- Update continuity internally.
- Ask you for review only when the whole manuscript package is ready.

## Google Drive Setup

Canon Quill can read selected references and write approved outputs to a selected target folder in Google Drive.

You need a Google OAuth Desktop credentials JSON file.

High-level setup:

1. Create or choose a Google Cloud project.
2. Enable the Google Drive API.
3. Create an OAuth Client ID with application type `Desktop app`.
4. Download the credentials JSON.
5. Run the installer. It creates a local `.env` file for you.

```bash
npm run setup
```

6. Open `.env` and fill in this value:

```text
GOOGLE_OAUTH_CLIENT_JSON=/absolute/path/to/credentials.json
```

The default Drive scope is:

```text
https://www.googleapis.com/auth/drive.file
```

This keeps Drive access narrow and user-selected.

## Enable Drive Tools

The Drive MCP server is disabled by default so a fresh clone never tries to start Drive tooling before setup.

After `npm run setup`, open `opencode.json` and change the `canon_drive` MCP server from:

```json
"enabled": false
```

to:

```json
"enabled": true
```

Then restart OpenCode.

## Workflow Phases

The workflow lives at:

```text
workflows/book-writing.workflow.yaml
```

The main phases are:

1. `setup`: check local readiness.
2. `intake`: ask all project questions before writing.
3. `drive_selection`: choose references and target.
4. `reference_extraction`: extract source facts and style.
5. `preparation`: create bibles, plans, style guides, and validation rubrics.
6. `preflight_review`: user approves the starting point.
7. `corrections`: update prep docs if needed.
8. `chapter_drafting`: draft chapters.
9. `chapter_editing`: revise phrase by phrase.
10. `chapter_validation`: validate canon, style, plot, boundaries, and proofread quality.
11. `user_chapter_review`: chapter approval gate only in chapter-by-chapter mode.
12. `final_post`: upload approved chapter.
13. `continuity_update`: update canon and next-chapter context.
14. `book_finalization`: compile full manuscript and reports.
15. `book_final_review`: user reviews the complete book.
16. `docx_generation`: generate the final DOCX.
17. `final_package_post`: upload DOCX and final reports.
18. `project_archive`: archive completed work and reset for a fresh book.

## Agents

Canon Quill uses one phase agent per phase:

```text
.opencode/agents/book-00-setup.md
.opencode/agents/book-01-intake.md
.opencode/agents/book-02-drive-selection.md
.opencode/agents/book-03-reference-extraction.md
.opencode/agents/book-04-preparation.md
.opencode/agents/book-05-preflight-review.md
.opencode/agents/book-06-corrections.md
.opencode/agents/book-07-chapter-drafting.md
.opencode/agents/book-08-chapter-editing.md
.opencode/agents/book-09-chapter-validation.md
.opencode/agents/book-10-user-review.md
.opencode/agents/book-11-final-post.md
.opencode/agents/book-12-continuity-update.md
.opencode/agents/book-13-book-finalization.md
.opencode/agents/book-14-docx-generation.md
.opencode/agents/book-15-final-package-post.md
.opencode/agents/book-16-project-archive.md
```

There are also focused subagents for Drive indexing, reference parsing, style analysis, character canon, plot, dialogue, AI-isms, continuity, spice boundaries, proofreading, security, and workflow YAML audits.

## Logs And State

Canon Quill records structured JSON state and logs under `.canon-quill/`.

Current state:

```text
.canon-quill/state/current.json
.canon-quill/state/current-phase.json
```

Logs:

```text
.canon-quill/logs/phase-log.json
.canon-quill/logs/errors-log.json
.canon-quill/logs/audit-log.json
```

Each log entry includes timestamps, stage IDs, stage names, agent names, events, messages, and optional data.

Book artifacts:

```text
.canon-quill/artifacts/
.canon-quill/artifacts/chapters/
.canon-quill/artifacts/continuity/
.canon-quill/artifacts/final/
```

Finished projects are archived under:

```text
.canon-quill-archives/<timestamp>/
```

The active `.canon-quill/` folder is reset after archive so the next book starts fresh.

## Pretty Review Preview

When Canon Quill shows a chapter or full book for review, it can open a local browser preview automatically.

The review agent uses:

```bash
npm run preview -- --detach --file <markdown-file> --title "Chapter Title"
```

The preview opens on localhost and formats the manuscript in a clean book-style reading view. If the referenced style implies a specific format, the review agent should match that format as closely as the available style notes allow. If the browser cannot open automatically, OpenCode still shows the local preview URL and file path.

## Final Book Output

When the full book is approved, Canon Quill generates:

```text
.canon-quill/artifacts/final/manuscript.docx
```

It also keeps:

```text
.canon-quill/artifacts/final/manuscript.md
.canon-quill/artifacts/final/continuity-report.md
.canon-quill/artifacts/final/style-report.md
.canon-quill/artifacts/final/open-threads-report.md
.canon-quill/artifacts/final/final-proofread-report.md
```

Manual DOCX generation is available if needed:

```bash
npm run docx
```

Manual archive/reset is available if needed:

```bash
npm run archive:project
```

## Writing Quality

Canon Quill is built to avoid generic AI writing.

It checks for:

- User/reference style fidelity.
- Character voice and physicality consistency.
- Plot causality and open loops.
- POV, tense, and narrative distance.
- Dialogue subtext and voice separation.
- Overexplaining.
- Empty poetic phrasing.
- Repeated AI-isms.
- Target audience fit.
- Romance/spice boundary compliance.
- Final proofread issues.

The writing rubric is here:

```text
docs/writing-rubric.md
```

The AI-isms list is here:

```text
config/ai-isms.yaml
```

## Local Validation

Run all project checks:

```bash
npm run check
```

Run individual checks:

```bash
npm run build
npm run validate:workflow
npm test
```

## Troubleshooting

### OpenCode does not show `book-orchestrator`

Restart OpenCode from the `Canon-Quill` folder. OpenCode reads agent files at startup.

### Setup says Node is too old

Install Node.js `20.19.0+`, then rerun:

```bash
npm run setup
```

### Drive tools are not available

Make sure `canon_drive.enabled` is `true` in `opencode.json`, then restart OpenCode.

### Drive OAuth does not open

Check that `GOOGLE_OAUTH_CLIENT_JSON` points to your OAuth Desktop credentials JSON.

### Target file already exists

Canon Quill refuses overwrites by default. Rename the target output or enable overwrite intentionally:

```bash
export CANON_QUILL_ALLOW_OVERWRITE=true
```
