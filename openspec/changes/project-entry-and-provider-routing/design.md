# Design

## State

`StudioState` gains:

- `projectStart`: `from_scratch` or `with_material`, nullable for legacy and
  newly created projects before the first screen.
- `startingBrief`: bounded author text for the scratch path.
- `engine.routing`: `single` or `split`.
- `engine.analysisProvider` and `engine.analysisAuthMethod`.
- `engine.draftingProvider` and `engine.draftingAuthMethod`.
- `chapterChats`: messages keyed by chapter number.
- `writingConfirmed`: explicit preparation gate.

The old `engine.provider`, `authMethod`, and `models` fields remain as aliases
for persisted projects and existing agents. Missing new fields are migrated
without changing source, manuscript, or artifact data.

## Phase behavior

The derived phase starts at `start`. The workflow's `project_start` state is the
source-branch contract; the Studio inserts its credential gate before the
branch continues. A scratch project uses the sequence
`start -> engine -> intake -> draft -> intake_analysis -> questions`, while a
material project retains Drive, source grouping, and optional style-corpus
steps. A style corpus is still mandatory when the author has selected a past
book as their own writing source; planning-only projects may continue without
one.

The questions phase remains active after its last answer until
`POST /api/writing/confirm` succeeds. That endpoint checks blocking questions,
analysis completion, and the existing-draft decision before setting
`writingConfirmed`.

## Source input

`POST /api/sources/upload` accepts bounded text-file payloads. Each file gets a
local workspace identifier and is classified with the same deterministic
classifier used by Drive indexing. Local files default to `notes` when the
classifier cannot make a stronger planning classification. Drive source
selection remains unchanged and still controls target-folder writes.

## Provider routing

Single routing synchronizes the legacy provider and both task assignments.
Split routing resolves `analysis`, `orchestration`, and `validation` through
the analysis assignment and `drafting` and `editing` through the drafting
assignment. Credential checks are performed independently with the existing
runtime and environment lookup functions.

## Chapter chat

`GET` and `POST /api/chapters/:number/chat` store author messages in local
project state. The drafting agent reads this endpoint in addition to canon,
the opening contract, style exemplars, and pending directions. Chat text is
instructional evidence, not an authority to contradict approved canon.

## Navigation

The sidebar derives its visible order from the entry mode and renders each
phase group as a collapsible control. Confirming the writing gate collapses
Setup and Prepare. The author can reopen either group at any time.

## Validation

Pure state and source checks remain deterministic. Tests cover entry routing,
local upload, split provider resolution, question persistence, writing-gate
failure and success, chapter chat, provider credential isolation, and the
existing Drive overwrite protections.
