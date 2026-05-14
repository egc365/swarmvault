import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "./config.js";
import { registerHookSink } from "./hooks-core.js";
import { estimateTokens } from "./token-estimation.js";
import type { HookSink } from "./types.js";

export type HotCache = { content: string; pages: string[]; tokens: number };

const MAX_TOKENS = 500;
const STALE_MS = 60 * 60 * 1000;
const refreshQueues = new Map<string, Promise<HotCache>>();
async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function recentFiles(dir: string, limit = 8): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(entry.parentPath, entry.name);
        return { filePath, mtime: (await fs.stat(filePath)).mtimeMs };
      })
  );
  return files
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit)
    .map((entry) => entry.filePath);
}
function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}
async function readSnippet(filePath: string, rootDir: string): Promise<string> {
  const rel = path.relative(rootDir, filePath).replace(/\\/g, "/");
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return `- ${rel}`;
  return `- ${rel}: ${compact(raw)}`;
}
async function importantPages(wikiDir: string): Promise<string[]> {
  const files = await recentFiles(wikiDir, 200);
  const important: string[] = [];
  for (const filePath of files.filter((file) => file.endsWith(".md"))) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const data = matter(raw).data as { important?: unknown };
    if (data.important === true || data.important === "true") important.push(filePath);
  }
  return important.slice(0, 8);
}
function capContent(lines: string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    const next = [...kept, line].join("\n");
    if (estimateTokens(next) > MAX_TOKENS) break;
    kept.push(line);
  }
  return `${kept.join("\n").trimEnd()}\n`;
}
export async function buildHotCache(vaultRoot: string): Promise<HotCache> {
  const { paths } = await loadVaultConfig(vaultRoot);
  const buckets = [
    ["Recent Sessions", await recentFiles(paths.sessionsDir)],
    ["Recent Approvals", await recentFiles(paths.approvalsDir)],
    ["Recent Outputs", await recentFiles(path.join(paths.wikiDir, "outputs"))],
    ["Important Pages", await importantPages(paths.wikiDir)]
  ] as const;
  const pages = [...new Set(buckets.flatMap(([, files]) => files))];
  const lines = [
    "---",
    'type: "meta"',
    'title: "Hot Cache"',
    `updated: "${new Date().toISOString()}"`,
    "---",
    "",
    "# Recent Context",
    "",
    "Generated from recent sessions, approvals, outputs, and important pages.",
    ""
  ];
  for (const [title, files] of buckets) {
    lines.push(`## ${title}`);
    if (files.length === 0) lines.push("- None found.");
    for (const filePath of files) lines.push(await readSnippet(filePath, paths.rootDir));
    lines.push("");
  }
  const content = capContent(lines);
  await fs.mkdir(paths.wikiDir, { recursive: true });
  await fs.writeFile(path.join(paths.wikiDir, ".hot-cache.md"), content, "utf8");
  return { content, pages: pages.map((file) => path.relative(paths.rootDir, file).replace(/\\/g, "/")), tokens: estimateTokens(content) };
}
export async function refreshHotCacheIfStale(vaultRoot: string, opts: { now?: Date } = {}): Promise<HotCache | undefined> {
  const { paths } = await loadVaultConfig(vaultRoot);
  const cachePath = path.join(paths.wikiDir, ".hot-cache.md");
  const stat = await fs.stat(cachePath).catch(() => null);
  const now = opts.now?.getTime() ?? Date.now();
  if (stat && now - stat.mtimeMs < STALE_MS) return undefined;
  return buildHotCache(vaultRoot);
}
function queueRefresh(vaultRoot: string): Promise<HotCache> {
  const previous = refreshQueues.get(vaultRoot) ?? Promise.resolve(undefined as never);
  const next = previous.catch(() => undefined).then(() => buildHotCache(vaultRoot));
  refreshQueues.set(vaultRoot, next);
  return next;
}
export function createHotCacheHookSink(vaultRoot: string): HookSink {
  return async (event) => {
    if (event.eventName === "SessionStart") return void (await refreshHotCacheIfStale(vaultRoot));
    if (event.eventName === "OnApprovalAccept" || event.eventName === "OnCandidatePromote" || event.eventName === "OnOutputPromote") {
      await queueRefresh(vaultRoot);
    }
  };
}
export function attachHotCacheHookSink(vaultRoot: string): () => void {
  return registerHookSink(createHotCacheHookSink(vaultRoot));
}
