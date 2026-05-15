# Pipeline Integration

This directory is the integration layer that ties the four named components — **pipeline**, **base**, **wiki**, **compiler** — into one deterministic, audit-grade alpha-research-to-execution system. SwarmVault (this repo) is the **base + wiki**. The **compiler** is the document-structuring stage. The **pipeline** is the orchestrated chain that runs around them.

The work product in this folder is a **plan, a set of inter-stage contracts, and a corrected pipeline tree** — not running code yet. Everything here is designed so the next step is a one-week scaffold-to-green build.

## What lives here

| File | Purpose |
|---|---|
| `README.md` | This file. The plan and how the four components compose. |
| `ARCHITECTURE.md` | The full file tree, the data-flow diagram, and where each stage reads/writes on disk. |
| `EVALUATION.md` | Corrections to the original 9-layer tree, strengths, weaknesses, and the gaps the original was silent on. |
| `TOOLS.md` | Per-layer tool research with 2026 sources, primary pick, and why. No difficulty weighting — highest-yield data only. |
| `contracts/*.schema.json` | JSON Schemas for every inter-stage handoff. These are the actual contracts. |

## The four components, located

- **Base** — SwarmVault's `packages/engine` (TypeScript). Provides ingest, graph construction, hybrid search (SQLite FTS + embeddings), candidate review, MCP server. See `packages/engine/src/{ingest,graph-deterministic,retrieval,search,vault}.ts`.
- **Wiki** — SwarmVault's `wiki/` output convention. Markdown pages with frontmatter, claims tagged `extracted` / `inferred` / `ambiguous`, candidate queue, approval bundles. The wiki *is* the durable artifact.
- **Compiler** — Stage 2 of the pipeline (document → clean Markdown + metadata). SwarmVault ingests the compiler's output. The compiler is **outside** SwarmVault because it needs heavy native dependencies (Docling, MinerU, WhisperX). It writes into `raw/` so SwarmVault sees it as a normal input.
- **Pipeline** — The orchestrated chain in `stages/` driven by Dagster assets. Each stage reads a contract, writes a contract, and emits a run manifest.

## How the chain operates end-to-end

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Dagster asset graph (one DAG, asset-oriented, full lineage)         │
   └──┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────┘
      │        │        │        │        │        │        │        │
      ▼        ▼        ▼        ▼        ▼        ▼        ▼        ▼
   capture  compile  swarmvault feature  signal  portfolio execute  audit
   (1)      (2)      ingest+graph (4)    (5)     (6)       (7)      (9)
                     (3)
      │        │        │        │        │        │        │        │
      ▼        ▼        ▼        ▼        ▼        ▼        ▼        ▼
   01_cap   02_norm  03_ingest  04_feat 05_sig  06_target 07_order  99_run
   record   doc      manifest   row     row     weight    row       manifest
