import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { installContextBudget } from "./context-budget"
import { installProviderTuning } from "./provider-tuning"
import { CEREBRAS_MODELS } from "./model"
import { FASTCODE_GUIDANCE } from "./prompt"
import {
	initMetrics,
	logMetrics,
	setMetricsSession,
	toolEnd,
	toolStart,
	turnEnd,
	turnFirstToken,
	turnStart,
} from "./metrics"
import { registerSubAgentTools } from "./subagents"
import { logoComponent } from "./logo"
import { checkPiUpdate } from "./version-check"

let sessionCaptured = false
function captureSession(ctx: ExtensionContext | undefined) {
	if (sessionCaptured) return
	sessionCaptured = true
	setMetricsSession((ctx?.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.())
}

// ---- latency telemetry ----------------------------------------------------
// The "is fastcode fast?" signal. The main loop runs one assistant turn at a
// time, so a single activeKey suffices; sub-agent inner requests bypass
// extension hooks entirely (they self-report via the `subagent` metric), so
// these `turn`/`tool` records are main-loop only — no double counting.
let activeTurnKey: string | undefined
let turnSeq = 0

// Per-run rollup, reset at agent_start. Lets a single number (wall + turns +
// throughput) compare one run vs. another.
const run = {
	t0: 0,
	turns: 0,
	outputTok: 0,
	firstTokSum: 0,
	firstTokMin: Infinity,
	toolTotalMs: 0,
	nTools: 0,
	toolErrs: 0,
}

function contentPartTypes(message: unknown): string[] {
	const content = (message as { content?: unknown } | undefined)?.content
	if (!Array.isArray(content)) return []
	return (content as { type?: string }[]).map((p) => p?.type).filter((t): t is string => typeof t === "string")
}

// Content that means the assistant has actually started emitting (text, a
// thinking token, or a tool call) — firstTokenMs marks that moment, not the
// empty skeleton that arrives in message_start.
const HAS_OUTPUT = (types: string[]) => types.some((t) => t === "text" || t === "thinking" || t === "toolCall")

export default function fastcode(pi: ExtensionAPI) {
	// Cerebras catalog: qwen-3.8-27b is too new for pi's built-in list.
	// FASTCODE_API_BASE overrides the endpoint — used by the e2e test's local
	// mock server and handy for proxies/gateways.
	pi.registerProvider("cerebras", {
		baseUrl: process.env.FASTCODE_API_BASE ?? "https://api.cerebras.ai/v1",
		// pi >= 0.74 treats apiKey as a literal/interpolation: "$VAR" reads the
		// env var; a bare name would be sent as the literal key (→ 401).
		apiKey: "$CEREBRAS_API_KEY",
		api: "openai-completions",
		models: CEREBRAS_MODELS,
	})

	initMetrics()
	installContextBudget(pi)
	installProviderTuning(pi)
	registerSubAgentTools(pi)

	// Startup banner — replaces pi's built-in header in interactive mode.
	// session_start fires after ui.start(), so the header slot exists.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return
		ctx.ui.setHeader(() => logoComponent())
		checkPiUpdate((m, t) => ctx.ui.notify(m, t))
	})

	// pi's built-in exit is /quit (or Ctrl-D); /exit is not a command and would
	// otherwise be submitted to the model as a literal prompt — the agent runs a
	// turn, then sits idle forever looking like a hung exit.
	// shutdown() sets shutdownRequested and exits immediately when idle; abort()
	// ends an in-flight turn so agent_end triggers the deferred shutdown.
	pi.registerCommand("exit", {
		description: "Exit fastcode",
		handler: async (_args, ctx) => {
			ctx.shutdown()
			if (!ctx.isIdle()) ctx.abort()
		},
	})

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
		const m = event.message as {
			role?: string
			model?: string
			usage?: Record<string, unknown>
			stopReason?: string
			content?: { type?: string }[]
		}
		if (m.role !== "assistant") return
		const u = m.usage as { input?: number; cacheRead?: number; output?: number; totalTokens?: number } | undefined
		// Per-turn latency: TTFT (start → first emitted token) + total (start →
		// end), output tokens, and derived throughput.
		if (activeTurnKey !== undefined) {
			const rec = turnEnd(activeTurnKey)
			activeTurnKey = undefined
			if (rec) {
				const outputTok = u?.output ?? rec.outputTok
				const toolCalls = (m.content ?? []).filter((p) => p?.type === "toolCall").length
				logMetrics({
					kind: "turn",
					model: m.model,
					firstTokenMs: rec.firstTokenMs,
					totalMs: rec.totalMs,
					outputTok,
					tokensPerSec: rec.totalMs > 0 ? Math.round(((outputTok ?? 0) / (rec.totalMs / 1000)) * 10) / 10 : 0,
					toolCalls,
					stopReason: m.stopReason,
					usage: u ?? undefined,
				})
				// run rollup
				if (run.t0) {
					run.turns++
					run.outputTok += outputTok ?? 0
					run.firstTokSum += rec.firstTokenMs
					run.firstTokMin = Math.min(run.firstTokMin, rec.firstTokenMs)
				}
			}
		}
		if (!u) return
		logMetrics({
			kind: "usage",
			input: u.input,
			cacheRead: u.cacheRead,
			output: u.output,
			totalTokens: u.totalTokens,
			stopReason: m.stopReason,
		})
	})

	// TTFT anchor: mark the first emitted content token of the in-flight turn.
	pi.on("message_start", (event) => {
		const m = event.message as { role?: string }
		if (m.role === "assistant") {
			activeTurnKey = `t${++turnSeq}`
			turnStart(activeTurnKey)
		}
	})
	pi.on("message_update", (event) => {
		const m = event.message as { role?: string }
		if (m.role === "assistant" && activeTurnKey !== undefined && HAS_OUTPUT(contentPartTypes(m))) {
			turnFirstToken(activeTurnKey)
		}
	})

	// Per-tool-call latency (main loop only).
	pi.on("tool_execution_start", (event) => {
		toolStart(event.toolCallId, event.toolName)
	})
	pi.on("tool_execution_end", (event) => {
		const rec = toolEnd(event.toolCallId, event.isError)
		if (!rec) return
		logMetrics({ kind: "tool", name: rec.name, ms: rec.ms, isError: rec.isError })
		if (run.t0) {
			run.toolTotalMs += rec.ms
			run.nTools++
			if (rec.isError) run.toolErrs++
		}
	})

	// Whole-run rollup: wall clock, turns, throughput, tool time.
	pi.on("agent_start", () => {
		turnSeq = 0
		activeTurnKey = undefined
		Object.assign(run, { t0: Date.now(), turns: 0, outputTok: 0, firstTokSum: 0, firstTokMin: Infinity, toolTotalMs: 0, nTools: 0, toolErrs: 0 })
	})
	pi.on("agent_end", () => {
		if (!run.t0) return
		const wallMs = Date.now() - run.t0
		logMetrics({
			kind: "run_end",
			wallMs,
			turns: run.turns,
			outputTok: run.outputTok,
			avgFirstTokenMs: run.turns ? Math.round(run.firstTokSum / run.turns) : 0,
			bestFirstTokenMs: run.firstTokMin === Infinity ? 0 : run.firstTokMin,
			tokensPerSec: wallMs > 0 ? Math.round((run.outputTok / (wallMs / 1000)) * 10) / 10 : 0,
			toolTotalMs: run.toolTotalMs,
			nTools: run.nTools,
			toolErrs: run.toolErrs,
		})
		run.t0 = 0
	})

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${FASTCODE_GUIDANCE}`,
	}))
}
