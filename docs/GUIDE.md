# Canon Quill: the full guide

Everything the system does, in the order you will meet it.

---

## 1. The mental model

There are three pieces, and it helps to keep them separate.

**The Studio** is a local web app. It is where you make decisions: which Drive folders to read, what kind of book this is, which pile a document belongs in, whether a chapter is approved. It also shows you what the engine measured.

**The engine** is plain TypeScript. It measures prose, retrieves passages, checks continuity. It has no opinions and calls no models. Everything it reports is reproducible.

**The agents** are the prompts that do the writing. They read from the engine and write back to it. The same prompts ship for both runtimes: `.claude/agents/` for Claude Code, `.opencode/agents/` for OpenCode. The OpenCode files are the source and the Claude Code ones are generated from them by `npm run sync:agents`, so edit the OpenCode copies.

**The runtime** is Claude Code or OpenCode. It runs the agents and owns the model connection.

You can use the Studio without opening either. You will not get chapters that way, but every setup and analysis step works standalone.

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

## 3. Starting the Studio

```bash
npm run studio
```

It prints the URL and opens your browser:

```
  Canon Quill Studio is running.

      http://127.0.0.1:4180

  Press Ctrl+C to stop.
```

If the browser does not open (headless box, WSL without an opener), click or paste the URL. To stop it opening at all, set `CANON_QUILL_NO_OPEN=1`.

In VS Code, press **F5** and pick **Studio** from the Run and Debug dropdown, or run the **Studio** task. Breakpoints in `src/` work. The other configurations there run the test suite (all, current file, or watch) and the CLI commands.

Leave it running while you work. It reads state fresh on each request, so agents writing to a workspace and the UI reading it never conflict.

---

## 4. Choosing a writing engine

The first screen in the Studio. Canon Quill's own engine needs no model at all, so this only decides who writes the prose.

**Provider.** Anthropic (Claude) or OpenAI (GPT).

**How to authenticate.**

