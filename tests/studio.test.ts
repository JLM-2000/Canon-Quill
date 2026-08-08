import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  it("starts at connect on a fresh project", () => {
    expect(derivePhase(emptyState("x"))).toBe("engine");
  });

  it("asks for a provider before anything else", () => {
    const state = emptyState("x");
    state.drive.connected = true;
    expect(derivePhase(state)).toBe("engine");
  });

  it("asks for sources once the engine and Drive are set", () => {
    const state = emptyState("x");
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.drive.connected = true;
    expect(derivePhase(state)).toBe("sources");
  });

  it("asks for intake once sources are confirmed", () => {
    const state = emptyState("x");
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
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
    expect(derivePhase(state)).toBe("intake");
  });

  it("holds at the existing-draft step until it is answered", () => {
    const state = emptyState("x");
    state.engine = { provider: "anthropic", authMethod: "subscription", models: {} };
    state.drive.connected = true;
    state.drive.referenceRoots = ["root-1"];
    state.sources = [{ driveId: "a", name: "book.md", path: "/book.md", mimeType: "text/plain", isFolder: false, kinds: ["past_book"] }];
    state.sourcesReviewed = true;
    state.shape = "standalone";
    state.draftingMode = "chapter_by_chapter";
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
    state.chapters = [{ number: 1, title: "One", synopsis: "", status: "planned", issues: [] }];
    expect(derivePhase(state)).toBe("writing");
  });

  it("reaches export only when every chapter is approved", () => {
    const state = emptyState("x");
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
    expect(html).toContain("Reset questions and project analysis");
  });

  it("returns state with a derived phase", async () => {
    const { body } = await call("/api/state");
    expect(body.state.projectName).toBe("Test Book");
    expect(body.state.phase).toBe("engine");
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

  it("rejects an unknown drafting mode without clobbering the stored value", async () => {
    await call("/api/project", { method: "PATCH", body: { draftingMode: "chapter_by_chapter" } });
    const { body } = await call("/api/project", { method: "PATCH", body: { draftingMode: "nonsense" } });
    expect(body.draftingMode).toBe("chapter_by_chapter");
  });

  it("accepts a question from an agent and an answer from the author", async () => {
    const created = await call("/api/questions", {
      method: "POST",
      body: {
        question: "Should Mara know about the forgery in chapter 3?",
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
      JSON.stringify({ text: "Premise: Mara must choose between the love she wants and the family secret that can destroy her. Conflict: the secret threatens her relationship. Ending: the couple stays together." }),
      "utf8"
    );

    const started = await call("/api/conversation/start", { method: "POST" });
    expect(started.body.questions).toHaveLength(1);
    expect(started.body.questions[0].key).toBe("protagonistArc");
    expect(started.body.questions[0].question).toMatch(/Mara|family secret/i);

    const answered = await call(`/api/questions/${started.body.questions[0].id}/answer`, {
      method: "POST",
      body: { answer: "Mara is the protagonist and wants a life outside her family." }
    });
    expect(answered.body.questions).toHaveLength(2);
    expect(answered.body.questions[1].key).toBe("relationshipArc");

    const relationshipAnswered = await call(`/api/questions/${answered.body.questions[1].id}/answer`, {
      method: "POST",
      body: { answer: "Mara and her partner choose each other despite the family secret." }
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
    state.drive.connected = true;
    state.drive.referenceRoots = ["root"];
    state.sources = [{ driveId: "source", name: "Reference", path: "/Reference", mimeType: "text/plain", isFolder: false, kinds: ["reference_book"] }];
    state.sourcesReviewed = true;
    state.shape = "standalone";
    state.draftingMode = "chapter_by_chapter";
    state.manuscriptReviewed = true;
    state.styleCorpus.built = true;
    await save(state);
    const result = await call("/api/style/continue", { method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.styleCorpus.continuedAt).toBeTruthy();
    expect(result.body.phase).toBe("intake_analysis");
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

  it("stores a chapter plan and reports it", async () => {
    const { body } = await call("/api/chapters", {
      method: "PUT",
      body: { chapters: [{ number: 1, title: "The Fence", synopsis: "He runs." }, { number: 2, title: "Marrow" }] }
    });
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters[0].title).toBe("The Fence");
    expect(body.ledger.plannedChapters).toBe(2);
    expect(body.phase).toBe("writing");
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
    expect(body.error).toMatch(/no prose to learn from/i);
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
    ({ driveId: id, name: id, path: `/${id}`, mimeType: "text/plain", isFolder: false, kinds, wordCount });

  it("refuses to continue with nothing marked as a style source", async () => {
    await seed([doc("a", ["notes"], 50000)]);
    const { status, body } = await call("/api/sources/reviewed", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/reference material is required/i);
  });

  it("requires references as well as a style source", async () => {
    await seed([doc("a", ["past_book"], 40000)]);
    const { body } = await call("/api/sources/check");
    expect(body.style.ok).toBe(true);
    expect(body.references.ok).toBe(false);
    expect(body.references.reason).toMatch(/nothing is marked as a reference/i);
    expect((await call("/api/sources/reviewed", { method: "POST" })).status).toBe(400);
  });

  it("requires references to carry enough material", async () => {
    await seed([doc("a", ["past_book"], 40000), doc("b", ["reference_book"], 200)]);
    const { body } = await call("/api/sources/check");
    expect(body.references.ok).toBe(false);
    expect(body.references.reason).toMatch(/little for the book to draw on/i);
  });

  it("lets one document satisfy both requirements", async () => {
    await seed([doc("both", ["past_book", "reference_book"], 40000)]);
    const { body } = await call("/api/sources/check");
    expect(body.ok).toBe(true);
    expect(body.style.ok).toBe(true);
    expect(body.references.ok).toBe(true);
    expect((await call("/api/sources/reviewed", { method: "POST" })).status).toBe(200);
  });

  it("refuses to continue when the prose is too short to measure", async () => {
    await seed([doc("a", ["past_book", "reference_book"], 300)]);
    const { status, body } = await call("/api/sources/reviewed", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/too noisy/i);
  });

  it("accepts the author's own writing once it is long enough", async () => {
    await seed([doc("a", ["past_book", "reference_book"], 40000)]);
    const { status } = await call("/api/sources/reviewed", { method: "POST" });
    expect(status).toBe(200);
  });

  it("accepts references alone when the author has written nothing", async () => {
    await seed([doc("a", ["reference_book"], 40000)]);
    const check = await call("/api/sources/check");
    expect(check.body.ok).toBe(true);
    expect(check.body.fromReference).toBe(true);
    expect((await call("/api/sources/reviewed", { method: "POST" })).status).toBe(200);
  });

  it("prefers the author's own writing for style when both exist", async () => {
    await seed([doc("mine", ["past_book"], 40000), doc("theirs", ["reference_book"], 90000)]);
    const { body } = await call("/api/sources/check");
    expect(body.fromReference).toBe(false);
    expect(body.style.words).toBe(40000);
    expect(body.references.words).toBe(90000);
  });

  it("refuses to build a corpus from reference writing unless asked", async () => {
    await seed([doc("a", ["reference_book"], 40000)]);
    const { status, body } = await call("/api/style/build", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/read like whoever wrote it/i);
  });
});

describe("run halt and resume", () => {
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

  it("resumes at the first chapter that is not approved", async () => {
    await call("/api/chapters", {
      method: "PUT",
      body: { chapters: [{ number: 1, title: "One" }, { number: 2, title: "Two" }, { number: 3, title: "Three" }] }
    });
    await call("/api/chapters/1/status", { method: "POST", body: { status: "approved" } });
    await call("/api/run/halt", { method: "POST", body: { reason: "rate_limited" } });

    const { body } = await call("/api/run/resume", { method: "POST" });
    expect(body.resumed).toBe(true);
    expect(body.resumeAt).toBe(2);
    expect(body.state.run.status).toBe("running");
    expect(body.state.run.reason).toBeNull();
  });
});

describe("directions", () => {
  it("accepts an instruction and lists it as pending", async () => {
    const created = await call("/api/directions", {
      method: "POST",
      body: { text: "Keep Mara's chapters colder.", scope: "book" }
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
