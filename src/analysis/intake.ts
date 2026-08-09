import { analyseWriting, type WritingProfile } from "../style/profile.js";
import { analyseManuscript } from "./manuscript.js";
import { splitParagraphs, words } from "../style/text.js";

export interface IntakeDocument {
  name: string;
  text: string;
  path?: string;
  kinds?: string[];
}

export interface IntakeFinding {
  value: string;
  confidence: number;
  evidence: string[];
}

export interface IntakeQuestionPlan {
  key: string;
  question: string;
  rationale: string;
  options?: string[];
  allowFreeText?: boolean;
  blocking: boolean;
}

export interface IntakeSourceSummary {
  name: string;
  kinds: string[];
  words: number;
  headings: string[];
}

export interface IntakeContext {
  shape?: string | null;
  draftingMode?: string | null;
  intake?: Record<string, string>;
  existingDraft?: boolean;
}

export interface ProjectAnalysis {
  documentsRead: number;
  wordsRead: number;
  sourceInventory: Record<string, { documents: number; words: number }>;
  documents: IntakeSourceSummary[];
  genre: string | null;
  subgenre: string | null;
  confidence: number;
  evidence: string[];
  findings: {
    premise: IntakeFinding | null;
    protagonist: IntakeFinding | null;
    relationships: IntakeFinding | null;
    centralConflict: IntakeFinding | null;
    setting: IntakeFinding | null;
    timeline: IntakeFinding | null;
    structure: IntakeFinding | null;
    narration: IntakeFinding | null;
    audience: IntakeFinding | null;
    intimacy: IntakeFinding | null;
  };
  unknowns: string[];
  questionPlan: IntakeQuestionPlan[];
  analysedAt: string;
}

interface GenreSignal {
  genre: string;
  pattern: RegExp;
  evidence: string;
}

interface RankedSignal extends GenreSignal {
  hits: number;
}

const signals: GenreSignal[] = [
  { genre: "Romance", pattern: /\b(?:love|loved|loving|kiss|kissed|boyfriend|girlfriend|husband|wife|romance|romantic|desire|attraction|relationship|heartbreak|lovers?)\b/gi, evidence: "romance and relationship vocabulary" },
  { genre: "Fantasy", pattern: /\b(?:magic|spell|kingdom|queen|king|dragon|fae|fairy|witch|wizard|curse|prophecy|sword|demon|vampire|werewolf|portal)\b/gi, evidence: "fantasy-world vocabulary" },
  { genre: "Mystery", pattern: /\b(?:murder|dead body|detective|clue|suspect|investigate|investigation|police|case|missing|whodunit|evidence|alibi|culprit)\b/gi, evidence: "mystery and investigation vocabulary" },
  { genre: "Thriller", pattern: /\b(?:threat|danger|assassin|conspiracy|hostage|chase|hunted|escape|terrorist|kill|weapon|survive|deadline)\b/gi, evidence: "danger and pursuit vocabulary" },
  { genre: "Science fiction", pattern: /\b(?:spaceship|spacecraft|planet|galaxy|robot|android|cyborg|station|alien|mars|future|colony|quantum|technology|starship)\b/gi, evidence: "science-fiction setting vocabulary" },
  { genre: "Horror", pattern: /\b(?:haunted|ghost|horror|terrified|nightmare|demon|monster|possessed|darkness|blood|corpse|graveyard|creature)\b/gi, evidence: "horror and fear vocabulary" },
  { genre: "Historical", pattern: /\b(?:victorian|regency|medieval|empire|war|colonial|wwi|wwii|nineteenth century|eighteenth century|historical|heirloom)\b/gi, evidence: "historical setting vocabulary" },
  { genre: "Contemporary", pattern: /\b(?:apartment|office|subway|instagram|texted|phone|modern|coffee shop|city life)\b/gi, evidence: "contemporary-life vocabulary" }
];

