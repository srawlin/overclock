import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai"
import { estimateTokens, type ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { logMetrics } from "./metrics"
import { hardBudgetTokens, keepRecentToolTokens, tightKeepTokens } from "./knobs"

// Cerebras qwen-3.8-27b: 128k context. Every request re-sends the transcript,
// so steady-state size drives both TTFT and cost. Old tool outputs are the
// dominant bulk — replace them with deterministic stubs once they fall behind
// a keep window. Stubs never change afterwards, so the wire prefix stays
// stable for Cerebras prefix caching.
//
// Two failure modes shaped this policy:
// - Keep window too small → the model notices stubs, re-fetches the same file,
//   gets pruned again, re-fetches... an amnesia loop that burns hundreds of
//   requests. Mitigations: a wider window, dedupe (repeated fetches of the
//   same target keep only the freshest result), and stub text that does NOT
//   instruct the model to re-run anything.
// - Accumulators that never shrink: toolCall arguments (huge bash commands,
//   write/edit payloads) ride the wire forever. Long arg values get truncated
//   once they're behind the boundary.

/** Tool output kept verbatim, counted back from the newest results. */
// Size thresholds below are the non-fast baseline. The keep-window constants
// (KEEP_RECENT / HARD_BUDGET / TIGHT_KEEP) became knobs — see knobs.ts; the
// `FASTCODE_FAST=1` preset tightens them to slash wire size and TTFT.
/** Don't stub outputs smaller than this — not worth the churn. */
const MIN_PRUNE_CHARS = 800
/** A single in-flight result larger than this gets middle-truncated so one
 *  oversized dump can't eat the whole window before the model even sees it. */
const IN_FLIGHT_MAX_CHARS = 32_000
/** String argument values older than the boundary get head-truncated. */
const ARG_MAX_CHARS = 600

export interface PruneStats {
	estTokens: number
	inFlightTokens: number
	stubbedResults: number
	dedupedResults: number
	truncatedArgs: number
}

interface ToolCallInfo {
	name: string
	args: Record<string, any>
}

function collectToolCalls(messages: AgentMessage[]) {
	const map = new Map<string, ToolCallInfo>()
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const part of message.content) {
			if (part.type === "toolCall") map.set(part.id, { name: part.name, args: part.arguments })
		}
	}
	return map
}

function textChars(message: ToolResultMessage) {
	return message.content.reduce((sum, part) => (part.type === "text" ? sum + part.text.length : sum), 0)
}

function hintFor(info: ToolCallInfo | undefined, toolName: string) {
	const args = info?.args ?? {}
	switch (info?.name ?? toolName) {
		case "read":
		case "edit":
		case "write": {
			const range = args.offset != null ? ` (offset ${args.offset}${args.limit != null ? `, limit ${args.limit}` : ""})` : ""
			return `${args.path ?? "?"}${range}`
		}
		case "bash": {
			const command = String(args.command ?? "?")
			return command.length > 80 ? `${command.slice(0, 80)}…` : command
		}
		case "grep":
			return `${args.pattern ?? "?"} in ${args.path ?? "."}`
		case "find":
		case "ls":
			return `${args.pattern ?? args.path ?? "."}`
		default:
			return toolName
	}
}

/** Identity of what a tool call fetched — repeated fetches of the same key
 *  are duplicates; only the freshest result is worth keeping. */
function dedupeKey(message: ToolResultMessage, info: ToolCallInfo | undefined) {
	const args = info?.args ?? {}
	switch (info?.name ?? message.toolName) {
		case "read":
			return `read:${args.path ?? "?"}:${args.offset ?? 0}:${args.limit ?? 0}`
		case "edit":
		case "write":
			return `${message.toolName}:${args.path ?? "?"}`
		case "bash":
			return `bash:${String(args.command ?? "?")}`
		case "grep":
			return `grep:${args.pattern ?? "?"}:${args.path ?? "."}`
		case "find":
		case "ls":
			return `${message.toolName}:${args.pattern ?? args.path ?? "."}`
		default:
			return undefined
	}
}

function stub(message: ToolResultMessage, info: ToolCallInfo | undefined, reason: "elided" | "superseded"): ToolResultMessage {
	const tokens = Math.max(1, Math.round(textChars(message) / 4))
	return {
		...message,
		content: [
			{
				type: "text",
				text: `[${message.toolName} output ${reason}: ${hintFor(info, message.toolName)}, ~${tokens} tokens]`,
			} satisfies TextContent,
		],
	}
}

function truncateMiddle(text: string, maxChars: number) {
	const head = Math.floor(maxChars * 0.7)
	const tail = maxChars - head
	return `${text.slice(0, head)}\n[… elided ${text.length - maxChars} chars …]\n${text.slice(text.length - tail)}`
}

function truncateArgs(value: any): any {
	if (typeof value === "string") {
		return value.length > ARG_MAX_CHARS ? `${value.slice(0, ARG_MAX_CHARS)}…[elided]` : value
	}
	if (Array.isArray(value)) {
		let changed = false
		const out = value.map((v) => {
			const next = truncateArgs(v)
			if (next !== v) changed = true
			return next
		})
		return changed ? out : value
	}
	if (value && typeof value === "object") {
		let changed = false
		const out: Record<string, any> = {}
		for (const [k, v] of Object.entries(value)) {
			const next = truncateArgs(v)
			if (next !== v) changed = true
			out[k] = next
		}
		return changed ? out : value
	}
	return value
}

