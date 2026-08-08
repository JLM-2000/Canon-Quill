/**
 * Canon Quill Studio -- local control surface for a book project.
 *
 * Replaces the old wizard, which was a single textarea for pasting Drive URLs.
 * This serves a real UI and the API behind it: browse and select Drive
 * material, classify and group it, answer the questions agents raise, watch
 * chapters move through drafting with live style-fidelity and flow scores.
 *
 * Local-only by design. It binds to loopback, holds no credentials of its own
 * (Drive OAuth lives in `src/drive/auth.ts`), and every write lands in
 * `.canon-quill/`, which is gitignored.
 */

import express, { type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { SafeDriveClient } from "../drive/client.js";
import { extractDriveId } from "../drive/id.js";
import { classifySource, groupSources, sourceKindLabels, type SourceKind } from "../analysis/classify.js";
import { buildCorpus, type CorpusDocument } from "../style/corpus.js";
import { scoreAgainstFingerprint } from "../style/score.js";
import { buildOpeningBrief, validateFlow } from "../continuity/flow.js";
import { computeMetrics } from "../style/metrics.js";
import {
  blockingQuestions,
  derivePhase,
  loadState,
  saveState,
  updateState,
  type OpenQuestion,
  type SelectedSource,
  type StudioState
} from "./state.js";
import { projectPaths } from "../project/paths.js";
import { appendLog } from "../project/logs.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StudioServerOptions {
  port?: number;
  host?: string;
}

