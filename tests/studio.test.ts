import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createStudioApp } from "../src/studio/server.js";
import { derivePhase, emptyState, loadState } from "../src/studio/state.js";
import { workspacesRoot } from "../src/workspace/paths.js";
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
        kind: "past_book", confidence: 0.9, reasons: [], confirmedByUser: true
      }
    ];
    expect(derivePhase(state)).toBe("intake");
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
  });

  it("rejects an empty answer", async () => {
    const created = await call("/api/questions", { method: "POST", body: { question: "Q?" } });
    const result = await call(`/api/questions/${created.body.question.id}/answer`, { method: "POST", body: { answer: "  " } });
    expect(result.status).toBe(400);
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

  it("refuses to build a style corpus with no past books", async () => {
    const { status, body } = await call("/api/style/build", { method: "POST" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/past series book/i);
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
    const { status } = await call("/api/sources/abc", { method: "PATCH", body: { kind: "nonsense" } });
    expect(status).toBe(400);
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
