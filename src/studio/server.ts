import express from "express";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { SafeDriveClient } from "../drive/client.js";
import { beginDriveAuthorization, driveAuthStatus } from "../drive/auth.js";
import { extractDriveId } from "../drive/id.js";
import { classifySource, sourceKindCounts, sourceKindLabels, sourceKindPurpose, type SourceKind } from "../analysis/classify.js";
import { analyseManuscript, renderContinuationBrief } from "../analysis/manuscript.js";
import { detectNarration, narrationOptions, povLabel, povOptions, tenseLabel, tenseOptions } from "../style/narration.js";
import { analyseWriting, type WritingProfile } from "../style/profile.js";
import { buildCorpus, type CorpusDocument, type StyleCorpus, type BeatType } from "../style/corpus.js";
import { scoreAgainstFingerprint } from "../style/score.js";
import { computeMetrics, type StyleMetrics } from "../style/metrics.js";
import { renderExemplarPrompt, retrieveExemplars } from "../style/retrieve.js";
import { buildOpeningBrief, validateFlow } from "../continuity/flow.js";
import {
  blockingQuestions,
  derivePhase,
  emptyState,
  loadState,
  saveState,
  updateState,
  type OpenQuestion,
  type SelectedSource,
  type StudioState
} from "./state.js";
import {
  activeSlug,
  createProject,
  deleteProject,
  finishProject,
  listProjects,
  setActiveProject,
  touchProject
} from "../workspace/registry.js";
import { workspacePaths } from "../workspace/paths.js";
import { appendLog } from "../project/logs.js";
import { checkCredentials, defaultModels, loadCatalog, type ProviderId } from "./engine.js";
import { applyUpdate, getVersionInfo } from "./updates.js";
import { deleteApiKey, maskKey, readApiKey, saveApiKey, verifyApiKey } from "./credentials.js";
import { loadDotEnv } from "../config/env.js";

// Read .env before anything looks at process.env.
loadDotEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();

export interface StudioServerOptions {
  port?: number;
  host?: string;
}

