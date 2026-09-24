# fastcode speed toolkit — eval, telemetry & experiments

Answers three questions on demand: **Is fastcode fast? How do I measure it? How
do I A/B a speed change without losing agentic quality?**

## 1. Telemetry — do we have logs? **Yes.**

Location: `~/.fastcode/agent/logs/metrics-*.jsonl` (or `$PI_CODING_AGENT_DIR/logs`).
One JSON line per event, **metadata only — no message content** (privacy-safe).
(Previously the only metric was `request`-side estimation; latency, cache-hit,
and per-tool numbers are now captured too.)

| `kind` | What it is | Key fields |
|--------|-----------|------------|
| `request` | per provider request, input side | `msgs`, `estTokens`, `subagent`? |
| `response` | per provider response | `status`, `x_ratelimit_tokens_input_1min`, `x_ratelimit_tokens_remaining_1min`, `subagent`? |
| `usage` | per finalized assistant msg | `input`, `cacheRead`, `output`, `totalTokens`, `stopReason` |
| `tool` | **per tool call** | `name`, `ms`, `isError`, `subagent`? |
| `turn` | **per LLM turn** (main loop) | `model`, `firstTokenMs`(TTFT), `totalMs`, `outputTok`, `tokensPerSec`, `toolCalls` |
| `context` | per outgoing request (context-budget transform) | `msgs`, `estTokens`, `stubbed`, `deduped`, `truncatedArgs` |
| `subagent` | per sub-agent (explore/delegate/verify) | `tool`, `model`, `ms`, `outputTokens` |
| `run_end` | per user message (rollup) | `totalMs`, `turns`, `inputTokens`, `cacheRead`, `outputTokens`, `toolCalls`, `toolErrors` |
| `error` | any request/tool failure | `source`, `code` |

Reading the numbers:
- **`turn.firstTokenMs` / wall** → server responsiveness (Cerebras is fast for short prompts; `cacheRead` reuse matters more than raw TTFT once context is large).
- **`request.estTokens` & `usage.input`** → the real latency lever as context grows.
- **`turn.tokensPerSec`** → output throughput.
- **`tool.ms`** → whether tool IO dominates.

## 2. Eval — the scoreboard

`test/eval/run.mjs` runs a fixed task suite end-to-end through the **real fastcode
CLI** (fresh copy of a fixture per task), grades correctness with the fixture's own
tests + a file-diff guard, and emits a JSON report to `test/eval/results/`.

```sh
node test/eval/run.mjs                 # default model, baseline knobs
node test/eval/run.mjs --only aggr-scan  # one task (prefix match)
node test/eval/run.mjs --repeat 3      # repeat to wash out per-run noise
node test/eval/run.mjs --keep          # keep scratch dirs to inspect a failure
FASTCODE_FAST=1 node test/eval/run.mjs # speed-optimized preset, A/B vs baseline
FASTCODE_MODEL=cerebras/gpt-oss-120b node test/eval/run.mjs   # compare models
```
(`npm run eval` and `npm run eval:fast` wrap the first and fourth.)

Sample output:
```
  PASS  fix-bug#1: 2.5s  4turns  4tools  ttft 36ms  387.5tok/s  in=15650tok (cache 11264)
  SUMMARY  pass 3/3 (100%)  total wall 10.4s
```

**The suite** (extend by appending to `TASKS` in `run.mjs`). Each task names its own
`fixture` (copied to a scratch dir per run, so fixtures are never mutated):
- **fix-bug** (fixture `calc`) — find & fix a logic bug; graded by the fixture's tests
  + a diff guard (`filesAllowed`, only the expected file may change). Verifies we
  **write correct code**, not just edits.
- **add-feature** (fixture `calc-fixed`, already green) — implement `lcm()` + tests.
  Verifies additive editing + writing new tests, with no confounding bug.
- **explore-then-fix** (fixture `calc`) — locate the bug **via the explore sub-agent**
  first, then fix. Guards the reasoning/sub-agent path.
- **aggr-scan** (fixture `aggr`) — read **12 module files** and sum their `COUNT`/
  `WEIGHT` into a manifest. Forces many large tool-result round-trips so request wire
  size is large — the regime the context-budget knobs act on.

