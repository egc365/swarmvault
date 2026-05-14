import path from "node:path";
import { registerHookSink } from "../hooks-core.js";
import type { HookEvent, HookSink } from "../types.js";
import { appendJsonLine } from "../utils.js";

// In-process adapter that subscribes to the unified core hook stream
// (hooks-core.ts) and translates events into the Claude-Code wire shape
// — the same `{hookSpecificOutput: {hookEventName, additionalContext}}`
// envelope the standalone .claude/hooks/swarmvault-graph-first.js script
// emits to stdout. The standalone script remains the canonical Claude
// Code stdin/stdout adapter and is intentionally not modified here
// (per its top-of-file "must not import from engine code" constraint).
// This adapter is the engine-side producer of the same shape, so any
// in-process consumer (tests, MCP server, future cross-process bridge)
// can read a Claude-Code-shaped stream sourced from engine events.

export type ClaudeCodeHookOutput = {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext?: string;
  };
  timestamp: string;
  vaultId: string;
  sessionId: string;
  origin: HookEvent["eventName"];
};

function translate(event: HookEvent): ClaudeCodeHookOutput | null {
  const base = {
    timestamp: event.timestamp,
    vaultId: event.vaultId,
    sessionId: event.sessionId,
    origin: event.eventName
  };
  switch (event.eventName) {
    case "SessionStart":
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `engine session ${event.payload.trigger} started at ${event.payload.startedAt}`
        }
      };
    case "SessionEnd":
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "SessionEnd",
          additionalContext: `engine session ${event.payload.trigger} ${event.payload.success ? "finished" : "failed"}`
        }
      };
    case "PreCompile":
    case "PreQuery":
    case "PreIngest":
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `engine ${event.eventName}`
        }
      };
    case "PostCompile":
    case "PostQuery":
    case "PostIngest":
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `engine ${event.eventName}`
        }
      };
    case "OnApprovalAccept":
    case "OnApprovalReject":
    case "OnCandidatePromote":
    case "OnCandidateArchive":
    case "OnOutputPromote":
      return {
        ...base,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `engine ${event.eventName}`
        }
      };
    default:
      return null;
  }
}

function claudeAdapterLogPath(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), "state", "sessions", sessionId, "claude-hooks.jsonl");
}

export function createClaudeAdapterSink(rootDir: string): HookSink {
  return async (event) => {
    const translated = translate(event);
    if (!translated) return;
    await appendJsonLine(claudeAdapterLogPath(rootDir, event.sessionId), translated);
  };
}

export function attachClaudeAdapter(rootDir: string): () => void {
  return registerHookSink(createClaudeAdapterSink(rootDir));
}
