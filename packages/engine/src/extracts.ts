import type { SourceAnalysis, SourceClaim, SourceManifest } from "./types.js";
import { normalizeWhitespace, sha256, toPosix } from "./utils.js";

export function normalizeClaimText(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

export function claimContentHash(input: { sourceFile: string; lineRange: [number, number]; text: string }): string {
  return sha256(`${input.sourceFile}:${input.lineRange[0]}-${input.lineRange[1]}:${normalizeClaimText(input.text)}`);
}

function sourceFileForClaim(manifest: SourceManifest): string {
  return toPosix(manifest.storedPath).replace(/^raw\//, "");
}

function lineRangeForClaim(text: string, claimText: string, searchFromLine: number): [number, number] {
  const lines = text.split(/\r?\n/);
  const normalizedClaim = normalizeClaimText(claimText);
  for (let index = Math.max(0, searchFromLine - 1); index < lines.length; index++) {
    const line = normalizeClaimText(lines[index] ?? "");
    if (line.includes(normalizedClaim) || normalizedClaim.includes(line)) return [index + 1, index + 1];
  }
  return [Math.max(1, searchFromLine), Math.max(1, searchFromLine)];
}

export function enrichClaimsWithHashes(claims: SourceClaim[], manifest: SourceManifest, sourceText: string | undefined): SourceClaim[] {
  const sourceFile = sourceFileForClaim(manifest);
  let nextSearchLine = 1;
  const text = sourceText ?? "";
  return claims.map((claim) => {
    const lineRange = claim.lineRange ?? lineRangeForClaim(text, claim.text, nextSearchLine);
    nextSearchLine = lineRange[1] + 1;
    return { ...claim, sourceFile: claim.sourceFile ?? sourceFile, lineRange, claimHash: claim.claimHash ?? claimContentHash({ sourceFile, lineRange, text: claim.text }) };
  });
}

export function enrichAnalysisClaimsWithHashes(analysis: SourceAnalysis, manifest: SourceManifest, sourceText: string | undefined): SourceAnalysis {
  return { ...analysis, claims: enrichClaimsWithHashes(analysis.claims, manifest, sourceText) };
}