export function createStudioApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const drive = new SafeDriveClient();

  /** Resolve the workspace a request applies to, or fail with a clear message. */
  async function requireSlug(): Promise<string> {
    const slug = await activeSlug();
    if (!slug) throw new HttpError(409, "No book selected. Create one first.");
    return slug;
  }

  const route = (handler: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response) => {
      handler(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        res.status(status).json({ error: message(error) });
      });
    };

  // --- UI -------------------------------------------------------------------
  app.get("/", route(async (_req, res) => {
    // The UI is one self-contained file, so there is no bundler step between
    // editing it and running it.
    for (const candidate of [path.join(here, "ui.html"), path.join(here, "../../src/studio/ui.html")]) {
      try {
        res.type("html").send(await readFile(candidate, "utf8"));
        return;
      } catch {
        continue;
      }
    }
    res.status(500).type("text").send("Studio UI not found. Run npm run build.");
  }));

  app.get("/api/version", route(async (req, res) => {
    // Checking the remote costs a network round trip, so the UI asks for it
    // only when it opens the panel or on a slow timer.
    res.json(await getVersionInfo(req.query.remote === "1"));
  }));

  app.post("/api/version/update", route(async (_req, res) => {
    res.json(await applyUpdate());
  }));

  /**
   * Restart into the updated code.
   *
   * The process cannot reload its own modules, so it spawns a replacement and
   * exits. Two things make that harder than it looks. The Studio is normally
   * run through tsx, so re-spawning `node server.ts` starts a process that
   * cannot parse TypeScript and dies immediately; the loader flags in
   * `execArgv` have to be carried across. And the replacement cannot bind the
   * port until this process has released it, so it retries rather than racing.
   */
  app.post("/api/version/restart", route(async (_req, res) => {
    const command = process.execPath;
    const args = [...process.execArgv, process.argv[1], ...process.argv.slice(2)];

    let child;
    try {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: { ...process.env, CANON_QUILL_NO_OPEN: "1", CANON_QUILL_RESTARTING: "1" },
        detached: true,
        // Inherited so a failure to start is visible in the terminal the author
        // is already looking at, rather than disappearing into /dev/null.
        stdio: "inherit"
      });
    } catch (error) {
      throw new HttpError(500, `Could not start a replacement process: ${message(error)}`);
    }

    // If it dies immediately, the old process should stay up rather than
    // leaving nothing listening at all.
    let died = false;
    child.once("error", () => (died = true));
    child.once("exit", () => (died = true));

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (died) {
      throw new HttpError(500, "The replacement process exited immediately. Restart the Studio by hand and check the terminal.");
    }

    child.unref();
    res.json({ restarting: true, pid: child.pid });
    // Released only after the reply is on the wire, so the client learns the
    // restart began rather than seeing a dropped connection.
    setTimeout(() => process.exit(0), 300);
  }));

  // --- Projects -------------------------------------------------------------
  app.get("/api/projects", route(async (_req, res) => {
    res.json({ projects: await listProjects(), activeSlug: await activeSlug() });
  }));

  app.post("/api/projects", route(async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title : "";
    const project = await createProject(title);
    await saveState(emptyState(project.slug, project.title));
    await appendLog(project.slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "setup",
      stageName: "Setup",
      agent: "studio",
      event: "project_created",
      data: { slug: project.slug, title: project.title }
    });
    res.status(201).json({ project, state: withDerived(await loadState(project.slug)) });
  }));

  app.post("/api/projects/:slug/activate", route(async (req, res) => {
    await setActiveProject(req.params.slug);
    res.json({ state: withDerived(await loadState(req.params.slug)) });
  }));

  app.post("/api/projects/:slug/finish", route(async (req, res) => {
    await finishProject(req.params.slug);
    res.json({ projects: await listProjects() });
  }));

  app.delete("/api/projects/:slug", route(async (req, res) => {
    await deleteProject(req.params.slug);
    res.json({ projects: await listProjects(), activeSlug: await activeSlug() });
  }));

  // --- State ----------------------------------------------------------------
  app.get("/api/state", route(async (_req, res) => {
    const slug = await activeSlug();
    if (!slug) {
      res.json({ state: null, projects: await listProjects(), kinds: sourceKindLabels, kindCounts: sourceKindCounts, kindPurpose: sourceKindPurpose, narrationOptions, povOptions, tenseOptions });
      return;
    }
    res.json({
      state: withDerived(await loadState(slug)),
      projects: await listProjects(),
      // Sent with the state so the client never keeps its own copy to drift.
      kinds: sourceKindLabels,
      kindCounts: sourceKindCounts,
      kindPurpose: sourceKindPurpose,
      narrationOptions,
      povOptions,
      tenseOptions
    });
  }));

  app.patch("/api/project", route(async (req, res) => {
    const slug = await requireSlug();
    const { projectName, shape, draftingMode, intake } = req.body ?? {};
    const state = await updateState(slug, (current) => ({
      ...current,
      projectName: typeof projectName === "string" && projectName.trim() ? projectName.trim() : current.projectName,
      shape: shape === "standalone" || shape === "series" ? shape : current.shape,
      draftingMode:
        draftingMode === "chapter_by_chapter" || draftingMode === "whole_book" ? draftingMode : current.draftingMode,
      intake: intake && typeof intake === "object" ? { ...current.intake, ...intake } : current.intake
    }));
    if (typeof projectName === "string" && projectName.trim()) {
      await touchProject(slug, { title: projectName.trim() });
    }
    res.json(withDerived(state));
  }));

  // --- Engine (provider, auth, models) --------------------------------------
  app.get("/api/engine", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const catalog = await loadCatalog();
    const provider = state.engine.provider;

    const storedKey = provider ? await readApiKey(provider) : undefined;

    res.json({
      choice: state.engine,
      catalog,
      resolvedModels: provider
        ? { ...defaultModels(catalog, provider), ...state.engine.models }
        : {},
      credentials:
        provider && state.engine.authMethod
          ? await checkCredentials(provider, state.engine.authMethod)
          : null,
      // A mask only. The key never leaves the server.
      storedKey: storedKey ? maskKey(storedKey) : null
    });
  }));

  app.patch("/api/engine", route(async (req, res) => {
    const slug = await requireSlug();
    const { provider, authMethod, models } = req.body ?? {};

    if (provider !== undefined && provider !== "anthropic" && provider !== "openai") {
      throw new HttpError(400, "Provider must be anthropic or openai.");
    }
    if (authMethod !== undefined && authMethod !== "subscription" && authMethod !== "api_key") {
      throw new HttpError(400, "Auth method must be subscription or api_key.");
    }
    // Keys go to /api/engine/key, which stores them outside the project state.
    for (const key of Object.keys(req.body ?? {})) {
      if (/key|token|secret|password/i.test(key) && key !== "authMethod") {
        throw new HttpError(400, "Send API keys to /api/engine/key, not here.");
      }
    }

    const state = await updateState(slug, (current) => {
      if (provider !== undefined) {
        current.engine.provider = provider;
        // Model overrides belong to a provider; drop them when it changes.
        current.engine.models = {};
      }
      if (authMethod !== undefined) current.engine.authMethod = authMethod;
      if (models && typeof models === "object") {
        current.engine.models = { ...current.engine.models, ...models };
      }
    });

    const catalog = await loadCatalog();
    res.json({
      choice: state.engine,
      resolvedModels: state.engine.provider
        ? { ...defaultModels(catalog, state.engine.provider), ...state.engine.models }
        : {},
      credentials:
        state.engine.provider && state.engine.authMethod
          ? await checkCredentials(state.engine.provider, state.engine.authMethod)
          : null
    });
  }));

  /** Store a key. The response carries a mask, never the key itself. */
  app.post("/api/engine/key", route(async (req, res) => {
    const provider = req.body?.provider as ProviderId | undefined;
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (provider !== "anthropic" && provider !== "openai") throw new HttpError(400, "Unknown provider.");
    if (!key) throw new HttpError(400, "A key is required.");

    const verification = await verifyApiKey(provider, key);
    // Stored either way: a network failure during verification should not lose
    // a key the author just pasted.
    await saveApiKey(provider, key);
    res.json({ saved: true, masked: maskKey(key), verification });
  }));

  app.post("/api/engine/key/verify", route(async (req, res) => {
    const provider = req.body?.provider as ProviderId | undefined;
    if (provider !== "anthropic" && provider !== "openai") throw new HttpError(400, "Unknown provider.");

    const key = (typeof req.body?.key === "string" && req.body.key.trim())
      || (await readApiKey(provider))
      || process.env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];
    if (!key) throw new HttpError(400, "No key stored or supplied for this provider.");

    res.json(await verifyApiKey(provider, key));
  }));

  app.delete("/api/engine/key/:provider", route(async (req, res) => {
    const provider = req.params.provider as ProviderId;
    if (provider !== "anthropic" && provider !== "openai") throw new HttpError(400, "Unknown provider.");
    await deleteApiKey(provider);
    res.json({ removed: true });
  }));

  // --- Drive ----------------------------------------------------------------
  /**
   * Non-interactive. Never opens a browser and never blocks on the user, which
   * is what made this endpoint hang for minutes before.
   */
  app.get("/api/drive/status", route(async (_req, res) => {
    const status = await driveAuthStatus();
    const slug = await activeSlug();
    if (slug) {
      await updateState(slug, (current) => void (current.drive.connected = status.authorized));
    }
    res.json({
      connected: status.authorized,
      configured: status.configured,
      canBrowse: status.canBrowse ?? false,
      needsReauthorization: status.needsReauthorization ?? false,
      reason: status.detail,
      // What the UI should offer next.
      next: status.configured ? (status.authorized ? "ready" : "connect") : "configure"
    });
  }));

  /** Start authorization and hand back the consent URL straight away. */
  app.post("/api/drive/connect", route(async (_req, res) => {
    const pending = await beginDriveAuthorization();
    pending.completed
      .then(async () => {
        const slug = await activeSlug();
        if (slug) await updateState(slug, (current) => void (current.drive.connected = true));
      })
      .catch(() => undefined);
    res.json({ url: pending.url });
  }));

  app.get("/api/drive/browse", route(async (req, res) => {
    const folderId = typeof req.query.folderId === "string" && req.query.folderId ? req.query.folderId : "root";
    const entries = await drive.listFolder(folderId);
    const status = await driveAuthStatus();

    res.json({
      folderId,
      canBrowse: status.canBrowse ?? false,
      // An empty result under a narrow grant is not an empty folder.
      emptyBecauseScope: entries.length === 0 && !status.canBrowse,
      entries: entries.map((entry) => ({
        ...entry,
        isFolder: entry.mimeType === "application/vnd.google-apps.folder"
      }))
    });
  }));

  app.post("/api/drive/roots", route(async (req, res) => {
    const slug = await requireSlug();
    const raw: unknown = req.body?.roots;
    const roots = Array.isArray(raw)
      ? raw.map((value) => extractDriveId(String(value))).filter((id): id is string => Boolean(id))
      : [];
    const target = req.body?.targetFolderId ? extractDriveId(String(req.body.targetFolderId)) : null;

    const state = await updateState(slug, (current) => {
      current.drive.referenceRoots = roots;
      if (target) current.drive.targetFolderId = target;
    });
    res.json(withDerived(state));
  }));

  app.post("/api/sources/index", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    if (state.drive.referenceRoots.length === 0) {
      throw new HttpError(400, "Select at least one reference folder or file first.");
    }
    if (!state.drive.targetFolderId) {
      throw new HttpError(400, "Choose a target folder. Finished chapters have to go somewhere, and picking it now avoids discovering the gap after the book is written.");
    }

    const found: Array<{ source: SelectedSource; text: string }> = [];

    for (const root of state.drive.referenceRoots) {
      // A root may be a single file the author picked directly.
      const meta = await drive.getMetadata(root).catch(() => undefined);
      const nodes =
        meta && meta.mimeType !== "application/vnd.google-apps.folder"
          ? [{ id: meta.id, name: meta.name, path: `/${meta.name}`, mimeType: meta.mimeType, isFolder: false }]
          : flatten(await drive.walkFolder(root, { maxDepth: 6, maxFiles: 400 }));

      for (const node of nodes) {
        if (node.isFolder || !isReadable(node.mimeType)) continue;
        let text = "";
        try {
          text = await drive.readFileText(node.id);
        } catch {
          continue;
        }
        const classification = classifySource({ name: node.name, path: node.path, text });
        found.push({
          source: {
            driveId: node.id,
            name: node.name,
            path: node.path,
            mimeType: node.mimeType,
            isFolder: false,
            // Your own past book is both the style corpus and canon material,
            // so it starts in both groups rather than making you add the
            // second one by hand on every book you have ever written.
            kinds:
              classification.kind === "past_book"
                ? ["past_book", "reference_book"]
                : [classification.kind],
            wordCount: computeMetrics(text).wordCount,
            classification
          },
          text
        });
      }
    }

    // Cached so building the corpus later does not refetch every document.
    const cache = workspacePaths(slug).driveCache;
    await mkdir(cache, { recursive: true });
    await Promise.all(
      found.map((entry) =>
        writeFile(path.join(cache, `${entry.source.driveId}.json`), JSON.stringify({ text: entry.text }), "utf8")
      )
    );

    const next = await updateState(slug, (current) => {
      current.sources = found.map((entry) => entry.source);
      current.sourcesReviewed = false;
      current.drive.lastIndexedAt = new Date().toISOString();
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
    });

    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "source_analysis",
      stageName: "Source analysis",
      agent: "studio",
      event: "sources_indexed",
      data: { count: found.length }
    });

    res.json(withDerived(next));
  }));

  app.patch("/api/sources/:driveId", route(async (req, res) => {
    const slug = await requireSlug();
    const raw: unknown = req.body?.kinds;
    if (!Array.isArray(raw)) throw new HttpError(400, "kinds must be an array.");

    const kinds = [...new Set(raw.map(String))] as SourceKind[];
    for (const kind of kinds) {
      if (!(kind in sourceKindLabels)) throw new HttpError(400, `Unknown source kind: ${kind}`);
    }

    const state = await updateState(slug, (current) => {
      const source = current.sources.find((entry) => entry.driveId === req.params.driveId);
      // An empty list is allowed: it means "ignore this document".
      if (source) {
        source.kinds = kinds;
        current.styleCorpus.built = false;
        current.styleCorpus.continuedAt = null;
      }
    });
    res.json(withDerived(state));
  }));

  /**
   * Drop a document from the analysis.
   *
   * Different from clearing its groups: an ungrouped document stays on the
   * board so it can be classified later, whereas a removed one is gone until
   * the next analysis. Nothing in Drive is touched.
   */
  app.delete("/api/sources/:driveId", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.sources = current.sources.filter((entry) => entry.driveId !== req.params.driveId);
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
    });
    res.json(withDerived(state));
  }));

  app.post("/api/sources/reviewed", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const check = sourcesCheck(state.sources);
    if (!check.ok) {
      throw new HttpError(400, [check.style.reason, check.references.reason].filter(Boolean).join(" "));
    }
    res.json(withDerived(await updateState(slug, (current) => void (current.sourcesReviewed = true))));
  }));

  app.get("/api/sources/check", route(async (_req, res) => {
    const state = await loadState(await requireSlug());
    res.json(sourcesCheck(state.sources));
  }));

  // --- Style ----------------------------------------------------------------
  app.post("/api/style/build", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const own = state.sources.filter((source) => source.kinds.includes("past_book"));
    const reference = state.sources.filter((source) => source.kinds.includes("reference_book"));

    // Someone else's prose is a valid style target when the author has none of
    // their own yet, but it is a different thing and has to be asked for.
    const useReference = req.body?.useReference === true;
    const chosen = own.length > 0 ? own : useReference ? reference : [];

    if (chosen.length === 0) {
      throw new HttpError(
        400,
        reference.length > 0
          ? "Nothing is marked as your writing. You can build the corpus from your reference writing instead, but the book will read like whoever wrote it rather than like you."
          : "Nothing is marked as your writing or your reference writing, so there is no prose to learn from. Group at least one document on the previous screen."
      );
    }
    if (!state.sourcesReviewed) {
      throw new HttpError(400, "Review the source grouping before building the style corpus.");
    }
    const sourceCheck = sourcesCheck(state.sources);
    if (!sourceCheck.ok) {
      throw new HttpError(400, [sourceCheck.style.reason, sourceCheck.references.reason].filter(Boolean).join(" "));
    }

    const documents: CorpusDocument[] = [];
    for (const source of chosen) {
      const text = await readCached(slug, source.driveId);
      if (text) documents.push({ source: source.name, text });
    }

    const corpus = buildCorpus(state.projectName, documents);
    const paths = workspacePaths(slug);
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(path.join(paths.artifacts, "style-corpus.json"), JSON.stringify(corpus, null, 2), "utf8");
    await writeFile(
      path.join(paths.artifacts, "style-fingerprint.md"),
      renderFingerprint(corpus.label, corpus.fingerprint, corpus.passages.length, corpus.profile),
      "utf8"
    );

    const next = await updateState(slug, (current) => {
      current.styleCorpus = {
        built: true,
        label: corpus.label,
        passageCount: corpus.passages.length,
        wordCount: corpus.fingerprint.wordCount,
        builtAt: corpus.builtAt,
        continuedAt: null,
        fromReference: own.length === 0
      };
    });

    res.json({ ...withDerived(next), fingerprint: corpus.fingerprint, fromReference: own.length === 0 });
  }));

  app.post("/api/style/continue", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    if (!state.styleCorpus.built) throw new HttpError(400, "Build the style corpus first.");
    const next = await updateState(slug, (current) => {
      current.styleCorpus.continuedAt ??= new Date().toISOString();
    });
    res.json(withDerived(next));
  }));

  app.get("/api/style/fingerprint", route(async (_req, res) => {
    const corpus = await readCorpus(await requireSlug());
    if (!corpus) throw new HttpError(404, "No style corpus built yet.");
    res.json({ label: corpus.label, fingerprint: corpus.fingerprint, profile: corpus.profile, passageCount: corpus.passages.length });
  }));

  app.post("/api/style/score", route(async (req, res) => {
    const corpus = await readCorpus(await requireSlug());
    if (!corpus) throw new HttpError(400, "Build the style corpus first.");
    res.json(scoreAgainstFingerprint(typeof req.body?.text === "string" ? req.body.text : "", corpus.fingerprint));
  }));

  /**
   * Retrieve exemplar passages for a scene and render them as a prompt block.
   * This is what the drafting agent calls before writing, so the model sees the
   * author's actual paragraphs for the beat rather than a description of them.
   */
  app.post("/api/style/exemplars", route(async (req, res) => {
    const corpus = await readCorpus(await requireSlug());
    if (!corpus) throw new HttpError(400, "Build the style corpus first.");

    const beat = (req.body?.beat ?? "dialogue") as BeatType;
    const valid: BeatType[] = ["dialogue", "action", "interiority", "description", "transition"];
    if (!valid.includes(beat)) throw new HttpError(400, `Unknown beat "${beat}".`);

    const brief = {
      beat,
      characters: Array.isArray(req.body?.characters) ? req.body.characters.map(String) : undefined,
      summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
      register: typeof req.body?.register === "string" ? req.body.register : undefined
    };
    const exemplars = retrieveExemplars(corpus, brief, {
      limit: Number(req.body?.limit) || 4,
      maxWords: Number(req.body?.maxWords) || 1200
    });

    res.json({
      brief,
      prompt: renderExemplarPrompt(exemplars, brief),
      exemplars: exemplars.map((entry) => ({
        source: entry.passage.source,
        beat: entry.passage.beat,
        wordCount: entry.passage.wordCount,
        score: entry.score,
        reasons: entry.reasons,
        text: entry.passage.text
      }))
    });
  }));

  // --- Questions ------------------------------------------------------------
  app.get("/api/questions", route(async (_req, res) => {
    const state = await loadState(await requireSlug());
    res.json({ questions: state.questions, conversation: state.conversation, blocking: blockingQuestions(state) });
  }));

  app.post("/api/questions", route(async (req, res) => {
    const slug = await requireSlug();
    const body = req.body ?? {};
    if (typeof body.question !== "string" || !body.question.trim()) {
      throw new HttpError(400, "A question is required.");
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
    const state = await updateState(slug, (current) => {
      current.questions.push(question);
      current.conversation.push({
        id: randomUUID(),
        role: "agent",
        text: question.question,
        questionId: question.id,
        phase: question.phase,
        createdAt: question.askedAt
      });
    });
    res.status(201).json({ question, state: withDerived(state) });
  }));

  app.post("/api/questions/:id/answer", route(async (req, res) => {
    const slug = await requireSlug();
    const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (!answer) throw new HttpError(400, "An answer is required.");

    const state = await updateState(slug, (current) => {
      const question = current.questions.find((entry) => entry.id === req.params.id);
      if (!question) throw new HttpError(404, "Question not found.");
      question.answer = answer;
      question.answeredAt = new Date().toISOString();
      current.conversation.push({
        id: randomUUID(),
        role: "author",
        text: answer,
        questionId: question.id,
        phase: question.phase,
        createdAt: question.answeredAt
      });
    });
    res.json(withDerived(state));
  }));

  app.post("/api/conversation", route(async (req, res) => {
    const slug = await requireSlug();
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new HttpError(400, "A message is required.");
    if (text.length > 8000) throw new HttpError(400, "Keep the message under 8,000 characters.");
    const state = await updateState(slug, (current) => {
      current.conversation.push({
        id: randomUUID(),
        role: "author",
        text,
        phase: "intake",
        createdAt: new Date().toISOString()
      });
    });
    res.status(201).json(withDerived(state));
  }));

  // --- Chapters -------------------------------------------------------------
  app.put("/api/chapters", route(async (req, res) => {
    const slug = await requireSlug();
    const raw: unknown = req.body?.chapters;
    if (!Array.isArray(raw)) throw new HttpError(400, "chapters must be an array.");

    const chapters = raw.map((entry, index) => {
      const record = entry as Record<string, unknown>;
      return {
        number: Number(record.number ?? index + 1),
        title: String(record.title ?? `Chapter ${index + 1}`),
        synopsis: String(record.synopsis ?? ""),
        status: "planned" as const,
        issues: [] as string[]
      };
    });

    const state = await updateState(slug, (current) => {
      current.chapters = chapters;
      current.ledger.plannedChapters = chapters.length;
    });
    res.json(withDerived(state));
  }));

  app.get("/api/chapters/:number/brief", route(async (req, res) => {
    const state = await loadState(await requireSlug());
    res.type("text/markdown").send(buildOpeningBrief(state.ledger, Number(req.params.number)));
  }));

  app.post("/api/chapters/:number/validate", route(async (req, res) => {
    const slug = await requireSlug();
    const number = Number(req.params.number);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) throw new HttpError(400, "Chapter text is required.");

    const state = await loadState(slug);
    const corpus = await readCorpus(slug);
    const style = corpus ? scoreAgainstFingerprint(text, corpus.fingerprint) : null;
    const flow = validateFlow(state.ledger, number, text, req.body?.handoff);

    const next = await updateState(slug, (current) => {
      const chapter = current.chapters.find((entry) => entry.number === number);
      if (chapter) {
        chapter.status = style?.verdict === "pass" && flow.verdict === "pass" ? "validated" : "needs_work";
        chapter.wordCount = computeMetrics(text).wordCount;
        chapter.styleFidelity = style?.fidelity;
        chapter.flowVerdict = flow.verdict;
        chapter.issues = [...flow.issues.map((issue) => issue.message), ...(style?.instructions ?? [])].slice(0, 20);
        chapter.updatedAt = new Date().toISOString();
      }
    });

    res.json({ style, flow, state: withDerived(next) });
  }));

  /**
   * What the indexed material already implies, offered as prefills.
   *
   * Asking an author to type out the POV and tense of books that are sitting
   * indexed is asking for something already known.
   */
  app.get("/api/intake/suggestions", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);

    const own = state.sources.filter((source) => source.kinds?.includes("past_book"));
    const suggestions: Record<string, { value: string; because: string; confidence?: number }> = {};

    // More than one book by this author reads as a series.
    if (own.length > 1) {
      suggestions.shape = {
        value: "series",
        because: `${own.length} of your own books are indexed, which reads as a series.`,
        confidence: 0.92
      };
    } else if (own.length === 1) {
      suggestions.shape = { value: "standalone", because: "One book of yours is indexed.", confidence: 0.72 };
    }

    const corpus = await readCorpus(slug);
    const sample = corpus
      ? corpus.passages.slice(0, 400).map((passage) => passage.text).join("\n\n")
      : (await Promise.all(own.slice(0, 2).map((source) => readCached(slug, source.driveId))))
          .filter(Boolean).join("\n\n").slice(0, 200_000);

    if (sample && sample.length > 500) {
      const profile = corpus?.profile ?? analyseWriting(sample);
      const narration = detectNarration(sample);
      if (narration.povConfidence > 0.5) {
        suggestions.pov = {
          value: povLabel(narration.pov),
          because: `Measured from your own prose: ${povLabel(narration.pov)} POV.`,
          confidence: narration.povConfidence
        };
      }
      if (narration.tenseConfidence > 0.5) {
        suggestions.tense = {
          value: tenseLabel(narration.tense),
          because: `Measured from your own prose: ${tenseLabel(narration.tense)} tense.`,
          confidence: narration.tenseConfidence
        };
      }
      if (profile.audience.values.length > 0) {
        suggestions.audience = {
          value: profile.audience.values.join("|"),
          because: profile.audience.evidence.join("; "),
          confidence: profile.audience.confidence
        };
      }
      if (profile.intimacy.value !== "None") {
        suggestions.spice = {
          value: profile.intimacy.value,
          because: profile.intimacy.evidence.join("; "),
          confidence: profile.intimacy.confidence
        };
      }
    }

    res.json({ suggestions, projectName: state.projectName });
  }));

  // --- An existing draft ------------------------------------------------------
  /** Read a part-written book and report where it stands. */
  app.post("/api/manuscript/analyse", route(async (req, res) => {
    const slug = await requireSlug();
    const driveId = typeof req.body?.driveId === "string" ? extractDriveId(req.body.driveId) : null;
    if (!driveId) throw new HttpError(400, "A Drive file is required.");

    const meta = await drive.getMetadata(driveId);
    if (meta.mimeType === "application/vnd.google-apps.folder") {
      throw new HttpError(400, "That is a folder. Pick the document the book is written in.");
    }

    const text = await drive.readFileText(driveId);
    const analysis = analyseManuscript(text);
    const prior = await loadState(slug);
    const notes = prior.manuscript?.driveId === driveId ? prior.manuscript.notes ?? "" : "";

    // Cached so the brief can be rebuilt without refetching.
    const paths = workspacePaths(slug);
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(
      path.join(paths.artifacts, "existing-manuscript.json"),
      JSON.stringify({ driveId, name: meta.name, analysis }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(paths.artifacts, "continuation-brief.md"),
      renderContinuationBrief(analysis, meta.name, notes),
      "utf8"
    );

    const state = await updateState(slug, (current) => {
      current.manuscript = {
        driveId,
        name: meta.name,
        target: current.manuscript?.driveId === driveId ? current.manuscript.target : "continue",
        totalWords: analysis.totalWords,
        storyWords: analysis.storyWords,
        chapterCount: analysis.chapters.length,
        lastChapterComplete: analysis.lastChapterComplete,
        completenessReason: analysis.completenessReason,
        backMatterHeading: analysis.backMatter?.heading,
        backMatterWords: analysis.backMatter?.wordCount,
        notes,
        analysedAt: new Date().toISOString()
      };
      current.manuscriptReviewed = true;
    });

    res.json({ analysis, state: withDerived(state) });
  }));

  app.patch("/api/manuscript", route(async (req, res) => {
    const slug = await requireSlug();
    const target = req.body?.target;
    const notes = req.body?.notes;
    if (target === undefined && typeof notes !== "string") {
      throw new HttpError(400, "Provide a continuation target or notes.");
    }
    if (target !== undefined && target !== "continue" && target !== "separate") {
      throw new HttpError(400, "Target must be continue or separate.");
    }
    const state = await updateState(slug, (current) => {
      if (current.manuscript) {
        if (target !== undefined) current.manuscript.target = target;
        if (typeof notes === "string") current.manuscript.notes = notes.trim().slice(0, 8000);
      }
    });
    if (state.manuscript && typeof notes === "string") {
      try {
        const raw = await readFile(path.join(workspacePaths(slug).artifacts, "existing-manuscript.json"), "utf8");
        const cached = JSON.parse(raw) as { analysis: Parameters<typeof renderContinuationBrief>[0] };
        await writeFile(
          path.join(workspacePaths(slug).artifacts, "continuation-brief.md"),
          renderContinuationBrief(cached.analysis, state.manuscript.name, state.manuscript.notes ?? ""),
          "utf8"
        );
      } catch {
        // The state note is still useful if the cached analysis was removed.
      }
    }
    res.json(withDerived(state));
  }));

  app.post("/api/manuscript/skip", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.manuscript = null;
      current.manuscriptReviewed = true;
    });
    res.json(withDerived(state));
  }));

  app.delete("/api/manuscript", route(async (_req, res) => {
    const slug = await requireSlug();
    res.json(withDerived(await updateState(slug, (current) => {
      current.manuscript = null;
      current.manuscriptReviewed = false;
    })));
  }));

  /** The brief a drafting agent needs to continue without a visible seam. */
  app.get("/api/manuscript/brief", route(async (_req, res) => {
    const slug = await requireSlug();
    try {
      const raw = await readFile(path.join(workspacePaths(slug).artifacts, "continuation-brief.md"), "utf8");
      res.type("text/markdown").send(raw);
    } catch {
      throw new HttpError(404, "No existing draft has been analysed for this book.");
    }
  }));

  // --- Directions (author to agent) ------------------------------------------
  app.get("/api/directions", route(async (_req, res) => {
    const state = await loadState(await requireSlug());
    res.json({
      directions: state.directions ?? [],
      pending: (state.directions ?? []).filter((d) => !d.appliedAt)
    });
  }));

  app.post("/api/directions", route(async (req, res) => {
    const slug = await requireSlug();
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new HttpError(400, "An instruction is required.");
    if (text.length > 4000) throw new HttpError(400, "That is too long for an instruction. Keep it to the point.");

    const scope = req.body?.scope === "chapter" ? "chapter" : "book";
    const direction = {
      id: randomUUID(),
      text,
      scope: scope as "book" | "chapter",
      chapter: scope === "chapter" ? Number(req.body?.chapter) || undefined : undefined,
      createdAt: new Date().toISOString()
    };

    const state = await updateState(slug, (current) => {
      current.directions = [...(current.directions ?? []), direction];
    });
    res.status(201).json({ direction, state: withDerived(state) });
  }));

  /** An agent marks an instruction as taken into account. */
  app.post("/api/directions/:id/applied", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      const direction = (current.directions ?? []).find((d) => d.id === req.params.id);
      if (direction) {
        direction.appliedAt = new Date().toISOString();
        direction.appliedTo = Number(req.body?.chapter) || undefined;
      }
    });
    res.json(withDerived(state));
  }));

  app.delete("/api/directions/:id", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.directions = (current.directions ?? []).filter((d) => d.id !== req.params.id);
    });
    res.json(withDerived(state));
  }));

  // --- Run control -----------------------------------------------------------
  /**
   * An agent reports that a run stopped.
   *
   * Canon Quill's engine never calls a provider, so it cannot see a 401 or a
   * spent balance itself. The runtime that does hit it says so here, and the
   * board can then explain the stop and offer to pick up where it left off
   * instead of the work simply going quiet.
   */
  app.post("/api/run/halt", route(async (req, res) => {
    const slug = await requireSlug();
    const reasons = ["no_credit", "rate_limited", "invalid_credentials", "provider_error", "cancelled", "other"];
    const reason = reasons.includes(req.body?.reason) ? req.body.reason : "other";

    const state = await updateState(slug, (current) => {
      current.run = {
        status: "halted",
        chapter: Number(req.body?.chapter) || current.run?.chapter || null,
        reason,
        detail: typeof req.body?.detail === "string" ? req.body.detail.slice(0, 2000) : null,
        haltedAt: new Date().toISOString(),
        startedAt: current.run?.startedAt ?? null
      };
    });

    await appendLog(slug, "error", {
      timestamp: new Date().toISOString(),
      stage: "chapter_drafting",
      stageName: "Drafting",
      agent: "runtime",
      event: "run_halted",
      errorMessage: `${reason}: ${req.body?.detail ?? "no detail"}`,
      data: { chapter: state.run.chapter }
    });

    res.json(withDerived(state));
  }));

  app.post("/api/run/start", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.run = {
        status: "running",
        chapter: Number(req.body?.chapter) || null,
        reason: null,
        detail: null,
        haltedAt: null,
        startedAt: new Date().toISOString()
      };
    });
    res.json(withDerived(state));
  }));

  /**
   * Clear a halt and report where to pick up.
   *
   * The credential is re-checked first: resuming into the same wall wastes the
   * author's time and, on a rate limit, can make it worse.
   */
  app.post("/api/run/resume", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);

    if (state.engine.provider && state.engine.authMethod === "api_key") {
      const key = (await readApiKey(state.engine.provider))
        ?? process.env[state.engine.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];
      if (key) {
        const check = await verifyApiKey(state.engine.provider, key);
        if (!check.ok) {
          res.status(409).json({ resumed: false, blockedBy: check });
          return;
        }
      }
    }

    // The first chapter that is not finished is where the work continues.
    const next = state.chapters.find((chapter) => chapter.status !== "approved");
    const updated = await updateState(slug, (current) => {
      current.run = {
        status: "running",
        chapter: next?.number ?? null,
        reason: null,
        detail: null,
        haltedAt: null,
        startedAt: new Date().toISOString()
      };
    });

    res.json({ resumed: true, resumeAt: next?.number ?? null, state: withDerived(updated) });
  }));

  app.post("/api/chapters/:number/status", route(async (req, res) => {
    const slug = await requireSlug();
    const status = req.body?.status;
    const allowed = ["planned", "drafting", "drafted", "editing", "validated", "approved", "needs_work"];
    if (!allowed.includes(status)) throw new HttpError(400, "Unknown chapter status.");

    const state = await updateState(slug, (current) => {
      const chapter = current.chapters.find((entry) => entry.number === Number(req.params.number));
      if (chapter) {
        chapter.status = status;
        chapter.updatedAt = new Date().toISOString();
      }
    });
    res.json(withDerived(state));
  }));

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return app;
}

