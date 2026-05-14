import { randomUUID } from "node:crypto";
import path from "node:path";
import type { HookEvent, HookEventName, HookSink } from "./types.js";
import { appendJsonLine, sha256, slugify } from "./utils.js";

const sinks = new Set<HookSink>();

export function registerHookSink(sink: HookSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function clearHookSinks(): void {
  sinks.clear();
}

export function listHookSinks(): readonly HookSink[] {
  return [...sinks];
}

export function deriveVaultId(rootDir: string): string {
  const resolved = path.resolve(rootDir);
  const base = slugify(path.basename(resolved)) || "vault";
  return `${base}:${sha256(resolved).slice(0, 8)}`;
}

export function newSessionId(label = "session"): string {
  const safe = slugify(label) || "session";
  return `${safe}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function hooksLogPath(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), "state", "sessions", sessionId, "hooks.jsonl");
}

async function notifySinks(event: HookEvent): Promise<void> {
  if (sinks.size === 0) return;
  const handlers = [...sinks];
  await Promise.all(
    handlers.map(async (sink) => {
      try {
        await sink(event);
      } catch {
        // Sinks must not break the producer. Errors in subscribers are
        // intentionally swallowed; subscribers are responsible for their
        // own logging.
      }
    })
  );
}

export async function emitHookEvent(rootDir: string, event: HookEvent): Promise<void> {
  const logPath = hooksLogPath(rootDir, event.sessionId);
  try {
    // Per-session log paths are not shared across processes, so we don't
    // take a write lock here — matches Sprint 4's choice to leave
    // state/sessions/* writes unlocked.
    await appendJsonLine(logPath, event);
  } catch {
    // Persistence failures must not block engine work; sinks still fire.
  }
  await notifySinks(event);
}

export function buildEvent<TName extends HookEventName>(
  rootDir: string,
  sessionId: string,
  eventName: TName,
  payload: Extract<HookEvent, { eventName: TName }>["payload"]
): Extract<HookEvent, { eventName: TName }> {
  return {
    eventName,
    timestamp: new Date().toISOString(),
    vaultId: deriveVaultId(rootDir),
    sessionId,
    payload
  } as Extract<HookEvent, { eventName: TName }>;
}

export async function beginEngineSession(rootDir: string, trigger = "engine"): Promise<string> {
  const sessionId = newSessionId(trigger);
  const startedAt = new Date().toISOString();
  await emitHookEvent(rootDir, buildEvent(rootDir, sessionId, "SessionStart", { trigger, startedAt }));
  return sessionId;
}

export async function endEngineSession(
  rootDir: string,
  sessionId: string,
  trigger: string,
  startedAt: string,
  success: boolean,
  error?: string
): Promise<void> {
  await emitHookEvent(
    rootDir,
    buildEvent(rootDir, sessionId, "SessionEnd", {
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      success,
      error
    })
  );
}
