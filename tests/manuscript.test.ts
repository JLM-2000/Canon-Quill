import { describe, expect, it } from "vitest";
import { analyseManuscript, mergeContinuation, renderContinuationBrief } from "../src/analysis/manuscript.js";

const chapter = (heading: string, body: string) => `${heading}\n\n${body}\n\n`;
const prose =
  "He crossed the yard before the light came up, boots loud on the frost. " +
  "The gate was open, which it never was, and he stood a moment working out what that meant. " +
  "Nothing good, he decided, and went through it anyway.";

describe("chapter detection", () => {
  it("finds markdown headings", () => {
    const text = chapter("# Chapter One", prose) + chapter("# Chapter Two", prose);
    const a = analyseManuscript(text);
    expect(a.chapters).toHaveLength(2);
    expect(a.chapters[0].heading).toBe("# Chapter One");
  });

  it("finds plain chapter lines with no markdown", () => {
    const text = chapter("Chapter One", prose) + chapter("Chapter Two", prose) + chapter("Chapter Three", prose);
    expect(analyseManuscript(text).chapters).toHaveLength(3);
  });

  it("does not count book-cover metadata as a chapter", () => {
    const text = [
      "The River House",
      "The Silver Door",
      "Book 7",
      "A. Writer",
      "________________",
      "CHAPTER I",
      prose
    ].join("\n");
    const analysis = analyseManuscript(text);
    expect(analysis.chapters).toHaveLength(1);
    expect(analysis.chapters[0].heading).toBe("CHAPTER I");
  });

  it("finds all-caps headings", () => {
    const text = chapter("THE HARBOUR OFFICE", prose) + chapter("WHAT MARA KNEW", prose);
    expect(analyseManuscript(text).chapters).toHaveLength(2);
  });

  it("does not treat all-caps signage inside prose as a chapter", () => {
    const text = chapter("CHAPTER ONE", `${prose} Above the gate were the words:\nCITY HALL\nThe driver continued on.`);
    const analysis = analyseManuscript(text);
    expect(analysis.chapters).toHaveLength(1);
    expect(analysis.chapters[0].wordCount).toBeGreaterThan(30);
  });

  it("treats a document with no headings as one body of work", () => {
    const a = analyseManuscript(prose);
    expect(a.chapters).toHaveLength(1);
    expect(a.totalWords).toBeGreaterThan(30);
  });

  it("does not mistake a scene break for a chapter", () => {
    const text = chapter("# Chapter One", `${prose}\n\n***\n\n${prose}`);
    expect(analyseManuscript(text).chapters).toHaveLength(1);
  });

  it("handles an empty document without throwing", () => {
    const a = analyseManuscript("");
    expect(a.totalWords).toBe(0);
    expect(a.chapters).toHaveLength(0);
  });
});

describe("whether the draft is finished", () => {
  it("treats a clean ending as complete", () => {
    const a = analyseManuscript(chapter("# Chapter One", prose));
    expect(a.lastChapterComplete).toBe(true);
  });

  it("catches a draft that stops mid-sentence", () => {
    const a = analyseManuscript(chapter("# Chapter One", "He reached for the door and then"));
    expect(a.lastChapterComplete).toBe(false);
    expect(a.completenessReason).toMatch(/no closing punctuation|unfinished/i);
  });

  it("catches a sentence that ends on a conjunction", () => {
    const a = analyseManuscript(chapter("# Chapter One", "She turned the key and pushed, and."));
    expect(a.lastChapterComplete).toBe(false);
  });

  it("keeps an explicitly numbered unfinished chapter in the chapter list", () => {
    const a = analyseManuscript(chapter("# Chapter One", prose) + chapter("# Chapter Two", "A"));
    expect(a.chapters).toHaveLength(2);
    expect(a.lastChapterComplete).toBe(false);
    expect(a.completenessReason).toMatch(/no closing punctuation/i);
  });

  it("flags a final section far shorter than the others", () => {
    const long = Array.from({ length: 30 }, () => prose).join(" ");
    const text = chapter("# One", long) + chapter("# Two", long) + chapter("# Three", long) + chapter("# Four", prose);
    const a = analyseManuscript(text);
    expect(a.lastChapterComplete).toBe(false);
    expect(a.completenessReason).toMatch(/part-written/);
  });

  it("accepts a closing quotation mark as an ending", () => {
    const a = analyseManuscript(chapter("# Chapter One", `${prose} "Go home," she said."`));
    expect(a.lastChapterComplete).toBe(true);
  });

  it("keeps an epilogue separate from the main ending", () => {
    const text = chapter("# Chapter One", prose) + chapter("Epilogue", "Five years later, the bakery was full.");
    const a = analyseManuscript(text);

    expect(a.chapters).toHaveLength(1);
    expect(a.epilogue?.heading).toBe("Epilogue");
    expect(a.lastChapterComplete).toBe(true);
    expect(a.tail).not.toContain("Five years later");
    expect(renderContinuationBrief(a, "draft.gdoc")).toContain("New chapters go before the epilogue");
  });
});

