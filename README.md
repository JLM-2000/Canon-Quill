# Canon Quill

Write a book with an LLM that actually sounds like you wrote it, and where chapter 12 still agrees with chapter 3.

Point it at your past books in Google Drive. It measures how you write, keeps your own paragraphs on hand as reference while it drafts, and refuses to let a chapter through if it drifts from your voice or breaks continuity with the chapter before it.

```bash
npm run setup
npm run studio
```

It prints the URL and opens your browser. In VS Code, press **F5** and pick **Studio**.

Works with **Claude Code** (`.claude/agents/`) or **OpenCode** (`.opencode/agents/`) as the writing runtime, on an Anthropic or OpenAI model, authenticated by subscription or API key. You choose in the Studio.

---

## What makes this different

Most tools describe your style to the model. They write a prompt that says "short sentences, dry humour, close third person" and hope for the best. A description of prose is not prose, and a model given one falls back on its own default voice. That is why the output reads fluent, competent and anonymous.

Canon Quill keeps your actual paragraphs.

**It reads your past books and cuts them into passages**, each tagged by the kind of scene it is: dialogue, action, interiority, description, transition.

**Before drafting a scene, it finds your closest precedent.** Writing an argument between two characters? It pulls the arguments you have already written, preferring ones with those same characters in them, and puts them in front of the model. The model writes next to real examples of how you handle that beat.

**After drafting, it measures the result against you.** Not against a general standard of good writing, against your numbers:

| Measure | You | This draft | Verdict |
|---|---:|---:|---|
| mean sentence length | 13.6 | 24.1 | too long |
| dialogue share | 34% | 11% | too little |
| plain dialogue tags | 81% | 34% | too ornate |
| abstract nouns per 1k | 4.2 | 11.7 | too vague |

The editing pass works from that table. If a fix would make the prose less like yours, it does not make it.

## Chapters that connect

Each chapter ends by recording where it left things: where every character physically is, what they now know, what condition they are in, where the clock stands, which threads moved, and the question the chapter closes on.

The next chapter is checked against that record before it can pass:

- A character who was in Marrow opening the next chapter in Calder, with no journey shown, fails.
- Someone acting on a secret the book never showed them learning fails.
- Time running backwards without a declared flashback fails.
- A thread you said would resolve by chapter 9 still open at chapter 10 fails.
- A gun on the mantelpiece in chapter 2 still unfired with two chapters left gets flagged.

## What it will not do

It will not treat a word as bad because a list somewhere says so. Plenty of novelists write "whispered" and "ache", and flagging those would just punish you for your own voice while pushing the editing pass toward thesaurus prose.

What it looks for instead is sameness, which is what actually gives a machine away: every sentence the same length, every paragraph the same shape, every character talking in the same register, every feeling named instead of shown. Those are measured directly. Anything your own writing does at a normal rate is left alone.

---

## The Studio

`npm run studio` opens a local web app. Nothing leaves your machine.

**Writing engine.** Pick your provider (Anthropic or OpenAI) and how it authenticates (subscription or API key). Canon Quill's own engine needs no model at all, so this only decides who writes the prose. There is no field to paste a key and the API refuses one: keys stay in your environment, subscriptions stay inside your runtime's login.

**Books.** Each book is its own workspace with its own sources, style corpus, chapters and continuity. Start a second book without touching the first. Finishing a book never deletes it.

**Connect Drive.** Narrow permissions, only the files you pick.

**Select sources.** Browse your Drive, mark the folders to read, choose where finished chapters get written back.

**Analyse and group.** Every document is read and sorted into past series books, reference books by other authors, characters, timeline, worldbuilding, plot, and notes. Each result shows how confident it is and why. Anything uncertain is put in front of you rather than assumed, and you can move anything to a different pile.

This step matters more than it looks. Only *past series books* feed your style corpus and your canon. Another author's novel filed in the wrong pile would pull your writing toward their voice, which is the one thing this is built to prevent.

**Project shape.** Standalone or part of a series. Series books inherit canon from the earlier volumes and are held to it.

**Style corpus.** Build it, then see your own measurements.

**Questions.** When something genuinely needs your decision, it gets asked here instead of guessed at and buried in a document. Blocking questions hold the pipeline until you answer.

