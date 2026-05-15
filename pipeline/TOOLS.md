# Tool Selection — Research, 2026 Sources, and Rationale

Per the user's directive: **best fit for open-source, highest-yield data, difficulty ignored as a selection criterion.** This document records why each primary tool was chosen and what was rejected.

## Stage 1 — Capture

### Text feeds (web, RSS, X)
- **Primary: Scrapy + feedparser + Scweet**
- **Why:** Scrapy is the mature crawler; feedparser is the RSS standard; Scweet is verified working against X's current GraphQL API as of March 2026, and the alternative (twscrape) is async-only with no resume support.
- **Rejected:** Apache NiFi (visual dataflow; overkill, JVM ops cost without yield gain).

### Audio / video
- **Primary: WhisperX** (= faster-whisper + pyannote 3.1 + wav2vec2 alignment)
- **Why:** pyannote 3.1 achieves ~10% DER on standard benchmarks — the best of the open-source diarization options. WhisperX bundles it with faster-whisper (4× GPU, 2× CPU speedup over vanilla Whisper) and adds word-level timestamps. Word-level timestamps are essential because Stage 4 features need to attribute each claim to a single speaker turn.
- **Rejected:** Whisper.cpp (no diarization, lower accuracy on some languages); Vosk (older models, lower yield); raw faster-whisper without WhisperX (loses diarization).

## Stage 2 — Compile

- **Primary: Docling. Fallback: MinerU.**
- **Why:** Docling hits 97.9% accuracy on complex tables in 2026 benchmarks, with best-in-class structural preservation (DocLayNet + TableFormer under the hood). MinerU is dominant on academic papers with complex layouts and CJK content. Running both and keeping the higher-confidence output is the highest-yield deterministic path — neither requires an LLM.
- **Rejected:** Custom LLM pipeline (non-deterministic; conflicts with the deterministic-core principle); pymupdf4llm (fast but no layout/OCR — useful as a fast-path for native PDFs only); unstructured.io (broad enterprise scope but lower table-extraction yield than Docling).

## Stage 3 — Knowledge core

### Graph + wiki
- **Primary: SwarmVault** (this repo). Mirror to **Neo4j Community** via the existing `graph-push` for advanced Cypher.
- **Why:** SwarmVault is the user's stated "base" + "wiki" component. It already does typed graph construction, candidate review, hybrid retrieval, MCP, and `graph-push` to Neo4j. Re-implementing any of that loses yield.
- **Rejected:** Building a Neo4j-primary or Memgraph-primary stack. They have stronger native query languages, but losing the wiki + candidate + approval workflow trades a 10x audit advantage for a marginal query-speed gain.

### Vector store
- **Primary: SwarmVault's existing hybrid index (SQLite FTS + embeddings)** for the wiki side. **Qdrant** for feature-row filtered semantic retrieval.
- **Why:** Qdrant is singled out in 2026 vector-DB benchmarks for filtered legal/financial search — exactly the shape of feature-row retrieval (filter by ticker, date range, source class). Weaviate is the hybrid-search champion but Qdrant is better-shaped for our metadata filters.
- **Rejected:** Replacing SwarmVault's Chroma-backed wiki index (would break the existing review workflow); Weaviate as primary (heavier deploy, marginal yield gain).

### Grounding corpus
- **Implementation:** PhD textbooks and top papers ingested through Stage 2 → Stage 3 with `source_class: resource` in SwarmVault. Higher centrality weight in Stage 4.

## Stage 4 — Features & conviction

### Lexicon sentiment
- **Primary: pysentiment2 + custom Loughran-McDonald loader** pulling the master dictionary from Notre Dame SRAF.
- **Why:** Loughran-McDonald is the academic gold standard for financial sentiment; SRAF maintains it with periodic updates and labels six categories (negative, positive, litigious, uncertainty, constraining, superfluous). pysentiment2 (the maintained fork of pysentiment) wraps it cleanly.
- **Rejected:** VADER (general-purpose, not finance-tuned); FinBERT (not deterministic).

### NLP / entity extraction
- **Primary: spaCy + EntityRuler. Secondary: Stanza.**
- **Why:** spaCy + EntityRuler is the mature path for custom-pattern matching on a curated key-figures list and a PhD-terms vocabulary. Stanza (Stanford NLP) supplies the cross-check on high-stakes entity decisions.
- **Rejected:** NLTK as primary (older, slower).

