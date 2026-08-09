import { describe, expect, it } from "vitest";
import {
  applyHandoff,
  emptyLedger,
  handoffFor,
  latestCharacterState,
  type ChapterHandoff,
  type ContinuityLedger
} from "../src/continuity/ledger.js";
import { buildOpeningBrief, renderFlowReport, validateFlow } from "../src/continuity/flow.js";

function handoff(overrides: Partial<ChapterHandoff> = {}): ChapterHandoff {
  return {
    chapter: 1,
    title: "Opening",
    endsAtLocation: "North Station",
    timeline: { chapter: 1, endsAt: "Day 2, dusk", elapsed: "six hours", isFlashback: false },
    characters: [
      {
        name: "Rowan",
        location: "North Station",
        knows: ["the record was altered"],
        condition: "a cut across their palm",
        emotionalState: "cornered",
        withCharacters: ["Ellis"],
        lastSeenChapter: 1
      }
    ],
    newFacts: ["The record belongs to the district office"],
    closingBeat: "They hide the document.",
    openQuestion: "Who altered the record?",
    ...overrides
  };
}

function ledgerWith(h: ChapterHandoff, extra: Partial<ContinuityLedger> = {}): ContinuityLedger {
  return { ...applyHandoff(emptyLedger("Test Book", 10), h), ...extra };
}

describe("ledger", () => {
  it("records handoffs and advances progress", () => {
    const ledger = ledgerWith(handoff());
    expect(ledger.chaptersComplete).toBe(1);
    expect(handoffFor(ledger, 1)?.title).toBe("Opening");
  });

  it("replaces a handoff for the same chapter rather than duplicating", () => {
    const ledger = applyHandoff(ledgerWith(handoff()), handoff({ title: "Rewritten" }));
    expect(ledger.handoffs).toHaveLength(1);
    expect(handoffFor(ledger, 1)?.title).toBe("Rewritten");
  });

  it("finds the latest state for a character", () => {
    const ledger = applyHandoff(
      ledgerWith(handoff()),
      handoff({
        chapter: 2,
        characters: [
          {
            name: "Rowan",
            location: "East Station",
            knows: ["the record was altered", "Ellis lied"],
            condition: "",
            emotionalState: "set",
            withCharacters: [],
            lastSeenChapter: 2
          }
        ]
      })
    );
    expect(latestCharacterState(ledger, "rowan")?.location).toBe("East Station");
  });
});

describe("opening brief", () => {
  it("states the contract for the next chapter", () => {
    const brief = buildOpeningBrief(ledgerWith(handoff()), 2);
    expect(brief).toContain("North Station");
    expect(brief).toContain("Who altered the record?");
    expect(brief).toContain("a cut across their palm");
    expect(brief).toContain("Rules for this chapter's opening");
  });

  it("handles the first chapter without a prior handoff", () => {
    expect(buildOpeningBrief(emptyLedger("Test", 10), 1)).toContain("opening chapter");
  });

  it("surfaces inherited canon for a series", () => {
    const ledger = { ...emptyLedger("Test", 10, "series"), inheritedCanon: ["Ellis left in the previous volume"] };
    expect(buildOpeningBrief(ledger, 1)).toContain("Ellis left in the previous volume");
  });

  it("flags threads going cold", () => {
    const ledger = ledgerWith(handoff(), {
      threads: [
        { id: "t1", question: "Where is the fleet?", openedChapter: 1, lastTouchedChapter: 1, status: "open", weight: "main" }
      ]
    });
    expect(buildOpeningBrief(ledger, 6)).toContain("going cold");
  });
});

