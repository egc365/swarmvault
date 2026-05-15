# Evaluation — Corrections, Strengths, Weaknesses

This document does three things:
1. **Corrects** the original 9-layer tree (specific deltas, not vibes).
2. Calls out the **strengths** that should be preserved.
3. Calls out the **weaknesses and silent gaps**, with a concrete fix for each.

## 1. Corrections to the original tree

| Original layer | Issue | Correction |
|---|---|---|
| 1. Multi-Source Intelligence Capture — "twscrape" | twscrape still works but **Scweet** is the actively-maintained option verified against X's current GraphQL API as of March 2026; twscrape is async-only with no resume support. | Use **Scweet** as the X scraper; keep twscrape as the fallback. |
| 1. Transcription — "faster-whisper, Whisper.cpp, Vosk, pyannote.audio (add-on)" listed as separate options | These compose, not compete. faster-whisper does transcription, pyannote 3.1 does diarization, WhisperX bundles them with word-level alignment via wav2vec2. | Replace the four-way list with: **WhisperX (= faster-whisper + pyannote 3.1)** as the single primary. whisper.cpp is the embedded/no-Python fallback. |
| 2. Compile — "User's custom LLM pipeline (current highest fidelity)" | A custom LLM compiler is **non-deterministic** and conflicts with the "fully deterministic core" goal stated at the top of the tree. | Replace with **Docling (97.9% on complex tables) + MinerU (academic / CJK)**, both deterministic. Keep the LLM step optional and gated, never on the default path. |
| 3. Vector Store — "Chroma (user's existing)" as primary | Chroma is fine for SwarmVault's wiki retrieval (and is already integrated). But for the **feature side** — filtered semantic search across millions of conviction rows — Chroma is the wrong shape. | Keep **SwarmVault's existing hybrid index** for the wiki. Add **Qdrant** as the feature-row store: 2026 benchmarks single it out for filtered legal/financial search. |
| 4. Custom Conviction Rules Engine — "lexicon sentiment × credibility boost × graph centrality × recency × PhD-term alignment flag" | Multiplicative shape: any zero kills the score; weights are unidentifiable; a strong negative (negative lexicon) can't fight a high centrality. | Compute **three framings in parallel** — (a) z-score weighted sum, (b) the original multiplicative form, (c) logistic / log-odds — plus an ensemble. Industry-standard practice is to view the same data multiple ways. Contract `05_conviction_row` carries all four. |
| 5. Backtest — "AlphaSuite / NautilusTrader / LEAN / vectorbt / Backtrader" as parallel options | Listing five with no chosen primary leaves the research → live gap unresolved. | **NautilusTrader is the primary** (Rust core, research-to-live parity, no code rewrite at the broker boundary). **vectorbt** for parameter sweeps. **Alphalens** as the *factor* evaluator before the backtester sees the factor. AlphaSuite remains as the user's pre-feature scanner. LEAN and Backtrader are out unless a specific need surfaces. |
| 6. Portfolio — "PyPortfolioOpt / Riskfolio-Lib / cvxpy" | Same issue: no primary. Riskfolio-Lib carries 13 risk measures (CVaR, EVaR, CDaR, HRP, HERC); PyPortfolioOpt has the Black-Litterman path. | **Riskfolio-Lib primary, PyPortfolioOpt cross-check.** cvxpy only when a constraint is exotic enough to need raw convex modeling. **skfolio** added as a scikit-learn-native option for the ML-pipeline side. |
| 7. Execution — "ib_insync / alpaca-py / ccxt / quickfix" | Four parallel SDKs invite four code paths. | **NautilusTrader's adapter layer** wraps IB, Alpaca, and ccxt under one interface. quickfix only if a venue requires raw FIX. **Default to paper trading; live requires per-run authorization.** |
| 8. Orchestrator — "Airflow / Dagster / Prefect / Kedro" | The pipeline produces *typed assets* (Parquet feature tables, weight files), not bare tasks. | **Dagster** is the only one that treats data assets as first-class with built-in lineage. Pick Dagster; the rest are out. |
| 9. Audit — "DVC / lakeFS / Delta Lake" listed alongside MLflow as a single bucket | These solve different problems and **compose**, they don't compete. | Use **all of them by role**: DVC for code-pinned artifacts, lakeFS for the raw → curated lake with zero-copy branches, Delta Lake unused (overkill without Spark), MLflow for run-level params/metrics. Add **Pandera** for inline schema validation — missing from the original. |

