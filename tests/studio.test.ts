import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createStudioApp } from "../src/studio/server.js";
import { derivePhase, emptyState, loadState } from "../src/studio/state.js";
import { workspacesRoot, workspacePaths } from "../src/workspace/paths.js";
import path from "node:path";
import type { Server } from "node:http";

let server: Server;
let base: string;

function listen(): Promise<void> {
  return new Promise((resolve) => {
    server = createStudioApp().listen(0, "127.0.0.1", () => {
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });
}

async function call(path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

async function seedPreparationPackage() {
  const files = ["project-brief.md", "book-bible.md", "character-bible.md", "world-bible.md", "plot-bible.md", "style-guide.md", "chapter-plan.md", "validation-rubric.md", "preparation-manifest.json"];
  const artifacts = workspacePaths("test-book").artifacts;
  await mkdir(artifacts, { recursive: true });
  await Promise.all(files.map((name) => writeFile(path.join(artifacts, name), name.endsWith(".json") ? "{}" : `# ${name}\n`, "utf8")));
  const { loadState: load, saveState: save } = await import("../src/studio/state.js");
  const state = await load("test-book");
  state.preparationReviewed = true;
  await save(state);
}

beforeEach(async () => {
  await rm(workspacesRoot(), { recursive: true, force: true });
  await rm(path.join(process.cwd(), ".auth", "credentials.json"), { force: true });
  if (!server) await listen();
  await call("/api/projects", { method: "POST", body: { title: "Test Book" } });
});

afterAll(async () => {
  server?.close();
  await rm(workspacesRoot(), { recursive: true, force: true });
  await rm(path.join(process.cwd(), ".auth", "credentials.json"), { force: true });
});

describe("phase derivation", () => {
  it("starts by asking how the book begins", () => {
    expect(derivePhase(emptyState("x"))).toBe("start");
  });

  it("asks for a provider before anything else", () => {
    const state = emptyState("x");
    state.projectStart = "with_material";
    state.drive.connected = true;
    expect(derivePhase(state)).toBe("engine");
  });

  it("asks for sources once the engine and Drive are set", () => {
    const state = emptyState("x");
    state.projectStart = "with_material";
    state.resourceMethod = "drive";
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.engineReviewed = true;
    state.drive.connected = true;
    expect(derivePhase(state)).toBe("sources");
  });

  it("asks for intake once sources are confirmed", () => {
    const state = emptyState("x");
    state.projectStart = "with_material";
    state.resourceMethod = "drive";
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.engineReviewed = true;
    state.drive.connected = true;
    state.drive.referenceRoots = ["root-1"];
    state.sources = [
      {
        driveId: "a", name: "book.md", path: "/book.md", mimeType: "text/markdown", isFolder: false,
        kinds: ["past_book"]
      }
    ];
    expect(derivePhase(state)).toBe("analyze");
    state.sourcesReviewed = true;
    state.projectStart = "with_material";
    expect(derivePhase(state)).toBe("intake");
  });

  it("holds at the existing-draft step until it is answered", () => {
    const state = emptyState("x");
    state.projectStart = "with_material";
    state.resourceMethod = "drive";
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.engineReviewed = true;
    state.drive.connected = true;
    state.drive.referenceRoots = ["root-1"];
    state.sources = [{ driveId: "a", name: "book.md", path: "/book.md", mimeType: "text/plain", isFolder: false, kinds: ["past_book", "reference_book"] }];
    state.sourcesReviewed = true;
    state.shape = "standalone";
    state.draftingMode = "chapter_by_chapter";
    state.projectShapeReviewed = true;
    expect(derivePhase(state)).toBe("draft");
    state.manuscriptReviewed = true;
    expect(derivePhase(state)).toBe("preparation");
    state.styleCorpus.built = true;
    expect(derivePhase(state)).toBe("preparation");
    state.styleCorpus.continuedAt = new Date().toISOString();
    expect(derivePhase(state)).toBe("intake_analysis");
  });

  it("moves to writing once chapters exist", () => {
    const state = emptyState("x");
    state.writingConfirmed = true;
    state.chapters = [{ number: 1, title: "One", synopsis: "", status: "planned", issues: [] }];
    expect(derivePhase(state)).toBe("writing");
  });

  it("reaches export only when every chapter is approved", () => {
    const state = emptyState("x");
    state.writingConfirmed = true;
    state.chapters = [
      { number: 1, title: "One", synopsis: "", status: "approved", issues: [] },
      { number: 2, title: "Two", synopsis: "", status: "drafted", issues: [] }
    ];
    expect(derivePhase(state)).toBe("writing");
    state.chapters[1].status = "approved";
    expect(derivePhase(state)).toBe("export");
  });
});

describe("studio api", () => {
  it("serves the UI", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Canon Quill Studio");
    expect(html).toContain("questionSnapshot");
    expect(html).not.toContain("Reset questions and project analysis");
    expect(html).not.toContain("Use it");
    expect(html).not.toContain("Detected");
    expect(html).not.toContain("Can't connect?");
    expect(html).toContain("showDriveRecovery");
    expect(html).toContain("about:blank");
    expect(html).toContain("Source analysis failed");
    expect(html).toContain("Add resources");
    expect(html).toContain("Choose file");
    expect(html).toContain('id="selected-files"');
    expect(html).not.toContain("Can't connect?");
    expect(html.indexOf("Select sources")).toBeLessThan(html.indexOf("Upload from this computer"));
    expect(html).toContain("credentialsByRole");
    expect(html).toContain("Analysis and outlines");
    expect(html).toContain("Main cast");
    expect(html).toContain("Change existing draft");
    expect(html).toContain("Use this existing draft?");
    expect(html).toContain("Start without an existing draft");
    expect(html).toContain("Reading existing draft");
    expect(html).toContain("Order the series books");
    expect(html).toContain("Series books are voice references too");
    expect(html).toContain("Remove both");
    expect(html).toContain("Voice reference");
    expect(html).toContain("Plot & outline (required)");
    expect(html).not.toContain("Series books (optional)");
    expect(html).not.toContain("Canon and project material (required)");
    expect(html).toContain("not included because");
    expect(html.indexOf('roleProviderCard("analysis", "anthropic"')).toBeLessThan(html.indexOf('roleProviderCard("analysis", "openai"'));
    expect(html).toContain('route = "start"; render();');
    expect(html).not.toContain("The Tide House");
    expect(html).not.toContain("Starting point confirmed");
    expect(html).toContain("pointer-events: none");
    expect(html).toContain("--sidebar-width: 232px");
    expect(html).toContain("scrollbar-gutter: stable");
    expect(html).toContain("sourceAnalysisStarted");
    expect(html).toContain("requestAnimationFrame(() => window.scrollTo");
    expect(html).toContain("analysis-finding");
    expect(html).toContain("Continuation point");
    expect(html).not.toContain("Show technical details");
    expect(html).not.toContain("Hide technical details");
    expect(html).toContain("outputCard");
    expect(html).toContain('run.status === "running" ? "" : outputCard()');
    expect(html).toContain("chapterGroups.map(fileGroup)");
    expect(html).toContain("finished-alert");
    expect(html).toContain("dismissOutputAlert");
    expect(html).toContain("localStorage");
    expect(html).toContain("Ready to analyse");
    expect(html).toContain("startProjectAnalysis");
    expect(html).toContain("Prepare everything");
    expect(html).toContain("Preparation package:");
    expect(html).not.toContain("Show completed and pending documents");
    expect(html).toContain("Preparation usually takes around 15 minutes");
    expect(html).toContain("openPreparationDocument");
    expect(html).toContain("runConsoleAtBottom");
    expect(html).toContain("Preparation stopped");
    expect(html).toContain("formatElapsed");
    expect(html).not.toContain("artifacts still missing");
    expect(html).toContain("Review the preparation");
    expect(html).toContain("Reprepare affected documents");
    expect(html).toContain("Documents with saved notes");
    expect(html).toContain("Related documents checked automatically");
    expect(html).toContain("Request a preparation repair?");
    expect(html).toContain("prep-rerun-general-note");
    expect(html).toContain("Preparation complete");
    expect(html).toContain('preparation: S.writingConfirmed ? "chapters"');
    expect(html).toContain("function enterPreparation()");
    expect(html).toContain("Edit with instructions");
    expect(html).toContain("Edit final book with instructions");
    expect(html).toContain("View as PDF");
    expect(html).toContain("addDirectionModal");
    expect(html).toContain("editDirectionModal");
    expect(html).toContain('size: "writing-modal"');
  });

  it("previews and downloads the final manuscript through an allowlisted output", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.draftingMode = "whole_book";
    await save(state);
    await mkdir(workspacePaths("test-book").final, { recursive: true });
    await writeFile(workspacePaths("test-book").final + "/manuscript.md", "# Chapter 2\n\nThe finished book.", "utf8");

    const output = await call("/api/run/output");
    expect(output.status).toBe(200);
    expect(output.body.primary.label).toBe("Final manuscript");
    expect(output.body.primary.preview).toContain("The finished book.");
    expect(output.body.primary.downloadUrl).toContain("kind=book");

    const download = await fetch(`${base}/api/run/output/download?kind=book&format=md`);
    expect(download.status).toBe(200);
    expect(await download.text()).toContain("The finished book.");
  });

  it("lists chapter downloads and provides a print-friendly document view", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.draftingMode = "whole_book";
    await save(state);
    await mkdir(workspacePaths("test-book").final, { recursive: true });
    await mkdir(workspacePaths("test-book").chapters, { recursive: true });
    await writeFile(path.join(workspacePaths("test-book").final, "manuscript.md"), "# Final\n\nBook.", "utf8");
    await writeFile(path.join(workspacePaths("test-book").chapters, "chapter-01-edited.md"), "# Chapter 1\n\nFirst.", "utf8");
    await writeFile(path.join(workspacePaths("test-book").chapters, "chapter-02-edited.md"), "# Chapter 2\n\nSecond.", "utf8");

    const output = await call("/api/run/output");
    expect(output.body.files.filter((file: any) => file.kind === "chapter")).toHaveLength(4);
    expect(output.body.files.some((file: any) => file.format === "docx" && file.chapter === 1)).toBe(true);
    const view = await fetch(`${base}/api/run/output/view?kind=chapter&chapter=1`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("Print / Save PDF");
  });

  it("returns state with a derived phase", async () => {
    const { body } = await call("/api/state");
    expect(body.state.projectName).toBe("Test Book");
    expect(body.state.phase).toBe("start");
  });

  it("records project shape and drafting mode", async () => {
    const { body } = await call("/api/project", {
      method: "PATCH",
      body: { shape: "series", draftingMode: "whole_book", intake: { audience: "adult" } }
    });
    expect(body.shape).toBe("series");
    expect(body.draftingMode).toBe("whole_book");
    expect(body.intake.audience).toBe("adult");
  });

  it("confirms project shape on the first request and can reset there", async () => {
    await call("/api/project/start", {
      method: "POST",
      body: { projectStart: "from_scratch", startingBrief: "A detailed premise about a return home, a buried family secret, and the choice that changes the protagonist's future." }
    });
    await call("/api/engine", {
      method: "PATCH",
      body: {
        provider: "anthropic",
        authMethod: "subscription",
        analysisProvider: "anthropic",
        analysisAuthMethod: "subscription",
        draftingProvider: "anthropic",
        draftingAuthMethod: "subscription"
      }
    });
    await call("/api/engine/continue", { method: "POST" });
    await call("/api/project", { method: "PATCH", body: { shape: "series", draftingMode: "whole_book" } });
    const continued = await call("/api/project/continue", { method: "POST" });
    expect(continued.body.projectShapeReviewed).toBe(true);
    expect(continued.body.phase).toBe("draft");

    const reset = await call("/api/project/reset-to-shape", { method: "POST" });
    expect(reset.body.projectShapeReviewed).toBe(false);
    expect(reset.body.shape).toBeNull();
    expect(reset.body.draftingMode).toBeNull();
    expect(reset.body.phase).toBe("intake");
  });

  it("asks for the starting point before engine setup", async () => {
    const short = await call("/api/project/start", { method: "POST", body: { projectStart: "from_scratch", startingBrief: "Too short" } });
    expect(short.status).toBe(400);
    const started = await call("/api/project/start", {
      method: "POST",
      body: { projectStart: "from_scratch", startingBrief: "A woman returns to a flooded coastal town to uncover why her sister disappeared, while an old promise threatens the life she rebuilt." }
    });
    expect(started.status).toBe(200);
    expect(started.body.projectStart).toBe("from_scratch");
    expect(started.body.startingBrief).toMatch(/flooded coastal town/);
    expect(started.body.phase).toBe("engine");
  });

  it("keeps legacy provider setup on the engine screen after reload", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.engine = {
      provider: null,
      authMethod: null,
      analysisProvider: "openai",
      analysisAuthMethod: "subscription",
      draftingProvider: "anthropic",
      draftingAuthMethod: "subscription",
      routing: "split",
      models: {}
    };
    await save(state);
    expect((await call("/api/state")).body.state.phase).toBe("engine");
    await call("/api/engine");
    const reloaded = await call("/api/state");
    expect(reloaded.body.state.projectStart).toBe("with_material");
    expect(reloaded.body.state.phase).toBe("engine");
    const continued = await call("/api/engine/continue", { method: "POST" });
    expect(continued.body.phase).toBe("connect");
  });

  it("supports separate providers for analysis and drafting", async () => {
    const result = await call("/api/engine", {
      method: "PATCH",
      body: {
        routing: "split",
        analysisProvider: "openai",
        analysisAuthMethod: "api_key",
        draftingProvider: "anthropic",
        draftingAuthMethod: "subscription"
      }
    });
    expect(result.status).toBe(200);
    expect(result.body.choice.routing).toBe("split");
    expect(result.body.choice.analysisProvider).toBe("openai");
    expect(result.body.choice.draftingProvider).toBe("anthropic");
    expect(result.body.resolvedModels.analysis).toBe("gpt-5.6-luna");
    expect(result.body.resolvedModels.drafting).toBe("claude-opus-5");
  });

  it("prefills the recommended providers when split mode is chosen", async () => {
    const result = await call("/api/engine", { method: "PATCH", body: { routing: "split" } });
    expect(result.body.choice.analysisProvider).toBe("openai");
    expect(result.body.choice.draftingProvider).toBe("anthropic");
  });

  it("resolves the analysis runtime separately from drafting", async () => {
    await call("/api/engine", { method: "PATCH", body: { routing: "split", analysisProvider: "openai", draftingProvider: "anthropic" } });
    const analysis = await call("/api/run/runtime?role=analysis");
    const drafting = await call("/api/run/runtime?role=drafting");
    expect(analysis.body.provider).toBe("openai");
    expect(analysis.body.model).toBe("gpt-5.6-luna");
    expect(drafting.body.provider).toBe("anthropic");
  });

  it("keeps resources locked until the engine is continued", async () => {
    await call("/api/project/start", { method: "POST", body: { projectStart: "with_material" } });
    await call("/api/engine", {
      method: "PATCH",
      body: {
        routing: "split",
        analysisProvider: "openai",
        analysisAuthMethod: "subscription",
        draftingProvider: "anthropic",
        draftingAuthMethod: "subscription"
      }
    });
    expect((await call("/api/state")).body.state.phase).toBe("engine");
    const continued = await call("/api/engine/continue", { method: "POST" });
    expect(continued.status).toBe(200);
    expect(continued.body.engineReviewed).toBe(true);
    expect(continued.body.phase).toBe("connect");
  });

  it("rejects an unknown drafting mode without clobbering the stored value", async () => {
    await call("/api/project", { method: "PATCH", body: { draftingMode: "chapter_by_chapter" } });
    const { body } = await call("/api/project", { method: "PATCH", body: { draftingMode: "nonsense" } });
    expect(body.draftingMode).toBe("chapter_by_chapter");
  });

  it("accepts a question from an agent and an answer from the author", async () => {
    const created = await call("/api/questions", {
      method: "POST",
      body: {
        question: "Should the lead know about the altered record in chapter 3?",
        askedBy: "book-04-preparation",
        options: ["Yes", "No", "She suspects"],
        blocking: true
      }
    });
    expect(created.status).toBe(201);
    const id = created.body.question.id;

    const before = await call("/api/questions");
    expect(before.body.blocking).toHaveLength(1);

    const answered = await call(`/api/questions/${id}/answer`, { method: "POST", body: { answer: "She suspects" } });
    expect(answered.body.questions[0].answer).toBe("She suspects");

    const after = await call("/api/questions");
    expect(after.body.blocking).toHaveLength(0);
    expect(after.body.conversation).toHaveLength(2);
  });

  it("rejects an empty answer", async () => {
    const created = await call("/api/questions", { method: "POST", body: { question: "Q?" } });
    const result = await call(`/api/questions/${created.body.question.id}/answer`, { method: "POST", body: { answer: "  " } });
    expect(result.status).toBe(400);
  });

  it("rejects an answer for an unknown question", async () => {
    const result = await call("/api/questions/missing/answer", { method: "POST", body: { answer: "No" } });
    expect(result.status).toBe(404);
  });

  it("records an author's freeform conversation message", async () => {
    const result = await call("/api/conversation", { method: "POST", body: { text: "Keep the ending quiet." } });
    expect(result.status).toBe(201);
    expect(result.body.conversation[0].text).toBe("Keep the ending quiet.");
    expect(result.body.conversation[0].role).toBe("author");
  });

  it("opens the agent-led intake conversation", async () => {
    const result = await call("/api/conversation/start", { method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.conversationStartedAt).toBeTruthy();
  });

  it("moves to chapters after the final intake answer", () => {
    const state = emptyState("x");
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.engineReviewed = true;
    state.projectStart = "with_material";
    state.resourceMethod = "drive";
    state.drive.connected = true;
    state.drive.referenceRoots = ["root"];
    state.sources = [{ driveId: "source", name: "Reference", path: "/Reference", mimeType: "text/plain", isFolder: false, kinds: ["reference_book"] }];
    state.sourcesReviewed = true;
    state.shape = "standalone";
    state.draftingMode = "chapter_by_chapter";
    state.projectShapeReviewed = true;
    state.manuscriptReviewed = true;
    state.styleCorpus.built = true;
    state.styleCorpus.continuedAt = new Date().toISOString();
    state.projectAnalysis.completed = true;
    state.projectAnalysis.continuedAt = new Date().toISOString();
    state.writingConfirmed = true;
    state.conversationStartedAt = new Date().toISOString();
    state.questions = [{
      id: "q", key: "storyPromise", phase: "intake", askedBy: "book-01-intake", question: "What is the promise?",
      allowFreeText: true, askedAt: new Date().toISOString(), answer: "A promise.", answeredAt: new Date().toISOString(), blocking: true
    }];
    expect(derivePhase(state)).toBe("writing");
  });

  it("requires an explicit writing confirmation after preparation", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.projectStart = "from_scratch";
    state.startingBrief = "A detailed premise about a woman returning home to uncover a family secret and choose what kind of life comes next.";
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} } as any;
    state.engineReviewed = true;
    state.shape = "standalone";
    state.projectShapeReviewed = true;
    state.manuscriptReviewed = true;
    state.projectAnalysis.completed = true;
    state.projectAnalysis.continuedAt = new Date().toISOString();
    state.conversationStartedAt = new Date().toISOString();
    state.questions = [];
    await save(state);
    expect((await call("/api/state")).body.state.phase).toBe("preparation");
    const opened = await call("/api/preparation/continue", { method: "POST" });
    expect(opened.status).toBe(200);
    expect(opened.body.phase).toBe("preparation");
    const confirmed = await call("/api/writing/confirm", { method: "POST" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.writingConfirmed).toBe(true);
    expect(confirmed.body.phase).toBe("writing");
  });

  it("does not make the author open an intake with nothing to ask", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const prepared = async () => {
      const state = await load("test-book");
      state.projectStart = "from_scratch";
      state.startingBrief = "A detailed premise about a woman returning home to uncover a family secret and choose what kind of life comes next.";
      state.engine = { provider: "anthropic", authMethod: "subscription", models: {} } as any;
      state.engineReviewed = true;
      state.shape = "standalone";
      state.projectShapeReviewed = true;
      state.manuscriptReviewed = true;
      state.projectAnalysis.completed = true;
      state.projectAnalysis.continuedAt = new Date().toISOString();
      state.conversationStartedAt = null;
      state.questions = [];
      return state;
    };

    const waiting = await prepared();
    waiting.projectAnalysis.questionPlan = [{
      key: "storyPromise", question: "What must this book promise?", rationale: "Nothing states it.", blocking: true
    }];
    await save(waiting);
    const blocked = await call("/api/writing/confirm", { method: "POST" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/open the preparation questions/i);

    const decided = await prepared();
    decided.projectAnalysis.questionPlan = [];
    await save(decided);
    const confirmed = await call("/api/writing/confirm", { method: "POST" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.phase).toBe("writing");
    expect(confirmed.body.conversationStartedAt).toBeTruthy();
  });

  it("keeps questions locked until project analysis is continued", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.projectStart = "from_scratch";
    state.startingBrief = "A detailed premise about a woman returning home to uncover a family secret and choose what kind of life comes next.";
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} } as any;
    state.engineReviewed = true;
    state.shape = "standalone";
    state.projectShapeReviewed = true;
    state.manuscriptReviewed = true;
    state.projectAnalysis.completed = true;
    state.projectAnalysis.continuedAt = null;
    await save(state);

    expect((await call("/api/state")).body.state.phase).toBe("intake_analysis");
    const continued = await call("/api/intake/analysis/continue", { method: "POST" });
    expect(continued.status).toBe(200);
    expect(continued.body.projectAnalysis.continuedAt).toBeTruthy();
    expect(continued.body.phase).toBe("preflight");
  });

  it("uploads planning files without requiring Drive", async () => {
    const result = await call("/api/sources/upload", {
      method: "POST",
      body: { files: [{ name: "outline.md", mimeType: "text/markdown", text: "The protagonist must return home. The timeline begins in winter." }] }
    });
    expect(result.status).toBe(200);
    expect(result.body.sources[0].driveId).toMatch(/^local-/);
    expect(result.body.sources[0].kinds).toContain("plot");
  });

  it("stores chapter-by-chapter planning chat", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "The return", synopsis: "She comes home." }] } });
    const sent = await call("/api/chapters/1/chat", { method: "POST", body: { text: "The chapter must end with the locked room opening. Keep the dialogue indirect." } });
    expect(sent.status).toBe(201);
    const read = await call("/api/chapters/1/chat");
    expect(read.body.messages[0].text).toMatch(/locked room/);
  });

  it("asks the analyzed question plan one decision at a time and resets it cleanly", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.shape = "series";
    state.sources = [{
      driveId: "plot",
      name: "Book plan",
      path: "/Book plan",
      mimeType: "text/plain",
      isFolder: false,
      kinds: ["plot"]
    }];
    await save(state);
    await mkdir(workspacePaths("test-book").driveCache, { recursive: true });
    await writeFile(
      `${workspacePaths("test-book").driveCache}/plot.json`,
      JSON.stringify({ text: "Romance. Premise: Rowan must choose between the life they want and the family secret that can destroy it. They are called Rowan. Conflict: the secret threatens their relationship. Ending: the couple stays together." }),
      "utf8"
    );

    const started = await call("/api/conversation/start", { method: "POST" });
    expect(started.body.questions).toHaveLength(1);
    expect(started.body.questions[0].key).toBe("protagonistArc");
    expect(started.body.questions[0].question).toMatch(/Rowan|family secret/i);

    const answered = await call(`/api/questions/${started.body.questions[0].id}/answer`, {
      method: "POST",
      body: { answer: "Rowan is the protagonist and wants a life outside their family." }
    });
    expect(answered.body.questions).toHaveLength(2);
    expect(answered.body.questions[1].key).toBe("relationshipArc");

    const relationshipAnswered = await call(`/api/questions/${answered.body.questions[1].id}/answer`, {
      method: "POST",
      body: { answer: "Rowan and their partner choose each other despite the family secret." }
    });
    expect(relationshipAnswered.body.questions[2].key).toBe("settingRules");

    const reset = await call("/api/intake/reset", { method: "POST" });
    expect(reset.body.questions).toEqual([]);
    expect(reset.body.conversation).toEqual([]);
    expect(reset.body.projectAnalysis.completed).toBe(false);
  });

  it("records starting without an existing draft", async () => {
    const result = await call("/api/manuscript/skip", { method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.manuscript).toBeNull();
    expect(result.body.manuscriptReviewed).toBe(true);
  });

  it("writes phase milestones and the workspace decision log", async () => {
    await call("/api/project/start", {
      method: "POST",
      body: {
        projectStart: "from_scratch",
        startingBrief: "A detailed premise about a student returning home to uncover a family secret and decide what kind of life comes next."
      }
    });
    await call("/api/intake/analyse", { method: "POST" });

    const paths = workspacePaths("test-book");
    const decisionLog = await readFile(path.join(paths.artifacts, "decision-log.md"), "utf8");
    const phaseLog = JSON.parse(await readFile(path.join(paths.logs, "phase-log.json"), "utf8")) as Array<{ event: string }>;
    const errorLog = JSON.parse(await readFile(path.join(paths.logs, "errors-log.json"), "utf8")) as unknown[];
    expect(decisionLog).toContain("# Author decision log");
    expect(decisionLog).toContain("Planned decisions");
    expect(phaseLog.map((entry) => entry.event)).toEqual(expect.arrayContaining(["entry_confirmed", "analysis_complete"]));
    expect(errorLog).toEqual([]);
  });

  it("persists source and target selections with their labels", async () => {
    const result = await call("/api/drive/roots", {
      method: "POST",
      body: {
        roots: ["reference-folder"],
        referenceNames: { "reference-folder": "Past books" },
        targetFolderId: "target-folder",
        targetFolderName: "Finished chapters"
      }
    });
    expect(result.body.drive.referenceRoots).toEqual(["reference-folder"]);
    expect(result.body.drive.referenceRootNames["reference-folder"]).toBe("Past books");
    expect(result.body.drive.targetFolderName).toBe("Finished chapters");

    const state = await call("/api/state");
    expect(state.body.state.drive.referenceRootNames["reference-folder"]).toBe("Past books");
    expect(state.body.state.drive.targetFolderName).toBe("Finished chapters");
  });

  it("persists leaving the corpus screen for questions", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.engineReviewed = true;
    state.projectStart = "with_material";
    state.resourceMethod = "drive";
    state.drive.connected = true;
    state.drive.referenceRoots = ["root"];
    state.sources = [{ driveId: "source", name: "Reference", path: "/Reference", mimeType: "text/plain", isFolder: false, kinds: ["reference_book"] }];
    state.sourcesReviewed = true;
    state.shape = "standalone";
    state.draftingMode = "chapter_by_chapter";
    state.projectShapeReviewed = true;
    state.manuscriptReviewed = true;
    state.styleCorpus.built = true;
    await save(state);
    const result = await call("/api/style/continue", { method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.styleCorpus.continuedAt).toBeTruthy();
    expect(result.body.phase).toBe("intake_analysis");
    expect(result.body.projectAnalysis.completed).toBe(false);
  });

  it("extracts intake suggestions from indexed prose", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.sources = [{
      driveId: "own-book",
      name: "Book One",
      path: "/Book One",
      mimeType: "text/plain",
      isFolder: false,
      kinds: ["past_book"]
    }];
    await save(state);
    await mkdir(workspacePaths("test-book").driveCache, { recursive: true });
    await writeFile(
      `${workspacePaths("test-book").driveCache}/own-book.json`,
      JSON.stringify({ text: "She walked through the rain and wondered what he knew. ".repeat(20) }),
      "utf8"
    );

    const result = await call("/api/intake/suggestions");
    expect(result.body.suggestions.shape.value).toBe("standalone");
    expect(result.body.suggestions.pov.value).toMatch(/third|past/i);
    expect(result.body.suggestions.tense.value).toBe("Past");
  });

  it("applies audience and intimacy findings during project analysis", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.sources = [{
      driveId: "own-book",
      name: "Book One",
      path: "/Book One",
      mimeType: "text/plain",
      isFolder: false,
      kinds: ["past_book"]
    }];
    await save(state);
    await mkdir(workspacePaths("test-book").driveCache, { recursive: true });
    await writeFile(
      `${workspacePaths("test-book").driveCache}/own-book.json`,
      JSON.stringify({ text: "At twenty-two, in their freshman year, the couple loved and kissed. Sex changed their relationship. ".repeat(30) }),
      "utf8"
    );

    const result = await call("/api/intake/analyse", { method: "POST" });
    expect(result.body.state.intake.audience).toMatch(/New adult/);
    expect(result.body.state.intake.spice).toMatch(/Open door|Explicit|Very explicit/);
    expect(result.body.state.projectAnalysis.questionPlan.map((question) => question.key)).not.toEqual(expect.arrayContaining(["audience", "spice"]));
  });

  it("stores a chapter plan and reports it", async () => {
    const { body } = await call("/api/chapters", {
      method: "PUT",
      body: { chapters: [{ number: 1, title: "Opening", synopsis: "The lead runs." }, { number: 2, title: "The crossing" }] }
    });
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters[0].title).toBe("Opening");
    expect(body.ledger.plannedChapters).toBe(2);
    expect(body.phase).toBe("preflight");
  });

  it("serves an opening contract for a chapter", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }] } });
    const response = await fetch(`${base}/api/chapters/1/brief`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Opening contract");
  });

  it("refuses to build a style corpus with no prose at all", async () => {
    const { status, body } = await call("/api/style/build", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/voice reference/i);
  });

  it("validates a chapter and records flow and style results", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }] } });
    const { body } = await call("/api/chapters/1/validate", {
      method: "POST",
      body: { text: "He ran. The alley narrowed and the fence came up fast.\n\n\"You're late,\" she said." }
    });
    expect(body.flow.verdict).toBe("pass");
    expect(body.state.chapters[0].wordCount).toBeGreaterThan(0);
    expect(body.state.chapters[0].flowVerdict).toBe("pass");
  });

  it("rejects validating an empty chapter", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }] } });
    const { status } = await call("/api/chapters/1/validate", { method: "POST", body: { text: "" } });
    expect(status).toBe(400);
  });

  it("rejects an unknown chapter status", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }] } });
    const { status } = await call("/api/chapters/1/status", { method: "POST", body: { status: "vibes" } });
    expect(status).toBe(400);
  });

  it("rejects an unknown source kind", async () => {
    const { status } = await call("/api/sources/abc", { method: "PATCH", body: { kinds: ["nonsense"] } });
    expect(status).toBe(400);
  });

  it("requires kinds to be an array", async () => {
    const { status } = await call("/api/sources/abc", { method: "PATCH", body: { kind: "notes" } });
    expect(status).toBe(400);
  });

  it("accepts several groups for one document", async () => {
    const { status } = await call("/api/sources/abc", {
      method: "PATCH",
      body: { kinds: ["timeline", "plot", "notes"] }
    });
    expect(status).toBe(200);
  });

  it("holds at analyze until the grouping is reviewed", async () => {
    const state = emptyState("x");
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.engineReviewed = true;
    state.projectStart = "with_material";
    state.resourceMethod = "drive";
    state.drive.connected = true;
    state.drive.referenceRoots = ["r"];
    state.sources = [{ driveId: "a", name: "n", path: "/n", mimeType: "text/plain", isFolder: false, kinds: ["notes"] }];
    expect(derivePhase(state)).toBe("analyze");
    state.sourcesReviewed = true;
    expect(derivePhase(state)).toBe("intake");
  });

  it("refuses to index without reference roots", async () => {
    const { status, body } = await call("/api/sources/index", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/reference folder/i);
  });

  it("persists state across reads", async () => {
    await call("/api/project", { method: "PATCH", body: { projectName: "Ashfall" } });
    expect((await loadState("test-book")).projectName).toBe("Ashfall");
  });

  it("lists projects and switches between them", async () => {
    await call("/api/projects", { method: "POST", body: { title: "Second Book" } });
    const { body } = await call("/api/projects");
    expect(body.projects.map((p: any) => p.slug).sort()).toEqual(["second-book", "test-book"]);
    expect(body.activeSlug).toBe("second-book");

    await call("/api/projects/test-book/activate", { method: "POST" });
    const after = await call("/api/state");
    expect(after.body.state.projectName).toBe("Test Book");
  });

  it("keeps each book's data separate", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "Only In Book One" }] } });
    await call("/api/projects", { method: "POST", body: { title: "Second Book" } });
    const second = await call("/api/state");
    expect(second.body.state.chapters).toHaveLength(0);

    await call("/api/projects/test-book/activate", { method: "POST" });
    const first = await call("/api/state");
    expect(first.body.state.chapters[0].title).toBe("Only In Book One");
  });

  it("finishing a book keeps it listed", async () => {
    await call("/api/projects/test-book/finish", { method: "POST" });
    const { body } = await call("/api/projects");
    expect(body.projects.find((p: any) => p.slug === "test-book").status).toBe("finished");
  });

  it("rejects a project with a blank title", async () => {
    const { status } = await call("/api/projects", { method: "POST", body: { title: "   " } });
    expect(status).toBe(500);
  });

  it("refuses exemplars before a corpus exists", async () => {
    const { status, body } = await call("/api/style/exemplars", { method: "POST", body: { beat: "dialogue" } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/corpus/i);
  });

  it("records provider and auth method, and checks credentials", async () => {
    const { body } = await call("/api/engine", {
      method: "PATCH",
      body: { provider: "anthropic", authMethod: "api_key" }
    });
    expect(body.choice.provider).toBe("anthropic");
    expect(body.resolvedModels.drafting).toBe("claude-opus-5");
    expect(body.credentials.env).toBe("ANTHROPIC_API_KEY");
  });

  it("keeps credentials out of the project state endpoint", async () => {
    const { status, body } = await call("/api/engine", {
      method: "PATCH",
      body: { provider: "anthropic", apiKey: "sk-ant-should-never-be-stored" }
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/\/api\/engine\/key/);
  });

  it("rejects an unknown provider", async () => {
    const { status } = await call("/api/engine", { method: "PATCH", body: { provider: "gemini" } });
    expect(status).toBe(400);
  });

  it("drops model overrides when the provider changes", async () => {
    await call("/api/engine", { method: "PATCH", body: { provider: "anthropic", models: { drafting: "claude-fable-5" } } });
    const { body } = await call("/api/engine", { method: "PATCH", body: { provider: "openai" } });
    expect(body.choice.models).toEqual({});
    expect(body.resolvedModels.drafting).toBe("gpt-5.6-sol");
  });

  it("404s unknown routes as JSON", async () => {
    const { status, body } = await call("/api/does-not-exist");
    expect(status).toBe(404);
    expect(body.error).toBe("Not found");
  });
});

