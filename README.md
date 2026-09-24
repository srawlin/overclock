# fastcode

```
    ____           __                  _
   / __/___ ______/ /_    ___ ___   __| | ___
  / /_/ __ `/ ___/ __/   / __/ _ \ / _` |/ _ \
 / __/ /_/ (__  ) /_    | (_| (_) | (_| |  __/
/_/  \__,_/____/\__/     \___\___/ \__,_|\___|
```

**A minimal coding-agent harness tuned for Cerebras fast inference.**

## Why?

Cerebras serves models like `qwen-3.8-27b` at ~2,000 output tokens/sec — fast enough that the *harness* becomes the bottleneck. Heavier coding agents are built for slow inference: big fixed system prompts, sprawling tool surfaces, and context compaction that forces expensive re-reads (or worse, re-fetch loops where the model re-downloads files it already saw).

fastcode is a thin extension on top of [`pi-coding-agent`](https://github.com/mariozechner/pi-coding-agent) that strips the harness down to what fast inference actually needs:

- **Small fixed overhead** — ~4k tokens of system prompt + tool schemas, vs ~10k+ in heavier harnesses. Every request re-pays it; on Cerebras that difference is latency you can feel.
- **Context budgeting instead of compaction spirals** — old tool outputs are elided in place (deduped by path/command, newest kept verbatim, generous keep window) so the transcript stays small *and* the model doesn't re-fetch what it already saw.
- **Prompt-cache friendly** — transforms only touch the tail of the transcript, keeping the prefix stable so Cerebras's prompt caching does its job (we measure ~90%+ cache hits in real sessions).
- **Rate-limit aware** — soft TPM pacing keeps bursts under the 750k tokens/min developer limit instead of burning time on 429 retries.
- **Sub-agents that protect context** — `explore` (read-only search), `delegate` (full coding task), and `verify` (independent PASS/FAIL check) run their own loops and return only summaries to the main agent.
- **Observability** — JSONL metrics for every request: wire size, cache rate, TTFT, tokens/sec, tool latency, sub-agent usage. `~/.fastcode/agent/logs/`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/srawlin/fastcode/dev/install.sh | bash
```

The installer clones to `~/.local/share/fastcode`, links `fastcode` into `~/.local/bin`, and prompts for your [Cerebras API key](https://cloud.cerebras.ai). Requires Node ≥ 20 and git.

> **While the repo is private:** the raw.githubusercontent.com URL needs auth — clone with SSH instead and run `install.sh` locally, or let the installer's SSH fallback handle it.

**Manual:**

```bash
git clone git@github.com:srawlin/fastcode.git && cd fastcode
npm install
./bin/fastcode
```

## Use it

```bash
fastcode                # interactive TUI
fastcode -p "fix the failing test"   # print mode — one shot, stdout
```

Exit with `/exit`, `/quit`, or Ctrl-D.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CEREBRAS_API_KEY` | — | Required. Or put it in `~/.config/fastcode/env` |
| `FASTCODE_MODEL` | `cerebras/qwen-3.8-27b` | Main agent model |
| `FASTCODE_EXPLORE_MODEL` | `gpt-oss-120b` | Route `explore` to a cheaper search model (default). Set to `""` to run explore on the main model. Only the *main* model is per-session; sub-agent model routing is cache-safe. |
| `FASTCODE_FAST` | off | Aggressive preset: tighter keep window, 8k output cap |
| `FASTCODE_KEEP_TOKENS` / `_HARD_BUDGET_TOKENS` / `_TIGHT_KEEP_TOKENS` / `_MAX_OUT_TOKENS` | 16k / 80k / 4k / 16k | Individual context/output knobs (override the preset) |
| `FASTCODE_DEBUG` | off | Per-request wire-size stats to stderr |
| `FASTCODE_API_BASE` | `api.cerebras.ai/v1` | Custom endpoint (proxy/gateway/test) |
| `FASTCODE_AGENT_DIR` | `~/.fastcode/agent` | Sessions, settings, metrics |

## Metrics

Every run appends to `~/.fastcode/agent/logs/metrics-*.jsonl`:

```json
{"kind":"turn","firstTokenMs":212,"totalMs":1400,"outputTok":96,"tokensPerSec":68.6}
{"kind":"usage","input":1204,"cacheRead":28900,"output":96}
{"kind":"subagent","name":"explore","model":"gpt-oss-120b","turns":3,"ms":684}
{"kind":"run_end","wallMs":9400,"turns":4,"toolTotalMs":1200,"nTools":3}
```

## Development

```bash
npm test          # unit + e2e suite (e2e uses a local mock — no API key needed)
bun typecheck
npm run eval      # real-API task evals in test/eval (uses your key, burns tokens)
```

`npm run eval:fast` runs the eval suite with the `FASTCODE_FAST` preset enabled.

## Layout

```
bin/fastcode                     # launcher (finds pi + a modern node, sets env)
extensions/fastcode/
  index.ts                       # provider registration, hooks, /exit, banner
  context-budget.ts              # transcript pruning + dedupe
  provider-tuning.ts             # clear_thinking, output cap, TPM pacing
  subagents.ts                   # explore / delegate / verify tools
  prompt.ts                      # small-context guidance
  knobs.ts                       # FASTCODE_* env knobs
  metrics.ts                     # JSONL metrics
  logo.ts                        # startup banner
test/                            # unit + mock e2e tests (bun)
test/eval/                       # real-API eval harness
```