export function startStudio(options: StudioServerOptions = {}) {
  const port = options.port ?? Number(process.env.CANON_QUILL_STUDIO_PORT ?? 4180);
  // Loopback only. This surface exposes manuscripts and Drive contents.
  const host = options.host ?? "127.0.0.1";
  const server = createStudioApp().listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log("");
    console.log("  Canon Quill Studio is running.");
    console.log("");
    console.log(`      ${url}`);
    console.log("");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
    if (process.env.CANON_QUILL_NO_OPEN !== "1") openBrowser(url);
  });

  /**
   * A replacement started by a restart begins before its predecessor has let
   * go of the port, so the address being in use is expected for a moment
   * rather than fatal.
   */
  const startedAt = Date.now();
  const patience = process.env.CANON_QUILL_RESTARTING === "1" ? 20_000 : 3_000;
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
    if (Date.now() - startedAt > patience) {
      console.error(`\n  Port ${port} is still in use after waiting.`);
      console.error(`  Another Studio may already be running, or set CANON_QUILL_STUDIO_PORT to a free port.\n`);
      process.exit(1);
    }
    setTimeout(() => server.listen(port, host), 400);
  });

  return server;
}

/**
 * Open the default browser. Best effort: a headless box, a locked-down WSL, or
 * a missing opener is not a reason to fail, so failures are silent and the URL
 * printed above remains the instruction.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "explorer.exe"
    // WSL reaches the Windows browser through the same binary.
    : existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") ? "explorer.exe"
    : "xdg-open";

  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Silent by design.
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Style needs enough prose for the fingerprint to mean anything: sentence
 * length spread and dialogue share are noise below a few thousand words.
 */