### Statistical features
- **Primary: scikit-learn + tsfresh + pandas + numpy**
- **Why:** tsfresh computes hundreds of statistical time-series features deterministically — the highest-yield bulk extractor available open-source. scikit-learn handles TF-IDF, n-grams, and feature-selection upstream.
- **Note:** tsfresh's 700+ features need feature selection in Stage 5 (Alphalens IC + Boruta / mRMR). Without selection, you overfit.

### Graph features
- **Primary: NetworkX (correctness). Performance fallback: igraph.**
- **Why:** NetworkX is the reference implementation for PageRank, betweenness, communities; igraph is 10–100x faster on large graphs but with a stricter API. Use NetworkX while the graph is <100k nodes; switch to igraph beyond.

### Conviction layer — three framings + ensemble
The user specified "industry-standard: data is usually analyzed multiple ways." Therefore the conviction row carries **all** of:

1. **`conviction_zscore`** — z-score each component over a rolling window, weighted sum. Stable, interpretable, no zero-multiplication trap.
2. **`conviction_multiplicative`** — the original `lexicon × credibility × centrality × recency × alignment` shape. Preserved so the user can compare against legacy.
3. **`conviction_logodds`** — each component mapped to a logit, sum logits, sigmoid back to [0, 1]. Bounded, additive in log-odds, calibration-friendly.
4. **`conviction_ensemble`** — rank-average of the three. The single number the downstream backtester uses by default.

All four are stored. Stage 9 calibrates each one against realized PnL and surfaces the best-performing framing per regime.

## Stage 5 — Signals