describe("api keys", () => {
  it("stores a key and returns only a mask, never the key", async () => {
    await call("/api/engine", { method: "PATCH", body: { provider: "anthropic", authMethod: "api_key" } });
    const saved = await call("/api/engine/key", {
      method: "POST",
      body: { provider: "anthropic", key: "sk-ant-test-0000000000000000abcd" }
    });
    expect(saved.body.saved).toBe(true);
    expect(saved.body.masked).toBe("sk-ant-t...abcd");

    const engine = await call("/api/engine");
    expect(engine.body.storedKey).toBe("sk-ant-t...abcd");
    expect(JSON.stringify(engine.body)).not.toContain("0000000000000000");
  });

  it("counts a stored key as a ready credential", async () => {
    await call("/api/engine", { method: "PATCH", body: { provider: "anthropic", authMethod: "api_key" } });
    await call("/api/engine/key", { method: "POST", body: { provider: "anthropic", key: "sk-ant-test-0000000000000000abcd" } });
    const { body } = await call("/api/engine");
    expect(body.credentials.ready).toBe(true);
    expect(body.credentials.runtime).toBe("studio");
  });

  it("removes a key", async () => {
    await call("/api/engine", { method: "PATCH", body: { provider: "anthropic", authMethod: "api_key" } });
    await call("/api/engine/key", { method: "POST", body: { provider: "anthropic", key: "sk-ant-test-0000000000000000abcd" } });
    await call("/api/engine/key/anthropic", { method: "DELETE" });
    const { body } = await call("/api/engine");
    expect(body.storedKey).toBeNull();
  });

  it("rejects an unknown provider and an empty key", async () => {
    expect((await call("/api/engine/key", { method: "POST", body: { provider: "gemini", key: "x" } })).status).toBe(400);
    expect((await call("/api/engine/key", { method: "POST", body: { provider: "openai", key: "  " } })).status).toBe(400);
  });

  it("refuses to verify when nothing is stored", async () => {
    const { status } = await call("/api/engine/key/verify", { method: "POST", body: { provider: "openai" } });
    expect(status).toBe(400);
  });
});

