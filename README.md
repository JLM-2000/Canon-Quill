# Canon Quill

An agentic book-writing workflow that grounds drafting in **the author's own past prose**, then gates every chapter on canon, continuity and measured style fidelity.

The hard part of getting an LLM to write a novel is not producing text. It is producing text that sounds like *you* wrote it, and that chapter 12 still agrees with chapter 3. Canon Quill treats both as engineering problems with measurements attached, rather than as instructions in a prompt.

```bash
npm run setup && npm run studio
```

---

## The two problems this exists to solve

### "It has no soul"

The usual approach hands the model a *description* of the author's style — "short sentences, dry humour, close third person" — and asks it to imitate that. A description of prose is not prose. Given one, the model falls back on its own default register, and the result is fluent, competent and completely anonymous.

Canon Quill keeps the actual paragraphs. Past books are cut into passages, each tagged by the kind of narrative beat it carries (dialogue, action, interiority, description, transition). Before a chapter is drafted, the passages that are the closest precedent for its beats are retrieved and put in the prompt. The model writes *next to* real examples of how this author handles an argument, a corridor, a gut-punch.

Then the draft is measured against the author's fingerprint and the deviations are named:

| Metric | Author | Draft | Drift | Severity |
|---|---:|---:|---:|---|
| mean sentence length | 13.6 | 24.1 | +77% | blocker |
| dialogue share | 0.34 | 0.11 | −68% | blocker |
| plain dialogue tag share | 0.81 | 0.34 | −58% | major |
| abstract nouns / 1k | 4.2 | 11.7 | +179% | blocker |

The editing agent works from that table. Not from taste.

### "The chapters don't flow"

The previous version had a continuity phase that wrote a markdown summary the next agent was asked to "read and respect". Nothing checked that it did. So chapter 7 could open with a character in a city chapter 6 had just watched them leave.

Continuity is now a typed contract. Each chapter emits a **handoff**: ending location, per-character state (where, what they know, physical condition, emotional register), timeline position, threads touched, and the open question the next chapter must engage. The next chapter is validated against it in code:

- a character relocating with no travel shown and no reference to where they were → **blocker**
- someone acting on a fact the book never showed them learning → **major**
- in-world time running backwards without a declared flashback → **blocker**
- a thread past its `mustResolveBy` chapter → **blocker**
- a setup planted in chapter 2 still unpaid with two chapters left → **major**

---

## Why the AI-ism detector had to be rebuilt

The old `config/ai-isms.yaml` was a list of ~200 banned words: *whispered*, *ache*, *shattered*, *silence*, *afraid*, *slowly*. That is wrong in both directions at once.

**False positives.** Plenty of real novelists write "whispered". Flagging it punishes an author for their own voice, and pushes the editing pass to swap natural prose for thesaurus prose — which is how the output got stiff.

**False negatives.** A model can avoid every listed word and still be obviously machine-written, because what gives it away is not vocabulary but **uniformity**: every sentence the same length, every paragraph the same shape, every character the same register, every emotion named rather than shown.

So detection is calibrated against the author's own corpus. A word is only suspicious when *this author* does not use it at that rate. What is actually enforced is structural: repeated sentence openers, repeated 4-grams, paragraph lengths with no spread, dialogue lines that all run the same length. The remaining list is advisory, and anything the corpus does at a comparable rate is exempt by policy.

---

## Canon Quill Studio

`npm run studio` → <http://127.0.0.1:4180>

A local web UI, loopback-only, no build step. It replaces a wizard that was previously one textarea for pasting Drive URLs.

1. **Connect Drive** — narrow `drive.file` scope; only files you pick.
2. **Select sources** — browse Drive, mark reference folders, set the target folder.
3. **Analyse & group** — every document is read and classified into *past series books · reference books · characters · timeline · worldbuilding · plot · notes*, with a confidence and the evidence behind it. Low-confidence guesses are surfaced for confirmation, and anything can be re-assigned.

   This grouping matters more than it looks: **only past series books feed the style corpus and canon.** A reference book by another author filed wrongly would pull the writing toward someone else's voice — the exact failure the system exists to prevent.
4. **Project shape** — standalone or series; chapter-by-chapter or whole book.
5. **Style corpus** — build the fingerprint and see your own measured targets.
6. **Questions** — when an agent hits a decision only you can make, it posts it here instead of guessing and burying the assumption. Blocking questions hold the pipeline.
7. **Chapters** — the board, with live style-fidelity and flow verdicts per chapter.

---

## The two drafting modes

Chosen once, before writing starts. **The only difference is where you approve. Every quality gate runs identically in both.**

| | Chapter by chapter | Whole book |
|---|---|---|
| **Loop** | draft → edit → validate → **you approve** → next | draft → edit → validate → next, for every chapter |
| **You are asked** | after each chapter | once, on the finished manuscript |
| **Style + flow gates** | every chapter | every chapter |
| **Best for** | catching a drift in voice or plot at chapter 2 rather than chapter 20 | getting a complete draft to react to without supervising it |
| **Trade-off** | you need to be present throughout | a systematic problem surfaces only after the whole book is written |

---

## Architecture

```
src/style/         the fidelity engine
  text.ts          tokenisation: sentences, paragraphs, dialogue spans, tags
  metrics.ts       the quantitative fingerprint (18 comparable measures)
  corpus.ts        past books → beat-tagged passages + fingerprint
  retrieve.ts      scene brief → matched exemplars → prompt block
  score.ts         draft vs fingerprint → named deviations + repetition findings

src/continuity/    chapter-to-chapter flow
  ledger.ts        typed state: character states, threads, promises, timeline
  flow.ts          opening contracts + validation of a draft against the handoff

src/analysis/
  classify.ts      Drive documents → source kinds, with confidence and evidence

src/studio/        the local UI and its API
src/drive/         OAuth + a Drive client that paginates and walks recursively
```

Style scoring and flow validation are pure functions over text and typed state, which is why they can be tested — **84 tests**, no network, no model calls.

---

## Setup

Requires Node `20.19.0+`.

```bash
npm run setup     # checks Node, installs OpenCode + OpenSpec, builds, validates
npm run studio    # the UI
opencode          # the agent workflow; Tab to book-orchestrator
```

For Drive, create an OAuth **Desktop app** client, download the JSON, and point `.env` at it:

```
GOOGLE_OAUTH_CLIENT_JSON=/absolute/path/to/credentials.json
```

Then enable the Drive MCP server by setting `canon_drive.enabled` to `true` in `opencode.json` and restarting OpenCode.

## Commands

```bash
npm run studio            # Canon Quill Studio
npm run check             # build + workflow validation + tests
npm run preview -- --file <md>   # book-style reading preview
npm run docx              # generate the final DOCX
npm run archive:project   # archive and reset for the next book
```

## Your book is never in this repo

Everything generated — references pulled from Drive, extracted style corpora, bibles, drafts, chapters, exports — lives under `.canon-quill/` and `.canon-quill-archives/`, both gitignored, with pattern-level rules behind them as defence in depth. The repo holds the engine, never the book.

## Limitations

- Exemplar retrieval is lexical and structural, not embedding-based. Deterministic, needs no API key, and adequate for "same beat, these characters" — but it will not catch a thematic match phrased in entirely different words.
- The fingerprint needs roughly 2,000+ words of the author's prose to be stable. Below that, deviations are reported as advisory and the UI says so.
- Flow validation is deliberately conservative. It reports what it can prove from structured state and stays quiet where only a human can judge; a gate that cries wolf gets switched off.
- Character-name detection is capitalisation-based and will over-match on prose with heavy proper-noun use.

## Licence

MIT
