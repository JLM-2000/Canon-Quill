import { describe, expect, it } from "vitest";
import { detectNarration, narrationOptions } from "../src/style/narration.js";

const firstPast = `I crossed the yard before the light came up. My boots were loud on the frost and I
knew the gate would be shut, because it always was. It was open. I stood there a moment and
thought about what that meant. Nothing good, I decided, and I went through it anyway.`;

const thirdPast = `She crossed the yard before the light came up. Her boots were loud on the frost
and she knew the gate would be shut, because it always was. It was open. She stood a moment and
thought about what that meant. Nothing good, she decided, and she went through it anyway.`;

const thirdPresent = `She crosses the yard before the light comes up. Her boots are loud on the
frost and she knows the gate is shut, because it always is. It stands open. She thinks about what
that means. Nothing good, she decides, and she goes through it anyway.`;

const secondPresent = `You cross the yard before the light comes up. Your boots are loud on the
frost. You know the gate is shut, because it always is. You stand there and you think about what
that means, and you go through it anyway.`;

describe("point of view", () => {
  it("detects first person", () => {
    expect(detectNarration(firstPast).pov).toBe("first");
  });

  it("detects third person", () => {
    expect(detectNarration(thirdPast).pov).toMatch(/^third/);
  });

  it("detects second person", () => {
    expect(detectNarration(secondPresent).pov).toBe("second");
  });

  it("is not fooled by first-person dialogue in a third-person story", () => {
    const withSpeech = `${thirdPast} "I told you I would come," she said. "I always do. I keep my word."`;
    expect(detectNarration(withSpeech).pov).toMatch(/^third/);
  });
});

describe("tense", () => {
  it("detects past", () => {
    expect(detectNarration(thirdPast).tense).toBe("past");
  });

  it("detects present", () => {
    expect(detectNarration(thirdPresent).tense).toBe("present");
  });

  it("is not fooled by present-tense dialogue in a past-tense story", () => {
    const withSpeech = `${thirdPast} "It is open," she says. "It always is. That is the problem."`;
    expect(detectNarration(withSpeech).tense).toBe("past");
  });
});

describe("the label", () => {
  it("produces a value that matches an offered option", () => {
    const label = detectNarration(thirdPast).label;
    expect(label).toBe("Close third, past");
    expect(narrationOptions).toContain(label);
  });

  it("produces first person past for a first person past text", () => {
    expect(detectNarration(firstPast).label).toBe("First person, past");
  });

  it("reports low confidence rather than guessing on empty input", () => {
    const n = detectNarration("");
    expect(n.povConfidence).toBeLessThan(0.5);
  });
});
