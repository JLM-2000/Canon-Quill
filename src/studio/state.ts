/**
 * Studio project state.
 *
 * One JSON document under `.canon-quill/state/studio.json` holding everything
 * the UI renders and the agents read. Writes are atomic (temp file + rename)
 * because the OpenCode agents and the Studio server both touch this file, and
 * a half-written state document would strand a project mid-book.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "../project/paths.js";
import type { SourceKind } from "../analysis/classify.js";
import type { ContinuityLedger } from "../continuity/ledger.js";
import { emptyLedger } from "../continuity/ledger.js";

export type ProjectShape = "standalone" | "series";
export type DraftingMode = "chapter_by_chapter" | "whole_book";

export type PhaseId =
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
  /** Assigned group. `auto` values come from the classifier. */
  kind: SourceKind;
  confidence: number;
  reasons: string[];
  /** True once the author has explicitly confirmed or corrected the group. */
  confirmedByUser: boolean;
  wordCount?: number;
}

/** A question an agent needs answered before it can proceed. */
export interface OpenQuestion {
  id: string;
  phase: PhaseId;
  /** Which agent or spec raised it. */
  askedBy: string;
  question: string;
  /** Why it matters -- shown under the question in the UI. */
  rationale?: string;
  /** Suggested answers; the UI renders these as one-click choices. */
  options?: string[];
  /** Free text allowed alongside options. */
  allowFreeText: boolean;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
  /** Blocking questions stop the pipeline; others are answered when convenient. */
  blocking: boolean;
}

export interface ChapterRecord {
  number: number;
  title: string;
  /** One-line intent from the chapter plan. */
  synopsis: string;
  status: "planned" | "drafting" | "drafted" | "editing" | "validated" | "approved" | "needs_work";
  wordCount?: number;
  /** 0-100 from the style engine. */
  styleFidelity?: number;
  flowVerdict?: "pass" | "revise" | "fail";
  issues: string[];
  updatedAt?: string;
}

export interface StudioState {
  version: 2;
  projectName: string;
  phase: PhaseId;
  shape: ProjectShape | null;
  draftingMode: DraftingMode | null;
  intake: Record<string, string>;
  drive: {
    connected: boolean;
    /** Drive folder ids the author picked as reference roots. */
    referenceRoots: string[];
    targetFolderId: string | null;
    lastIndexedAt: string | null;
  };
  sources: SelectedSource[];
  questions: OpenQuestion[];
  chapters: ChapterRecord[];
  ledger: ContinuityLedger;
  /** Fingerprint summary for the UI; full metrics live in the artifacts dir. */
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

const stateFile = () => path.join(projectPaths.state, "studio.json");

export function emptyState(projectName = "Untitled Book"): StudioState {
  const now = new Date().toISOString();
  return {
    version: 2,
    projectName,
    phase: "connect",
    shape: null,
    draftingMode: null,
    intake: {},
    drive: { connected: false, referenceRoots: [], targetFolderId: null, lastIndexedAt: null },
    sources: [],
    questions: [],
    chapters: [],
    ledger: emptyLedger(projectName, 0),
    styleCorpus: { built: false, label: "", passageCount: 0, wordCount: 0, builtAt: null },
    createdAt: now,
    updatedAt: now
  };
}

export async function loadState(): Promise<StudioState> {
  try {
    const raw = await readFile(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StudioState>;
    // Merge onto a fresh default so a state file written by an older version
    // gains new fields instead of leaving them undefined at the call site.
    return { ...emptyState(parsed.projectName ?? "Untitled Book"), ...parsed, version: 2 };
  } catch (error) {
    if (isMissing(error)) return emptyState();
    throw error;
  }
}

export async function saveState(state: StudioState): Promise<StudioState> {
  await mkdir(projectPaths.state, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const target = stateFile();
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
  await rename(temp, target);
  return next;
}

/** Read, transform, write. */
export async function updateState(mutate: (state: StudioState) => StudioState | void): Promise<StudioState> {
  const current = await loadState();
  const result = mutate(current);
  return saveState(result ?? current);
}

/**
 * Which phase the project should be in, derived from what actually exists.
 *
 * Deriving this rather than storing it means the UI cannot get stuck showing a
 * phase the data no longer supports -- the failure mode of the old
 * `current-phase.json`, which was written by whichever agent ran last and
 * silently disagreed with reality after any manual edit.
 */
export function derivePhase(state: StudioState): PhaseId {
  // Order matters: this must walk the pipeline from the earliest unmet
  // prerequisite forward. Testing intake before Drive reported "intake" on a
  // brand-new project that had not connected to anything yet.
  if (state.chapters.length > 0 && state.chapters.every((chapter) => chapter.status === "approved")) {
    return "export";
  }
  if (state.chapters.length > 0) return "writing";
  if (!state.drive.connected) return "connect";
  if (state.drive.referenceRoots.length === 0) return "sources";
  if (state.sources.length === 0) return "sources";
  if (state.sources.some((source) => !source.confirmedByUser && source.confidence < 0.6)) return "analyze";
  if (state.shape === null || state.draftingMode === null) return "intake";
  if (state.questions.some((question) => question.blocking && question.answer === undefined)) return "intake";
  if (!state.styleCorpus.built) return "preparation";
  return "preflight";
}

/** Blocking questions the pipeline is currently waiting on. */
export function blockingQuestions(state: StudioState): OpenQuestion[] {
  return state.questions.filter((question) => question.blocking && question.answer === undefined);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
