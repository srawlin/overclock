import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Append-only JSONL metrics for overclock. One line per event — request
// estimates (from the context transform), provider responses (status +
// rate-limit headers), assistant usage, per-turn/tool latency, and sub-agent
// summaries. Numbers only: no message content is ever written here.
//
// Latency kinds (the "is it fast?" signal):
//   turn      — per LLM turn: firstTokenMs (TTFT), totalMs, outputTok, tokens/sec, toolCalls
//   tool      — per tool call: name, ms, isError
//   run_end   — whole-run rollup printed at agent_end (see index.ts)

let file: string | undefined
let sessionId = "unknown"

export function initMetrics() {
	if (file) return
	const dir = join(
		process.env.OVERCLOCK_CODING_AGENT_DIR ??
			process.env.PI_CODING_AGENT_DIR ??
			join(homedir(), ".overclock", "agent"),
		"logs",
	)
	mkdirSync(dir, { recursive: true })
	try {
		chmodSync(dir, 0o700) // logs live under the agent dir — owner-only (F6)
	} catch {}
	file = join(dir, `metrics-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`)
}

export function setMetricsSession(id: string | undefined) {
	if (id) sessionId = id
}

export function logMetrics(record: Record<string, unknown>) {
	if (!file) return
	try {
		appendFileSync(file, `${JSON.stringify({ t: Date.now(), session: sessionId, ...record })}\n`)
	} catch {}
}

// ---- per-turn latency ---------------------------------------------------
// One entry per assistant message in flight. Keyed by a stable id we mint at
// message_start (the in-progress message has no stable id yet).
const turnTimers = new Map<string, { t0: number; firstTok: number; outputTok: number; toolCalls: number }>()

export function turnStart(key: string) {
	turnTimers.set(key, { t0: Date.now(), firstTok: 0, outputTok: 0, toolCalls: 0 })
}

export function turnFirstToken(key: string) {
	const t = turnTimers.get(key)
	if (t && !t.firstTok) t.firstTok = Date.now()
}

export function turnOutput(key: string, tokens: number) {
	const t = turnTimers.get(key)
	if (t) t.outputTok += tokens
}

export function turnToolCall(key: string) {
	const t = turnTimers.get(key)
	if (t) t.toolCalls += 1
}

/** Return and clear the turn record, or undefined if the turn is not tracked. */
export function turnEnd(key: string): { firstTokenMs: number; totalMs: number; outputTok: number; outputTokPerSec: number; toolCalls: number } | undefined {
	const t = turnTimers.get(key)
	if (!t) return undefined
	turnTimers.delete(key)
	const totalMs = Date.now() - t.t0
	const firstTokenMs = t.firstTok ? t.firstTok - t.t0 : totalMs // nothing streamed → treat as full latency
	const secs = totalMs / 1000 || 1e-6
	return {
		firstTokenMs,
		totalMs,
		outputTok: t.outputTok,
		outputTokPerSec: Math.round((t.outputTok / secs) * 10) / 10,
		toolCalls: t.toolCalls,
	}
}

// ---- per-tool-call latency ------------------------------------------------
const toolTimers = new Map<string, { t0: number; name: string }>()

export function toolStart(toolCallId: string, name: string) {
	toolTimers.set(toolCallId, { t0: Date.now(), name })
}

/** Return and clear the tool record ({name, ms, isError}) or undefined. */
export function toolEnd(toolCallId: string, isError: boolean): { name: string; ms: number; isError: boolean } | undefined {
	const t = toolTimers.get(toolCallId)
	if (!t) return undefined
	toolTimers.delete(toolCallId)
	return { name: t.name, ms: Date.now() - t.t0, isError }
}