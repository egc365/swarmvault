import { buildEvent, emitHookEvent, newSessionId } from "../hooks-core.js";
import { type OutputPromotionResult, promoteOutput as promoteOutputRaw } from "../output-promotion.js";
import type { CandidateRecord, ReviewActionResult } from "../types.js";
import {
  acceptApproval as acceptApprovalRaw,
  archiveCandidate as archiveCandidateRaw,
  promoteCandidate as promoteCandidateRaw,
  readApproval,
  rejectApproval as rejectApprovalRaw
} from "../vault.js";

// Outside-wrappers for lifecycle points whose underlying files are
// fenced this sprint (output-promotion.ts) or whose executors must not
// be modified in-place (approvals, candidate-promotion). Each wrapper
// emits a HookEvent (OnApprovalAccept / OnApprovalReject /
// OnCandidatePromote / OnCandidateArchive / OnOutputPromote) around an
// unchanged call to the raw function.

export async function acceptApprovalWithHooks(rootDir: string, approvalId: string, targets: string[] = []): Promise<ReviewActionResult> {
  const sessionId = newSessionId("approval-accept");
  const detail = await readApproval(rootDir, approvalId, { diff: false }).catch(() => null);
  const entries = detail?.entries ?? [];
  const result = await acceptApprovalRaw(rootDir, approvalId, targets);
  await emitHookEvent(rootDir, buildEvent(rootDir, sessionId, "OnApprovalAccept", { approvalId, entries }));
  return result;
}

export async function rejectApprovalWithHooks(rootDir: string, approvalId: string, targets: string[] = []): Promise<ReviewActionResult> {
  const sessionId = newSessionId("approval-reject");
  const detail = await readApproval(rootDir, approvalId, { diff: false }).catch(() => null);
  const entries = detail?.entries ?? [];
  const result = await rejectApprovalRaw(rootDir, approvalId, targets);
  await emitHookEvent(rootDir, buildEvent(rootDir, sessionId, "OnApprovalReject", { approvalId, entries }));
  return result;
}

export async function promoteCandidateWithHooks(rootDir: string, target: string): Promise<CandidateRecord> {
  const sessionId = newSessionId("candidate-promote");
  const result = await promoteCandidateRaw(rootDir, target);
  await emitHookEvent(
    rootDir,
    buildEvent(rootDir, sessionId, "OnCandidatePromote", {
      pageId: result.pageId,
      fromPath: result.path,
      toPath: result.activePath,
      kind: result.kind
    })
  );
  return result;
}

export async function archiveCandidateWithHooks(rootDir: string, target: string): Promise<CandidateRecord> {
  const sessionId = newSessionId("candidate-archive");
  const result = await archiveCandidateRaw(rootDir, target);
  await emitHookEvent(
    rootDir,
    buildEvent(rootDir, sessionId, "OnCandidateArchive", {
      pageId: result.pageId,
      fromPath: result.path,
      kind: result.kind
    })
  );
  return result;
}

export async function promoteOutputWithHooks(
  rootDir: string,
  slug: string,
  options: { into?: string } = {}
): Promise<OutputPromotionResult> {
  const sessionId = newSessionId("output-promote");
  const result = await promoteOutputRaw(rootDir, slug, options);
  await emitHookEvent(
    rootDir,
    buildEvent(rootDir, sessionId, "OnOutputPromote", {
      outputSlug: result.outputSlug,
      outputPath: result.outputPath,
      conceptPageId: result.pageId,
      conceptPath: result.path,
      sourceIds: result.sourceIds,
      merged: result.merged
    })
  );
  return result;
}
