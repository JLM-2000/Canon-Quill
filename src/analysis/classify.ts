// Sorts a pile of Drive documents into series canon, voice references,
// character sheets, timelines, outlines and notes.
//
// Getting this wrong is expensive: another author's novel filed as a past
// series book feeds their prose into the style fingerprint and their facts into
// canon. So every result carries a confidence and its evidence, and anything
// uncertain is surfaced for confirmation rather than assumed.

import { dialogueSpans, splitParagraphs, words } from "../style/text.js";

export type SourceKind =
  | "past_book"        // an earlier book in this series: canon and continuity
  | "reference_book"   // prose or material explicitly chosen as a voice reference
  | "characters"       // character sheets, cast lists, bibles
  | "timeline"         // chronology, event ordering
  | "world"            // setting, magic system, geography, factions
  | "plot"             // outlines, synopses, beat sheets
  | "notes";           // everything else

export interface Classification {
  kind: SourceKind;
  /** 0 to 1. Below `reviewThreshold` the UI asks for confirmation. */
  confidence: number;
  /** Evidence shown in the Studio grouping board. */
  reasons: string[];
  /** Runner-up, offered as a one-click correction. */
  alternative?: SourceKind;
  /** Additional groups strongly supported by the same document. */
  suggestedKinds?: SourceKind[];
}

export interface ClassifyInput {
  /** File name including extension. */
  name: string;
  /** Folder path within the selection, if known. Strong signal. */
  path?: string;
  /** File contents. A prefix of a few thousand words is enough. */
  text: string;
}

/** Classifications below this confidence should be confirmed by the author. */
export const reviewThreshold = 0.6;

/**
 * What a single document *is*, used on the group chips, so these read in the
 * singular: a chip says "this document is a series book". The ids stay as they
 * are; only the wording changes.
 */
export const sourceKindLabels: Record<SourceKind, string> = {
  past_book: "Series book",
  reference_book: "Voice reference",
  characters: "Character sheet",
  timeline: "Timeline",
  world: "Worldbuilding",
  plot: "Plot & outline",
  notes: "Notes"
};

/**
 * How to name a count of documents in each group. Several of these are mass
 * nouns that read the same either way, so the pair is explicit rather than
 * derived by appending an s.
 */
/** One line on what each group does, shown as help under the chips. */
export const sourceKindPurpose: Record<SourceKind, string> = {
  past_book:
    "An earlier book in this series. Its ordered events, character knowledge and unresolved threads become canon.",
  reference_book: "Prose you explicitly want Canon Quill to study for voice. The voice gate requires at least 2,000 words; do not use comparison titles by another author.",
  characters: "Who exists, what they want, what they look like.",
  timeline: "What happened when.",
  world: "Setting, factions, rules of the world.",
  plot: "Outlines, synopses, beat sheets.",
  notes: "Everything else worth keeping to hand."
};

export const sourceKindCounts: Record<SourceKind, { one: string; many: string }> = {
  past_book: { one: "Series book", many: "Series books" },
  reference_book: { one: "Voice reference", many: "Voice references" },
  characters: { one: "Character sheet", many: "Character sheets" },
  timeline: { one: "Timeline", many: "Timelines" },
  world: { one: "Worldbuilding", many: "Worldbuilding" },
  plot: { one: "Plot & outline", many: "Plot & outlines" },
  notes: { one: "Note", many: "Notes" }
};

/** Planning files can inform canon, but should not distort prose measurement. */
export const planningSourceKinds: SourceKind[] = ["characters", "timeline", "world", "plot", "notes"];

/** A voice reference must be explicitly selected and contain prose rather than only planning material. */
export function isVoiceReference(kinds: SourceKind[] | undefined, explicitlyConfirmed = false): boolean {
  if (!kinds?.includes("reference_book")) return false;
  if (kinds.includes("past_book")) return true;
  return explicitlyConfirmed && !kinds.some((kind) => planningSourceKinds.includes(kind));
}

/** Filename and folder-path keywords, weighted per kind. */
const nameSignals: Array<[SourceKind, RegExp, number]> = [
  ["characters", /\b(character|characters|cast|dramatis|personae|profiles?|bios?)\b/i, 3],
  ["timeline", /\b(timeline|chronolog|calendar|history|events?|dates?)\b/i, 3],
  ["world", /\b(world|worldbuilding|setting|lore|magic|geograph|map|factions?|glossar)\b/i, 3],
  ["plot", /\b(outline|synopsis|beats?|plot|structure|arc|treatment|pitch|plan|blueprint|roadmap|editorial)\b/i, 4],
  ["reference_book", /\b(reference|comp|comparison|inspiration|research|influences?|study)\b/i, 3],
  ["past_book", /\b(book\s*\d|vol(?:ume)?\s*\d|manuscript|novel|draft|final)\b/i, 2.5],
  ["notes", /\b(notes?|misc|scratch|ideas?|todo|random)\b/i, 2]
];

