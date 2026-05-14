import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "./config.js";
import { withWriteLock } from "./locks.js";
import type { GraphArtifact, GraphPage, RetentionAccessRecord, RetentionScanResult, RetentionScore } from "./types.js";
import { appendJsonLine, ensureDir, fileExists, readJsonFile, writeJsonFile } from "./utils.js";

// Retention/decay scoring (Sprint 5).
//
// Score formula (0..1, lower = more decay-ready):
//   score = 0.45 * accessFactor + 0.35 * edgeFactor + 0.20 * ageFactor
// where
//   accessFactor = 1 if accessed within 30 days, decays linearly to 0 by 365 days, 0 thereafter
//   edgeFactor   = min(1, incomingEdgeCount / 3)  // 3+ incoming edges = full credit
//   ageFactor    = clamp(1 - (sourceAgeDays / 730), 0, 1)  // older than 2 years = 0
// `important: true` in frontmatter is an absolute override: score is forced to 1.0
// with reason "important_override", and the page is NEVER a candidate.
//
// Default threshold is 0.3 — anything strictly below is flagged as a
// retention candidate. Surface them via `swarmvault retention scan`.

const RETENTION_WEIGHTS = { access: 0.45, edges: 0.35, age: 0.2 } as const;
const ACCESS_FULL_DAYS = 30;
const ACCESS_DECAY_DAYS = 365;
const EDGE_FULL_COUNT = 3;
const SOURCE_AGE_HORIZON_DAYS = 730;
const DEFAULT_THRESHOLD = 0.3;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface RetentionScanOptions {
  threshold?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, (now - then) / MS_PER_DAY);
}

function retentionAccessLogPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), "state", "retention", "access-log.jsonl");
}

function retentionScanPath(rootDir: string, isoTimestamp: string): string {
  const safe = isoTimestamp.replace(/[:.]/g, "-");
  return path.join(path.resolve(rootDir), "state", "retention", `scan-${safe}.json`);
}

export async function recordPageAccess(rootDir: string, record: RetentionAccessRecord): Promise<void> {
  await recordPageAccessBatch(rootDir, [record]);
}

export async function recordPageAccessBatch(rootDir: string, records: RetentionAccessRecord[]): Promise<void> {
  if (records.length === 0) return;
  const logPath = retentionAccessLogPath(rootDir);
  await ensureDir(path.dirname(logPath));
  await withWriteLock(logPath, async () => {
    for (const record of records) {
      await appendJsonLine(logPath, record);
    }
  });
}

async function readAccessLog(rootDir: string): Promise<Map<string, string>> {
  const logPath = retentionAccessLogPath(rootDir);
  if (!(await fileExists(logPath))) return new Map();
  const raw = await fs.readFile(logPath, "utf8");
  const latest = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as RetentionAccessRecord;
      if (!entry || typeof entry.pageId !== "string" || typeof entry.queriedAt !== "string") continue;
      const existing = latest.get(entry.pageId);
      if (!existing || Date.parse(entry.queriedAt) > Date.parse(existing)) {
        latest.set(entry.pageId, entry.queriedAt);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return latest;
}

function incomingEdgeCounts(graph: GraphArtifact): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.target) continue;
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

async function pageMarkedImportant(wikiDir: string, page: GraphPage): Promise<boolean> {
  const filePath = path.join(wikiDir, page.path);
  if (!(await fileExists(filePath))) return false;
  try {
    const parsed = matter(await fs.readFile(filePath, "utf8"));
    return parsed.data?.important === true;
  } catch {
    return false;
  }
}

function accessFactor(lastAccessIso: string | undefined, createdAtIso: string | undefined, now: number): number {
  const accessDays = daysSince(lastAccessIso, now);
  const createdDays = daysSince(createdAtIso, now);
  // A brand-new page with no recorded access yet should not be treated as
  // decay-ready. Use the minimum of "days since last access" and "days
  // since creation" so new pages get a grace period equal to their age.
  const effectiveDays = accessDays === null ? (createdDays ?? null) : createdDays === null ? accessDays : Math.min(accessDays, createdDays);
  if (effectiveDays === null) return 0;
  if (effectiveDays <= ACCESS_FULL_DAYS) return 1;
  if (effectiveDays >= ACCESS_DECAY_DAYS) return 0;
  return 1 - (effectiveDays - ACCESS_FULL_DAYS) / (ACCESS_DECAY_DAYS - ACCESS_FULL_DAYS);
}

