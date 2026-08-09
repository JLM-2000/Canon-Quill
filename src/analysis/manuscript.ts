import { splitParagraphs, words } from "../style/text.js";
import { computeMetrics, type StyleMetrics } from "../style/metrics.js";

export interface ManuscriptChapter {
  /** Sequential position in the file, not necessarily the printed number. */
  index: number;
  /** The heading as written, or a generated one when there are no headings. */
  heading: string;
  wordCount: number;
  /** Character offset of the heading within the document. */
  offset: number;
}

/** Layout conventions for continuation text. */
export interface Conventions {
  /** A heading line as written, to copy the shape of. */
  headingExample: string | null;
  /** Upper case, title case, or unknowable from the sample. */
  headingCase: "upper" | "title" | "other" | null;
  /** The line used between scenes, if any. */
  sceneBreak: string | null;
  quotes: "curly" | "straight" | "mixed" | "none";
  dashes: "em" | "double-hyphen" | "spaced-en" | "none";
  /** Paragraphs open with an indent rather than a blank line. */
  indentedParagraphs: boolean;
}

/** Material that sits after the story: afterword, review request, also-by. */
export interface BackMatter {
  /** Character offset where it starts. New chapters go before this. */
  offset: number;
  /** The line that gave it away. */
  heading: string;
  wordCount: number;
}

export interface ManuscriptAnalysis {
  totalWords: number;
  /** Words of actual story, excluding back matter. */
  storyWords: number;
  /** Where the story ends and the back matter begins. */
  storyEndOffset: number;
  backMatter: BackMatter | null;
  chapters: ManuscriptChapter[];
  /**
   * Whether the final chapter reads as finished. A draft that stops mid
   * sentence needs completing; one that ends cleanly needs a new chapter, and
   * guessing wrong is worse than asking.
   */
  lastChapterComplete: boolean;
  /** Why that conclusion was reached, so a human can overrule it. */
  completenessReason: string;
  /** The closing passage, for continuing without a seam. */
  tail: string;
  conventions: Conventions;
  metrics: StyleMetrics;
}

/**
 * Lines that look like a chapter heading.
 *
 * The division word alone is enough; requiring a digit or Roman numeral after
 * it missed "Chapter One", which is how most manuscripts are actually written.
 * The length guard in `isHeading` keeps this from matching a sentence that
 * happens to open with the word.
 */