describe("source removal", () => {
  it("removes a document from the analysis without touching the others", async () => {
    await call("/api/engine", { method: "PATCH", body: { provider: "anthropic", authMethod: "subscription" } });
    // Seed two sources through the state file, since indexing needs Drive.
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const seeded = await load("test-book");
    seeded.sources = [
      { driveId: "a", name: "Keep", path: "/a", mimeType: "text/plain", isFolder: false, kinds: ["notes"] },
      { driveId: "b", name: "Drop", path: "/b", mimeType: "text/plain", isFolder: false, kinds: [] }
    ];
    await save(seeded);

    const { body } = await call("/api/sources/b", { method: "DELETE" });
    expect(body.sources.map((s: any) => s.driveId)).toEqual(["a"]);
  });

  it("is a no-op for an id that is not there", async () => {
    const { status } = await call("/api/sources/nope", { method: "DELETE" });
    expect(status).toBe(200);
  });
});

describe("source roles", () => {
  it("keeps a series book as a voice reference, and keeps voice when canon is removed", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.sources = [{ driveId: "book", name: "Book", path: "/book", mimeType: "text/plain", isFolder: false, kinds: ["past_book", "reference_book"] }];
    await save(state);

    const cannotRemoveVoice = await call("/api/sources/book", { method: "PATCH", body: { kinds: ["past_book"] } });
    expect(cannotRemoveVoice.body.sources[0].kinds).toEqual(["past_book", "reference_book"]);

    const removedCanon = await call("/api/sources/book", { method: "PATCH", body: { kinds: ["reference_book"] } });
    expect(removedCanon.body.sources[0].kinds).toEqual(["reference_book"]);
  });
});

