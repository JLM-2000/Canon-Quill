/**
 * Quantitative prose fingerprint.
 *
 * Every number here is something a drafting model can actually be steered by
 * and a validator can actually check. "Write in the author's voice" is not
 * enforceable; "your mean sentence is 24.1 words, the author's is 13.6, and
 * they open 31% of sentences with a fragment" is.
 *
 * Nothing in this file judges quality. It measures shape. Whether a given
 * shape is good is decided by comparing a draft to the author's own corpus
 * (see `score.ts`), never against a global idea of good writing -- that
 * comparison is the entire point, and it is why the AI-isms pass had to stop
 * being a fixed word blacklist.
 */

import {
  dialogueSpans,
  dialogueTags,
  mean,
  per1k,
  percentile,
  round,
  splitParagraphs,
  stdev,
  words,
  type Paragraph
} from "./text.js";

/** Verbs that put a camera between the reader and the scene. */
const filterVerbs = [
  "saw", "watched", "noticed", "heard", "listened", "felt", "smelled", "tasted",
  "seemed", "appeared", "realized", "realised", "thought", "wondered", "knew",
  "decided", "looked", "observed", "sensed", "considered"
];

/** Neutral tags that disappear on the page. */
const invisibleTags = ["said", "asked", "replied", "answered"];

/** Tags that narrate the delivery instead of letting the line carry it. */
const ornateTags = [
  "breathed", "hissed", "growled", "purred", "chuckled", "smirked", "grinned",
  "laughed", "sneered", "spat", "murmured", "whispered", "shouted", "screamed",
  "exclaimed", "declared", "insisted", "countered", "offered", "ventured",
  "admitted", "confessed", "snapped", "barked", "drawled", "quipped"
];

/** Abstractions that tend to stand in for a rendered moment. */
const abstractNouns = [
  "silence", "darkness", "longing", "grief", "sorrow", "joy", "rage", "fear",
  "hope", "despair", "emptiness", "weight", "warmth", "tension", "presence",
  "absence", "distance", "understanding", "realization", "realisation",
  "connection", "emotion", "feeling", "moment", "energy", "atmosphere"
];

const contractionPattern = /\b[a-z]+'(?:s|t|re|ve|ll|d|m|n)\b/gi;
const similePattern = /\b(?:like a|like the|as if|as though|the way a|the way the)\b/gi;
const lyAdverbPattern = /\b[a-z]{3,}ly\b/gi;

export interface StyleMetrics {
  /** Total words measured. Fingerprints below ~2,000 words are unstable. */
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;

  sentence: {
    meanWords: number;
    medianWords: number;
    stdevWords: number;
    p10Words: number;
    p90Words: number;
    /** Share of sentences under five words -- the author's punch rate. */
    fragmentRate: number;
    /** Share of sentences over thirty words -- the author's long-line rate. */
    longRate: number;
  };

  paragraph: {
    meanWords: number;
    meanSentences: number;
    /** Share of paragraphs that are a single sentence. */
    singleSentenceRate: number;
  };

  dialogue: {
    /** Share of total words spoken inside quotes. */
    wordShare: number;
    meanLineWords: number;
    /** Share of dialogue tags that are `said`/`asked`-class. */
    invisibleTagShare: number;
    ornateTagsPer1k: number;
  };

  texture: {
    lyAdverbsPer1k: number;
    filterVerbsPer1k: number;
    abstractNounsPer1k: number;
    similesPer1k: number;
    contractionsPer1k: number;
    commasPer1k: number;
    emDashesPer1k: number;
    semicolonsPer1k: number;
    ellipsesPer1k: number;
    /** Distinct words / total words. Falls with repetition. */
    typeTokenRatio: number;
  };
}