export function createStudioApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const drive = new SafeDriveClient();

  // --- UI -------------------------------------------------------------------
  app.get("/", async (_req, res) => {
    // The UI ships as one self-contained file: no bundler, no install step,
    // nothing to rebuild before it will run.
    const candidates = [
      path.join(here, "ui.html"),          // dist/studio/ui.html
      path.join(here, "../../src/studio/ui.html") // running from source via tsx
    ];
    for (const candidate of candidates) {
      try {
        res.type("html").send(await readFile(candidate, "utf8"));
        return;
      } catch {
        continue;
      }
    }
    res.status(500).type("text").send("Studio UI not found. Run `npm run build`.");
  });

  // --- State ----------------------------------------------------------------
  app.get("/api/state", async (_req, res) => {
    const state = await loadState();
    res.json(withDerived(state));
  });

  app.patch("/api/project", async (req, res) => {
    const { projectName, shape, draftingMode, intake } = req.body ?? {};
    const state = await updateState((current) => ({
      ...current,
      projectName: typeof projectName === "string" && projectName.trim() ? projectName.trim() : current.projectName,
      shape: shape === "standalone" || shape === "series" ? shape : current.shape,
      draftingMode:
        draftingMode === "chapter_by_chapter" || draftingMode === "whole_book" ? draftingMode : current.draftingMode,
      intake: intake && typeof intake === "object" ? { ...current.intake, ...intake } : current.intake
    }));
    res.json(withDerived(state));
  });

  app.post("/api/reset", async (_req, res) => {
    const { emptyState } = await import("./state.js");
    res.json(withDerived(await saveState(emptyState())));
  });

  // --- Drive ----------------------------------------------------------------
  app.get("/api/drive/status", async (_req, res) => {
    // Probing with a cheap call tells us whether OAuth is actually usable,
    // rather than whether a token file merely exists.
    try {
      await drive.listFolder("root");
      const state = await updateState((current) => {
        current.drive.connected = true;
      });
      res.json({ connected: true, referenceRoots: state.drive.referenceRoots, targetFolderId: state.drive.targetFolderId });
    } catch (error) {
      res.json({ connected: false, reason: message(error) });
    }
  });

  app.get("/api/drive/browse", async (req, res) => {
    const folderId = typeof req.query.folderId === "string" && req.query.folderId ? req.query.folderId : "root";
    try {
      const entries = await drive.listFolder(folderId);
      res.json({
        folderId,
        entries: entries.map((entry) => ({
          ...entry,
          isFolder: entry.mimeType === "application/vnd.google-apps.folder"
        }))
      });
    } catch (error) {
      res.status(502).json({ error: message(error) });
    }
  });

  app.post("/api/drive/roots", async (req, res) => {
    const raw: unknown = req.body?.roots;
    const roots = Array.isArray(raw)
      ? raw.map((value) => extractDriveId(String(value))).filter((id): id is string => Boolean(id))
      : [];
    const target = req.body?.targetFolderId ? extractDriveId(String(req.body.targetFolderId)) : null;

    const state = await updateState((current) => {
      current.drive.referenceRoots = roots;
      if (target) current.drive.targetFolderId = target;
    });
    res.json(withDerived(state));
  });

  /**
   * Index the selected roots: walk them, read every readable text document,
   * classify it, and store the grouping for the author to confirm.
   */
  app.post("/api/sources/index", async (_req, res) => {
    const state = await loadState();
    if (state.drive.referenceRoots.length === 0) {
      res.status(400).json({ error: "Select at least one reference folder first." });
      return;
    }

    try {
      const documents: Array<{ source: SelectedSource; text: string }> = [];

      for (const root of state.drive.referenceRoots) {
        const tree = await drive.walkFolder(root, { maxDepth: 6, maxFiles: 400 });
        for (const node of flatten(tree)) {
          if (node.isFolder || !isReadable(node.mimeType)) continue;
          let text = "";
          try {
            text = await drive.readFileText(node.id);
          } catch {
            continue; // unreadable file: skip rather than fail the whole index
          }
          const classification = classifySource({ name: node.name, path: node.path, text });
          documents.push({
            source: {
              driveId: node.id,
              name: node.name,
              path: node.path,
              mimeType: node.mimeType,
              isFolder: false,
              kind: classification.kind,
              confidence: classification.confidence,
              reasons: classification.reasons,
              confirmedByUser: false,
              wordCount: computeMetrics(text).wordCount
            },
            text
          });
        }
      }

      // Cache text locally so building the style corpus later does not re-fetch
      // every document from Drive.
      await cacheDocuments(documents.map(({ source, text }) => ({ id: source.driveId, name: source.name, text })));

      const next = await updateState((current) => {
        current.sources = documents.map(({ source }) => source);
        current.drive.lastIndexedAt = new Date().toISOString();
      });

      await appendLog("audit", {
        timestamp: new Date().toISOString(),
        stage: "analyze",
        stageName: "Source analysis",
        agent: "studio",
        event: "sources_indexed",
        data: { count: documents.length }
      });

      res.json(withDerived(next));
    } catch (error) {
      res.status(502).json({ error: message(error) });
    }
  });

  app.patch("/api/sources/:driveId", async (req, res) => {
    const kind = req.body?.kind as SourceKind | undefined;
    if (!kind || !(kind in sourceKindLabels)) {
      res.status(400).json({ error: "Unknown source kind." });
      return;
    }
    const state = await updateState((current) => {
      const source = current.sources.find((entry) => entry.driveId === req.params.driveId);
      if (source) {
        source.kind = kind;
        source.confirmedByUser = true;
        source.confidence = 1;
        source.reasons = ["confirmed by the author"];
      }
    });
    res.json(withDerived(state));
  });

  app.post("/api/sources/confirm-all", async (_req, res) => {
    const state = await updateState((current) => {
      for (const source of current.sources) source.confirmedByUser = true;
    });
    res.json(withDerived(state));
  });

  // --- Style corpus ---------------------------------------------------------
  /**
   * Build the exemplar corpus from documents grouped as past series books.
   *
   * Only `past_book` sources are used. Reference books by other authors are
   * deliberately excluded: their prose would pull the fingerprint towards
   * someone else's voice, which is the precise failure this system exists to
   * prevent.
   */
  app.post("/api/style/build", async (_req, res) => {
    const state = await loadState();
    const pastBooks = state.sources.filter((source) => source.kind === "past_book");

    if (pastBooks.length === 0) {
      res.status(400).json({
        error:
          "No sources are grouped as 'Past series book'. The style corpus is built only from your own prose, so at least one is required."
      });
      return;
    }

    const documents: CorpusDocument[] = [];
    for (const source of pastBooks) {
      const text = await readCachedDocument(source.driveId);
      if (text) documents.push({ source: source.name, text });
    }

    const corpus = buildCorpus(state.projectName, documents);
    await writeArtifact("style-corpus.json", JSON.stringify(corpus, null, 2));
    await writeArtifact("style-fingerprint.md", renderFingerprint(corpus.label, corpus.fingerprint, corpus.passages.length));

    const next = await updateState((current) => {
      current.styleCorpus = {
        built: true,
        label: corpus.label,
        passageCount: corpus.passages.length,
        wordCount: corpus.fingerprint.wordCount,
        builtAt: corpus.builtAt
      };
    });

    res.json({ ...withDerived(next), fingerprint: corpus.fingerprint });
  });

  app.get("/api/style/fingerprint", async (_req, res) => {
    const corpus = await readCorpus();
    if (!corpus) {
      res.status(404).json({ error: "No style corpus built yet." });
      return;
    }
    res.json({ label: corpus.label, fingerprint: corpus.fingerprint, passageCount: corpus.passages.length });
  });

  /** Score arbitrary text against the corpus -- used by the UI's live check. */
  app.post("/api/style/score", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const corpus = await readCorpus();
    if (!corpus) {
      res.status(400).json({ error: "Build the style corpus first." });
      return;
    }
    res.json(scoreAgainstFingerprint(text, corpus.fingerprint));
  });

  // --- Questions ------------------------------------------------------------
  app.get("/api/questions", async (_req, res) => {
    const state = await loadState();
    res.json({ questions: state.questions, blocking: blockingQuestions(state) });
  });

  /** Agents POST here when they need the author to decide something. */
  app.post("/api/questions", async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.question !== "string" || !body.question.trim()) {
      res.status(400).json({ error: "A question is required." });
      return;
    }
    const question: OpenQuestion = {
      id: randomUUID(),
      phase: body.phase ?? "intake",
      askedBy: typeof body.askedBy === "string" ? body.askedBy : "agent",
      question: body.question.trim(),
      rationale: typeof body.rationale === "string" ? body.rationale : undefined,
      options: Array.isArray(body.options) ? body.options.map(String).slice(0, 8) : undefined,
      allowFreeText: body.allowFreeText !== false,
      askedAt: new Date().toISOString(),
      blocking: body.blocking === true
    };
    const state = await updateState((current) => {
      current.questions.push(question);
    });
    res.status(201).json({ question, state: withDerived(state) });
  });

  app.post("/api/questions/:id/answer", async (req, res) => {
    const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (!answer) {
      res.status(400).json({ error: "An answer is required." });
      return;
    }
    const state = await updateState((current) => {
      const question = current.questions.find((entry) => entry.id === req.params.id);
      if (question) {
        question.answer = answer;
        question.answeredAt = new Date().toISOString();
      }
    });
    res.json(withDerived(state));
  });

  // --- Chapters -------------------------------------------------------------
  app.put("/api/chapters", async (req, res) => {
    const raw: unknown = req.body?.chapters;
    if (!Array.isArray(raw)) {
      res.status(400).json({ error: "chapters must be an array." });
      return;
    }
    const chapters = raw.map((entry, index) => ({
      number: Number((entry as Record<string, unknown>).number ?? index + 1),
      title: String((entry as Record<string, unknown>).title ?? `Chapter ${index + 1}`),
      synopsis: String((entry as Record<string, unknown>).synopsis ?? ""),
      status: "planned" as const,
      issues: [] as string[]
    }));

    const state = await updateState((current) => {
      current.chapters = chapters;
      current.ledger.plannedChapters = chapters.length;
    });
    res.json(withDerived(state));
  });

  /** The opening contract for a chapter, straight from the continuity ledger. */
  app.get("/api/chapters/:number/brief", async (req, res) => {
    const state = await loadState();
    const number = Number(req.params.number);
    res.type("text/markdown").send(buildOpeningBrief(state.ledger, number));
  });

  /**
   * Validate a drafted chapter: style fidelity plus chapter-to-chapter flow.
   * This is the gate the old pipeline had no code for.
   */
  app.post("/api/chapters/:number/validate", async (req, res) => {
    const number = Number(req.params.number);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      res.status(400).json({ error: "Chapter text is required." });
      return;
    }

    const state = await loadState();
    const corpus = await readCorpus();
    const style = corpus ? scoreAgainstFingerprint(text, corpus.fingerprint) : null;
    const flow = validateFlow(state.ledger, number, text, req.body?.handoff);

    const next = await updateState((current) => {
      const chapter = current.chapters.find((entry) => entry.number === number);
      if (chapter) {
        chapter.status = style?.verdict === "pass" && flow.verdict === "pass" ? "validated" : "needs_work";
        chapter.wordCount = computeMetrics(text).wordCount;
        chapter.styleFidelity = style?.fidelity;
        chapter.flowVerdict = flow.verdict;
        chapter.issues = [
          ...flow.issues.map((issue) => issue.message),
          ...(style?.instructions ?? [])
        ].slice(0, 20);
        chapter.updatedAt = new Date().toISOString();
      }
    });

    res.json({ style, flow, state: withDerived(next) });
  });

  app.post("/api/chapters/:number/status", async (req, res) => {
    const status = req.body?.status;
    const allowed = ["planned", "drafting", "drafted", "editing", "validated", "approved", "needs_work"];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: "Unknown chapter status." });
      return;
    }
    const state = await updateState((current) => {
      const chapter = current.chapters.find((entry) => entry.number === Number(req.params.number));
      if (chapter) {
        chapter.status = status;
        chapter.updatedAt = new Date().toISOString();
      }
    });
    res.json(withDerived(state));
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return app;
}

