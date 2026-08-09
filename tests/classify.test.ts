import { describe, expect, it } from "vitest";
import { classifySource, groupSources, reviewThreshold } from "../src/analysis/classify.js";

const prose = `
Chapter One

He ran. The alley narrowed and the fence came up fast, and he was over it before he had decided to be.

"You're late," Rowan said from the dark.

"I know."

"You said an hour."

He wiped the rain off his face and did not answer. The room behind her smelled of cold coffee and old paper, and she had been awake for all of it.

Chapter Two

    The district office opened at six. By five he was already across the street, watching the door and counting the men who went in.

"Anything?" Rowan asked.

"Not yet."

Chapter Three

She had known him a long time, long enough to hear the lie under the flatness of it, and she let him keep it because there was nothing else she could give him that morning.
`.repeat(40);

describe("classification", () => {
  it("recognises a character sheet", () => {
    const result = classifySource({
      name: "cast-and-characters.md",
      text: [
        "Name: Rowan Vale",
        "Age: 34",
        "Appearance: tall, a scar across the left palm",
        "Personality: guarded, dry, loyal past reason",
        "Motivation: find who altered the record",
        "Backstory: raised in the river district",
        "Arc: from vengeance to responsibility"
      ].join("\n")
    });
    expect(result.kind).toBe("characters");
    expect(result.confidence).toBeGreaterThan(reviewThreshold);
  });

  it("recognises a person-named character document even when it is prose", () => {
    const result = classifySource({
      name: "Julian Scott Reid",
      text: "PHYSICAL APPEARANCE\nJulian is tall and athletic. His personality is guarded but loyal.\n\nPERSONALITY\nHe avoids conflict until someone he loves is threatened."
    });
    expect(result.kind).toBe("characters");
  });

  it("trusts an explicit Characters folder over prose shape", () => {
    const result = classifySource({
      name: "Cassandro Giuliano Montfort",
      path: "/His Golden Heart/Characters/Cassandro Giuliano Montfort",
      text: "PHYSICAL APPEARANCE\nCassandro is tall and athletic. His personality is guarded but loyal."
    });
    expect(result.kind).toBe("characters");
    expect(result.reasons.join(" ")).toMatch(/folder path/i);
  });

  it("recognises a timeline", () => {
    const result = classifySource({
      name: "chronology.md",
      text: [
        "Year 1203: the river district burns",
        "Year 1204: Rowan is born",
        "Year 1228: the expedition sails, and after that nothing is the same",
        "Year 1230: the record is altered",
        "Year 1231: present day, before the events of book one"
      ].join("\n")
    });
    expect(result.kind).toBe("timeline");
  });

  it("recognises worldbuilding", () => {
    const result = classifySource({
      name: "world-lore.md",
      text: [
        "# The Kingdom",
        "- The empire is split between three guilds",
        "# Religion",
        "- The guild religion forbids iron",
        "# Currency",
        "- The kingdom mints its own currency",
        "# Magic system",
        "- Magic system is bound to the tides"
      ].join("\n")
    });
    expect(result.kind).toBe("world");
  });

  it("recognises a plot outline", () => {
    const result = classifySource({
      name: "outline-draft.md",
      text: [
        "- Act one: the inciting incident is the altered record",
        "- Midpoint: Rowan learns the truth",
        "- Act two: the subplot with the expedition closes",
        "- Climax: the district office burns",
        "- Resolution: she leaves"
      ].join("\n")
    });
    expect(result.kind).toBe("plot");
  });

  it("suggests several groups for a working plan", () => {
    const result = classifySource({
      name: "Book 3 Full Plan",
      text: "* Timeline and series position\n* Detailed chapter roadmap\n* Notes on the ending and epilogue\nYear 2026: graduation."
    });
    expect(result.kind).toBe("plot");
    expect(result.suggestedKinds).toEqual(expect.arrayContaining(["plot", "timeline", "notes"]));
  });

  it("recognises a long prose manuscript as a past book", () => {
    const result = classifySource({ name: "book-1-final.md", path: "/Series/Book 1", text: prose });
    expect(result.kind).toBe("past_book");
    expect(result.reasons.join(" ")).toMatch(/prose|chapter/i);
  });

  it("files another author's novel as a reference book, not canon", () => {
    const result = classifySource({
      name: "reference-novel.md",
      path: "/Reference/Comps",
      text: `Reference Novel\n\nby Example Author\n\n${prose}`
    });
    expect(result.kind).toBe("reference_book");
  });

  it("falls back to notes for unrecognisable content", () => {
    const result = classifySource({ name: "scratch.txt", text: "buy milk\nring the bank\nmaybe the thing with the boat" });
    expect(result.kind).toBe("notes");
  });

  it("handles an empty file without crashing", () => {
    const result = classifySource({ name: "empty.md", text: "" });
    expect(result.kind).toBe("notes");
    expect(result.confidence).toBeLessThan(reviewThreshold);
  });

  it("offers an alternative for ambiguous files", () => {
    const result = classifySource({ name: "book-1-final.md", text: prose });
    expect(result.alternative).toBeDefined();
  });
});

describe("grouping", () => {
  it("groups a batch and flags low-confidence files for review", () => {
    const { groups, needsReview } = groupSources([
      { name: "characters.md", text: "Name: Rowan\nAge: 34\nAppearance: tall\nMotivation: justice\nBackstory: river district" },
      { name: "book-1.md", path: "/Series", text: prose },
      { name: "scratch.txt", text: "misc" }
    ]);

    expect(groups.characters).toHaveLength(1);
    expect(groups.past_book).toHaveLength(1);
    expect(needsReview.every((entry) => entry.classification.confidence < reviewThreshold)).toBe(true);
  });
});
