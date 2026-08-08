// Tokenisation primitives for the style engine. Deterministic by design: the
// fingerprint is compared across runs, so a drifting tokeniser would read as
// drifting prose.

/** Abbreviations that end in a period without ending a sentence. */
const abbreviations = new Set([
  "mr", "mrs", "ms", "dr", "st", "sr", "jr", "prof", "rev", "gen", "col", "lt",
  "sgt", "capt", "cmdr", "adm", "hon", "vs", "etc", "eg", "ie", "approx", "inc",
  "ltd", "co", "no", "vol", "fig", "al"
]);

const closingQuotes = `"'”’`;
const openingQuotes = `"'“‘`;

export interface Sentence {
  text: string;
  /** Character offset of the sentence within the passage it came from. */
  offset: number;
  words: string[];
}

export interface Paragraph {
  text: string;
  offset: number;
  sentences: Sentence[];
}

/**
 * Split prose into sentences, handling the two cases a naive `split(/[.!?]/)`
 * gets wrong: abbreviations, and dialogue punctuation followed by a tag.
 */
export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "." && char !== "!" && char !== "?") continue;

    // Runs like "?!" or "..." are one boundary.
    let end = i;
    while (end + 1 < text.length && ".!?".includes(text[end + 1])) end += 1;

    while (end + 1 < text.length && closingQuotes.includes(text[end + 1])) end += 1;

    const next = text.slice(end + 1);

    if (next.length > 0 && !/^\s/.test(next)) {
      i = end;
      continue;
    }

    if (char === "." && isAbbreviation(text, i)) {
      i = end;
      continue;
    }

    // A lowercase word after a closing quote is a dialogue tag, not a new sentence.
    if (/^\s+[a-z]/.test(next) && closingQuotes.includes(text[end])) {
      i = end;
      continue;
    }

    const raw = text.slice(start, end + 1).trim();
    if (raw) sentences.push(makeSentence(raw, start));
    start = end + 1;
    i = end;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(makeSentence(tail, start));

  return sentences;
}

/** Split prose into paragraphs on blank lines, preserving offsets. */
export function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const pattern = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;

  const push = (chunk: string, offset: number) => {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    const lead = chunk.length - chunk.trimStart().length;
    paragraphs.push({ text: trimmed, offset: offset + lead, sentences: splitSentences(trimmed) });
  };

  while ((match = pattern.exec(text)) !== null) {
    push(text.slice(start, match.index), start);
    start = match.index + match[0].length;
  }
  push(text.slice(start), start);

  return paragraphs;
}

/** Lowercased word tokens, apostrophes preserved so contractions survive. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-zÀ-ɏ]+(?:'[a-z]+)*/gi) ?? [];
}

/**
 * Extract quoted dialogue. Double quotes only: single quotes collide with
 * apostrophes far more often than they mark speech in English prose.
 */
export function dialogueSpans(text: string): string[] {
  const spans: string[] = [];
  const pattern = /["“]([^"“”]{1,2000})["”]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const inner = match[1].trim();
    if (inner) spans.push(inner);
  }
  return spans;
}

/**
 * Subject that can sit between a quote and its tag verb. The lowercase
 * alternatives matter: without them `"Get out," she said` resolves to the
 * pronoun rather than the verb.
 */
const tagSubject = "(?:[A-Z][a-zÀ-ɏ]+|he|she|they|it|we|you)";

/** Extract dialogue tag verbs, in both `"line," she said` and `she said, "line"` order. */
export function dialogueTags(text: string): string[] {
  const tags: string[] = [];
  const after = new RegExp(`["”][\\s,.]*(?:${tagSubject}\\s+)?([a-zÀ-ɏ]+)`, "g");
  const before = new RegExp(`${tagSubject}\\s+([a-zÀ-ɏ]+)\\s*[,:]\\s*["“]`, "g");

  for (const pattern of [after, before]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const verb = match[1]?.toLowerCase();
      if (verb) tags.push(verb);
    }
  }
  return tags;
}

/** True when a paragraph contains spoken dialogue. */
export function isSpeechParagraph(text: string): boolean {
  return dialogueSpans(text).length > 0;
}

function makeSentence(text: string, offset: number): Sentence {
  return { text, offset, words: words(text) };
}

function isAbbreviation(text: string, periodIndex: number): boolean {
  let start = periodIndex - 1;
  while (start >= 0 && /[A-Za-z]/.test(text[start])) start -= 1;
  const token = text.slice(start + 1, periodIndex).toLowerCase();
  if (!token) return false;
  if (abbreviations.has(token)) return true;
  // Single initials: "J. Lucia", "T. S. Eliot".
  return token.length === 1;
}

/** Mean of a numeric list; 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation; 0 for lists shorter than two entries. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

/** Linear-interpolated percentile, `p` in [0, 1]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** Rate per 1,000 words, rounded to two decimals. */
export function per1k(count: number, totalWords: number): number {
  if (totalWords === 0) return 0;
  return round(count / (totalWords / 1000));
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
