import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Classification, SourceKind } from "../analysis/classify.js";
import type { ProjectAnalysis } from "../analysis/intake.js";
import type { ContinuityLedger } from "../continuity/ledger.js";
import { emptyLedger } from "../continuity/ledger.js";
import { workspacePaths } from "../workspace/paths.js";

export type ProjectShape = "standalone" | "series";
export type DraftingMode = "chapter_by_chapter" | "whole_book";
export type ProjectStart = "from_scratch" | "with_material";
export type ResourceMethod = "drive" | "upload";
export type ProviderId = "anthropic" | "openai";
export type AuthMethod = "subscription" | "api_key";
export type EngineRouting = "single" | "split";

export type PhaseId =
  | "start"
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
  /** Analysis gap this question resolves, when it came from the intake plan. */
  key?: string;
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

export interface ChapterChatMessage {
  id: string;
  role: "author" | "agent";
  text: string;
  createdAt: string;
}

export interface ProjectAnalysisState extends Omit<ProjectAnalysis, "analysedAt"> {
  completed: boolean;
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
  /** Legacy aliases retained for agents and older state files. */
  provider: ProviderId | null;
  authMethod: AuthMethod | null;
  analysisProvider: ProviderId | null;
  analysisAuthMethod: AuthMethod | null;
  draftingProvider: ProviderId | null;
  draftingAuthMethod: AuthMethod | null;
  routing: EngineRouting;
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

/** Author instruction for the drafting agent. */
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

/** Existing manuscript and continuation policy. */
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
  /** Whether the project begins with a detailed brief or selected material. */
  projectStart: ProjectStart | null;
  startingBrief: string;
  resourceMethod: ResourceMethod | null;
  engine: EngineChoice;
  /** True after the author continues past the writing-engine screen. */
  engineReviewed: boolean;
  shape: ProjectShape | null;
  draftingMode: DraftingMode | null;
  /** True after the author continues past the project-shape screen. */
  projectShapeReviewed: boolean;
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
  chapterChats: Record<string, ChapterChatMessage[]>;
  projectAnalysis: ProjectAnalysisState;
  chapters: ChapterRecord[];
  /** Null when starting from scratch. */
  manuscript: ExistingManuscript | null;
  /** True after the author chooses a draft or explicitly starts fresh. */
  manuscriptReviewed: boolean;
  /** Explicit author confirmation that preparation is complete. */
  writingConfirmed: boolean;
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
    projectStart: null,
    startingBrief: "",
    resourceMethod: null,
    engine: {
      provider: null,
      authMethod: null,
      analysisProvider: null,
      analysisAuthMethod: null,
      draftingProvider: null,
      draftingAuthMethod: null,
      routing: "single",
      models: {}
    },
    engineReviewed: false,
    shape: null,
    draftingMode: "chapter_by_chapter",
    projectShapeReviewed: false,
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
    chapterChats: {},
    projectAnalysis: {
      completed: false,
      documentsRead: 0,
      wordsRead: 0,
      genre: null,
      subgenre: null,
      confidence: 0,
      evidence: [],
      unknowns: [],
      sourceInventory: {},
      documents: [],
      findings: {
        premise: null,
        protagonist: null,
        relationships: null,
        centralConflict: null,
        setting: null,
        timeline: null,
        structure: null,
        narration: null,
        audience: null,
        intimacy: null
      },
      questionPlan: [],
      analysedAt: null
    },
    chapters: [],
    manuscript: null,
    manuscriptReviewed: false,
    writingConfirmed: false,
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
    const base = emptyState(slug, parsed.projectName ?? "Untitled Book");
    const intake = migrateIntake({ ...base.intake, ...(parsed.intake ?? {}) });
    const merged = {
      ...base,
      ...parsed,
      slug,
      version: 7 as const,
      projectStart: parsed.projectStart ?? null,
      startingBrief: parsed.startingBrief ?? "",
      resourceMethod: parsed.resourceMethod
        ?? (parsed.sources?.some((source) => source.driveId.startsWith("local-")) ? "upload" : parsed.drive?.referenceRoots?.length ? "drive" : null),
      draftingMode: parsed.draftingMode ?? base.draftingMode,
      projectShapeReviewed: parsed.projectShapeReviewed ?? false,
      engine: {
        ...base.engine,
        ...(parsed.engine ?? {}),
        analysisProvider: parsed.engine?.analysisProvider ?? parsed.engine?.provider ?? null,
        analysisAuthMethod: parsed.engine?.analysisAuthMethod ?? parsed.engine?.authMethod ?? null,
        draftingProvider: parsed.engine?.draftingProvider ?? parsed.engine?.provider ?? null,
        draftingAuthMethod: parsed.engine?.draftingAuthMethod ?? parsed.engine?.authMethod ?? null,
        routing: parsed.engine?.routing === "split" ? ("split" as const) : ("single" as const),
        models: { ...base.engine.models, ...(parsed.engine?.models ?? {}) }
      },
      engineReviewed: parsed.engineReviewed ?? false,
      intake,
      drive: { ...base.drive, ...(parsed.drive ?? {}) },
      projectAnalysis: { ...base.projectAnalysis, ...(parsed.projectAnalysis ?? {}) },
      chapterChats: parsed.chapterChats ?? {},
      manuscriptReviewed: parsed.manuscriptReviewed ?? Boolean(parsed.manuscript),
      writingConfirmed: parsed.writingConfirmed ?? Boolean(parsed.chapters?.length),
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
  const storedPov = /^(.+?),\s*(past|present|mixed)$/i.exec(next.pov ?? "");
  if (storedPov) {
    next.pov = storedPov[1].trim();
    next.tense = labelCase(storedPov[2]);
  } else if (next.tense) {
    next.tense = labelCase(next.tense);
  }
  return next;
}

function labelCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

/** Normalize source groups from persisted state. */
function migrateSources(sources: SelectedSource[]): SelectedSource[] {
  return (sources ?? []).map((source) => {
    if (Array.isArray(source.kinds)) return source;
    const storedKind = (source as unknown as { kind?: SourceKind }).kind;
    return { ...source, kinds: storedKind ? [storedKind] : [] };
  });
}

export async function saveState(state: StudioState): Promise<StudioState> {
  const paths = workspacePaths(state.slug);
  await mkdir(paths.root, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  // Atomic replacement protects concurrent Studio and agent writes.
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

/** Derive the phase from persisted work. */
export function derivePhase(state: StudioState): PhaseId {
  if (state.chapters.length > 0 && !state.writingConfirmed) return "preflight";
  if (state.chapters.length > 0 && state.chapters.every((chapter) => chapter.status === "approved")) {
    return "export";
  }
  if (state.chapters.length > 0) return "writing";
  const draftingProvider = state.engine.draftingProvider ?? state.engine.provider;
  const draftingAuth = state.engine.draftingAuthMethod ?? state.engine.authMethod;
  const analysisProvider = state.engine.analysisProvider ?? draftingProvider;
  const analysisAuth = state.engine.analysisAuthMethod ?? draftingAuth;
  if (!state.projectStart && !draftingProvider && !analysisProvider) return "start";
  // A project created by an older Studio may already have engine choices but
  // no entry marker. Keep the author on the engine screen until that legacy
  // state is migrated, rather than sending them back to the first screen.
  if (!state.projectStart) return "engine";
  if (!draftingProvider || !draftingAuth || !analysisProvider || !analysisAuth || !state.engineReviewed) return "engine";
  if (state.projectStart === "with_material") {
    const hasLocalSources = state.sources.some((source) => source.driveId.startsWith("local-"));
    if (state.resourceMethod === "upload" && !hasLocalSources) return "connect";
    if (!state.resourceMethod) return "connect";
    if (!state.drive.connected && !hasLocalSources) return "connect";
    if (state.drive.referenceRoots.length === 0 && !hasLocalSources) return "sources";
    if (state.sources.length === 0) return "sources";
    if (!state.sourcesReviewed) return "analyze";
  }
  if (blockingQuestions(state).length > 0) return "preflight";
  if (state.shape === null || state.draftingMode === null || !state.projectShapeReviewed) return "intake";
  if (!state.manuscriptReviewed) return "draft";
  const hasOwnStyle = state.sources.some((source) => source.kinds.includes("past_book"));
  if (hasOwnStyle && !state.styleCorpus.built) return "preparation";
  if (hasOwnStyle && !state.styleCorpus.continuedAt) return "preparation";
  if (!state.projectAnalysis.completed) return "intake_analysis";
  if (!state.conversationStartedAt && state.questions.length === 0) return "preflight";
  if (!state.writingConfirmed) return "preflight";
  return "writing";
}

export function blockingQuestions(state: StudioState): OpenQuestion[] {
  return state.questions.filter((question) => question.blocking && question.answer === undefined);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
