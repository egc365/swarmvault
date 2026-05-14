import * as ox from "oxigraph";
import type { GraphArtifact, GraphEdge, GraphPage } from "./types.js";

const CORTEX = "https://cortex.abbacus.ai/ontology#";
const SV = "https://swarmvault.ai/graph#";
const PREFIXES = `PREFIX cortex: <${CORTEX}>\nPREFIX sv: <${SV}>\n`;

export interface ContradictionPair {
  supersededId: string;
  supersederId: string;
  dependentId: string;
  supersededTitle?: string;
  supersederTitle?: string;
  dependentTitle?: string;
}

export interface SupersessionCandidate {
  pageId: string;
  supersededBy: string;
  dependentIds: string[];
}

function iri(id: string): ox.NamedNode {
  return ox.namedNode(`${SV}${encodeURIComponent(id)}`);
}

function text(value: unknown): ox.Literal {
  return ox.literal(String(value ?? ""));
}

function idFromTerm(term: ox.Term | undefined): string {
  return term?.value.startsWith(SV) ? decodeURIComponent(term.value.slice(SV.length)) : (term?.value ?? "");
}

function rows(store: ox.Store, sparql: string): Map<string, ox.Term>[] {
  const result = store.query(`${PREFIXES}${sparql}`);
  return Array.isArray(result) ? (result as Map<string, ox.Term>[]) : [];
}

function addPage(store: ox.Store, page: GraphPage): void {
  const subject = iri(page.id);
  store.add(ox.triple(subject, ox.namedNode(`${CORTEX}title`), text(page.title)));
  store.add(ox.triple(subject, ox.namedNode(`${CORTEX}path`), text(page.path)));
  store.add(ox.triple(subject, ox.namedNode(`${CORTEX}kind`), text(page.kind)));
  if (page.supersededBy) {
    store.add(ox.triple(iri(page.supersededBy), ox.namedNode(`${CORTEX}supersedes`), subject));
  }
}

function addEdge(store: ox.Store, edge: GraphEdge): void {
  if (edge.relation === "superseded_by" || edge.relation === "supersededBy") {
    store.add(ox.triple(iri(edge.target), ox.namedNode(`${CORTEX}supersedes`), iri(edge.source)));
    return;
  }
  const rel = edge.relation === "depends_on" ? "dependsOn" : edge.relation;
  if (["contradicts", "dependsOn", "supersedes"].includes(rel)) {
    store.add(ox.triple(iri(edge.source), ox.namedNode(`${CORTEX}${rel}`), iri(edge.target)));
  }
}

export function loadGraphIntoStore(graphJson: GraphArtifact | string): ox.Store {
  const graph = typeof graphJson === "string" ? (JSON.parse(graphJson) as GraphArtifact) : graphJson;
  const store = new ox.Store();
  for (const page of graph.pages ?? []) addPage(store, page);
  for (const node of graph.nodes ?? []) {
    if (!node.pageId) continue;
    store.add(ox.triple(iri(node.id), ox.namedNode(`${CORTEX}pageId`), iri(node.pageId)));
    store.add(ox.triple(iri(node.pageId), ox.namedNode(`${CORTEX}nodeId`), iri(node.id)));
  }
  for (const edge of graph.edges ?? []) addEdge(store, edge);
  return store;
}

export function detectContradictions(store: ox.Store): ContradictionPair[] {
  return rows(
    store,
    `SELECT DISTINCT ?old ?new ?dep ?oldTitle ?newTitle ?depTitle WHERE {
      ?new cortex:supersedes ?old .
      ?dep cortex:dependsOn ?old .
      OPTIONAL { ?old cortex:title ?oldTitle }
      OPTIONAL { ?new cortex:title ?newTitle }
      OPTIONAL { ?dep cortex:title ?depTitle }
    } ORDER BY ?old ?dep ?new`
  ).map((row) => ({
    supersededId: idFromTerm(row.get("old")),
    supersederId: idFromTerm(row.get("new")),
    dependentId: idFromTerm(row.get("dep")),
    supersededTitle: row.get("oldTitle")?.value,
    supersederTitle: row.get("newTitle")?.value,
    dependentTitle: row.get("depTitle")?.value
  }));
}

export function findSupersessionCandidates(store: ox.Store): SupersessionCandidate[] {
  const grouped = new Map<string, SupersessionCandidate>();
  for (const row of rows(
    store,
    `SELECT DISTINCT ?old ?new ?dep WHERE {
      ?new cortex:supersedes ?old .
      OPTIONAL { ?dep cortex:dependsOn ?old }
    } ORDER BY ?old ?new ?dep`
  )) {
    const pageId = idFromTerm(row.get("old"));
    const supersededBy = idFromTerm(row.get("new"));
    const key = `${pageId}\0${supersededBy}`;
    const item = grouped.get(key) ?? { pageId, supersededBy, dependentIds: [] };
    const dependentId = idFromTerm(row.get("dep"));
    if (dependentId && !item.dependentIds.includes(dependentId)) item.dependentIds.push(dependentId);
    grouped.set(key, item);
  }
  return [...grouped.values()];
}

export function walkSupersessionChain(store: ox.Store, pageId: string): { predecessors: string[]; successors: string[] } {
  const collect = (sparql: string) => rows(store, sparql).map((row) => idFromTerm(row.get("page")));
  const page = `<${SV}${encodeURIComponent(pageId)}>`;
  return {
    predecessors: collect(`SELECT DISTINCT ?page WHERE { ${page} cortex:supersedes+ ?page } ORDER BY ?page`),
    successors: collect(`SELECT DISTINCT ?page WHERE { ?page cortex:supersedes+ ${page} } ORDER BY ?page`)
  };
}
