import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { appendLog } from "./logs.js";
import { workspacePaths } from "../workspace/paths.js";

export interface GenerateDocxResult {
  inputPath: string;
  outputPath: string;
}

export async function generateDocx(slug: string): Promise<GenerateDocxResult> {
  const paths = workspacePaths(slug);
  const inputPath = path.join(paths.final, "manuscript.md");
  const outputPath = path.join(paths.final, "manuscript.docx");

  if (!existsSync(inputPath)) {
    throw new Error(`Final manuscript not found: ${inputPath}`);
  }

  const markdown = await readFile(inputPath, "utf8");
  const doc = new Document({
    sections: [{ properties: {}, children: markdownToParagraphs(markdown) }]
  });

  await mkdir(paths.final, { recursive: true });
  await writeFile(outputPath, await Packer.toBuffer(doc));

  await appendLog(slug, "audit", {
    timestamp: new Date().toISOString(),
    stage: "docx_generation",
    stageName: "DOCX Generation",
    agent: "book-14-docx-generation",
    event: "docx_generated",
    data: { inputPath, outputPath }
  });

  return { inputPath, outputPath };
}

function markdownToParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("# ")) {
      paragraphs.push(new Paragraph({ text: line.slice(2).trim(), heading: HeadingLevel.TITLE }));
      continue;
    }
    if (line.startsWith("## ")) {
      paragraphs.push(new Paragraph({ text: line.slice(3).trim(), heading: HeadingLevel.HEADING_1 }));
      continue;
    }
    if (line.startsWith("### ")) {
      paragraphs.push(new Paragraph({ text: line.slice(4).trim(), heading: HeadingLevel.HEADING_2 }));
      continue;
    }
    if (line.trim() === "") {
      paragraphs.push(new Paragraph({ children: [new TextRun("")] }));
      continue;
    }
    paragraphs.push(new Paragraph({ children: parseInline(line) }));
  }

  return paragraphs;
}

function parseInline(line: string): TextRun[] {
  const runs: TextRun[] = [];
  const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);

  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    } else if (part.startsWith("*") && part.endsWith("*")) {
      runs.push(new TextRun({ text: part.slice(1, -1), italics: true }));
    } else {
      runs.push(new TextRun(part));
    }
  }

  return runs;
}
