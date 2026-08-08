/**
 * The continuity ledger: typed state carried from one chapter into the next.
 *
 * The old workflow had a `continuity_update` phase whose entire contract was a
 * markdown file the next agent was asked to "read and respect". Nothing checked
 * that it did. That is why chapters did not flow: chapter 7 could open with a
 * character in a city chapter 6 had just seen them leave, resolve a thread
 * chapter 4 had already resolved, or have someone act on a secret they were
 * never told -- and no gate in the pipeline could notice.
 *
 * Here the state is structured, so the handoff between chapters is a contract
 * that can be validated (`validate.ts`) rather than a document that can be
 * skimmed.
 */

/** Where a character stands as a chapter ends. */
export interface CharacterState {
  name: string;
  /** Where they physically are when the chapter closes. */
  location: string;
  /** Facts they now know. Used to catch characters acting on secrets. */
  knows: string[];
  /** Injuries, exhaustion, intoxication -- anything that constrains the next scene. */
  condition: string;
  /** Emotional register they exit on, so the next appearance is continuous. */
  emotionalState: string;
  /** Who they are currently with. */
  withCharacters: string[];
  lastSeenChapter: number;
}

export type ThreadStatus = "open" | "advanced" | "resolved" | "abandoned";

/** An open dramatic question the book owes the reader an answer to. */
export interface Thread {
  id: string;
  /** Phrased as a question: "Who sent the letter?" */
  question: string;
  openedChapter: number;
  lastTouchedChapter: number;
  status: ThreadStatus;
  /** Chapter by which this must be resolved, if the plan commits to one. */
  mustResolveBy?: number;
  /** How central this is; drives how loudly staleness is reported. */
  weight: "main" | "subplot" | "minor";
}

/** A setup that obliges a payoff -- Chekhov's ledger. */
export interface Promise_ {
  id: string;
  setup: string;
  plantedChapter: number;
  paidOffChapter?: number;
}

export interface TimelinePoint {
  chapter: number;
  /** In-world time the chapter ends at, e.g. "Day 4, dusk". */
  endsAt: string;
  /** Elapsed in-world time this chapter covered, e.g. "about six hours". */
  elapsed: string;
  /** True when the chapter deliberately moves backwards in time. */
  isFlashback: boolean;
}

/** Everything true at the end of one chapter. */
export interface ChapterHandoff {
  chapter: number;
  title: string;
  /** Where the chapter physically leaves the story. */
  endsAtLocation: string;
  timeline: TimelinePoint;
  characters: CharacterState[];
  /** Facts established that later chapters may rely on. */
  newFacts: string[];
  /** The emotional note the chapter closes on. */
  closingBeat: string;
  /**
   * The hook the next chapter must answer, honour, or deliberately subvert.
   * This is the single most important field for flow.
   */
  openQuestion: string;
}

/** The whole book's continuity state. */
export interface ContinuityLedger {
  bookTitle: string;
  /** Standalone books carry no prior-book canon; series books inherit it. */
  projectShape: "standalone" | "series";
  /** For series books: canon inherited from earlier volumes. */
  inheritedCanon: string[];
  chaptersComplete: number;
  plannedChapters: number;
  handoffs: ChapterHandoff[];
  threads: Thread[];
  promises: Promise_[];
  updatedAt: string;
}

export function emptyLedger(bookTitle: string, plannedChapters: number, projectShape: "standalone" | "series" = "standalone"): ContinuityLedger {
  return {
    bookTitle,
    projectShape,
    inheritedCanon: [],
    chaptersComplete: 0,
    plannedChapters,
    handoffs: [],
    threads: [],
    promises: [],
    updatedAt: new Date().toISOString()
  };
}

/** The handoff for a given chapter, if it exists. */
export function handoffFor(ledger: ContinuityLedger, chapter: number): ChapterHandoff | undefined {
  return ledger.handoffs.find((handoff) => handoff.chapter === chapter);
}

/** The most recent state recorded for a character across all handoffs. */
export function latestCharacterState(ledger: ContinuityLedger, name: string): CharacterState | undefined {
  const key = name.toLowerCase();
  let latest: CharacterState | undefined;
  for (const handoff of ledger.handoffs) {
    for (const character of handoff.characters) {
      if (character.name.toLowerCase() !== key) continue;
      if (!latest || character.lastSeenChapter >= latest.lastSeenChapter) latest = character;
    }
  }
  return latest;
}

/** Record a completed chapter and roll the ledger forward. */
export function applyHandoff(ledger: ContinuityLedger, handoff: ChapterHandoff): ContinuityLedger {
  const handoffs = [...ledger.handoffs.filter((entry) => entry.chapter !== handoff.chapter), handoff].sort(
    (a, b) => a.chapter - b.chapter
  );

  return {
    ...ledger,
    handoffs,
    chaptersComplete: Math.max(ledger.chaptersComplete, handoff.chapter),
    updatedAt: new Date().toISOString()
  };
}
