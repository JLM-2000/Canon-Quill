# Canon Quill

Agentic book-writing workflows grounded in an author's own past prose, with the
quality gates needed to keep a long manuscript in the same voice and continuity.

The hard part is not asking a model to write. It is giving it the right canon,
showing it how this author actually writes, and proving that the next chapter
still agrees with the chapters before it.

```bash
npm run setup
npm run check
npm run studio
```

The Studio is a local web application. Writing runs through Claude Code or
OpenCode on an Anthropic or OpenAI model. Canon Quill's analysis, style scoring,
continuity checks, and workflow validation are ordinary TypeScript functions,
not model calls.

---

## What the gates measure

| Gate | Evidence | Failure it prevents |
|---|---|---|
| Source analysis | Selected documents with explicit roles and provenance | Another author's prose entering the style corpus |
| Style corpus | Measured passages from series books or chosen voice references | A generic description of style replacing the author's actual prose |
| Project analysis | Claims, conflicts, unknowns, and author decisions | Guessing at canon, audience, reveals, or boundaries |
| Preparation | Project brief, bibles, plot, style guide, chapter plan, rubric, and manifest | Drafting before the book's contracts exist |
| Chapter handoff | Location, knowledge, condition, timeline, relationships, open threads | Chapter 12 contradicting chapter 3 |
| Validation | Flow, continuity, style, dialogue, boundary, and proofreading reports | A fluent but unsupported or off-voice chapter being accepted |

The system measures prose against the author's own corpus, not against a generic
standard of good writing. If the corpus uses a habit at a normal rate, Canon
Quill does not ban it because an AI-ism list dislikes the word.

## How it works

1. Select the source material and assign roles. Series books provide canon and
   are also voice references. Planning documents inform preparation but do not
   become prose exemplars.
2. Build the style corpus from beat-tagged passages such as dialogue, action,
   interiority, description, and transition.
3. Analyse the project with deterministic source measurements, then ask only
   the author decisions that remain unresolved.
4. Prepare the book package and require the author to review it before prose is
   written.
5. Start the selected writing runtime. It reads the workspace, approved
   artifacts, author decisions, prior directions, and recorded run history.
6. Draft, edit, validate, and record a typed handoff for every chapter.
7. Approve the chapters, compile the manuscript, and download DOCX or print a
   formatted document view as PDF.

## The Studio

The Studio keeps each book in its own workspace and exposes the decisions that
matter instead of hiding them inside a prompt.

**Sources.** Browse Google Drive or upload local planning material. Only the
files selected by the author are indexed. Source roles can be corrected, and a
document can satisfy more than one role.

**Writing engine.** Choose Anthropic or OpenAI, subscription or API key, and a
single or split provider route. In split mode, preparation and drafting can use
different providers. Credentials never enter project state or the agent prompt.

**Preparation.** The required package is nine artifacts: project brief, book
bible, character bible, world bible, plot bible, style guide, chapter plan,
validation rubric, and preparation manifest. The Studio shows completed and
pending documents while preparation runs. Completed documents can be read and
annotated before the package is reviewed.

**Resuming.** A provider switch starts a new runtime session, not a new book.
The next session inherits the workspace, decisions, artifacts, chapter states,
directions, and recorded runtime conversation. It does not rely on the old
provider's hidden context.

**Outputs.** Chapters and final manuscripts are available as Markdown and DOCX.
The formatted browser view is suitable for printing or saving as PDF.

## Provider defaults

Models and catalog rates live in `config/models.yaml` and can be changed in the
Studio. The default split route uses a cheaper analysis model and a stronger
drafting model. The pre-start estimate reports approximate input tokens, output
tokens, total tokens, and API cost. Subscription runs show token usage without a
per-token dollar figure.

The estimate is intentionally directional. It does not yet claim cache savings,
because the external runtimes own the provider requests and Canon Quill does not
currently receive a structured cache-read or cache-write breakdown.

## Stack

| Area | Implementation |
|---|---|
| Runtime | Node 20.19+, TypeScript, Express |
| Writing runtimes | Claude Code and OpenCode |
| Sources | Google Drive API and local workspace uploads |
| Style | Corpus extraction, beat retrieval, 18-metric fingerprint, deviation scoring |
| Continuity | Typed ledger, chapter opening contracts, flow validation |
| Documents | Markdown preview and DOCX generation |
| Workflow | OpenSpec-validated YAML workflow and authored agents |
| Tests | Vitest over pure functions plus a real local HTTP Studio |

## Workspace

Generated book data is kept outside the repository:

```text
workspaces/
  the-tide-house/
    project.json
    drive-cache/
    artifacts/
      project-analysis.json
      decision-log.md
      style-corpus.json
      style-fingerprint.md
      chapters/
      continuity/
      final/
    logs/
      phase-log.json
      audit-log.json
      errors-log.json
```

The repository holds the engine. The book remains in its workspace, which is
gitignored.

## Development

```bash
npm run build
npm run validate:workflow
npm test
```

`npm run check` runs all three. The current suite contains 298 tests and does
not call a network or a model.

## Limitations

- Passage retrieval matches wording and measured structure, not abstract
  thematic similarity.
- A style fingerprint needs enough prose before its targets become stable.
- Continuity validation proves typed facts and stays cautious when evidence is
  missing.
- Model quality still varies by provider, model, prompt context, and runtime.
- Cache-aware cost accounting depends on structured usage from Claude Code and
  OpenCode and is not part of the current estimate.

## Licence

MIT
