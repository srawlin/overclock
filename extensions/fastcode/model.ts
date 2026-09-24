import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent"

// cacheRead is derived as input * CACHE_READ_DISCOUNT (never hard-code it).
// ASSUMPTION: Cerebras bills cached reads at ~10% of the input price (the
// common prefix-cache rate). Update this ONE constant when the real rate is
// confirmed for these fintune models. It changed from 0 so the harness/telemetry
// no longer under-prices the value of a warm main-session cache.
// Confirm: cerebras pricing docs / your account's billing.
const CACHE_READ_DISCOUNT = 0.1

// Cerebras thinking levels, matching pi's built-in catalog: only low/medium/
// high are real — off/minimal/xhigh/max are null so the /thinking selector
// hides them and cycling skips them. reasoning_effort goes on the wire as-is.
const CEREBRAS_THINKING_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const

export const CEREBRAS_MODELS: ProviderModelConfig[] = [
	{
		id: "qwen-3.8-27b",
		name: "Qwen 3.8 27B",
		reasoning: true,
		thinkingLevelMap: CEREBRAS_THINKING_MAP,
		input: ["text", "image"],
		cost: { input: 0.99, output: 1.49, cacheRead: 0.99 * CACHE_READ_DISCOUNT, cacheWrite: 0 },
		// pi's built-in catalog says 65_536, but real sessions have sent
		// ~91k input tokens successfully — the 131k figure is correct for
		// this deployment. Kept deliberately above the hard budget (80k).
		contextWindow: 131_072,
		maxTokens: 32_768,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: true,
		thinkingLevelMap: CEREBRAS_THINKING_MAP,
		input: ["text"],
		cost: { input: 0.35, output: 0.75, cacheRead: 0.35 * CACHE_READ_DISCOUNT, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 40_960,
	},
]