const headingPatterns = [
  /^\s*#{1,3}\s*(chapter|chapitre|capítulo|kapitel|part|book|prologue|epilogue|interlude)\b/i,
  /^\s*(chapter|chapitre|capítulo|kapitel|part|book|prologue|epilogue|interlude)\b[\s\d\p{L}.:'-]*$/iu,
  /^\s*#{1,3}\s+\S.*$/,
  /^\s*[A-Z][A-Z\s\d.:'-]{4,60}$/ // an all-caps line on its own
];

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return false;
  return headingPatterns.some((pattern) => pattern.test(trimmed));
}

/**
 * Lines that open the material after the story.
 *
 * A published draft usually ends with an afterword, a review request or an
 * also-by list. Read as story, that material makes a book that finished
 * perfectly well look like it stops mid-thought, and anything appended lands
 * after the acknowledgements instead of after the last chapter.
 */
const backMatterPatterns = [
  /^\s*#{0,3}\s*thank(s| you) for reading\b/i,
  /^\s*#{0,3}\s*(a note (from|to)|author'?s note|afterword|foreword|postscript)\b/i,
  /^\s*#{0,3}\s*acknowledge?ments?\b/i,
  /^\s*#{0,3}\s*about the author\b/i,
  /^\s*#{0,3}\s*also by\b/i,
  /^\s*#{0,3}\s*(leave|write) (an? )?(honest )?review\b/i,
  /^\s*#{0,3}\s*(coming soon|preview of|excerpt from|sneak peek)\b/i,
  /^\s*#{0,3}\s*(the end|fin)\s*[.!]?\s*$/i,
  /^\s*#{0,3}\s*(dedication|copyright|contents|table of contents)\b/i,
  /^\s*#{0,3}\s*(join|sign up for) (my|the) (newsletter|mailing list)\b/i
];

/** Back matter is often a long paragraph without a heading. */
const backMatterContentPatterns = [
  /\bthank you for reading\b/i,
  /\bindependent author\b/i,
  /\bleave an? honest review\b/i,
  /\b(?:scan|qr) code\b/i,
  /\bhelp my books find their audience\b/i,
  /\b(?:join|sign up for) (?:my|the) newsletter\b/i,
  /\b(?:also by|about the author)\b/i
];

/**
 * Where the story stops, if anything follows it.
 *
 * Only the back half of the document is considered, measured in characters
 * rather than lines: a story is a few long paragraphs and back matter is many
 * short ones, so counting lines puts the boundary in the wrong place. A
 * chapter can legitimately mention thanking someone, and the length limit
 * keeps that from matching, since prose runs longer than a heading.
 */
function findBackMatter(text: string, lines: string[]): BackMatter | null {
  // Closing copy can be short and may be exported without blank lines. Keep a
  // front-of-book guard, but do not require it to occupy the final half.
  const threshold = text.length * 0.25;
  let offset = 0;

  for (const line of lines) {
    const at = offset;
    offset += line.length + newlineLength(text, offset + line.length);

    if (at < threshold) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 90) continue;

    if (backMatterPatterns.some((pattern) => pattern.test(trimmed))) {
      return { offset: at, heading: trimmed, wordCount: words(text.slice(at)).length };
    }
  }

  for (const paragraph of splitParagraphs(text)) {
    const found = backMatterContentPatterns
      .map((pattern) => {
        pattern.lastIndex = 0;
        const match = pattern.exec(paragraph.text);
        return match ? { pattern, index: match.index, text: match[0] } : null;
      })
      .filter((match): match is { pattern: RegExp; index: number; text: string } => Boolean(match));
    const first = found.sort((a, b) => a.index - b.index)[0];
    if (!first) continue;
    const absolute = paragraph.offset + first.index;
    const strong = /thank you|independent author|honest review|qr|find their audience|newsletter|also by|about the author/i.test(first.pattern.source);
    if (absolute >= threshold && (found.length >= 2 || strong)) {
      // Once the paragraph itself is in the closing quarter, keep its opening
      // sentence with the closing copy. Splitting at a later signal can leave
      // "As an" or similar connective tissue looking like unfinished story.
      const boundary = paragraph.offset >= threshold ? paragraph.offset : absolute;
      const heading = text.slice(boundary).split(/[.!?\n]/)[0].trim().slice(0, 90);
      return { offset: boundary, heading: heading || "Closing material", wordCount: words(text.slice(boundary)).length };
    }
  }
  return null;
}

function newlineLength(text: string, offset: number): number {
  if (text.startsWith("\r\n", offset)) return 2;
  return text[offset] === "\n" || text[offset] === "\r" ? 1 : 0;
}

