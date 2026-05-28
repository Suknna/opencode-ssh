import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HistoryStore } from "../src/history/store.js";

const testRoot = join(process.cwd(), ".tmp", "history-test");

describe("HistoryStore", () => {
  beforeEach(async () => {
    await rm(testRoot, { force: true, recursive: true });
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { force: true, recursive: true });
  });

  test("appends and reads command output", async () => {
    const store = new HistoryStore({ projectDirectory: testRoot, enabled: true, cleanupOnClose: true });

    await store.append("host-a", "conn-a", "output", "first\n");
    await store.append("host-a", "conn-a", "output", "second\n");

    expect(await store.read("host-a", "conn-a")).toBe("first\nsecond\n");
    expect(await readFile(join(store.pathFor("host-a", "conn-a"), "output.log"), "utf8")).toBe("first\nsecond\n");
  });

  test("disabled store does not create logs", async () => {
    const store = new HistoryStore({ projectDirectory: testRoot, enabled: false, cleanupOnClose: true });

    await store.append("host-a", "conn-a", "output", "ignored\n");

    expect(await exists(join(testRoot, ".opencode"))).toBe(false);
    expect(await store.read("host-a", "conn-a")).toBe("");
  });

  test("cleanup removes connection directory", async () => {
    const store = new HistoryStore({ projectDirectory: testRoot, enabled: true, cleanupOnClose: true });

    await store.append("host-a", "conn-a", "output", "first\n");
    await store.cleanup("host-a", "conn-a");

    expect(await exists(store.pathFor("host-a", "conn-a"))).toBe(false);
  });

  test("cleanup disabled keeps logs", async () => {
    const store = new HistoryStore({ projectDirectory: testRoot, enabled: true, cleanupOnClose: false });

    await store.append("host-a", "conn-a", "output", "first\n");
    await store.cleanup("host-a", "conn-a");

    expect(await exists(join(store.pathFor("host-a", "conn-a"), "output.log"))).toBe(true);
  });

  test("sanitizes traversal-like host, connection, and record identifiers", async () => {
    const store = new HistoryStore({ projectDirectory: testRoot, enabled: true, cleanupOnClose: true });

    await store.append("..", "..", "..", "safe\n");

    expect(store.pathFor("..", "..")).toBe(join(testRoot, ".opencode", "ssh", "_", "_"));
    expect(await readFile(join(testRoot, ".opencode", "ssh", "_", "_", "_.log"), "utf8")).toBe("safe\n");
    expect(await exists(join(testRoot, ".opencode", "_.log"))).toBe(false);
    expect(await exists(join(testRoot, ".opencode", "ssh", "_.log"))).toBe(false);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
