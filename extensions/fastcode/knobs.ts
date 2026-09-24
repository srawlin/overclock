// Speed-experiment knobs, read from env at call time (each run is one pi
// process, so the eval harness can flip these via the child env and get a clean
// A/B). `FASTCODE_FAST=1` enables a recommended, still-safe aggressive preset;
// any individual FASTCODE_* env var overrides on top. When nothing is set we
// preserve today's defaults exactly, so behaviour is a no-op unless asked for.

function envInt(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	const n = parseInt(raw, 10)
	return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Fast preset on? (the eval runner's `FASTCODE_FAST=1`) */
export function fastEnabled(): boolean {
	return process.env.FASTCODE_FAST === "1"
}

/** Tool output kept verbatim (counted back from the newest results). */
export function keepRecentToolTokens(): number {
	return envInt("FASTCODE_KEEP_TOKENS", fastEnabled() ? 8_000 : 16_000)
}

/** Above this whole-request estimate, tighten the keep window. */
export function hardBudgetTokens(): number {
	return envInt("FASTCODE_HARD_BUDGET_TOKENS", fastEnabled() ? 20_000 : 80_000)
}

/** Keep window once past the hard budget. */
export function tightKeepTokens(): number {
	return envInt("FASTCODE_TIGHT_KEEP_TOKENS", fastEnabled() ? 2_000 : 4_000)
}

/** Output-token ceiling reserved per request (also drives Cerebras pacing). */
export function maxCompletionTokens(): number {
	return envInt("FASTCODE_MAX_OUT_TOKENS", fastEnabled() ? 8_192 : 16_384)
}