const pathSignals: Array<[SourceKind, RegExp, number]> = [
  ["characters", /(?:^|[\\/])(?:characters?|cast|bios?|profiles?)(?:[\\/]|$)/i, 8],
  ["timeline", /(?:^|[\\/])(?:timeline|chronolog(?:y|ies)|history|calendar|events?)(?:[\\/]|$)/i, 8],
  ["world", /(?:^|[\\/])(?:world|worldbuilding|lore|setting|geography|factions?)(?:[\\/]|$)/i, 8],
  ["plot", /(?:^|[\\/])(?:plot|outlines?|plans?|blueprints?|roadmaps?|story(?:line|boards?))(?:[\\/]|$)/i, 8],
  ["notes", /(?:^|[\\/])(?:notes?|misc|scratch|ideas?)(?:[\\/]|$)/i, 5]
];

export function classifySource(input: ClassifyInput): Classification {
  const scores: Record<SourceKind, number> = {
    past_book: 0,
    reference_book: 0,
    characters: 0,
    timeline: 0,
    world: 0,
    plot: 0,
    notes: 0.5 // weak default so an unrecognisable file lands somewhere sane
  };
  const reasons: Partial<Record<SourceKind, string[]>> = {};

  const note = (kind: SourceKind, weight: number, reason: string) => {
    scores[kind] += weight;
    (reasons[kind] ??= []).push(reason);
  };

  // --- Name and path signals -----------------------------------------------
  const haystack = `${input.path ?? ""} ${input.name}`;
  for (const [kind, pattern, weight] of nameSignals) {
    const match = pattern.exec(haystack);
    if (match) note(kind, weight, `name/path contains "${match[0]}"`);
  }
  for (const [kind, pattern, weight] of pathSignals) {
    const match = pattern.exec(input.path ?? "");
    if (match) note(kind, weight, `folder path indicates ${sourceKindLabels[kind].toLowerCase()}`);
  }

  // --- Structural signals --------------------------------------------------
  const text = input.text;
  const allWords = words(text);
  const wordCount = allWords.length;
  const paragraphs = splitParagraphs(text);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  if (wordCount === 0) {
    return { kind: "notes", confidence: 0.2, reasons: ["file is empty or unreadable"] };
  }

  const bulletLines = lines.filter((line) => /^\s*(?:[-*•+]|\d+[.)])\s/.test(line)).length;
  const bulletRatio = bulletLines / lines.length;
  const headingLines = lines.filter((line) => /^\s*#{1,6}\s/.test(line)).length;
  const chapterHeadings = (text.match(/^\s*(?:#{1,3}\s*)?(?:chapter|chapitre|capítulo)\s+[\dIVXLC]+/gim) ?? []).length;
  const spokenWords = dialogueSpans(text).reduce((sum, span) => sum + words(span).length, 0);
  const dialogueShare = spokenWords / wordCount;
  // Lines shaped like "Name: value" -- the hallmark of a character sheet.
  const fieldLines = lines.filter((line) => /^\s*\*{0,2}[A-Z][\w '-]{1,30}\*{0,2}\s*[:：]\s*\S/.test(line)).length;
  const fieldRatio = fieldLines / lines.length;
  const dateLines = lines.filter((line) =>
    /\b(?:year|day|month|age|era|\d{3,4}\s*(?:AD|BC|CE|BCE))\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i.test(line)
  ).length;
  const looksLikePersonDocument = /^[A-Z][a-zÀ-ɏ]+(?:\s+[A-Z][a-zÀ-ɏ]+){1,3}$/.test(input.name.trim());

  // Prose means no list or sheet structure, plus a positive sign of narrative:
  // dialogue or sustained paragraphs. A high mean paragraph length would
  // misfile dialogue-driven fiction, whose paragraphs are mostly one-line
  // exchanges.
  const longParagraphs = paragraphs.filter((paragraph) => words(paragraph.text).length >= 40).length;
  const longParagraphShare = paragraphs.length > 0 ? longParagraphs / paragraphs.length : 0;
  const isProse =
    bulletRatio < 0.2 && fieldRatio < 0.15 && (dialogueShare > 0.03 || longParagraphShare > 0.25);

  if (isProse) {
    const scale = wordCount > 3000 ? 3 : wordCount > 800 ? 1.5 : 0.75;
    note(
      "past_book",
      scale,
      `narrative prose (${wordCount.toLocaleString()} words, ${Math.round(dialogueShare * 100)}% dialogue)`
    );
    note("reference_book", scale * 0.66, "narrative prose could also be another author's book");
  }

  if (looksLikePersonDocument && chapterHeadings < 3) {
    note("characters", 5, "filename looks like a person name and the document has no chapter structure");
  }

  // Chapter headings mark a book regardless of how the prose test resolved.
  if (chapterHeadings >= 3) {
    note("past_book", 2, `${chapterHeadings} chapter headings`);
    note("reference_book", 1, `${chapterHeadings} chapter headings`);
  }

  if (fieldRatio > 0.15) {
    note("characters", 3, `${Math.round(fieldRatio * 100)}% of lines are "Field: value" entries`);
  }
  if (bulletRatio > 0.3) {
    note("plot", 1.5, `${Math.round(bulletRatio * 100)}% bulleted lines`);
    note("notes", 1, "heavily bulleted");
  }
  if (bulletRatio > 0.08) note("notes", 1.5, "working-note or outline lists are present");
  if (dateLines / lines.length > 0.2) {
    note("timeline", 3, `${dateLines} lines carry dates or era markers`);
  }
  if (headingLines > 5 && bulletRatio > 0.15 && !isProse) {
    note("world", 1.5, "structured reference document with many sections");
  }

  // --- Content keyword signals --------------------------------------------
  const body = text.slice(0, 20000).toLowerCase();
  const keyword = (kind: SourceKind, pattern: RegExp, weight: number, label: string) => {
    const hits = (body.match(pattern) ?? []).length;
    if (hits >= 3) note(kind, weight, `${label} (${hits} mentions)`);
  };
  keyword("characters", /\b(?:age|appearance|personality|motivation|backstory|arc|wants?|fears?)\b/g, 2, "character-sheet vocabulary");
  keyword("timeline", /\b(?:before|after|then|meanwhile|year|decade|century|precede|follow)\b/g, 1, "chronological vocabulary");
  keyword("world", /\b(?:kingdom|empire|guild|religion|currency|climate|species|magic system|technology)\b/g, 2, "worldbuilding vocabulary");
  keyword("plot", /\b(?:act (?:one|two|three|i|ii|iii)|inciting|climax|resolution|midpoint|subplot|beat)\b/g, 2, "story-structure vocabulary");

  // A by-line for someone else must beat the "long prose means past book" default.
  const byline = /\bby\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/.exec(text.slice(0, 1500));
  if (byline) note("reference_book", 2.5, `by-line "${byline[1]}" near the top`);

  // --- Resolve --------------------------------------------------------------
  const ranked = (Object.entries(scores) as Array<[SourceKind, number]>).sort((a, b) => b[1] - a[1]);
  const [topKind, topScore] = ranked[0];
  const [altKind, altScore] = ranked[1] ?? ["notes", 0];

  // Blends absolute evidence with the margin over the runner-up: a document
  // scoring equally for two kinds is genuinely ambiguous.
  const margin = topScore > 0 ? (topScore - altScore) / topScore : 0;
  const strength = Math.min(topScore / 6, 1);
  const confidence = Math.round(Math.max(0.15, Math.min(0.98, strength * 0.6 + margin * 0.4)) * 100) / 100;

  const suggested = new Set<SourceKind>([topKind]);
  if (topKind !== "timeline" && dateLines / lines.length > 0.08) suggested.add("timeline");
  if (topKind !== "plot" && (bulletRatio > 0.08 || /\b(?:outline|plan|blueprint|roadmap|table of contents)\b/i.test(haystack))) suggested.add("plot");
  if (topKind !== "notes" && bulletRatio > 0.08 && !isProse) suggested.add("notes");

  return {
    kind: topKind,
    confidence,
    reasons: (reasons[topKind] ?? ["no strong signal; filed as a general note"]).slice(0, 4),
    alternative: altScore > 0 && altKind !== topKind ? altKind : undefined,
    suggestedKinds: [...suggested]
  };
}

export interface GroupedSources {
  groups: Record<SourceKind, Array<{ name: string; path?: string; classification: Classification }>>;
  /** Files whose classification the author should confirm. */
  needsReview: Array<{ name: string; path?: string; classification: Classification }>;
}

/** Classify a batch and group it for the Studio board. */
export function groupSources(inputs: ClassifyInput[]): GroupedSources {
  const groups = {
    past_book: [],
    reference_book: [],
    characters: [],
    timeline: [],
    world: [],
    plot: [],
    notes: []
  } as GroupedSources["groups"];
  const needsReview: GroupedSources["needsReview"] = [];

  for (const input of inputs) {
    const classification = classifySource(input);
    const entry = { name: input.name, path: input.path, classification };
    groups[classification.kind].push(entry);
    if (classification.confidence < reviewThreshold) needsReview.push(entry);
  }

  return { groups, needsReview };
}
