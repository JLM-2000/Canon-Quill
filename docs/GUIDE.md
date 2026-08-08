# Canon Quill: the full guide

Everything the system does, in the order you will meet it.

---

## 1. The mental model

There are three pieces, and it helps to keep them separate.

**The Studio** is a local web app. It is where you make decisions: which Drive folders to read, what kind of book this is, which pile a document belongs in, whether a chapter is approved. It also shows you what the engine measured.

**The engine** is plain TypeScript. It measures prose, retrieves passages, checks continuity. It has no opinions and calls no models. Everything it reports is reproducible.

**The agents** are OpenCode prompts in `.opencode/agents/`. They do the writing. They read from the engine and write back to it.

You can use the Studio without ever opening OpenCode. You will not get chapters that way, but every setup and analysis step works standalone.

---

## 2. Books and workspaces

Each book is a folder under `workspaces/`:

```
workspaces/
  registry.json           which books exist, which one is active
  the-tide-house/
    project.json          settings, source list, chapter board
    drive-cache/          documents pulled from Drive, by file id
    artifacts/
      style-corpus.json   your passages, tagged by beat
      style-fingerprint.md
      chapters/           drafts, edits, per-chapter reports
      continuity/         ledger.json and per-chapter handoffs
      final/              manuscript.md, manuscript.docx, reports
    logs/                 phase, audit and error logs
```

Books are independent. Two books never share a style corpus, a canon, or a chapter board. Switching between them is instant, and finishing one does not delete or move anything.

```bash
npm run book:new -- "The Tide House"
npm run book:list
npm run book:use -- the-tide-house
npm run book:finish -- the-tide-house   # marks it done, keeps everything
```

The Studio's book dropdown does the same thing.

`workspaces/` is gitignored, so your writing never enters the repository.

---

## 3. Connecting Google Drive

**You cannot connect yet if you have not done this.** There is no `.env` in a fresh clone.

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and select or create a project.
2. **APIs and Services > Library**, find **Google Drive API**, enable it.
3. **APIs and Services > Credentials**, **Create credentials > OAuth client ID**.
   - If it asks you to configure a consent screen first: external, fill the required fields, add yourself as a test user.
   - Application type: **Desktop app**.
4. Download the JSON.
5. In the project root, create `.env`:

```
GOOGLE_OAUTH_CLIENT_JSON=/absolute/path/to/credentials.json
```

6. In `opencode.json`, change `canon_drive.enabled` from `false` to `true`, and restart OpenCode if it is running.

Now open the Studio and press **Check connection**. A browser window opens once to authorise. A refresh token is stored locally.

### About the permission scope

The scope is `drive.file`. This is the narrow one: Canon Quill sees only files you explicitly select or that it creates itself. It cannot enumerate your Drive. If a folder you picked does not appear, that is usually the scope working as intended rather than a bug.

---

## 4. The phases

The workflow is defined in `workflows/book-writing.workflow.yaml`. Here is what each phase is actually for.

### Setup

Checks Node, the build, OpenSpec, and whether Drive credentials are present. Fails loudly with the exact blocker rather than half-starting.

### Intake

Asks the project-level questions **before** anything is read: standalone or series, audience, POV and tense, intimacy boundary, how mysteries should be handled.

The reason this comes first is that these answers change what gets extracted from your references. Asking them later means re-doing work.

### Drive selection

You pick reference folders and a target folder. Folders are walked recursively, and pagination is followed, so a folder with more than a thousand files is read completely.

### Source analysis

Every document is read and sorted into one of seven groups:

| Group | What it is | What it feeds |
|---|---|---|
| **Past series book** | your own earlier books | style corpus **and** canon |
| **Reference book** | another author's work | nothing automatic, held for reference |
| **Characters** | cast lists, sheets, bibles | character canon |
| **Timeline** | chronology, dates, eras | timeline canon |
| **Worldbuilding** | setting, magic, factions | world canon |
| **Plot** | outlines, synopses, beat sheets | chapter plan |
| **Notes** | everything else | nothing automatic |

