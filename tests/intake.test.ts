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
});
