import { dialogueSpans, per1k, splitParagraphs, words } from "./text.js";
import { detectNarration, type Narration } from "./narration.js";
import type { BeatType } from "./corpus.js";

export interface WritingProfile {
  narration: {
    pov: Narration["pov"];
    tense: Narration["tense"];
    label: string;
    confidence: number;
    evidence: string[];
  };
  distance: {
    label: "close" | "middle" | "distant";
    filterVerbsPer1k: number;
    interiorityPer1k: number;
  };
  sensory: {
    sight: number;
    sound: number;
    touch: number;
    smell: number;
    taste: number;
    temperature: number;
    body: number;
  };
  beats: Record<BeatType, number>;
  emotion: {
    explicitPer1k: number;
    bodyCuePer1k: number;
    thoughtPer1k: number;
  };
  figurative: {
    similesPer1k: number;
    metaphorSignalsPer1k: number;
  };
  intimacy: {
    value: "None" | "Romantic tension only" | "Fade to black" | "Open door" | "Explicit" | "Very explicit";
    confidence: number;
    evidence: string[];
  };
  audience: {
    values: string[];
    confidence: number;
    evidence: string[];
  };
  evidence: string[];
}

const filterVerbs = /\b(?:saw|watched|noticed|heard|listened|felt|smelled|tasted|seemed|appeared|realized|realised|thought|wondered|knew|decided|looked|observed|sensed|considered)\b/gi;
const interiority = /\b(?:thought|wondered|remembered|realized|realised|knew|believed|hoped|feared|wanted|understood|decided|regretted|imagined|considered|suspected|felt)\b/gi;
const emotionWords = /\b(?:afraid|angry|anxious|ashamed|bitter|calm|delighted|desperate|disappointed|embarrassed|excited|furious|glad|grateful|happy|jealous|lonely|nervous|relieved|sad|scared|shocked|surprised|terrified|thrilled|worried)\b/gi;
const bodyCues = /\b(?:heart|chest|throat|stomach|jaw|hands?|fingers?|shoulders?|breath|lungs?|skin|pulse|sweat|shiver|trembl|flinch|blush|blink)\w*\b/gi;
const metaphorSignals = /\b(?:as if|as though|the shape of|a kind of|made him|made her|carried the weight|hung between|settled over)\b/gi;

const sensoryPatterns = {
  sight: /\b(?:see|saw|look|looked|watch|watched|glimpse|glanced|bright|dark|shadow|color|colour|pale|red|blue|light|shape|visible)\w*\b/gi,
  sound: /\b(?:hear|heard|sound|sounded|voice|whisper|whispered|shout|shouted|silence|noise|music|rang|ringing|thunder|laugh|laughed)\w*\b/gi,
  touch: /\b(?:touch|touched|feel|felt|rough|smooth|soft|hard|cold|hot|warm|ice|pressure|pain|ache|sting|brush|brushed)\w*\b/gi,
  smell: /\b(?:smell|smelled|scent|odor|odour|perfume|fragrant|stink|reek|smoke|coffee|rain|earth)\w*\b/gi,
  taste: /\b(?:taste|tasted|flavor|flavour|sweet|bitter|salt|sour|mouth|tongue|hunger|thirst)\w*\b/gi,
  temperature: /\b(?:cold|cool|chill|chilled|heat|hot|warm|freezing|frost|burn|burning|sweat)\w*\b/gi,
  body: bodyCues
};

const romanceSignals = /\b(?:love|loved|loving|kiss|kissed|kissing|desire|desired|attraction|attracted|romance|romantic|lips|embrace|embraced|caress|caressed|intimacy|intimate)\w*\b/gi;
const sexualSignals = /\b(?:sex|sexual|naked|nude|undress|undressed|orgasm|penetrat|climax|breast|cock|pussy|condom|thighs?|moan|moaned|groan|groaned)\w*\b/gi;
const explicitAnatomy = /\b(?:cock|pussy|clitoris|penis|vagina|orgasm|penetrat|cum|semen)\w*\b/gi;
const profanity = /\b(?:fuck|fucking|shit|bitch|bastard|damn|hell|asshole)\w*\b/gi;
const violence = /\b(?:kill|killed|murder|blood|stab|shot|shoot|weapon|fight|punched|beaten|torture|corpse|gun)\w*\b/gi;

export interface WritingSample {
  text: string;
  beat: BeatType;
}