export function analyseProjectMaterial(documents: IntakeDocument[], context: IntakeContext = {}): ProjectAnalysis {
  const nonEmpty = documents.filter((document) => words(document.text).length > 0);
  const allText = nonEmpty.map((document) => `${document.name}\n${document.text}`).join("\n\n");
  const proseDocuments = nonEmpty.filter((document) =>
    !document.kinds?.length || document.kinds.some((kind) => ["past_book", "reference_book", "notes"].includes(kind))
  );
  const proseText = (proseDocuments.length ? proseDocuments : nonEmpty)
    .map((document) => document.text)
    .join("\n\n");
  const wordsRead = words(allText).length;
  const ranked = rankGenres(allText);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const genre = winner && winner.hits >= 2 ? winner.genre : null;
  const margin = winner && runnerUp ? (winner.hits - runnerUp.hits) / winner.hits : winner ? 0.5 : 0;
  const confidence = genre ? round(Math.min(0.96, 0.45 + margin * 0.35 + Math.min(winner.hits / 20, 0.3))) : 0.2;
  const subgenre = genre ? inferSubgenre(genre, allText) : null;
  const profile = proseText ? analyseWriting(proseText) : null;
  const sourceInventory = buildSourceInventory(nonEmpty);
  const summaries = nonEmpty.map(summariseDocument);
  const targetDocuments = nonEmpty.filter(isPlanningDocument);
  const premise = findPremise(targetDocuments);
  const names = extractNames(nonEmpty);
  const protagonist = findProtagonist(targetDocuments, names);
  const relationships = findRelationships(targetDocuments, names, genre);
  const centralConflict = findConflict(targetDocuments, genre, names);
  const setting = findSetting(nonEmpty);
  const timeline = findTimeline(targetDocuments, nonEmpty);
  const structure = findStructure(targetDocuments, nonEmpty);
  const narration = profile ? findNarration(profile) : null;
  const audience = profile?.audience.values.length ? {
    value: profile.audience.values.join(" / "),
    confidence: profile.audience.confidence,
    evidence: profile.audience.evidence
  } : null;
  const intimacy = profile && profile.intimacy.value !== "None" ? {
    value: profile.intimacy.value,
    confidence: profile.intimacy.confidence,
    evidence: profile.intimacy.evidence
  } : null;

  const findings = { premise, protagonist, relationships, centralConflict, setting, timeline, structure, narration, audience, intimacy };
  const unknowns = findUnknowns({ genre, findings, context });
  const base: ProjectAnalysis = {
    documentsRead: nonEmpty.length,
    wordsRead,
    sourceInventory,
    documents: summaries,
    genre,
    subgenre,
    confidence: round(confidence),
    evidence: genre
      ? ranked.slice(0, 5).map((signal) => `${signal.genre}: ${signal.hits} ${signal.evidence}`)
      : ["No genre signal was strong enough to prefill a project decision."],
    findings,
    unknowns,
    questionPlan: [],
    analysedAt: new Date().toISOString()
  };

  base.questionPlan = buildIntakeQuestionPlan(base, context);
  return base;
}

