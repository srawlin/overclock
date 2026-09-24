// Speed-experiment knobs, read from env at call time (each run is one pi
// process, so the eval harness can flip these via the child env and get a clean
// A/B). `OVERCLOCK_FAST=1` enables a recommended, still-safe aggressive preset;
// any individual OVERCLOCK_* env var overrides on top. When nothing is set we
// preserve today's defaults exactly, so behaviour is a no-op unless asked for.

/** Read an OVERCLOCK_* env var, falling back to the legacy FASTCODE_* name. */
export function envVar(name: string): string | undefined {
	return process.env[`OVERCLOCK_${name}`] ?? process.env[`FASTCODE_${name}`]
}

function envInt(name: string, fallback: number): number {
	const raw = envVar(name)
	if (raw === undefined || raw === "") return fallback
	const n = parseInt(raw, 10)
	return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Fast preset on? (the eval runner's `OVERCLOCK_FAST=1`) */
export function fastEnabled(): boolean {
	return envVar("FAST") === "1"
}

/** Tool output kept verbatim (counted back from the newest results). */
export function keepRecentToolTokens(): number {
	return envInt("KEEP_TOKENS", fastEnabled() ? 8_000 : 16_000)
}

/** Above this whole-request estimate, tighten the keep window. */
export function hardBudgetTokens(): number {
	return envInt("HARD_BUDGET_TOKENS", fastEnabled() ? 20_000 : 80_000)
}

/** Keep window once past the hard budget. */
export function tightKeepTokens(): number {
	return envInt("TIGHT_KEEP_TOKENS", fastEnabled() ? 2_000 : 4_000)
}

/** Output-token ceiling reserved per request (also drives Cerebras pacing). */
export function maxCompletionTokens(): number {
	return envInt("MAX_OUT_TOKENS", fastEnabled() ? 8_192 : 16_384)
}

// ── quality/speed experiments ──────────────────────────────────────────────
// Payload-level overrides applied to every provider request, independent of
// pi's thinkingLevel. OVERCLOCK_REASONING maps straight to the wire's
// reasoning_effort — including "off", which Cerebras honors by generating
// zero reasoning tokens (unlike pi's "off" level, which just omits the param
// and leaves the server default = thinking ON).
//
// WARNING — "off" breaks tool calling on qwen-3.8-27b: verified live that
// reasoning_effort:"off" + tools returns tool_calls:null and empty content.
// Only useful for single-shot, tool-free probes. Keep low/medium/high for
// agentic work (eval: low 8/8 @ 30s, medium 8/8 @ 33.5s, off 2/8).
export function reasoningEffortOverride(): string | undefined {
	const raw = envVar("REASONING")?.trim()
	return raw ? raw : undefined
}

/** Same override for sub-agent inner requests (explore/delegate/verify). */
export function subAgentReasoningEffort(): string | undefined {
	const raw = envVar("SUBAGENT_REASONING")?.trim()
	return raw ? raw : undefined
}

/** Optional sampling temperature for all main-loop requests. */
export function temperatureOverride(): number | undefined {
	const raw = envVar("TEMPERATURE")
	if (raw === undefined || raw === "") return undefined
	const n = parseFloat(raw)
	return Number.isFinite(n) && n >= 0 ? n : undefined
}