const minimumStyleWords = 2000;

/**
 * References are what the book is *about*, as opposed to how it sounds, so a
 * smaller amount is still useful: a character sheet and a timeline carry a lot
 * of canon in very few words.
 */
const minimumReferenceWords = 1000;

export interface SourceRequirement {
  ok: boolean;
  documents: number;
  words: number;
  minWords: number;
  reason: string;
}

export interface SourcesCheck {
  ok: boolean;
  style: SourceRequirement;
  references: SourceRequirement;
  /** Style is being learned from someone else's prose. */
  fromReference: boolean;
}

/**
 * Two separate requirements, reported separately.
 *
 * Style decides how the book sounds; references decide what is in it. One
 * document can satisfy both, and for an author continuing their own series it
 * usually does: mark it as Your writing and References together.
 */
export function sourcesCheck(sources: SelectedSource[]): SourcesCheck {
  const own = sources.filter((source) => source.kinds?.includes("past_book"));
  const references = sources.filter((source) => source.kinds?.includes("reference_book"));
  const styleSources = own.length > 0 ? own : references;
  const fromReference = own.length === 0 && references.length > 0;

  const words = (list: SelectedSource[]) => list.reduce((total, s) => total + (s.wordCount ?? 0), 0);

  const styleWords = words(styleSources);
  const style: SourceRequirement = {
    documents: styleSources.length,
    words: styleWords,
    minWords: minimumStyleWords,
    ok: styleSources.length > 0 && styleWords >= minimumStyleWords,
      reason:
        styleSources.length === 0
        ? "No prose source is available yet. Reference material is required, and series books are optional."
        : styleWords < minimumStyleWords
          ? `Only ${styleWords.toLocaleString()} words to learn the voice from. Below about ${minimumStyleWords.toLocaleString()} the measurements are too noisy to steer by.`
          : ""
  };

  const referenceWords = words(references);
  const referenceRequirement: SourceRequirement = {
    documents: references.length,
    words: referenceWords,
    minWords: minimumReferenceWords,
    ok: references.length > 0 && referenceWords >= minimumReferenceWords,
    reason:
      references.length === 0
        ? "Nothing is marked as a Reference. The book needs material to draw on, not just a voice to write in. Series books count here too and are marked as references automatically."
        : referenceWords < minimumReferenceWords
          ? `Only ${referenceWords.toLocaleString()} words of reference material. Below about ${minimumReferenceWords.toLocaleString()} there is little for the book to draw on.`
          : ""
  };

  return {
    ok: style.ok && referenceRequirement.ok,
    style,
    references: referenceRequirement,
    fromReference
  };
}

