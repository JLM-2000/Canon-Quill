import { words } from "./text.js";

export interface FormattingObservation {
  source: string;
  wordCount: number;
  dialogueCount: number;
  boldDialogueCount: number;
  italicCount: number;
  boldCount: number;
}

const dialoguePattern = /["“][^"“”\n]+["”]/g;
const boldDialoguePattern = /\*\*\s*["“][^"“”\n]+["”]\s*\*\*/g;
const italicPattern = /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g;
const boldPattern = /\*\*(.+?)\*\*/g;

export function measureFormatting(documents: Array<{ source: string; text: string }>): FormattingObservation[] {
  return documents.map(({ source, text }) => ({
    source,
    wordCount: words(text).length,
    dialogueCount: matches(text, dialoguePattern),
    boldDialogueCount: matches(text, boldDialoguePattern),
    italicCount: matches(text, italicPattern),
    boldCount: matches(text, boldPattern)
  }));
}

export function renderFormattingReference(observations: FormattingObservation[]): string {
  const boldDialogue = observations.filter((observation) => observation.boldDialogueCount > 0);
  const italics = observations.filter((observation) => observation.italicCount > 0);
  const lines = [
    "# Formatting references",
    "",
    "This is evidence from every selected source document, including uploaded files and Drive-extracted files.",
    "It is separate from the voice corpus. When a convention is observed below, preserve it in new prose unless",
    "the author gives a later instruction that changes it.",
    "",
    "## Evidence-backed conventions",
    "",
    boldDialogue.length
      ? `- **Dialogue formatting:** Bold dialogue including its quotation marks is present in ${boldDialogue.length} selected source${boldDialogue.length === 1 ? "" : "s"}. Write spoken lines as **“The complete line.”**`
      : "- **Dialogue formatting:** No bold dialogue marker was detected in the selected sources.",
    italics.length
      ? `- **Italic formatting:** Italic emphasis or thought markers are present in ${italics.length} selected source${italics.length === 1 ? "" : "s"}. Preserve italics where the source uses them.`
      : "- **Italic formatting:** No Markdown italic marker was detected in the selected sources.",
    "",
    "## Source measurements",
    "",
    "| Source | Words | Dialogue spans | Bold dialogue | Italic spans | Bold spans |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...observations.map((observation) => `| ${observation.source.replace(/\|/g, "\\|")} | ${observation.wordCount.toLocaleString()} | ${observation.dialogueCount} | ${observation.boldDialogueCount} | ${observation.italicCount} | ${observation.boldCount} |`),
    "",
    "Do not treat this document as a generic formatting suggestion. It records the selected material the author",
    "asked Canon Quill to use, and it applies to the output format the author is writing in."
  ];
  return lines.join("\n");
}

function matches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}
