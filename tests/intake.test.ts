import { describe, expect, it } from "vitest";
import { analyseProjectMaterial, applyAnalysisEdits, deriveAnalysisGaps, hasAnalysisEdits } from "../src/analysis/intake.js";

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

  it("does not call ordinary romance language fantasy", () => {
    const result = analyseProjectMaterial([{
      name: "Romance notes",
      kinds: ["plot"],
      text: "Premise: The magic of their first kiss changes how they see each other. They build a quiet life in the city."
    }]);
    expect(result.genre).toBe("Romance");
    expect(result.subgenre).not.toBe("Fantasy romance");
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

  it("does not cut a conflict finding in the middle of a sentence", () => {
    const conflict = [
      "A three-volume structure works beautifully if the final volume is allowed to become the full completion of the protagonist's first-year transformation.",
      "The romance, the first sexual intimacy, and the boyfriend confirmation have already been earned.",
      "The final volume does not need to repeat those milestones.",
      "It needs to test what the transformation costs when the relationship is no longer new."
    ].join(" ");
    const result = analyseProjectMaterial([{
      name: "Project analysis notes",
      kinds: ["plot"],
      text: `Conflict and stakes: ${conflict}`
    }]);

    expect(result.findings.centralConflict?.value).toMatch(/[.!?]$/);
    expect(result.findings.centralConflict?.value).not.toMatch(/what t$/);
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

    expect(result.findings.protagonist).toBeNull();
    expect(result.findings.cast?.value).toMatch(/Rowan/);
    expect(result.findings.cast?.value).toMatch(/Ellis/);
    expect(result.findings.cast?.value).not.toMatch(/\b(?:The|You|And|But)\b/);
    expect(result.findings.relationships?.value).toMatch(/Rowan/);
    expect(result.findings.relationships?.value).toMatch(/Ellis/);
    expect(result.findings.relationships?.value).not.toMatch(/\b(?:And|But)\b/);
    expect(result.findings.relationships?.confidence).toBeLessThan(0.8);
    expect(result.questionPlan.find((question) => question.key === "relationshipArc")?.question).not.toMatch(/\.,/);
  });

  it("does not promote dialogue interjections to cast members", () => {
    const result = analyseProjectMaterial([{
      name: "Prose Sample",
      kinds: ["reference_book"],
      text: "Chapter One\n\n\"Yeah,\" Rowan said. \"Okay,\" Ellis answered. Ellis moved away. There was no one else in the room. Rowan shut the door."
    }]);

    expect(result.findings.cast?.value).toMatch(/Rowan/);
    expect(result.findings.cast?.value).toMatch(/Ellis/);
    expect(result.findings.cast?.value).not.toMatch(/\b(?:Yeah|Okay|There)\b/);
  });

  it("reports an epilogue separately from the ending", () => {
    const result = analyseProjectMaterial([{
      name: "Book plan",
      kinds: ["plot"],
      text: "Ending: the couple chooses a quiet life together.\nEpilogue: Five years later, they open the bakery."
    }]);

    expect(result.findings.structure?.value).toMatch(/quiet life together/);
    expect(result.findings.epilogue?.value).toBe("Present: Five years later, they open the bakery.");
  });

  it("reports a prologue separately and asks for book targets without past books", () => {
    const result = analyseProjectMaterial([{
      name: "Starting brief",
      kinds: ["notes"],
      text: "Prologue: Before the move, the promise is made. Premise: A student returns home to choose a different life."
    }], { pastBookCount: 0 });

    expect(result.findings.prologue?.value).toMatch(/Before the move/);
    expect(result.questionPlan.map((question) => question.key)).toEqual(expect.arrayContaining([
      "chapterWords", "chapterCount", "lengthTarget", "epilogue"
    ]));
    expect(result.questionPlan.map((question) => question.key)).not.toContain("prologue");
  });

  it("uses character documents to separate main cast from incidental named people", () => {
    const result = analyseProjectMaterial([
      { name: "Mara Voss", kinds: ["characters"], text: "Mara is the viewpoint character." },
      { name: "Tess Arden", kinds: ["characters"], text: "Tess is Mara's closest friend." },
      {
        name: "Prior novel",
        kinds: ["past_book"],
        text: "Mara looked across the room at Tess. Tess nodded to Mara. A man named Noah waved from the doorway. The lights dimmed. His coat was still wet."
      }
    ]);

    expect(result.findings.cast?.value).toBe("Mara, Tess");
    expect(result.findings.cast?.value).not.toMatch(/Noah|The|His/);
  });

  it("recognizes an established couple from selected prior material", () => {
    const result = analyseProjectMaterial([
      {
        name: "Series plan",
        kinds: ["plot"],
        text: "Character: Morgan. Character: Riley. Morgan and Riley are already a couple at the opening."
      },
      {
        name: "Prior novel",
        kinds: ["past_book"],
        text: "Morgan kissed Riley before they went home. Riley was Morgan's boyfriend, and they were happy together."
      }
    ]);

    expect(result.findings.relationships?.value).toMatch(/established as a romantic couple/);
    expect(result.findings.relationships?.confidence).toBeGreaterThan(0.8);
    expect(result.questionPlan.map((question) => question.key)).not.toContain("relationshipArc");
  });

  it("infers the lead from focus and arc evidence without hardcoding a cast", () => {
    const result = analyseProjectMaterial([
      {
        name: "Novel plan",
        kinds: ["plot"],
        text: "The story focuses on Morgan and Riley, but Morgan owns the emotional arc. Morgan's first-year transformation is the spine of the final volume."
      },
      { name: "Character notes", kinds: ["characters"], text: "Name: Morgan. Name: Riley." }
    ], { shape: "series" });

    expect(result.findings.protagonist?.value).toBe("Morgan");
    expect(result.findings.protagonist?.confidence).toBeGreaterThan(0.8);
    expect(result.questionPlan.map((question) => question.key)).not.toContain("protagonistArc");
  });

  it("reads author notes as material without counting them as a document", () => {
    const documents = [{ name: "Notes", kinds: ["notes"], text: "A woman waits beside a window." }];
    const plain = analyseProjectMaterial(documents);
    const noted = analyseProjectMaterial(documents, {
      authorNotes: "Premise: she must choose between the love she wants and the town that raised her."
    });

    expect(plain.findings.premise).toBeNull();
    expect(noted.findings.premise?.value).toMatch(/love she wants/);
    expect(noted.documentsRead).toBe(plain.documentsRead);
    expect(noted.wordsRead).toBeGreaterThan(plain.wordsRead);
    expect(noted.authorNotes).toMatch(/Premise/);
  });
});

