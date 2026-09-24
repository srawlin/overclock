# overclock

```
                               _            _
  ____ _   _____  _____    ___| | ___   ___| | __
 / __ \ | / / _ \/ ___/   / __| |/ _ \ / __| |/ /
/ /_/ / |/ /  __/ /      | (__| | (_) | (__|   <
\____/|___/\___/_/        \___|_|\___/ \___|_|\_\
```

**A minimal coding-agent harness tuned for Cerebras fast inference.**

*A personal project — not affiliated with, endorsed by, or sponsored by Cerebras Systems, Inc. See [Disclaimer](#disclaimer).*

## Why?

Cerebras serves models like `qwen-3.8-27b` at ~2,000 output tokens/sec — fast enough that the *harness* becomes the bottleneck. Heavier coding agents are built for slow inference: big fixed system prompts, sprawling tool surfaces, and context compaction that forces expensive re-reads (or worse, re-fetch loops where the model re-downloads files it already saw).

overclock is a thin extension on top of [`pi-coding-agent`](https://github.com/earendil-works/pi) that strips the harness down to what fast inference actually needs:

- **Small fixed overhead** — ~4k tokens of system prompt + tool schemas, vs ~10k+ in heavier harnesses. Every request re-pays it; on Cerebras that difference is latency you can feel.
- **Context budgeting** — old tool outputs are kept in place (deduped by path/command, newest kept verbatim, generous keep window) so the transcript stays small *and* the model doesn't re-fetch what it already saw.
- **Prompt-cache friendly** — transforms only touch the tail of the transcript, keeping the prefix stable so Cerebras's prompt caching does its job (we measure ~90%+ cache hits in real sessions).
- **Rate-limit aware** — soft TPM pacing keeps bursts under the 750k tokens/min developer limit instead of burning time on 429 retries.
- **Sub-agents that protect context** — `explore` (read-only search), `delegate` (full coding task), and `verify` (independent PASS/FAIL check) run their own loops and return only summaries to the main agent.
- **Observability** — JSONL metrics for every request: wire size, cache rate, TTFT, tokens/sec, tool latency, sub-agent usage. `~/.overclock/agent/logs/`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/srawlin/overclock/dev/install.sh | bash
```

The installer clones to `~/.local/share/overclock`, links `overclock` into `~/.local/bin`, and prompts for your [Cerebras API key](https://cloud.cerebras.ai). Requires Node ≥ 22.19 and git.


**Manual:**

```bash
git clone git@github.com:srawlin/overclock.git && cd overclock
npm install
./bin/overclock
```

## Use it

```bash
overclock                # interactive TUI
overclock -p "fix the failing test"   # print mode — one shot, stdout
overclock -r             # resume your last session
overclock --session <id> # resume a specific session (shown on exit)
overclock --safe         # read-only mode: no bash, no writes, no delegate/verify
```

Exit with `/exit`, `/quit`, or Ctrl-D — the session-resume hint printed on exit is already `overclock`-branded.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CEREBRAS_API_KEY` | — | Required. Or put it in `~/.config/overclock/env`. At launch the key is stored in `~/.config/overclock/key` (0600) and **removed from the agent's environment** — commands the agent runs never see it (see Security) |
| `OVERCLOCK_MODEL` | `cerebras/qwen-3.8-27b` | Main agent model |
| `OVERCLOCK_EXPLORE_MODEL` | `gpt-oss-120b` | Route `explore` to a cheaper search model (default). Set to `""` to run explore on the main model. Only the *main* model is per-session; sub-agent model routing is cache-safe. |
| `OVERCLOCK_FAST` | off | Aggressive preset: tighter keep window, 8k output cap |
| `OVERCLOCK_KEEP_TOKENS` / `_HARD_BUDGET_TOKENS` / `_TIGHT_KEEP_TOKENS` / `_MAX_OUT_TOKENS` | 16k / 80k / 4k / 16k | Individual context/output knobs (override the preset) |
| `OVERCLOCK_REASONING` | `low` (session setting) | Wire `reasoning_effort`: `low`/`medium`/`high`/`off`. **Warning:** `off` disables tool calls on qwen-3.8-27b — probe only |
| `OVERCLOCK_SUBAGENT_REASONING` | `low` | Same for sub-agent inner requests |
| `OVERCLOCK_TEMPERATURE` | provider default | Sampling temperature for main-loop requests |
| `OVERCLOCK_DEBUG` | off | Per-request wire-size stats to stderr |
| `OVERCLOCK_API_BASE` | `api.cerebras.ai/v1` | Custom endpoint (proxy/gateway/test). Must be `https://` — `http://` accepted only for localhost |
| `OVERCLOCK_AGENT_DIR` | `~/.overclock/agent` | Sessions, settings, metrics. `OVERCLOCK_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR` also honored (pi's own vars) |


**Update notices:** overclock is built on the [pi](https://github.com/earendil-works/pi) runtime (`@earendil-works/pi-coding-agent`). Pi's own "new version" banner is suppressed; the extension shows an overclock-branded notice instead when a newer pi exists. Upgrade with `npm install @earendil-works/pi-coding-agent@latest` in this repo.

**Pi rebranding:** `scripts/postinstall.mjs` (runs on every `npm install`) writes `piConfig` into pi's `package.json` — pi's built-in rebrand hook — so its resume hint, `--help`, update and crash text all say `overclock`, and its agent-dir env var is `OVERCLOCK_CODING_AGENT_DIR`. It also patches two literals piConfig can't reach; the extension replaces `pi` in the system prompt at runtime. If a pi upgrade rewords those strings, they harmlessly revert to "pi".

## Metrics

Every run appends to `~/.overclock/agent/logs/metrics-*.jsonl`:

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

`npm run eval:fast` runs the eval suite with the `OVERCLOCK_FAST` preset enabled.

## Layout

```
bin/overclock                    # launcher (finds pi + a modern node, sets env)
extensions/overclock/
  index.ts                       # provider registration, hooks, /exit, banner
  context-budget.ts              # transcript pruning + dedupe
  provider-tuning.ts             # clear_thinking, output cap, TPM pacing
  subagents.ts                   # explore / delegate / verify tools
  prompt.ts                      # small-context guidance
  knobs.ts                       # OVERCLOCK_* env knobs
  metrics.ts                     # JSONL metrics
  logo.ts                        # startup banner
  version-check.ts               # overclock-branded pi update notice
test/                            # unit + mock e2e tests (bun)
test/eval/                       # real-API eval harness
```

## Security

overclock is a coding agent: in default mode the model can **read files, edit files, and run arbitrary shell commands as you**. File contents and tool output are instructions to the model — treat an untrusted repo as adversarial input, not passive data.

- **`--safe`** runs a read-only session (`read`, `grep`, `find`, `ls`, `explore` only — no bash, no writes, no `delegate`/`verify`). Use it in repos you wouldn't hand your credentials to, or inside a container/VM for anything actively suspicious.
- **Sub-agent capabilities:** only `explore` is capability-restricted (no write/exec tools). `verify` and `delegate` can run shell commands and modify the workspace — their prompts ask them not to, but prompts are guidelines, not boundaries.
- **API key storage:** the launcher moves `CEREBRAS_API_KEY` into `~/.config/overclock/key` (0600) and unsets it from the agent's environment, so spawned commands can't read it. Other secrets in your shell env are still visible to commands the agent runs — same as running them yourself.
- Session transcripts under `~/.overclock/agent` record what the model saw, verbatim — including secrets it read. The directory is owner-only (0700); treat its contents as sensitive.
- `./.env` in a repo can supply `CEREBRAS_API_KEY` but is **parsed, never executed**, and can't override other config.

Full findings and severity ratings: [SECURITY.md](SECURITY.md). Report vulnerabilities via a GitHub private security advisory.

## Disclaimer

overclock is a **personal, independent project**. It is not affiliated with, endorsed by, sponsored by, or supported by **Cerebras Systems, Inc.** — "Cerebras" is a trademark of Cerebras Systems, Inc., used here only to describe the public inference API this tool calls. It is not an official Cerebras product, and Cerebras does not provide support for it.

Other notes:

- Built on the third-party [pi](https://github.com/earendil-works/pi) runtime — a separate project, likewise unaffiliated with Cerebras.
- Model names (`qwen-3.8-27b`, `gpt-oss-120b`) belong to their respective owners.
- Using the Cerebras API requires your own API key and is governed by Cerebras's own terms of service and pricing — you're responsible for your usage and costs.
- Provided **as is, without warranty of any kind**. It's a coding agent: it edits files and runs commands on your machine. Review its actions; use at your own risk.

overclock itself is [MIT-licensed](LICENSE).
