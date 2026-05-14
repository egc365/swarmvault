import matter from "gray-matter";
import type { CodeExtractSymbolKind, CodeSymbol, SourceAnalysis, SourceManifest } from "../types.js";

export type CodeSymbolTemplate = {
  kind: CodeExtractSymbolKind;
  sections: string[];
};

export const CODE_SYMBOL_TEMPLATES: Record<CodeExtractSymbolKind, CodeSymbolTemplate> = {
  function: { kind: "function", sections: ["Purpose", "Signature", "Calls", "Evidence"] },
  class: { kind: "class", sections: ["Responsibility", "Signature", "Inheritance", "Evidence"] },
  method: { kind: "method", sections: ["Purpose", "Receiver", "Calls", "Evidence"] },
  type: { kind: "type", sections: ["Shape", "Signature", "Relationships", "Evidence"] },
  constant: { kind: "constant", sections: ["Value Role", "Signature", "Consumers", "Evidence"] },
  module: { kind: "module", sections: ["Responsibility", "Imports", "Exports", "Evidence"] }
};

export function isPromotedCodeSymbol(symbol: CodeSymbol): boolean {
  return symbol.exported || symbol.symbolKind === "class" || symbol.symbolKind === "type" || symbol.kind === "table" || symbol.kind === "view";
}

export function renderCodeSymbolPage(input: {
  manifest: SourceManifest;
  analysis: SourceAnalysis;
  symbol: CodeSymbol;
  path: string;
  schemaHash: string;
  sourcePageId: string;
  modulePageId: string;
  createdAt: string;
  updatedAt: string;
  projectIds?: string[];
}): string {
  const { manifest, analysis, symbol } = input;
  const kind = symbol.symbolKind ?? "module";
  const title = `${symbol.name} (${kind})`;
  const body = [
    `# ${title}`,
    "",
    `Module: [[code/${manifest.sourceId}|${analysis.title}]]`,
    `Source: \`${symbol.filePath ?? manifest.repoRelativePath ?? manifest.originalPath ?? manifest.storedPath}\``,
    symbol.lineRange ? `Lines: \`${symbol.lineRange[0]}-${symbol.lineRange[1]}\`` : "",
    "",
    "## Purpose",
    "",
    analysis.summary,
    "",
    "## Signature",
    "",
    `\`\`\`${analysis.code?.language ?? ""}`,
    symbol.signature,
    "```",
    "",
    "## Relationships",
    "",
    ...(symbol.calls.length ? symbol.calls.map((item) => `- Calls \`${item}\``) : ["- No same-module calls detected."]),
    ...symbol.extends.map((item) => `- Extends \`${item}\``),
    ...symbol.implements.map((item) => `- Implements \`${item}\``),
    "",
    "## Evidence",
    "",
    `- Symbol hash: \`${symbol.symbolHash ?? ""}\``,
    `- Exported: \`${symbol.exported}\``,
    ""
  ].filter((line) => line !== "").join("\n");
  return matter.stringify(body, {
    page_id: symbol.id,
    kind: "symbol",
    title,
    tags: ["code", "symbol", kind],
    source_ids: [manifest.sourceId],
    project_ids: input.projectIds ?? [],
    node_ids: [symbol.id],
    freshness: "fresh",
    status: "active",
    confidence: symbol.exported ? 0.88 : 0.74,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    compiled_from: [manifest.sourceId],
    managed_by: "system",
    backlinks: [input.sourcePageId, input.modulePageId],
    schema_hash: input.schemaHash,
    symbol_hashes: symbol.symbolHash ? [symbol.symbolHash] : [],
    language: analysis.code?.language,
    symbol_kind: kind,
    repo_path: symbol.filePath,
    line_range: symbol.lineRange
  });
}
