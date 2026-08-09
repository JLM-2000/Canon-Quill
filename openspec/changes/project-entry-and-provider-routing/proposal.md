# Proposal

Canon Quill needs an explicit project-entry decision before it asks for Drive
material. Authors may have a detailed premise but no planning files, or they
may already have an outline, timeline, character sheet, or manuscript. The
Studio currently assumes the latter and makes the first useful interaction
depend on Drive.

This change adds two safe entry paths:

- `from_scratch`: capture a detailed author brief, then continue through setup
  without inventing source files or requiring Drive.
- `with_material`: accept local planning-file uploads or selected Drive
  material, preserving the existing classification and review gates.

It also makes model assignment explicit by task. Analysis and outline work can
use OpenAI while chapter prose and editing use Anthropic, with independent
subscription or API-key status per provider. No credential is placed in
project state or returned to the browser.

Chapter-by-chapter mode gains a per-chapter author conversation. Messages are
stored as planning evidence for the drafting agent and never override canon,
the approved chapter plan, or validation contracts.

The author must explicitly confirm that preparation is complete before the
writing phase becomes active. This is a user-review gate, not a model decision.

## Security and Drive impact

- Local uploads are text-only JSON payloads, capped in count and size, and are
  stored only in the active workspace cache.
- Drive remains read-only for source selection except for the existing selected
  target-folder write contract.
- Existing source files are never overwritten by upload or re-index operations.
- Provider credentials remain in runtime or `.auth/credentials.json`, with
  masked status only.

## Affected areas

- `src/studio/state.ts`: entry mode, starting brief, provider assignments,
  chapter chat, and writing confirmation state.
- `src/studio/server.ts`: entry, upload, provider, chat, and confirmation APIs.
- `src/studio/ui.html`: first screen, source paths, provider routing, chat, and
  collapsible navigation groups.
- `workflows/book-writing.workflow.yaml`: explicit project-entry and writing
  review gates.
- `.opencode/agents/book-07-chapter-drafting.md`: chapter chat contract.

## Rollback

Older state files migrate missing fields to the safe defaults: no entry choice,
single-provider routing, no writing confirmation, and an empty chapter-chat
map. Existing drafts and source caches remain untouched.