function withDerived(state: StudioState) {
  return { ...state, phase: derivePhase(state), blocking: blockingQuestions(state).length };
}

interface FlatNode {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  isFolder: boolean;
}

function flatten(nodes: Array<FlatNode & { children?: unknown[] }>): FlatNode[] {
  const output: FlatNode[] = [];
  const walk = (list: unknown[]) => {
    for (const entry of list) {
      const node = entry as FlatNode & { children?: unknown[] };
      output.push({ id: node.id, name: node.name, path: node.path, mimeType: node.mimeType, isFolder: node.isFolder });
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return output;
}

function isReadable(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/vnd.google-apps.document" ||
    mimeType === "application/rtf" ||
    mimeType === "application/json"
  );
}

async function readCached(slug: string, driveId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(workspacePaths(slug).driveCache, `${driveId}.json`), "utf8");
    return (JSON.parse(raw) as { text: string }).text;
  } catch {
    return undefined;
  }
}

async function readCorpus(slug: string): Promise<StyleCorpus | undefined> {
  try {
    const raw = await readFile(path.join(workspacePaths(slug).artifacts, "style-corpus.json"), "utf8");
    return JSON.parse(raw) as StyleCorpus;
  } catch {
    return undefined;
  }
}

function renderFingerprint(label: string, fingerprint: StyleMetrics, passages: number, profile?: WritingProfile): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `# Style fingerprint: ${label}`,
    "",
    `Built from ${passages} passages, ${fingerprint.wordCount.toLocaleString()} words of your own prose.`,
    "",
    "These are targets, not rules. Drafts are compared against them, and deviation",
    "is measured against your writing rather than a generic standard.",
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
    `| Ornate tags per 1k words | ${fingerprint.dialogue.ornateTagsPer1k} |`,
    `| Adverbs per 1k | ${fingerprint.texture.lyAdverbsPer1k} |`,
    `| Filter verbs per 1k | ${fingerprint.texture.filterVerbsPer1k} |`,
    `| Abstract nouns per 1k | ${fingerprint.texture.abstractNounsPer1k} |`,
    `| Similes per 1k | ${fingerprint.texture.similesPer1k} |`,
    `| Contractions per 1k | ${fingerprint.texture.contractionsPer1k} |`,
    `| Vocabulary variety | ${fingerprint.texture.typeTokenRatio} |`,
    "",
    "## Evidence-backed writing profile",
    "",
    ...(profile ? [
      `- Narration: ${profile.narration.label} (${Math.round(profile.narration.confidence * 100)}% confidence).`,
      `- Narrative distance: ${profile.distance.label}; filter verbs ${profile.distance.filterVerbsPer1k}/1k, interiority ${profile.distance.interiorityPer1k}/1k.`,
      `- Sensory palette per 1k: ${Object.entries(profile.sensory).map(([key, value]) => `${key} ${value}`).join(", ")}.`,
      `- Beat distribution: ${Object.entries(profile.beats).map(([key, value]) => `${key} ${pct(value)}`).join(", ")}.`,
      `- Emotional rendering per 1k: explicit ${profile.emotion.explicitPer1k}, body cues ${profile.emotion.bodyCuePer1k}, thought ${profile.emotion.thoughtPer1k}.`,
      `- Figurative language per 1k: similes ${profile.figurative.similesPer1k}, metaphor signals ${profile.figurative.metaphorSignalsPer1k}.`,
      `- Advisory audience signals: ${profile.audience.values.join(", ") || "none strong enough to suggest"}.`,
      `- Advisory intimacy signal: ${profile.intimacy.value} (${Math.round(profile.intimacy.confidence * 100)}% confidence).`,
      "",
      "Evidence:",
      ...profile.narration.evidence.map((item) => `- ${item}`),
      ...profile.audience.evidence.map((item) => `- ${item}`),
      ...profile.intimacy.evidence.map((item) => `- ${item}`)
    ] : ["No extended profile is available in this corpus artifact."]),
    ""
  ].join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startStudio();
}
