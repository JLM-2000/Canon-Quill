import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Classification, SourceKind } from "../analysis/classify.js";
import type { ContinuityLedger } from "../continuity/ledger.js";
import { emptyLedger } from "../continuity/ledger.js";
import { workspacePaths } from "../workspace/paths.js";

export type ProjectShape = "standalone" | "series";
export type DraftingMode = "chapter_by_chapter" | "whole_book";

export type PhaseId =
  | "engine"
  | "connect"
  | "sources"
  | "analyze"
  | "intake"
  | "draft"
  | "preparation"
  | "intake_analysis"
  | "preflight"
  | "writing"
  | "review"
  | "export"
  | "complete";

export interface SelectedSource {
  driveId: string;
  name: string;
  path: string;
  mimeType: string;
  isFolder: boolean;
  /**
   * Which groups this document belongs to. A single file can genuinely be
   * several things at once: one document holding a timeline, an outline and
   * loose notes is common, and an author's past book is both their style
   * corpus and their canon reference.
   */
  kinds: SourceKind[];
  wordCount?: number;
  /** Evidence behind the initial classification, kept for author review. */
  classification?: Classification;
}

export interface OpenQuestion {
  id: string;
  phase: PhaseId;
  askedBy: string;
  question: string;
  rationale?: string;
  options?: string[];
  allowFreeText: boolean;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
  /** Blocking questions hold the pipeline until answered. */
  blocking: boolean;
}

export interface ConversationMessage {
  id: string;
  role: "agent" | "author";
  text: string;
  questionId?: string;
  phase: PhaseId;
  createdAt: string;
}

export interface ProjectAnalysisState {
  completed: boolean;
  documentsRead: number;
  wordsRead: number;
  genre: string | null;
  subgenre: string | null;
  confidence: number;
  evidence: string[];
  unknowns: string[];
  analysedAt: string | null;
}

export interface ChapterRecord {
  number: number;
  title: string;
  synopsis: string;
  status: "planned" | "drafting" | "drafted" | "editing" | "validated" | "approved" | "needs_work";
  wordCount?: number;
  /** 0 to 100, from the style scorer. */
  styleFidelity?: number;
  flowVerdict?: "pass" | "revise" | "fail";
  issues: string[];
  updatedAt?: string;
}

/**
 * Which provider runs the writing, and how it authenticates.
 * The credential itself is never stored here, only the choice.
 */
export interface EngineChoice {
  provider: "anthropic" | "openai" | null;
  authMethod: "subscription" | "api_key" | null;
  /** Per-role model overrides. Empty means use the catalog defaults. */
  models: Record<string, string>;
}

/** Why a run stopped, when it stopped for a reason worth acting on. */
export type HaltReason =
  | "no_credit"
  | "rate_limited"
  | "invalid_credentials"
  | "provider_error"
  | "cancelled"
  | "other";

export interface RunState {
  status: "idle" | "running" | "halted" | "complete";
  /** Which chapter was in flight when it stopped. */
  chapter: number | null;
  reason: HaltReason | null;
  /** What the agent reported, verbatim. */
  detail: string | null;
  haltedAt: string | null;
  startedAt: string | null;
}

/**
 * A standing instruction from the author to the drafting agent.
 *
 * The questions inbox runs the other way, agent to author. This is the return
 * channel: mid-run corrections, a change of direction, a note that applies to
 * everything from here on. Agents read the unapplied ones before drafting.
 */
export interface Direction {
  id: string;
  text: string;
  /** `book` applies from now on; `chapter` applies to one chapter only. */
  scope: "book" | "chapter";
  chapter?: number;
  createdAt: string;
  /** Set by the agent once it has taken the instruction into account. */
  appliedAt?: string;
  /** Which chapter it was first applied to, for the record. */
  appliedTo?: number;
}

/**
 * A draft that already exists before Canon Quill is involved.
 *
 * `target` decides where new chapters land. Continuing in place keeps one
 * document, which is what most authors want; writing separately leaves the
 * original untouched, which is what they want when they are not yet sure.
 */
export interface ExistingManuscript {
  driveId: string;
  name: string;
  target: "continue" | "separate";
  totalWords: number;
  storyWords?: number;
  chapterCount: number;
  lastChapterComplete: boolean;
  completenessReason: string;
  backMatterHeading?: string;
  backMatterWords?: number;
  /** Author clarification for the continuation agent. */
  notes?: string;
  analysedAt: string;
}

