import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { SourceKind } from "../analysis/classify.js";
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
  | "preparation"
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

export interface StudioState {
  version: 3;
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
    targetFolderId: string | null;
    lastIndexedAt: string | null;
  };
  sources: SelectedSource[];
  /** The author has looked at the grouping board and moved on. */
  sourcesReviewed: boolean;
  questions: OpenQuestion[];
  chapters: ChapterRecord[];
  ledger: ContinuityLedger;
  styleCorpus: {
    built: boolean;
    label: string;
    passageCount: number;
    wordCount: number;
    builtAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export function emptyState(slug: string, projectName = "Untitled Book"): StudioState {
  const now = new Date().toISOString();
  return {
    version: 3,
    slug,
    projectName,
    phase: "engine",
    engine: { provider: null, authMethod: null, models: {} },
    shape: null,
    draftingMode: null,
    intake: {},
    drive: { connected: false, referenceRoots: [], targetFolderId: null, lastIndexedAt: null },
    sources: [],
    sourcesReviewed: false,
    questions: [],
    chapters: [],
    ledger: emptyLedger(projectName, 0),
    styleCorpus: { built: false, label: "", passageCount: 0, wordCount: 0, builtAt: null },
    createdAt: now,
    updatedAt: now
  };
}

export async function loadState(slug: string): Promise<StudioState> {
  try {
    const parsed = JSON.parse(await readFile(workspacePaths(slug).stateFile, "utf8")) as Partial<StudioState>;
    // Merged onto a fresh default so a file written by an older version gains
    // new fields rather than leaving them undefined at the call site.
    return { ...emptyState(slug, parsed.projectName ?? "Untitled Book"), ...parsed, slug, version: 3 };
  } catch (error) {
    if (isMissing(error)) return emptyState(slug);
    throw error;
  }
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
  if (state.shape === null || state.draftingMode === null) return "intake";
  if (state.questions.some((question) => question.blocking && question.answer === undefined)) return "intake";
  if (!state.styleCorpus.built) return "preparation";
  return "preflight";
}

export function blockingQuestions(state: StudioState): OpenQuestion[] {
  return state.questions.filter((question) => question.blocking && question.answer === undefined);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
