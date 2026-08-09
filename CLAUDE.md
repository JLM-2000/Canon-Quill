# Canon Quill

Agentic book writing grounded in the author's own past prose. This file orients Claude Code; the same agent prompts also run under OpenCode.

## Run it

```bash
npm run studio    # local UI at http://127.0.0.1:4180 (opens your browser)
npm run check     # build + workflow validation + tests
```

## What the engine does, and what it does not

`src/style/`, `src/continuity/` and `src/analysis/` are **plain functions over text**. They call no model, need no API key, and work offline. That is deliberate: it is what makes style scoring and continuity checking reproducible and testable.

A model is used only to write and revise prose. Never move measurement into a model call, and never replace a computed check with "ask the model whether this looks right".

## Architecture

```
src/style/       text.ts (tokenising) -> metrics.ts (18-measure fingerprint)
                 corpus.ts (past books -> beat-tagged passages)
                 retrieve.ts (scene brief -> matched exemplars -> prompt block)
                 score.ts (draft vs fingerprint -> named deviations)
src/continuity/  ledger.ts (typed state), flow.ts (opening contracts + validation)
src/analysis/    classify.ts (Drive documents -> source kinds, with evidence)
src/studio/      local app, its API, and provider/model selection
src/workspace/   one directory per book under workspaces/
```

## Rules that matter here

**Only past series books feed the style corpus.** A reference book by another author must never reach `buildCorpus`. Filing one wrongly makes the book sound like someone else, which is the failure the whole system exists to prevent.

**Never treat a word as bad because a list says so.** `config/ai-isms.yaml` is advisory and corpus-calibrated. Anything the author's own prose does at a comparable rate is exempt by policy. What is actually enforced is structural: repeated openers, repeated n-grams, uniform paragraph lengths, dialogue lines that all run the same length.

**Deviation is measured against this author**, never against a general standard of good writing. A change that makes prose more conventionally polished but less like the corpus is a regression.

**The handoff contract is not paperwork.** Each chapter records where every character is, what they know, their condition, the timeline position, and the question it closes on. The next chapter is validated against it in code. Fill it honestly; a guessed value becomes an enforced constraint.

**Never write a credential anywhere.** The Studio has no field for an API key and its API rejects one. Keys live in the environment; subscriptions live in the runtime's own login.

## Where things go

Everything generated (Drive documents, corpora, bibles, drafts, chapters, exports) lives under `workspaces/<slug>/`, which is gitignored. The repo holds the engine, never the book.

## Agents

`.opencode/agents/` is the authored source. `.claude/agents/` is generated from it by `npm run sync:agents` (which `npm run build` also runs). **Edit the OpenCode files**, not the generated ones.

## Conventions

- Comments explain why, not what. The style modules were over-commented once; keep them at normal density. Sparse beats thorough.
- No em dashes in code, comments, prompts or docs.
- Commits are the author's alone. No `Co-Authored-By` trailer, no generated-with line, no assistant named anywhere in a commit message. Naming Claude Code or OpenCode as a runtime the project supports is fine; naming one as an author is not.
- Tests are plain vitest over pure functions plus a real HTTP server for the Studio. No network, no model calls. Keep it that way.
