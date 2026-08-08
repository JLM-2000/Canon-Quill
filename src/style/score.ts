/**
 * Style fidelity scoring.
 *
 * Compares a draft against the author's own fingerprint and reports where it
 * drifted, in numbers a human and an editing agent can both act on.
 *
 * This is the replacement for the old banned-word list. That list flagged
 * "whispered", "ache", "shattered" and "silence" as AI tells, which is wrong in
 * two directions at once: it fails on an author who legitimately writes those
 * words -- punishing their voice for being theirs -- and it passes prose that
 * avoids every listed word while still being unmistakably machine-written,
 * because what gives a model away is not vocabulary but *uniformity*: every
 * sentence the same length, every emotion named rather than shown, every
 * character speaking in the same register.
 *
 * So we measure the shape and compare it to the author's. A word is only
 * suspicious when the author does not use it at that rate.
 */

import {
  comparableMetrics,
  computeMetrics,
  readMetric,
  type StyleMetrics
} from "./metrics.js";
import { dialogueSpans, dialogueTags, splitParagraphs, words } from "./text.js";
import type { StyleCorpus } from "./corpus.js";

export type Severity = "blocker" | "major" | "minor";

export interface StyleDeviation {
  metric: string;
  label: string;
  draft: number;
  author: number;
  /** Relative deviation; 0.5 means the draft is 50% off the author's value. */
  drift: number;
  severity: Severity;
  direction: "above" | "below";
  /** Actionable instruction for the editing agent. */
  instruction: string;
}

export interface RepetitionFinding {
  kind: "phrase" | "sentence-opener" | "paragraph-shape" | "dialogue-tag";
  value: string;
  count: number;
  severity: Severity;
  note: string;
}

export interface StyleReport {
  /** 0-100. 100 means indistinguishable from the author on measured axes. */
  fidelity: number;
  verdict: "pass" | "revise" | "fail";
  draftMetrics: StyleMetrics;
  authorMetrics: StyleMetrics;
  deviations: StyleDeviation[];
  repetitions: RepetitionFinding[];
  /** Ordered, concrete edit instructions. */
  instructions: string[];
  notes: string[];
}

/** Metrics where drift matters most; weights feed the fidelity score. */
const weights: Record<string, number> = {
  "sentence.meanWords": 1.5,
  "sentence.stdevWords": 1.5,
  "sentence.fragmentRate": 1.2,
  "dialogue.wordShare": 1.3,
  "dialogue.invisibleTagShare": 1.2,
  "texture.filterVerbsPer1k": 1.2,
  "texture.abstractNounsPer1k": 1.3,
  "texture.lyAdverbsPer1k": 1.0
};

export interface ScoreOptions {
  /**
   * Fraction of drift tolerated before a deviation is reported.
   * Default 0.25 -- prose is not a spreadsheet and small variation is life.
   */
  tolerance?: number;
}

export function scoreAgainstCorpus(draft: string, corpus: StyleCorpus, options: ScoreOptions = {}): StyleReport {
  return scoreAgainstFingerprint(draft, corpus.fingerprint, options);
}