describe("typographic conventions", () => {
  it("reads the heading style and case", () => {
    const a = analyseManuscript(chapter("CHAPTER ONE", prose) + chapter("CHAPTER TWO", prose));
    expect(a.conventions.headingExample).toBe("CHAPTER ONE");
    expect(a.conventions.headingCase).toBe("upper");
  });

  it("reads the scene break marker", () => {
    const a = analyseManuscript(chapter("# One", `${prose}\n\n* * *\n\n${prose}`));
    expect(a.conventions.sceneBreak).toBe("* * *");
  });

  it("tells curly quotes from straight", () => {
    expect(analyseManuscript(`“Go,” she said. “Now.” “Please.”`).conventions.quotes).toBe("curly");
    expect(analyseManuscript(`"Go," she said. "Now." "Please."`).conventions.quotes).toBe("straight");
  });

  it("tells em dashes from double hyphens", () => {
    expect(analyseManuscript("He stopped—then went on—again—and again.").conventions.dashes).toBe("em");
    expect(analyseManuscript("He stopped--then went on--again--and again.").conventions.dashes).toBe("double-hyphen");
  });

  it("detects indented paragraphs", () => {
    const indented = ["    " + prose, "    " + prose, "    " + prose].join("\n");
    expect(analyseManuscript(indented).conventions.indentedParagraphs).toBe(true);
    expect(analyseManuscript([prose, prose].join("\n\n")).conventions.indentedParagraphs).toBe(false);
  });
});

describe("the continuation brief", () => {
  it("tells the agent to finish an interrupted chapter", () => {
    const a = analyseManuscript(chapter("# Chapter One", "He reached for the door and then"));
    const brief = renderContinuationBrief(a, "draft.gdoc");
    expect(brief).toContain("Finish the chapter in progress");
    expect(brief).toContain("draft.gdoc");
  });

  it("tells the agent to start a new chapter after a clean ending", () => {
    const brief = renderContinuationBrief(analyseManuscript(chapter("# Chapter One", prose)), "draft.gdoc");
    expect(brief).toContain("Begin a new chapter");
  });

  it("carries the conventions and the closing passage", () => {
    const text = chapter("CHAPTER ONE", `${prose}\n\n* * *\n\n${prose} “Done,” he said.`);
    const brief = renderContinuationBrief(analyseManuscript(text), "draft.gdoc");
    expect(brief).toContain("CHAPTER ONE");
    expect(brief).toContain("* * *");
    expect(brief).toContain("curly");
    expect(brief).toMatch(/Do not restate it/);
  });

  it("carries author clarification into the continuation brief", () => {
    const brief = renderContinuationBrief(analyseManuscript(chapter("# Chapter One", prose)), "draft.gdoc", "The review request is back matter.");
    expect(brief).toContain("The review request is back matter.");
  });
});

