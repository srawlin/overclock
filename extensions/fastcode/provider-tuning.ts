import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { logMetrics } from "./metrics"

// Cerebras rate limiting estimates consumption as input + max_completion_tokens
// before the request runs. pi defaults it to the model's 32-40k ceiling, so
// every turn reserves far more output quota than an agentic step needs.
// Typical tool-call turns finish under ~4k output; 16k keeps long writes safe
// while roughly halving the reservation.
const MAX_COMPLETION_TOKENS = 16_384

// Cerebras Developer limits: 750k total tokens/min (cached + uncached count
// equally). Fast steps plus parallel tool calls can burst past that, and 429
// retries cost more time than pacing does. Track a rolling 60s window of
// estimated consumption (input + reserved output) and sleep briefly rather
// than trip the limit. Covers sub-agent traffic too via paceRequest below.
const SOFT_TPM = 600_000
const WINDOW_MS = 60_000
const MAX_SLEEP_MS = 10_000
const window: { ts: number; tokens: number }[] = []

/** Soft token-per-minute pacing shared by main and sub-agent requests. */
export async function paceRequest(estimatedTokens: number): Promise<void> {
	const now = Date.now()
	while (window.length && now - window[0].ts > WINDOW_MS) window.shift()
	let used = window.reduce((sum, w) => sum + w.tokens, 0)
	if (used + estimatedTokens > SOFT_TPM) {
		let wake = now
		let acc = used
		for (const w of window) {
			if (acc + estimatedTokens <= SOFT_TPM) break
			acc -= w.tokens
			wake = w.ts + WINDOW_MS
		}
		const delay = Math.min(wake - now, MAX_SLEEP_MS)
		if (delay > 0) {
			logMetrics({ kind: "pace", delayMs: delay, windowTokens: used })
			await new Promise((resolve) => setTimeout(resolve, delay))
		}
	}
	window.push({ ts: Date.now(), tokens: estimatedTokens })
}

export function installProviderTuning(pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event) => {
		const p = event.payload as Record<string, unknown>
		const isQwen = typeof p.model === "string" && p.model.includes("qwen")
		if (isQwen) {
			// pi-ai already omits assistant thinking from the wire when no
			// thinkingSignature is set (Cerebras never sets one), so deleting
			// `reasoning` is defensive only — it protects against future pi-ai
			// versions replaying reasoning, which would re-bloat the prompt.
			// clear_thinking is the server-side equivalent (Qwen-only parameter).
			p.clear_thinking = true
			for (const m of (p.messages as { role?: string; reasoning?: string }[] | undefined) ?? []) {
				if (m.role === "assistant" && m.reasoning !== undefined) delete m.reasoning
			}

			const current = typeof p.max_completion_tokens === "number" ? p.max_completion_tokens : undefined
			if (current === undefined || current > MAX_COMPLETION_TOKENS) {
				p.max_completion_tokens = MAX_COMPLETION_TOKENS
			}
		}

		const reserved = typeof p.max_completion_tokens === "number" ? p.max_completion_tokens : MAX_COMPLETION_TOKENS
		await paceRequest(Math.ceil(JSON.stringify(p).length / 4) + reserved)
		return p
	})
}
