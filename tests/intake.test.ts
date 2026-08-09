import { describe, expect, it } from "vitest";
import { analyseProjectMaterial } from "../src/analysis/intake.js";

describe("project intake analysis", () => {
  it("uses reference material before asking for genre", () => {
    const result = analyseProjectMaterial([{
      name: "Storyline",
      text: "At university, the boyfriend she never expected to love kissed her in the rain. Their relationship changed everything."
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
          "Premise: Mara must choose between the love she wants and the family secret that can destroy her.",
          "Conflict: the secret threatens her relationship.",
          "Setting: a contemporary university town.",
          "Ending: the couple stays together."
        ].join("\n")
      },
      {
        name: "Mara Profile",
        kinds: ["characters"],
        text: "Name: Mara. Want: freedom. Fear: disappointing her family."
      }
    ], { shape: "series" });

    expect(result.findings.premise?.value).toMatch(/Mara/);
    expect(result.findings.centralConflict?.value).toMatch(/secret/);
    expect(result.findings.setting?.value).toMatch(/contemporary university town/);
    expect(result.findings.structure?.value).toMatch(/couple stays together/);
    expect(result.questionPlan.map((question) => question.key)).not.toEqual(expect.arrayContaining([
      "storyPromise", "centralConflict", "settingRules", "endingAndStructure"
    ]));
  });

  it("does not turn document titles or headings into characters", () => {
    const result = analyseProjectMaterial([
      { name: "Ashford Hall", kinds: ["characters"], text: "Setting: a university hall. New Year events occur here." },
      { name: "Quantum Mechanics", kinds: ["notes"], text: "Then Cas leaves. Thank God the scene ends." }
    ]);

    expect(result.findings.protagonist).toBeNull();
    expect(result.questionPlan.find((question) => question.key === "protagonistArc")?.question).not.toMatch(/Ashford|Quantum|New Year|Thank God/);
  });
});
