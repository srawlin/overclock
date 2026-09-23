import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

// Cerebras rate limiting estimates consumption as input + max_completion_tokens
// before the request runs. pi defaults it to the model's 32-40k ceiling, so
// every turn reserves far more output quota than an agentic step needs.
// Typical tool-call turns finish under ~4k output; 16k keeps long writes safe
// while roughly halving the reservation.
const MAX_COMPLETION_TOKENS = 16_384

export function installProviderTuning(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const p = event.payload as Record<string, unknown>
		if (typeof p.model !== "string" || !p.model.includes("qwen")) return

		// Prior reasoning is dead weight for a coding agent — the final answer
		// and tool results carry the useful state. Drop it client-side (saves
		// wire bytes and keeps it out of the cached prefix); clear_thinking is
		// the belt-and-suspenders server-side equivalent. (Qwen-only parameter.)
		p.clear_thinking = true
		for (const m of (p.messages as { role?: string; reasoning?: string }[] | undefined) ?? []) {
			if (m.role === "assistant" && m.reasoning !== undefined) delete m.reasoning
		}

		const current = typeof p.max_completion_tokens === "number" ? p.max_completion_tokens : undefined
		if (current === undefined || current > MAX_COMPLETION_TOKENS) {
			p.max_completion_tokens = MAX_COMPLETION_TOKENS
		}
		return p
	})
}