describe("flow validation", () => {
  const base = ledgerWith(handoff());

  it("passes a chapter that honours the handoff", () => {
    const draft =
      "Rowan stayed in North Station through the night, their palm still bandaged. The record was altered, and they meant to find out who had done it.";
    const claimed = handoff({
      chapter: 2,
      timeline: { chapter: 2, endsAt: "Day 3, dawn", elapsed: "a night", isFlashback: false },
      characters: [
        {
          name: "Rowan",
          location: "North Station",
          knows: ["the record was altered"],
          condition: "a cut across their palm",
          emotionalState: "set",
          withCharacters: [],
          lastSeenChapter: 2
        }
      ]
    });
    const report = validateFlow(base, 2, draft, claimed);
    expect(report.verdict).toBe("pass");
    expect(report.issues).toHaveLength(0);
  });

  it("catches a character teleporting between chapters", () => {
    const draft = "Rowan woke in East Station with the sun already high. Who had altered the record still gnawed at them.";
    const claimed = handoff({
      chapter: 2,
      timeline: { chapter: 2, endsAt: "Day 3, noon", elapsed: "a day", isFlashback: false },
      characters: [
        {
          name: "Rowan",
          location: "East Station",
          knows: ["the record was altered"],
          condition: "a cut across their palm",
          emotionalState: "set",
          withCharacters: [],
          lastSeenChapter: 2
        }
      ]
    });
    const report = validateFlow(base, 2, draft, claimed);
    expect(report.verdict).toBe("fail");
    expect(report.issues.some((issue) => issue.kind === "location-jump")).toBe(true);
  });

  it("accepts a relocation when travel is shown", () => {
    const draft =
      "They rode out of North Station before dawn and reached East Station by dusk. Rowan's palm ached the whole way. Who altered the record was all they thought about.";
    const claimed = handoff({
      chapter: 2,
      timeline: { chapter: 2, endsAt: "Day 3, dusk", elapsed: "a day", isFlashback: false },
      characters: [
        {
          name: "Rowan",
          location: "East Station",
          knows: ["the record was altered"],
          condition: "a cut across their palm",
          emotionalState: "set",
          withCharacters: [],
          lastSeenChapter: 2
        }
      ]
    });
    expect(validateFlow(base, 2, draft, claimed).issues.some((i) => i.kind === "location-jump")).toBe(false);
  });

  it("catches a timeline running backwards without a flashback marker", () => {
    const draft = "Rowan remained in North Station. Who altered the record, they did not yet know.";
    const claimed = handoff({
      chapter: 2,
      timeline: { chapter: 2, endsAt: "Day 1, noon", elapsed: "a day", isFlashback: false }
    });
    const report = validateFlow(base, 2, draft, claimed);
    expect(report.issues.some((issue) => issue.kind === "timeline-regression")).toBe(true);
  });

  it("allows a declared flashback to move backwards", () => {
    const draft = "Rowan remained in North Station. Who altered the record, they did not yet know.";
    const claimed = handoff({
      chapter: 2,
      timeline: { chapter: 2, endsAt: "Day 1, noon", elapsed: "a day", isFlashback: true }
    });
    expect(validateFlow(base, 2, draft, claimed).issues.some((i) => i.kind === "timeline-regression")).toBe(false);
  });

  it("catches a dropped hook", () => {
    const draft = "Rowan stayed in North Station and spent the morning sorting papers, thinking of nothing at all.";
    const report = validateFlow(base, 2, draft, handoff({ chapter: 2 }));
    expect(report.issues.some((issue) => issue.kind === "dropped-hook")).toBe(true);
  });

  it("catches a character acting on knowledge they never gained", () => {
    const draft = "Rowan stayed in North Station. Who altered the record was still the question.";
    const claimed = handoff({
      chapter: 2,
      characters: [
        {
          name: "Rowan",
          location: "North Station",
          knows: ["the record was altered", "Ellis betrayed them"],
          condition: "a cut across their palm",
          emotionalState: "set",
          withCharacters: [],
          lastSeenChapter: 2
        }
      ]
    });
    const report = validateFlow(base, 2, draft, claimed);
    expect(report.issues.some((issue) => issue.kind === "knowledge-violation")).toBe(true);
  });

  it("flags an overdue thread as a blocker", () => {
    const ledger = ledgerWith(handoff(), {
      threads: [
        { id: "t1", question: "Where is the fleet?", openedChapter: 1, lastTouchedChapter: 1, status: "open", weight: "main", mustResolveBy: 3 }
      ]
    });
    const report = validateFlow(ledger, 4, "Rowan stayed in North Station. Who altered the record?", handoff({ chapter: 4 }));
    expect(report.issues.some((issue) => issue.kind === "overdue-thread" && issue.severity === "blocker")).toBe(true);
  });

  it("flags unpaid promises as the book runs out of chapters", () => {
    const ledger = ledgerWith(handoff(), {
      plannedChapters: 10,
      promises: [{ id: "p1", setup: "the locked drawer", plantedChapter: 2 }]
    });
    const report = validateFlow(ledger, 10, "Rowan stayed in North Station. Who altered the record?", handoff({ chapter: 10 }));
    expect(report.issues.some((issue) => issue.kind === "unpaid-promise")).toBe(true);
  });

  it("renders a readable report", () => {
    const report = validateFlow(base, 2, "Nothing happens here at all.", handoff({ chapter: 2 }));
    const markdown = renderFlowReport(report);
    expect(markdown).toContain("Chapter Flow Report");
    expect(markdown).toContain("| Severity |");
  });
});