const STUB_RE = /^\[\S+ output (elided|superseded|pruned):/
function isStub(m: ToolResultMessage) {
	return m.content.length === 1 && m.content[0].type === "text" && STUB_RE.test(m.content[0].text)
}

// estimateTokens counts thinking parts, but pi-ai omits them from the wire
// (no thinkingSignature on Cerebras), so they inflate any size estimate.
function thinkingTokens(m: AgentMessage) {
	if (m.role !== "assistant" || !Array.isArray(m.content)) return 0
	return m.content.reduce(
		(sum, part) => (part.type === "thinking" ? sum + Math.ceil(part.thinking.length / 4) : sum),
		0,
	)
}

function wireTokens(m: AgentMessage) {
	return estimateTokens(m) - thinkingTokens(m)
}

/** Pure per-request transform. Never mutates the input messages' content. */
export function pruneContext(messages: AgentMessage[]): { messages: AgentMessage[]; stats: PruneStats } {
	// Never touch the in-flight batch's position: everything after the last
	// assistant message is fresh output the model asked for and hasn't seen.
	let boundary = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			boundary = i
			break
		}
	}

	const total = messages.reduce((sum, m) => sum + wireTokens(m), 0)
	const keep = total > hardBudgetTokens() ? tightKeepTokens() : keepRecentToolTokens()

	const calls = collectToolCalls(messages)

	// Pass 1: dedupe — for each fetch-key, only the newest result (including
	// in-flight re-fetches) stays eligible; earlier duplicates are superseded.
	const lastByKey = new Map<string, number>()
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]
		if (m.role !== "toolResult" || isStub(m as ToolResultMessage)) continue
		const key = dedupeKey(m as ToolResultMessage, calls.get((m as ToolResultMessage).toolCallId))
		if (key !== undefined) lastByKey.set(key, i)
	}
	const lastIdx = new Set(lastByKey.values())
	const superseded = new Set<number>()
	for (let i = 0; i <= Math.min(boundary, messages.length - 1); i++) {
		const m = messages[i]
		if (m.role !== "toolResult" || isStub(m as ToolResultMessage) || lastIdx.has(i)) continue
		if (dedupeKey(m as ToolResultMessage, calls.get((m as ToolResultMessage).toolCallId)) === undefined) continue
		if (textChars(m as ToolResultMessage) >= MIN_PRUNE_CHARS) superseded.add(i)
	}

	// Pass 2: keep window — newest-first over non-superseded results.
	const prune = new Map<number, "elided" | "superseded">(superseded.keys().map((i) => [i, "superseded"]))
	let remaining = keep
	for (let i = Math.min(boundary, messages.length - 1); i >= 0; i--) {
		const m = messages[i]
		if (m.role !== "toolResult" || prune.has(i)) continue
		const tr = m as ToolResultMessage
		if (isStub(tr)) continue
		if (tr.content.some((part) => part.type !== "text")) continue
		const tokens = Math.ceil(textChars(tr) / 4)
		if (remaining >= tokens) {
			remaining -= tokens
			continue
		}
		remaining = 0
		if (textChars(tr) >= MIN_PRUNE_CHARS) prune.set(i, "elided")
	}

	// Pass 3: transform — stub results, truncate old toolCall args, cap
	// oversized in-flight results.
	let truncatedArgs = 0
	let inFlightTokens = 0
	const out = messages.map((m, i) => {
		if (m.role === "toolResult") {
			const reason = prune.get(i)
			if (reason) return stub(m as ToolResultMessage, calls.get((m as ToolResultMessage).toolCallId), reason)
			const tr = m as ToolResultMessage
			if (i > boundary && textChars(tr) > IN_FLIGHT_MAX_CHARS && tr.content.every((p) => p.type === "text")) {
				inFlightTokens += Math.ceil(IN_FLIGHT_MAX_CHARS / 4)
				const total = textChars(tr)
				return {
					...tr,
					content: tr.content.map((p) =>
						p.type === "text"
							? { ...p, text: truncateMiddle(p.text, Math.floor((IN_FLIGHT_MAX_CHARS * p.text.length) / total)) }
							: p,
					),
				}
			}
			if (i > boundary) inFlightTokens += Math.ceil(textChars(tr) / 4)
			return m
		}
		if (m.role === "assistant" && i < boundary && Array.isArray(m.content)) {
			let changed = false
			const content = m.content.map((part) => {
				if (part.type !== "toolCall") return part
				const next = truncateArgs(part.arguments)
				if (next === part.arguments) return part
				changed = true
				return { ...part, arguments: next }
			})
			if (changed) {
				truncatedArgs++
				return { ...m, content }
			}
		}
		return m
	})

	const stats: PruneStats = {
		estTokens: out.reduce((sum, m) => sum + wireTokens(m), 0),
		inFlightTokens,
		stubbedResults: [...prune.values()].filter((r) => r === "elided").length,
		dedupedResults: superseded.size,
		truncatedArgs,
	}
	return { messages: out, stats }
}

export function installContextBudget(pi: ExtensionAPI) {
	pi.on("context", (event) => {
		const { messages, stats } = pruneContext(event.messages)
		const changed = stats.stubbedResults + stats.dedupedResults + stats.truncatedArgs > 0
		logMetrics({
			kind: "context",
			msgs: event.messages.length,
			estTokens: stats.estTokens,
			inFlightTokens: stats.inFlightTokens,
			stubbed: stats.stubbedResults,
			deduped: stats.dedupedResults,
			truncatedArgs: stats.truncatedArgs,
		})
		if (!changed) return
		return { messages }
	})
}