export function scoreAgainstFingerprint(
  draft: string,
  author: StyleMetrics,
  options: ScoreOptions = {}
): StyleReport {
  const tolerance = options.tolerance ?? 0.25;
  const draftMetrics = computeMetrics(draft);
  const notes: string[] = [];

  if (author.wordCount < 2000) {
    notes.push(
      `Author fingerprint is built from only ${author.wordCount} words. Below ~2,000 words the ` +
        `targets are noisy; treat deviations as advisory until more reference material is indexed.`
    );
  }
  if (draftMetrics.wordCount < 300) {
    notes.push(`Draft is only ${draftMetrics.wordCount} words; per-1,000-word rates are unreliable at this length.`);
  }

  const deviations: StyleDeviation[] = [];
  for (const [metric, label] of comparableMetrics) {
    const authorValue = readMetric(author, metric);
    const draftValue = readMetric(draftMetrics, metric);
    if (authorValue === 0 && draftValue === 0) continue;

    // Guard against divide-by-zero and against tiny absolute values producing
    // enormous relative drift (0.01 -> 0.03 is not a 200% style failure).
    const base = Math.max(authorValue, floorFor(metric));
    const drift = (draftValue - authorValue) / base;
    if (Math.abs(drift) < tolerance) continue;

    deviations.push({
      metric,
      label,
      draft: draftValue,
      author: authorValue,
      drift: Math.round(drift * 100) / 100,
      severity: severityFor(Math.abs(drift), weights[metric] ?? 1),
      direction: drift > 0 ? "above" : "below",
      instruction: instructionFor(metric, label, drift > 0, draftValue, authorValue)
    });
  }

  deviations.sort((a, b) => rank(b.severity) - rank(a.severity) || Math.abs(b.drift) - Math.abs(a.drift));

  const repetitions = findRepetitions(draft);
  const fidelity = computeFidelity(deviations, repetitions);

  return {
    fidelity,
    verdict: fidelity >= 80 ? "pass" : fidelity >= 60 ? "revise" : "fail",
    draftMetrics,
    authorMetrics: author,
    deviations,
    repetitions,
    instructions: buildInstructions(deviations, repetitions),
    notes
  };
}

/**
 * Detect mechanical repetition -- the strongest signal of machine authorship
 * that survives any vocabulary filter.
 */
