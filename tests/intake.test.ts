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
});