describe("back matter", () => {
  // The exact shape that made a finished book look interrupted.
  const reviewRequest = `Thank you for reading!

I hope you enjoyed reading this book as much as I enjoyed writing it. As an independent author, I rely heavily on readers like you to help my books find their audience.

If you have a quick minute, I would be incredibly grateful if you could leave an honest review. Even just a sentence or two makes a massive difference and helps other readers know what to expect!

Scan the QR code below or click here to leave a quick review`;

  const body = Array.from({ length: 8 }, () => prose).join(" ");

  it("does not read a review request as an unfinished chapter", () => {
    const text = chapter("# Chapter One", body) + chapter("# Chapter Two", body) + reviewRequest;
    const a = analyseManuscript(text);
    expect(a.backMatter).not.toBeNull();
    expect(a.backMatter!.heading).toBe("Thank you for reading!");
    expect(a.lastChapterComplete).toBe(true);
  });

  it("recognises unheaded review copy in a long paragraph", () => {
    const closing = "I hope you enjoyed reading this book. As an independent author, I rely on readers like you to help my books find their audience. If you have a quick minute, I would be grateful if you could leave an honest review. Scan the QR code below.";
    const text = chapter("# Chapter One", body) + closing;
    const a = analyseManuscript(text);
    expect(a.backMatter).not.toBeNull();
    expect(a.lastChapterComplete).toBe(true);
  });

  it("finds closing copy when Drive removes blank paragraph separators", () => {
    const text = `${chapter("Chapter One", "Avery blinked at the doorway, then turned back to the stove, face burning as their partner's laugh echoed from the next room.\n\n\"Oh no,\" they muttered to themself, trying very hard not to burn breakfast.")}Thank you for reading!\nI hope you enjoyed reading this book. As an independent author, I rely heavily on readers like you to help my books find their audience.\nIf you have a quick minute, I would be grateful if you could leave an honest review. Even just a sentence or two makes a massive difference and helps other readers know what to expect!\nScan the QR code below or click here to leave a quick review`;
    const a = analyseManuscript(text);
    expect(a.backMatter?.heading).toMatch(/Thank you for reading/i);
    expect(a.lastChapterComplete).toBe(true);
  });

  it("keeps CRLF offsets aligned when closing material follows the story", () => {
    const story = "Chapter One\r\n\r\n" +
      "Avery blinked at the doorway, then turned back to the stove, face burning as their partner's laugh echoed from the next room.\r\n\r\n" +
      "\"Oh no,\" they muttered to themself, trying very hard not to burn breakfast.";
    const closing = "Thank you for reading!\r\n\r\nI hope you enjoyed reading this book as much as I enjoyed writing it. As an independent author, I rely heavily on readers like you to help my books find their audience.\r\n\r\nIf you have a quick minute, I would be incredibly grateful if you could leave an honest review.\r\n\r\nScan the QR code below or click here to leave a quick review";
    const a = analyseManuscript(`${story}\r\n\r\n${closing}`);
    expect(a.backMatter?.heading).toBe("Thank you for reading!");
    expect(a.lastChapterComplete).toBe(true);
    expect(a.completenessReason).not.toMatch(/Avery blinked/);
  });

  it("ignores a trailing page-break rule when judging the ending", () => {
    const text = `${chapter("Chapter One", "Avery blinked at the doorway, then turned back to the stove, face burning as their partner's laugh echoed from the next room.\n\n\"Oh no,\" they muttered to themself, trying very hard not to burn breakfast.")}________________`;
    const a = analyseManuscript(text);
    expect(a.lastChapterComplete).toBe(true);
    expect(a.completenessReason).toContain("complete sentence");
    expect(a.tail).not.toContain("________________");
  });

  it("counts story words separately from the whole document", () => {
    const text = chapter("# Chapter One", body) + reviewRequest;
    const a = analyseManuscript(text);
    expect(a.storyWords).toBeLessThan(a.totalWords);
    expect(a.storyEndOffset).toBeLessThan(text.length);
  });

  it("keeps back matter out of the chapter list", () => {
    const text = chapter("# Chapter One", body) + chapter("# Chapter Two", body) + reviewRequest;
    expect(analyseManuscript(text).chapters).toHaveLength(2);
  });

  it("takes the continuation point from the story, not the afterword", () => {
    const text = chapter("# Chapter One", `${body} She closed the door behind her.`) + reviewRequest;
    const a = analyseManuscript(text);
    expect(a.tail).toContain("closed the door");
    expect(a.tail).not.toContain("honest review");
  });

  it("tells the agent to insert before the back matter", () => {
    const text = chapter("# Chapter One", body) + reviewRequest;
    const brief = renderContinuationBrief(analyseManuscript(text), "draft.gdoc");
    expect(brief).toContain("Where to insert");
    expect(brief).toContain("New chapters go before it, not after");
  });

  it.each([
    ["Acknowledgements", "Acknowledgements"],
    ["About the Author", "About the Author"],
    ["Also by J. Smith", "Also by J. Smith"],
    ["THE END", "THE END"],
    ["Author's Note", "Author's Note"]
  ])("recognises %s", (heading) => {
    const text = chapter("# Chapter One", body) + chapter("# Chapter Two", body) + `${heading}\n\nSome closing words here.`;
    expect(analyseManuscript(text).backMatter?.heading).toBe(heading);
  });

  it("ignores the same words appearing early as ordinary prose", () => {
    const text = chapter("# Chapter One", "Thank you for reading, she said, handing back the letter. " + body)
      + chapter("# Chapter Two", body) + chapter("# Chapter Three", body);
    expect(analyseManuscript(text).backMatter).toBeNull();
  });

  it("still reports no back matter when there is none", () => {
    const a = analyseManuscript(chapter("# Chapter One", body));
    expect(a.backMatter).toBeNull();
    expect(a.storyWords).toBe(a.totalWords);
  });
});

describe("continuation merge", () => {
  it("inserts new prose before review material", () => {
    const original = `${chapter("# Chapter One", prose)}Thank you for reading!\n\nPlease leave a review.`;
    const merged = mergeContinuation(original, "# Chapter Two\n\nThe next morning, he left.");
    expect(merged.indexOf("# Chapter Two")).toBeLessThan(merged.indexOf("Thank you for reading!"));
    expect(merged).toContain("Please leave a review.");
  });

  it("inserts new prose before an epilogue", () => {
    const original = `${chapter("# Chapter One", prose)}Epilogue\n\nFive years later, the bakery was full.`;
    const merged = mergeContinuation(original, "# Chapter Two\n\nThe next morning, he left.");
    expect(merged.indexOf("# Chapter Two")).toBeLessThan(merged.indexOf("Epilogue"));
  });

  it("does not change an existing document when there is no addition", () => {
    const original = `${prose}\n`;
    expect(mergeContinuation(original, "  ")).toBe(original);
  });
});
