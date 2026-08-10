import express from "express";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { SafeDriveClient } from "../drive/client.js";
import { beginDriveAuthorization, driveAuthStatus } from "../drive/auth.js";
import { extractDriveId } from "../drive/id.js";
import { classifySource, isVoiceReference, sourceKindCounts, sourceKindLabels, sourceKindPurpose, type SourceKind } from "../analysis/classify.js";
import {
  analyseProjectMaterial,
  applyAnalysisEdits,
  deriveAnalysisGaps,
  findingKeys,
  hasAnalysisEdits,
  type AnalysisEdits,
  type FindingKey,
  type IntakeQuestionPlan,
  type ProjectAnalysis
} from "../analysis/intake.js";
import { analyseManuscript, renderContinuationBrief } from "../analysis/manuscript.js";
import { detectNarration, narrationOptions, povLabel, povOptions, tenseLabel, tenseOptions } from "../style/narration.js";
import { analyseWriting, type WritingProfile } from "../style/profile.js";
import { buildCorpus, type CorpusDocument, type StyleCorpus, type BeatType } from "../style/corpus.js";
import { scoreAgainstFingerprint } from "../style/score.js";
import { computeMetrics, type StyleMetrics } from "../style/metrics.js";
import { renderExemplarPrompt, retrieveExemplars } from "../style/retrieve.js";
import { buildOpeningBrief, validateFlow } from "../continuity/flow.js";
import { redactSensitiveText } from "./redact.js";
import {
  isRunning,
  runSnapshot,
  runtimeLabel,
  selectRuntime,
  startRun,
  stopRun,
  type RunOutcome,
  type RunProgress,
  type RuntimeId
} from "./runner.js";
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
  type ExistingManuscriptSection,
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
import { appendLog, logError, resolveErrors } from "../project/logs.js";
import { checkCredentials, defaultModels, loadCatalog, type ProviderId } from "./engine.js";
import { estimateWriting } from "./estimate.js";
import { applyUpdate, getVersionInfo } from "./updates.js";
import { deleteApiKey, maskKey, readApiKey, saveApiKey, verifyApiKey } from "./credentials.js";
import { loadDotEnv } from "../config/env.js";
import { generateMarkdownDocx } from "../project/docx.js";
import { generateMarkdownPdf } from "../project/pdf.js";
import { escapeHtml, renderMarkdown } from "../preview/markdown.js";
import { measureFormatting, renderFormattingReference } from "../style/formatting.js";

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
  let phaseLogQueue = Promise.resolve();
  let pendingOutcome: Promise<void> | null = null;
  const explicitlyHalted = new Set<string>();

  /** Resolve the workspace a request applies to, or fail with a clear message. */
  async function requireSlug(): Promise<string> {
    const slug = await activeSlug();
    if (!slug) throw new HttpError(409, "No book selected. Create one first.");
    return slug;
  }

  /** Keep the author decisions in one workspace artifact for every downstream agent. */
  async function writeDecisionLog(slug: string): Promise<void> {
    const state = await loadState(slug);
    const paths = workspacePaths(slug);
    const planned = state.projectAnalysis.questionPlan || [];
    const questions = state.questions || [];
    const conversation = state.conversation || [];
    const lines = [
      "# Author decision log",
      "",
      "This is the author-facing intake record. Author answers outrank source inference and model assumptions.",
      "Read it with project-analysis.json before making preparation or drafting decisions.",
      "",
      "## Planned decisions",
      "",
      ...(planned.length
        ? planned.map((question) => `- **${question.key}**: ${question.question} (${question.blocking ? "blocking" : "advisory"})`)
        : ["No unresolved decisions were identified by the deterministic analysis."]),
      "",
      "## Questions and answers",
      "",
      ...(questions.length
        ? questions.flatMap((question) => [
            `### ${question.key || question.id}`,
            "",
            `**Question:** ${question.question}`,
            `**Answer:** ${question.answer ?? "Unanswered"}`,
            ""
          ])
        : ["No questions have been asked.", ""]),
      "## Intake conversation",
      "",
      ...(conversation.length
        ? conversation.map((message) => `- **${message.role}**: ${message.text}`)
        : ["No freeform intake messages."]),
      ""
    ];
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(path.join(paths.artifacts, "decision-log.md"), lines.join("\n"), "utf8");
  }

  async function logPhase(slug: string, stage: string, stageName: string, event: string, data?: unknown): Promise<void> {
    await appendLog(slug, "phase", {
      timestamp: new Date().toISOString(),
      stage,
      stageName,
      agent: "studio",
      event,
      data
    });
  }

  async function resolveFixedRuntimeErrors(slug: string): Promise<void> {
    try {
      JSON.parse(await readFile(path.join(process.cwd(), "opencode.json"), "utf8"));
    } catch {
      return;
    }
    const resolved = await resolveErrors(
      slug,
      (entry) => /InvalidEscapeCharacter|opencode\.json.*not valid JSON/i.test(`${entry.errorMessage} ${entry.stack ?? ""}`),
      "opencode.json now validates successfully; the historical configuration failure is resolved."
    );
    if (resolved) {
      await appendLog(slug, "audit", {
        timestamp: new Date().toISOString(),
        stage: "chapter_drafting",
        stageName: "Drafting",
        agent: "studio",
        event: "runtime_configuration_resolved",
        data: { resolvedErrors: resolved }
      });
    }
  }

  async function refreshExistingManuscript(slug: string, driveId: string) {
    const meta = await drive.getMetadata(driveId);
    if (meta.mimeType === "application/vnd.google-apps.folder") {
      throw new HttpError(400, "That is a folder. Pick the document the book is written in.");
    }

    const text = await drive.readFileText(driveId);
    const analysis = analyseManuscript(text);
    const prior = await loadState(slug);
    const sameDraft = prior.manuscript?.driveId === driveId;
    const notes = sameDraft ? prior.manuscript?.notes ?? "" : "";
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
        epilogueHeading: analysis.epilogue?.heading,
        epilogueWords: analysis.epilogue?.wordCount,
        sections: analysis.chapters.map((section) => ({
          index: section.index,
          heading: section.heading,
          wordCount: section.wordCount,
          kind: /^	1?prologue\b/i.test(section.heading) ? "prologue" : /^\s*#{0,3}\s*chapter\b/i.test(section.heading) ? "chapter" : "section"
        })).map((section) => ({ ...section, kind: classifyManuscriptSection(section.heading) })),
        notes,
        analysedAt: new Date().toISOString()
      };
      if (!sameDraft) {
        current.manuscriptReviewed = false;
        current.writingConfirmed = false;
      }
    });

    return { analysis, state: withDerived(state) };
  }

  /** Fill the author-facing structure from an older cached analysis without rewriting state. */
  async function hydrateExistingManuscript(slug: string, state: StudioState): Promise<StudioState> {
    if (!state.manuscript || state.manuscript.sections?.length) return state;
    try {
      const raw = await readFile(path.join(workspacePaths(slug).artifacts, "existing-manuscript.json"), "utf8");
      const cached = JSON.parse(raw) as { analysis?: { chapters?: Array<{ index: number; heading: string; wordCount: number }> } };
      const sections: ExistingManuscriptSection[] = (cached.analysis?.chapters ?? []).map((section) => ({
        index: section.index,
        heading: section.heading,
        wordCount: section.wordCount,
        kind: classifyManuscriptSection(section.heading)
      }));
      return { ...state, manuscript: { ...state.manuscript, sections } };
    } catch {
      return state;
    }
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
    const edits = state.projectAnalysis.edits ?? {};
    const intake = { ...state.intake };
    const context = {
      shape: state.shape,
      draftingMode: state.draftingMode,
      intake,
      existingDraft: Boolean(state.manuscript),
      pastBookCount: documents.filter((document) => document.kinds.includes("past_book")).length,
      authorNotes: state.projectAnalysis.authorNotes ?? ""
    };
    const corrected = applyAnalysisEdits(analyseProjectMaterial(documents, context), edits);
    const audience = corrected.findings.audience?.value.replace(/\s*\/\s*/g, "|");
    const intimacy = corrected.findings.intimacy?.value;
    if (audience && !intake.audience) intake.audience = audience;
    if (intimacy && !intake.spice) intake.spice = intimacy;
    context.intake = intake;
    // The gaps depend on the prefilled intake, so they are derived last.
    const analysis = deriveAnalysisGaps(corrected, context);

    const paths = workspacePaths(slug);
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(path.join(paths.artifacts, "project-analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
    const next = await updateState(slug, (current) => {
      current.projectAnalysis = { ...analysis, completed: true, continuedAt: null };
      // A measured value only prefills; a correction is the author's answer.
      const apply = (key: string, value: string | null | undefined, edited: boolean) => {
        if (edited) {
          if (value) current.intake[key] = value;
          else delete current.intake[key];
        } else if (value && !current.intake[key]) current.intake[key] = value;
      };
      apply("genre", analysis.genre, edits.genre !== undefined);
      apply("subgenre", analysis.subgenre, edits.subgenre !== undefined);
      apply("audience", audience, edits.findings?.audience !== undefined);
      apply("spice", intimacy, edits.findings?.intimacy !== undefined);
    });
    await writeDecisionLog(slug);
    await logPhase(slug, "intake_analysis", "Project analysis", "analysis_complete", {
      documents: analysis.documentsRead,
      questions: analysis.questionPlan.length
    });
    return { analysis, state: withDerived(next) };
  }

  async function writeFormattingReference(slug: string, state: StudioState): Promise<void> {
    const documents: Array<{ source: string; text: string }> = [];
    for (const source of state.sources) {
      // Older Drive caches were plain text exports, so refresh only this
      // formatting measurement from the selected files when Drive is in use.
      const text = state.resourceMethod === "drive"
        ? await drive.readFileText(source.driveId).catch(() => readCached(slug, source.driveId))
        : await readCached(slug, source.driveId);
      if (text) documents.push({ source: source.name, text });
    }
    if (!documents.length) return;
    const paths = workspacePaths(slug);
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(
      path.join(paths.artifacts, "formatting-references.md"),
      renderFormattingReference(measureFormatting(documents)),
      "utf8"
    );
  }

  async function launchRuntime(slug: string, state: StudioState, options: { chapter: number | null; note?: string; role?: "analysis" | "drafting"; resumeSessionId?: string | null; authMethod?: "subscription" | "api_key" | null }) {
    if (isRunning()) throw new HttpError(409, "A run is already in progress.");
    if (pendingOutcome) {
      await pendingOutcome;
      pendingOutcome = null;
    }
    explicitlyHalted.delete(slug);
    await writeFormattingReference(slug, state);
    await resolveFixedRuntimeErrors(slug);
    const role = options.role ?? "drafting";
    const provider = role === "analysis"
      ? state.engine.analysisProvider ?? state.engine.provider
      : state.engine.draftingProvider ?? state.engine.provider;
    const authMethod = options.authMethod ?? (role === "analysis"
      ? state.engine.analysisAuthMethod ?? state.engine.authMethod
      : state.engine.draftingAuthMethod ?? state.engine.authMethod);
    if (!provider) throw new HttpError(400, "Choose a writing engine first.");

    const resolvedModels = resolveModels(await loadCatalog(), state.engine);
    const model = (role === "analysis" ? resolvedModels.analysis : resolvedModels.drafting) ?? null;
    const chapter = role === "analysis" ? null : options.chapter ?? nextChapterHint(state);
    let started: { runtime: RuntimeId; command: string };
    try {
      started = startRun({
        slug,
        projectName: state.projectName,
        provider,
        authMethod,
        model,
        chapter,
        note: options.note,
        resumeSessionId: options.resumeSessionId,
        onProgress: (progress) => {
          phaseLogQueue = phaseLogQueue.then(() => appendLog(slug, "phase", {
            timestamp: new Date().toISOString(),
            stage: "chapter_drafting",
            stageName: progress.label,
            agent: "book-orchestrator",
            event: "progress",
            message: progress.detail,
            data: { phase: progress.phase, percent: progress.percent, chapter: progress.chapter }
          })).catch(() => undefined);
        },
        onEvent: (event) => {
          phaseLogQueue = phaseLogQueue.then(() => appendLog(slug, "phase", {
            timestamp: event.at,
            stage: "chapter_drafting",
            stageName: role === "analysis" ? "Preparation" : "Drafting",
            agent: "book-orchestrator",
            event: "runtime_message",
            message: event.text,
            data: { seq: event.seq, kind: event.kind }
          })).catch(() => undefined);
        },
        onExit: (outcome) => {
          pendingOutcome = recordRunOutcome(slug, outcome);
          void pendingOutcome;
        }
      });
    } catch (error) {
      throw new HttpError(400, message(error));
    }
    await phaseLogQueue;

    const next = await updateState(slug, (current) => {
      current.run = {
        status: "running",
        role,
        chapter,
        reason: null,
        detail: null,
        haltedAt: null,
        startedAt: new Date().toISOString(),
        providerSessionId: options.resumeSessionId ?? null
      };
    });
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "chapter_drafting",
      stageName: role === "analysis" ? "Preparation" : "Drafting",
      agent: started.runtime,
      event: "run_started",
      data: { model, chapter, draftingMode: state.draftingMode, role }
    });

    return { ...withDerived(next), runtime: started.runtime, runtimeLabel: runtimeLabel(started.runtime), model };
  }

  function nextChapterHint(state: StudioState): number | null {
    const nextPlanned = state.chapters.find((chapter) => chapter.status !== "approved");
    if (nextPlanned) return nextPlanned.number;
    if (!state.manuscript) return null;
    return state.manuscript.lastChapterComplete
      ? state.manuscript.chapterCount + 1
      : state.manuscript.chapterCount;
  }

  type OutputKind = "book" | "chapter";
  interface OutputFile {
    kind: OutputKind;
    format: "md" | "docx" | "pdf";
    chapter: number | null;
    label: string;
    fileName: string;
    path: string;
  }

  function formattingFollowsDirections(state: StudioState, number: number, markdown: string): boolean {
    const directions = state.directions
      .filter((direction) => direction.scope === "book" || direction.chapter === number)
      .map((direction) => direction.text.toLowerCase());
    const requiresBoldDialogue = directions.some((text) => /bold.*dialog|dialog.*bold/.test(text));
    const requiresItalicThoughts = directions.some((text) => /italic.*thought|thought.*italic/.test(text));
    if (!requiresBoldDialogue && !requiresItalicThoughts) return true;

    const observation = measureFormatting([{ source: `chapter-${number}`, text: markdown }])[0];
    if (requiresBoldDialogue && observation.dialogueCount > 0 && observation.boldDialogueCount < observation.dialogueCount) return false;
    if (requiresItalicThoughts && observation.italicCount === 0) return false;
    return true;
  }

  async function finalChapterMarkdownPath(slug: string, state: StudioState, number: number): Promise<string | null> {
    const chapterDirectory = workspacePaths(slug).chapters;
    const padded = String(number).padStart(2, "0");
    const markdownPath = [`chapter-${padded}-edited.md`, `chapter-${number}-edited.md`]
      .map((name) => path.join(chapterDirectory, name))
      .find((candidate) => existsSync(candidate));
    if (!markdownPath) return null;

    const validationPath = [`chapter-${padded}-validation.md`, `chapter-${number}-validation.md`, `chapter-${padded}-validation.json`, `chapter-${number}-validation.json`]
      .map((name) => path.join(chapterDirectory, name))
      .find((candidate) => existsSync(candidate));
    if (!validationPath) return null;

    const markdown = await readFile(markdownPath, "utf8");
    if (!formattingFollowsDirections(state, number, markdown)) return null;
    const validation = await readFile(validationPath, "utf8");
    let passed = /(?:^|\n)\s*Transition:\s*pass_(?:chapter_by_chapter|whole_book)\b/i.test(validation);
    if (!passed && validationPath.endsWith(".json")) {
      try {
        const report = JSON.parse(validation) as { transition?: unknown; result?: { transition?: unknown } };
        const transition = report.transition ?? report.result?.transition;
        passed = transition === "pass_chapter_by_chapter" || transition === "pass_whole_book";
      } catch { /* an unreadable report cannot open the output gate */ }
    }
    if (!passed) return null;

    // A halted or active run must not expose an edited file it changed after starting.
    if (state.run.chapter === number && state.run.status !== "complete" && state.run.startedAt) {
      const startedAt = Date.parse(state.run.startedAt);
      if (Number.isFinite(startedAt) && (await stat(markdownPath)).mtimeMs >= startedAt) return null;
    }
    return markdownPath;
  }

  async function resolveOutput(slug: string, state: StudioState, kind: OutputKind, format: "md" | "docx" | "pdf", requestedChapter?: number): Promise<OutputFile | null> {
    const paths = workspacePaths(slug);
    if (kind === "book") {
      const fileName = format === "docx" ? "manuscript.docx" : format === "pdf" ? "manuscript.pdf" : "manuscript.md";
      const filePath = path.join(paths.final, fileName);
      if (format === "docx") {
        const markdownPath = path.join(paths.final, "manuscript.md");
        if (existsSync(markdownPath)) await generateMarkdownDocx(await readFile(markdownPath, "utf8"), filePath);
      }
      if (format === "pdf") {
        const markdownPath = path.join(paths.final, "manuscript.md");
        if (existsSync(markdownPath)) await generateMarkdownPdf(await readFile(markdownPath, "utf8"), filePath);
      }
      return existsSync(filePath) ? { kind, format, chapter: null, label: "Final manuscript", fileName, path: filePath } : null;
    }
    const numbers = new Set<number>();
    if (requestedChapter && Number.isInteger(requestedChapter)) numbers.add(requestedChapter);
    else {
      if (state.run.chapter) numbers.add(state.run.chapter);
      for (const chapter of state.chapters) numbers.add(chapter.number);
    }
    if (!requestedChapter) {
      try {
        for (const name of await readdir(paths.chapters)) {
          const match = /^chapter-(\d+)-(?:draft|edited)\.md$/i.exec(name);
          if (match) numbers.add(Number(match[1]));
        }
      } catch { /* no chapter artifacts yet */ }
    }

    for (const number of [...numbers].sort((a, b) => b - a)) {
      const markdownPath = await finalChapterMarkdownPath(slug, state, number);
      if (!markdownPath) continue;
      const markdownName = path.basename(markdownPath);
      if (format === "md") return { kind, format, chapter: number, label: `Chapter ${number}`, fileName: markdownName, path: path.join(paths.chapters, markdownName) };
       const outputName = markdownName.replace(/\.md$/i, format === "docx" ? ".docx" : ".pdf");
       const outputPath = path.join(paths.chapters, outputName);
       if (format === "docx") await generateMarkdownDocx(await readFile(markdownPath, "utf8"), outputPath);
       else await generateMarkdownPdf(await readFile(markdownPath, "utf8"), outputPath);
       return { kind, format, chapter: number, label: `Chapter ${number}`, fileName: outputName, path: outputPath };
    }
    return null;
  }

  async function allChapterOutputs(slug: string, state: StudioState): Promise<OutputFile[]> {
    const paths = workspacePaths(slug);
    const numbers = new Set<number>(state.chapters.map((chapter) => chapter.number));
    try {
      for (const name of await readdir(paths.chapters)) {
        const match = /^chapter-(\d+)-(?:draft|edited)\.md$/i.exec(name);
        if (match) numbers.add(Number(match[1]));
      }
    } catch { /* no chapter artifacts yet */ }
    const outputs: OutputFile[] = [];
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const markdown = await resolveOutput(slug, state, "chapter", "md", number);
      const docx = await resolveOutput(slug, state, "chapter", "docx", number);
      if (markdown) outputs.push(markdown);
      if (docx) outputs.push(docx);
    }
    return outputs;
  }

  async function availableOutputs(slug: string): Promise<{ primary: OutputFile | null; files: OutputFile[] }> {
    const state = await loadState(slug);
    const book = await resolveOutput(slug, state, "book", "md");
    const docx = await resolveOutput(slug, state, "book", "docx");
    const chapters = await allChapterOutputs(slug, state);
    const primary = book ?? chapters.filter((file) => file.format === "md").at(-1) ?? null;
    return { primary, files: [...[book, docx].filter((file): file is OutputFile => Boolean(file)), ...chapters] };
  }

  /**
   * A run dies with the Studio that spawned it, so a restart can find a state
   * file claiming a run that no longer exists. Say so rather than show a
   * progress panel that will never move.
   */
  async function reconcileRun(slug: string): Promise<StudioState> {
    const state = await loadState(slug);
    const phaseNeedsRepair = state.phase !== derivePhase(state);
    if (state.run.status !== "running" || isRunning()) {
      return phaseNeedsRepair ? updateState(slug, (current) => { current.phase = derivePhase(current); }) : state;
    }
    return updateState(slug, (current) => {
      current.run = {
        ...current.run,
        status: "halted",
        reason: "cancelled",
        detail: "The Studio restarted while this run was going, so the run ended with it.",
        haltedAt: new Date().toISOString()
      };
    });
  }

  async function recordRunOutcome(slug: string, outcome: RunOutcome): Promise<void> {
    try {
      await appendLog(slug, "phase", {
        timestamp: new Date().toISOString(),
        stage: "chapter_drafting",
        stageName: "Drafting",
        agent: "book-orchestrator",
        event: outcome.ok ? "run_finished" : "run_stopped",
        message: outcome.reason ?? undefined,
        data: {
          exitCode: outcome.code,
          signal: outcome.signal,
          progress: outcome.progress,
          trace: outcome.trace.map((event) => `${event.at} [${event.kind}] ${event.text}`)
        }
      });
    } catch { /* the trace is a convenience; losing it must not break the run */ }

    try {
      await updateState(slug, (current) => {
        current.run = outcome.ok
          ? { ...current.run, status: "complete", reason: null, detail: null, haltedAt: null, providerSessionId: outcome.providerSessionId }
          : {
            ...current.run,
            status: "halted",
            reason: outcome.reason ?? "other",
            detail: outcome.detail ? redactSensitiveText(outcome.detail).slice(0, 2000) : null,
            haltedAt: new Date().toISOString(),
            providerSessionId: outcome.providerSessionId
          };
      });
    } catch { /* the run is over either way; the board reloads from disk */ }

    if (!outcome.ok && outcome.reason !== "cancelled" && !explicitlyHalted.has(slug)) {
      try {
        await appendLog(slug, "error", {
          timestamp: new Date().toISOString(),
          stage: "chapter_drafting",
          stageName: "Drafting",
          agent: "runtime",
          event: "run_halted",
          errorName: outcome.reason ?? "runtime_error",
          errorMessage: `${outcome.reason ?? "other"}: ${outcome.detail ?? "The writing runtime stopped without a detail."}`,
          data: { chapter: outcome.progress?.chapter ?? null, progress: outcome.progress }
        });
      } catch { /* an error log is useful, but never prevents the board from recovering */ }
    }
    explicitlyHalted.delete(slug);
  }

  /** Clear the computed analysis while keeping what the author supplied. */
  function resetAnalysis(current: StudioState): void {
    const fresh = emptyState(current.slug, current.projectName).projectAnalysis;
    current.projectAnalysis = {
      ...fresh,
      authorNotes: current.projectAnalysis.authorNotes ?? "",
      edits: current.projectAnalysis.edits ?? {}
    };
  }

  const route = (handler: (req: express.Request, res: express.Response) => Promise<void>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch (error: unknown) {
        const status = error instanceof HttpError ? error.status : 500;
        const slug = await activeSlug().catch(() => null);
        if (slug) {
          await logError(slug, new Error(redactSensitiveText(message(error))), {
            stage: "studio_api",
            stageName: "Studio API",
            agent: "studio",
            event: "request_failed",
            data: { method: req.method, path: req.path, status }
          }).catch(() => undefined);
        }
        if (res.headersSent) return;
        res.status(status).json({ error: message(error) });
      }
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
    setTimeout(() => {
      stopRun();
      process.exit(0);
    }, 300);
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
      current.resourceMethod = null;
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
      // Changing how the book starts discards the old material, including the
      // notes and corrections that described it.
      const fresh = emptyState(slug, current.projectName);
      current.styleCorpus = fresh.styleCorpus;
      current.projectAnalysis = fresh.projectAnalysis;
      if (projectStart === "from_scratch") {
        current.drive.referenceRoots = [];
        current.drive.referenceRootNames = {};
        current.drive.targetFolderId = null;
        current.drive.targetFolderName = null;
      }
    });
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "project_start",
      stageName: "Project entry",
      agent: "author",
      event: "project_start_selected",
      data: { projectStart }
    });
    await logPhase(slug, "project_start", "Project entry", "entry_confirmed", { projectStart });
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
    const reconciled = await reconcileRun(slug);
    res.json({
      state: withDerived(await hydrateExistingManuscript(slug, reconciled)),
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
      if (nextShape !== current.shape) current.seriesOrderReviewed = false;
      current.projectName = typeof projectName === "string" && projectName.trim() ? projectName.trim() : current.projectName;
      current.shape = nextShape;
      current.draftingMode = nextMode;
      current.intake = intake && typeof intake === "object" ? { ...current.intake, ...intake } : current.intake;
    });
    if (typeof projectName === "string" && projectName.trim()) {
      await touchProject(slug, { title: projectName.trim() });
    }
    res.json(withDerived(await hydrateExistingManuscript(slug, state)));
  }));

  app.patch("/api/project/series-order", route(async (req, res) => {
    const slug = await requireSlug();
    if (!Array.isArray(req.body?.order)) throw new HttpError(400, "order must be an array of series-book ids.");
    const requested = [...new Set((req.body.order as unknown[]).map(String))] as string[];
    const state = await updateState(slug, (current) => {
      const valid = new Set(current.sources.filter((source) => source.kinds.includes("past_book")).map((source) => source.driveId));
      const order = requested.filter((id) => valid.has(id));
      current.seriesOrder = [...order, ...[...valid].filter((id) => !order.includes(id))];
      current.seriesOrderReviewed = req.body?.confirmed === true;
    });
    res.json(withDerived(state));
  }));

  app.post("/api/project/continue", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      if (!current.shape || !current.draftingMode) throw new HttpError(400, "Choose a book shape and drafting mode first.");
      const seriesIds = current.sources.filter((source) => source.kinds.includes("past_book")).map((source) => source.driveId);
      current.seriesOrder = [...(current.seriesOrder ?? []).filter((id) => seriesIds.includes(id)), ...seriesIds.filter((id) => !(current.seriesOrder ?? []).includes(id))];
      if (current.shape === "series" && seriesIds.length > 0 && !current.seriesOrderReviewed) {
        throw new HttpError(400, "Review and confirm the order of the series books first.");
      }
      current.seriesOrderReviewed = true;
      current.projectShapeReviewed = true;
    });
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "project_shape",
      stageName: "Project shape",
      agent: "author",
      event: "project_shape_confirmed",
      data: { shape: state.shape, draftingMode: state.draftingMode }
    });
    await logPhase(slug, "project_shape", "Project shape", "shape_confirmed", { shape: state.shape, draftingMode: state.draftingMode });
    res.json(withDerived(state));
  }));

  app.post("/api/project/reset-to-shape", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.shape = null;
      current.draftingMode = null;
      current.projectShapeReviewed = false;
      current.seriesOrder = [];
      current.seriesOrderReviewed = false;
      current.manuscript = null;
      current.manuscriptReviewed = false;
      current.questions = [];
      current.conversation = [];
      current.conversationStartedAt = null;
      current.writingConfirmed = false;
      resetAnalysis(current);
    });
    try {
      await unlink(path.join(workspacePaths(slug).artifacts, "project-analysis.json"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await writeDecisionLog(slug);
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "project_shape",
      stageName: "Project shape",
      agent: "author",
      event: "reset_to_project_shape"
    });
    await logPhase(slug, "project_shape", "Project shape", "reset_to_shape");
    res.json(withDerived(state));
  }));

  app.post("/api/resources/method", route(async (req, res) => {
    const slug = await requireSlug();
    const method = req.body?.method;
    if (method !== "drive" && method !== "upload") throw new HttpError(400, "Choose Drive or upload.");
    const state = await updateState(slug, (current) => {
      current.resourceMethod = method;
      if (method === "drive") {
        current.sources = current.sources.filter((source) => !source.driveId.startsWith("local-"));
        current.sourcesReviewed = false;
      } else {
        current.sources = current.sources.filter((source) => source.driveId.startsWith("local-"));
        current.sourcesReviewed = false;
      }
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
        if (routing === "split") {
          // Split mode starts with the recommended division, while the role
          // controls remain available for the author to change.
          current.engine.analysisProvider = analysisProvider ?? "openai";
          current.engine.draftingProvider = draftingProvider ?? "anthropic";
        }
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
      canWriteExisting: status.canWriteExisting ?? false,
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
        kinds: sourceKinds(classification),
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
      current.resourceMethod = "upload";
      current.sources = [...current.sources.filter((source) => !source.driveId.startsWith("local-")), ...uploaded];
      current.seriesOrder = normalizeSeriesOrder(current.seriesOrder, current.sources);
      current.seriesOrderReviewed = false;
      current.sourcesReviewed = false;
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
      resetAnalysis(current);
    });
    await writeFormattingReference(slug, state);
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
            // Series books supply canon and are voice references automatically.
            kinds: sourceKinds(classification),
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
      current.resourceMethod = "drive";
      current.sources = found.map((entry) => entry.source);
      current.seriesOrder = normalizeSeriesOrder(current.seriesOrder, current.sources);
      current.seriesOrderReviewed = false;
      current.sourcesReviewed = false;
      current.drive.lastIndexedAt = new Date().toISOString();
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
      resetAnalysis(current);
    });
    await writeFormattingReference(slug, next);

    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "source_analysis",
      stageName: "Source analysis",
      agent: "studio",
      event: "sources_indexed",
      data: { count: found.length }
    });
    await logPhase(slug, "source_analysis", "Source analysis", "sources_indexed", { count: found.length });

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
        const wasSeriesBook = source.kinds.includes("past_book");
        const wasVoiceReference = source.kinds.includes("reference_book");
        const wantsSeriesBook = kinds.includes("past_book");
        if (wantsSeriesBook && !kinds.includes("reference_book")) kinds.push("reference_book");
        if (wasSeriesBook && !wantsSeriesBook && !kinds.includes("reference_book")) kinds.push("reference_book");
        const wantsVoiceReference = kinds.includes("reference_book");
        source.kinds = kinds;
        if (!wantsVoiceReference) source.voiceReferenceConfirmed = undefined;
        else if (!wantsSeriesBook && (!wasVoiceReference || wasSeriesBook)) source.voiceReferenceConfirmed = true;
        current.seriesOrder = normalizeSeriesOrder(current.seriesOrder, current.sources);
        if (wasSeriesBook !== wantsSeriesBook) current.seriesOrderReviewed = false;
        current.styleCorpus.built = false;
        current.styleCorpus.continuedAt = null;
        resetAnalysis(current);
      }
    });
    res.json(withDerived(state));
  }));

  /** Remove a document from the current source set. */
  app.delete("/api/sources/:driveId", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      const wasSeriesBook = current.sources.find((entry) => entry.driveId === req.params.driveId)?.kinds.includes("past_book") ?? false;
      current.sources = current.sources.filter((entry) => entry.driveId !== req.params.driveId);
      current.seriesOrder = normalizeSeriesOrder(current.seriesOrder, current.sources);
      if (wasSeriesBook) current.seriesOrderReviewed = false;
      current.styleCorpus.built = false;
      current.styleCorpus.continuedAt = null;
      resetAnalysis(current);
    });
    res.json(withDerived(state));
  }));

  app.post("/api/sources/reviewed", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const check = sourcesCheck(state.sources);
    if (!check.ok) {
      throw new HttpError(400, [check.style.reason, check.plot.reason].filter(Boolean).join(" "));
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
    await writeFormattingReference(slug, state);

    if (req.body?.excluded !== undefined && !Array.isArray(req.body.excluded)) {
      throw new HttpError(400, "excluded must be an array of document ids.");
    }
    if (req.body?.notes !== undefined && typeof req.body.notes !== "string") {
      throw new HttpError(400, "notes must be text.");
    }
    const excluded: string[] = Array.isArray(req.body?.excluded)
      ? [...new Set<string>((req.body.excluded as unknown[]).map((id) => String(id)))]
      : state.styleCorpus.excluded ?? [];
    const notes = typeof req.body?.notes === "string"
      ? req.body.notes.trim().slice(0, 4000)
      : state.styleCorpus.notes ?? "";

    const kept = (kind: SourceKind) =>
      state.sources.filter((source) => source.kinds.includes(kind) && !excluded.includes(source.driveId));
    const own = kept("past_book");
    const reference = kept("reference_book").filter((source) => isVoiceReference(source.kinds, source.voiceReferenceConfirmed));
    const anyReference = state.sources.some((source) => isVoiceReference(source.kinds, source.voiceReferenceConfirmed));
    const chosen = reference;

    if (chosen.length === 0) {
      const excludedEverything = anyReference && excluded.length > 0;
      throw new HttpError(
        400,
        excludedEverything
          ? "Every document you could learn from is excluded. Include at least one before rebuilding."
          : "Nothing is marked as a voice reference. Mark the prose you want Canon Quill to study on the previous screen."
      );
    }
    if (!state.sourcesReviewed) {
      throw new HttpError(400, "Review the source grouping before building the style corpus.");
    }
    const sourceCheck = sourcesCheck(state.sources);
    if (!sourceCheck.ok) {
      throw new HttpError(400, [sourceCheck.style.reason, sourceCheck.plot.reason].filter(Boolean).join(" "));
    }

    const documents: CorpusDocument[] = [];
    for (const source of chosen) {
      const text = await readCached(slug, source.driveId);
      if (text) documents.push({ source: source.name, text });
    }

    const corpus: StyleCorpus = {
      ...buildCorpus(state.projectName, documents),
      notes,
      documentStats: documents.length ? documents.map((document) => {
        const analysis = analyseManuscript(document.text);
        return {
          source: document.source,
          wordCount: analysis.storyWords,
          chapterCount: analysis.chapters.length,
          wordsPerChapter: analysis.chapters.map((chapter) => chapter.wordCount)
        };
      }) : []
    };
    const paths = workspacePaths(slug);
    await mkdir(paths.artifacts, { recursive: true });
    await writeFile(path.join(paths.artifacts, "style-corpus.json"), JSON.stringify(corpus, null, 2), "utf8");
    await writeFile(path.join(paths.artifacts, "style-fingerprint.md"), renderFingerprint(corpus), "utf8");

    const next = await updateState(slug, (current) => {
      current.styleCorpus = {
        built: true,
        label: corpus.label,
        passageCount: corpus.passages.length,
        wordCount: corpus.fingerprint.wordCount,
        builtAt: corpus.builtAt,
        // A rebuild does not send the author back through a screen they passed.
        continuedAt: current.styleCorpus.continuedAt,
        fromReference: reference.length > 0 && own.length === 0,
        excluded,
        notes,
        documentStats: corpus.documentStats ?? []
      };
    });

    res.json({ ...withDerived(next), fingerprint: corpus.fingerprint, fromReference: reference.length > 0 && own.length === 0 });
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

  app.get("/api/preparation/status", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    res.json({ ...preparationStatus(slug), reviewed: state.preparationReviewed });
  }));

  app.get("/api/preparation/documents", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const status = preparationStatus(slug);
    const documents = await Promise.all(requiredPreparationArtifacts.map(async (name) => ({
      name,
      available: status.present.includes(name),
      content: status.present.includes(name) ? await readFile(path.join(workspacePaths(slug).artifacts, name), "utf8") : null,
      note: state.preparationNotes[name] ?? ""
    })));
    for (const document of documents) {
      if (document.content !== null) (document as { rendered?: string }).rendered = renderMarkdown(document.content);
    }
    res.json({ documents, reviewed: state.preparationReviewed, ready: status.ready, present: status.present, missing: status.missing, artifactDirectory: status.artifactDirectory });
  }));

  app.get("/api/preparation/documents/:name/view", route(async (req, res) => {
    const slug = await requireSlug();
    const name = req.params.name;
    if (!requiredPreparationArtifacts.includes(name)) throw new HttpError(404, "Unknown preparation document.");
    const filePath = path.join(workspacePaths(slug).artifacts, name);
    if (!existsSync(filePath)) throw new HttpError(404, "That preparation document is not ready yet.");
    const content = await readFile(filePath, "utf8");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(name)}</title><style>
      :root{color-scheme:light;--paper:#fffdf8;--ink:#201914;--muted:#7c6f64;--rule:#e8decf;--accent:#8f5838}
      body{margin:0;background:#eee7dc;color:var(--ink);font-family:Georgia,'Times New Roman',serif}
      header{max-width:760px;margin:0 auto;padding:24px 22px;color:var(--muted);font:12px ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}
      main{max-width:760px;margin:0 auto 60px;padding:58px clamp(24px,6vw,72px);background:var(--paper);border:1px solid var(--rule);box-shadow:0 20px 60px rgba(64,45,26,.16)}
      h1,h2,h3{font-weight:500;line-height:1.15} h1{font-size:42px;margin:0 0 34px} h2{margin-top:42px;padding-top:24px;border-top:1px solid var(--rule);color:var(--accent)}
      p,li{font-size:18px;line-height:1.78} table{width:100%;border-collapse:collapse;margin:24px 0}th,td{border:1px solid var(--rule);padding:8px 9px;text-align:left;vertical-align:top}th{background:#f3ebdf} blockquote{margin:24px 0;padding-left:20px;border-left:3px solid var(--accent);font-style:italic;color:#4c3d33}
      .toolbar{position:fixed;right:18px;top:18px;font:13px ui-sans-serif,system-ui,sans-serif}.toolbar a{display:inline-block;padding:8px 12px;border:1px solid #c8b9a7;border-radius:6px;background:#fffdf8;color:#39291e;text-decoration:none}
      @media print{body{background:white}.toolbar,header{display:none}main{margin:0;max-width:none;border:0;box-shadow:none;padding:0}p,li{font-size:12pt}}
    </style></head><body><div class="toolbar"><button onclick="window.print()">Print / Save PDF</button></div><header>Canon Quill · ${escapeHtml(name)}</header><main>${renderMarkdown(content)}</main></body></html>`);
  }));

  app.patch("/api/preparation/documents/:name", route(async (req, res) => {
    const slug = await requireSlug();
    const name = req.params.name;
    if (!requiredPreparationArtifacts.includes(name)) throw new HttpError(404, "Unknown preparation document.");
    if (typeof req.body?.note !== "string") throw new HttpError(400, "note must be text.");
    const note = req.body.note.trim().slice(0, 4000);
    const state = await updateState(slug, (current) => {
      if (note) current.preparationNotes[name] = note;
      else delete current.preparationNotes[name];
      current.preparationReviewed = false;
    });
    res.json(withDerived(state));
  }));

  app.post("/api/preparation/continue", route(async (_req, res) => {
    const slug = await requireSlug();
    const current = await loadState(slug);
    if (!current.projectAnalysis.completed || !current.projectAnalysis.continuedAt) {
      throw new HttpError(409, "Continue the project analysis before preparation.");
    }
    if (pendingPlannedQuestions(current).length > 0 || current.questions.some((question) => question.answer === undefined)) {
      throw new HttpError(409, "Finish the preparation questions first.");
    }
    const state = await updateState(slug, (next) => {
      next.conversationStartedAt ??= new Date().toISOString();
    });
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "preparation",
      stageName: "Preparation",
      agent: "author",
      event: "preparation_opened"
    });
    res.json(withDerived(state));
  }));

  app.post("/api/preparation/review", route(async (_req, res) => {
    const slug = await requireSlug();
    if (!preparationStatus(slug).ready) throw new HttpError(409, "Finish preparation before reviewing it.");
    const state = await updateState(slug, (current) => { current.preparationReviewed = true; });
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "preflight",
      stageName: "Preparation review",
      agent: "author",
      event: "preparation_reviewed"
    });
    res.json(withDerived(state));
  }));

  app.post("/api/preparation/run", route(async (req, res) => {
    const slug = await requireSlug();
    const current = await loadState(slug);
    const preparation = preparationStatus(slug);
    if (preparation.ready && current.preparationReviewed) throw new HttpError(409, "Preparation is already ready and reviewed.");
    const savedNotes = Object.entries(current.preparationNotes)
      .filter(([, note]) => note.trim())
      .map(([name]) => name);
    const noted = Array.isArray(req.body?.documents)
      ? req.body.documents.filter((name: unknown): name is string => typeof name === "string" && savedNotes.includes(name))
      : savedNotes;
    const excludedNotes = savedNotes.filter((name) => !noted.includes(name));
    const generalNote = typeof req.body?.generalNote === "string" ? req.body.generalNote.trim().slice(0, 4000) : "";
    const scope = noted.length
      ? `Only revise the selected preparation documents (${noted.join(", ")}) and documents directly affected by those notes. Preserve every other existing preparation document unchanged.`
      : generalNote
        ? "Use the author's general preparation instruction to identify only the preparation documents that need attention and preserve unrelated existing documents unchanged."
        : "There are no author document notes or general repair instructions. Create only missing preparation documents and preserve every existing document unchanged.";
    const excluded = excludedNotes.length
      ? ` Saved notes on these documents are out of scope for this run: ${excludedNotes.join(", ")}. Do not apply them now.`
      : "";
    const general = generalNote ? ` General author instruction for this run: ${generalNote}` : "";
    const started = await launchRuntime(slug, current, {
      chapter: null,
      role: "analysis",
      note: `PREPARATION_REPAIR: build or repair the preparation package from the existing project analysis, decision log, cached sources, style artifacts, and saved document notes. ${scope}${excluded}${general} Do not draft prose. Stop at preflight review once the package is complete.`
    });
    res.json(started);
  }));

  app.post("/api/intake/analyse", route(async (req, res) => {
    const slug = await requireSlug();
    const notes = req.body?.notes;
    if (notes !== undefined && typeof notes !== "string") throw new HttpError(400, "notes must be text.");
    const dropCorrections = req.body?.keepCorrections === false;
    if (notes !== undefined || dropCorrections) {
      await updateState(slug, (current) => {
        if (typeof notes === "string") current.projectAnalysis.authorNotes = notes.trim().slice(0, 4000);
        if (dropCorrections) current.projectAnalysis.edits = {};
      });
    }
    res.json(await analyseProject(slug));
  }));

  /** Correct what the analyzer got wrong. Corrections survive a rebuild. */
  app.patch("/api/intake/analysis", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    if (!state.projectAnalysis.completed) throw new HttpError(400, "Run the analysis before correcting it.");

    const body = req.body ?? {};
    if (body.clear === true) {
      await updateState(slug, (current) => void (current.projectAnalysis.edits = {}));
      res.json(await analyseProject(slug));
      return;
    }

    const edits: AnalysisEdits = { ...(state.projectAnalysis.edits ?? {}) };
    for (const key of ["genre", "subgenre"] as const) {
      if (body[key] === undefined) continue;
      if (body[key] !== null && typeof body[key] !== "string") throw new HttpError(400, `${key} must be text or null.`);
      edits[key] = typeof body[key] === "string" ? body[key].trim().slice(0, 120) : null;
    }
    if (body.findings !== undefined) {
      if (typeof body.findings !== "object" || body.findings === null || Array.isArray(body.findings)) {
        throw new HttpError(400, "findings must be an object of corrections.");
      }
      const findings = { ...(edits.findings ?? {}) };
      for (const [key, value] of Object.entries(body.findings as Record<string, unknown>)) {
        if (!findingKeys.includes(key as FindingKey)) throw new HttpError(400, `Unknown finding: ${key}`);
        if (typeof value !== "string") throw new HttpError(400, `Correction for ${key} must be text.`);
        findings[key as FindingKey] = value.trim().slice(0, 600);
      }
      edits.findings = findings;
    }
    if (!hasAnalysisEdits(edits)) throw new HttpError(400, "No corrections were sent.");
    const measured = {
      ...state.projectAnalysis,
      analysedAt: state.projectAnalysis.analysedAt ?? new Date().toISOString()
    } as ProjectAnalysis;
    const intake = { ...state.intake };
    const applyIntake = (key: string, value: string | null | undefined) => {
      if (value) intake[key] = value;
      else delete intake[key];
    };
    if (edits.genre !== undefined) applyIntake("genre", edits.genre);
    if (edits.subgenre !== undefined) applyIntake("subgenre", edits.subgenre);
    if (edits.findings?.audience !== undefined) applyIntake("audience", edits.findings.audience.replace(/\s*\/\s*/g, "|"));
    if (edits.findings?.intimacy !== undefined) applyIntake("spice", edits.findings.intimacy);
    const corrected = deriveAnalysisGaps(applyAnalysisEdits(measured, edits), {
      shape: state.shape,
      draftingMode: state.draftingMode,
      intake,
      existingDraft: Boolean(state.manuscript),
      pastBookCount: state.sources.filter((source) => source.kinds.includes("past_book")).length,
      authorNotes: state.projectAnalysis.authorNotes ?? ""
    });
    await mkdir(workspacePaths(slug).artifacts, { recursive: true });
    await writeFile(path.join(workspacePaths(slug).artifacts, "project-analysis.json"), JSON.stringify(corrected, null, 2), "utf8");
    const next = await updateState(slug, (current) => {
      current.projectAnalysis = { ...corrected, completed: true, continuedAt: null };
      current.intake = intake;
      current.questions = [];
      current.conversation = [];
      current.conversationStartedAt = null;
    });
    await writeDecisionLog(slug);
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "intake_analysis",
      stageName: "Project analysis",
      agent: "author",
      event: "analysis_corrections_saved",
      data: { findings: Object.keys(edits.findings ?? {}), genre: edits.genre !== undefined, subgenre: edits.subgenre !== undefined }
    });
    res.json({ analysis: corrected, state: withDerived(next) });
  }));

  app.post("/api/intake/analysis/continue", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      if (!current.projectAnalysis.completed) throw new HttpError(400, "Finish project analysis first.");
      current.projectAnalysis.continuedAt = new Date().toISOString();
    });
    await writeDecisionLog(slug);
    await logPhase(slug, "intake_analysis", "Project analysis", "analysis_reviewed");
    res.json(withDerived(state));
  }));

  app.post("/api/intake/reset", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await updateState(slug, (current) => {
      current.questions = [];
      current.conversation = [];
      current.conversationStartedAt = null;
      current.writingConfirmed = false;
      resetAnalysis(current);
    });
    try {
      await unlink(path.join(workspacePaths(slug).artifacts, "project-analysis.json"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await writeDecisionLog(slug);
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
    await writeDecisionLog(slug);
    await logPhase(slug, "intake", "Intake", "intake_started", { plannedQuestions: state.projectAnalysis.questionPlan.length });
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
    await writeDecisionLog(slug);
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "intake",
      stageName: "Questions",
      agent: question.askedBy,
      event: "question_asked",
      data: { key: question.key, blocking: question.blocking }
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
    await writeDecisionLog(slug);
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "intake",
      stageName: "Questions",
      agent: "author",
      event: "question_answered",
      data: { questionId: req.params.id }
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
    await writeDecisionLog(slug);
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "intake",
      stageName: "Questions",
      agent: "author",
      event: "conversation_message",
      data: { messageLength: text.length }
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
    // The gate is that no author decision is outstanding, not that a
    // conversation happened. An analysis with nothing to ask needs no intake.
    if (!current.conversationStartedAt && pendingPlannedQuestions(current).length > 0) {
      throw new HttpError(400, "Open the preparation questions first.");
    }
    const state = await updateState(slug, (current) => {
      if (blockingQuestions(current).length > 0) throw new HttpError(400, "Answer the blocking preparation questions first.");
      current.conversationStartedAt ??= new Date().toISOString();
      current.writingConfirmed = true;
    });
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "preflight",
      stageName: "Preparation gate",
      agent: "author",
      event: "writing_confirmed"
    });
    await logPhase(slug, "preflight", "Preparation gate", "writing_unlocked");
    res.json(withDerived(state));
  }));

  app.post("/api/writing/reopen", route(async (_req, res) => {
    const slug = await requireSlug();
    if (isRunning()) throw new HttpError(409, "Stop the run before reopening preparation.");
    res.json(withDerived(await updateState(slug, (current) => {
      current.writingConfirmed = false;
      current.preparationReviewed = false;
    })));
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
    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "existing_draft",
      stageName: "Existing draft",
      agent: "author",
      event: "existing_draft_skipped"
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

  async function existingSection(slug: string, state: StudioState, index: number): Promise<{ markdown: string; heading: string }> {
    if (!state.manuscript) throw new HttpError(404, "No existing draft has been selected.");
    if (!Number.isInteger(index) || index < 1) throw new HttpError(400, "Unknown draft section.");
    const cached = () => readCached(slug, state.manuscript!.driveId);
    const text = state.resourceMethod === "drive"
      ? await drive.readFileText(state.manuscript.driveId).catch(cached)
      : await cached();
    if (!text) throw new HttpError(404, "The selected draft text is not cached.");
    const analysis = analyseManuscript(text);
    const storySections = analysis.chapters.filter((candidate) => isManuscriptStoryHeading(candidate.heading));
    const section = analysis.chapters.find((candidate) => candidate.index === index && isManuscriptStoryHeading(candidate.heading))
      ?? storySections[index - 1];
    if (!section) throw new HttpError(404, "That draft section is not available.");
    const rawIndex = analysis.chapters.indexOf(section);
    const nextSection = analysis.chapters.slice(rawIndex + 1).find((candidate) => isManuscriptStoryHeading(candidate.heading));
    const nextSectionOffset = nextSection?.offset ?? analysis.epilogue?.offset ?? analysis.backMatter?.offset ?? analysis.storyEndOffset;
    return { heading: section.heading, markdown: text.slice(section.offset, nextSectionOffset).trim() };
  }

  app.get("/api/manuscript/sections/:index/view", route(async (req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const section = await existingSection(slug, state, Number(req.params.index));
    const pdfUrl = `/api/manuscript/sections/${encodeURIComponent(req.params.index)}/download?format=pdf`;
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(section.heading)}</title><style>
      :root{color-scheme:light;--paper:#fffdf8;--ink:#201914;--muted:#7c6f64;--rule:#e8decf;--accent:#8f5838}
      body{margin:0;background:#eee7dc;color:var(--ink);font-family:Georgia,'Times New Roman',serif}
      header{max-width:760px;margin:0 auto;padding:24px 22px;color:var(--muted);font:12px ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}
      main{max-width:760px;margin:0 auto 60px;padding:58px clamp(24px,6vw,72px);background:var(--paper);border:1px solid var(--rule);box-shadow:0 20px 60px rgba(64,45,26,.16)}
      h1,h2,h3{font-weight:500;line-height:1.15} h1{font-size:42px;margin:0 0 34px} h2{margin-top:42px;padding-top:24px;border-top:1px solid var(--rule);color:var(--accent)}
      p{font-size:18px;line-height:1.78;margin:0 0 1.15em} blockquote{margin:24px 0;padding-left:20px;border-left:3px solid var(--accent);font-style:italic;color:#4c3d33}
      .toolbar{position:fixed;right:18px;top:18px;font:13px ui-sans-serif,system-ui,sans-serif}.toolbar .download-button{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid #c8b9a7;border-radius:6px;background:#fffdf8;color:#39291e;text-decoration:none;cursor:pointer;box-shadow:0 1px 2px rgba(64,45,26,.08)}.toolbar .download-button:hover{border-color:#8f5838;background:#f7efe4}
      @media print{body{background:white}.toolbar,header{display:none}main{margin:0;max-width:none;border:0;box-shadow:none;padding:0}p{font-size:12pt}}
       </style></head><body><div class="toolbar"><a class="download-button" href="${escapeHtml(pdfUrl)}" download>Download</a></div><header>Canon Quill · ${escapeHtml(section.heading)}</header><main>${renderMarkdown(section.markdown)}</main></body></html>`);
  }));

  app.get("/api/manuscript/sections/:index/download", route(async (req, res) => {
    const slug = await requireSlug();
    const format = req.query.format === "pdf" ? "pdf" : req.query.format === "docx" ? "docx" : null;
    if (!format) throw new HttpError(400, "Choose DOCX or PDF.");
    const state = await loadState(slug);
    const section = await existingSection(slug, state, Number(req.params.index));
    const number = String(Number(req.params.index)).padStart(2, "0");
    const outputPath = path.join(workspacePaths(slug).chapters, `existing-section-${number}.${format}`);
    if (format === "docx") await generateMarkdownDocx(section.markdown, outputPath);
    else await generateMarkdownPdf(section.markdown, outputPath);
    res.download(outputPath, `existing-section-${number}.${format}`);
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

  app.patch("/api/directions/:id", route(async (req, res) => {
    const slug = await requireSlug();
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new HttpError(400, "An instruction is required.");
    if (text.length > 4000) throw new HttpError(400, "That is too long for an instruction. Keep it to the point.");
    const scope = req.body?.scope === "chapter" ? "chapter" : "book";
    let updated: StudioState["directions"][number] | undefined;
    const state = await updateState(slug, (current) => {
      const direction = (current.directions ?? []).find((item) => item.id === req.params.id);
      if (!direction) throw new HttpError(404, "Instruction not found.");
      if (direction.appliedAt) throw new HttpError(409, "Applied instructions are historical and cannot be edited.");
      direction.text = text;
      direction.scope = scope;
      direction.chapter = scope === "chapter" ? Number(req.body?.chapter) || undefined : undefined;
      updated = direction;
    });
    res.json({ direction: updated, state: withDerived(state) });
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
    const reasons = ["no_credit", "rate_limited", "invalid_credentials", "provider_error", "stalled", "cancelled", "other"];
    const reason = reasons.includes(req.body?.reason) ? req.body.reason : "other";
    const detail = typeof req.body?.detail === "string" ? redactSensitiveText(req.body.detail).slice(0, 2000) : null;

    const state = await updateState(slug, (current) => {
      current.run = {
        status: "halted",
        role: current.run?.role ?? null,
        chapter: Number(req.body?.chapter) || current.run?.chapter || null,
        reason,
        detail,
        haltedAt: new Date().toISOString(),
        startedAt: current.run?.startedAt ?? null,
        providerSessionId: current.run?.providerSessionId ?? null
      };
    });

    explicitlyHalted.add(slug);
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
    if (!(current.engine.draftingProvider ?? current.engine.provider)) {
      throw new HttpError(400, "Choose a writing engine first.");
    }
    await resolveFixedRuntimeErrors(slug);
    const preparation = preparationStatus(slug);
    if (!preparation.ready) {
      throw new HttpError(409, `Preparation is not ready. Missing: ${preparation.missing.join(", ")}.`);
    }
    if (!current.preparationReviewed) throw new HttpError(409, "Review the preparation documents before writing.");
    const started = await launchRuntime(slug, current, {
      chapter: Number(req.body?.chapter) || null,
      note: typeof req.body?.note === "string" ? req.body.note : undefined
    });
    res.json(started);
  }));

  app.post("/api/run/retouch", route(async (req, res) => {
    const slug = await requireSlug();
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 4000) : "";
    if (!note) throw new HttpError(400, "Describe what should be retouched.");
    const current = await loadState(slug);
    if (!current.writingConfirmed || !current.preparationReviewed) throw new HttpError(409, "Finish preparation review before retouching the book.");
    if (!preparationStatus(slug).ready) throw new HttpError(409, "Preparation is not ready.");
    if (!existsSync(path.join(workspacePaths(slug).final, "manuscript.md"))) throw new HttpError(404, "The final manuscript is not available yet.");
    if (isRunning()) throw new HttpError(409, "A run is already in progress.");
    await updateState(slug, (state) => {
      state.chapters = state.chapters.map((chapter) => ({ ...chapter, status: chapter.status === "approved" ? "needs_work" : chapter.status, updatedAt: new Date().toISOString() }));
    });
    const updated = await loadState(slug);
    const started = await launchRuntime(slug, updated, {
      chapter: null,
      note: `RETTOUCH_FINAL: revise the existing final manuscript according to the author's instruction, preserve canon and approved structure, and run the normal editing and validation gates. ${note}`
    });
    res.json(started);
  }));

  app.get("/api/run/events", route(async (_req, res) => {
    await requireSlug();
    if (!isRunning() && pendingOutcome) {
      await pendingOutcome;
      pendingOutcome = null;
    }
    res.json(runSnapshot(Number(_req.query.since) || 0));
  }));

  app.post("/api/run/stop", route(async (_req, res) => {
    const slug = await requireSlug();
    if (!stopRun()) {
      await phaseLogQueue;
      throw new HttpError(409, "Nothing is running.");
    }
    await phaseLogQueue;
    const state = await updateState(slug, (current) => {
      current.run = { ...current.run, status: "halted", reason: "cancelled", detail: null, haltedAt: new Date().toISOString() };
    });
    res.json(withDerived(state));
  }));

  app.get("/api/run/runtime", route(async (_req, res) => {
    const state = await loadState(await requireSlug());
    const role = _req.query.role === "analysis" ? "analysis" : "drafting";
    const provider = role === "analysis"
      ? state.engine.analysisProvider ?? state.engine.provider
      : state.engine.draftingProvider ?? state.engine.provider;
    const runtime = provider ? selectRuntime(provider) : null;
    const catalog = await loadCatalog();
    res.json({
      role,
      provider,
      runtime,
      label: runtime ? runtimeLabel(runtime) : null,
      model: provider ? (role === "analysis" ? resolveModels(catalog, state.engine).analysis : resolveModels(catalog, state.engine).drafting) ?? null : null,
      running: isRunning()
    });
  }));

  app.get("/api/run/estimate", route(async (_req, res) => {
    const state = await loadState(await requireSlug());
    res.json(estimateWriting(await loadCatalog(), state));
  }));

  /** Return the newest finished manuscript or chapter without exposing workspace paths. */
  app.get("/api/run/output", route(async (_req, res) => {
    const slug = await requireSlug();
    const available = await availableOutputs(slug);
    let preview: string | null = null;
    let truncated = false;
    if (available.primary) {
      const text = await readFile(available.primary.path, "utf8");
      preview = text.slice(0, 120_000);
      truncated = text.length > preview.length;
    }
    res.json({
      primary: available.primary ? {
        kind: available.primary.kind,
        format: available.primary.format,
        chapter: available.primary.chapter,
        label: available.primary.label,
        fileName: available.primary.fileName,
        preview,
        truncated,
        downloadUrl: outputDownloadUrl(available.primary)
      } : null,
      files: available.files.map((file) => ({
        kind: file.kind,
        format: file.format,
        chapter: file.chapter,
        label: file.label,
        fileName: file.fileName,
        downloadUrl: outputDownloadUrl(file)
      }))
    });
  }));

  app.get("/api/run/output/view", route(async (req, res) => {
    const slug = await requireSlug();
    const kind = req.query.kind === "book" ? "book" : req.query.kind === "chapter" ? "chapter" : null;
    if (!kind) throw new HttpError(400, "Choose a valid output.");
    const chapter = typeof req.query.chapter === "string" ? Number(req.query.chapter) : undefined;
    const file = await resolveOutput(slug, await loadState(slug), kind, "md", chapter);
    if (!file) throw new HttpError(404, "That output is not available yet.");
    const markdown = await readFile(file.path, "utf8");
    const pdfUrl = outputDownloadUrl(file, "pdf");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(file.label)}</title><style>
      :root{color-scheme:light;--paper:#fffdf8;--ink:#201914;--muted:#7c6f64;--rule:#e8decf;--accent:#8f5838}
      body{margin:0;background:#eee7dc;color:var(--ink);font-family:Georgia,'Times New Roman',serif}
      header{max-width:760px;margin:0 auto;padding:24px 22px;color:var(--muted);font:12px ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}
      main{max-width:760px;margin:0 auto 60px;padding:58px clamp(24px,6vw,72px);background:var(--paper);border:1px solid var(--rule);box-shadow:0 20px 60px rgba(64,45,26,.16)}
      h1,h2,h3{font-weight:500;line-height:1.15} h1{font-size:42px;margin:0 0 34px} h2{margin-top:42px;padding-top:24px;border-top:1px solid var(--rule);color:var(--accent)}
      p{font-size:18px;line-height:1.78;margin:0 0 1.15em} blockquote{margin:24px 0;padding-left:20px;border-left:3px solid var(--accent);font-style:italic;color:#4c3d33}
      .toolbar{position:fixed;right:18px;top:18px;font:13px ui-sans-serif,system-ui,sans-serif}.toolbar .download-button{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid #c8b9a7;border-radius:6px;background:#fffdf8;color:#39291e;text-decoration:none;cursor:pointer;box-shadow:0 1px 2px rgba(64,45,26,.08)}.toolbar .download-button:hover{border-color:#8f5838;background:#f7efe4}
      @media print{body{background:white}.toolbar,header{display:none}main{margin:0;max-width:none;border:0;box-shadow:none;padding:0}p{font-size:12pt}}
       </style></head><body><div class="toolbar"><a class="download-button" href="${escapeHtml(pdfUrl)}" download>Download</a></div><header>Canon Quill · ${escapeHtml(file.label)}</header><main>${renderMarkdown(markdown)}</main></body></html>`);
  }));

  app.get("/api/run/output/download", route(async (req, res) => {
    const slug = await requireSlug();
    const kind = req.query.kind === "book" ? "book" : req.query.kind === "chapter" ? "chapter" : null;
    const format = req.query.format === "docx" ? "docx" : req.query.format === "pdf" ? "pdf" : req.query.format === "md" ? "md" : null;
    if (!kind || !format) throw new HttpError(400, "Choose a valid output.");
    const chapter = typeof req.query.chapter === "string" ? Number(req.query.chapter) : undefined;
    const file = await resolveOutput(slug, await loadState(slug), kind, format, chapter);
    if (!file) throw new HttpError(404, "That finished output is not available yet.");
    res.download(file.path, file.fileName);
  }));

  app.post("/api/run/output/post", route(async (req, res) => {
    const slug = await requireSlug();
    const destination = req.body?.destination === "update_draft" ? "update_draft" : req.body?.destination === "target_folder" ? "target_folder" : null;
    if (!destination) throw new HttpError(400, "Choose a Drive destination.");
    const state = await loadState(slug);
    if (isRunning() || state.run.status === "running") throw new HttpError(409, "Wait for the writing run to finish before posting the book.");

    const markdown = await resolveOutput(slug, state, "book", "md");
    const docx = await resolveOutput(slug, state, "book", "docx");
    if (!markdown || !docx) throw new HttpError(404, "The complete book DOCX is not available yet.");

    let file;
    if (destination === "target_folder") {
      if (!state.drive.targetFolderId) throw new HttpError(409, "Choose a Drive target folder first.");
      const status = await driveAuthStatus();
      if (!status.authorized) throw new HttpError(409, "Connect Google Drive before posting the book.");
      file = await drive.uploadBinaryFile({
        folderId: state.drive.targetFolderId,
        name: docx.fileName,
        base64Content: (await readFile(docx.path)).toString("base64"),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        overwrite: req.body?.overwrite === true
      });
    } else {
      if (!state.manuscript) throw new HttpError(409, "There is no selected draft to update.");
      const status = await driveAuthStatus();
      if (!status.authorized || !status.canWriteExisting) {
        throw new HttpError(409, "Updating the selected Google Doc requires document write access. Reconnect with the Google Docs scope, or add the full DOCX to the target folder instead.");
      }
      const source = await drive.getMetadata(state.manuscript.driveId);
      if (source.mimeType !== "application/vnd.google-apps.document") {
        throw new HttpError(409, "The selected draft is not a Google Doc. Add the full DOCX to the target folder instead.");
      }
      file = await drive.replaceGoogleDocument(state.manuscript.driveId, await readFile(markdown.path, "utf8"));
    }

    await appendLog(slug, "audit", {
      timestamp: new Date().toISOString(),
      stage: "output_post",
      stageName: "Book output",
      agent: "author",
      event: destination === "target_folder" ? "full_docx_posted" : "selected_draft_updated",
      data: { destination, driveId: file.id, name: file.name }
    });
    res.json({ destination, file, fullBook: true });
  }));

  function outputDownloadUrl(file: OutputFile, format = file.format): string {
    const params = new URLSearchParams({ kind: file.kind, format });
    if (file.chapter) params.set("chapter", String(file.chapter));
    return `/api/run/output/download?${params.toString()}`;
  }

  /** Resume a halted run after credential checks. */
  app.post("/api/run/resume", route(async (_req, res) => {
    const slug = await requireSlug();
    const state = await loadState(slug);
    const preparationRun = state.run.role === "analysis" && !state.preparationReviewed;
    if (!preparationRun) requireWritingPhase(state);
    await resolveFixedRuntimeErrors(slug);
    const preparation = preparationStatus(slug);
    if (!preparationRun && !preparation.ready) {
      throw new HttpError(409, `Preparation is not ready. Missing: ${preparation.missing.join(", ")}.`);
    }
    if (!preparationRun && !state.preparationReviewed) throw new HttpError(409, "Review the preparation documents before writing.");

    const resumeProvider = preparationRun
      ? state.engine.analysisProvider ?? state.engine.provider
      : state.engine.draftingProvider ?? state.engine.provider;
    const resumeAuth = preparationRun
      ? state.engine.analysisAuthMethod ?? state.engine.authMethod
      : state.engine.draftingAuthMethod ?? state.engine.authMethod;
    if (resumeProvider && resumeAuth === "api_key") {
      const key = (await readApiKey(resumeProvider))
        ?? process.env[resumeProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];
      if (key) {
        const check = await verifyApiKey(resumeProvider, key);
        if (!check.ok) {
          res.status(409).json({ resumed: false, blockedBy: check });
          return;
        }
      }
    }

    // The first chapter that is not finished is where the work continues.
    const next = state.chapters.find((chapter) => chapter.status !== "approved");
    const updated = await launchRuntime(slug, state, {
      chapter: preparationRun ? null : next?.number ?? null,
      role: preparationRun ? "analysis" : "drafting",
      note: preparationRun ? "PREPARATION_REPAIR: continue preparing the package. Do not draft prose." : undefined,
      resumeSessionId: state.run.providerSessionId
    });

    res.json({ resumed: true, resumeAt: next?.number ?? null, state: updated, runtime: updated.runtime, runtimeLabel: updated.runtimeLabel, model: updated.model });
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
    stopRun();
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

const requiredPreparationArtifacts = [
  "project-brief.md",
  "book-bible.md",
  "character-bible.md",
  "world-bible.md",
  "plot-bible.md",
  "style-guide.md",
  "chapter-plan.md",
  "validation-rubric.md",
  "preparation-manifest.json"
];

function preparationStatus(slug: string): { ready: boolean; missing: string[]; present: string[]; artifactDirectory: string } {
  const artifacts = workspacePaths(slug).artifacts;
  const present = requiredPreparationArtifacts.filter((name) => existsSync(path.join(artifacts, name)));
  return {
    ready: present.length === requiredPreparationArtifacts.length,
    missing: requiredPreparationArtifacts.filter((name) => !present.includes(name)),
    present,
    artifactDirectory: `workspaces/${slug}/artifacts/`
  };
}

function sourceKinds(classification: { kind: SourceKind; suggestedKinds?: SourceKind[] }): SourceKind[] {
  const kinds = new Set<SourceKind>(classification.suggestedKinds?.length ? classification.suggestedKinds : [classification.kind]);
  if (classification.kind === "past_book") {
    kinds.add("past_book");
    kinds.add("reference_book");
  }
  return [...kinds];
}

function normalizeSeriesOrder(order: string[] | undefined, sources: SelectedSource[]): string[] {
  const seriesIds = sources.filter((source) => source.kinds.includes("past_book")).map((source) => source.driveId);
  const existing = (order ?? []).filter((id) => seriesIds.includes(id));
  return [...existing, ...seriesIds.filter((id) => !existing.includes(id))];
}

/** Minimum prose for a useful style measurement. */
const minimumStyleWords = 2000;

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
  plot: SourceRequirement;
  /** Style is being learned from voice references without a series book among them. */
  fromReference: boolean;
}

/** Validate the two source requirements that block the writing workflow. */
export function sourcesCheck(sources: SelectedSource[]): SourcesCheck {
  const seriesBooks = sources.filter((source) => source.kinds?.includes("past_book"));
  const voiceReferences = sources.filter((source) => isVoiceReference(source.kinds, source.voiceReferenceConfirmed));
  const plotSources = sources.filter((source) => source.kinds?.includes("plot"));
  const styleSources = voiceReferences;
  const fromReference = styleSources.length > 0 && seriesBooks.length === 0;

  const words = (list: SelectedSource[]) => list.reduce((total, s) => total + (s.wordCount ?? 0), 0);

  const styleWords = words(styleSources);
  const style: SourceRequirement = {
    documents: styleSources.length,
    words: styleWords,
    minWords: minimumStyleWords,
    ok: styleSources.length > 0 && styleWords >= minimumStyleWords,
      reason:
        styleSources.length === 0
        ? "Mark at least one Voice reference with 2,000 or more words."
        : styleWords < minimumStyleWords
          ? `Only ${styleWords.toLocaleString()} words to learn the voice from. Below about ${minimumStyleWords.toLocaleString()} the measurements are too noisy to steer by.`
          : ""
  };

  const plotRequirement: SourceRequirement = {
    documents: plotSources.length,
    words: words(plotSources),
    minWords: 1,
    ok: plotSources.length > 0,
    reason: plotSources.length === 0 ? "Mark at least one Plot & outline document." : ""
  };

  return {
    ok: style.ok && plotRequirement.ok,
    style,
    plot: plotRequirement,
    fromReference
  };
}

function withDerived(state: StudioState) {
  return { ...state, phase: derivePhase(state), blocking: blockingQuestions(state).length };
}

function classifyManuscriptSection(heading: string): ExistingManuscriptSection["kind"] {
  if (/^\s*#{0,3}\s*prologue\b/i.test(heading)) return "prologue";
  if (/^\s*#{0,3}\s*chapter\b/i.test(heading)) return "chapter";
  return "section";
}

function isManuscriptStoryHeading(heading: string): boolean {
  return /^\s*#{0,3}\s*(?:prologue|chapter|chapitre|capítulo|kapitel|part|epilogue|interlude)\b/i.test(heading);
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

function renderFingerprint(corpus: StyleCorpus): string {
  const { label, fingerprint, profile } = corpus;
  const passages = corpus.passages.length;
  const notes = corpus.notes?.trim();
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `# Style fingerprint: ${label}`,
    "",
    `Built from ${passages} passages, ${fingerprint.wordCount.toLocaleString()} words of your own prose.`,
    "",
    ...(notes ? [
      "## Author notes on this voice",
      "",
      "The author wrote these by hand. Where they conflict with a measured target below,",
      "follow the author.",
      "",
      notes,
      ""
    ] : []),
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

/** Planned questions the author has neither answered elsewhere nor been asked. */
function pendingPlannedQuestions(state: StudioState): IntakeQuestionPlan[] {
  return state.projectAnalysis.questionPlan.filter((candidate) =>
    !state.intake[candidate.key] && !state.questions.some((question) => question.key === candidate.key)
  );
}

function appendNextPlannedQuestion(state: StudioState, askedAt: string): void {
  const plan = pendingPlannedQuestions(state)[0];
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startStudio();
}