- **Subscription.** A Claude Pro or Max plan. No key, no per-token cost, and the cheapest way to run this if you already pay for one. Setup below.
- **API key.** Pay per token. Export `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or put it in `.env`.

The Studio then checks whether a usable credential is present and tells you exactly what to set if not.

### Install a runtime

The runtime is the program that actually talks to the model. You need one; Canon Quill drives it.

**Claude Code** is the simpler choice, and the only one that can use a Claude subscription.

```bash
npm install -g @anthropic-ai/claude-code
```

**OpenCode** is the alternative, and the one to use if you want OpenAI.

```bash
npm install -g opencode-ai
```

`npm run setup` installs OpenCode for you if it is missing. Neither is installed automatically if you already have the other.

### Connect a subscription

Only needed if you picked **Subscription** above. On an API key there is nothing to connect.

Which runtime you use depends on the provider. Canon Quill detects either.

**Anthropic plan (Claude Pro or Max): Claude Code.**

```bash
claude
```

The first run opens your browser and asks you to sign in with the account your plan is on. Approve it, and the login is stored in `~/.claude`. Then type `/exit`. Run `claude` again to confirm: it should go straight to a prompt with no sign-in step. `/logout` then `claude` switches account.

A Claude plan **cannot** be used through OpenCode. On that runtime, Anthropic needs an API key.

**OpenAI plan (ChatGPT): OpenCode.**

```bash
opencode auth login
```

Pick OpenAI, then choose the sign-in option rather than the API-key option. Your browser opens; approve it. Credentials land in `~/.local/share/opencode/auth.json`.

Check what you have connected at any time:

```bash
opencode auth list
```

```
┌  Credentials  ~/.local/share/opencode/auth.json
│
●  Anthropic   oauth
●  OpenAI      oauth
│
└  2 credentials
```

`oauth` means a plan sign-in. `api` means a stored key. `opencode auth logout` removes one.

Back in the Studio, **Writing engine** will now show *Credential found* and a tag saying which runtime holds it.

### If the Studio says a credential is needed

- **Subscription:** no plan sign-in was found. For Anthropic it looks for `~/.claude`; for OpenAI, an `oauth` entry in OpenCode's `auth.json`. Run `opencode auth list` to see what is actually connected. Signing in as a different OS user will also hide it.
- **API key:** the environment variable is not visible to the Studio's process and no runtime has a key stored. Export it in the same shell, or add it to `.env`.
- **After editing `.env`:** it is read at startup only. Restart the Studio.

Canon Quill reads only the provider names and whether each entry is `oauth` or `api` from those files. It never reads the tokens.

**There is no field to paste a key, by design.** Anything typed into a web form ends up in a plaintext state file, so the API refuses credentials outright. Keys stay in your environment; subscriptions stay inside the runtime's own login.

### Which model for which phase

Defaults come from `config/models.yaml` and can be changed per phase in the Studio.

| Phase | Anthropic | OpenAI | Why |
|---|---|---|---|
| **Drafting** | Claude Opus 5 | GPT-5.6 Sol | The prose itself. The one place capability shows up directly. Do not economise. |
| **Editing** | Claude Sonnet 5 | GPT-5.6 Terra | The deviations are already named by the engine, so this is execution more than judgement. |
| **Validation** | Claude Sonnet 5 | GPT-5.6 Terra | Style and flow are computed in code; the model only judges what code cannot. |
| **Analysis** | Claude Haiku 4.5 | GPT-5.6 Luna | Extraction and summarising. High volume, low difficulty. |
| **Orchestration** | Claude Haiku 4.5 | GPT-5.6 Luna | Routing between phases. Almost no reasoning. |

Rough cost for a 90,000-word book at three passes per chapter:

| | Anthropic | OpenAI |
|---|---|---|
| Top tier for drafting, mid tier elsewhere | $15 to $40 | roughly $20 to $50 |
| Mid tier throughout | $5 to $12 | unverified |
| On a subscription | no marginal cost (Claude Pro or Max) | not available through Claude Code |

The Studio shows the figures for whichever provider you picked, with the other alongside for comparison. Verify prices before budgeting: the `verified` dates in `config/models.yaml` record when each was last checked, and only GPT-5.6 Sol's pricing is confirmed on the OpenAI side.

---

## 5. Connecting Google Drive

**A fresh clone has no `.env`, so you cannot connect until you do this.** It takes about five minutes and Google's console moves things around, so the steps are spelled out.

### Create the project and enable the API

1. Open the [Google Cloud console](https://console.cloud.google.com/). Sign in with the Google account whose Drive holds your books.
2. Top bar, project dropdown, **New project**. Name it anything (`canon-quill` is fine), **Create**, then make sure that project is selected.
3. Navigation menu, **APIs and Services > Library**. Search **Google Drive API**, open it, **Enable**. Wait for it to finish.

### Configure the consent screen

Google will not let you create an OAuth client until this exists.

4. **APIs and Services > OAuth consent screen** (in newer consoles this sits under **Google Auth Platform > Branding**).
5. User type: **External**. (**Internal** only appears with Google Workspace, and is simpler if you have it.) **Create**.
6. Fill the required fields: **App name** (anything), **User support email** (yours), **Developer contact email** (yours). Everything else can stay blank. **Save and continue**.
7. **Scopes**: skip it. Canon Quill requests its scope at runtime. **Save and continue**.
8. **Test users**: this is the step people miss. Click **Add users** and add **your own Google address**. While the app is in Testing, only listed test users can authorise it, and leaving yourself out produces an `access_denied` error that looks like a bug. **Save and continue**.

### Create the credentials

9. **APIs and Services > Credentials**, **Create credentials**, **OAuth client ID**.
10. Application type: **Desktop app**. This matters. A *Web application* client needs redirect URIs and will fail; a *service account* key is a different thing entirely and will not work.
11. Name it, **Create**, then **Download JSON**. Keep the file outside this repo (`~/.config/` or anywhere private).

### Point Canon Quill at it

12. Create `.env` in the project root and point it at the file you just downloaded:

```
GOOGLE_OAUTH_CLIENT_JSON=/absolute/path/to/credentials.json
```

**Any platform's path style works.** Canon Quill translates between them, so you can paste whatever your file browser gave you:

| You are on | Write | Notes |
|---|---|---|
| **Windows** | `C:\Users\you\Downloads\creds.json` | Forward slashes work too |
| **WSL** | `C:\Users\you\Downloads\creds.json` | Translated to `/mnt/c/...` for you |
| **WSL**, file inside Linux | `/home/you/creds.json` | |
| **macOS / Linux** | `/Users/you/creds.json`, `~/creds.json` | `~` is expanded |

Quotes around the value are fine, and so are spaces in the path. If your WSL mounts drives somewhere other than `/mnt`, `/c/...` is tried as well.

If the file cannot be found, the error prints exactly which paths were tried and why, rather than claiming the file is the wrong type.

13. If you are using OpenCode, change `canon_drive.enabled` from `false` to `true` in `opencode.json` and restart it. Claude Code needs nothing here; the Studio talks to Drive directly.

14. Restart the Studio. `.env` is read at startup only.

15. Open **Connect Drive**. It reports one of three states without ever blocking:

- **Not configured** means the credentials file was not found or is not an OAuth client. The message says which paths it tried.
- **Credentials found, not authorised yet** means everything is right and you just need to grant access. Press **Connect Google Drive**; Google opens in a new tab, and the page updates itself once you approve.
- **Connected** means you are done.

### The warning you will see when authorising

Because the app is in Testing and unverified, Google shows **"Google hasn't verified this app"**. Click **Advanced**, then **Go to <your app name> (unsafe)**. This is your own OAuth client talking to your own Drive; verification only matters for apps distributed to other people.

### Two things that will bite you later

**Test-mode refresh tokens expire after seven days.** While the consent screen is in Testing, Google expires refresh tokens weekly, so Drive will stop working after about a week and you re-authorise. To stop that, go to the consent screen and **Publish app**. You will stay unverified (still the "unsafe" click-through), but tokens stop expiring.

**What access you are granting.** Two scopes by default:

| Scope | What it allows |
|---|---|
| `drive.readonly` | Read your Drive. This is what makes the folder browser work. No write access at all. |
| `drive.file` | Write, but only to files Canon Quill creates. This is how finished chapters reach your target folder. |

Canon Quill cannot modify or delete anything that already exists in your Drive.

**If you would rather grant less**, set this in `.env` and restart:

```
CANON_QUILL_DRIVE_SCOPES=https://www.googleapis.com/auth/drive.file
```

Then browsing is not possible, because `drive.file` can only see files the app created itself. Instead of browsing you paste folder links into the **Or paste Drive links** box on the Select sources screen. Everything else works the same.

This is worth knowing if you connected early on: the first version requested `drive.file` alone, which is why My Drive appeared empty. Reconnect and the browser fills in.

### If it still fails

| Message | Cause |
|---|---|
| `access_denied` | You are not in the test users list, or the app is in Testing and you signed in with a different account. |
| `must point to a Google OAuth desktop credentials JSON file` | The path is wrong, relative, or the file is a service-account key rather than an OAuth client. |
| `redirect_uri_mismatch` | The client is a *Web application*. Create a **Desktop app** client instead. |
| Worked last week, fails now | Test-mode refresh token expired. Re-authorise, then publish the consent screen. |

---

## 6. The phases

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
| **Reference book** | comparison titles, research, anything not your own series | held for reference; never feeds the corpus |
| **Characters** | cast lists, sheets, bibles | character canon |
| **Timeline** | chronology, dates, eras | timeline canon |
| **Worldbuilding** | setting, magic, factions | world canon |
| **Plot** | outlines, synopses, beat sheets | chapter plan |
| **Notes** | everything else | nothing automatic |

**Check this step.** Only *past series books* feed your voice and your canon. If someone else's novel lands in that pile, you get a book that sounds like them and contradicts itself.

Click the labels on any document to change its groups. A document can be in several at once, which is normal: one file often holds a timeline, an outline and loose notes, and your own past books are usually both style corpus and general reference.

Re-analysing replaces the grouping entirely, so the Studio warns before doing it.

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

You choose chapter-by-chapter or whole-book. See section 7.

This is the last interactive decision until a gate.

### The drafting loop

**Draft.** The prompt carries two things the old approach lacked: the opening contract from the previous chapter's handoff, and retrieved passages of your own prose matched to each beat in this chapter. No questions are asked here. If something is missing, the least invasive option is chosen and the assumption is logged.

**Edit.** The draft is scored, and the revision works from named deviations. Not a general polish pass. If a change would make the prose less like yours, it is not made.

**Validate.** Style fidelity, chapter flow, canon consistency, boundary compliance. Passing routes on the mode you chose.

**Approve** (chapter-by-chapter only). You read it with its scores and either approve or send notes. Notes shape every following chapter.

**Post.** The approved chapter is written to your Drive target folder. It will not overwrite an existing file unless you allow it.

**Continuity update.** The chapter's handoff is recorded. See section 8.

### Finalisation and export

The manuscript is compiled with reports on continuity, style across chapters, unresolved threads and unpaid setups. You review the whole book, then it becomes a DOCX and is uploaded, and the project is marked finished.

---

## 7. Chapter by chapter, or whole book

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

## 8. How chapters stay connected

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

## 9. Reading the style report

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

## 10. Things worth knowing

**Nothing leaves your machine except Drive traffic.** The Studio binds to loopback only.

**Your book is never in the repository.** `workspaces/` is gitignored, with pattern rules behind it.

**The Studio is safe to leave running.** It reads state fresh on each request, so agents writing to a workspace and the UI reading it do not conflict. Writes go through a temp file and a rename, so a crash cannot leave a half-written state file.

**Questions from agents appear in the Studio.** When an agent hits a decision only you can make, it posts it rather than guessing and burying the assumption. Blocking questions hold the pipeline.

**The classifier is a guess.** It is right often enough to save you the sorting, and it shows its reasoning so you can catch it when it is wrong. Treat the grouping board as a review step, not a result.

**Small corpus, soft numbers.** Under about 2,000 words of your prose, deviations are advisory and the reports say so.

---

## 11. Troubleshooting

**"No book selected."** Create one, in the Studio or with `npm run book:new -- "Title"`.

**Drive says not connected.** Check that `.env` exists, that `GOOGLE_OAUTH_CLIENT_JSON` is an absolute path, and that the file is an OAuth client of type *Desktop app* rather than a service account key.

**A folder does not show up when browsing.** The `drive.file` scope only exposes files you have selected or that Canon Quill created. This is the intended trade-off.

**"No sources are grouped as a past series book."** The style corpus is built only from your own prose. Move at least one of your books into that pile on the grouping board.

**A chapter keeps failing style.** Read which metrics are drifting. If they are all the same direction, the drafting prompt is probably missing the fingerprint. If the score is fine but the prose feels wrong, the corpus may be too small or built from the wrong documents.

**The orchestrator agent is not listed.** Restart the runtime from this folder; both Claude Code and OpenCode read their agent files at startup. If it is missing under Claude Code specifically, run `npm run sync:agents` to regenerate `.claude/agents/` from the OpenCode sources.