describe("series order", () => {
  it("persists the author's title order and requires confirmation", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.shape = "series";
    state.draftingMode = "chapter_by_chapter";
    state.sources = [
      { driveId: "first", name: "The Arrival", path: "/The Arrival", mimeType: "text/plain", isFolder: false, kinds: ["past_book", "reference_book"] },
      { driveId: "second", name: "After the Storm", path: "/After the Storm", mimeType: "text/plain", isFolder: false, kinds: ["past_book", "reference_book"] }
    ];
    await save(state);

    const unconfirmed = await call("/api/project/continue", { method: "POST" });
    expect(unconfirmed.status).toBe(400);
    const ordered = await call("/api/project/series-order", {
      method: "PATCH",
      body: { order: ["second", "first"], confirmed: true }
    });
    expect(ordered.body.seriesOrder).toEqual(["second", "first"]);
    expect(ordered.body.seriesOrderReviewed).toBe(true);
    expect((await call("/api/project/continue", { method: "POST" })).status).toBe(200);
  });
});

describe("stored source migration", () => {
  it("carries a single kind forward into the kinds list", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const seeded = await load("test-book");
    // Write the pre-multi-group shape directly.
    (seeded as any).sources = [{ driveId: "old", name: "Old", path: "/o", mimeType: "text/plain", isFolder: false, kind: "past_book" }];
    await save(seeded);

    const reloaded = await load("test-book");
    expect(reloaded.sources[0].kinds).toEqual(["past_book"]);
  });
});

