import { describe, expect, it } from "vitest";
import { detectContradictions, findSupersessionCandidates, loadGraphIntoStore, walkSupersessionChain } from "../src/index.js";
import type { GraphArtifact } from "../src/types.js";

function graph(edges: GraphArtifact["edges"] = []): GraphArtifact {
  const now = new Date(0).toISOString();
  const pages = ["old", "mid", "new", "dependent"].map((id) => ({
    id,
    path: `${id}.md`,
    title: id,
    kind: "source" as const,
    sourceIds: [],
    projectIds: [],
    nodeIds: [],
    freshness: id === "old" ? ("stale" as const) : ("fresh" as const),
    status: "active" as const,
    confidence: 1,
    backlinks: [],
    schemaHash: "",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: now,
    updatedAt: now,
    compiledFrom: [],
    managedBy: "system" as const
  }));
  return { generatedAt: now, nodes: [], edges, hyperedges: [], sources: [], pages };
}

describe("deterministic graph reasoning", () => {
  it("detects structural contradictions from superseded dependencies", () => {
    const store = loadGraphIntoStore(
      graph([
        {
          id: "new->old",
          source: "new",
          target: "old",
          relation: "supersedes",
          status: "inferred",
          evidenceClass: "inferred",
          confidence: 1,
          provenance: []
        },
        {
          id: "dep->old",
          source: "dependent",
          target: "old",
          relation: "dependsOn",
          status: "inferred",
          evidenceClass: "inferred",
          confidence: 1,
          provenance: []
        }
      ])
    );

    expect(detectContradictions(store)).toEqual([
      expect.objectContaining({ supersededId: "old", supersederId: "new", dependentId: "dependent" })
    ]);
    expect(findSupersessionCandidates(store)).toEqual([{ pageId: "old", supersededBy: "new", dependentIds: ["dependent"] }]);
  });

  it("walks supersession chains in both directions", () => {
    const store = loadGraphIntoStore(
      graph([
        {
          id: "mid->old",
          source: "mid",
          target: "old",
          relation: "supersedes",
          status: "inferred",
          evidenceClass: "inferred",
          confidence: 1,
          provenance: []
        },
        {
          id: "new->mid",
          source: "new",
          target: "mid",
          relation: "supersedes",
          status: "inferred",
          evidenceClass: "inferred",
          confidence: 1,
          provenance: []
        }
      ])
    );

    expect(walkSupersessionChain(store, "mid")).toEqual({ predecessors: ["old"], successors: ["new"] });
  });

  it("treats an empty graph as a no-op", () => {
    const store = loadGraphIntoStore({ ...graph(), pages: [] });
    expect(detectContradictions(store)).toEqual([]);
    expect(findSupersessionCandidates(store)).toEqual([]);
    expect(walkSupersessionChain(store, "missing")).toEqual({ predecessors: [], successors: [] });
  });
});