export function findRepetitions(draft: string): RepetitionFinding[] {
  const findings: RepetitionFinding[] = [];
  const paragraphs = splitParagraphs(draft);
  const sentences = paragraphs.flatMap((paragraph) => paragraph.sentences);
  const totalWords = words(draft).length;
  if (totalWords === 0) return findings;

  // Repeated 4-grams: catches "a mixture of X and Y", "the kind of X that Y".
  const grams = new Map<string, number>();
  const tokens = words(draft);
  for (let i = 0; i + 4 <= tokens.length; i += 1) {
    const gram = tokens.slice(i, i + 4).join(" ");
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  for (const [gram, count] of grams) {
    if (count < 3) continue;
    findings.push({
      kind: "phrase",
      value: gram,
      count,
      severity: count >= 5 ? "blocker" : "major",
      note: `"${gram}" appears ${count} times. Vary or cut all but one.`
    });
  }

  // Repeated sentence openers: the "She felt... She knew... She turned..." tic.
  const openers = new Map<string, number>();
  for (const sentence of sentences) {
    const opener = sentence.words.slice(0, 2).join(" ");
    if (opener.length < 3) continue;
    openers.set(opener, (openers.get(opener) ?? 0) + 1);
  }
  const openerThreshold = Math.max(4, Math.ceil(sentences.length * 0.06));
  for (const [opener, count] of openers) {
    if (count < openerThreshold) continue;
    findings.push({
      kind: "sentence-opener",
      value: opener,
      count,
      severity: count >= openerThreshold * 1.75 ? "major" : "minor",
      note: `${count} sentences open with "${opener}". Restructure at least half.`
    });
  }

  // Uniform paragraph length: real prose varies, generated prose rarely does.
  const paragraphLengths = paragraphs.map((paragraph) => words(paragraph.text).length).filter((n) => n > 0);
  if (paragraphLengths.length >= 6) {
    const avg = paragraphLengths.reduce((a, b) => a + b, 0) / paragraphLengths.length;
    const spread = Math.sqrt(
      paragraphLengths.reduce((sum, n) => sum + (n - avg) ** 2, 0) / paragraphLengths.length
    );
    if (avg > 0 && spread / avg < 0.35) {
      findings.push({
        kind: "paragraph-shape",
        value: `${Math.round(avg)} words ±${Math.round(spread)}`,
        count: paragraphLengths.length,
        severity: "major",
        note:
          `Every paragraph is about the same length (${Math.round(avg)} words, spread ${Math.round(spread)}). ` +
          `Break the pattern: some one-line paragraphs, some long ones.`
      });
    }
  }

  // Same dialogue tag over and over.
  const tags = new Map<string, number>();
  const ignoredTags = new Set(["said", "asked", "and", "the", "he", "she", "they", "but", "it", "we", "you"]);
  for (const verb of dialogueTags(draft)) {
    if (ignoredTags.has(verb)) continue;
    tags.set(verb, (tags.get(verb) ?? 0) + 1);
  }
  for (const [tag, count] of tags) {
    if (count < 4) continue;
    findings.push({
      kind: "dialogue-tag",
      value: tag,
      count,
      severity: count >= 6 ? "major" : "minor",
      note: `"${tag}" is used as a dialogue tag ${count} times. Replace most with "said" or an action beat.`
    });
  }

  // Dialogue lines that all run to the same length -- everyone talking alike.
  const lines = dialogueSpans(draft).map((span) => words(span).length).filter((n) => n > 2);
  if (lines.length >= 8) {
    const avg = lines.reduce((a, b) => a + b, 0) / lines.length;
    const spread = Math.sqrt(lines.reduce((sum, n) => sum + (n - avg) ** 2, 0) / lines.length);
    if (avg > 0 && spread / avg < 0.4) {
      findings.push({
        kind: "paragraph-shape",
        value: `dialogue lines ~${Math.round(avg)} words`,
        count: lines.length,
        severity: "major",
        note:
          `All ${lines.length} dialogue lines are about ${Math.round(avg)} words. Characters who share a ` +
          `sentence length share a voice. Give at least two of them a clipped or a rambling register.`
      });
    }
  }

  return findings.sort((a, b) => rank(b.severity) - rank(a.severity) || b.count - a.count);
}

function floorFor(metric: string): number {
  // Rates expressed as shares need a larger floor than per-1k counts.
  if (metric.endsWith("Rate") || metric.endsWith("Share") || metric.endsWith("Ratio")) return 0.05;
  if (metric.endsWith("Per1k")) return 1.5;
  return 1;
}

function severityFor(drift: number, weight: number): Severity {
  const scaled = drift * weight;
  if (scaled >= 1.0) return "blocker";
  if (scaled >= 0.5) return "major";
  return "minor";
}

function rank(severity: Severity): number {
  return severity === "blocker" ? 3 : severity === "major" ? 2 : 1;
}

function computeFidelity(deviations: StyleDeviation[], repetitions: RepetitionFinding[]): number {
  let penalty = 0;
  for (const deviation of deviations) {
    const weight = weights[deviation.metric] ?? 1;
    penalty += Math.min(Math.abs(deviation.drift), 2) * weight * 7;
  }
  for (const repetition of repetitions) {
    penalty += repetition.severity === "blocker" ? 12 : repetition.severity === "major" ? 6 : 2;
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function instructionFor(metric: string, label: string, above: boolean, draft: number, author: number): string {
  const target = `author runs ${author}, this draft runs ${draft}`;
  const table: Record<string, [string, string]> = {
    "sentence.meanWords": [
      `Sentences are too long. Split the longest third; the author averages ${author} words (${target}).`,
      `Sentences are too clipped. Let some run and subordinate; the author averages ${author} words (${target}).`
    ],
    "sentence.stdevWords": [
      `Sentence lengths swing more than the author's. Even out the extremes (${target}).`,
      `Sentence lengths are too uniform — the clearest machine tell. Mix short punches with long runs (${target}).`
    ],
    "sentence.fragmentRate": [
      `Too many fragments; they lose force through repetition (${target}).`,
      `Too few fragments. This author punctuates beats with short lines (${target}).`
    ],
    "dialogue.wordShare": [
      `Too much of the chapter is dialogue. Convert some exchange into action and interiority (${target}).`,
      `Too little dialogue. This author carries scenes on speech; move exposition into conversation (${target}).`
    ],
    "dialogue.invisibleTagShare": [
      `Dialogue tags are too plain for this author (${target}).`,
      `Too many ornate tags doing the acting. Replace with "said" plus a physical beat (${target}).`
    ],
    "texture.filterVerbsPer1k": [
      `Too many filter verbs (saw/felt/realised) putting distance between reader and scene. Render directly (${target}).`,
      `Fewer filter verbs than the author uses; harmless, but check POV has not gone too distant (${target}).`
    ],
    "texture.abstractNounsPer1k": [
      `Abstractions (silence, weight, longing) are doing work the scene should do. Replace with what is physically happening (${target}).`,
      `Fewer abstractions than the author uses. No action needed unless the prose reads clinical (${target}).`
    ],
    "texture.lyAdverbsPer1k": [
      `Adverb-heavy. Push the meaning into stronger verbs (${target}).`,
      `Sparser adverbs than the author. Usually fine (${target}).`
    ],
    "texture.similesPer1k": [
      `Simile density is above the author's. Cut the decorative ones; keep those that reveal character (${target}).`,
      `Fewer similes than the author uses. Consider one or two in high-emotion beats (${target}).`
    ],
    "paragraph.meanWords": [
      `Paragraphs run longer than the author's. Break for pace (${target}).`,
      `Paragraphs are shorter than the author's, which can read choppy (${target}).`
    ]
  };

  const pair = table[metric];
  if (pair) return above ? pair[0] : pair[1];
  return `${label} is ${above ? "above" : "below"} the author's range (${target}).`;
}

function buildInstructions(deviations: StyleDeviation[], repetitions: RepetitionFinding[]): string[] {
  const instructions: string[] = [];
  for (const repetition of repetitions.filter((entry) => entry.severity !== "minor")) {
    instructions.push(repetition.note);
  }
  for (const deviation of deviations.filter((entry) => entry.severity !== "minor")) {
    instructions.push(deviation.instruction);
  }
  return instructions.slice(0, 12);
}

/** Render a style report as the markdown the editing agent consumes. */
export function renderStyleReport(report: StyleReport): string {
  const lines: string[] = [
    "# Style Fidelity Report",
    "",
    `**Fidelity:** ${report.fidelity}/100 — **${report.verdict.toUpperCase()}**`,
    `**Draft:** ${report.draftMetrics.wordCount} words · **Author corpus:** ${report.authorMetrics.wordCount} words`,
    ""
  ];

  if (report.notes.length > 0) {
    lines.push("> " + report.notes.join("\n> "), "");
  }

  if (report.deviations.length === 0 && report.repetitions.length === 0) {
    lines.push("No measurable drift from the author's fingerprint.", "");
    return lines.join("\n");
  }

  if (report.deviations.length > 0) {
    lines.push("## Measured drift", "", "| Metric | Author | Draft | Drift | Severity |", "|---|---:|---:|---:|---|");
    for (const deviation of report.deviations) {
      const drift = `${deviation.drift > 0 ? "+" : ""}${Math.round(deviation.drift * 100)}%`;
      lines.push(`| ${deviation.label} | ${deviation.author} | ${deviation.draft} | ${drift} | ${deviation.severity} |`);
    }
    lines.push("");
  }

  if (report.repetitions.length > 0) {
    lines.push("## Mechanical repetition", "", "| Kind | Value | Count | Severity |", "|---|---|---:|---|");
    for (const repetition of report.repetitions) {
      lines.push(`| ${repetition.kind} | ${repetition.value} | ${repetition.count} | ${repetition.severity} |`);
    }
    lines.push("");
  }

  if (report.instructions.length > 0) {
    lines.push("## Edit instructions", "");
    report.instructions.forEach((instruction, index) => lines.push(`${index + 1}. ${instruction}`));
    lines.push("");
  }

  return lines.join("\n");
}