function edgeFactor(incomingEdges: number): number {
  return clamp01(incomingEdges / EDGE_FULL_COUNT);
}

function ageFactor(sourceAgeDays: number | null): number {
  if (sourceAgeDays === null) return 1;
  return clamp01(1 - sourceAgeDays / SOURCE_AGE_HORIZON_DAYS);
}

export interface ScoreRetentionInputs {
  page: GraphPage;
  incomingEdges: number;
  lastAccessIso?: string;
  isImportant: boolean;
  now: number;
}

export function computeRetentionScore(inputs: ScoreRetentionInputs): RetentionScore {
  const { page, incomingEdges, lastAccessIso, isImportant, now } = inputs;
  if (isImportant) {
    return {
      pageId: page.id,
      score: 1,
      reasons: ["important_override"]
    };
  }
  const aDays = daysSince(lastAccessIso, now);
  const sourceAgeDays = daysSince(page.createdAt, now);
  const fAccess = accessFactor(lastAccessIso, page.createdAt, now);
  const fEdges = edgeFactor(incomingEdges);
  const fAge = ageFactor(sourceAgeDays);
  const score = clamp01(RETENTION_WEIGHTS.access * fAccess + RETENTION_WEIGHTS.edges * fEdges + RETENTION_WEIGHTS.age * fAge);
  const reasons: string[] = [];
  if (aDays === null) reasons.push("no_recorded_access");
  else if (aDays > ACCESS_DECAY_DAYS) reasons.push(`stale_access_${Math.round(aDays)}d`);
  else reasons.push(`access_${Math.round(aDays)}d`);
  reasons.push(`incoming_edges_${incomingEdges}`);
  if (sourceAgeDays !== null) reasons.push(`source_age_${Math.round(sourceAgeDays)}d`);
  return { pageId: page.id, score, reasons };
}

export async function scoreRetention(rootDir: string, pageId: string): Promise<RetentionScore> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = (await readJsonFile<GraphArtifact>(paths.graphPath)) ?? {
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    hyperedges: [],
    sources: [],
    pages: []
  };
  const page = graph.pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new Error(`Page not found: ${pageId}`);
  }
  const accessLog = await readAccessLog(rootDir);
  const counts = incomingEdgeCounts(graph);
  const isImportant = await pageMarkedImportant(paths.wikiDir, page);
  return computeRetentionScore({
    page,
    incomingEdges: counts.get(page.id) ?? 0,
    lastAccessIso: accessLog.get(page.id),
    isImportant,
    now: Date.now()
  });
}

export async function scanRetention(rootDir: string, options: RetentionScanOptions = {}): Promise<RetentionScanResult> {
  const threshold = typeof options.threshold === "number" ? options.threshold : DEFAULT_THRESHOLD;
  const { paths } = await loadVaultConfig(rootDir);
  const graph = (await readJsonFile<GraphArtifact>(paths.graphPath)) ?? {
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    hyperedges: [],
    sources: [],
    pages: []
  };
  const accessLog = await readAccessLog(rootDir);
  const counts = incomingEdgeCounts(graph);
  const now = Date.now();
  const scores: RetentionScore[] = [];
  for (const page of graph.pages) {
    const isImportant = await pageMarkedImportant(paths.wikiDir, page);
    const score = computeRetentionScore({
      page,
      incomingEdges: counts.get(page.id) ?? 0,
      lastAccessIso: accessLog.get(page.id),
      isImportant,
      now
    });
    scores.push(score);
  }
  const candidates = scores
    .filter((entry) => entry.score < threshold && !entry.reasons.includes("important_override"))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      return left.pageId.localeCompare(right.pageId);
    });
  const generatedAt = new Date().toISOString();
  const result: RetentionScanResult = {
    generatedAt,
    threshold,
    scanned: graph.pages.length,
    candidates
  };
  const scanFile = retentionScanPath(rootDir, generatedAt);
  await ensureDir(path.dirname(scanFile));
  await writeJsonFile(scanFile, result);
  return result;
}

export const RETENTION_DEFAULTS = {
  threshold: DEFAULT_THRESHOLD,
  weights: RETENTION_WEIGHTS,
  accessFullDays: ACCESS_FULL_DAYS,
  accessDecayDays: ACCESS_DECAY_DAYS,
  edgeFullCount: EDGE_FULL_COUNT,
  sourceAgeHorizonDays: SOURCE_AGE_HORIZON_DAYS
} as const;
