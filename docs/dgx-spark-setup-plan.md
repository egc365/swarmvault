# DGX Spark Setup, Claude Code & Qwen3 Optimization Plan

A step-by-step playbook to go from a sealed box to a working NVIDIA DGX Spark
running Claude Code in the terminal and serving the largest Qwen3 model the
hardware can hold, tuned for performance.

---

## Goal

1. Unbox and physically install the DGX Spark.
2. Bring up DGX OS, network, and the NVIDIA software stack.
3. Install and authenticate **Claude Code** in the terminal.
4. Deploy the **largest Qwen3 model the 128 GB unified memory can handle**.
5. Apply an **optimization pass** for inference throughput and stability.

> **Note on the model.** "Qwen 3.6" maps to the **Qwen3** family. The biggest
> member is **Qwen3-235B-A22B** (235B total / 22B active Mixture-of-Experts).
> See [Phase 6](#phase-6--deploy-the-largest-qwen3-model) for why we run it at a
> sub-4-bit dynamic quant to fit in 128 GB, plus dense fallbacks.

---

## Hardware reference (DGX Spark)

| Component | Spec |
|---|---|
| Superchip | NVIDIA GB10 Grace Blackwell |
| CPU | 20-core Arm (10× Cortex-X925 + 10× Cortex-A725) |
| GPU | Blackwell architecture, 5th-gen Tensor Cores |
| Memory | **128 GB LPDDR5x unified (coherent CPU+GPU)** |
| Memory bandwidth | ~273 GB/s *(the main limiter for token generation)* |
| AI compute | up to ~1 PFLOP FP4 (sparse) |
| Storage | 1 TB / 4 TB NVMe M.2 |
| Networking | 10 GbE RJ45 + ConnectX-7 QSFP (200 GbE, for 2-unit clustering) + Wi-Fi/BT |
| OS | DGX OS (Ubuntu 24.04 LTS base + NVIDIA drivers/CUDA) |
| Power | ~240 W via USB-C PD adapter |

Key takeaway: **128 GB unified memory** is the capacity ceiling and **~273 GB/s
bandwidth** is the speed ceiling. MoE models (few active params) are the sweet
spot here.

---

## Master To-Do Checklist

### Phase 0 — Pre-arrival prep
- [ ] Confirm a workspace with airflow and a grounded outlet near your network.
- [ ] Have a monitor (HDMI/DP), USB keyboard + mouse ready for first boot *(or plan headless via Ethernet + SSH)*.
- [ ] Ethernet cable on hand (prefer wired for the large model downloads).
- [ ] Create / verify an **Anthropic account** with Claude Code access (Pro/Max or Console API billing).
- [ ] Create a **Hugging Face account** + access token (for gated/large model pulls).
- [ ] Note your Wi-Fi or network credentials.

### Phase 1 — Unboxing & physical setup
- [ ] Inspect the box for shipping damage before opening.
- [ ] Remove DGX Spark, power adapter/cable, and any included accessories.
- [ ] Place on a hard, ventilated surface (do not block intake/exhaust vents).
- [ ] Connect monitor (HDMI), keyboard, mouse *(skip if going headless)*.
- [ ] Connect Ethernet (RJ45). Reserve the QSFP port for two-unit clustering only.
- [ ] Connect the power adapter; do not power on until everything is seated.
- [ ] Power on; confirm the front indicator/LED comes up.

### Phase 2 — First boot & DGX OS setup
- [ ] Complete the DGX OS first-boot wizard (locale, keyboard, timezone).
- [ ] Create your primary user account; set a strong password.
- [ ] Connect to network (wired preferred); confirm internet reachability.
- [ ] Accept NVIDIA software license terms.
- [ ] Enable SSH for headless access: `sudo systemctl enable --now ssh`.
- [ ] Record the device IP: `ip a` (and reserve it / set a DHCP reservation).

### Phase 3 — System update & NVIDIA stack verification
- [ ] Update the OS: `sudo apt update && sudo apt full-upgrade -y`.
- [ ] Reboot if a kernel/driver was updated: `sudo reboot`.
- [ ] Verify GPU + driver: `nvidia-smi` (expect GB10 / Blackwell listed).
- [ ] Verify CUDA toolkit: `nvcc --version` (install via `sudo apt install -y cuda-toolkit` if missing).
- [ ] Confirm container runtime: `docker --version` and `sudo docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi`.
- [ ] Confirm unified memory headroom: `free -h` (expect ~128 GB total).
- [ ] (Optional) Log in to NVIDIA NGC for official containers: `docker login nvcr.io`.

### Phase 4 — Install Claude Code in the terminal
- [ ] Install Node.js 18+ (LTS): `sudo apt install -y nodejs npm` *(or use nvm for a current LTS)*.
- [ ] Verify: `node --version` (>= 18).
- [ ] Install Claude Code (native installer): `curl -fsSL https://claude.ai/install.sh | bash`
      *(alternative: `npm install -g @anthropic-ai/claude-code`)*.
- [ ] Ensure it's on PATH; start it: `claude`.
- [ ] Authenticate when prompted (browser OAuth for Pro/Max, or set `ANTHROPIC_API_KEY` for Console billing).
- [ ] Smoke test: `cd` into a repo and run `claude` → ask it to summarize the project.
- [ ] (Optional) Add a project `CLAUDE.md` and run `/init` to capture build/test commands.

### Phase 5 — Install the inference stack
Pick **one** primary engine. Recommendation order for DGX Spark (Arm + Blackwell):
- [ ] **Option A — Ollama (easiest):** `curl -fsSL https://ollama.com/install.sh | sh` → verify `ollama --version` and that it detects the GPU in logs.
- [ ] **Option B — llama.cpp (most control over quant/offload):** build with CUDA
      `cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release -j`.
- [ ] **Option C — vLLM / NVIDIA NIM (best throughput & serving):** run the NGC/NIM container for Qwen3 with `--gpus all`.
- [ ] Confirm the engine reports the Blackwell GPU and loads a tiny model (e.g. `qwen3:0.6b`) end-to-end first.

### Phase 6 — Deploy the largest Qwen3 model
- [ ] Decide capacity budget: reserve ~10–15 GB for OS/KV-cache → **~110 GB usable** for weights.
- [ ] **Largest that fits — Qwen3-235B-A22B (MoE)** at a dynamic sub-4-bit quant:
  - [ ] Use an Unsloth **dynamic GGUF** (~IQ3/Q3, ≈90–110 GB) — 4-bit (~142 GB) does **not** fit in 128 GB.
  - [ ] llama.cpp: `./build/bin/llama-server -m Qwen3-235B-A22B-Instruct-2507-Q3_K_XL.gguf -ngl 999 -c 8192 --host 0.0.0.0`
  - [ ] Ollama alt: pull/create from the dynamic GGUF, then `ollama run qwen3-235b`.
- [ ] **Quality/speed fallbacks (recommended for daily use):**
  - [ ] `Qwen3-30B-A3B` (MoE, ~3B active) at Q8 — very fast, fits easily, great default.
  - [ ] `Qwen3-32B` (dense) at Q8/Q6 — strong quality, fits comfortably.
- [ ] Validate output: run a reasoning + a coding prompt; confirm coherent responses.
- [ ] Record tokens/sec for each candidate to choose your daily driver.

### Phase 7 — Optimization pass
- [ ] **Power/thermal:** set the platform to max performance and confirm clocks hold under load; keep vents clear. Watch temps with `nvidia-smi -l 1`.
- [ ] **Full GPU offload:** ensure all layers are on GPU (`-ngl 999` / engine auto) — partial CPU offload tanks speed.
- [ ] **Flash attention + KV-cache quant** (llama.cpp): add `-fa` and `--cache-type-k q8_0 --cache-type-v q8_0` to cut KV memory and raise usable context.
- [ ] **Right-size context:** start at 8K; only raise `-c` if memory allows (KV cache grows with context).
- [ ] **Prefer MoE for interactive use:** with 273 GB/s bandwidth, low active-param MoE (A3B/A22B) >> dense for tokens/sec.
- [ ] **Batching/serving:** for multi-request workloads use vLLM/NIM continuous batching instead of single-stream llama.cpp.
- [ ] **Keep model resident:** set Ollama `OLLAMA_KEEP_ALIVE=-1` (or engine equivalent) to avoid reload stalls.
- [ ] **Storage:** keep model files on the NVMe (not a network/USB mount) for fast load.
- [ ] **Wire Claude Code to local models (optional):** point an Anthropic-compatible/OpenAI-compatible proxy at the local server, or use the local model via your own tooling while keeping Claude Code on Anthropic models for agentic work.

### Phase 8 — Validation & benchmarking
- [ ] Capture baseline tokens/sec (prompt + generation) per model with `llama-bench` or engine stats.
- [ ] Verify memory headroom under load (`nvidia-smi`, `free -h`) — no swapping.
- [ ] Run a 30–60 min soak test; confirm stable temps and no OOM.
- [ ] Document final chosen model, quant, context size, and tokens/sec in this file.
- [ ] Commit notes; you're production-ready.

---

## Quick decision summary

- **Biggest model that fits:** Qwen3-235B-A22B at ~Q3 dynamic GGUF (≈100 GB) — impressive but bandwidth-bound and tight on context.
- **Best daily driver:** Qwen3-30B-A3B (Q8) for speed, or Qwen3-32B (Q6/Q8) for max dense quality.
- **Why:** 128 GB caps capacity; ~273 GB/s caps speed — MoE models win on this box.

## Useful commands cheat-sheet

```bash
nvidia-smi                 # GPU, driver, memory, temps
nvidia-smi -l 1            # live monitor
free -h                    # unified memory usage
nvcc --version             # CUDA toolkit
claude                     # launch Claude Code (then /login, /init)
ollama list                # local models
ollama ps                  # loaded models + memory
```
