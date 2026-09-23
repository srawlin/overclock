import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent"

export const CEREBRAS_MODELS: ProviderModelConfig[] = [
	{
		id: "qwen-3.8-27b",
		name: "Qwen 3.8 27B",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.99, output: 1.49, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 40_960,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.25, output: 0.69, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	},
]
