## Cryptographic audit chain
Source: https://github.com/scopeblind/scopeblind-gateway (MIT, tomjwxf/Veritas Acta)
IETF draft: draft-farley-acta-signed-receipts
Ported to: packages/engine/src/audit-chain.ts
Source files referenced:
- src/signing.ts
- src/cli.ts
- src/types.ts
- src/rekor-anchor.ts
- src/selective-disclosure.ts
- draft-farley-acta-signed-receipts-01.txt

## Deterministic graph reasoning
Source: https://github.com/abbacusgroup/cortex (MIT)
Ported to: packages/engine/src/graph-deterministic.ts
Source files referenced: src/cortex/ontology/namespaces.py, src/cortex/pipeline/reason.py, src/cortex/pipeline/advanced_reason.py, src/cortex/retrieval/graph.py, benchmarks/b3_contradiction/test_bench.py, benchmarks/b4_graph_intelligence/test_bench.py

## Hot-cache session context
Source: https://github.com/AgriciDaniel/claude-obsidian (MIT, 4933★)
Ported to: packages/engine/src/hot-cache.ts

## AST-only deterministic code extraction
Source: https://github.com/Houseofmvps/codesight (MIT, 1043★)
Ported to: packages/engine/src/code-ast-deterministic.ts
Source files referenced:
- src/scanner.ts
- src/detectors/routes.ts
- src/detectors/schema.ts
- src/ast/loader.ts
- src/ast/extract-routes.ts
- src/ast/extract-schema.ts