Each result carries a confidence and the evidence behind it, for example "narrative prose (48,120 words, 31% dialogue)" or "by-line 'Eleanor Finch' near the top".

**Check this step.** Only *past series books* feed your voice and your canon. If someone else's novel lands in that pile, you get a book that sounds like them and contradicts itself. Anything the classifier is unsure about is surfaced for you to confirm, and you can move any document to any pile with a dropdown.

### Style corpus

Your past books are cut into passages, each tagged by beat type:

- **dialogue** - people talking
- **action** - physical events, movement
- **interiority** - thought, memory, decision
- **description** - place, person, atmosphere
- **transition** - time and place shifts

Passage boundaries never cut a paragraph in half, and a run of dialogue is kept together rather than being absorbed into surrounding narration.

Then it measures you. Eighteen numbers, including mean sentence length and how much it varies, how often you use fragments, how much of your page is dialogue, how long your dialogue lines run, whether your tags are plain or ornate, and your rates of adverbs, filter verbs, abstractions and similes.

You need roughly 2,000 words of your prose for these to settle. The Studio warns you below that.

### Reference extraction

Canon facts, characters, timeline and constraints are pulled from the grouped sources. Series projects also inherit canon from the earlier books, and that canon is binding for everything that follows.

### Preparation

Builds the project brief, the world, plot and character bibles, the style guide, the chapter plan and the validation rubric.

Each chapter in the plan declares its beats, its POV, which thread it advances, and the question it must close on. That last field is what makes the next chapter have something to answer.

### Preflight review

**A stop.** You read the preparation package before a word of prose is written. Approve it, or send corrections and it loops back.

This is the cheapest place to catch a wrong premise.

### Mode select

You choose chapter-by-chapter or whole-book. See section 5.

This is the last interactive decision until a gate.

### The drafting loop

**Draft.** The prompt carries two things the old approach lacked: the opening contract from the previous chapter's handoff, and retrieved passages of your own prose matched to each beat in this chapter. No questions are asked here. If something is missing, the least invasive option is chosen and the assumption is logged.

**Edit.** The draft is scored, and the revision works from named deviations. Not a general polish pass. If a change would make the prose less like yours, it is not made.

**Validate.** Style fidelity, chapter flow, canon consistency, boundary compliance. Passing routes on the mode you chose.

**Approve** (chapter-by-chapter only). You read it with its scores and either approve or send notes. Notes shape every following chapter.

**Post.** The approved chapter is written to your Drive target folder. It will not overwrite an existing file unless you allow it.

**Continuity update.** The chapter's handoff is recorded. See section 6.

### Finalisation and export

The manuscript is compiled with reports on continuity, style across chapters, unresolved threads and unpaid setups. You review the whole book, then it becomes a DOCX and is uploaded, and the project is marked finished.

---

## 5. Chapter by chapter, or whole book

Both run identical quality gates. The difference is only where you approve.

### Chapter by chapter

```
draft -> edit -> validate -> YOU APPROVE -> post -> continuity -> next chapter
```

Use this when the voice matters more than the speed, or when you are not yet sure the premise holds. Your notes on chapter 2 change chapter 3. You catch a drift early, when fixing it costs one chapter instead of twenty.

The cost is that the book advances only while you are paying attention.

### Whole book

```
draft -> edit -> validate -> continuity -> next chapter -> ... -> YOU REVIEW THE BOOK
```

Use this when you want a complete draft to react to. Continuity and style are still enforced on every chapter as it goes, so this is not a free-for-all. What you give up is the chance to redirect mid-book.

The cost is that a systemic problem, one that touches every chapter, only becomes visible once every chapter exists.

You can change the mode between books. Changing it mid-book is possible but means the chapters written under the old mode were approved on different terms.

---

## 6. How chapters stay connected

