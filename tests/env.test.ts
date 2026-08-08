import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidatePaths, loadDotEnv } from "../src/config/env.js";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cq-env-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loading .env", () => {
  it("reads simple assignments", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".env"), "CQ_TEST_A=hello\nCQ_TEST_B=world\n");
    delete process.env.CQ_TEST_A;
    delete process.env.CQ_TEST_B;

    expect(loadDotEnv(root).sort()).toEqual(["CQ_TEST_A", "CQ_TEST_B"]);
    expect(process.env.CQ_TEST_A).toBe("hello");
  });

  it("keeps backslashes so a Windows path survives", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".env"), String.raw`CQ_TEST_PATH=C:\Users\jluci\Downloads\creds.json` + "\n");
    delete process.env.CQ_TEST_PATH;

    loadDotEnv(root);
    expect(process.env.CQ_TEST_PATH).toBe(String.raw`C:\Users\jluci\Downloads\creds.json`);
  });

  it("strips one layer of quotes but not the content", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".env"), 'CQ_TEST_Q="C:\\Users\\a b\\creds.json"\n');
    delete process.env.CQ_TEST_Q;

    loadDotEnv(root);
    expect(process.env.CQ_TEST_Q).toBe(String.raw`C:\Users\a b\creds.json`);
  });

  it("does not override an existing environment variable", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".env"), "CQ_TEST_WINS=from-file\n");
    process.env.CQ_TEST_WINS = "from-shell";

    loadDotEnv(root);
    expect(process.env.CQ_TEST_WINS).toBe("from-shell");
  });

  it("ignores comments, blanks and malformed lines", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".env"), "# a comment\n\nnot-an-assignment\n=novalue\nCQ_TEST_OK=yes\n");
    delete process.env.CQ_TEST_OK;

    expect(loadDotEnv(root)).toEqual(["CQ_TEST_OK"]);
  });

  it("accepts an export prefix", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".env"), "export CQ_TEST_EXP=value\n");
    delete process.env.CQ_TEST_EXP;

    loadDotEnv(root);
    expect(process.env.CQ_TEST_EXP).toBe("value");
  });

  it("returns nothing when there is no .env", () => {
    expect(loadDotEnv(tempRoot())).toEqual([]);
  });
});

describe("cross-platform paths", () => {
  const windowsPath = String.raw`C:\Users\jluci\Downloads\client_secret.apps.googleusercontent.com.json`;

  it("translates a Windows path to WSL mount points", () => {
    const candidates = candidatePaths(windowsPath, "linux");
    expect(candidates[0]).toBe("/mnt/c/Users/jluci/Downloads/client_secret.apps.googleusercontent.com.json");
    // The mount root is configurable, so alternatives are tried too.
    expect(candidates).toContain("/c/Users/jluci/Downloads/client_secret.apps.googleusercontent.com.json");
  });

  it("keeps a Windows path intact on Windows", () => {
    expect(candidatePaths(windowsPath, "win32")[0]).toBe(windowsPath);
  });

  it("accepts a Windows path written with forward slashes", () => {
    expect(candidatePaths("C:/Users/me/creds.json", "linux")[0]).toBe("/mnt/c/Users/me/creds.json");
  });

  it("maps a WSL mount path back to a drive on Windows", () => {
    expect(candidatePaths("/mnt/c/Users/me/creds.json", "win32")[0]).toBe(String.raw`C:\Users\me\creds.json`);
  });

  it("resolves a UNC WSL path from inside the distro", () => {
    expect(candidatePaths(String.raw`\\wsl$\Ubuntu\home\javi\creds.json`, "linux")[0]).toBe("/home/javi/creds.json");
    expect(candidatePaths(String.raw`\\wsl.localhost\Ubuntu\home\javi\creds.json`, "linux")[0]).toBe(
      "/home/javi/creds.json"
    );
  });

  it("leaves a plain POSIX path alone", () => {
    expect(candidatePaths("/home/javi/creds.json", "linux")).toEqual(["/home/javi/creds.json"]);
  });

  it("expands a leading tilde", () => {
    const [resolved] = candidatePaths("~/creds.json", "linux");
    expect(resolved.endsWith("/creds.json")).toBe(true);
    expect(resolved.startsWith("~")).toBe(false);
  });

  it("strips surrounding quotes pasted from a file browser", () => {
    expect(candidatePaths(`"${windowsPath}"`, "linux")[0]).toBe(
      "/mnt/c/Users/jluci/Downloads/client_secret.apps.googleusercontent.com.json"
    );
  });

  it("handles spaces in the path", () => {
    expect(candidatePaths(String.raw`C:\Users\a b\My Docs\creds.json`, "linux")[0]).toBe(
      "/mnt/c/Users/a b/My Docs/creds.json"
    );
  });

  it("returns nothing for an empty value", () => {
    expect(candidatePaths("   ")).toEqual([]);
  });
});
