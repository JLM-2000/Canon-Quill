import { describe, expect, it } from "vitest";
import { measureFormatting, renderFormattingReference } from "../src/style/formatting.js";

describe("formatting references", () => {
  it("measures marked dialogue and emphasis without making it part of the voice corpus", () => {
    const observations = measureFormatting([
      { source: "uploaded-plan.md", text: '**"Say it."**\n\n*Julian thought about it.*' },
      { source: "drive-notes.md", text: '"Plain dialogue."' }
    ]);

    expect(observations[0]).toMatchObject({ boldDialogueCount: 1, italicCount: 1 });
    expect(observations[1].boldDialogueCount).toBe(0);
    expect(renderFormattingReference(observations)).toContain("Bold dialogue including its quotation marks");
  });
});