export interface StudioState {
  version: 7;
  slug: string;
  projectName: string;
  phase: PhaseId;
  engine: EngineChoice;
  shape: ProjectShape | null;
  draftingMode: DraftingMode | null;
  intake: Record<string, string>;
  drive: {
    connected: boolean;
    referenceRoots: string[];
    referenceRootNames: Record<string, string>;
    targetFolderId: string | null;
    targetFolderName: string | null;
    lastIndexedAt: string | null;
  };
  sources: SelectedSource[];
  /** The author has looked at the grouping board and moved on. */
  sourcesReviewed: boolean;
  questions: OpenQuestion[];
  conversation: ConversationMessage[];
  /** Set when the author opens the intake gate for the agent. */
  conversationStartedAt: string | null;
  projectAnalysis: ProjectAnalysisState;
  chapters: ChapterRecord[];
  /** Null when starting from scratch. */
  manuscript: ExistingManuscript | null;
  /** True after the author chooses a draft or explicitly starts fresh. */
  manuscriptReviewed: boolean;
  directions: Direction[];
  run: RunState;
  ledger: ContinuityLedger;
  styleCorpus: {
    built: boolean;
    label: string;
    passageCount: number;
    wordCount: number;
    builtAt: string | null;
    /** True after the author has left the corpus screen for the questions conversation. */
    continuedAt: string | null;
    /** Built from reference prose because the author had none of their own. */
    fromReference?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export function emptyState(slug: string, projectName = "Untitled Book"): StudioState {
  const now = new Date().toISOString();
  return {
    version: 7,
    slug,
    projectName,
    phase: "engine",
    engine: { provider: null, authMethod: null, models: {} },
    shape: null,
    draftingMode: null,
    intake: {},
    drive: {
      connected: false,
      referenceRoots: [],
      referenceRootNames: {},
      targetFolderId: null,
      targetFolderName: null,
      lastIndexedAt: null
    },
    sources: [],
    sourcesReviewed: false,
    questions: [],
    conversation: [],
    conversationStartedAt: null,
    projectAnalysis: {
      completed: false,
      documentsRead: 0,
      wordsRead: 0,
      genre: null,
      subgenre: null,
      confidence: 0,
      evidence: [],
      unknowns: [],
      analysedAt: null
    },
    chapters: [],
    manuscript: null,
    manuscriptReviewed: false,
    directions: [],
    run: { status: "idle", chapter: null, reason: null, detail: null, haltedAt: null, startedAt: null },
    ledger: emptyLedger(projectName, 0),
    styleCorpus: { built: false, label: "", passageCount: 0, wordCount: 0, builtAt: null, continuedAt: null },
    createdAt: now,
    updatedAt: now
  };
}

export async function loadState(slug: string): Promise<StudioState> {
  try {
    const parsed = JSON.parse(await readFile(workspacePaths(slug).stateFile, "utf8")) as Partial<StudioState>;
    // Merged onto a fresh default so a file written by an older version gains
    // new fields rather than leaving them undefined at the call site.
    const base = emptyState(slug, parsed.projectName ?? "Untitled Book");
    const intake = migrateIntake({ ...base.intake, ...(parsed.intake ?? {}) });
    const merged = {
      ...base,
      ...parsed,
      slug,
      version: 7 as const,
      intake,
      drive: { ...base.drive, ...(parsed.drive ?? {}) },
      projectAnalysis: { ...base.projectAnalysis, ...(parsed.projectAnalysis ?? {}) },
      manuscriptReviewed: parsed.manuscriptReviewed ?? Boolean(parsed.manuscript),
      styleCorpus: { ...base.styleCorpus, ...(parsed.styleCorpus ?? {}) }
    };
    return { ...merged, sources: migrateSources(merged.sources) };
  } catch (error) {
    if (isMissing(error)) return emptyState(slug);
    throw error;
  }
}

function migrateIntake(intake: Record<string, string>): Record<string, string> {
  const next = { ...intake };
  const legacy = /^(.+?),\s*(past|present|mixed)$/i.exec(next.pov ?? "");
  if (legacy) {
    next.pov = legacy[1].trim();
    next.tense = labelCase(legacy[2]);
  } else if (next.tense) {
    next.tense = labelCase(next.tense);
  }
  return next;
}

function labelCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Sources used to carry a single `kind`. Carry those forward rather than
 * leaving an existing project with every document ungrouped.
 */
function migrateSources(sources: SelectedSource[]): SelectedSource[] {
  return (sources ?? []).map((source) => {
    if (Array.isArray(source.kinds)) return source;
    const legacy = (source as unknown as { kind?: SourceKind }).kind;
    return { ...source, kinds: legacy ? [legacy] : [] };
  });
}

export async function saveState(state: StudioState): Promise<StudioState> {
  const paths = workspacePaths(state.slug);
  await mkdir(paths.root, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  // Written via a temp file and renamed: agents and the Studio both write here,
  // and a half-written state document would strand a book mid-draft.
  const temp = `${paths.stateFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
  await rename(temp, paths.stateFile);
  return next;
}

export async function updateState(
  slug: string,
  mutate: (state: StudioState) => StudioState | void
): Promise<StudioState> {
  const current = await loadState(slug);
  return saveState(mutate(current) ?? current);
}

/**
 * Which phase a project is in, derived from what exists rather than stored.
 * Storing it let the UI show a phase the data no longer supported.
 */
export function derivePhase(state: StudioState): PhaseId {
  if (state.chapters.length > 0 && state.chapters.every((chapter) => chapter.status === "approved")) {
    return "export";
  }
  if (state.chapters.length > 0) return "writing";
  if (!state.engine.provider || !state.engine.authMethod) return "engine";
  if (!state.drive.connected) return "connect";
  if (state.drive.referenceRoots.length === 0) return "sources";
  if (state.sources.length === 0) return "sources";
  if (!state.sourcesReviewed) return "analyze";
  if (blockingQuestions(state).length > 0) return "preflight";
  if (state.shape === null || state.draftingMode === null) return "intake";
  if (!state.manuscriptReviewed) return "draft";
  if (!state.styleCorpus.built) return "preparation";
  if (!state.styleCorpus.continuedAt) return "preparation";
  if (!state.projectAnalysis.completed) return "intake_analysis";
  return "preflight";
}

export function blockingQuestions(state: StudioState): OpenQuestion[] {
  return state.questions.filter((question) => question.blocking && question.answer === undefined);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
