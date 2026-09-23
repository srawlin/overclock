import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { installContextBudget } from "./context-budget"
import { installProviderTuning } from "./provider-tuning"
import { CEREBRAS_MODELS } from "./model"
import { FASTCODE_GUIDANCE } from "./prompt"
import { initMetrics, logMetrics, setMetricsSession } from "./metrics"
import { registerSubAgentTools } from "./subagents"

let sessionCaptured = false
function captureSession(ctx: ExtensionContext | undefined) {
	if (sessionCaptured) return
	sessionCaptured = true
	setMetricsSession((ctx?.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.())
}

export default function fastcode(pi: ExtensionAPI) {
	// Cerebras catalog: qwen-3.8-27b is too new for pi's built-in list.
	pi.registerProvider("cerebras", {
		baseUrl: "https://api.cerebras.ai/v1",
		apiKey: "CEREBRAS_API_KEY",
		api: "openai-completions",
		models: CEREBRAS_MODELS,
	})

	initMetrics()
	installContextBudget(pi)
	installProviderTuning(pi)
	registerSubAgentTools(pi)

	// FASTCODE_DEBUG=1 logs the outgoing request size each turn.
	pi.on("before_provider_request", (event, ctx) => {
		captureSession(ctx)
		if (!process.env.FASTCODE_DEBUG) return
		const p = event.payload as Record<string, unknown> & { messages?: { role?: string; reasoning?: string }[] }
		const reasoningChars = (p.messages ?? []).reduce(
			(sum, m) => sum + (typeof m.reasoning === "string" ? m.reasoning.length : 0),
			0,
		)
		console.error(
			`[fastcode] request: ${p.messages?.length ?? "?"} messages, ~${Math.round(
				JSON.stringify(p).length / 4,
			)} tokens | max_completion_tokens=${p.max_completion_tokens ?? p.max_tokens ?? "unset"} reasoning_effort=${
				p.reasoning_effort ?? "unset"
			} clear_thinking=${p.clear_thinking ?? "unset"} history_reasoning~${Math.round(reasoningChars / 4)}tok`,
		)
	})

	// Provider response: status + Cerebras rate-limit headers → metrics log.
	pi.on("after_provider_response", (event) => {
		const headers = (event as { headers?: Headers | Record<string, string> }).headers
		const get = (name: string) =>
			headers instanceof Headers ? headers.get(name) : ((headers as Record<string, string> | undefined)?.[name] ?? null)
		logMetrics({
			kind: "response",
			status: (event as { status?: number }).status,
			rpmRemaining: get("x-ratelimit-remaining-requests"),
			tpmRemaining: get("x-ratelimit-remaining-tokens"),
			rpmReset: get("x-ratelimit-reset-requests"),
			tpmReset: get("x-ratelimit-reset-tokens"),
		})
	})

	// Finalized assistant messages carry server-reported usage — the ground
	// truth for wire size, cache hits, and output volume.
	pi.on("message_end", (event) => {
		const m = event.message as { role?: string; usage?: Record<string, unknown>; stopReason?: string }
		if (m.role !== "assistant" || !m.usage) return
		const u = m.usage as { input?: number; cacheRead?: number; output?: number; totalTokens?: number }
		logMetrics({
			kind: "usage",
			input: u.input,
			cacheRead: u.cacheRead,
			output: u.output,
			totalTokens: u.totalTokens,
			stopReason: m.stopReason,
		})
	})

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${FASTCODE_GUIDANCE}`,
	}))
}