/** Lines used to separate scenes rather than chapters. */
function isSceneBreak(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 12) return false;
  return /^([*#~•·]|\*\s*\*|-{3,}|\*{3,}|#{3,}|·{3,}|\.{3,})[\s*#~•·.-]*$/.test(trimmed);
}

export function analyseManuscript(text: string): ManuscriptAnalysis {
  const allLines = text.split(/\r?\n/);
  const backMatter = findBackMatter(text, allLines);
  // Everything below reasons about the story, not the matter after it.
  const storyEndOffset = backMatter?.offset ?? text.length;
  const story = text.slice(0, storyEndOffset);
  const lines = story.split(/\r?\n/);
  const chapters: ManuscriptChapter[] = [];

  let offset = 0;
  let currentStart = 0;
  let currentHeading: string | null = null;

  const push = (endOffset: number) => {
    const body = story.slice(currentStart, endOffset);
    const count = words(body).length;
    if (count === 0) return; // nothing there at all
    if (count < 20 && chapters.length > 0 && !isExplicitChapterHeading(currentHeading)) return;
    chapters.push({
      index: chapters.length + 1,
      heading: currentHeading ?? `Untitled section ${chapters.length + 1}`,
      wordCount: count,
      offset: currentStart
    });
  };

  for (const line of lines) {
    if (isHeading(line) && !isSceneBreak(line)) {
      if (currentHeading !== null || words(story.slice(currentStart, offset)).length > 20) {
        push(offset);
      }
      currentHeading = line.trim();
      currentStart = offset;
    }
    offset += line.length + newlineLength(story, offset + line.length);
  }
  push(story.length);

  // A document with no headings at all is still one body of work.
  if (chapters.length === 0 && words(story).length > 0) {
    chapters.push({ index: 1, heading: "Untitled", wordCount: words(story).length, offset: 0 });
  }

  const complete = assessCompleteness(story, chapters);

  return {
    totalWords: words(text).length,
    storyWords: words(story).length,
    storyEndOffset,
    backMatter,
    chapters,
    lastChapterComplete: complete.complete,
    completenessReason: complete.reason,
    tail: tailOf(story, 400),
    conventions: readConventions(story, lines),
    metrics: computeMetrics(story)
  };
}

function isExplicitChapterHeading(heading: string | null): boolean {
  return Boolean(heading && /^\s*#{0,3}\s*(chapter|chapitre|capítulo|kapitel|part|book|prologue|epilogue|interlude)\b/i.test(heading));
}

/**
 * Does the draft stop at an ending, or in the middle of one?
 *
 * Prose that ends without terminal punctuation, or on a conjunction, was
 * almost certainly interrupted. A short final chapter next to long ones is
 * suggestive but not decisive, so it lowers confidence rather than deciding.
 */
function assessCompleteness(
  text: string,
  chapters: ManuscriptChapter[]
): { complete: boolean; reason: string } {
  const trimmed = stripTrailingLayout(text);
  if (!trimmed) return { complete: true, reason: "The document is empty." };

  const lastChar = trimmed.slice(-1);
  const terminal = ".!?\"'”’…";
  if (!terminal.includes(lastChar)) {
    return {
      complete: false,
      reason: `The text stops on "${trimmed.slice(-40)}" with no closing punctuation, which reads as interrupted.`
    };
  }

  const finalWords = words(trimmed).slice(-3);
  const danglers = ["and", "but", "or", "then", "because", "which", "that", "so", "as", "with"];
  if (finalWords.some((word) => danglers.includes(word)) && finalWords.at(-1) !== undefined) {
    const last = finalWords.at(-1)!;
    if (danglers.includes(last)) {
      return { complete: false, reason: `The last sentence ends on "${last}", which reads as unfinished.` };
    }
  }

  if (chapters.length >= 3) {
    const last = chapters.at(-1)!;
    const others = chapters.slice(0, -1);
    const median = [...others.map((c) => c.wordCount)].sort((a, b) => a - b)[Math.floor(others.length / 2)];
    if (median > 0 && last.wordCount < median * 0.35) {
      return {
        complete: false,
        reason: `The final section is ${last.wordCount} words against a typical ${median}, so it looks part-written.`
      };
    }
  }

  return { complete: true, reason: "The text ends on a complete sentence at a normal chapter length." };
}

/** The closing passage, cut at a paragraph boundary. */
function tailOf(text: string, targetWords: number): string {
  const paragraphs = splitParagraphs(stripTrailingLayout(text));
  const kept: string[] = [];
  let count = 0;
  for (let i = paragraphs.length - 1; i >= 0 && count < targetWords; i -= 1) {
    kept.unshift(paragraphs[i].text);
    count += words(paragraphs[i].text).length;
  }
  return kept.join("\n\n");
}

/** Page-break rules are document layout, not prose or an unfinished ending. */
function stripTrailingLayout(text: string): string {
  return text
    .replace(/[\u000b\u000c\u0085\u2028\u2029]/g, "\n")
    .replace(/(?:\s*(?:_{3,}|-{3,}|={3,}|\*{3,}|~{3,}|·{3,})\s*)+$/u, "")
    .trimEnd();
}

function readConventions(text: string, lines: string[]): Conventions {
  const headings = lines.filter((line) => isHeading(line) && !isSceneBreak(line)).map((l) => l.trim());
  const headingExample = headings[0] ?? null;

  let headingCase: Conventions["headingCase"] = null;
  if (headingExample) {
    const stripped = headingExample.replace(/^#+\s*/, "");
    headingCase = stripped === stripped.toUpperCase() && /[A-Z]/.test(stripped)
      ? "upper"
      : /^[A-Z][a-z]/.test(stripped)
        ? "title"
        : "other";
  }

  const breaks = lines.filter(isSceneBreak).map((l) => l.trim());
  const sceneBreak = breaks.length > 0 ? mostCommon(breaks) : null;

  const curly = (text.match(/[“”]/g) ?? []).length;
  const straight = (text.match(/"/g) ?? []).length;
  const quotes: Conventions["quotes"] =
    curly === 0 && straight === 0 ? "none"
    : curly > straight * 3 ? "curly"
    : straight > curly * 3 ? "straight"
    : "mixed";

  const em = (text.match(/—/g) ?? []).length;
  const doubleHyphen = (text.match(/(?<!-)--(?!-)/g) ?? []).length;
  const spacedEn = (text.match(/ – /g) ?? []).length;
  const dashes: Conventions["dashes"] =
    em === 0 && doubleHyphen === 0 && spacedEn === 0 ? "none"
    : em >= doubleHyphen && em >= spacedEn ? "em"
    : doubleHyphen >= spacedEn ? "double-hyphen"
    : "spaced-en";

  // An indented style opens paragraphs with whitespace instead of a blank line.
  const proseLines = lines.filter((line) => line.trim().length > 40);
  const indented = proseLines.filter((line) => /^[ \t]{2,}|^\t/.test(line)).length;
  const indentedParagraphs = proseLines.length > 0 && indented / proseLines.length > 0.4;

  return { headingExample, headingCase, sceneBreak, quotes, dashes, indentedParagraphs };
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Render the analysis as the brief a drafting agent needs to continue. */
export function renderContinuationBrief(analysis: ManuscriptAnalysis, documentName: string, notes = ""): string {
  const c = analysis.conventions;
  return [
    `# Continuing an existing draft: ${documentName}`,
    "",
    `The book is already ${analysis.storyWords.toLocaleString()} words of story across ` +
      `${analysis.chapters.length} section${analysis.chapters.length === 1 ? "" : "s"}. You are adding to ` +
      `it, not starting it.`,
    "",
    ...(analysis.backMatter
      ? [
          "## Where to insert",
          "",
          `This document ends with back matter, starting at "${analysis.backMatter.heading}" ` +
            `(${analysis.backMatter.wordCount} words). That is not story and must not be treated as one.`,
          "",
          "**New chapters go before it, not after.** The acknowledgements, review request and anything",
          "else down there stay at the end of the document where they belong. Do not edit, move or",
          "restate them.",
          ""
        ]
      : []),
    "## Where it stops",
    "",
    analysis.lastChapterComplete
      ? `The draft ends cleanly. ${analysis.completenessReason} Begin a new chapter.`
      : `The draft stops mid-flow. ${analysis.completenessReason} Finish the chapter in progress before starting another.`,
    "",
    "## Match these exactly",
    "",
    `- Chapter headings: ${c.headingExample ? `written as \`${c.headingExample}\`` : "none found; do not invent a style"}` +
      `${c.headingCase ? ` (${c.headingCase} case)` : ""}`,
    `- Scene breaks: ${c.sceneBreak ? `\`${c.sceneBreak}\`` : "none used; separate scenes with a blank line"}`,
    `- Quotation marks: ${c.quotes === "none" ? "no dialogue yet" : c.quotes}`,
    `- Dashes: ${c.dashes === "none" ? "none used" : c.dashes}`,
    `- Paragraphs: ${c.indentedParagraphs ? "indented, no blank line between" : "separated by a blank line, no indent"}`,
    "",
    "These are not suggestions. A reader should not be able to see where the",
    "existing text ends and yours begins.",
    "",
    "## The passage you are continuing from",
    "",
    "```",
    analysis.tail,
    "```",
    "",
    ...(notes.trim()
      ? ["## Author's continuation notes", "", notes.trim(), ""]
      : []),
    "Pick up from that. Do not restate it, summarise it, or open with a recap."
  ].join("\n");
}

/**
 * Insert approved continuation prose without moving or rewriting the original
 * back matter. The caller decides whether the merged result is posted in place
 * or written as a separate manuscript.
 */
export function mergeContinuation(existingText: string, additions: string): string {
  const clean = additions.trim();
  if (!clean) return existingText;

  const analysis = analyseManuscript(existingText);
  const offset = analysis.backMatter?.offset ?? existingText.length;
  const before = existingText.slice(0, offset);
  const after = existingText.slice(offset);
  const prefix = before.length === 0 || /\n\s*$/.test(before) ? before : `${before}\n\n`;
  const suffix = after.length === 0 || /^\s*\n/.test(after) ? after : `\n\n${after}`;
  return `${prefix}${clean}${suffix}`;
}