At the end of a chapter, the system records a **handoff**:

- where the chapter physically leaves the story
- in-world time it ends at, time elapsed, whether it was a flashback
- for every character on the page: where they are, what they now know, their physical condition, the register they exit on, who they are with
- facts established that later chapters may rely on
- the beat it closes on
- **the open question the next chapter must engage**

Before the next chapter is drafted, that handoff becomes an **opening contract**: a checklist stating where everyone is, what they know, what is still open, and what must be honoured.

After it is drafted, it is checked against that contract:

| Problem | Severity |
|---|---|
| character relocated with no journey shown and no reference to where they were | fails |
| in-world time runs backwards with no declared flashback | fails |
| a thread past the chapter you said it would resolve by | fails |
| a character acting on a fact the book never showed them learning | needs revision |
| a condition (injury, exhaustion) simply dropped | needs revision |
| the previous chapter's closing question never engaged | needs revision |
| a main thread untouched for three chapters | needs revision |
| a setup planted long ago, unpaid, with the book nearly over | needs revision |

The checker is deliberately cautious. It reports what it can prove from recorded state and stays quiet where only you can judge, because a checker that fires constantly is a checker you switch off.

---

## 7. Reading the style report

```
Fidelity: 64/100, verdict REVISE

| Metric                | Author | Draft | Drift | Severity |
| mean sentence length  | 13.6   | 24.1  | +77%  | blocker  |
| dialogue share        | 0.34   | 0.11  | -68%  | blocker  |
| abstract nouns / 1k   | 4.2    | 11.7  | +179% | blocker  |
```

**Fidelity** is 0 to 100. At or above 80 passes. Below 60 fails. In between needs revision.

**Author** is your measured number. **Draft** is this chapter's. **Drift** is how far off it is, relative to you.

Below the deviations sits a repetition section: repeated phrases, repeated sentence openers, paragraphs that are all the same length, an overused dialogue tag, dialogue lines that all run the same length. These are structural, so they survive any amount of word-swapping, and they are usually the more damning half of the report.

A low score is not automatically bad. If you deliberately wrote a chapter in a different register, the score will say so, and that is the checker doing its job rather than being wrong. Approve it anyway.

---

## 8. Things worth knowing

**Nothing leaves your machine except Drive traffic.** The Studio binds to loopback only.

**Your book is never in the repository.** `workspaces/` is gitignored, with pattern rules behind it.

**The Studio is safe to leave running.** It reads state fresh on each request, so agents writing to a workspace and the UI reading it do not conflict. Writes go through a temp file and a rename, so a crash cannot leave a half-written state file.

**Questions from agents appear in the Studio.** When an agent hits a decision only you can make, it posts it rather than guessing and burying the assumption. Blocking questions hold the pipeline.

**The classifier is a guess.** It is right often enough to save you the sorting, and it shows its reasoning so you can catch it when it is wrong. Treat the grouping board as a review step, not a result.

**Small corpus, soft numbers.** Under about 2,000 words of your prose, deviations are advisory and the reports say so.

---

## 9. Troubleshooting

**"No book selected."** Create one, in the Studio or with `npm run book:new -- "Title"`.

**Drive says not connected.** Check that `.env` exists, that `GOOGLE_OAUTH_CLIENT_JSON` is an absolute path, and that the file is an OAuth client of type *Desktop app* rather than a service account key.

**A folder does not show up when browsing.** The `drive.file` scope only exposes files you have selected or that Canon Quill created. This is the intended trade-off.

**"No sources are grouped as a past series book."** The style corpus is built only from your own prose. Move at least one of your books into that pile on the grouping board.

**A chapter keeps failing style.** Read which metrics are drifting. If they are all the same direction, the drafting prompt is probably missing the fingerprint. If the score is fine but the prose feels wrong, the corpus may be too small or built from the wrong documents.

**OpenCode does not list `book-orchestrator`.** Restart it from this folder; agents are read at startup.
