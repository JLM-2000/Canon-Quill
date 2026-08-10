import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import PDFDocument from "pdfkit";

/** Generate a readable PDF without changing the source Markdown. */
export async function generateMarkdownPdf(markdown: string, outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const document = new PDFDocument({ autoFirstPage: true, margin: 72 });
  const stream = createWriteStream(outputPath);
  document.pipe(stream);

  for (const block of markdown.split(/\n{2,}/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) continue;
    const first = lines[0].trim();
    const heading = /^(#{1,3})\s+(.+)$/.exec(first);
    if (heading) {
      document.font("Helvetica-Bold").fontSize(heading[1].length === 1 ? 22 : heading[1].length === 2 ? 16 : 13);
      document.text(stripMarkdown(heading[2]), { paragraphGap: 8 });
      continue;
    }

    writeRichText(document, lines.join("\n"));
  }

  document.end();
  await once(stream, "finish");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^>\s?/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/`/g, "");
}

function writeRichText(document: PDFKit.PDFDocument, value: string): void {
  const parts = stripMarkdown(value).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  parts.forEach((part, index) => {
    const bold = part.startsWith("**") && part.endsWith("**");
    const italic = !bold && part.startsWith("*") && part.endsWith("*");
    const content = bold || italic ? part.slice(bold ? 2 : 1, bold ? -2 : -1) : part;
    document
      .font(bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica")
      .fontSize(11)
      .text(content, { align: "left", lineGap: 3, paragraphGap: index === parts.length - 1 ? 8 : 0, continued: index < parts.length - 1 });
  });
}