export function analyseWriting(text: string, samples: WritingSample[] = []): WritingProfile {
  const total = words(text).length;
  const narration = detectNarration(text);
  const filter = count(text, filterVerbs);
  const interior = count(text, interiority);
  const emotion = count(text, emotionWords);
  const body = count(text, bodyCues);
  const similes = count(text, /\b(?:like a|like the|as if|as though|the way a|the way the)\b/gi);
  const metaphor = count(text, metaphorSignals);

  const distance: WritingProfile["distance"] = {
    label: filter > interior * 1.35 ? "distant" : interior > filter * 1.35 ? "close" : "middle",
    filterVerbsPer1k: per1k(filter, total),
    interiorityPer1k: per1k(interior, total)
  };

  const sensory = Object.fromEntries(
    Object.entries(sensoryPatterns).map(([key, pattern]) => [key, per1k(count(text, pattern), total)])
  ) as WritingProfile["sensory"];

  const beatCounts = { dialogue: 0, action: 0, interiority: 0, description: 0, transition: 0 } as Record<BeatType, number>;
  for (const sample of samples) beatCounts[sample.beat] += words(sample.text).length;
  const beatTotal = Object.values(beatCounts).reduce((sum, value) => sum + value, 0) || 1;
  const beats = Object.fromEntries(
    Object.entries(beatCounts).map(([key, value]) => [key, round(value / beatTotal, 3)])
  ) as Record<BeatType, number>;

  const intimacy = detectIntimacy(text);
  const audience = detectAudience(text, total);
  const narrationEvidence = [
    `${narration.pov.replace("_", " ")} POV (${Math.round(narration.povConfidence * 100)}% confidence)`,
    `${narration.tense} tense (${Math.round(narration.tenseConfidence * 100)}% confidence)`
  ];

  return {
    narration: {
      pov: narration.pov,
      tense: narration.tense,
      label: narration.label,
      confidence: round(Math.min(narration.povConfidence, narration.tenseConfidence), 2),
      evidence: narrationEvidence
    },
    distance,
    sensory,
    beats,
    emotion: {
      explicitPer1k: per1k(emotion, total),
      bodyCuePer1k: per1k(body, total),
      thoughtPer1k: per1k(interior, total)
    },
    figurative: {
      similesPer1k: per1k(similes, total),
      metaphorSignalsPer1k: per1k(metaphor, total)
    },
    intimacy,
    audience,
    evidence: [
      `${dialogueSpans(text).length} quoted dialogue spans`,
      `${splitParagraphs(text).length} prose paragraphs`,
      `${count(text, profanity)} profanity signals and ${count(text, violence)} violence signals`
    ]
  };
}

function detectIntimacy(text: string): WritingProfile["intimacy"] {
  const romance = count(text, romanceSignals);
  const sexual = count(text, sexualSignals);
  const explicit = count(text, explicitAnatomy);
  const evidence = [`${romance} romantic signals`, `${sexual} sexual-content signals`];

  if (explicit >= 4) {
    evidence.push(`${explicit} explicit anatomy or act signals`);
    return { value: "Very explicit", confidence: Math.min(0.98, 0.65 + explicit / 40), evidence };
  }
  if (explicit > 0) {
    evidence.push(`${explicit} explicit anatomy or act signals`);
    return { value: "Explicit", confidence: Math.min(0.94, 0.6 + explicit / 30), evidence };
  }
  if (sexual > 0) return { value: "Open door", confidence: Math.min(0.85, 0.55 + sexual / 30), evidence };
  if (/\b(?:fade to black|closed the door|woke the next morning)\b/i.test(text) && romance > 0) {
    return { value: "Fade to black", confidence: 0.72, evidence: [...evidence, "fade-to-black transition language"] };
  }
  if (romance > 0) return { value: "Romantic tension only", confidence: Math.min(0.78, 0.5 + romance / 40), evidence };
  return { value: "None", confidence: 0.55, evidence };
}

function detectAudience(text: string, total: number): WritingProfile["audience"] {
  const candidates: Array<{ value: string; count: number; evidence: string }> = [
    { value: "New adult", count: count(text, /\b(?:freshman|sophomore|twenty[- ]one|twenty[- ]two|twenty[- ]three)\b/gi), evidence: "early-adult markers" },
    { value: "Young adult", count: count(text, /\b(?:teenager|sixteen|seventeen|eighteen|high school|coming of age)\b/gi), evidence: "teen or coming-of-age markers" },
    { value: "Middle grade", count: count(text, /\b(?:middle school|ten-year-old|eleven-year-old|twelve-year-old)\b/gi), evidence: "middle-grade age markers" },
    { value: "Children", count: count(text, /\b(?:picture book|kindergarten|nursery|bedtime story)\b/gi), evidence: "children's-format markers" },
    { value: "Adult", count: count(text, profanity) + count(text, sexualSignals) + count(text, violence), evidence: "adult-content signals" }
  ];
  const strong = candidates.filter((candidate) => candidate.count >= 2).sort((a, b) => b.count - a.count);
  if (strong.length === 0) return { values: [], confidence: 0.25, evidence: [] };
  const values = strong.slice(0, 2).map((candidate) => candidate.value);
  const evidence = strong.slice(0, 2).map((candidate) => `${candidate.evidence} (${candidate.count} signals)`);
  return { values, confidence: round(Math.min(0.9, 0.5 + strong[0].count / Math.max(total / 1000, 1) / 10), 2), evidence };
}

function count(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return (text.match(pattern) ?? []).length;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
