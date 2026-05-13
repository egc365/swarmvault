# Windows known-issue test failures
*Tracked 2026-05-13 after Sprint 0.5 (cross-env) + resolve-root fix landed.*

Upstream swarmclawai/swarmvault has never claimed Windows support - its own
`.github/workflows/ci.yml` runs `pnpm test` on `ubuntu-latest` only. Our fork
inherits that posture. The following tests fail on Windows out of the box for
reasons NOT related to our cross-env or resolve-root fixes:

| Package         | Test file                         | Test name                                                                                 | Failure shape                                                     |
|-----------------|-----------------------------------|-------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| packages/engine | test/audio-extraction.test.ts     | video transcription extraction > extracts local video audio with ffmpeg and routes it through the audio provider | `result.extractedText` is `undefined`; expected transcript text containing `architecture review` |
| packages/engine | test/audio-extraction.test.ts     | video transcription extraction > downloads public video audio with yt-dlp when URL video mode is requested | `result.extractedText` is `undefined`; expected `Public demo transcript.` |
| packages/engine | test/audio-redaction.test.ts      | audio transcription redaction > scrubs secrets from public video transcripts before writing raw and extract sidecars | raw sidecar content is empty; expected `[REDACTED]`               |
| packages/engine | test/code-ingestion.test.ts       | code-aware ingestion > detects executable shell scripts by shebang even without an extension | shebang-only shell script is classified as `text`; expected `code` |
| packages/engine | test/code-ingestion.test.ts       | code-aware ingestion > detects executable node, python, and ruby scripts by shebang without an extension | extensionless shebang scripts are classified as `text`; expected `code` |
| packages/engine | test/local-whisper-setup.test.ts  | expectedModelPath / modelDownloadUrl > resolves to ~/.swarmvault/models/ggml-<model>.bin | expects POSIX `/home/user/...`, gets `\home\user\...`             |

Total: 6 failing tests, distributed across audio/video extraction + redaction,
code-ingestion shebang detection, and local whisper setup path handling.

**Posture:** these block `pnpm test` on Windows, do NOT block CI (Linux only per
upstream), do NOT block local development on Windows for the non-affected
packages. Resolved by either (a) upstream PRs we may submit over time, or (b)
local fork patches if specific failures bite us.