export function buildIntakeQuestionPlan(analysis: ProjectAnalysis, context: IntakeContext = {}): IntakeQuestionPlan[] {
  const plan: IntakeQuestionPlan[] = [];
  const intake = context.intake ?? {};
  const findings = analysis.findings;
  const genre = analysis.genre;
  const genreLabel = analysis.subgenre || analysis.genre || "the selected material";
  const characterReference = findings.protagonist?.value
    ? `the named character material around ${findings.protagonist.value}`
    : "character material without a clear protagonist";
  const storyFocus = findings.protagonist?.value || "the selected cast material";
  const setting = findings.setting?.value || "the setting implied by the selected material";
  const evidence = (finding: IntakeFinding | null, fallback: string) => finding?.evidence[0] || fallback;
  const add = (question: IntakeQuestionPlan) => {
    if (!intake[question.key]) plan.push(question);
  };

  if (!findings.premise) {
    add({
      key: "storyPromise",
      question: `The analysis found ${characterReference} and ${setting}, and it reads as ${genreLabel}, but no target-book promise is stated in the selected material. What must this specific book promise and deliver to the reader?`,
      rationale: `The analyzer checked ${analysis.documentsRead} selected documents and found no explicit logline, premise, synopsis, or target outline. This is a book-defining decision, not a genre question.`,
      blocking: true
    });
  }

  if (!findings.protagonist || findings.protagonist.confidence < 0.8) {
    add({
      key: "protagonistArc",
      question: findings.protagonist?.value
        ? `The character material names ${findings.protagonist.value}, but does not establish the lead's full arc. Which character owns this book's emotional arc, what do they want at the opening, and what must change in them by the end?`
        : "The selected material does not identify a clear protagonist. Which character owns this book's emotional arc, what do they want at the opening, and what must change in them by the end?",
      rationale: `The selected material identifies cast members but does not unambiguously designate the target book's lead, opening want, and transformation.`,
      allowFreeText: true,
      blocking: true
    } as IntakeQuestionPlan);
  }

  if (genre === "Romance" && (!findings.relationships || findings.relationships.confidence < 0.8)) {
    add({
      key: "relationshipArc",
      question: `The material points toward ${findings.relationships?.value || "a romantic relationship"}, but it does not define this book's relationship arc. What changes between them from the opening to the ending, and what must they choose or risk to get there?`,
      rationale: "Romance preparation needs a relationship progression, not only a genre label or attraction signal.",
      blocking: true
    });
  }

  if (!findings.centralConflict) {
    add({
      key: "centralConflict",
      question: `The analysis found ${genreLabel} material around ${storyFocus}, but no target-book conflict or stakes are explicit. What opposing force keeps the protagonist from getting what they want, and what becomes costly if they fail?`,
      rationale: `No outline, plot note, or character document states the central opposition and consequence clearly enough for the preparation agent to canonize it.`,
      blocking: true
    });
  }

  if (!findings.setting) {
    add({
      key: "settingRules",
      question: "The selected material does not establish the target book's primary setting or any rules that could constrain scenes. Where and when does the story happen, and what setting details must remain canon?",
      rationale: "No world, setting, location, or time anchor was found in the selected material.",
      blocking: false
    });
  }

  if (!findings.structure) {
    add({
      key: "endingAndStructure",
      question: `The analysis found no target outline or ending plan for this ${genreLabel} book. What ending must the preparation agent build toward, and are there any non-negotiable reveals, relationship milestones, or sequel handoffs?`,
      rationale: "The selected documents contain no explicit chapter plan, climax, resolution, epilogue, or ending requirement.",
      blocking: true
    });
  }

  if (!findings.audience && !intake.audience) {
    add({
      key: "audience",
      question: `The prose signals ${genreLabel}, but the selected material does not reliably name the shelf or age category. Is this Adult, New adult, Young adult, Middle grade, Children, or another audience?`,
      rationale: "Audience affects diction, character age, content boundaries, pacing, and the preparation rubric, so the agent must not infer it from genre alone.",
      options: ["Adult", "New adult", "Young adult", "Middle grade", "Children", "Other"],
      blocking: true
    });
  }

  if (genre === "Romance" && !intake.spice) {
    add({
      key: "spice",
      question: `The selected prose contains ${findings.intimacy?.value?.toLowerCase() || "romantic"} material. Which intimacy boundary should the preparation agent enforce for this book?`,
      rationale: evidence(findings.intimacy, "Romance is present, but the target book's intimacy policy is not stated as an instruction."),
      options: ["None", "Romantic tension only", "Fade to black", "Open door", "Explicit", "Very explicit"],
      blocking: true
    });
  }

  if ((genre === "Mystery" || genre === "Thriller" || /mystery|thriller/i.test(analysis.subgenre || "")) && !intake.revealPolicy) {
    add({
      key: "revealPolicy",
      question: "The analysis found mystery or threat signals. Should the preparation agent preserve the central reveal as an author-only secret, imply it early, explain it as the story progresses, or fully expose it in the planning documents?",
      rationale: "Reveal handling changes what can appear in chapter briefs, prompts, validation reports, and user-facing summaries.",
      options: ["Keep secret", "Imply early", "Explain progressively", "Fully expose in plans"],
      blocking: true
    });
  }

  if (context.shape === "series" && !intake.seriesPosition && !findings.structure) {
    add({
      key: "seriesPosition",
      question: "This project is configured as a series, but the selected material does not identify this book's position or inherited threads. Which book is this, and what must it carry forward or set up?",
      rationale: "Series position controls the canon handoff and prevents the preparation agent from treating an inherited relationship or unresolved thread as new.",
      blocking: true
    });
  }

  if (!intake.lengthTarget && !findings.structure) {
    const range = inferLengthRange(analysis.documents);
    add({
      key: "lengthTarget",
      question: range
        ? `The indexed prose ranges from ${range}. What word-count range should this book target, and what chapter length should the drafting agent treat as normal?`
        : "What word-count range should this book target, and what chapter length should the drafting agent treat as normal?",
      rationale: range
        ? "The analyzer measured the selected prose, but a prior book's length is not automatically the target for this book."
        : "No reliable target length was stated in the selected material.",
      blocking: false
    });
  }

  return plan;
}