### Backtest / live
- **Primary: NautilusTrader.** Research add-on: **vectorbt** for sweeps.
- **Why:** NautilusTrader's Rust core gives nanosecond determinism and the same code path runs research and live — no rewrite at the broker boundary. vectorbt is the fastest open-source vectorized engine for parameter sweeps where you don't need live parity.
- **Rejected:** QuantConnect LEAN (institutional but ties you to QuantConnect's ecosystem); Backtrader (older, slower, no live parity); Zipline-reloaded (research only).

### Factor evaluation
- **Primary: Alphalens.** Computes IC, quantile returns, turnover, tear-sheets. The gate that decides whether a feature even *gets* to the backtester.

### Strategy scanner (user's existing)
- **Kept: AlphaSuite** as the pre-feature scanner. Its output feeds Stage 4 as another feature source (with `source_type: alphasuite_scanner` tag).

## Stage 6 — Portfolio

- **Primary: Riskfolio-Lib. Cross-check: PyPortfolioOpt.**
- **Why:** Riskfolio-Lib supports 13 risk measures (CVaR, EVaR, CDaR, HRP, HERC, plus the standard mean-variance) — the most institutional-fidelity coverage in open source. PyPortfolioOpt is the conservative cross-check (Black-Litterman + classic frontier).
- **Added: skfolio** for scikit-learn-pipeline-native portfolio fitting when integrating with ML cross-validation.
- **Risk analytics:** empyrical (core metrics) + QuantStats (tear-sheets).

## Stage 7 — Execution

- **Primary: NautilusTrader live adapters** wrapping IB / Alpaca / ccxt under one interface.
- **Why:** Same engine that ran the backtest. Eliminates the most common live-trading bug class: backtest-vs-live divergence.
- **Default mode: paper.** Live requires `execution.mode: live` in `config/pipeline.yml` AND a per-run authorization. Drawdown kill-switch is a Dagster sensor.

## Stage 8 — Orchestration

- **Primary: Dagster.**
- **Why:** The pipeline produces typed assets (Parquet tables tied to contracts), not bare tasks. Dagster is the only major orchestrator that treats data assets as first-class with built-in lineage, partitioning, and a UI (Dagit) that visualizes the asset graph including staleness. Matches our contract-per-stage model exactly.
- **Rejected:** Airflow (task-oriented, no asset lineage); Prefect (flow-oriented, less mature lineage); Kedro (project structure framework, not an orchestrator).

## Stage 9 — Audit & versioning

Used together by role, not as alternatives:

- **DVC** — version-controls model artifacts, feature snapshots, and the conviction config. Pins them to git commits.
- **lakeFS** — version-controls the raw → curated lake with zero-copy branches. Lets us reproduce any historical run against the exact data the run saw.
- **MLflow** — tracks every run's params, metrics, and artifact pointers. The "run database."
- **Pandera 0.29** — inline schema validation at every stage boundary; schemas derived from the JSON Schemas in `contracts/`. Pandera was preferred over Great Expectations because (a) it runs in-process with pandas/Polars (no separate service), (b) it integrates with type hints, and (c) it validates 5M-row frames faster.
- **structlog + Prometheus + Grafana** — live observability.
- **Delta Lake** — explicitly **not** used. It's the right answer for Spark/petabyte tables; overkill for this footprint.

---

## Sources (2026)

### Transcription
- [Modal — Choosing between Whisper variants](https://modal.com/blog/choosing-whisper-variants)
- [BrassTranscripts — WhisperX vs Competitors 2026](https://brasstranscripts.com/blog/whisperx-vs-competitors-accuracy-benchmark)
- [pyannote/speaker-diarization-3.1 (Hugging Face)](https://huggingface.co/pyannote/speaker-diarization-3.1)
- [BrassTranscripts — Best Speaker Diarization Models 2026](https://brasstranscripts.com/blog/speaker-diarization-models-comparison)
- [LocalAIMaster — Faster-Whisper Setup Guide 2026](https://localaimaster.com/blog/faster-whisper-guide)

### Document structuring
- [Menon Lab — Best Open-Source PDF-to-Markdown Tools in 2026](https://themenonlab.blog/blog/best-open-source-pdf-to-markdown-tools-2026)
- [Procycons — PDF Data Extraction Benchmark](https://procycons.com/en/blogs/pdf-data-extraction-benchmark/)
- [BoringBot — PDF Table Extraction Showdown: Docling vs LlamaParse vs Unstructured](https://boringbot.substack.com/p/pdf-table-extraction-showdown-docling)

### Vector databases
- [CallSphere — Vector Database Benchmarks 2026](https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb)
- [4xxi — Vector Database Comparison 2026](https://4xxi.com/articles/vector-database-comparison/)
- [MarkTechPost — Best Vector Databases in 2026](https://www.marktechpost.com/2026/05/10/best-vector-databases-in-2026-pricing-scale-limits-and-architecture-tradeoffs-across-nine-leading-systems/)

### Backtesting
- [python.financial — The Python Backtesting Landscape 2026](https://python.financial/)
- [NautilusTrader official site](https://nautilustrader.io/)
- [autotradelab — Backtrader vs NautilusTrader vs VectorBT vs Zipline-reloaded](https://autotradelab.com/blog/backtrader-vs-nautilusttrader-vs-vectorbt-vs-zipline-reloaded)
- [Alphalens — Quantopian factor analysis](https://github.com/quantopian/alphalens)

### Lexicon sentiment
- [Notre Dame SRAF — Loughran-McDonald Master Dictionary](https://sraf.nd.edu/loughranmcdonald-master-dictionary/)
- [pysentiment2 on PyPI](https://pypi.org/project/pysentiment2/)

### Portfolio optimization
- [Riskfolio-Lib documentation](https://riskfolio-lib.readthedocs.io/en/latest/portfolio.html)
- [PyPortfolioOpt on GitHub](https://github.com/PyPortfolio/PyPortfolioOpt)
- [skfolio documentation](https://skfolio.org/)
- [arXiv — skfolio: Portfolio Optimization in Python](https://arxiv.org/pdf/2507.04176)

### Orchestration
- [bix-tech — Airflow vs Dagster vs Prefect 2026](https://bix-tech.com/airflow-vs-dagster-vs-prefect-which-workflow-orchestrator-should-you-choose-in-2026/)
- [Modern DataTools — Apache Airflow vs Dagster vs Prefect 2026](https://www.modern-datatools.com/compare/airflow-vs-dagster-vs-prefect)

### Data validation
- [endjin — Pandera vs Great Expectations](https://endjin.com/blog/a-look-into-pandera-and-great-expectations-for-data-validation)
- [PythonDataBench — Pandera Validation Guide 2026](https://pythondatabench.com/article/data-validation-python-pandera-practical-guide)

### Data versioning
- [HashDork — 7 Best Data Version Control Tools 2026](https://hashdork.com/data-version-control-tools/)
- [lakeFS — Data Version Control Tools 2026](https://lakefs.io/data-version-control/dvc-tools/)

### Web scraping
- [Scrapfly — How to Scrape X.com 2026](https://scrapfly.io/blog/posts/how-to-scrape-twitter)
- [AIMultiple — 5 Best Twitter Scrapers 2026](https://aimultiple.com/twitter-scraper)
- [Scweet on GitHub](https://github.com/Altimis/Scweet)