## 2. Strengths to preserve (don't break these on the rewrite)

- **Deterministic core.** The principle is right and rare. Generative models are gated to optional, off-path steps. Every primary tool in this plan is rule-based, statistical, or graph-algorithmic.
- **Full source provenance.** SwarmVault already enforces this for the wiki. Extending it to every Parquet row downstream is a 100x audit advantage over typical quant pipelines.
- **6×/day cadence with freshness + dedup.** The right granularity for intraday-ish signal refresh without burning rate limits.
- **Grounding corpus as truth anchor.** Smart move; carries through unchanged. Implementation: PhD textbook + top-papers corpus lives in `raw/papers/`, gets the same Docling/MinerU treatment, and is tagged in SwarmVault as `source_class: resource` so it can be weighted differently in graph centrality.
- **Approval queue for new entities.** SwarmVault's `wiki/candidates/` flow is the human-in-the-loop gate; the pipeline plan keeps it intact.

## 3. Weaknesses + silent gaps (each with a fix)

| Gap | Risk | Fix in this plan |
|---|---|---|
| **No point-in-time correctness** in the original tree | Every backtest will leak future information. The single biggest correctness bug. | Every row carries `event_ts` and `as_of_ts`. Backtests filter `as_of_ts <= simulated_now`. Pandera contracts enforce both columns are present and `as_of_ts >= event_ts`. |
| **No feedback loop from performance → conviction weights** | Conviction weights are guesses that never get corrected. | Audit stage emits a calibration job: QuantStats → IC of conviction components → updated weights in `config/conviction.yml` (DVC-tracked). Closed loop. |
| **Python ↔ Node bridge unaddressed** | SwarmVault is TS, everything else is Python. Hidden integration cost. | Pipeline drives SwarmVault via its CLI + filesystem outputs; no in-process binding. Documented in `stages/03_knowledge_core/README.md`. |
| **No data-validation gate between stages** | A bad row silently flows to the optimizer. | **Pandera schemas** at every stage boundary, derived from the JSON Schemas in `contracts/`. Fail-fast on type/range/null violations. |
| **"Maximum features" risk: overfitting** | tsfresh emits 700+ features; spaCy + lexicon adds more. Without selection, signals overfit. | Stage 5 runs Alphalens IC + a Boruta / mRMR-style selection over the *deterministic* feature columns before they reach the backtester. Result: a stable feature subset gets surfaced in the run manifest. |
| **Execution defaults are dangerous** | A bug pushes orders to live. | Stage 7 defaults to **paper** mode. Live requires `execution.mode: live` in `config/pipeline.yml` *and* a per-run authorization in the Dagster run config. Kill-switch is a Dagster sensor on drawdown breach. |
| **No explicit handling of stale data / freshness windows** | An old tweet still drives a fresh signal. | Stage 4 features compute with an explicit `recency_window_days` per source type (X = 7d, news = 30d, papers = 365d, books = no decay). Decay is a tunable, not a constant. |
| **No timezone discipline** | UTC vs broker local will silently corrupt joins. | All `event_ts` and `as_of_ts` are stored as UTC `timestamp[ns, UTC]` in Parquet. Broker local time is a derived column. |
| **No cost model in the backtester** | Live PnL diverges from backtest immediately. | NautilusTrader's fee/slippage models are populated from broker tick logs in stage 9's calibration loop. |
| **No model risk for the lexicon dictionary itself** | Loughran-McDonald evolves; pinning to a stale version drifts. | Dictionary version is part of the run manifest. DVC tracks the file. Stage 9 flags drift if the dictionary file changes mid-run. |
| **"Highest yield" + "deterministic" is in tension** | Best-yield NLP today is embedding-based, not lexicon-based. | Hybrid: lexicon features are the deterministic core; embedding-based features (from SwarmVault's existing embeddings) are admitted as **additional columns** with a `source_type: embedding` tag so they can be ablated. Determinism is preserved at the *backtest* boundary by freezing the embedding model version per run. |

## 4. Overall verdict

The original 9-layer tree is **structurally sound and roughly 70% complete**. The biggest wins are (a) the deterministic principle and (b) the SwarmVault-as-base + wiki choice. The biggest problems are silent gaps — point-in-time correctness, the feedback loop, the missing validation gate, and the absence of a chosen primary at every "options" node. This plan resolves each of those with a named primary, a contract, and a fix.

If you build only the contracts and stage 1–4 + 9, you already have an institutional-grade research environment with full audit. Stages 5–7 can land progressively.