/** The metric keys that `score.ts` compares, with human-readable labels. */
export const comparableMetrics = [
  ["sentence.meanWords", "mean sentence length"],
  ["sentence.stdevWords", "sentence length variation"],
  ["sentence.fragmentRate", "fragment rate"],
  ["sentence.longRate", "long-sentence rate"],
  ["paragraph.meanWords", "mean paragraph length"],
  ["paragraph.singleSentenceRate", "single-sentence paragraph rate"],
  ["dialogue.wordShare", "dialogue share"],
  ["dialogue.meanLineWords", "mean dialogue line length"],
  ["dialogue.invisibleTagShare", "plain dialogue tag share"],
  ["dialogue.ornateTagsPer1k", "ornate dialogue tags"],
  ["texture.lyAdverbsPer1k", "-ly adverbs"],
  ["texture.filterVerbsPer1k", "filter verbs"],
  ["texture.abstractNounsPer1k", "abstract nouns"],
  ["texture.similesPer1k", "similes"],
  ["texture.contractionsPer1k", "contractions"],
  ["texture.commasPer1k", "commas"],
  ["texture.emDashesPer1k", "em dashes"],
  ["texture.typeTokenRatio", "vocabulary variety"]
] as const satisfies ReadonlyArray<readonly [string, string]>;

export type ComparableMetric = (typeof comparableMetrics)[number][0];

/** Read a dotted metric path such as `sentence.meanWords`. */
export function readMetric(metrics: StyleMetrics, path: string): number {
  const value = path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], metrics);
  return typeof value === "number" ? value : 0;
}

export function computeMetrics(text: string): StyleMetrics {
  const paragraphs = splitParagraphs(text);
  const sentences = paragraphs.flatMap((paragraph) => paragraph.sentences);
  const allWords = words(text);
  const wordCount = allWords.length;

  const sentenceLengths = sentences.map((sentence) => sentence.words.length).filter((n) => n > 0);
  const spans = dialogueSpans(text);
  const dialogueWordCounts = spans.map((span) => words(span).length);
  const dialogueWords = dialogueWordCounts.reduce((sum, n) => sum + n, 0);

  return {
    wordCount,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,

    sentence: {
      meanWords: round(mean(sentenceLengths)),
      medianWords: round(percentile(sentenceLengths, 0.5)),
      stdevWords: round(stdev(sentenceLengths)),
      p10Words: round(percentile(sentenceLengths, 0.1)),
      p90Words: round(percentile(sentenceLengths, 0.9)),
      fragmentRate: rate(sentenceLengths.filter((n) => n < 5).length, sentenceLengths.length),
      longRate: rate(sentenceLengths.filter((n) => n > 30).length, sentenceLengths.length)
    },

    paragraph: {
      meanWords: round(mean(paragraphs.map((p) => words(p.text).length))),
      meanSentences: round(mean(paragraphs.map((p) => p.sentences.length))),
      singleSentenceRate: rate(paragraphs.filter((p) => p.sentences.length === 1).length, paragraphs.length)
    },

    dialogue: {
      wordShare: rate(dialogueWords, wordCount),
      meanLineWords: round(mean(dialogueWordCounts)),
      invisibleTagShare: tagShare(text),
      ornateTagsPer1k: per1k(countWords(allWords, ornateTags), wordCount)
    },

    texture: {
      lyAdverbsPer1k: per1k(countPattern(text, lyAdverbPattern), wordCount),
      filterVerbsPer1k: per1k(countWords(allWords, filterVerbs), wordCount),
      abstractNounsPer1k: per1k(countWords(allWords, abstractNouns), wordCount),
      similesPer1k: per1k(countPattern(text, similePattern), wordCount),
      contractionsPer1k: per1k(countPattern(text, contractionPattern), wordCount),
      commasPer1k: per1k(countChar(text, ","), wordCount),
      emDashesPer1k: per1k(countPattern(text, /—|--/g), wordCount),
      semicolonsPer1k: per1k(countChar(text, ";"), wordCount),
      ellipsesPer1k: per1k(countPattern(text, /\.\.\.|…/g), wordCount),
      typeTokenRatio: rate(new Set(allWords).size, wordCount)
    }
  };
}