describe("style source requirement", () => {
  async function seed(sources: any[]) {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.sources = sources;
    state.sourcesReviewed = false;
    await save(state);
  }
  const doc = (id: string, kinds: string[], wordCount: number) =>
    ({ driveId: id, name: id, path: `/${id}`, mimeType: "text/plain", isFolder: false, kinds, wordCount,
      voiceReferenceConfirmed: kinds.includes("reference_book") && !kinds.includes("past_book") });

  it("requires both a voice reference and a plot outline", async () => {
    await seed([doc("a", ["notes"], 50000), doc("plot", ["plot"], 1000)]);
    const check = await call("/api/sources/check");
    const { status } = await call("/api/sources/reviewed", { method: "POST" });
    expect(status).toBe(400);
    expect(check.body.style.ok).toBe(false);
    expect(check.body.plot.ok).toBe(true);
  });

  it("does not treat a Series book without its voice role as a complete project", async () => {
    await seed([doc("a", ["past_book"], 40000)]);
    const { body } = await call("/api/sources/check");
    expect(body.style.ok).toBe(false);
    expect(body.plot.ok).toBe(false);
  });

  it("requires voice references to carry enough prose", async () => {
    await seed([doc("a", ["past_book", "reference_book"], 200), doc("b", ["reference_book"], 200), doc("plot", ["plot"], 1000)]);
    const { body } = await call("/api/sources/check");
    expect(body.style.ok).toBe(false);
    expect(body.plot.ok).toBe(true);
    expect(body.style.reason).toMatch(/too noisy/i);
  });

  it("lets one document satisfy both requirements", async () => {
    await seed([doc("both", ["past_book", "reference_book", "plot"], 40000)]);
    const { body } = await call("/api/sources/check");
    expect(body.ok).toBe(true);
    expect(body.style.ok).toBe(true);
    expect(body.plot.ok).toBe(true);
    expect((await call("/api/sources/reviewed", { method: "POST" })).status).toBe(200);
  });

  it("refuses to continue when the prose is too short to measure", async () => {
    await seed([doc("a", ["past_book", "reference_book"], 300), doc("plot", ["plot"], 1000)]);
    const { status, body } = await call("/api/sources/reviewed", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/too noisy/i);
  });

  it("accepts the author's own writing once it is long enough", async () => {
    await seed([doc("a", ["past_book", "reference_book"], 40000), doc("plot", ["plot"], 1000)]);
    const { status } = await call("/api/sources/reviewed", { method: "POST" });
    expect(status).toBe(200);
  });

  it("accepts references alone when the author has written nothing", async () => {
    await seed([doc("a", ["reference_book"], 40000), doc("plot", ["plot"], 1000)]);
    const check = await call("/api/sources/check");
    expect(check.body.ok).toBe(true);
    expect(check.body.fromReference).toBe(true);
    expect((await call("/api/sources/reviewed", { method: "POST" })).status).toBe(200);
  });

  it("uses every selected voice reference for style when both roles exist", async () => {
    await seed([doc("mine", ["past_book", "reference_book"], 40000), doc("theirs", ["reference_book"], 90000), doc("plot", ["plot"], 1000)]);
    const { body } = await call("/api/sources/check");
    expect(body.fromReference).toBe(false);
    expect(body.style.words).toBe(130000);
    expect(body.plot.documents).toBe(1);
  });

  it("accepts explicitly selected voice references", async () => {
    await seed([doc("a", ["reference_book"], 40000), doc("plot", ["plot"], 1000)]);
    const { body } = await call("/api/sources/check");
    expect(body.style.words).toBe(40000);
    expect(body.style.ok).toBe(true);
  });
});