export function startStudio(options: StudioServerOptions = {}) {
  const port = options.port ?? Number(process.env.CANON_QUILL_STUDIO_PORT ?? 4180);
  // Loopback only: this surface exposes the author's manuscript and Drive
  // contents and must never be reachable from the network.
  const host = options.host ?? "127.0.0.1";
  const app = createStudioApp();
  return app.listen(port, host, () => {
    console.log(`Canon Quill Studio → http://${host}:${port}`);
  });
}

// --- helpers ----------------------------------------------------------------

function withDerived(state: StudioState) {
  return { ...state, phase: derivePhase(state), blocking: blockingQuestions(state).length };
}

function flatten(nodes: Array<{ children?: unknown[] }>): Array<{
  id: string;
  name: string;
  path: string;
  mimeType: string;
  isFolder: boolean;
}> {
  const output: Array<{ id: string; name: string; path: string; mimeType: string; isFolder: boolean }> = [];
  const walk = (list: unknown[]) => {
    for (const entry of list) {
      const node = entry as { id: string; name: string; path: string; mimeType: string; isFolder: boolean; children?: unknown[] };
      output.push({ id: node.id, name: node.name, path: node.path, mimeType: node.mimeType, isFolder: node.isFolder });
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return output;
}

/** Mime types we can turn into text. */
function isReadable(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/vnd.google-apps.document" ||
    mimeType === "application/rtf" ||
    mimeType === "application/json"
  );
}

const cacheDir = () => path.join(projectPaths.workspace, "drive-cache");

async function cacheDocuments(documents: Array<{ id: string; name: string; text: string }>): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(cacheDir(), { recursive: true });
  await Promise.all(
    documents.map((document) =>
      writeFile(path.join(cacheDir(), `${document.id}.json`), JSON.stringify(document), "utf8")
    )
  );
}

