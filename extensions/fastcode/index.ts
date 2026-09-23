import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { installContextBudget } from "./context-budget"
import { CEREBRAS_MODELS } from "./model"
import { FASTCODE_GUIDANCE } from "./prompt"
import { registerSubAgentTools } from "./subagents"

export default function fastcode(pi: ExtensionAPI) {
	// Cerebras catalog: qwen-3.8-27b is too new for pi's built-in list.
	pi.registerProvider("cerebras", {
		baseUrl: "https://api.cerebras.ai/v1",
		apiKey: "CEREBRAS_API_KEY",
		api: "openai-completions",
		models: CEREBRAS_MODELS,
	})

	installContextBudget(pi)
	registerSubAgentTools(pi)

	// FASTCODE_DEBUG=1 logs the outgoing request size each turn.
	pi.on("before_provider_request", (event) => {
		if (!process.env.FASTCODE_DEBUG) return
		const payload = event.payload as { messages?: unknown[] }
		console.error(
			`[fastcode] request: ${payload.messages?.length ?? "?"} messages, ~${Math.round(
				JSON.stringify(payload).length / 4,
			)} tokens`,
		)
	})

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${FASTCODE_GUIDANCE}`,
	}))
}
