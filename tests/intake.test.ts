import { describe, expect, it } from "vitest";
import { analyseProjectMaterial } from "../src/analysis/intake.js";

describe("project intake analysis", () => {
  it("uses reference material before asking for genre", () => {
    const result = analyseProjectMaterial([{
      name: "Storyline",
      text: "Subgenre: New adult romance\nThe partner she never expected to love kissed her in the rain. Their relationship changed everything."
    }]);

    expect(result.genre).toBe("Romance");
    expect(result.subgenre).toBe("New adult romance");
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.evidence.join(" ")).toMatch(/romance/i);
    expect(result.unknowns).not.toContain("genre and subgenre");
  });

  it("leaves an unsupported genre as an author question", () => {
    const result = analyseProjectMaterial([{ name: "Notes", text: "A woman waits beside a window." }]);
    expect(result.genre).toBeNull();
    expect(result.unknowns).toContain("genre and subgenre");
  });

  it("extracts book architecture and avoids asking for explicit plot facts", () => {
    const result = analyseProjectMaterial([
      {
        name: "Book plan",
        kinds: ["plot"],
        text: [
          "Premise: Rowan must choose between the love they want and the family secret that can destroy them.",
          "Conflict: the secret threatens her relationship.",
          "Setting: a contemporary coastal town.",
          "Ending: the couple stays together."
        ].join("\n")
      },
      {
        name: "Lead Profile",
        kinds: ["characters"],
        text: "Name: Rowan. Want: freedom. Fear: disappointing their family."
      }
    ], { shape: "series" });

    expect(result.findings.premise?.value).toMatch(/Rowan/);
    expect(result.findings.centralConflict?.value).toMatch(/secret/);
    expect(result.findings.setting?.value).toMatch(/contemporary coastal town/);
    expect(result.findings.structure?.value).toMatch(/couple stays together/);
    expect(result.questionPlan.map((question) => question.key)).not.toEqual(expect.arrayContaining([
      "storyPromise", "centralConflict", "settingRules", "endingAndStructure"
    ]));
  });

  it("does not turn document titles or headings into characters", () => {
    const result = analyseProjectMaterial([
      { name: "Location Notes", kinds: ["characters"], text: "Setting: a public hall. Seasonal events occur here." },
      { name: "Technical Notes", kinds: ["notes"], text: "Then the lead leaves. The scene ends." }
    ]);

    expect(result.findings.protagonist).toBeNull();
    expect(result.questionPlan.find((question) => question.key === "protagonistArc")?.question).not.toMatch(/Location Notes|Technical Notes|Seasonal events/);
  });

  it("filters sentence tokens and surfaces weak relationship evidence", () => {
    const result = analyseProjectMaterial([
      {
        name: "Plot Notes",
        kinds: ["plot"],
        text: "Romance. Character: Rowan. Character: Ellis. Rowan and Ellis keep circling each other, but the relationship arc is not yet decided."
      },
      {
        name: "Prose Sample",
        kinds: ["reference_book"],
        text: "The room was quiet. You waited by the door. Rowan looked at Ellis, and Ellis looked back."
      }
    ]);

    expect(result.findings.protagonist?.value).not.toMatch(/\b(?:The|You)\b/);
    expect(result.findings.relationships?.value).toMatch(/Rowan/);
    expect(result.findings.relationships?.value).toMatch(/Ellis/);
    expect(result.findings.relationships?.confidence).toBeLessThan(0.8);
  });
});