function rankGenres(text: string): RankedSignal[] {
  return signals
    .map((signal) => ({ ...signal, hits: count(text, signal.pattern) }))
    .filter((signal) => signal.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

function findUnknowns(input: {
  genre: string | null;
  findings: ProjectAnalysis["findings"];
  context: IntakeContext;
}): string[] {
  const unknowns: string[] = [];
  const { findings, genre, context } = input;
  if (!genre) unknowns.push("genre and subgenre");
  if (!findings.premise) unknowns.push("target-book story promise");
  if (!findings.protagonist) unknowns.push("protagonist arc");
  if (!findings.centralConflict) unknowns.push("central conflict and stakes");
  if (!findings.setting) unknowns.push("setting and governing rules");
  if (!findings.timeline) unknowns.push("timeline and sequence");
  if (genre === "Romance" && !findings.relationships) unknowns.push("relationship arc");
  if (!findings.structure) unknowns.push("ending and structural handoff");
  if (!findings.audience) unknowns.push("audience and age category");
  if (genre === "Romance" && !context.intake?.spice) unknowns.push("intimacy boundary");
  if ((genre === "Mystery" || genre === "Thriller") && !context.intake?.revealPolicy) unknowns.push("reveal policy");
  if (context.shape === "series" && !findings.structure) unknowns.push("series position and inherited threads");
  return [...new Set(unknowns)];
}

function findPremise(documents: IntakeDocument[]): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:story promise|logline|premise|central premise|hook|one[- ]sentence(?: story)?|synopsis|blurb)\s*[:\-]\s*(.{24,320})/i);
  if (labeled) return labeled;
  const plotDocument = documents.find((document) => document.kinds?.includes("plot"));
  const candidate = plotDocument && firstUsefulLine(plotDocument.text);
  return candidate ? {
    value: candidate,
    confidence: 0.62,
    evidence: [`First substantive plot note in ${plotDocument.name}.`]
  } : null;
}

function findProtagonist(documents: IntakeDocument[], names: string[]): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:protagonist|main character|primary character|lead)\s*[:\-]\s*(.{2,180})/i);
  if (labeled) return labeled;
  const characterDocuments = documents.filter((document) => document.kinds?.includes("characters"));
  if (!names.length) return null;
  const selected = names.slice(0, 5).join(", ");
  return {
    value: selected,
    confidence: characterDocuments.length ? (names.length === 1 ? 0.72 : 0.55) : 0.4,
    evidence: [`Selected material names ${selected}.`]
  };
}

function findRelationships(documents: IntakeDocument[], names: string[], genre: string | null): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:relationship|romance|couple|dynamic|relationship arc|love story)\s*[:\-]\s*(.{16,280})/i);
  if (labeled) return labeled;
  const pair = rankRelationshipPair(documents, names);
  if (genre === "Romance" && pair) {
    return {
      value: `${pair.names[0]} and ${pair.names[1]} share relationship evidence, but the full arc is not explicit yet.`,
      confidence: 0.58,
      evidence: [`${pair.sharedScenes} shared narrative sections, including ${pair.romanceScenes} with relationship signals.`]
    };
  }
  if (genre === "Romance" && names.length >= 2) {
    const romancePattern = signals.find((signal) => signal.genre === "Romance")?.pattern;
    const romanceSignals = romancePattern ? count(documents.map((document) => document.text).join("\n\n"), romancePattern) : 0;
    if (romanceSignals > 0) {
      return {
        value: `Relationship signals surround ${names.slice(0, 3).join(", ")}, but the selected material does not establish the arc yet.`,
        confidence: 0.34,
        evidence: [`${romanceSignals} relationship signals were found around named characters, without enough shared-scene evidence to identify the arc.`]
      };
    }
  }
  return null;
}

