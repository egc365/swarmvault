import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { checkTrackedRepoChanges, compileVault, ingestDirectory, initVault, loadVaultConfig } from "../../src/index.js";
import type { GraphArtifact, SourceAnalysis } from "../../src/types.js";

const tempDirs: string[] = [];
async function tmp(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-symbol-stale-")); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("per-symbol code staleness", () => {
  it("marks only pages grounded by changed overlapping symbols as stale", async () => {
    const rootDir = await tmp(); await initVault(rootDir); const repoDir = path.join(rootDir, "repo"); await fs.mkdir(repoDir, { recursive: true }); const sourcePath = path.join(repoDir, "module.py");
    await fs.writeFile(sourcePath, ["def alpha():", "    value = 1", "    return value", "", "def beta():", "    value = 2", "    return value"].join("\n"), "utf8");
    const ingest = await ingestDirectory(rootDir, repoDir, {}); const manifest = ingest.imported[0] ?? ingest.updated[0]; if (!manifest) throw new Error("expected ingested manifest"); await compileVault(rootDir);
    const { paths } = await loadVaultConfig(rootDir); const analysis = JSON.parse(await fs.readFile(path.join(paths.analysesDir, `${manifest.sourceId}.json`), "utf8")) as SourceAnalysis;
    const alpha = analysis.code?.symbols.find((symbol) => symbol.name === "alpha"); const beta = analysis.code?.symbols.find((symbol) => symbol.name === "beta");
    expect(alpha?.symbolHash).toBeTruthy(); expect(alpha?.filePath).toBe("module.py"); expect(alpha?.lineRange).toEqual([1, 3]); expect(alpha?.symbolKind).toBe("function"); expect(beta?.symbolHash).toBeTruthy();
    await fs.mkdir(path.join(paths.wikiDir, "concepts"), { recursive: true });
    await fs.writeFile(path.join(paths.wikiDir, "concepts", "alpha.md"), matter.stringify("# Alpha\n\nDocuments alpha.", { title: "Alpha", page_id: "concept:alpha", kind: "concept", status: "active", freshness: "fresh", source_ids: [manifest.sourceId], symbol_hashes: [alpha?.symbolHash] }), "utf8");
    await fs.writeFile(path.join(paths.wikiDir, "concepts", "beta.md"), matter.stringify("# Beta\n\nDocuments beta.", { title: "Beta", page_id: "concept:beta", kind: "concept", status: "active", freshness: "fresh", source_ids: [manifest.sourceId], symbol_hashes: [beta?.symbolHash] }), "utf8");
    const graph = JSON.parse(await fs.readFile(paths.graphPath, "utf8")) as GraphArtifact;
    const pageBase = { kind: "concept" as const, sourceIds: [manifest.sourceId], projectIds: [], freshness: "fresh" as const, status: "active" as const, confidence: 1, backlinks: [], schemaHash: "", sourceHashes: {}, sourceSemanticHashes: {}, relatedPageIds: [], relatedNodeIds: [], relatedSourceIds: [], createdAt: "2026-05-13T21:58:00.000Z", updatedAt: "2026-05-13T21:58:00.000Z", compiledFrom: [manifest.sourceId], managedBy: "system" as const };
    graph.pages.push({ ...pageBase, id: "concept:alpha", path: "concepts/alpha.md", title: "Alpha", nodeIds: ["concept:alpha"] }, { ...pageBase, id: "concept:beta", path: "concepts/beta.md", title: "Beta", nodeIds: ["concept:beta"] });
    await fs.writeFile(paths.graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await fs.writeFile(sourcePath, ["def alpha():", "    value = 10", "    return value", "", "def beta():", "    value = 2", "    return value"].join("\n"), "utf8");
    const changes = await checkTrackedRepoChanges(rootDir, [repoDir]); expect(changes[0]?.changedLineRanges).toEqual([[2, 2]]); expect(changes[0]?.changedSymbolHashes).toEqual([alpha?.symbolHash]); expect(changes[0]?.stalePageIds).toContain("concept:alpha"); expect(changes[0]?.stalePageIds).not.toContain("concept:beta");
    const alphaPage = matter(await fs.readFile(path.join(paths.wikiDir, "concepts", "alpha.md"), "utf8")); const betaPage = matter(await fs.readFile(path.join(paths.wikiDir, "concepts", "beta.md"), "utf8"));
    expect(alphaPage.data.freshness).toBe("stale"); expect(betaPage.data.freshness).toBe("fresh");
  });
});
