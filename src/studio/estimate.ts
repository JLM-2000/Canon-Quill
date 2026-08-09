import type { ModelCatalog, ModelEntry } from "./engine.js";
import type { StudioState } from "./state.js";

const PASSES_PER_CHAPTER = 3;
const TOKENS_PER_WORD = 1.33;
const INPUT_TO_OUTPUT_RATIO = 2;
const FALLBACK_CHAPTER_WORDS = 4500;

export interface WritingEstimate {
  provider: "anthropic" | "openai" | null;
  authMethod: "subscription" | "api_key" | null;
  model: string | null;
  modelLabel: string | null;
  chapters: number;
  wordsPerChapter: number;
  passesPerChapter: number;
  outputTokens: number;
  inputTokens: number;
  totalTokens: number;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  totalCostUsd: number | null;
  assumptions: string[];
}

export function estimateWriting(catalog: ModelCatalog, state: StudioState): WritingEstimate {
  const provider = state.engine.draftingProvider ?? state.engine.provider;
  const authMethod = state.engine.draftingAuthMethod ?? state.engine.authMethod;
  const resolved = resolveDraftingModel(catalog, state);
  const chapters = state.chapters.filter((chapter) => chapter.status !== "approved").length || 1;
  const wordsPerChapter = averageChapterWords(state) || FALLBACK_CHAPTER_WORDS;
  const outputTokens = Math.ceil(chapters * wordsPerChapter * PASSES_PER_CHAPTER * TOKENS_PER_WORD);
  const inputTokens = Math.ceil(outputTokens * INPUT_TO_OUTPUT_RATIO);
  const inputCostUsd = provider && resolved?.input_per_mtok != null
    ? inputTokens / 1_000_000 * resolved.input_per_mtok
    : null;
  const outputCostUsd = provider && resolved?.output_per_mtok != null
    ? outputTokens / 1_000_000 * resolved.output_per_mtok
    : null;
  const totalCostUsd = authMethod === "subscription" || inputCostUsd == null || outputCostUsd == null
    ? null
    : inputCostUsd + outputCostUsd;

  return {
    provider,
    authMethod,
    model: resolved?.id ?? null,
    modelLabel: resolved?.label ?? null,
    chapters,
    wordsPerChapter,
    passesPerChapter: PASSES_PER_CHAPTER,
    outputTokens,
    inputTokens,
    totalTokens: inputTokens + outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd,
    assumptions: [
      `${PASSES_PER_CHAPTER} runtime passes per unfinished chapter`,
      `${TOKENS_PER_WORD} tokens per prose word`,
      "Input context estimated at twice the generated-token count; actual usage varies with canon, tools, and model reasoning."
    ]
  };
}

function resolveDraftingModel(catalog: ModelCatalog, state: StudioState): ModelEntry | null {
  const provider = state.engine.draftingProvider ?? state.engine.provider;
  if (!provider) return null;
  const model = state.engine.models.drafting ?? catalog.roles.drafting?.[provider];
  return catalog.providers[provider]?.models.find((entry) => entry.id === model) ?? null;
}

function averageChapterWords(state: StudioState): number | null {
  const measured = state.styleCorpus.documentStats.flatMap((document) => document.wordsPerChapter).filter((words) => words > 0);
  const recorded = state.chapters.map((chapter) => chapter.wordCount ?? 0).filter((words) => words > 0);
  const values = measured.length ? measured : recorded;
  if (!values.length && state.manuscript?.storyWords && state.manuscript.chapterCount) {
    return Math.round(state.manuscript.storyWords / state.manuscript.chapterCount);
  }
  if (!values.length) return null;
  return Math.round(values.reduce((sum, words) => sum + words, 0) / values.length);
}