function findConflict(documents: IntakeDocument[], genre: string | null, names: string[]): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:central conflict|conflict|stakes|antagonist|goal|external problem|internal problem)\s*[:\-]\s*(.{20,280})/i);
  if (labeled) return labeled;
  const plotDocument = documents.find((document) => document.kinds?.includes("plot"));
  const line = plotDocument && findLine(plotDocument.text, /\b(?:must|tries to|determined to|before|unless|against|threat|secret|goal|wants to|needs to)\b/i);
  if (!line) return null;
  return {
    value: line,
    confidence: genre ? 0.58 : 0.48,
    evidence: [`Conflict-shaped language in ${plotDocument.name}${names.length ? `, alongside ${names.slice(0, 3).join(", ")}` : ""}.`]
  };
}

function findSetting(documents: IntakeDocument[]): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:setting|location|world|takes place|time period|era)\s*[:\-]\s*(.{12,220})/i);
  if (labeled) return labeled;
  const worldDocument = documents.find((document) => document.kinds?.includes("world"));
  const worldLine = worldDocument && firstUsefulLine(worldDocument.text);
  if (worldLine) return { value: worldLine, confidence: 0.62, evidence: [`Opening worldbuilding note in ${worldDocument.name}.`] };
  const proseLine = findLine(documents.map((document) => document.text).join("\n"), /\b(?:set in|takes place|located in|based in)\b/i);
  return proseLine ? { value: proseLine, confidence: 0.5, evidence: ["Setting language found in the selected prose."] } : null;
}

function findTimeline(documents: IntakeDocument[], allDocuments: IntakeDocument[]): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:timeline|chronology|series position|book number|time line|dates?)\s*[:\-]\s*(.{12,220})/i);
  if (labeled) return labeled;
  const timelineDocument = allDocuments.find((document) => document.kinds?.includes("timeline"));
  const timelineLine = timelineDocument && firstUsefulLine(timelineDocument.text);
  if (timelineLine) return { value: timelineLine, confidence: 0.72, evidence: [`Timeline material found in ${timelineDocument.name}.`] };
  const dateLine = findLine(allDocuments.map((document) => document.text).join("\n"), /\b(?:day|week|month|year|spring|summer|autumn|fall|winter|before|after)\b/i);
  return dateLine ? { value: dateLine, confidence: 0.42, evidence: ["Temporal language found in the selected material."] } : null;
}

function findStructure(documents: IntakeDocument[], allDocuments: IntakeDocument[]): IntakeFinding | null {
  const labeled = findLabeledSnippet(documents, /(?:ending|resolution|climax|epilogue|final chapter|book ending|structure|chapter plan|beat sheet)\s*[:\-]\s*(.{16,280})/i);
  if (labeled) return labeled;
  const chapterCount = allDocuments.reduce((total, document) => total + countChapterHeadings(document.text), 0);
  const plotDocument = documents.find((document) => document.kinds?.includes("plot"));
  const endingLine = findLine(documents.map((document) => document.text).join("\n"), /\b(?:happily ever after|happy ending|resolution|epilogue|final chapter|climax|ending)\b/i);
  if (endingLine) return { value: endingLine, confidence: 0.68, evidence: ["An ending or structural marker is explicit in the selected material."] };
  if (plotDocument || chapterCount > 0) {
    return {
      value: `${chapterCount || "An outlined"} chapter structure is present, but the target ending is not explicit.`,
      confidence: 0.42,
      evidence: [plotDocument ? `${plotDocument.name} is marked as plot material.` : `${chapterCount} chapter headings were found in the selected prose.`]
    };
  }
  return null;
}

function findNarration(profile: WritingProfile): IntakeFinding | null {
  if (profile.narration.confidence < 0.5) return null;
  return {
    value: profile.narration.label,
    confidence: profile.narration.confidence,
    evidence: profile.narration.evidence
  };
}

function buildSourceInventory(documents: IntakeDocument[]): ProjectAnalysis["sourceInventory"] {
  const inventory: ProjectAnalysis["sourceInventory"] = {};
  for (const document of documents) {
    const kinds = document.kinds?.length ? document.kinds : ["unclassified"];
    const wordCount = words(document.text).length;
    for (const kind of kinds) {
      inventory[kind] ??= { documents: 0, words: 0 };
      inventory[kind].documents += 1;
      inventory[kind].words += wordCount;
    }
  }
  return inventory;
}

