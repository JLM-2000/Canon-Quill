/**
 * Exemplar retrieval.
 *
 * Given a brief for the scene about to be written, pick the passages from the
 * author's own books that are the closest precedent, and render them into a
 * prompt block. The drafting agent then writes *next to* real examples of how
 * this author handles this kind of beat, instead of from an adjective.
 *
 * Retrieval is lexical and structural rather than embedding-based, on purpose:
 * it needs no model call, no API key and no index build, it is deterministic
 * across runs, and for "find me passages of the same beat with these
 * characters in them" it is entirely adequate. If semantic recall ever proves
 * to be the bottleneck, this module is the only one that has to change.
 */

import type { BeatType, Passage, StyleCorpus } from "./corpus.js";
import { words } from "./text.js";

export interface SceneBrief {
  /** What kind of beat the chapter section is. */
  beat: BeatType;
  /** POV and on-page characters, matched against passage speakers. */
  characters?: string[];
  /** Free text: the beat summary from the chapter plan. */
  summary?: string;
  /** Optional register hint, e.g. "tense", "tender", "comic". */
  register?: string;
}

export interface RetrievedExemplar {
  passage: Passage;
  score: number;
  /** Why this passage was chosen, surfaced in the Studio UI. */
  reasons: string[];
}

export interface RetrieveOptions {
  /** How many exemplars to return. Default 4. */
  limit?: number;
  /** Cap on total exemplar words, to bound prompt size. Default 1200. */
  maxWords?: number;
}

/** Words too common to carry topical signal. */
const stopWords = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "from", "by", "as", "is", "was", "were", "be", "been", "it", "its",
  "he", "she", "they", "him", "her", "them", "his", "their", "that", "this",
  "these", "those", "there", "then", "than", "so", "not", "no", "do", "does",
  "did", "has", "have", "had", "will", "would", "can", "could", "up", "out",
  "into", "over", "about", "who", "what", "when", "where", "how", "all", "one"
]);

/**
 * Rank corpus passages against a scene brief.
 *
 * Scoring, highest weight first:
 *   beat match       -- an argument should be modelled on an argument
 *   character match  -- captures per-character voice, the thing that makes
 *                       every character stop sounding identical
 *   topical overlap  -- shared content words with the beat summary
 *   length fitness   -- mid-length passages make the best examples
 */
export function retrieveExemplars(
  corpus: StyleCorpus,
  brief: SceneBrief,
  options: RetrieveOptions = {}
): RetrievedExemplar[] {
  const limit = options.limit ?? 4;
  const maxWords = options.maxWords ?? 1200;

  const briefTerms = new Set(
    words(brief.summary ?? "")
      .concat(words(brief.register ?? ""))
      .filter((word) => word.length > 3 && !stopWords.has(word))
  );
  const wanted = (brief.characters ?? []).map((name) => name.toLowerCase());

  const scored = corpus.passages
    .map((passage) => score(passage, brief, briefTerms, wanted))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  // Diversify by source so all four examples do not come from one chapter of
  // one book, which would over-fit the drafter to a single scene.
  const chosen: RetrievedExemplar[] = [];
  const perSource = new Map<string, number>();
  let budget = maxWords;

  for (const pass of [1, 2]) {
    for (const entry of scored) {
      if (chosen.length >= limit) break;
      if (chosen.includes(entry)) continue;
      if (entry.passage.wordCount > budget) continue;
      const used = perSource.get(entry.passage.source) ?? 0;
      if (pass === 1 && used >= 1) continue; // first pass: one per source
      chosen.push(entry);
      perSource.set(entry.passage.source, used + 1);
      budget -= entry.passage.wordCount;
    }
    if (chosen.length >= limit) break;
  }

  return chosen;
}

function score(
  passage: Passage,
  brief: SceneBrief,
  briefTerms: Set<string>,
  wanted: string[]
): RetrievedExemplar {
  const reasons: string[] = [];
  let total = 0;

  if (passage.beat === brief.beat) {
    total += 5;
    reasons.push(`same beat type (${passage.beat})`);
  } else if (isAdjacentBeat(passage.beat, brief.beat)) {
    total += 1.5;
    reasons.push(`related beat (${passage.beat})`);
  }

  if (wanted.length > 0) {
    const speakers = passage.speakers.map((name) => name.toLowerCase());
    const matched = passage.speakers.filter((name) => wanted.includes(name.toLowerCase()));
    if (matched.length > 0) {
      total += 3 * matched.length;
      reasons.push(`features ${matched.join(", ")}`);
    } else if (speakers.length === 0 && brief.beat !== "dialogue") {
      total += 0.5; // unpeopled description is reusable across characters
    }
  }

  if (briefTerms.size > 0) {
    const passageTerms = new Set(passage.text.toLowerCase().match(/[a-zà-ÿ]{4,}/g) ?? []);
    let overlap = 0;
    for (const term of briefTerms) if (passageTerms.has(term)) overlap += 1;
    if (overlap > 0) {
      total += Math.min(overlap, 6) * 0.75;
      reasons.push(`${overlap} shared content word${overlap === 1 ? "" : "s"}`);
    }
  }

  // Prefer 80-260 word passages: long enough to show rhythm, short enough to
  // leave prompt room for several of them.
  if (passage.wordCount >= 80 && passage.wordCount <= 260) total += 1;
  else if (passage.wordCount < 40) total -= 1;

  return { passage, score: Math.round(total * 100) / 100, reasons };
}

function isAdjacentBeat(a: BeatType, b: BeatType): boolean {
  const neighbours: Record<BeatType, BeatType[]> = {
    dialogue: ["interiority"],
    action: ["description"],
    interiority: ["dialogue", "description"],
    description: ["interiority", "action"],
    transition: ["description"]
  };
  return neighbours[a]?.includes(b) ?? false;
}

/**
 * Render exemplars as a prompt block.
 *
 * The framing matters as much as the passages: the model is told to match
 * rhythm and register but explicitly forbidden from lifting content, which is
 * the failure mode when you hand a model its own author's prose.
 */
export function renderExemplarPrompt(exemplars: RetrievedExemplar[], brief: SceneBrief): string {
  if (exemplars.length === 0) {
    return [
      "## Style exemplars",
      "",
      "No exemplars matched this beat. Fall back to the measured fingerprint in",
      "`style-fingerprint.md` and stay conservative: plain dialogue tags, concrete",
      "detail, no summary of emotion."
    ].join("\n");
  }

  const blocks = exemplars.map((entry, index) => {
    const { passage } = entry;
    return [
      `### Exemplar ${index + 1} — ${passage.source} (${passage.beat}, ${passage.wordCount} words)`,
      `_Selected because: ${entry.reasons.join("; ")}._`,
      "",
      passage.text.trim()
    ].join("\n");
  });

  return [
    "## Style exemplars — the author's own prose",
    "",
    `These are real passages from the author's published work, chosen as the closest`,
    `precedent for the ${brief.beat} beat you are about to write.`,
    "",
    "**Match:** sentence rhythm and length variation, paragraph shape, how much is",
    "left unsaid, dialogue tag habits, how emotion is rendered through behaviour,",
    "and the level of sensory detail.",
    "",
    "**Never reuse:** their events, images, names, metaphors or phrasing. Borrowing",
    "content from these passages is a validation failure, not a success. You are",
    "matching a hand, not copying a page.",
    "",
    blocks.join("\n\n---\n\n")
  ].join("\n");
}