**Chapters.** The board, with each chapter's style score and continuity verdict.

---

## Two ways to write

Pick one before drafting starts. The only difference is where you approve. Every quality check runs in both.

|  | Chapter by chapter | Whole book |
|---|---|---|
| **What happens** | writes a chapter, edits it, checks it, then stops for you | writes every chapter start to finish |
| **You are asked** | after each chapter | once, on the finished manuscript |
| **Style and continuity checks** | every chapter | every chapter |
| **Good for** | catching a problem at chapter 2 instead of chapter 20 | getting a full draft to react to |
| **Cost** | you need to be around | a systemic problem shows up only at the end |

---

## What it costs

The engine is free. Measuring prose, building the corpus, retrieving exemplars and validating continuity never call a model.

Only the writing does. For a 90,000-word book at three passes per chapter: roughly **$15 to $40** using Opus 5 for drafting and Sonnet 5 elsewhere, **$5 to $12** on Sonnet throughout, and **nothing extra** on a Claude Pro or Max subscription. Model defaults per phase live in `config/models.yaml` and are editable in the Studio.

## Setup

Node 20.19 or newer.

```bash
npm run setup
```

That checks your Node version, installs OpenCode and OpenSpec if missing, builds, and validates the workflow. If you would rather use Claude Code, install it with `npm install -g @anthropic-ai/claude-code`; the guide covers connecting a subscription to either.

### Google Drive

You need a Google OAuth client of type **Desktop app**.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and pick or create a project.
2. Enable the **Google Drive API**.
3. Under **Credentials**, create an OAuth client ID, application type **Desktop app**.
4. Download the JSON.
5. Create `.env` in this folder:

```
GOOGLE_OAUTH_CLIENT_JSON=/absolute/path/to/your/credentials.json
```

6. In `opencode.json`, set `canon_drive.enabled` to `true`.

Then open the Studio and press **Check connection**.

Two things catch people out: while the OAuth consent screen is in Testing you must add your own Google address as a **test user**, and test-mode refresh tokens expire after **seven days** unless you publish the consent screen. [docs/GUIDE.md](docs/GUIDE.md) walks the whole console flow step by step, including the errors and what causes them.

The scope is `drive.file`, so Canon Quill only ever sees files you explicitly choose, never your whole Drive.

---

## Commands

```bash
npm run studio                  open the Studio
npm run sync:agents             regenerate the Claude Code agents
npm run book:new -- "Title"     start a book
npm run book:list               list your books
npm run book:use -- <slug>      switch books
npm run book:finish -- <slug>   mark a book done, keeping everything
npm run docx                    build the DOCX
npm run check                   build, validate, test
```

## Where your book lives

```
workspaces/
  the-tide-house/
    project.json          settings, sources, chapter board
    drive-cache/          documents pulled from Drive
    artifacts/
      style-corpus.json   your passages, tagged by beat
      style-fingerprint.md
      chapters/           drafts and reports
      continuity/         the ledger and per-chapter handoffs
      final/              manuscript.md, manuscript.docx
    logs/
```

`workspaces/` is gitignored. The repository holds the engine; your writing stays out of it.

## How it is built

```
src/style/       measuring prose, building the corpus, retrieving exemplars, scoring drafts
src/continuity/  the ledger, opening contracts, flow validation
src/analysis/    sorting Drive documents into groups
src/studio/      the local app and its API
src/drive/       OAuth and the Drive client
src/workspace/   projects on disk
```

Agent prompts are authored in `.opencode/agents/` and `.claude/agents/` is generated from them by `npm run sync:agents` (which `npm run build` also runs). One source, both runtimes.

Scoring and validation are ordinary functions over text and typed state, so they are tested without a network or a model. 104 tests.

## Honest limitations

- Finding matching passages works on wording and structure, not meaning. It will not connect two scenes that are thematically alike but share no vocabulary.
- Your fingerprint needs roughly 2,000 words of your prose before the numbers settle. Below that the Studio tells you the targets are noisy.
- Continuity checking is deliberately cautious. It reports what it can prove and stays quiet otherwise, because a checker that fires constantly gets ignored.
- Character detection keys on capitalisation and will over-match on prose dense with proper nouns.
- The classifier guesses. That is why it shows its confidence and asks.

## Licence

MIT