function summariseDocument(document: IntakeDocument): IntakeSourceSummary {
  const headings = document.text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .filter((line) => line.length >= 3 && line.length <= 100 && (/^chapter\b/i.test(line) || /^\d+[.)]\s/.test(line) || /^[A-Z][^.!?]{2,70}$/.test(line)))
    .slice(0, 12);
  return { name: document.name, kinds: document.kinds ?? [], words: words(document.text).length, headings };
}

function extractNames(documents: IntakeDocument[]): string[] {
  const candidates = new Map<string, { score: number; mentions: number }>();
  const add = (candidate: string, score: number, mentions = 1) => {
    const normalized = candidate.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    if (!/^[A-Z][a-zÀ-ɏ]+(?:\s+[A-Z][a-zÀ-ɏ]+){0,3}$/.test(normalized)) return;
    if (normalized.split(/\s+/).some((token) => NON_NAME_TOKENS.has(token))) return;
    const current = candidates.get(normalized) ?? { score: 0, mentions: 0 };
    current.score += score;
    current.mentions += mentions;
    candidates.set(normalized, current);
  };

  for (const document of documents) {
    for (const match of document.text.matchAll(/(?:full\s+name|name|character|protagonist|lead)\s*[:\-]\s*([A-Z][a-zÀ-ɏ]+(?:\s+[A-Z][a-zÀ-ɏ]+){0,3})/gi)) add(match[1], 4);
    for (const match of document.text.matchAll(/\b(?:called|named)\s+([A-Z][a-zÀ-ɏ]+(?:\s+[A-Z][a-zÀ-ɏ]+){0,3})\b/g)) add(match[1], 3);

    if (!isNarrativeDocument(document)) continue;
    const narrative = narrativeText(document);
    const seen = new Map<string, { mentions: number; nonSentence: number }>();
    for (const match of narrative.matchAll(/\b([A-Z][a-zÀ-ɏ]{2,}(?:\s+[A-Z][a-zÀ-ɏ]{2,}){0,2})\b/g)) {
      const candidate = match[1];
      const before = narrative.slice(0, match.index).trimEnd();
      const previous = before.at(-1) ?? "";
      const sentenceStart = !previous || /[.!?]/.test(previous);
      const current = seen.get(candidate) ?? { mentions: 0, nonSentence: 0 };
      current.mentions += 1;
      if (!sentenceStart || insideQuotes(narrative, match.index)) current.nonSentence += 1;
      seen.set(candidate, current);
    }
    for (const [candidate, evidence] of seen) {
      if (evidence.mentions < 2 || evidence.nonSentence < 1) continue;
      add(candidate, evidence.mentions * 2 + evidence.nonSentence, evidence.mentions);
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].mentions - a[1].mentions || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name]) => name);
}

function rankRelationshipPair(documents: IntakeDocument[], names: string[]): { names: [string, string]; sharedScenes: number; romanceScenes: number } | null {
  if (names.length < 2) return null;
  const romancePattern = signals.find((signal) => signal.genre === "Romance")?.pattern;
  const scores: Array<{ names: [string, string]; sharedScenes: number; romanceScenes: number; score: number }> = [];
  const prose = documents
    .filter((document) => isNarrativeDocument(document) || isPlanningDocument(document))
    .map((document) => isNarrativeDocument(document) ? narrativeText(document) : document.text)
    .join("\n\n");
  const paragraphs = splitParagraphs(prose).map((paragraph) => paragraph.text);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const pair: [string, string] = [names[i], names[j]];
      const occurrences = paragraphs.filter((paragraph) => pair.every((name) => namePattern(name).test(paragraph)));
      const romanceScenes = occurrences.filter((paragraph) => romancePattern ? count(paragraph, romancePattern) > 0 : false).length;
      if (occurrences.length > 0 && romanceScenes > 0) scores.push({ names: pair, sharedScenes: occurrences.length, romanceScenes, score: occurrences.length + romanceScenes * 2 });
    }
  }
  return scores.sort((a, b) => b.score - a.score || b.sharedScenes - a.sharedScenes)[0] ?? null;
}

