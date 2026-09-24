import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent"

// cacheRead is derived as input * CACHE_READ_DISCOUNT (never hard-code it).
// ASSUMPTION: Cerebras bills cached reads at ~10% of the input price (the
// common prefix-cache rate). Update this ONE constant when the real rate is
// confirmed for these fintune models. It changed from 0 so the harness/telemetry
// no longer under-prices the value of a warm main-session cache.
// Confirm: cerebras pricing docs / your account's billing.
const CACHE_READ_DISCOUNT = 0.1

export const CEREBRAS_MODELS: ProviderModelConfig[] = [
	{
		id: "qwen-3.8-27b",
		name: "Qwen 3.8 27B",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.99, output: 1.49, cacheRead: 0.99 * CACHE_READ_DISCOUNT, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 40_960,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.25, output: 0.69, cacheRead: 0.25 * CACHE_READ_DISCOUNT, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	},
]