import { describe, expect, it } from "vitest";
import { splitParagraphs, splitSentences, dialogueSpans, percentile } from "../src/style/text.js";
import { computeMetrics } from "../src/style/metrics.js";
import { buildCorpus, classifyBeat, extractProse } from "../src/style/corpus.js";
import { renderExemplarPrompt, retrieveExemplars } from "../src/style/retrieve.js";
import { findRepetitions, scoreAgainstCorpus, scoreAgainstFingerprint } from "../src/style/score.js";

describe("sentence splitting", () => {
  it("does not split on abbreviations or initials", () => {
    const sentences = splitSentences("Dr. Halloway crossed the room. J. R. Vance did not move.");
    expect(sentences).toHaveLength(2);
    expect(sentences[0].text).toBe("Dr. Halloway crossed the room.");
  });

  it("keeps a dialogue tag attached to its line", () => {
    const sentences = splitSentences('"Get out." she said. He did not move.');
    expect(sentences[0].text).toBe('"Get out." she said.');
    expect(sentences).toHaveLength(2);
  });

  it("treats runs of terminal punctuation as one boundary", () => {
    expect(splitSentences("What?! Nothing... Then he left.")).toHaveLength(3);
  });
});

describe("paragraph splitting", () => {
  it("splits on blank lines and preserves sentences", () => {
    const paragraphs = splitParagraphs("One. Two.\n\nThree.");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].sentences).toHaveLength(2);
    expect(paragraphs[1].text).toBe("Three.");
  });
});

describe("dialogue extraction", () => {
  it("finds quoted speech and ignores apostrophes", () => {
    const spans = dialogueSpans(`She didn't move. "I won't ask twice," he said.`);
    expect(spans).toEqual(["I won't ask twice,"]);
  });
});

