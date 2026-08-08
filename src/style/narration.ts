// Working out how a body of prose is narrated.
//
// POV and tense are answerable from the text, so asking the author to type
// them out when their own books are already indexed is asking for something
// already known. Detected values are offered as a prefill, never imposed: a
// new book may deliberately change either.

import { dialogueSpans, splitSentences, words } from "./text.js";

export type Pov = "first" | "second" | "third_limited" | "third_omniscient" | "mixed";
export type Tense = "past" | "present" | "mixed";

export interface Narration {
  pov: Pov;
  tense: Tense;
  /** 0-1 for each, so a weak reading can be shown as uncertain. */
  povConfidence: number;
  tenseConfidence: number;
  /** Combined value matching the intake options, e.g. "close third, past". */
  label: string;
}

/**
 * Dialogue is stripped first. Characters speak in first person and present
 * tense regardless of how the book is narrated, so counting inside quotes
 * makes every novel look like first-person present.
 */
function narrativeOnly(text: string): string {
  let out = text;
  for (const span of dialogueSpans(text)) out = out.replace(`"${span}"`, " ").replace(`“${span}”`, " ");
  return out;
}

const firstPerson = new Set(["i", "me", "my", "mine", "myself", "we", "us", "our", "ours"]);
const secondPerson = new Set(["you", "your", "yours", "yourself"]);
const thirdPerson = new Set(["he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs"]);

/** Verbs that mark interiority, used to tell limited from omniscient. */
const interiority = /\b(?:thought|wondered|remembered|realis|realiz|felt|knew|hoped|feared|wanted)\w*\b/gi;

const pastMarkers = /\b(?:was|were|had|did|said|went|came|looked|took|made|knew|thought|felt|saw|walked|turned|stood|sat)\b/gi;
const presentMarkers = /\b(?:is|are|am|has|have|does|says|goes|comes|looks|takes|makes|knows|thinks|feels|sees|walks|turns|stands|sits)\b/gi;

export function detectNarration(text: string): Narration {
  const narrative = narrativeOnly(text);
  const tokens = words(narrative);
  const total = tokens.length || 1;

  let first = 0;
  let second = 0;
  let third = 0;
  for (const token of tokens) {
    if (firstPerson.has(token)) first += 1;
    else if (secondPerson.has(token)) second += 1;
    else if (thirdPerson.has(token)) third += 1;
  }

  const pronouns = first + second + third || 1;
  const firstShare = first / pronouns;
  const secondShare = second / pronouns;
  const thirdShare = third / pronouns;

  let pov: Pov;
  let povConfidence: number;
  if (firstShare > 0.35) {
    pov = "first";
    povConfidence = Math.min(firstShare * 1.6, 1);
  } else if (secondShare > 0.3) {
    pov = "second";
    povConfidence = Math.min(secondShare * 1.6, 1);
  } else if (thirdShare > 0.5) {
    // Interiority against head-hopping separates limited from omniscient. A
    // narrator with access to one mind reports thought often; one with access
    // to all of them reports it about many people, which this cannot see, so
    // limited is the safer default and the author can correct it.
    const interiorityRate = (narrative.match(interiority) ?? []).length / (total / 1000);
    pov = interiorityRate > 1.2 ? "third_limited" : "third_omniscient";
    povConfidence = Math.min(thirdShare * 1.2, 1) * (interiorityRate > 1.2 ? 1 : 0.7);
  } else {
    pov = "mixed";
    povConfidence = 0.3;
  }

  const past = (narrative.match(pastMarkers) ?? []).length;
  const present = (narrative.match(presentMarkers) ?? []).length;
  const tenseTotal = past + present || 1;
  const pastShare = past / tenseTotal;

  const tense: Tense = pastShare > 0.65 ? "past" : pastShare < 0.35 ? "present" : "mixed";
  const tenseConfidence = tense === "mixed" ? 0.4 : Math.min(Math.abs(pastShare - 0.5) * 2.4, 1);

  return { pov, tense, povConfidence, tenseConfidence, label: narrationLabel(pov, tense) };
}

/** The intake option this corresponds to. */
export function narrationLabel(pov: Pov, tense: Tense): string {
  const povText: Record<Pov, string> = {
    first: "First person",
    second: "Second person",
    third_limited: "Close third",
    third_omniscient: "Omniscient third",
    mixed: "Mixed"
  };
  const tenseText: Record<Tense, string> = { past: "past", present: "present", mixed: "mixed" };
  return `${povText[pov]}, ${tenseText[tense]}`;
}

/** Every combination worth offering, in the order a writer would look for them. */
export const narrationOptions = [
  "First person, past",
  "First person, present",
  "Close third, past",
  "Close third, present",
  "Omniscient third, past",
  "Omniscient third, present",
  "Second person, past",
  "Second person, present",
  "Multiple POVs, past",
  "Multiple POVs, present",
  "Epistolary",
  "Mixed"
];
