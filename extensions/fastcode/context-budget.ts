import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai"
import { estimateTokens, type ExtensionAPI } from "@mariozechner/pi-coding-agent"

// Cerebras qwen-3.8-27b: 128k context. Every request re-sends the transcript,
// so steady-state size drives both TTFT and cost. Old tool outputs are the
// dominant bulk — replace them with deterministic stubs once they fall behind
// a keep window. Stubs never change afterwards, so the wire prefix stays
// stable for Cerebras prefix caching.

/** Tool output kept verbatim, counted back from the newest results. */
const KEEP_RECENT_TOOL_TOKENS = 6_000
/** Don't stub outputs smaller than this — not worth the churn. */
const MIN_PRUNE_CHARS = 800
/** Above this estimate, tighten the keep window instead. */
const HARD_BUDGET_TOKENS = 80_000
const TIGHT_KEEP_TOKENS = 1_500

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

function stub(message: ToolResultMessage, info: ToolCallInfo | undefined): ToolResultMessage {
	const tokens = Math.max(1, Math.round(textChars(message) / 4))
	return {
		...message,
		content: [
			{
				type: "text",
				text: `[${message.toolName} output pruned: ${hintFor(info, message.toolName)}, ~${tokens} tokens. Re-run ${message.toolName} to fetch it again.]`,
			} satisfies TextContent,
		],
	}
}

export function installContextBudget(pi: ExtensionAPI) {
	pi.on("context", (event) => {
		const messages = event.messages
		// Never touch the in-flight batch: everything after the last assistant
		// message is fresh output the model asked for.
		let boundary = -1
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				boundary = i
				break
			}
		}

		const total = messages.reduce((sum, m) => sum + estimateTokens(m), 0)
		const keep = total > HARD_BUDGET_TOKENS ? TIGHT_KEEP_TOKENS : KEEP_RECENT_TOOL_TOKENS

		// Newest-first: keep tool output until the window is spent, stub the rest.
		const prune = new Set<number>()
		let remaining = keep
		for (let i = Math.min(boundary, messages.length - 1); i >= 0; i--) {
			const m = messages[i]
			if (m.role !== "toolResult") continue
			if (m.content.some((part) => part.type !== "text")) continue
			const tokens = Math.ceil(textChars(m) / 4)
			if (remaining >= tokens) {
				remaining -= tokens
				continue
			}
			remaining = 0
			if (textChars(m) >= MIN_PRUNE_CHARS) prune.add(i)
		}
		if (prune.size === 0) return

		const calls = collectToolCalls(messages)
		return {
			messages: messages.map((m, i) =>
				prune.has(i) ? stub(m as ToolResultMessage, calls.get((m as ToolResultMessage).toolCallId)) : m,
			),
		}
	})
}
