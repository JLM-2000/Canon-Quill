import express from "express";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { SafeDriveClient } from "../drive/client.js";
import { beginDriveAuthorization, driveAuthStatus } from "../drive/auth.js";
import { extractDriveId } from "../drive/id.js";
import { classifySource, sourceKindCounts, sourceKindLabels, sourceKindPurpose, type SourceKind } from "../analysis/classify.js";
import { analyseProjectMaterial, buildIntakeQuestionPlan } from "../analysis/intake.js";
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
  type ChapterChatMessage,
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

  async function refreshExistingManuscript(slug: string, driveId: string) {
    const meta = await drive.getMetadata(driveId);
    if (meta.mimeType === "application/vnd.google-apps.folder") {
      throw new HttpError(400, "That is a folder. Pick the document the book is written in.");
    }

    const text = await drive.readFileText(driveId);
    const analysis = analyseManuscript(text);
    const prior = await loadState(slug);
    const notes = prior.manuscript?.driveId === driveId ? prior.manuscript.notes ?? "" : "";
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
      current.manuscriptReviewed = false;
      current.writingConfirmed = false;
    });

    return { analysis, state: withDerived(state) };
  }

  async function analyseProject(slug: string) {
    const state = await loadState(slug);
    const documents: Array<{ name: string; path: string; kinds: string[]; text: string }> = [];
    for (const source of state.sources) {
      const text = await readCached(slug, source.driveId);
      if (text) documents.push({ name: source.name, path: source.path, kinds: source.kinds, text });
    }
    if (!documents.length && state.projectStart === "from_scratch" && state.startingBrief.trim()) {
      documents.push({
        name: "Author starting brief",
        path: "/author-starting-brief",
        kinds: ["notes"],
        text: `Premise: ${state.startingBrief.trim()}`
      });
    }
    const intake = { ...state.intake };
    const context = {
      shape: state.shape,
      draftingMode: state.draftingMode,
      intake,
      existingDraft: Boolean(state.manuscript)
    };
    const analysis = analyseProjectMaterial(documents, context);
    if (analysis.findings.audience && !intake.audience) {
      intake.audience = analysis.findings.audience.value.replace(/\s*\/\s*/g, "|");
    }
    if (analysis.findings.intimacy && !intake.spice) {
      intake.spice = analysis.findings.intimacy.value;
    }
    context.intake = intake;
    analysis.questionPlan = buildIntakeQuestionPlan(analysis, context);
    const paths = workspacePaths(slug);
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(path.join(paths.artifacts, "project-analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
    const next = await updateState(slug, (current) => {
      current.projectAnalysis = { ...analysis, completed: true };
      if (analysis.genre && !current.intake.genre) current.intake.genre = analysis.genre;
      if (analysis.subgenre && !current.intake.subgenre) current.intake.subgenre = analysis.subgenre;
      if (!current.intake.audience && intake.audience) current.intake.audience = intake.audience;
      if (!current.intake.spice && intake.spice) current.intake.spice = intake.spice;
    });
    return { analysis, state: withDerived(next) };
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
    res.json(await getVersionInfo(req.query.remote === "1"));
  }));

  app.post("/api/version/update", route(async (_req, res) => {
    res.json(await applyUpdate());
  }));

  /** Restart the Studio with the current executable arguments. */
  app.post("/api/version/restart", route(async (_req, res) => {
    const command = process.execPath;
    const args = [...process.execArgv, process.argv[1], ...process.argv.slice(2)];

    let child;
    try {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: { ...process.env, CANON_QUILL_NO_OPEN: "1", CANON_QUILL_RESTARTING: "1" },
        detached: true,
        stdio: "inherit"
      });
    } catch (error) {
      throw new HttpError(500, `Could not start a replacement process: ${message(error)}`);
    }

    let died = false;
    child.once("error", () => (died = true));
    child.once("exit", () => (died = true));

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (died) {
      throw new HttpError(500, "The replacement process exited immediately. Restart the Studio by hand and check the terminal.");
    }

    child.unref();
    res.json({ restarting: true, pid: child.pid });
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

  app.post("/api/project/start", route(async (req, res) => {
    const slug = await requireSlug();
    const projectStart = req.body?.projectStart;
    const brief = typeof req.body?.startingBrief === "string" ? req.body.startingBrief.trim() : "";
    if (projectStart !== "from_scratch" && projectStart !== "with_material") {
      throw new HttpError(400, "Choose whether the book starts from scratch or with existing material.");
    }
    if (projectStart === "from_scratch" && brief.length < 40) {
      throw new HttpError(400, "Describe what the book is about in at least a few detailed sentences first.");
    }
    const state = await updateState(slug, (current) => {
      const changed = current.projectStart !== projectStart;
      current.projectStart = projectStart;
      current.startingBrief = projectStart === "from_scratch" ? brief.slice(0, 12000) : "";
      if (!changed) return;
      current.writingConfirmed = false;
      current.shape = null;
      current.projectShapeReviewed = false;
      current.manuscript = null;
      current.manuscriptReviewed = false;
      current.sources = [];
      current.sourcesReviewed = false;
      current.questions = [];
      current.conversation = [];
      current.conversationStartedAt = null;
      current.chapterChats = {};
      current.styleCorpus = { built: false, label: "", passageCount: 0, wordCount: 0, builtAt: null, continuedAt: null };
      current.projectAnalysis = emptyState(slug, current.projectName).projectAnalysis;
      if (projectStart === "from_scratch") {
        current.drive.referenceRoots = [];
        current.drive.referenceRootNames = {};
        current.drive.targetFolderId = null;
        current.drive.targetFolderName = null;
      }
    });
    res.json(withDerived(state));
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
    const state = await updateState(slug, (current) => {
      const nextShape = shape === "standalone" || shape === "series" ? shape : current.shape;
      const nextMode = draftingMode === "chapter_by_chapter" || draftingMode === "whole_book"
        ? draftingMode
        : current.draftingMode;
      if (nextShape !== current.shape || nextMode !== current.draftingMode) {
        current.projectShapeReviewed = false;
        current.writingConfirmed = false;
      }
      current.projectName = typeof projectName === "string" && projectName.trim() ? projectName.trim() : current.projectName;
      current.shape = nextShape;
      current.draftingMode = nextMode;
      current.intake = intake && typeof intake === "object" ? { ...current.intake, ...intake } : current.intake;
    });
    if (typeof projectName === "string" && projectName.trim()) {
      await touchProject(slug, { title: projectName.trim() });
    }
    res.json(withDerived(state));
  }));

  app.post("/api/project/continue", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      if (!current.shape || !current.draftingMode) throw new HttpError(400, "Choose a book shape and drafting mode first.");
      current.projectShapeReviewed = true;
    });
    res.json(withDerived(state));
  }));

  // --- Engine (provider, auth, models) --------------------------------------
  app.get("/api/engine", route(async (_req, res) => {
    const slug = await requireSlug();
    let state = await loadState(slug);
    if (!state.projectStart && (state.engine.provider || state.engine.analysisProvider || state.engine.draftingProvider)) {
      state = await updateState(slug, (current) => { current.projectStart = "with_material"; });
    }
    const catalog = await loadCatalog();
    const draftingProvider = state.engine.draftingProvider ?? state.engine.provider;
    const draftingAuth = state.engine.draftingAuthMethod ?? state.engine.authMethod;
    const analysisProvider = state.engine.analysisProvider ?? draftingProvider;
    const analysisAuth = state.engine.analysisAuthMethod ?? draftingAuth;

    const storedKey = draftingProvider ? await readApiKey(draftingProvider) : undefined;
    const storedKeys = {
      anthropic: await readApiKey("anthropic"),
      openai: await readApiKey("openai")
    };

    res.json({
      choice: state.engine,
      catalog,
      resolvedModels: resolveModels(catalog, state.engine),
      credentials: draftingProvider && draftingAuth ? await checkCredentials(draftingProvider, draftingAuth) : null,
      credentialsByRole: {
        analysis: analysisProvider && analysisAuth ? await checkCredentials(analysisProvider, analysisAuth) : null,
        drafting: draftingProvider && draftingAuth ? await checkCredentials(draftingProvider, draftingAuth) : null
      },
      // A mask only. The key never leaves the server.
      storedKey: storedKey ? maskKey(storedKey) : null,
      storedKeys: Object.fromEntries(Object.entries(storedKeys).map(([id, key]) => [id, key ? maskKey(key) : null]))
    });
  }));

  app.patch("/api/engine", route(async (req, res) => {
    const slug = await requireSlug();
    const { provider, authMethod, analysisProvider, analysisAuthMethod, draftingProvider, draftingAuthMethod, routing, models } = req.body ?? {};

    for (const value of [provider, analysisProvider, draftingProvider]) {
      if (value !== undefined && value !== "anthropic" && value !== "openai") {
        throw new HttpError(400, "Provider must be anthropic or openai.");
      }
    }
    for (const value of [authMethod, analysisAuthMethod, draftingAuthMethod]) {
      if (value !== undefined && value !== "subscription" && value !== "api_key") {
        throw new HttpError(400, "Auth method must be subscription or api_key.");
      }
    }
    if (routing !== undefined && routing !== "single" && routing !== "split") throw new HttpError(400, "Routing must be single or split.");
    // Keys go to /api/engine/key, which stores them outside the project state.
    for (const key of Object.keys(req.body ?? {})) {
      if (/key|token|secret|password/i.test(key) && key !== "authMethod") {
        throw new HttpError(400, "Send API keys to /api/engine/key, not here.");
      }
    }

    const state = await updateState(slug, (current) => {
      if (provider !== undefined) {
        current.engine.provider = provider;
        current.engine.draftingProvider = provider;
        current.engine.analysisProvider = provider;
        // Model overrides belong to a provider; drop them when it changes.
        current.engine.models = {};
      }
      if (authMethod !== undefined) current.engine.authMethod = authMethod;
      if (provider !== undefined && authMethod !== undefined) {
        current.engine.draftingAuthMethod = authMethod;
        current.engine.analysisAuthMethod = authMethod;
      }
      if (analysisProvider !== undefined) current.engine.analysisProvider = analysisProvider;
      if (analysisAuthMethod !== undefined) current.engine.analysisAuthMethod = analysisAuthMethod;
      if (draftingProvider !== undefined) current.engine.draftingProvider = draftingProvider;
      if (draftingAuthMethod !== undefined) current.engine.draftingAuthMethod = draftingAuthMethod;
      if (routing !== undefined) {
        current.engine.routing = routing;
        if (routing === "single") {
          const selectedProvider = current.engine.draftingProvider ?? current.engine.analysisProvider;
          const selectedAuth = current.engine.draftingAuthMethod ?? current.engine.analysisAuthMethod;
          current.engine.provider = selectedProvider ?? current.engine.provider;
          current.engine.authMethod = selectedAuth ?? current.engine.authMethod;
          current.engine.analysisProvider = current.engine.provider;
          current.engine.draftingProvider = current.engine.provider;
          current.engine.analysisAuthMethod = current.engine.authMethod;
          current.engine.draftingAuthMethod = current.engine.authMethod;
        }
      }
      if (models && typeof models === "object") {
        current.engine.models = { ...current.engine.models, ...models };
      }
      if ([provider, authMethod, analysisProvider, analysisAuthMethod, draftingProvider, draftingAuthMethod, routing].some((value) => value !== undefined)) {
        current.engineReviewed = false;
      }
    });

    const catalog = await loadCatalog();
    const nextDraftingProvider = state.engine.draftingProvider ?? state.engine.provider;
    const nextDraftingAuth = state.engine.draftingAuthMethod ?? state.engine.authMethod;
    res.json({
      choice: state.engine,
      resolvedModels: resolveModels(catalog, state.engine),
      credentials: nextDraftingProvider && nextDraftingAuth ? await checkCredentials(nextDraftingProvider, nextDraftingAuth) : null,
      credentialsByRole: {
        analysis: state.engine.analysisProvider && state.engine.analysisAuthMethod
          ? await checkCredentials(state.engine.analysisProvider, state.engine.analysisAuthMethod)
          : null,
        drafting: nextDraftingProvider && nextDraftingAuth
          ? await checkCredentials(nextDraftingProvider, nextDraftingAuth)
          : null
      }
    });
  }));

  app.post("/api/engine/continue", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      const draftingProvider = current.engine.draftingProvider ?? current.engine.provider;
      const draftingAuth = current.engine.draftingAuthMethod ?? current.engine.authMethod;
      const analysisProvider = current.engine.analysisProvider ?? draftingProvider;
      const analysisAuth = current.engine.analysisAuthMethod ?? draftingAuth;
      if (!current.projectStart || !draftingProvider || !draftingAuth || !analysisProvider || !analysisAuth) {
        throw new HttpError(400, "Choose the project starting point and complete both provider assignments first.");
      }
      current.engineReviewed = true;
    });
    res.json(withDerived(state));
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
  /** Report Drive status without starting authorization. */
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
    const rawNames = req.body?.referenceNames;
    const referenceNames = rawNames && typeof rawNames === "object" && !Array.isArray(rawNames)
      ? Object.fromEntries(Object.entries(rawNames).map(([id, name]) => [id, String(name)]))
      : {};
    const targetName = typeof req.body?.targetFolderName === "string" ? req.body.targetFolderName.trim() : "";

    const state = await updateState(slug, (current) => {
      current.drive.referenceRoots = roots;
      current.drive.referenceRootNames = Object.fromEntries(
        roots.map((id) => [id, referenceNames[id] || current.drive.referenceRootNames[id] || id])
      );
      current.drive.targetFolderId = target;
      current.drive.targetFolderName = target ? targetName || current.drive.targetFolderName || target : null;
    });
    res.json(withDerived(state));
  }));

  app.post("/api/sources/upload", route(async (req, res) => {
    const slug = await requireSlug();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) throw new HttpError(400, "Choose at least one text file.");
    if (files.length > 100) throw new HttpError(400, "Upload no more than 100 files at once.");

    const cache = workspacePaths(slug).driveCache;
    await mkdir(cache, { recursive: true });
    const uploaded: SelectedSource[] = [];
    const pendingCache: Array<{ id: string; text: string }> = [];
    let totalChars = 0;
    const allowedExtensions = new Set([".txt", ".md", ".markdown", ".rtf", ".html", ".htm", ".csv", ".json"]);
    const allowedMimeTypes = new Set(["", "text/plain", "text/markdown", "text/html", "text/csv", "application/rtf", "application/json"]);
    for (const file of files) {
      const name = typeof file?.name === "string" ? file.name.trim() : "";
      const text = typeof file?.text === "string" ? file.text : "";
      if (!name || !text.trim()) continue;
      const extension = path.extname(name).toLowerCase();
      const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
      if (name.length > 240 || !allowedExtensions.has(extension) || !allowedMimeTypes.has(mimeType)) {
        throw new HttpError(400, `${name} is not an accepted text file.`);
      }
      if (text.length > 5_000_000) throw new HttpError(400, `${name} is too large for a browser upload.`);
      totalChars += text.length;
      if (totalChars > 7_000_000) throw new HttpError(400, "The upload is too large. Keep the batch under 7 MB of text.");
      const id = `local-${randomUUID()}`;
      const classification = classifySource({ name, path: `/${name}`, text });
      const source: SelectedSource = {
        driveId: id,
        name,
        path: `/${name}`,
        mimeType: mimeType || "text/plain",
        isFolder: false,
        kinds: classification.kind === "past_book"
          ? ["past_book", "reference_book"]
          : [String(classification.kind) === "unclassified" ? "notes" : classification.kind],
        wordCount: computeMetrics(text).wordCount,
        classification
      };
      pendingCache.push({ id, text });
      uploaded.push(source);
    }
    if (!uploaded.length) throw new HttpError(400, "The selected files contained no readable text.");
    try {
      await Promise.all(pendingCache.map(({ id, text }) => writeFile(path.join(cache, `${id}.json`), JSON.stringify({ text }), "utf8")));
    } catch (error) {
      await Promise.all(pendingCache.map(({ id }) => unlink(path.join(cache, `${id}.json`)).catch(() => undefined)));
      throw error;
    }

    const state = await updateState(slug, (current) => {
      current.sources = [...current.sources.filter((source) => !source.driveId.startsWith("local-")), ...uploaded];
      current.sourcesReviewed = false;
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
      current.projectAnalysis = emptyState(slug, current.projectName).projectAnalysis;
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
            // Own past books supply both style and canon.
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
      current.projectAnalysis = emptyState(slug, current.projectName).projectAnalysis;
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
      if (source) {
        source.kinds = kinds;
        current.styleCorpus.built = false;
        current.styleCorpus.continuedAt = null;
        current.projectAnalysis = emptyState(slug, current.projectName).projectAnalysis;
      }
    });
    res.json(withDerived(state));
  }));

  /** Remove a document from the current source set. */
  app.delete("/api/sources/:driveId", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.sources = current.sources.filter((entry) => entry.driveId !== req.params.driveId);
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
      current.projectAnalysis = emptyState(slug, current.projectName).projectAnalysis;
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

  /** Retrieve exemplar passages for a scene. */
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
    res.json({
      questions: state.questions,
      conversation: state.conversation,
      conversationStartedAt: state.conversationStartedAt,
      blocking: blockingQuestions(state)
    });
  }));

  app.post("/api/intake/analyse", route(async (_req, res) => {
    const slug = await requireSlug();
    res.json(await analyseProject(slug));
  }));

  app.post("/api/intake/reset", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.questions = [];
      current.conversation = [];
      current.conversationStartedAt = null;
      current.writingConfirmed = false;
      current.projectAnalysis = emptyState(slug, current.projectName).projectAnalysis;
    });
    try {
      await unlink(path.join(workspacePaths(slug).artifacts, "project-analysis.json"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    res.json(withDerived(state));
  }));

  app.post("/api/conversation/start", route(async (_req, res) => {
    const slug = await requireSlug();
    let state = await loadState(slug);
    if (!state.projectAnalysis.completed) state = (await analyseProject(slug)).state;
    state = await updateState(slug, (current) => {
      const startedAt = current.conversationStartedAt ?? new Date().toISOString();
      current.conversationStartedAt = startedAt;
      if (current.questions.length === 0) {
        appendNextPlannedQuestion(current, startedAt);
      }
    });
    res.json(withDerived(state));
  }));

  app.post("/api/questions", route(async (req, res) => {
    const slug = await requireSlug();
    const body = req.body ?? {};
    if (typeof body.question !== "string" || !body.question.trim()) {
      throw new HttpError(400, "A question is required.");
    }
    const question: OpenQuestion = {
      id: randomUUID(),
      key: typeof body.key === "string" ? body.key : undefined,
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
      current.conversationStartedAt ??= question.askedAt;
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
      if (question.key) current.intake[question.key] = answer;
      current.conversation.push({
        id: randomUUID(),
        role: "author",
        text: answer,
        questionId: question.id,
        phase: question.phase,
        createdAt: question.answeredAt
      });
      appendNextPlannedQuestion(current, question.answeredAt);
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

  app.post("/api/writing/confirm", route(async (_req, res) => {
    const slug = await requireSlug();
    const current = await loadState(slug);
    const hasOwnStyle = current.sources.some((source) => source.kinds.includes("past_book"));
    if (!current.projectStart) throw new HttpError(400, "Choose how the book starts first.");
    if (!current.engineReviewed) throw new HttpError(400, "Continue past the writing engine first.");
    if (!current.shape || !current.draftingMode || !current.projectShapeReviewed) throw new HttpError(400, "Finish project shape first.");
    if (current.projectStart === "with_material" && !current.sourcesReviewed) throw new HttpError(400, "Review the selected material first.");
    if (!current.manuscriptReviewed) throw new HttpError(400, "Choose whether to continue an existing draft or start fresh first.");
    if (hasOwnStyle && (!current.styleCorpus.built || !current.styleCorpus.continuedAt)) throw new HttpError(400, "Finish the style corpus first.");
    if (!current.projectAnalysis.completed) throw new HttpError(400, "Finish project analysis first.");
    if (!current.conversationStartedAt) throw new HttpError(400, "Open the preparation questions first.");
    const state = await updateState(slug, (current) => {
      if (blockingQuestions(current).length > 0) throw new HttpError(400, "Answer the blocking preparation questions first.");
      current.writingConfirmed = true;
    });
    res.json(withDerived(state));
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
      current.writingConfirmed = false;
    });
    res.json(withDerived(state));
  }));

  app.get("/api/chapters/:number/brief", route(async (req, res) => {
    const state = await loadState(await requireSlug());
    res.type("text/markdown").send(buildOpeningBrief(state.ledger, Number(req.params.number)));
  }));

  app.get("/api/chapters/:number/chat", route(async (req, res) => {
    const state = await loadState(await requireSlug());
    const chapter = Number(req.params.number);
    if (state.draftingMode !== "chapter_by_chapter" || !state.chapters.some((entry) => entry.number === chapter)) {
      throw new HttpError(400, "Chapter chat is available only for planned chapters in chapter-by-chapter mode.");
    }
    res.json({ chapter, messages: state.chapterChats[String(chapter)] ?? [] });
  }));

  app.post("/api/chapters/:number/chat", route(async (req, res) => {
    const slug = await requireSlug();
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new HttpError(400, "Write a chapter instruction first.");
    if (text.length > 8000) throw new HttpError(400, "Keep the chapter note under 8,000 characters.");
    const chapter = Number(req.params.number);
    if (!Number.isInteger(chapter) || chapter < 1) throw new HttpError(400, "Unknown chapter number.");
    const current = await loadState(slug);
    if (current.draftingMode !== "chapter_by_chapter" || !current.chapters.some((entry) => entry.number === chapter)) {
      throw new HttpError(400, "Chapter chat is available only for planned chapters in chapter-by-chapter mode.");
    }
    const message: ChapterChatMessage = { id: randomUUID(), role: "author", text, createdAt: new Date().toISOString() };
    const state = await updateState(slug, (current) => {
      const key = String(chapter);
      current.chapterChats[key] = [...(current.chapterChats[key] ?? []), message];
    });
    res.status(201).json({ chapter, message, messages: state.chapterChats[String(chapter)] ?? [], state: withDerived(state) });
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
    res.json(await refreshExistingManuscript(slug, driveId));
  }));

  app.post("/api/manuscript/reanalyse", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    if (!state.manuscript) throw new HttpError(404, "No existing draft has been selected.");
    res.json(await refreshExistingManuscript(slug, state.manuscript.driveId));
  }));

  app.patch("/api/manuscript", route(async (req, res) => {
    const slug = await requireSlug();
    const target = req.body?.target;
    const notes = req.body?.notes;
    const proceed = req.body?.continue === true;
    if (target === undefined && typeof notes !== "string" && !proceed) {
      throw new HttpError(400, "Provide a continuation target or notes.");
    }
    if (target !== undefined && target !== "continue" && target !== "separate") {
      throw new HttpError(400, "Target must be continue or separate.");
    }
    const state = await updateState(slug, (current) => {
      if (current.manuscript) {
        if (target !== undefined) current.manuscript.target = target;
        if (typeof notes === "string") current.manuscript.notes = notes.trim().slice(0, 8000);
        if (proceed) {
          current.manuscriptReviewed = true;
          current.writingConfirmed = false;
        }
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
      current.writingConfirmed = false;
    });
    res.json(withDerived(state));
  }));

  app.delete("/api/manuscript", route(async (_req, res) => {
    const slug = await requireSlug();
    res.json(withDerived(await updateState(slug, (current) => {
      current.manuscript = null;
      current.manuscriptReviewed = false;
      current.writingConfirmed = false;
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
  /** Record a provider run halt. */
  app.post("/api/run/halt", route(async (req, res) => {
    const slug = await requireSlug();
    const reasons = ["no_credit", "rate_limited", "invalid_credentials", "provider_error", "cancelled", "other"];
    const reason = reasons.includes(req.body?.reason) ? req.body.reason : "other";
    const detail = typeof req.body?.detail === "string" ? redactSensitiveText(req.body.detail).slice(0, 2000) : null;

    const state = await updateState(slug, (current) => {
      current.run = {
        status: "halted",
        chapter: Number(req.body?.chapter) || current.run?.chapter || null,
        reason,
        detail,
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
      errorMessage: `${reason}: ${detail ?? "no detail"}`,
      data: { chapter: state.run.chapter }
    });

    res.json(withDerived(state));
  }));

  app.post("/api/run/start", route(async (req, res) => {
    const slug = await requireSlug();
    const current = await loadState(slug);
    requireWritingPhase(current);
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

  /** Resume a halted run after credential checks. */
  app.post("/api/run/resume", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    requireWritingPhase(state);

    const draftingProvider = state.engine.draftingProvider ?? state.engine.provider;
    const draftingAuth = state.engine.draftingAuthMethod ?? state.engine.authMethod;
    if (draftingProvider && draftingAuth === "api_key") {
      const key = (await readApiKey(draftingProvider))
        ?? process.env[draftingProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];
      if (key) {
        const check = await verifyApiKey(draftingProvider, key);
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
      if (!chapter) throw new HttpError(404, "Chapter not found.");
      if (status === "approved") {
        requireWritingPhase(current);
        if (chapter.status !== "validated") throw new HttpError(409, "Only a validated chapter can be approved.");
      }
      chapter.status = status;
      chapter.updatedAt = new Date().toISOString();
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

  // Close the HTTP listener when the terminal sends Ctrl+C. This prevents an
  // orphaned tsx child from keeping the port occupied after npm exits.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

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
    : existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") ? "explorer.exe"
    : "xdg-open";

  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Minimum prose for a useful style measurement. */
const minimumStyleWords = 2000;

/** Minimum material for a useful reference set. */
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

/** Validate style and reference source requirements. */
export function sourcesCheck(sources: SelectedSource[]): SourcesCheck {
  const own = sources.filter((source) => source.kinds?.includes("past_book"));
  const references = sources.filter((source) => source.kinds?.includes("reference_book"));
  const planning = sources.filter((source) => source.kinds?.some((kind) => ["characters", "timeline", "world", "plot", "notes"].includes(kind)));
  const referenceMaterial = references.length > 0 ? references : planning;
  const styleSources = own.length > 0 ? own : references;
  const fromReference = own.length === 0 && references.length > 0;

  const words = (list: SelectedSource[]) => list.reduce((total, s) => total + (s.wordCount ?? 0), 0);

  const styleWords = words(styleSources);
  const style: SourceRequirement = {
    documents: styleSources.length,
    words: styleWords,
    minWords: minimumStyleWords,
    ok: own.length === 0 || styleWords >= minimumStyleWords,
      reason:
        own.length === 0
        ? "No past book is marked as the author's style source. Drafting can continue without a measured style corpus."
        : styleWords < minimumStyleWords
          ? `Only ${styleWords.toLocaleString()} words to learn the voice from. Below about ${minimumStyleWords.toLocaleString()} the measurements are too noisy to steer by.`
          : ""
  };

  const referenceWords = words(referenceMaterial);
  const referenceRequirement: SourceRequirement = {
    documents: referenceMaterial.length,
    words: referenceWords,
    minWords: references.length > 0 ? minimumReferenceWords : 1,
    ok: referenceMaterial.length > 0 && (references.length === 0 || referenceWords >= minimumReferenceWords),
    reason:
      referenceMaterial.length === 0
        ? "No plan, timeline, character, world, note, or reference-book material has been selected yet."
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
      `- Passage beat mix, one dominant label per passage: ${Object.entries(profile.beats).map(([key, value]) => `${key} ${pct(value)}`).join(", ")}. This is directional word share, not quoted-dialogue share.`,
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

function appendNextPlannedQuestion(state: StudioState, askedAt: string): void {
  const plan = state.projectAnalysis.questionPlan.find((candidate) =>
    !state.intake[candidate.key] && !state.questions.some((question) => question.key === candidate.key)
  );
  if (!plan) return;

  const question: OpenQuestion = {
    id: randomUUID(),
    key: plan.key,
    phase: "intake",
    askedBy: "book-01-intake",
    question: plan.question,
    rationale: plan.rationale,
    options: plan.options,
    allowFreeText: plan.allowFreeText !== false,
    askedAt,
    blocking: plan.blocking
  };
  state.questions.push(question);
  state.conversation.push({
    id: randomUUID(),
    role: "agent",
    text: question.question,
    questionId: question.id,
    phase: question.phase,
    createdAt: askedAt
  });
}

function resolveModels(catalog: Awaited<ReturnType<typeof loadCatalog>>, engine: StudioState["engine"]): Record<string, string> {
  const draftingProvider = engine.draftingProvider ?? engine.provider;
  const analysisProvider = engine.analysisProvider ?? draftingProvider;
  if (!draftingProvider && !analysisProvider) return {};
  const resolved: Record<string, string> = {};
  for (const [role, entry] of Object.entries(catalog.roles)) {
    const provider = ["drafting", "editing"].includes(role) ? draftingProvider : analysisProvider;
    if (provider) resolved[role] = entry[provider];
  }
  return { ...resolved, ...engine.models };
}

function requireWritingPhase(state: StudioState): void {
  if (!state.writingConfirmed || derivePhase(state) !== "writing") {
    throw new HttpError(409, "The writing phase has not been explicitly confirmed.");
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]{12,}\b/g, "[redacted key]")
    .replace(/\b(?:ya29\.[A-Za-z0-9._-]+|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[redacted token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(api[_ -]?key|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startStudio();
}