```

Each arrow is a **versioned Parquet (or JSON) file under a contract in `contracts/`**. Every row carries the `source_ids[]` and `run_id` needed to trace it back to the original capture in SwarmVault. The audit stage (9) doesn't transform data; it materializes the `99_run_manifest` and writes lineage to MLflow + DVC.

## Primary tool picks (highest-yield, no difficulty discount)

| Stage | Primary | Why (see `TOOLS.md` for full citations) |
|---|---|---|
| 1. Capture — text feeds | **Scrapy + feedparser + Scweet** | Mature crawler, RSS battle-tested, Scweet is the actively-maintained X scraper as of March 2026. |
| 1. Capture — audio/video | **WhisperX** (faster-whisper + pyannote 3.1) | Best DER (~10%) + word-level timestamps + diarization in one pipeline. |
| 2. Compile — PDF/docs | **Docling primary, MinerU fallback** | Docling 97.9% on complex tables; MinerU dominant on academic / CJK layouts. Run both, keep the higher-confidence output. |
| 3. Knowledge core — graph + wiki | **SwarmVault (this repo)** + **Neo4j Community via graph-push** | SwarmVault is the wiki + graph + retrieval. Neo4j receives the push for advanced Cypher queries. |
| 3. Knowledge core — vectors | **SwarmVault's existing hybrid (SQLite FTS + embeddings)** for wiki retrieval; **Qdrant** for feature-row filtered search | Qdrant is the explicit pick for legal/financial filtered search in 2026 benchmarks. SwarmVault's index stays for the wiki side. |
| 4. Features — lexicon | **pysentiment2 + custom LM loader** (Notre Dame SRAF master dictionary) | Loughran-McDonald is the academic gold standard for financial sentiment; the SRAF dictionary is the authoritative source. |
| 4. Features — NLP/NER | **spaCy + EntityRuler primary, Stanza secondary** | spaCy is the mature rule-based path; Stanza adds Stanford-grade NER as a cross-check. |
| 4. Features — statistical | **scikit-learn + tsfresh** | tsfresh extracts hundreds of statistical time-series features deterministically — this is the highest-yield path. |
| 4. Features — graph | **NetworkX (correctness) + igraph (scale)** | NetworkX for the reference centralities; igraph when the graph crosses ~100k nodes. |
| 4. Conviction | **Three framings computed in parallel** (z-score weighted sum, multiplicative, logistic / log-odds) | Industry-standard practice is to look at the same data multiple ways. The contract emits all three plus an ensemble. |
| 5. Signals | **NautilusTrader (live parity) + vectorbt (sweeps)** | NautilusTrader's Rust core gives nanosecond determinism and research-to-live parity; vectorbt sweeps parameters at NumPy speed. |
| 5. Signals — factor eval | **Alphalens** | IC, quantile analysis, tear sheets — the standard for evaluating raw factors before they hit the backtester. |
| 6. Portfolio | **Riskfolio-Lib primary + PyPortfolioOpt cross-check** | Riskfolio-Lib supports 13 risk measures (CVaR, EVaR, CDaR, HRP, HERC); PyPortfolioOpt is the conservative cross-check. |
| 6. Risk analytics | **empyrical + QuantStats** | empyrical for the core metrics, QuantStats for tearsheets. |
| 7. Execution | **NautilusTrader live adapters** (IB, Alpaca, ccxt under one interface) | Same engine as backtest = no code rewrite at the live boundary. |
| 8. Orchestration | **Dagster** | Asset-oriented, first-class lineage, partitioned assets — matches the contract-per-stage model exactly. |
| 9. Audit / versioning | **DVC (artifacts) + lakeFS (data lake) + MLflow (runs) + Pandera (validation)** | DVC for model/feature artifacts, lakeFS for the raw → curated lake with zero-copy branches, MLflow for params/metrics, Pandera for inline schema enforcement. |

## How it ties to SwarmVault specifically

- **Compiler writes to `raw/`.** SwarmVault's `ingest` already accepts markdown, PDFs, transcripts, code. Stage 2 emits normalized markdown into `raw/<source_type>/<source_id>.md` with frontmatter that satisfies SwarmVault's schema. No SwarmVault code changes required.
- **SwarmVault writes to `wiki/` and `state/graph.json`.** Stage 3 reads `state/graph.json` (machine-readable) for graph features and reads `wiki/` pages for entity/claim provenance.
- **Stage 4 emits `04_feature_row` Parquet** with every row carrying `source_ids[]` that point back to wiki pages and (where applicable) raw capture records. This is what makes the conviction score auditable in <1 click.
- **`graph-push` into Neo4j is already implemented** at `packages/engine/src/graph-push.ts`. Stage 3 reuses it for the Cypher-side feature path.
- **MCP server (`packages/engine/src/mcp.ts`) is already exposed.** Agents can query the wiki, candidates, and context packs without leaving Claude. The pipeline does not need its own MCP layer.

## Deferred decisions (called out for visibility)

1. **Python ↔ Node bridge.** SwarmVault is Node; everything from stage 4 onward is Python. The pipeline calls SwarmVault via its CLI (`swarmvault ingest`, `swarmvault graph export`) and reads its filesystem outputs. No in-process binding needed. See `stages/03_knowledge_core/README.md` in the architecture doc.
2. **Conviction weights.** Three framings are emitted; the *weights inside each framing* are tunable in `config/conviction.yml` and version-controlled with DVC.
3. **Execution gate.** Stage 7 is **off by default** with a paper-trading flag + kill-switch. Live trading requires an explicit per-run authorization in the orchestration config.
4. **Point-in-time correctness.** Every Parquet row carries `as_of_ts` (the wall-clock time the data was *available*) in addition to `event_ts`. Backtests filter on `as_of_ts <= bar_ts` to prevent look-ahead. This is missing from the original tree and is the single biggest correctness risk — covered in `EVALUATION.md`.

## Next step

Read `ARCHITECTURE.md` for the file tree and data flow, then `EVALUATION.md` for the diff against the original 9-layer outline. `TOOLS.md` has the citations for every primary pick.