/**
 * Merge per-passage metrics into one corpus fingerprint.
 *
 * Weighted by word count so a 40-word fragment cannot pull the fingerprint as
 * hard as a full chapter.
 */
export function aggregateMetrics(samples: StyleMetrics[]): StyleMetrics {
  const usable = samples.filter((sample) => sample.wordCount > 0);
  if (usable.length === 0) return computeMetrics("");
  if (usable.length === 1) return usable[0];

  const totalWords = usable.reduce((sum, sample) => sum + sample.wordCount, 0);
  const weighted = (path: string): number =>
    round(usable.reduce((sum, sample) => sum + readMetric(sample, path) * sample.wordCount, 0) / totalWords);

  return {
    wordCount: totalWords,
    sentenceCount: usable.reduce((sum, s) => sum + s.sentenceCount, 0),
    paragraphCount: usable.reduce((sum, s) => sum + s.paragraphCount, 0),
    sentence: {
      meanWords: weighted("sentence.meanWords"),
      medianWords: weighted("sentence.medianWords"),
      stdevWords: weighted("sentence.stdevWords"),
      p10Words: weighted("sentence.p10Words"),
      p90Words: weighted("sentence.p90Words"),
      fragmentRate: weighted("sentence.fragmentRate"),
      longRate: weighted("sentence.longRate")
    },
    paragraph: {
      meanWords: weighted("paragraph.meanWords"),
      meanSentences: weighted("paragraph.meanSentences"),
      singleSentenceRate: weighted("paragraph.singleSentenceRate")
    },
    dialogue: {
      wordShare: weighted("dialogue.wordShare"),
      meanLineWords: weighted("dialogue.meanLineWords"),
      invisibleTagShare: weighted("dialogue.invisibleTagShare"),
      ornateTagsPer1k: weighted("dialogue.ornateTagsPer1k")
    },
    texture: {
      lyAdverbsPer1k: weighted("texture.lyAdverbsPer1k"),
      filterVerbsPer1k: weighted("texture.filterVerbsPer1k"),
      abstractNounsPer1k: weighted("texture.abstractNounsPer1k"),
      similesPer1k: weighted("texture.similesPer1k"),
      contractionsPer1k: weighted("texture.contractionsPer1k"),
      commasPer1k: weighted("texture.commasPer1k"),
      emDashesPer1k: weighted("texture.emDashesPer1k"),
      semicolonsPer1k: weighted("texture.semicolonsPer1k"),
      ellipsesPer1k: weighted("texture.ellipsesPer1k"),
      typeTokenRatio: weighted("texture.typeTokenRatio")
    }
  };
}

function rate(part: number, whole: number): number {
  if (whole === 0) return 0;
  return round(part / whole, 3);
}

function countWords(allWords: string[], targets: string[]): number {
  const set = new Set(targets);
  return allWords.reduce((count, word) => (set.has(word) ? count + 1 : count), 0);
}

function countPattern(text: string, pattern: RegExp): number {
  return (text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) if (c === char) count += 1;
  return count;
}

/**
 * Share of dialogue tags that are plain (`said`, `asked`).
 *
 * Only counts tags adjacent to a quoted span, so narrative uses of the same
 * verbs ("she whispered to herself" outside dialogue) are not miscounted.
 * Returns 1 when there is no dialogue at all, so a description-only passage
 * never reads as a tag problem.
 */
function tagShare(text: string): number {
  const invisible = new Set(invisibleTags);
  const ornate = new Set(ornateTags);
  let plain = 0;
  let total = 0;

  for (const verb of dialogueTags(text)) {
    if (invisible.has(verb)) {
      plain += 1;
      total += 1;
    } else if (ornate.has(verb)) {
      total += 1;
    }
  }

  if (total === 0) return 1;
  return round(plain / total, 3);
}
