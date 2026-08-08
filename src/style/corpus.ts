// The exemplar corpus: the author's own prose, cut into retrievable passages
// and tagged by the kind of beat each one carries.

import { computeMetrics, type StyleMetrics } from "./metrics.js";
import { dialogueSpans, isSpeechParagraph, splitParagraphs, words } from "./text.js";
import { analyseWriting, type WritingProfile } from "./profile.js";

/** The kind of narrative work a passage is doing. */
export type BeatType =
  | "dialogue"      // two or more people talking
  | "action"        // physical events, movement, violence, chase
  | "interiority"   // thought, memory, decision, emotional processing
  | "description"   // place, person, object, atmosphere
  | "transition";   // time/place shifts, summary, connective tissue

export interface Passage {
  id: string;
  /** Which book/document this came from, for provenance in prompts. */
  source: string;
  /** Position in the source, so retrieved examples can be cited. */
  index: number;
  text: string;
  beat: BeatType;
  wordCount: number;
  /** Character names detected in the passage, used to match POV at retrieval. */
  speakers: string[];
  metrics: StyleMetrics;
}

export interface StyleCorpus {
  /** Human label, e.g. "Ashfall series, books 1-3". */
  label: string;
  passages: Passage[];
  /** Weighted fingerprint across every passage. */
  fingerprint: StyleMetrics;
  profile: WritingProfile;
  builtAt: string;
}

export interface CorpusDocument {
  /** Title or filename, used as passage provenance. */
  source: string;
  text: string;
}

export interface BuildCorpusOptions {
  /** Passages shorter than this are merged forward. Default 60. */
  minWords?: number;
  /** Passages longer than this are split. Default 320. */
  maxWords?: number;
}

const actionVerbs = /\b(?:ran|run|grabbed|threw|hit|struck|pulled|pushed|slammed|kicked|jumped|dove|ducked|swung|fell|crashed|shoved|lunged|sprinted|drew|fired|swept|climbed|tore|caught|dropped|spun|staggered|stumbled|reached|seized|hauled|flung|rolled|leapt)\b/gi;
const interiorityMarkers = /\b(?:thought|wondered|remembered|realized|realised|knew|believed|hoped|feared|wanted|understood|decided|regretted|imagined|considered|suspected|recalled)\b/gi;
const transitionMarkers = /\b(?:later|afterwards?|the next (?:day|morning|week|month|year)|hours? (?:later|passed)|by (?:then|morning|evening|nightfall)|meanwhile|that (?:night|evening|afternoon)|days? (?:later|passed)|eventually|in the end)\b/gi;

/**
 * Build a style corpus from the author's past books. Front matter and
 * copyright pages skew the fingerprint, so `extractProse` strips them.
 */
export function buildCorpus(label: string, documents: CorpusDocument[], options: BuildCorpusOptions = {}): StyleCorpus {
  const minWords = options.minWords ?? 60;
  const maxWords = options.maxWords ?? 320;

  const passages: Passage[] = [];
  for (const document of documents) {
    const chunks = chunkDocument(document.text, minWords, maxWords);
    chunks.forEach((chunk, index) => {
      const wordCount = words(chunk).length;
      if (wordCount < 20) return;
      passages.push({
        id: `${slug(document.source)}-${index}`,
        source: document.source,
        index,
        text: chunk,
        beat: classifyBeat(chunk),
        wordCount,
        speakers: detectSpeakers(chunk),
        metrics: computeMetrics(chunk)
      });
    });
  }

  return {
    label,
    passages,
    fingerprint: aggregate(passages),
    profile: analyseWriting(
      passages.map((passage) => passage.text).join("\n\n"),
      passages.map((passage) => ({ text: passage.text, beat: passage.beat }))
    ),
    builtAt: new Date().toISOString()
  };
}

/**
 * Classify what a passage is doing. Categories are decided by marker density
 * rather than a single keyword, so one stray "remembered" does not turn a
 * fight into introspection.
 */
export function classifyBeat(text: string): BeatType {
  const total = words(text).length;
  if (total === 0) return "description";

  const spoken = dialogueSpans(text).reduce((sum, span) => sum + words(span).length, 0);
  if (spoken / total >= 0.3) return "dialogue";

  const perWord = (pattern: RegExp) => (text.match(pattern) ?? []).length / (total / 100);
  const action = perWord(actionVerbs);
  const interior = perWord(interiorityMarkers);
  const transition = perWord(transitionMarkers);

  if (transition >= 1.2 && total < 120) return "transition";
  if (action >= 1.5 && action > interior) return "action";
  if (interior >= 1.2) return "interiority";
  if (action >= 0.8) return "action";
  return "description";
}

/**
 * Strip markdown scaffolding and non-prose lines so the fingerprint measures
 * the book rather than its formatting.
 */
export function extractProse(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")        // YAML front matter
    .replace(/```[\s\S]*?```/g, "")               // code fences
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) return false;  // headings
      if (trimmed.startsWith(">")) return false;  // block quotes
      if (trimmed.startsWith("|")) return false;  // tables
      if (/^[-*_]{3,}$/.test(trimmed)) return false; // rules / scene breaks
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Group paragraphs into passages. Paragraph boundaries are never broken: a
 * passage cut mid-paragraph would be a poor writing example.
 */
function chunkDocument(text: string, minWords: number, maxWords: number): string[] {
  const paragraphs = splitParagraphs(extractProse(text));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  let currentIsSpeech: boolean | undefined;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    current = [];
    currentWords = 0;
    currentIsSpeech = undefined;
  };

  for (const paragraph of paragraphs) {
    const count = words(paragraph.text).length;
    if (count === 0) continue;
    const speech = isSpeechParagraph(paragraph.text);

    // A single paragraph longer than the ceiling becomes its own passage.
    if (count >= maxWords) {
      flush();
      chunks.push(paragraph.text);
      continue;
    }

    // Break at the seam between dialogue and narration. Dialogue paragraphs
    // are short, so a pure word-count rule swallows an exchange into the
    // surrounding description and the corpus ends up with no dialogue
    // exemplars to retrieve.
    if (currentIsSpeech !== undefined && speech !== currentIsSpeech && currentWords >= 25) {
      flush();
    }

    current.push(paragraph.text);
    currentWords += count;
    currentIsSpeech ??= speech;
    // A run of speech stays a run even when a beat of narration interrupts it.
    if (speech) currentIsSpeech = true;

    if (currentWords >= minWords && !speech) flush();
  }

  flush();
  return chunks;
}

/** Detect capitalised names that look like characters. */
function detectSpeakers(text: string): string[] {
  const stop = new Set([
    "the", "and", "but", "he", "she", "they", "it", "we", "you", "i", "a", "an",
    "his", "her", "their", "no", "yes", "then", "when", "what", "why", "how",
    "god", "sir", "maam", "mister", "miss", "mrs", "mr", "dr", "okay", "oh"
  ]);
  const counts = new Map<string, number>();
  const pattern = /(?<![.!?]["”]?\s)(?<!^)\b([A-Z][a-zÀ-ɏ]{2,})\b/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    if (stop.has(name.toLowerCase())) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);
}

function aggregate(passages: Passage[]): StyleMetrics {
  // Measured over the concatenated corpus rather than averaged per passage:
  // ratios like type/token only mean anything across the whole text.
  return computeMetrics(passages.map((passage) => passage.text).join("\n\n"));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "source";
}