async function readCachedDocument(driveId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(cacheDir(), `${driveId}.json`), "utf8");
    return (JSON.parse(raw) as { text: string }).text;
  } catch {
    return undefined;
  }
}

async function writeArtifact(name: string, content: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(projectPaths.artifacts, { recursive: true });
  await writeFile(path.join(projectPaths.artifacts, name), content, "utf8");
}

async function readCorpus() {
  try {
    const raw = await readFile(path.join(projectPaths.artifacts, "style-corpus.json"), "utf8");
    return JSON.parse(raw) as import("../style/corpus.js").StyleCorpus;
  } catch {
    return undefined;
  }
}

function renderFingerprint(label: string, fingerprint: ReturnType<typeof computeMetrics>, passages: number): string {
  return [
    `# Style Fingerprint — ${label}`,
    "",
    `Built from ${passages} passages, ${fingerprint.wordCount.toLocaleString()} words of the author's own prose.`,
    "",
    "These are targets, not rules. Drafts are compared against them by",
    "`src/style/score.ts`; deviation is measured against *this author*, never",
    "against a generic idea of good writing.",
    "",
    "| Measure | Target |",
    "|---|---:|",
    `| Mean sentence length | ${fingerprint.sentence.meanWords} words |`,
    `| Sentence length variation | ${fingerprint.sentence.stdevWords} |`,
    `| Fragment rate | ${pct(fingerprint.sentence.fragmentRate)} |`,
    `| Long-sentence rate | ${pct(fingerprint.sentence.longRate)} |`,
    `| Mean paragraph length | ${fingerprint.paragraph.meanWords} words |`,
    `| Single-sentence paragraphs | ${pct(fingerprint.paragraph.singleSentenceRate)} |`,
    `| Dialogue share | ${pct(fingerprint.dialogue.wordShare)} |`,
    `| Mean dialogue line | ${fingerprint.dialogue.meanLineWords} words |`,
    `| Plain dialogue tags | ${pct(fingerprint.dialogue.invisibleTagShare)} |`,
    `| Ornate tags / 1k words | ${fingerprint.dialogue.ornateTagsPer1k} |`,
    `| -ly adverbs / 1k | ${fingerprint.texture.lyAdverbsPer1k} |`,
    `| Filter verbs / 1k | ${fingerprint.texture.filterVerbsPer1k} |`,
    `| Abstract nouns / 1k | ${fingerprint.texture.abstractNounsPer1k} |`,
    `| Similes / 1k | ${fingerprint.texture.similesPer1k} |`,
    `| Contractions / 1k | ${fingerprint.texture.contractionsPer1k} |`,
    `| Em dashes / 1k | ${fingerprint.texture.emDashesPer1k} |`,
    `| Vocabulary variety | ${fingerprint.texture.typeTokenRatio} |`,
    ""
  ].join("\n");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Start when executed directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startStudio();
}
