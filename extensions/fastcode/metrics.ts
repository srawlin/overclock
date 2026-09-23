import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Append-only JSONL metrics for fastcode. One line per event — request
// estimates (from the context transform), provider responses (status +
// rate-limit headers), assistant usage, and sub-agent summaries. Numbers
// only: no message content is ever written here.

let file: string | undefined
let sessionId = "unknown"

export function initMetrics() {
	if (file) return
	const dir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "logs")
	mkdirSync(dir, { recursive: true })
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
