import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { acceptApproval, initVault } from "../../src/index.js";
import type { ApprovalEntry, ApprovalManifest, GraphArtifact, GraphPage } from "../../src/types.js";

const tempDirs: string[] = [];
const now = "2026-05-13T20:10:00.000Z";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<{ rootDir: string; oldPage: GraphPage; newPage: GraphPage }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-op-"));
  tempDirs.push(rootDir);
  await initVault(rootDir);
  const oldPage = makePage("concept:old-page", "concepts/old-page.md", "Old Page");
  const newPage = makePage("concept:new-page", "concepts/new-page.md", "New Page");
  await writeWikiPage(rootDir, oldPage.path, oldPage.id, oldPage.title, "Old body.");
  await writeWikiPage(rootDir, newPage.path, newPage.id, newPage.title, "New body.");
  await fs.writeFile(path.join(rootDir, "state", "graph.json"), `${JSON.stringify(makeGraph([oldPage, newPage]), null, 2)}\n`, "utf8");
  return { rootDir, oldPage, newPage };
}

function makePage(id: string, pagePath: string, title: string): GraphPage {
  return {
    id,
    path: pagePath,
    title,
    kind: "concept",
    sourceIds: [],
    projectIds: [],
    nodeIds: [`node:${id}`],
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "schema",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: now,
    updatedAt: now,
    compiledFrom: [],
    managedBy: "system"
  };
}

function makeGraph(pages: GraphPage[]): GraphArtifact {
  return {
    generatedAt: now,
    nodes: pages.map((page) => ({
      id: `node:${page.id}`,
      type: "concept",
      label: page.title,
      pageId: page.id,
      sourceIds: [],
      projectIds: []
    })),
    edges: [],
    hyperedges: [],
    sources: [],
    pages
  };
}

async function writeWikiPage(rootDir: string, pagePath: string, pageId: string, title: string, body: string): Promise<void> {
  const absolutePath = path.join(rootDir, "wiki", pagePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, matter.stringify(`${body}\n`, { page_id: pageId, title }), "utf8");
}

async function readGraph(rootDir: string): Promise<GraphArtifact> {
  return JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
}