Fixtures: `test/eval/fixtures/{calc,calc-fixed,aggr}`. `calc` = a Node lib with a
deliberate `factorial` off-by-one bug + a suite that's green only after the fix;
`calc-fixed` = the same with the bug pre-fixed; `aggr` = 12 deterministic modules +
`tests/verify_manifest.mjs` (hard-codes expected sums 172/330 and re-checks sources so
a correct manifest can't be produced by editing the constants).

**Interpreting a result:** a speed change *wins* when `in=` (input tokens → the
latency driver) and wall clock drop **while pass rate and output quality hold**.
Because grading is by the real test suite + diff, the harness guards against the
"fast because it stopped thinking / stopped checking" failure mode.

## 3. Experiments — faster without losing intelligence

All levers are env-knobbed in `extensions/fastcode/knobs.ts`. `FASTCODE_FAST=1`
applies a recommended, still-safe preset; any individual `FASTCODE_*` value overrides
on top. **Defaults are unchanged unless you set a knob**, so any regression is one
env var away from the baseline.

| Knob | Env | default / fast | What it does | Intelligence risk |
|------|-----|----------------|--------------|------------------|
| keep-recent | `FASTCODE_KEEP_RECENT_TOOL_TOKENS` | 16000 / 8000 | Cap on how much *old* tool output stays verbatim. Smaller ⇒ smaller prompt ⇒ more cache reuse ⇒ lower TTFT on long sessions. | None — old results stub to a pointer, re-readable via tool. |
| hard budget | `FASTCODE_HARD_BUDGET_TOKENS` | 80000 / 20000 | Above this, drop to the tight keep window. | None. |
| tighten-keep | `FASTCODE_TIGHT_KEEP_TOKENS` | 4000 / 2000 | The tight-mode keep window. | None. |
| output reservation | `FASTCODE_MAX_COMPLETION_TOKENS` | 16384 / 8192 | Cerebras bills/limits on input + `max_completion_tokens`; a smaller cap slashes reserved quota + pacing sleep. | None — typical agentic turns emit <4k; long writes still covered. |
| explore model | `FASTCODE_EXPLORE_MODEL` | (same) | Run the read-only `explore` sub-agent on a cheaper/faster model. | Low — bounded + result-capped; raise only if explore quality drops here. |
| fast preset | `FASTCODE_FAST=1` | off | Combines the above into a conservative speed preset. | Low — use for A/B; revert a single knob if one task regresses. |

**Measured A/B (this machine, qwen-3.8-27b, `aggr-scan` ~3.5s, x3)** — honest result:
on the small fixtures the pruning knob has little headroom (the model keeps wire tight
already, ~33–46k in), so `FASTCODE_FAST` is ~a wash here; it earns its keep on
longer real sessions where the keep window would otherwise balloon past 80k.
Lever with clear signal **today** is model choice, which the harness A/Bs directly:
- `aggr-scan`, gpt-oss-120b avg ~7.7 turns vs 27B ~4.3 turns (120B plans more but is
  often right in fewer correct edits), 27B often lower wall time on the micro-tasks.

Suggested experiment loop (cheap → expensive):
1. **Baseline** — `node test/eval/run.mjs --repeat 3`. Record pass rate + `in=` + wall.
2. **Tighten context** — `FASTCODE_FAST=1 node test/eval/run.mjs --repeat 3`. Expect a
   win on long sessions; confirm no task drops.
3. **Cheaper explore** — `FASTCODE_EXPLORE_MODEL=cerebras/gpt-oss-120b …` to keep the
   sub-agent path fast on a cheaper model (watches explore quality in the eval).
4. **Compare models** — `FASTCODE_MODEL=cerebras/qwen-3.8-27b` vs `gpt-oss-120b`.

Bigger structural levers these knobs deliberately do NOT turn (enable only if a task
proves it safe): removing reasoning, capping tool output harder, or disabling
sub-agents. Those trade away the intelligence this eval exists to protect.

## 4. Adding a task

Append to `TASKS` in `test/eval/run.mjs`:
```js
{
  name: "your-task",
  fixture: "your-fixture-d",          // dir under test/eval/fixtures/
  hint: "…instructions to the agent…",
  verify: "node test/something.test.js",  // run from the fixture root
  filesAllowed: ["src/lib.js"],       // optional diff guard (code may only touch these)
}
```
Keep `hint` deterministic and grade with a real test so quality drift is caught.