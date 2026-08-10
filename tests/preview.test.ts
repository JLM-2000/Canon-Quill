import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/preview/markdown.js";

describe("formatted Markdown preview", () => {
  it("renders tables instead of exposing line-break markup", () => {
    const html = renderMarkdown("# Brief\n\n| Field | Value |\n|---|---|\n| Genre | Romance |<br />| POV | Close third |\n\n---");

    expect(html).toContain("<table>");
    expect(html).toContain("<th>Field</th>");
    expect(html).toContain("<td>Romance</td>");
    expect(html).toContain("<td>Close third</td>");
    expect(html).toContain("<hr />");
    expect(html).not.toContain("&lt;br");
  });

  it("renders source line breaks as HTML breaks instead of visible text", () => {
    const html = renderMarkdown("First line<br />Second line");

    expect(html).toContain("First line<br />Second line");
    expect(html).not.toContain("&lt;br");
  });
});
