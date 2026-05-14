import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestDirectory, initVault, loadVaultConfig, reindexCodeWiki } from "../../src/index.js";
import type { CodeIndexArtifact } from "../../src/types.js";

const tempDirs: string[] = [];
async function tmp(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-code-flow-")); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("code ingest flow", () => {
  it("builds hybrid code wiki pages and symbol state for a repo", async () => {
    const rootDir = await tmp(); await initVault(rootDir); const repo = path.join(rootDir, "repo"); await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "package.json"), "{\"name\":\"fixture\",\"type\":\"module\"}\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "math.ts"), "export function add(a:number,b:number){return a+b}\nexport const PI=3.14\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "box.ts"), "export class Box{ constructor(public value:number){} }\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "types.ts"), "export type Id = string\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "internal.ts"), "function hidden(){return 1}\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "index.ts"), "export { add } from './math.js'\nexport { Box } from './box.js'\n", "utf8");
    await ingestDirectory(rootDir, repo, { repoRoot: repo }); await reindexCodeWiki(rootDir);
    const { paths } = await loadVaultConfig(rootDir); const codeFiles = (await fs.readdir(path.join(paths.wikiDir, "code"))).filter((file) => file.endsWith(".md") && file !== "index.md");
    const symbolFiles = await fs.readdir(path.join(paths.wikiDir, "code", "symbols"));
    expect(codeFiles.length).toBe(5); expect(symbolFiles.some((file) => file.includes("add"))).toBe(true); expect(symbolFiles.some((file) => file.includes("hidden"))).toBe(false);
    const codeIndex = JSON.parse(await fs.readFile(paths.codeIndexPath, "utf8")) as CodeIndexArtifact;
    expect(codeIndex.entries).toHaveLength(5); expect(codeIndex.entries.flatMap((entry) => entry.symbols ?? []).map((symbol) => symbol.name).sort()).toEqual(["Box", "Id", "PI", "add", "hidden"].sort());
    const symbolState = JSON.parse(await fs.readFile(path.join(paths.stateDir, "code-symbols.json"), "utf8")) as { symbols: Array<{ name: string; promoted: boolean }> };
    expect(symbolState.symbols).toHaveLength(5); expect(symbolState.symbols.find((symbol) => symbol.name === "hidden")?.promoted).toBe(false);
  });
});
