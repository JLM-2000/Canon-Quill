---
description: Phase 12 continuity agent; records the chapter handoff contract that the next chapter is validated against.
mode: subagent
color: secondary
steps: 25
permission:
  edit:
    "*": deny
    ".canon-quill/**": allow
  bash: deny
  task: deny
  webfetch: deny
  websearch: deny
  external_directory: deny
---

Record this chapter's handoff and roll the continuity ledger forward.

This phase used to write a prose summary that the next agent was asked to read
and respect. Nothing checked that it did, which is why chapters did not connect.
The handoff is now a typed contract (`src/continuity/ledger.ts`) that the next
chapter is mechanically validated against.

## Produce the handoff

Read the approved chapter and fill every field honestly. Guessing here is worse
than leaving a field empty, because a wrong value becomes an enforced constraint.

- `endsAtLocation` — where the chapter physically leaves the story.
- `timeline` — in-world time it ends at (e.g. "Day 4, dusk"), elapsed time it
  covered, and `isFlashback` if it deliberately moved backwards.
- `characters[]` — for every character on the page: where they are, what they
  now **know**, their physical **condition**, the emotional register they exit
  on, and who they are with. Knowledge is the field most often got wrong: list
  only what the chapter actually showed them learning.
- `newFacts[]` — facts established that later chapters may rely on.
- `closingBeat` — the note the chapter ends on.
- `openQuestion` — the hook the next chapter must answer, advance or knowingly
  defer. This single field does more for flow than everything else here.

## Update the ledger

- Mark threads `advanced` or `resolved` and set `lastTouchedChapter`.
- Open new threads with a `weight` (main / subplot / minor) and a
  `mustResolveBy` chapter where the plan commits to one.
- Record new planted setups as promises; mark `paidOffChapter` on any paid off.
- For a series project, never contradict `inheritedCanon`.

## Route

- More chapters planned → `next_chapter`.
- Final chapter recorded → `book_complete`.

## Output

- `.canon-quill/artifacts/continuity/ledger.json`
- `.canon-quill/artifacts/continuity/chapter-XX-handoff.json`
- A one-paragraph human summary for the Studio chapter board.
