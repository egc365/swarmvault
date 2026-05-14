import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvent,
  clearHookSinks,
  compileVault,
  deriveVaultId,
  emitHookEvent,
  initVault,
  loadVaultConfig,
  newSessionId,
  queryVault,
  registerHookSink
} from "../../src/index.js";
import type { GraphArtifact, HookEvent } from "../../src/types.js";

const tempDirs: string[] = [];

async function tempVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-hooks-core-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

async function seedMinimalGraph(rootDir: string): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  await fs.mkdir(path.join(paths.wikiDir, "concepts"), { recursive: true });
  const now = "2026-05-13T20:00:00.000Z";
  const concept = matter.stringify("# Alpha\n\nBody.", {
    title: "Alpha",
    page_id: "concept:alpha",
    kind: "concept",
    status: "active",
    source_ids: ["src-a"],
    node_ids: ["concept:alpha"],
    freshness: "fresh",
    confidence: 0.9,
    created_at: now,
    updated_at: now
  });
  await fs.writeFile(path.join(paths.wikiDir, "concepts", "alpha.md"), concept, "utf8");
  const graph: GraphArtifact = {
    generatedAt: now,
    nodes: [{ id: "concept:alpha", type: "concept", label: "Alpha", pageId: "concept:alpha", sourceIds: ["src-a"], projectIds: [] }],
    edges: [],
    hyperedges: [],
    sources: [{ id: "src-a", title: "Src A", path: "raw/sources/a.md", sourceClass: "first_party" } as never],
    pages: [
      {
        id: "concept:alpha",
        path: "concepts/alpha.md",
        title: "Alpha",
        kind: "concept",
        sourceIds: ["src-a"],
        projectIds: [],
        nodeIds: ["concept:alpha"],
        freshness: "fresh",
        status: "active",
        confidence: 0.9,
        backlinks: [],
        schemaHash: "",
        sourceHashes: {},
        sourceSemanticHashes: {},
        relatedPageIds: [],
        relatedNodeIds: [],
        relatedSourceIds: ["src-a"],
        createdAt: now,
        updatedAt: now,
        compiledFrom: ["src-a"],
        managedBy: "system"
      }
    ]
  };
  await fs.writeFile(paths.graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  clearHookSinks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("hooks-core unified contract", () => {
  it("delivers PreCompile/PostCompile and PreQuery/PostQuery events to a registered sink with validating payloads", async () => {
    const rootDir = await tempVault();
    await seedMinimalGraph(rootDir);

    const collected: HookEvent[] = [];
    const unregister = registerHookSink(async (event) => {
      collected.push(event);
    });
    try {
      await compileVault(rootDir, {});
      await queryVault(rootDir, { question: "test query", save: false });
    } finally {
      unregister();
    }

    const eventNames = collected.map((event) => event.eventName);
    expect(eventNames).toContain("PreCompile");
    expect(eventNames).toContain("PostCompile");
    expect(eventNames).toContain("PreQuery");
    expect(eventNames).toContain("PostQuery");

    const preCompile = collected.find((event) => event.eventName === "PreCompile");
    expect(preCompile?.payload).toMatchObject({ rootDir });
    expect(preCompile?.sessionId).toBeTruthy();
    expect(preCompile?.vaultId).toBeTruthy();

    const postCompile = collected.find((event) => event.eventName === "PostCompile");
    expect(postCompile?.payload).toMatchObject({ success: true });
    expect(typeof (postCompile?.payload as { pageCount?: number }).pageCount).toBe("number");

    const preQuery = collected.find((event) => event.eventName === "PreQuery");
    expect(preQuery?.payload).toMatchObject({ question: "test query", save: false });

    const postQuery = collected.find((event) => event.eventName === "PostQuery");
    expect(postQuery?.payload).toMatchObject({ success: true });

    const sessionsDir = path.join(rootDir, "state", "sessions");
    const entries = await fs.readdir(sessionsDir);
    const compileSessions = entries.filter((entry) => entry.startsWith("compile-"));
    expect(compileSessions.length).toBeGreaterThan(0);
    const hooksJsonl = await fs.readFile(path.join(sessionsDir, compileSessions[0], "hooks.jsonl"), "utf8");
    expect(hooksJsonl.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("narrows the discriminated union by eventName so per-event payloads are statically typed", async () => {
    const rootDir = await tempVault();
    const sessionId = newSessionId("type-test");
    const vaultId = deriveVaultId(rootDir);

    const collected: HookEvent[] = [];
    const unregister = registerHookSink(async (event) => {
      collected.push(event);
    });
    try {
      await emitHookEvent(
        rootDir,
        buildEvent(rootDir, sessionId, "OnCandidatePromote", {
          pageId: "concept:beta",
          fromPath: "candidates/concepts/beta.md",
          toPath: "concepts/beta.md",
          kind: "concept"
        })
      );
    } finally {
      unregister();
    }

    expect(collected).toHaveLength(1);
    const event = collected[0];
    expect(event.eventName).toBe("OnCandidatePromote");
    expect(event.vaultId).toBe(vaultId);
    expect(event.sessionId).toBe(sessionId);

    // Static narrowing — TypeScript should accept these accesses only when
    // eventName matches. The runtime asserts confirm the narrowing path is
    // exercised; the test is also a compile-time check.
    if (event.eventName === "OnCandidatePromote") {
      const p: { pageId: string; fromPath: string; toPath: string; kind: "concept" | "entity" } = event.payload;
      expect(p.pageId).toBe("concept:beta");
      expect(p.kind).toBe("concept");
    } else {
      throw new Error("event.eventName did not narrow to OnCandidatePromote");
    }
  });
});
