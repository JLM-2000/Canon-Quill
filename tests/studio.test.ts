import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createStudioApp } from "../src/studio/server.js";
import { derivePhase, emptyState, loadState, saveState } from "../src/studio/state.js";
import { projectPaths } from "../src/project/paths.js";
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
  await rm(projectPaths.workspace, { recursive: true, force: true });
  await saveState(emptyState("Test Book"));
  if (!server) await listen();
});

afterAll(async () => {
  server?.close();
  await rm(projectPaths.workspace, { recursive: true, force: true });
});

describe("phase derivation", () => {
  it("starts at connect on a fresh project", () => {
    expect(derivePhase(emptyState())).toBe("connect");
  });

  it("asks for sources once Drive is connected", () => {
    const state = emptyState();
    state.drive.connected = true;
    expect(derivePhase(state)).toBe("sources");
  });

  it("asks for intake once sources are confirmed", () => {
    const state = emptyState();
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
    const state = emptyState();
    state.chapters = [{ number: 1, title: "One", synopsis: "", status: "planned", issues: [] }];
    expect(derivePhase(state)).toBe("writing");
  });

  it("reaches export only when every chapter is approved", () => {
    const state = emptyState();
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
    expect(body.projectName).toBe("Test Book");
    expect(body.phase).toBe("connect");
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
    expect((await loadState()).projectName).toBe("Ashfall");
  });

  it("404s unknown routes as JSON", async () => {
    const { status, body } = await call("/api/does-not-exist");
    expect(status).toBe(404);
    expect(body.error).toBe("Not found");
  });
});
