import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, loadVaultConfig, recordPageAccess, scanRetention } from "../../src/index.js";
import type { GraphArtifact, GraphPage } from "../../src/types.js";

const tempDirs: string[] = [];

async function tempVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-retention-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makePage(overrides: Partial<GraphPage> & { id: string; path: string; title: string }): GraphPage {
  const created = overrides.createdAt ?? isoDaysAgo(30);
  return {
    id: overrides.id,
    path: overrides.path,
    title: overrides.title,
    kind: overrides.kind ?? "concept",
    sourceIds: overrides.sourceIds ?? [],
    projectIds: overrides.projectIds ?? [],
    nodeIds: overrides.nodeIds ?? [overrides.id],
    freshness: overrides.freshness ?? "fresh",
    status: overrides.status ?? "active",
    confidence: overrides.confidence ?? 0.8,
    backlinks: overrides.backlinks ?? [],
    schemaHash: overrides.schemaHash ?? "",
    sourceHashes: overrides.sourceHashes ?? {},
    sourceSemanticHashes: overrides.sourceSemanticHashes ?? {},
    relatedPageIds: overrides.relatedPageIds ?? [],
    relatedNodeIds: overrides.relatedNodeIds ?? [],
    relatedSourceIds: overrides.relatedSourceIds ?? [],
    createdAt: created,
    updatedAt: overrides.updatedAt ?? created,
    compiledFrom: overrides.compiledFrom ?? [],
    managedBy: overrides.managedBy ?? "system"
  };
}

async function writeConcept(rootDir: string, slug: string, title: string, frontmatter: Record<string, unknown>): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  await fs.mkdir(path.join(paths.wikiDir, "concepts"), { recursive: true });
  const body = matter.stringify("# " + title + "\n\nBody.", { title, kind: "concept", status: "active", ...frontmatter });
  await fs.writeFile(path.join(paths.wikiDir, "concepts", `${slug}.md`), body, "utf8");
}

describe("retention scan", () => {
  it("flags low-edge no-access pages, spares high-edge recent pages, and never flags important:true pages", async () => {
    const rootDir = await tempVault();
    const { paths } = await loadVaultConfig(rootDir);

    // 5 pages: 2 high-edge recently-accessed, 2 low-edge no-access, 1 important.
    const pages: GraphPage[] = [
      makePage({ id: "concept:high-1", path: "concepts/high-1.md", title: "High 1", createdAt: isoDaysAgo(10) }),
      makePage({ id: "concept:high-2", path: "concepts/high-2.md", title: "High 2", createdAt: isoDaysAgo(10) }),
      makePage({ id: "concept:low-1", path: "concepts/low-1.md", title: "Low 1", createdAt: isoDaysAgo(500) }),
      makePage({ id: "concept:low-2", path: "concepts/low-2.md", title: "Low 2", createdAt: isoDaysAgo(500) }),
      makePage({ id: "concept:vip", path: "concepts/vip.md", title: "VIP", createdAt: isoDaysAgo(1000) })
    ];

    // High-edge pages have several incoming edges; low and vip have zero.
    const edges = [
      {
        id: "e1",
        source: "concept:low-1",
        target: "concept:high-1",
        relation: "related_to",
        status: "explicit",
        evidenceClass: "explicit",
        confidence: 0.9,
        provenance: []
      },
      {
        id: "e2",
        source: "concept:low-2",
        target: "concept:high-1",
        relation: "related_to",
        status: "explicit",
        evidenceClass: "explicit",
        confidence: 0.9,
        provenance: []
      },
      {
        id: "e3",
        source: "concept:vip",
        target: "concept:high-1",
        relation: "related_to",
        status: "explicit",
        evidenceClass: "explicit",
        confidence: 0.9,
        provenance: []
      },
      {
        id: "e4",
        source: "concept:low-1",
        target: "concept:high-2",
        relation: "related_to",
        status: "explicit",
        evidenceClass: "explicit",
        confidence: 0.9,
        provenance: []
      },
      {
        id: "e5",
        source: "concept:low-2",
        target: "concept:high-2",
        relation: "related_to",
        status: "explicit",
        evidenceClass: "explicit",
        confidence: 0.9,
        provenance: []
      },
      {
        id: "e6",
        source: "concept:vip",
        target: "concept:high-2",
        relation: "related_to",
        status: "explicit",
        evidenceClass: "explicit",
        confidence: 0.9,
        provenance: []
      }
    ];

    const graph: GraphArtifact = {
      generatedAt: new Date().toISOString(),
      nodes: pages.map((page) => ({ id: page.id, type: "concept", label: page.title, pageId: page.id, sourceIds: [], projectIds: [] })),
      edges: edges as never,
      hyperedges: [],
      sources: [],
      pages
    };
    await fs.writeFile(paths.graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    // Write on-disk frontmatter for each page.
    for (const page of pages) {
      await writeConcept(
        rootDir,
        page.path.replace(/^concepts\//, "").replace(/\.md$/, ""),
        page.title,
        page.id === "concept:vip" ? { important: true, created_at: page.createdAt } : { created_at: page.createdAt }
      );
    }

    // High-edge pages have recent access entries; low pages have none; vip has none either but is shielded.
    const now = new Date().toISOString();
    await recordPageAccess(rootDir, { pageId: "concept:high-1", queriedAt: now, queryId: "q1" });
    await recordPageAccess(rootDir, { pageId: "concept:high-2", queriedAt: now, queryId: "q2" });

    const result = await scanRetention(rootDir);
    const candidateIds = new Set(result.candidates.map((entry) => entry.pageId));

    expect(candidateIds.has("concept:low-1")).toBe(true);
    expect(candidateIds.has("concept:low-2")).toBe(true);
    expect(candidateIds.has("concept:high-1")).toBe(false);
    expect(candidateIds.has("concept:high-2")).toBe(false);
    expect(candidateIds.has("concept:vip")).toBe(false);

    // Even with a permissive threshold of 1, important:true must stay out of the list.
    const permissive = await scanRetention(rootDir, { threshold: 1.5 });
    const permissiveIds = new Set(permissive.candidates.map((entry) => entry.pageId));
    expect(permissiveIds.has("concept:vip")).toBe(false);

    // Audit file is written.
    const scanFiles = await fs.readdir(path.join(rootDir, "state", "retention"));
    expect(scanFiles.some((entry) => entry.startsWith("scan-") && entry.endsWith(".json"))).toBe(true);
  });
});