const NON_NAME_TOKENS = new Set([
  "The", "This", "That", "These", "Those", "Then", "You", "Your", "They", "Their", "Them",
  "She", "Her", "He", "His", "Him", "We", "Our", "Us", "It", "Its", "What", "When", "Where",
  "Who", "Why", "How", "Chapter", "Book", "Part", "Setting", "Conflict", "Ending", "Premise"
]);

function isNarrativeDocument(document: IntakeDocument): boolean {
  const kinds = document.kinds ?? [];
  return kinds.length === 0 || kinds.includes("past_book") || kinds.includes("reference_book");
}

function narrativeText(document: IntakeDocument): string {
  if (!isNarrativeDocument(document)) return document.text;
  const analysis = analyseManuscript(document.text);
  const start = analysis.chapters[0]?.offset ?? 0;
  return document.text.slice(start, analysis.storyEndOffset || document.text.length);
}

function insideQuotes(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const straight = (before.match(/"/g) ?? []).length;
  const curly = (before.match(/[“”]/g) ?? []).length;
  return straight % 2 === 1 || curly % 2 === 1;
}

function namePattern(name: string): RegExp {
  return new RegExp(`\\b${name.split(/\s+/).map(escapeRegExp).join("\\s+")}\\b`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findLabeledSnippet(documents: IntakeDocument[], pattern: RegExp): IntakeFinding | null {
  for (const document of documents) {
    const lines = document.text.replace(/\r/g, "").split("\n");
    for (const line of lines) {
      const match = pattern.exec(line);
      if (!match || match.index > 3 || !match[1]) continue;
      const value = cleanSnippet(match[1]);
      if (value.length < 12) continue;
      return { value, confidence: 0.86, evidence: [`Explicit planning label found in ${document.name}.`] };
    }
  }
  return null;
}

function firstUsefulLine(text: string): string | null {
  return text
    .split(/\r?\n/)
    .map(cleanSnippet)
    .find((line) => line.length >= 25 && !/^[-*#\d]/.test(line)) || null;
}

function findLine(text: string, pattern: RegExp): string | null {
  return text.split(/\r?\n/).map(cleanSnippet).find((line) => pattern.test(line) && line.length >= 18) || null;
}

function cleanSnippet(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[-*\d.)\s]+/, "").trim().slice(0, 300);
}

function countChapterHeadings(text: string): number {
  return (text.match(/^\s*(?:#{1,3}\s*)?(?:chapter|chapitre|capítulo)\s+[\dIVXLC]+/gim) ?? []).length;
}

function isPlanningDocument(document: IntakeDocument): boolean {
  const kinds = document.kinds ?? [];
  return kinds.some((kind) => ["characters", "timeline", "world", "plot", "notes"].includes(kind)) && !kinds.every((kind) => kind === "past_book" || kind === "reference_book");
}

function inferSubgenre(genre: string, text: string): string | null {
  const explicit = /\bsubgenre\s*[:\-]\s*([^\n]+)/i.exec(text)?.[1]?.trim();
  if (explicit) return explicit;
  if (genre === "Romance") {
    if (/\b(?:magic|fae|kingdom|vampire|werewolf)\b/i.test(text)) return "Fantasy romance";
    if (/\b(?:historical|regency|victorian|duke|earl)\b/i.test(text)) return "Historical romance";
    if (/\b(?:contemporary|apartment|office|city|modern)\b/i.test(text)) return "Contemporary romance";
  }
  if (genre === "Mystery" && /\b(?:small town|bakery|bookshop|tea shop|cozy)\b/i.test(text)) return "Cozy mystery";
  if (genre === "Fantasy" && /\b(?:love|kiss|boyfriend|girlfriend|romance)\b/i.test(text)) return "Romantic fantasy";
  if (genre === "Thriller" && /\b(?:mind|trauma|psychological|memory)\b/i.test(text)) return "Psychological thriller";
  return null;
}

function inferLengthRange(documents: IntakeSourceSummary[]): string | null {
  const prose = documents.filter((document) => document.kinds.includes("past_book") || document.kinds.includes("reference_book"));
  if (!prose.length) return null;
  const counts = prose.map((document) => document.words).filter((count) => count >= 1000);
  if (!counts.length) return null;
  return `${Math.min(...counts).toLocaleString()} to ${Math.max(...counts).toLocaleString()} words across the indexed prose`;
}

function count(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return (text.match(pattern) ?? []).length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