describe("author corrections to an analysis", () => {
  const analysis = () => analyseProjectMaterial([
    { name: "Notes", kinds: ["plot"], text: "Premise: Cole hunts the thing in the water and loses his nerve." }
  ]);

  it("replaces a measured finding and closes the question it left open", () => {
    const before = analysis();
    expect(before.questionPlan.map((question) => question.key)).toContain("protagonistArc");

    const after = deriveAnalysisGaps(applyAnalysisEdits(before, {
      findings: { protagonist: "Mara, who wants the harbour back and must give up the boat to get it." }
    }));

    expect(after.findings.protagonist?.value).toMatch(/^Mara/);
    expect(after.findings.protagonist?.authorEdited).toBe(true);
    expect(after.findings.protagonist?.confidence).toBe(1);
    expect(after.questionPlan.map((question) => question.key)).not.toContain("protagonistArc");
    expect(after.unknowns).not.toContain("protagonist arc");
  });

  it("clears a finding the analyzer invented", () => {
    const after = deriveAnalysisGaps(applyAnalysisEdits(analysis(), { findings: { premise: "  " } }));
    expect(after.findings.premise).toBeNull();
    expect(after.unknowns).toContain("target-book story promise");
    expect(after.questionPlan.map((question) => question.key)).toContain("storyPromise");
  });

  it("takes an author genre over the measured one", () => {
    const after = applyAnalysisEdits(analysis(), { genre: "Horror", subgenre: "Coastal horror" });
    expect(after.genre).toBe("Horror");
    expect(after.subgenre).toBe("Coastal horror");
    expect(after.confidence).toBe(1);
    expect(after.evidence[0]).toMatch(/set by the author/i);
  });

  it("reports whether anything was corrected", () => {
    expect(hasAnalysisEdits(undefined)).toBe(false);
    expect(hasAnalysisEdits({})).toBe(false);
    expect(hasAnalysisEdits({ findings: {} })).toBe(false);
    expect(hasAnalysisEdits({ genre: null })).toBe(true);
    expect(hasAnalysisEdits({ findings: { setting: "A harbour town" } })).toBe(true);
  });
});
