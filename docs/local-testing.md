# Local Testing

This is the start-to-finish guide for testing **the source checkout** on a local machine. It complements [docs/live-testing.md](./live-testing.md), which covers validation of the **published npm package**. Use this doc when you are developing in the OSS repo and want to verify your changes before opening a PR.

## Prerequisites

- Node.js `>=24.0.0` (every package in the workspace pins this in `engines.node`)
- pnpm `10.32.1` — the version pinned in `packageManager`. Install with `corepack enable && corepack prepare pnpm@10.32.1 --activate`.
- A POSIX shell. Windows users: see [WINDOWS_KNOWN_ISSUES.md](../WINDOWS_KNOWN_ISSUES.md).
- Optional, only for specific lanes:
  - **Playwright Chromium** — required for `--browser-check` smoke runs (`pnpm exec playwright install chromium`).
  - **Docker daemon** — required for the Neo4j live-smoke lane.
  - **Provider credentials** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OLLAMA_API_KEY` for the matching provider lane. None of these are required for the heuristic path.

## 1. Clone and install

```bash
git clone https://github.com/swarmclawai/swarmvault.git
cd swarmvault
pnpm install
```

`pnpm install` also runs `lefthook install` via the root `prepare` script, which wires up the pre-commit lint hook defined in `lefthook.yml`.

## 2. Inner-loop checks

These are fast and should pass on every working tree before you commit.

```bash
pnpm lint        # biome check across the workspace
pnpm typecheck   # tsc --noEmit in every package
pnpm test        # workspace test suite
pnpm build       # builds viewer, engine, and CLI in order
```

Notes:

- `pnpm test` runs `check-published-manifests.mjs`, the release-preflight-summary unit test, and then `pnpm -r test` (vitest in each package). The engine test command sets `SWARMVAULT_ALLOW_PRIVATE_URLS=1` and a 30s test timeout — `pnpm --filter @swarmvaultai/engine test` reproduces it in isolation.
- `pnpm build` is order-sensitive: the engine build copies the viewer's `dist/` into `packages/engine/dist/viewer/`. If you only changed the viewer, rerun the engine build.
- Use `pnpm lint:fix` to auto-apply Biome fixes and `pnpm format` to format only.

## 3. Aggregate check

The `check` script is the single command that mirrors most of what CI runs on a PR:

```bash
pnpm check
```

It runs, in order:

1. `biome check .`
2. `pnpm -r typecheck`
3. `node ./scripts/check-release-sync.mjs` — versions and changelog must line up
4. `node ./scripts/check-published-manifests.mjs` — published manifests stay clean of workspace specs
5. `node ./scripts/check-readme-parity.mjs` — English/Chinese/Japanese READMEs stay in sync
6. `node ./scripts/check-clawhub-skill.mjs` — the `skills/swarmvault/` bundle stays valid

Individual checks are also exposed as scripts (`pnpm check:release-sync`, `pnpm check:readme-parity`, etc.) for tighter loops.

## 4. Per-package testing

Run a single package's vitest suite while iterating:

```bash
pnpm --filter @swarmvaultai/engine test
pnpm --filter @swarmvaultai/cli test
pnpm --filter @swarmvaultai/viewer test
```

To run a single file or pattern, pass through to vitest:

```bash
pnpm --filter @swarmvaultai/engine exec vitest run src/path/to/file.test.ts
```

## 5. Local CLI smoke

After `pnpm build`, the freshly built CLI is at `packages/cli/dist/index.js`. Smoke-test it against a throwaway workspace without touching your global install:

```bash
mkdir -p /tmp/swarmvault-local && cd /tmp/swarmvault-local
node /path/to/swarmvault/packages/cli/dist/index.js init
node /path/to/swarmvault/packages/cli/dist/index.js scan ./some-fixture --no-serve
node /path/to/swarmvault/packages/cli/dist/index.js query "What is in this vault?"
```

This is the fastest way to confirm an engine or CLI change behaves end-to-end before reaching for the packaged smoke runner.

## 6. Live smoke against a packed tarball

When you want to verify the install path your users will hit, run the live smoke runner against locally-packed tarballs instead of the published npm registry:

```bash
pnpm build
pnpm --filter @swarmvaultai/engine pack --pack-destination /tmp
pnpm --filter @swarmvaultai/cli pack --pack-destination /tmp
node ./scripts/live-smoke.mjs --lane heuristic \
  --install-spec /tmp/swarmvaultai-engine-*.tgz \
  --install-spec /tmp/swarmvaultai-cli-*.tgz
```

Use `pnpm pack`, not raw `npm pack`: the latter preserves workspace dependency specs in the CLI manifest and does not reflect the publish-time rewrite.

The heuristic lane is offline and the recommended default. Other lanes (`neo4j`, `ollama`, `anthropic`, `openai`, `--browser-check`) and the OSS corpus runner are documented in [docs/live-testing.md](./live-testing.md).

## 7. Release preflight

Before tagging or asking for a release, run the full preflight locally:

```bash
pnpm release:preflight
```

This runs `check`, `test`, `build`, the site build, the skill dry-run, and the installed-package smoke through heuristic, browser, and OSS corpus lanes. It is the same gate the maintainer publish flow runs before it touches npm.

## 8. Failure artifacts

When a smoke or corpus run fails, the runner keeps the temporary workspace and logs under:

```text
.live-smoke-artifacts/
.oss-corpus-artifacts/
```

Successful runs delete those directories. Pass `--keep-artifacts` or set `KEEP_LIVE_SMOKE_ARTIFACTS=1` to preserve them during a green run while debugging.

## 9. Pre-commit hook

`lefthook` runs `biome check` against staged `*.{ts,tsx,js,jsx,json}` on every commit and auto-stages fixes. If a commit is blocked, run `pnpm lint` to see the full report. Do not bypass with `--no-verify`: fix the underlying issue or stage the auto-applied edits.

## Quick reference

| Goal | Command |
|---|---|
| Install deps | `pnpm install` |
| Fast inner loop | `pnpm lint && pnpm typecheck && pnpm test` |
| Mirror CI checks | `pnpm check` |
| Build all packages | `pnpm build` |
| One package's tests | `pnpm --filter @swarmvaultai/<pkg> test` |
| Local-tarball smoke | `node ./scripts/live-smoke.mjs --lane heuristic --install-spec …` |
| Full release gate | `pnpm release:preflight` |