describe("editing and rebuilding the style corpus", () => {
  const prose = "She crossed the yard before the rain came. \"You waited,\" he said, and she heard the question under it. ";

  async function seedCorpusSources() {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.sources = [
      { driveId: "mine", name: "Book One", path: "/Book One", mimeType: "text/plain", isFolder: false, kinds: ["past_book", "reference_book"], wordCount: 40000 },
      { driveId: "ghost", name: "Ghostwritten", path: "/Ghostwritten", mimeType: "text/plain", isFolder: false, kinds: ["reference_book"], voiceReferenceConfirmed: true, wordCount: 40000 },
      { driveId: "plot", name: "Plot", path: "/Plot", mimeType: "text/plain", isFolder: false, kinds: ["plot"], wordCount: 2000 }
    ];
    state.sourcesReviewed = true;
    await save(state);
    const cache = workspacePaths("test-book").driveCache;
    await mkdir(cache, { recursive: true });
    await writeFile(`${cache}/mine.json`, JSON.stringify({ text: prose.repeat(60) }), "utf8");
    await writeFile(`${cache}/ghost.json`, JSON.stringify({ text: prose.repeat(60) }), "utf8");
  }

  it("leaves excluded documents out of the corpus and remembers the choice", async () => {
    await seedCorpusSources();
    const all = await call("/api/style/build", { method: "POST" });
    expect(all.status).toBe(200);

    const { status, body } = await call("/api/style/build", { method: "POST", body: { excluded: ["ghost"] } });
    expect(status).toBe(200);
    expect(body.styleCorpus.excluded).toEqual(["ghost"]);
    expect(body.styleCorpus.wordCount).toBeLessThan(all.body.styleCorpus.wordCount);

    const corpus = JSON.parse(await readFile(path.join(workspacePaths("test-book").artifacts, "style-corpus.json"), "utf8"));
    expect(corpus.passages.every((passage: { source: string }) => passage.source === "Book One")).toBe(true);
  });

  it("refuses to build when every document is excluded", async () => {
    await seedCorpusSources();
    const { status, body } = await call("/api/style/build", { method: "POST", body: { excluded: ["mine", "ghost"] } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/every document you could learn from is excluded/i);
  });

  it("carries author notes into the fingerprint the writing agents read", async () => {
    await seedCorpusSources();
    const { body } = await call("/api/style/build", {
      method: "POST",
      body: { notes: "My dialogue runs shorter than book one suggests." }
    });
    expect(body.styleCorpus.notes).toMatch(/dialogue runs shorter/);
    expect(body.styleCorpus.documentStats[0].wordCount).toBeGreaterThan(0);
    expect(body.styleCorpus.documentStats[0].chapterCount).toBe(1);
    expect(body.styleCorpus.documentStats[0].wordsPerChapter).toHaveLength(1);

    const fingerprint = await readFile(path.join(workspacePaths("test-book").artifacts, "style-fingerprint.md"), "utf8");
    expect(fingerprint).toMatch(/## Author notes on this voice/);
    expect(fingerprint).toMatch(/dialogue runs shorter/);

    const again = await call("/api/style/build", { method: "POST" });
    expect(again.body.styleCorpus.notes).toMatch(/dialogue runs shorter/);
  });

  it("keeps the author on the same screen when they rebuild after continuing", async () => {
    await seedCorpusSources();
    await call("/api/style/build", { method: "POST" });
    await call("/api/style/continue", { method: "POST" });
    const { body } = await call("/api/style/build", { method: "POST", body: { notes: "Colder." } });
    expect(body.styleCorpus.continuedAt).toBeTruthy();
  });
});

describe("editing and rebuilding the project analysis", () => {
  async function seedAnalysis() {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.sources = [{
      driveId: "plot", name: "Plot Notes", path: "/Plot Notes", mimeType: "text/plain", isFolder: false, kinds: ["plot"]
    }];
    await save(state);
    const cache = workspacePaths("test-book").driveCache;
    await mkdir(cache, { recursive: true });
    await writeFile(`${cache}/plot.json`, JSON.stringify({
      text: "Premise: Cole hunts the thing in the water and loses his nerve.\nThe murder case stays open."
    }), "utf8");
    await call("/api/intake/analyse", { method: "POST" });
  }

  it("takes an author correction over the measured finding", async () => {
    await seedAnalysis();
    const { status, body } = await call("/api/intake/analysis", {
      method: "PATCH",
      body: { findings: { protagonist: "Mara, who wants the harbour back and must give up the boat." } }
    });

    expect(status).toBe(200);
    expect(body.analysis.findings.protagonist.value).toMatch(/^Mara/);
    expect(body.analysis.findings.protagonist.authorEdited).toBe(true);
    expect(body.analysis.questionPlan.map((question: { key: string }) => question.key)).not.toContain("protagonistArc");

    const saved = JSON.parse(await readFile(path.join(workspacePaths("test-book").artifacts, "project-analysis.json"), "utf8"));
    expect(saved.findings.protagonist.value).toMatch(/^Mara/);
  });

  it("writes an author genre through to the intake decisions", async () => {
    await seedAnalysis();
    const { body } = await call("/api/intake/analysis", { method: "PATCH", body: { genre: "Horror", subgenre: "Coastal horror" } });
    expect(body.state.intake.genre).toBe("Horror");
    expect(body.state.intake.subgenre).toBe("Coastal horror");
    expect(body.analysis.confidence).toBe(1);
  });

  it("clears a finding the analyzer invented, and reopens its question", async () => {
    await seedAnalysis();
    const { body } = await call("/api/intake/analysis", { method: "PATCH", body: { findings: { premise: "" } } });
    expect(body.analysis.findings.premise).toBeNull();
    expect(body.analysis.questionPlan.map((question: { key: string }) => question.key)).toContain("storyPromise");
  });

  it("rejects a correction to a finding that does not exist", async () => {
    await seedAnalysis();
    const { status, body } = await call("/api/intake/analysis", { method: "PATCH", body: { findings: { vibes: "good" } } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown finding/i);
  });

  it("reads rebuild notes as material and keeps them on the record", async () => {
    await seedAnalysis();
    const { body } = await call("/api/intake/analyse", {
      method: "POST",
      body: { notes: "Setting: the story happens in a drowned harbour town in 1974." }
    });
    expect(body.state.projectAnalysis.authorNotes).toMatch(/drowned harbour town/);
    expect(body.analysis.findings.setting?.value).toMatch(/drowned harbour town/);
    expect(body.analysis.documentsRead).toBe(1);
  });

  it("keeps corrections through a rebuild unless the author drops them", async () => {
    await seedAnalysis();
    await call("/api/intake/analysis", { method: "PATCH", body: { findings: { protagonist: "Mara owns the arc." } } });

    const kept = await call("/api/intake/analyse", { method: "POST", body: { notes: "" } });
    expect(kept.body.analysis.findings.protagonist.value).toMatch(/^Mara/);

    const dropped = await call("/api/intake/analyse", { method: "POST", body: { keepCorrections: false } });
    expect(dropped.body.analysis.findings.protagonist?.value ?? "").not.toMatch(/^Mara/);
    expect(dropped.body.state.projectAnalysis.edits).toEqual({});
  });

  it("clears every correction on request", async () => {
    await seedAnalysis();
    await call("/api/intake/analysis", { method: "PATCH", body: { genre: "Horror" } });
    const { body } = await call("/api/intake/analysis", { method: "PATCH", body: { clear: true } });
    expect(body.state.projectAnalysis.edits).toEqual({});
    expect(body.analysis.genre).not.toBe("Horror");
  });

  it("keeps notes and corrections when the sources are re-grouped", async () => {
    await seedAnalysis();
    await call("/api/intake/analyse", { method: "POST", body: { notes: "Mara is the lead." } });
    await call("/api/intake/analysis", { method: "PATCH", body: { genre: "Horror" } });

    const { body } = await call("/api/sources/plot", { method: "PATCH", body: { kinds: ["notes"] } });
    expect(body.projectAnalysis.completed).toBe(false);
    expect(body.projectAnalysis.authorNotes).toMatch(/Mara is the lead/);
    expect(body.projectAnalysis.edits.genre).toBe("Horror");
  });
});

describe("run halt and resume", () => {
  it("lets the author read preparation documents, add notes, and review the package", async () => {
    await seedPreparationPackage();
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.preparationReviewed = false;
    await save(state);

    const docs = await call("/api/preparation/documents");
    expect(docs.status).toBe(200);
    expect(docs.body.documents).toHaveLength(9);
    expect(docs.body.documents[0].content).toMatch(/project-brief/);
    expect(docs.body.documents[0].rendered).toContain("<h1>");
    const view = await fetch(`${base}/api/preparation/documents/project-brief.md/view`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("Print / Save PDF");

    const noted = await call("/api/preparation/documents/project-brief.md", {
      method: "PATCH",
      body: { note: "The ending direction needs another pass." }
    });
    expect(noted.body.preparationReviewed).toBe(false);

    const reviewed = await call("/api/preparation/review", { method: "POST" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.preparationReviewed).toBe(true);
  });

  it("refuses to start drafting before the writing gate", async () => {
    const result = await call("/api/run/start", { method: "POST", body: { chapter: 1 } });
    expect(result.status).toBe(409);
  });

  it("reports a missing preparation package before starting a run", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    await mkdir(workspacePaths("test-book").artifacts, { recursive: true });
    await writeFile(path.join(workspacePaths("test-book").artifacts, "project-brief.md"), "# Project brief", "utf8");
    const state = await load("test-book");
    state.chapters = [{ number: 1, title: "One", synopsis: "", status: "planned", issues: [] }];
    state.writingConfirmed = true;
    state.engine = { ...state.engine, provider: "anthropic", authMethod: "subscription", draftingProvider: "anthropic", draftingAuthMethod: "subscription" };
    await save(state);

    const prep = await call("/api/preparation/status");
    expect(prep.body.ready).toBe(false);
    expect(prep.body.artifactDirectory).toBe("workspaces/test-book/artifacts/");
    expect(prep.body.present).toEqual(["project-brief.md"]);
    expect(prep.body.missing).toHaveLength(8);
    const docs = await call("/api/preparation/documents");
    expect(docs.status).toBe(200);
    expect(docs.body.documents.find((doc: { name: string }) => doc.name === "project-brief.md").content).toContain("Project brief");
    expect(docs.body.documents.find((doc: { name: string }) => doc.name === "book-bible.md").content).toBeNull();
    const missingView = await fetch(`${base}/api/preparation/documents/book-bible.md/view`);
    expect(missingView.status).toBe(404);
    const result = await call("/api/run/start", { method: "POST" });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/Preparation is not ready/);
  });

  it("records a halt with its reason and the chapter it stopped on", async () => {
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }, { number: 2, title: "Two" }] } });
    const { body } = await call("/api/run/halt", {
      method: "POST",
      body: { reason: "no_credit", chapter: 2, detail: "credit balance is too low" }
    });
    expect(body.run.status).toBe("halted");
    expect(body.run.reason).toBe("no_credit");
    expect(body.run.chapter).toBe(2);
    expect(body.run.detail).toContain("credit balance");
  });

  it("falls back to a safe reason for anything unrecognised", async () => {
    const { body } = await call("/api/run/halt", { method: "POST", body: { reason: "wat" } });
    expect(body.run.reason).toBe("other");
  });

  it("redacts credential-shaped halt details before persistence", async () => {
    const { body } = await call("/api/run/halt", {
      method: "POST",
      body: { reason: "provider_error", detail: "Authorization: Bearer abc.def.ghi api_key=sk-ant-1234567890abcdef" }
    });
    expect(body.run.detail).not.toContain("abc.def.ghi");
    expect(body.run.detail).not.toContain("sk-ant-1234567890abcdef");
    expect(body.run.detail).toContain("[redacted]");
  });

  it("resumes at the first chapter that is not approved", async () => {
    await seedPreparationPackage();
    await call("/api/chapters", {
      method: "PUT",
      body: { chapters: [{ number: 1, title: "One" }, { number: 2, title: "Two" }, { number: 3, title: "Three" }] }
    });
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.writingConfirmed = true;
    state.engine = { ...state.engine, provider: "anthropic", authMethod: "subscription", draftingProvider: "anthropic", draftingAuthMethod: "subscription" };
    await save(state);
    await call("/api/chapters/1/status", { method: "POST", body: { status: "validated" } });
    await call("/api/chapters/1/status", { method: "POST", body: { status: "approved" } });
    await call("/api/run/halt", { method: "POST", body: { reason: "rate_limited" } });

    const { body } = await call("/api/run/resume", { method: "POST" });
    expect(body.resumed).toBe(true);
    expect(body.resumeAt).toBe(2);
    expect(body.state.run.status).toBe("running");
    expect(body.state.run.reason).toBeNull();
  });

  it("resumes with the current drafting provider after a provider switch", async () => {
    await seedPreparationPackage();
    await call("/api/chapters", {
      method: "PUT",
      body: { chapters: [{ number: 1, title: "One" }, { number: 2, title: "Two" }] }
    });
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.writingConfirmed = true;
    state.engine = { ...state.engine, provider: "anthropic", authMethod: "subscription", draftingProvider: "anthropic", draftingAuthMethod: "subscription" };
    await save(state);
    const started = await call("/api/run/start", { method: "POST" });
    expect(started.body.run.role).toBe("drafting");
    await call("/api/run/stop", { method: "POST" });
    await call("/api/engine", { method: "PATCH", body: { routing: "split", analysisProvider: "openai", draftingProvider: "openai", analysisAuthMethod: "subscription", draftingAuthMethod: "subscription" } });

    const resumed = await call("/api/run/resume", { method: "POST" });
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.state.run.role).toBe("drafting");
    expect(resumed.body.model).toBe("gpt-5.6-sol");
    await call("/api/run/stop", { method: "POST" });
  });
});