describe("percentile", () => {
  it("interpolates", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("metrics", () => {
  const clipped = "He ran. The door held. He hit it again. It gave.";
  const flowing =
    "He moved through the long corridor with a deliberate and unhurried patience, considering " +
    "the weight of everything that had happened, and the door at the far end remained closed " +
    "against him in a way that felt almost personal.";

  it("separates clipped prose from flowing prose", () => {
    expect(computeMetrics(clipped).sentence.meanWords).toBeLessThan(6);
    expect(computeMetrics(flowing).sentence.meanWords).toBeGreaterThan(20);
  });

  it("measures fragment rate", () => {
    expect(computeMetrics(clipped).sentence.fragmentRate).toBeGreaterThan(0.5);
  });

  it("measures dialogue share", () => {
    const metrics = computeMetrics('"Come here," she said. "Now."');
    expect(metrics.dialogue.wordShare).toBeGreaterThan(0.5);
  });

  it("reports full plain-tag share when there is no dialogue", () => {
    expect(computeMetrics("The room was cold and empty.").dialogue.invisibleTagShare).toBe(1);
  });

  it("counts filter verbs and abstractions per 1k", () => {
    const metrics = computeMetrics("She felt the silence. She saw the darkness. She knew the weight.");
    expect(metrics.texture.filterVerbsPer1k).toBeGreaterThan(0);
    expect(metrics.texture.abstractNounsPer1k).toBeGreaterThan(0);
  });

  it("handles empty input without dividing by zero", () => {
    const metrics = computeMetrics("");
    expect(metrics.wordCount).toBe(0);
    expect(metrics.sentence.meanWords).toBe(0);
    expect(metrics.texture.typeTokenRatio).toBe(0);
  });
});

describe("beat classification", () => {
  it("detects dialogue", () => {
    expect(classifyBeat('"Where were you?" she asked. "Out," he said. "All night?" "Yes."')).toBe("dialogue");
  });

  it("detects action", () => {
    expect(
      classifyBeat("He ran. He grabbed the rail and pulled himself over, then dropped and rolled and came up running.")
    ).toBe("action");
  });

  it("detects interiority", () => {
    expect(
      classifyBeat(
        "She wondered whether he had known all along. She remembered the letter and understood, finally, what it had meant, and she decided she would not forgive it."
      )
    ).toBe("interiority");
  });
});

describe("prose extraction", () => {
  it("strips headings, front matter, tables and fences", () => {
    const prose = extractProse("---\ntitle: X\n---\n# Chapter One\n\nHe walked in.\n\n| a | b |\n\n> quote\n");
    expect(prose).toBe("He walked in.");
  });
});

const sampleBook = `
# Chapter One

He ran. The alley narrowed. He hit the fence, hauled himself over, and dropped hard on the far side.

Behind him someone shouted. He did not look back. He pushed off the wall and kept going, lungs burning, the wet street sliding under his boots.

"You're late," Mara said.

"I know."

"You said an hour."

"I know that too." He wiped his face. "There were complications."

She looked at him for a long moment. Then she stepped aside and let him in.

The room was small and smelled of cold coffee. A single lamp burned on the table. Papers everywhere, stacked and pinned and annotated in her cramped hand.

He wondered how long she had been at it. He remembered her at the academy, the same posture, the same refusal to sleep. He decided not to ask.
`;

describe("corpus", () => {
  const corpus = buildCorpus("Test Book", [{ source: "book-one.md", text: sampleBook }]);

  it("builds passages with provenance and metrics", () => {
    expect(corpus.passages.length).toBeGreaterThan(0);
    expect(corpus.passages[0].source).toBe("book-one.md");
    expect(corpus.passages[0].metrics.wordCount).toBeGreaterThan(0);
    expect(corpus.fingerprint.wordCount).toBeGreaterThan(50);
  });

  it("detects character names as speakers", () => {
    expect(corpus.passages.some((passage) => passage.speakers.includes("Mara"))).toBe(true);
  });

  it("classifies at least one passage as dialogue", () => {
    expect(corpus.passages.some((passage) => passage.beat === "dialogue")).toBe(true);
  });
});

describe("retrieval", () => {
  const corpus = buildCorpus("Test Book", [
    { source: "book-one.md", text: sampleBook },
    { source: "book-two.md", text: sampleBook.replace(/Mara/g, "Iselle") }
  ]);

  it("prefers passages of the requested beat", () => {
    const results = retrieveExemplars(corpus, { beat: "dialogue" }, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].passage.beat).toBe("dialogue");
    expect(results[0].reasons.join(" ")).toContain("same beat");
  });

  it("boosts passages featuring the requested characters", () => {
    const results = retrieveExemplars(corpus, { beat: "dialogue", characters: ["Iselle"] }, { limit: 2 });
    expect(results[0].passage.text).toContain("Iselle");
  });

  it("respects the word budget", () => {
    const results = retrieveExemplars(corpus, { beat: "action" }, { limit: 10, maxWords: 60 });
    const total = results.reduce((sum, entry) => sum + entry.passage.wordCount, 0);
    expect(total).toBeLessThanOrEqual(60);
  });

  it("renders a prompt that forbids copying content", () => {
    const results = retrieveExemplars(corpus, { beat: "dialogue" }, { limit: 2 });
    const prompt = renderExemplarPrompt(results, { beat: "dialogue" });
    expect(prompt).toContain("Never reuse");
    expect(prompt).toContain("Exemplar 1");
  });

  it("degrades gracefully with no matches", () => {
    const empty = buildCorpus("Empty", []);
    const prompt = renderExemplarPrompt(retrieveExemplars(empty, { beat: "action" }), { beat: "action" });
    expect(prompt).toContain("No exemplars matched");
  });
});

describe("repetition detection", () => {
  it("flags repeated sentence openers", () => {
    const draft = Array.from({ length: 10 }, (_, i) => `She felt the cold air number ${i}.`).join(" ");
    const findings = findRepetitions(draft);
    expect(findings.some((finding) => finding.kind === "sentence-opener")).toBe(true);
  });

  it("flags uniform paragraph length", () => {
    const paragraph = "He crossed the room and opened the window and looked out at the street below him now.";
    const findings = findRepetitions(Array.from({ length: 8 }, () => paragraph).join("\n\n"));
    expect(findings.some((finding) => finding.kind === "paragraph-shape")).toBe(true);
  });

  it("flags an overused dialogue tag", () => {
    const draft = Array.from({ length: 6 }, (_, i) => `"Line ${i}," she whispered.`).join("\n\n");
    const findings = findRepetitions(draft);
    expect(findings.some((finding) => finding.kind === "dialogue-tag" && finding.value === "whispered")).toBe(true);
  });

  it("stays quiet on varied prose", () => {
    const varied = `He ran.\n\nThe alley narrowed to nothing, and by the time he reached the fence his lungs were raw.\n\n"Stop," she said.\n\nHe did not.`;
    expect(findRepetitions(varied).filter((finding) => finding.severity === "blocker")).toHaveLength(0);
  });
});

describe("style scoring", () => {
  const corpus = buildCorpus("Test Book", [{ source: "book-one.md", text: sampleBook }]);

  it("scores the author's own prose highly", () => {
    const report = scoreAgainstCorpus(sampleBook, corpus);
    expect(report.fidelity).toBeGreaterThan(80);
    expect(report.verdict).toBe("pass");
  });

  it("penalises prose written in a different shape", () => {
    const offStyle = Array.from({ length: 12 }, () =>
      "She felt an overwhelming sense of profound and ineffable longing that seemed to settle upon her " +
      "with the crushing and inexorable weight of everything she had ever silently endured."
    ).join("\n\n");
    const report = scoreAgainstCorpus(offStyle, corpus);
    expect(report.fidelity).toBeLessThan(60);
    expect(report.verdict).toBe("fail");
    expect(report.instructions.length).toBeGreaterThan(0);
  });

  it("warns when the corpus is too small to trust", () => {
    const report = scoreAgainstCorpus("He ran.", corpus);
    expect(report.notes.join(" ")).toContain("noisy");
  });

  it("does not explode on an empty fingerprint", () => {
    const report = scoreAgainstFingerprint("He ran fast.", computeMetrics(""));
    expect(report.fidelity).toBeGreaterThanOrEqual(0);
    expect(report.fidelity).toBeLessThanOrEqual(100);
  });
});
