import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachHotCacheHookSink,
  buildEvent,
  buildHotCache,
  clearHookSinks,
  emitHookEvent,
  initVault,
  loadVaultConfig,
  newSessionId,
  refreshHotCacheIfStale
} from "../../src/index.js";

const tempDirs: string[] = [];

async function tempVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-hot-cache-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

async function seed(rootDir: string): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  await fs.mkdir(path.join(paths.sessionsDir, "s1"), { recursive: true });
  await fs.mkdir(paths.approvalsDir, { recursive: true });
  await fs.mkdir(path.join(paths.wikiDir, "outputs"), { recursive: true });
  await fs.mkdir(path.join(paths.wikiDir, "concepts"), { recursive: true });
  await fs.writeFile(path.join(paths.sessionsDir, "s1", "hooks.jsonl"), '{"eventName":"SessionStart"}\n', "utf8");
  await fs.writeFile(path.join(paths.approvalsDir, "a1.json"), '{"id":"approval-1","summary":"accept this"}\n', "utf8");
  await fs.writeFile(path.join(paths.wikiDir, "outputs", "brief.md"), "# Brief\n\nPromoted output body.", "utf8");
  await fs.writeFile(
    path.join(paths.wikiDir, "concepts", "important.md"),
    matter.stringify("# Important\n\nPinned context survives recency.", { title: "Important", important: true }),
    "utf8"
  );
}

afterEach(async () => {
  clearHookSinks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("hot-cache", () => {
  it("builds wiki/.hot-cache.md from recent state and important pages under the token cap", async () => {
    const rootDir = await tempVault();
    await seed(rootDir);

    const result = await buildHotCache(rootDir);
    const { paths } = await loadVaultConfig(rootDir);
    const written = await fs.readFile(path.join(paths.wikiDir, ".hot-cache.md"), "utf8");

    expect(written).toBe(result.content);
    expect(result.tokens).toBeLessThanOrEqual(500);
    expect(result.pages).toEqual(
      expect.arrayContaining(["state/approvals/a1.json", "wiki/outputs/brief.md", "wiki/concepts/important.md"])
    );
    expect(result.content).toContain("Recent Sessions");
    expect(result.content).toContain("Important Pages");
  });

  it("refreshes only when the cache is stale", async () => {
    const rootDir = await tempVault();
    await seed(rootDir);
    const first = await buildHotCache(rootDir);

    await expect(refreshHotCacheIfStale(rootDir)).resolves.toBeUndefined();
    const staleNow = new Date(Date.now() + 61 * 60 * 1000);
    const refreshed = await refreshHotCacheIfStale(rootDir, { now: staleNow });

    expect(refreshed?.content).toContain("Recent Context");
    expect(refreshed?.content).not.toBe(first.content);
  });

  it("refreshes on relevant hook events and session start ensures a cache exists", async () => {
    const rootDir = await tempVault();
    await seed(rootDir);
    const { paths } = await loadVaultConfig(rootDir);
    const unregister = attachHotCacheHookSink(rootDir);
    const sessionId = newSessionId("hot-cache");

    await emitHookEvent(rootDir, buildEvent(rootDir, sessionId, "SessionStart", { trigger: "test", startedAt: new Date().toISOString() }));
    await expect(fs.access(path.join(paths.wikiDir, ".hot-cache.md"))).resolves.toBeUndefined();

    await fs.writeFile(path.join(paths.approvalsDir, "a2.json"), '{"id":"approval-2","summary":"new approval"}\n', "utf8");
    await emitHookEvent(rootDir, buildEvent(rootDir, sessionId, "OnApprovalAccept", { approvalId: "approval-2", entries: [] }));
    let content = await fs.readFile(path.join(paths.wikiDir, ".hot-cache.md"), "utf8");
    expect(content).toContain("approval-2");

    await emitHookEvent(
      rootDir,
      buildEvent(rootDir, sessionId, "OnCandidatePromote", {
        pageId: "concept:new",
        fromPath: "wiki/candidates/concepts/new.md",
        toPath: "wiki/concepts/new.md",
        kind: "concept"
      })
    );
    await emitHookEvent(
      rootDir,
      buildEvent(rootDir, sessionId, "OnOutputPromote", {
        outputSlug: "brief",
        outputPath: "wiki/outputs/brief.md",
        conceptPageId: "concept:brief",
        conceptPath: "wiki/concepts/brief.md",
        sourceIds: [],
        merged: false
      })
    );
    content = await fs.readFile(path.join(paths.wikiDir, ".hot-cache.md"), "utf8");
    expect(content).toContain("Recent Outputs");
    unregister();
  });
});