describe("starting the writing run", () => {
  async function ready() {
    await seedPreparationPackage();
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }] } });
    const state = await load("test-book");
    state.writingConfirmed = true;
    state.engine = { ...state.engine, provider: "anthropic", authMethod: "subscription", draftingProvider: "anthropic", draftingAuthMethod: "subscription" };
    await save(state);
  }

  it("reports the runtime and model the author's choice resolves to", async () => {
    await ready();
    const { body } = await call("/api/run/runtime");
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-opus-5");
    expect(body.running).toBe(false);
  });

  it("estimates tokens without inventing a subscription price", async () => {
    await ready();
    const { body } = await call("/api/run/estimate");
    expect(body.model).toBe("claude-opus-5");
    expect(body.chapters).toBe(1);
    expect(body.totalTokens).toBeGreaterThan(body.outputTokens);
    expect(body.totalCostUsd).toBeNull();
  });

  it("estimates API usage from the selected drafting model rates", async () => {
    await ready();
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.engine = { ...state.engine, provider: "openai", authMethod: "api_key", draftingProvider: "openai", draftingAuthMethod: "api_key" };
    await save(state);

    const { body } = await call("/api/run/estimate");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.inputCostUsd).toBeGreaterThan(0);
    expect(body.outputCostUsd).toBeGreaterThan(0);
    expect(body.totalCostUsd).toBe(body.inputCostUsd + body.outputCostUsd);
  });

  it("runs preparation through the analysis provider in split mode", async () => {
    await seedPreparationPackage();
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    const state = await load("test-book");
    state.preparationReviewed = false;
    state.writingConfirmed = true;
    state.engine = {
      ...state.engine,
      routing: "split",
      analysisProvider: "openai",
      analysisAuthMethod: "subscription",
      draftingProvider: "anthropic",
      draftingAuthMethod: "subscription"
    };
    await save(state);

    const started = await call("/api/preparation/run", { method: "POST" });
    expect(started.status).toBe(200);
    expect(started.body.model).toBe("gpt-5.6-luna");
    expect(started.body.run.role).toBe("analysis");
    expect(started.body.run.chapter).toBeNull();
    await call("/api/run/stop", { method: "POST" });
  });

  it("marks the book as running and records what it started", async () => {
    await ready();
    const { status, body } = await call("/api/run/start", { method: "POST", body: { note: "Start at chapter one." } });
    expect(status).toBe(200);
    expect(body.run.status).toBe("running");
    expect(body.runtime).toBeTruthy();

    const events = await call("/api/run/events");
    expect(events.body.command).toContain("book-orchestrator");
    expect(events.body.events.map((event: { text: string }) => event.text).join(" ")).toMatch(/Starting/);
    await call("/api/run/stop", { method: "POST" });
  });

  it("refuses to start without a writing engine", async () => {
    const { loadState: load, saveState: save } = await import("../src/studio/state.js");
    await call("/api/chapters", { method: "PUT", body: { chapters: [{ number: 1, title: "One" }] } });
    const state = await load("test-book");
    state.writingConfirmed = true;
    await save(state);
    const { status, body } = await call("/api/run/start", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/writing engine/i);
  });

  it("refuses to stop what is not running", async () => {
    const { status } = await call("/api/run/stop", { method: "POST" });
    expect(status).toBe(409);
  });

  it("reopens preparation so the record can be corrected", async () => {
    await ready();
    const { body } = await call("/api/writing/reopen", { method: "POST" });
    expect(body.writingConfirmed).toBe(false);
    expect(body.phase).toBe("preflight");
  });
});

