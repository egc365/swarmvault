# Architecture — File Tree, Contracts, and Data Flow

This document is the source of truth for **how data moves through the pipeline**. The file tree shows where every artifact lives. The contracts (in `contracts/`) define the wire format between stages. The data-flow diagram shows the order, fan-out, and feedback loops.

## 1. The file tree

```
swarmvault/                                  # this repo
├── packages/                                # SwarmVault — the BASE + WIKI engine
│   ├── engine/                              #   ingest, graph, retrieval, mcp
│   ├── cli/                                 #   `swarmvault ...` commands
│   ├── viewer/                              #   local graph workspace
│   └── obsidian-plugin/                     #   editor integration
│
├── pipeline/                                # THIS DIRECTORY — the integration layer
│   ├── README.md                            #   plan, primary tool picks, how it ties together
│   ├── ARCHITECTURE.md                      #   THIS FILE — file tree + data flow
│   ├── EVALUATION.md                        #   corrections + strengths/weaknesses
│   ├── TOOLS.md                             #   tool selection rationale + 2026 sources
│   │
│   ├── contracts/                           #   THE CONTRACTS — JSON Schemas
│   │   ├── 01_capture_record.schema.json    #     raw capture from scrubber/transcriber
│   │   ├── 02_normalized_doc.schema.json    #     compiler output (markdown + frontmatter)
│   │   ├── 03_swarmvault_ingest_manifest.schema.json   # what SwarmVault wrote to wiki/graph
│   │   ├── 04_feature_row.schema.json       #     deterministic feature row (Parquet schema)
│   │   ├── 05_conviction_row.schema.json    #     conviction row (three framings + ensemble)
│   │   ├── 06_signal_row.schema.json        #     backtester output: signal + factor attribution
│   │   ├── 07_target_weight.schema.json     #     optimizer output: target weights + constraints
│   │   ├── 08_order.schema.json             #     execution layer: orders sent/filled
│   │   └── 99_run_manifest.schema.json      #     audit envelope tying everything to one run_id
│   │
│   ├── stages/                              #   one folder per pipeline stage
│   │   ├── 01_capture/                      #     Scrapy + feedparser + Scweet + WhisperX
│   │   ├── 02_compile/                      #     Docling primary, MinerU fallback
│   │   ├── 03_knowledge_core/               #     thin Python wrapper that drives `swarmvault` CLI
│   │   ├── 04_features/                     #     pysentiment2 + spaCy + tsfresh + NetworkX
│   │   ├── 05_signals/                      #     NautilusTrader + vectorbt + Alphalens
│   │   ├── 06_portfolio/                    #     Riskfolio-Lib + PyPortfolioOpt cross-check
│   │   ├── 07_execution/                    #     NautilusTrader live adapters (kill-switch gated)
│   │   ├── 08_orchestration/                #     Dagster asset graph (the wiring)
│   │   └── 09_audit/                        #     DVC + lakeFS + MLflow + Pandera validators
│   │
│   └── config/
│       ├── pipeline.yml                     #   run cadence, source list, paper-trade flag
│       └── conviction.yml                   #   weights for each of the 3 conviction framings
│
├── raw/                                     # SwarmVault input layer — immutable
│   ├── x/                                   #   tweets (one .md per thread, frontmatter)
│   ├── rss/                                 #   feed items
│   ├── transcripts/                         #   WhisperX output (md with diarization)
│   ├── papers/                              #   Docling/MinerU output
│   └── manifests/                           #   01_capture_record.json + 02_normalized_doc.json
│
├── wiki/                                    # SwarmVault output layer — durable
│   ├── sources/                             #   one page per ingested source
│   ├── entities/                            #   typed entity pages (ticker, person, concept, …)
│   ├── candidates/                          #   not-yet-promoted graph extractions
│   ├── claims/                              #   typed claims w/ extracted|inferred|ambiguous
│   └── graph/                               #   share-card, report, exports
│
├── state/                                   # SwarmVault internals — machine-readable
│   ├── graph.json                           #   the knowledge graph
│   └── retrieval/                           #   SQLite FTS + embeddings
│
└── pipeline_data/                           # Pipeline artifacts (NEW — gitignored, DVC-tracked)
    ├── features/                            #   04_feature_row Parquet, partitioned by date
    ├── conviction/                          #   05_conviction_row Parquet
    ├── signals/                             #   06_signal_row Parquet
    ├── weights/                             #   07_target_weight Parquet
    ├── orders/                              #   08_order Parquet (paper/live segregated)
    ├── runs/                                 #   99_run_manifest.json per run_id
    └── mlruns/                              #   MLflow tracking dir
```