async function stageBundle(
  rootDir: string,
  approvalId: string,
  entry: ApprovalEntry,
  stagedFiles: Record<string, string> = {}
): Promise<void> {
  const approvalDir = path.join(rootDir, "state", "approvals", approvalId);
  await fs.mkdir(path.join(approvalDir, "wiki"), { recursive: true });
  await fs.mkdir(path.join(approvalDir, "state"), { recursive: true });
  const manifest: ApprovalManifest = {
    approvalId,
    createdAt: now,
    bundleType: "compile",
    entries: [entry]
  };
  await fs.writeFile(path.join(approvalDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(approvalDir, "state", "graph.json"), `${JSON.stringify(makeGraph([]), null, 2)}\n`, "utf8");
  for (const [relativePath, content] of Object.entries(stagedFiles)) {
    const target = path.join(approvalDir, "wiki", relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

function entry(page: GraphPage, op: ApprovalEntry["op"], nextPath?: string): ApprovalEntry {
  return {
    pageId: page.id,
    title: page.title,
    kind: page.kind,
    changeType: op === "archive" ? "delete" : "update",
    op,
    status: "pending",
    sourceIds: [],
    previousPath: page.path,
    nextPath
  };
}

describe("approval op vocabulary", () => {
  it("op=keep applies without file changes and emits a log line", async () => {
    const { rootDir, oldPage } = await createWorkspace();
    const before = await fs.readFile(path.join(rootDir, "wiki", oldPage.path), "utf8");
    await stageBundle(rootDir, "op-keep", entry(oldPage, "keep"));

    await acceptApproval(rootDir, "op-keep");

    expect(await fs.readFile(path.join(rootDir, "wiki", oldPage.path), "utf8")).toBe(before);
    expect(await fs.readFile(path.join(rootDir, "wiki", "log.md"), "utf8")).toContain(`keep=${oldPage.id}`);
  });

  it("op=update replaces existing page content", async () => {
    const { rootDir, oldPage } = await createWorkspace();
    await stageBundle(rootDir, "op-update", entry(oldPage, "update", oldPage.path), {
      [oldPage.path]: matter.stringify("Updated body.\n", { page_id: oldPage.id, title: oldPage.title })
    });

    await acceptApproval(rootDir, "op-update");

    expect(await fs.readFile(path.join(rootDir, "wiki", oldPage.path), "utf8")).toContain("Updated body.");
  });

  it("op=merge archives source with redirect frontmatter and updates target", async () => {
    const { rootDir, oldPage, newPage } = await createWorkspace();
    await stageBundle(rootDir, "op-merge", entry(oldPage, "merge", newPage.path));

    await acceptApproval(rootDir, "op-merge");

    await expect(fs.access(path.join(rootDir, "wiki", oldPage.path))).rejects.toThrow();
    expect(await fs.readFile(path.join(rootDir, "wiki", newPage.path), "utf8")).toContain("Old body.");
    const archived = matter(await fs.readFile(path.join(rootDir, "wiki", "archive", "concept-old-page.md"), "utf8"));
    expect(archived.data.redirect_to).toBe(newPage.path);
    expect(archived.data.mergedInto).toBe(newPage.id);
    const graph = await readGraph(rootDir);
    expect(graph.edges.some((edge) => edge.relation === "merge" && edge.provenance[0] === oldPage.id)).toBe(true);
    expect(graph.pages.some((page) => page.path === oldPage.path)).toBe(false);
  });

  it("op=supersede writes supersession frontmatter and graph edges", async () => {
    const { rootDir, oldPage, newPage } = await createWorkspace();
    await stageBundle(rootDir, "op-supersede", entry(oldPage, "supersede", newPage.path));

    await acceptApproval(rootDir, "op-supersede");

    const newFrontmatter = matter(await fs.readFile(path.join(rootDir, "wiki", newPage.path), "utf8"));
    const oldFrontmatter = matter(await fs.readFile(path.join(rootDir, "wiki", "archive", "concept-old-page.md"), "utf8"));
    expect(newFrontmatter.data.supersedes).toBe(oldPage.id);
    expect(oldFrontmatter.data.supersededBy).toBe(newPage.id);
    const graph = await readGraph(rootDir);
    expect(graph.edges.some((edge) => edge.relation === "supersedes" && edge.provenance[0] === newPage.id)).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "supersededBy" && edge.provenance[0] === oldPage.id)).toBe(true);
  });

  it("op=archive moves the page to wiki/archive and removes the main index entry", async () => {
    const { rootDir, oldPage } = await createWorkspace();
    await stageBundle(rootDir, "op-archive", entry(oldPage, "archive"));

    await acceptApproval(rootDir, "op-archive");

    await expect(fs.access(path.join(rootDir, "wiki", oldPage.path))).rejects.toThrow();
    expect(await fs.readFile(path.join(rootDir, "wiki", "archive", "concept-old-page.md"), "utf8")).toContain("Old body.");
    const graph = await readGraph(rootDir);
    expect(graph.pages.some((page) => page.path === oldPage.path)).toBe(false);
    expect(graph.pages.find((page) => page.id === oldPage.id)?.status).toBe("archived");
  });

  it("legacy changeType update still applies when op is absent", async () => {
    const { rootDir, oldPage } = await createWorkspace();
    const legacy = entry(oldPage, undefined, oldPage.path);
    delete legacy.op;
    await stageBundle(rootDir, "legacy-update", legacy, {
      [oldPage.path]: matter.stringify("Legacy body.\n", { page_id: oldPage.id, title: oldPage.title })
    });

    await acceptApproval(rootDir, "legacy-update");

    expect(await fs.readFile(path.join(rootDir, "wiki", oldPage.path), "utf8")).toContain("Legacy body.");
  });
});