describe("directions", () => {
  it("accepts an instruction and lists it as pending", async () => {
    const created = await call("/api/directions", {
      method: "POST",
      body: { text: "Keep the protagonist's chapters colder.", scope: "book" }
    });
    expect(created.status).toBe(201);

    const { body } = await call("/api/directions");
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].text).toContain("colder");
  });

  it("moves an instruction out of pending once applied", async () => {
    const created = await call("/api/directions", { method: "POST", body: { text: "Shorter chapters." } });
    await call(`/api/directions/${created.body.direction.id}/applied`, { method: "POST", body: { chapter: 4 } });

    const { body } = await call("/api/directions");
    expect(body.pending).toHaveLength(0);
    expect(body.directions[0].appliedTo).toBe(4);
  });

  it("edits a pending instruction", async () => {
    const created = await call("/api/directions", { method: "POST", body: { text: "Keep the opening quiet." } });
    const edited = await call(`/api/directions/${created.body.direction.id}`, {
      method: "PATCH",
      body: { text: "Keep the opening tense.", scope: "chapter", chapter: 2 }
    });
    expect(edited.status).toBe(200);
    expect(edited.body.direction.text).toBe("Keep the opening tense.");
    expect(edited.body.direction.scope).toBe("chapter");
    expect(edited.body.direction.chapter).toBe(2);
  });

  it("removes an instruction", async () => {
    const created = await call("/api/directions", { method: "POST", body: { text: "Drop the subplot." } });
    await call(`/api/directions/${created.body.direction.id}`, { method: "DELETE" });
    expect((await call("/api/directions")).body.directions).toHaveLength(0);
  });

  it("rejects an empty or oversized instruction", async () => {
    expect((await call("/api/directions", { method: "POST", body: { text: "   " } })).status).toBe(400);
    expect((await call("/api/directions", { method: "POST", body: { text: "x".repeat(5000) } })).status).toBe(400);
  });
});

describe("target folder is required", () => {
  it("refuses to index without one", async () => {
    await call("/api/drive/roots", { method: "POST", body: { roots: ["1AAAAAAAAAAAAAAAAAAAAAAAAAAA"] } });
    const { status, body } = await call("/api/sources/index", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/target folder/i);
  });

  it("still refuses when a target exists but nothing was selected to read", async () => {
    await call("/api/drive/roots", {
      method: "POST",
      body: { roots: [], targetFolderId: "1BBBBBBBBBBBBBBBBBBBBBBBBBBB" }
    });
    const { status, body } = await call("/api/sources/index", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/reference folder or file/i);
  });
});