**Key invariant:** every file under `pipeline_data/` carries a `run_id` and `source_ids[]` so any row can be traced back to (a) the run that produced it and (b) the raw capture(s) that justified it. This is what makes the pipeline auditable.

## 2. The data-flow diagram

```
                            ┌──────────────────────────────────────────────────┐
                            │                  Dagster (8)                     │
                            │  schedules + asset graph + lineage + retries     │
                            └──────────────────────────────────────────────────┘
                                                  │
                                  scheduled 6×/day (or event-driven)
                                                  ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 1 — CAPTURE                                                                  │
   │   Scrapy (web) + feedparser (RSS) + Scweet (X) + yt-dlp (audio/video)             │
   │   ──→ WhisperX (audio→text + diarization)                                          │
   │   writes: raw/{x,rss,transcripts,papers}/<source_id>.{md,json}                     │
   │   contract: 01_capture_record.schema.json                                          │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 2 — COMPILE (the "compiler")                                                 │
   │   Docling (primary) + MinerU (fallback for academic/CJK)                           │
   │   keeps the higher-confidence output; emits clean markdown + table JSON           │
   │   writes: raw/papers/<source_id>.md + raw/manifests/02_normalized_doc.json         │
   │   contract: 02_normalized_doc.schema.json                                          │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 3 — KNOWLEDGE CORE (the "base + wiki" — SwarmVault)                          │
   │   Python wrapper calls `swarmvault ingest` then `swarmvault compile`               │
   │   SwarmVault writes: wiki/{sources,entities,candidates,claims}/ + state/graph.json │
   │   `swarmvault graph push` mirrors to Neo4j for Cypher access                       │
   │   Qdrant collection for feature-row filtered semantic retrieval (separate from     │
   │     SwarmVault's own hybrid index, which stays for the wiki side)                  │
   │   writes: state/graph.json (SwarmVault) + 03_swarmvault_ingest_manifest.json       │
   │   contract: 03_swarmvault_ingest_manifest.schema.json                              │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 4 — FEATURES & CONVICTION (deterministic; no generative models)              │
   │                                                                                    │
   │   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                  │
   │   │ Lexicon     │ │ NLP / NER   │ │ Statistical │ │ Graph       │                  │
   │   │ pysentiment │ │ spaCy +     │ │ scikit-learn│ │ NetworkX +  │                  │
   │   │ + LM master │ │ Stanza      │ │ + tsfresh   │ │ igraph      │                  │
   │   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘                  │
   │          └──────────────┬┴───────────────┴───────────────┘                          │
   │                         ▼                                                          │
   │   feature_row Parquet  (one row per (entity, as_of_ts))                            │
   │   contract: 04_feature_row.schema.json                                             │
   │                         ▼                                                          │
   │   Conviction layer — THREE framings computed in parallel:                          │
   │     (a) z-score weighted sum     (b) multiplicative (legacy)                       │
   │     (c) logistic / log-odds      + (d) ensemble of a/b/c                           │
   │   contract: 05_conviction_row.schema.json                                          │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 5 — SIGNALS (research-to-live parity)                                        │
   │   Alphalens IC / quantile / tear-sheet on raw features (research gate)             │
   │   vectorbt for parameter sweeps (research)                                         │
   │   NautilusTrader for event-driven backtest + live (production)                     │
   │   writes: signal_row Parquet                                                       │
   │   contract: 06_signal_row.schema.json                                              │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 6 — PORTFOLIO                                                                │
   │   Riskfolio-Lib (HRP, HERC, CVaR, EVaR — 13 risk measures) primary                 │
   │   PyPortfolioOpt cross-check (Black-Litterman, mean-variance)                      │
   │   empyrical + QuantStats for ex-post analytics                                     │
   │   writes: target_weight Parquet                                                    │
   │   contract: 07_target_weight.schema.json                                           │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 7 — EXECUTION (DEFAULT: PAPER. Live requires per-run authorization.)         │
   │   NautilusTrader live adapters: IB / Alpaca / ccxt under one interface             │
   │   Pre-trade risk gate (drawdown, concentration, kill-switch)                       │
   │   writes: order Parquet + fill events                                              │
   │   contract: 08_order.schema.json                                                   │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 9 — AUDIT (the envelope; doesn't transform data)                             │
   │   Pandera schema validation runs at every stage boundary (fail-fast)               │
   │   DVC pins feature/signal/weight artifacts to the run_id                           │
   │   lakeFS branches for raw → curated zero-copy reproducibility                      │
   │   MLflow logs params + metrics + artifacts per run                                 │
   │   structlog → Prometheus → Grafana for live observability                          │
   │   writes: runs/<run_id>/99_run_manifest.json                                       │
   │   contract: 99_run_manifest.schema.json                                            │
   └───────────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ FEEDBACK LOOP (missing from original tree — added here)                            │
   │   QuantStats results from Stage 6 → conviction weight calibration in `config/conviction.yml`
   │   Drift detection on Stage 4 features → triggers re-ingest in Stage 1              │
   │   Approval queue (SwarmVault `wiki/candidates/`) → human-in-the-loop for new entities│
   └───────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Stage-by-stage contracts cheat-sheet

| Stage | Reads | Writes | Contract |
|---|---|---|---|
| 1. Capture | source list (`config/pipeline.yml`) | `raw/**/*.{md,json}` | `01_capture_record` |
| 2. Compile | `raw/papers/**/*.pdf` and similar | `raw/papers/**/*.md`, `raw/manifests/*.json` | `02_normalized_doc` |
| 3. Knowledge core | `raw/`, SwarmVault config | `wiki/`, `state/graph.json`, Neo4j, Qdrant | `03_swarmvault_ingest_manifest` |
| 4. Features | `state/graph.json`, `wiki/`, Qdrant | `pipeline_data/features/`, `pipeline_data/conviction/` | `04_feature_row`, `05_conviction_row` |
| 5. Signals | `pipeline_data/conviction/`, market data | `pipeline_data/signals/` | `06_signal_row` |
| 6. Portfolio | `pipeline_data/signals/` | `pipeline_data/weights/` | `07_target_weight` |
| 7. Execution | `pipeline_data/weights/`, broker session | `pipeline_data/orders/` | `08_order` |
| 8. Orchestration | all of the above (asset graph) | scheduler events, retries | — |
| 9. Audit | all of the above | `pipeline_data/runs/<run_id>/`, DVC, MLflow, lakeFS | `99_run_manifest` |

## 4. Two non-negotiable invariants

### a. Point-in-time correctness

Every row in every stage carries **two** timestamps:

- `event_ts` — when the underlying event happened (tweet posted, paper published, bar closed).
- `as_of_ts` — when this pipeline first had the data available.

Backtests in stage 5 **must** filter on `as_of_ts <= simulated_now` rather than `event_ts`. The original tree was silent on this; without it, every backtest is contaminated by look-ahead bias.

### b. Full source provenance

Every conviction score, every signal, every order carries a `source_ids: string[]` array. Those IDs index into SwarmVault's wiki pages, which index into the raw capture records. The chain is:

```
order.run_id → run_manifest
            → target_weight.signal_id
            → signal.conviction_id
            → conviction.feature_ids
            → feature.source_ids[]
            → wiki/sources/<id>.md
            → raw/<source_type>/<source_id>.{md,json}
```

A regulator (or you) can walk that chain in <1 second per hop.
