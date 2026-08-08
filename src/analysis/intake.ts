// Deterministic project-level signals gathered before the agent asks intake
// questions. These are evidence-backed hints, not replacements for author
// decisions when the material is genuinely ambiguous.

import { words } from "../style/text.js";

export interface IntakeDocument {
  name: string;
  text: string;
}

export interface ProjectAnalysis {
  documentsRead: number;
  wordsRead: number;
  genre: string | null;
  subgenre: string | null;
  confidence: number;
  evidence: string[];
  unknowns: string[];
  analysedAt: string;
}

interface GenreSignal {
  genre: string;
  score: number;
  pattern: RegExp;
  evidence: string;
}

const signals: GenreSignal[] = [
  { genre: "Romance", score: 0, pattern: /\b(?:love|loved|kiss|kissed|boyfriend|girlfriend|husband|wife|romance|desire|attraction|relationship|heartbreak|lovers?)\b/gi, evidence: "romance and relationship vocabulary" },
  { genre: "Fantasy", score: 0, pattern: /\b(?:magic|spell|kingdom|queen|king|dragon|fae|fairy|witch|wizard|curse|prophecy|sword|demon|vampire|werewolf)\b/gi, evidence: "fantasy-world vocabulary" },
  { genre: "Mystery", score: 0, pattern: /\b(?:murder|dead body|detective|clue|suspect|investigate|investigation|police|case|missing|whodunit|evidence)\b/gi, evidence: "mystery and investigation vocabulary" },
  { genre: "Thriller", score: 0, pattern: /\b(?:threat|danger|assassin|conspiracy|hostage|chase|hunted|escape|terrorist|kill|weapon|survive)\b/gi, evidence: "danger and pursuit vocabulary" },
  { genre: "Science fiction", score: 0, pattern: /\b(?:spaceship|spacecraft|planet|galaxy|robot|android|cyborg|station|alien|mars|future|colony|quantum|technology)\b/gi, evidence: "science-fiction setting vocabulary" },
  { genre: "Horror", score: 0, pattern: /\b(?:haunted|ghost|horror|terrified|nightmare|demon|monster|possessed|darkness|blood|corpse|graveyard)\b/gi, evidence: "horror and fear vocabulary" },
  { genre: "Historical", score: 0, pattern: /\b(?:victorian|regency|medieval|empire|war|colonial|wwi|wwii|nineteenth century|eighteenth century|historical)\b/gi, evidence: "historical setting vocabulary" }
];

export function analyseProjectMaterial(documents: IntakeDocument[]): ProjectAnalysis {
  const text = documents.map((document) => `${document.name}\n${document.text}`).join("\n\n");
  const wordsRead = words(text).length;
  const ranked = signals
    .map((signal) => ({ ...signal, hits: count(text, signal.pattern) }))
    .filter((signal) => signal.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  const winner = ranked[0];
  const runnerUp = ranked[1];
  const genre = winner && winner.hits >= 2 ? winner.genre : null;
  const margin = winner && runnerUp ? (winner.hits - runnerUp.hits) / winner.hits : winner ? 0.5 : 0;
  const confidence = genre ? round(Math.min(0.95, 0.45 + margin * 0.35 + Math.min(winner.hits / 20, 0.3))) : 0.2;
  const subgenre = genre ? inferSubgenre(genre, text) : null;
  const evidence = genre
    ? ranked.slice(0, 3).map((signal) => `${signal.genre}: ${signal.hits} ${signal.evidence}`)
    : ["No genre signal was strong enough to prefill a project decision."];

  return {
    documentsRead: documents.length,
    wordsRead,
    genre,
    subgenre,
    confidence: round(confidence),
    evidence,
    unknowns: [
      ...(genre ? [] : ["genre and subgenre"]),
      "story promise",
      "length target",
      "mystery and reveal policy",
      "hard avoids and content boundaries"
    ],
    analysedAt: new Date().toISOString()
  };
}

function inferSubgenre(genre: string, text: string): string | null {
  if (genre === "Romance") {
    if (/\b(?:college|university|freshman|sophomore|new adult)\b/i.test(text)) return "New adult romance";
    if (/\b(?:magic|fae|kingdom|vampire|werewolf)\b/i.test(text)) return "Fantasy romance";
    if (/\b(?:contemporary|apartment|office|city|modern)\b/i.test(text)) return "Contemporary romance";
  }
  if (genre === "Mystery" && /\b(?:small town|bakery|bookshop|tea shop|cozy)\b/i.test(text)) return "Cozy mystery";
  if (genre === "Fantasy" && /\b(?:love|kiss|boyfriend|girlfriend|romance)\b/i.test(text)) return "Romantic fantasy";
  if (genre === "Thriller" && /\b(?:mind|trauma|psychological|memory)\b/i.test(text)) return "Psychological thriller";
  return null;
}

function count(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return (text.match(pattern) ?? []).length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
