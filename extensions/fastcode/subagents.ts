import { Agent } from "@mariozechner/pi-agent-core"
import { streamSimple, type TextContent } from "@mariozechner/pi-ai"
import {
	convertToLlm,
	createCodingTools,
	createReadOnlyTools,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"

// Cerebras enforces RPM and TPM per org. Sub-agents multiply request rate, so
// cap concurrency — three in-flight sub-agents is plenty at ~1500 tok/s.
const MAX_CONCURRENT = 3
let active = 0
const waiters: (() => void)[] = []

async function acquire() {
	if (active < MAX_CONCURRENT) {
		active++
		return
	}
	await new Promise<void>((resolve) => waiters.push(resolve))
	active++
}

function release() {
	active--
	waiters.shift()?.()
}

const EXPLORE_PROMPT = `You are a read-only exploration sub-agent in a coding CLI. Answer the given question by inspecting the codebase.
Rules: locate with grep/find/ls before reading; read only the ranges you need; never modify anything.
Finish with a concise answer citing file:line references. If you cannot determine something, say so.`

const DELEGATE_PROMPT = `You are a coding sub-agent in a CLI. Complete the given task end-to-end in the current working directory.
Rules: make the change, then verify it (run the relevant test/build/lint if one exists); keep your own searches targeted.
Finish with: what changed (files), how you verified it, and anything the caller must know. Be terse.`

interface SubAgentDetails {
	turns: number
	error?: string
}

function errorResult(text: string): AgentToolResult<SubAgentDetails> {
	return { content: [{ type: "text", text }], details: { turns: 0, error: text } }
}

async function runSubAgent(
	ctx: ExtensionContext,
	task: string,
	tools: "read-only" | "coding",
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<SubAgentDetails>) => void) | undefined,
): Promise<AgentToolResult<SubAgentDetails>> {
	const model = ctx.model
	if (!model) return errorResult("no active model")
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok) return errorResult(`cannot resolve credentials: ${auth.error}`)
	if (!auth.apiKey) return errorResult(`no API key for provider ${model.provider}`)

	await acquire()
	try {
		const agent = new Agent({
			initialState: {
				systemPrompt: tools === "read-only" ? EXPLORE_PROMPT : DELEGATE_PROMPT,
				model,
				tools: tools === "read-only" ? createReadOnlyTools(ctx.cwd) : createCodingTools(ctx.cwd),
			},
			convertToLlm,
			streamFn: (m, c, o) => streamSimple(m, c, o),
			getApiKey: () => auth.apiKey,
			toolExecution: "parallel",
		})
		let turns = 0
		agent.subscribe((event) => {
			if (event.type === "turn_end") {
				turns++
				onUpdate?.({ content: [{ type: "text", text: `sub-agent running (turn ${turns})` }], details: { turns } })
			}
		})
		await Promise.race([
			agent.prompt(task),
			new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		]).catch((error) => {
			agent.abort()
			throw error
		})

		const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant")
		const text = Array.isArray(last?.content)
			? last.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n")
			: ""
		return {
			content: [{ type: "text", text: text || "(sub-agent produced no output)" }],
			details: { turns },
		}
	} finally {
		release()
	}
}

export function registerSubAgentTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "explore",
		label: "Explore",
		description:
			"Spawn a read-only sub-agent to answer a question about the codebase. Use for questions that would require reading more than ~2 files — the sub-agent's file contents stay out of your context. Returns a concise answer with file:line references.",
		promptSnippet: "explore — read-only sub-agent for codebase questions (keeps your context small)",
		promptGuidelines: [
			"Prefer explore over reading many files yourself when answering questions that span more than ~2 files.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The question or investigation to answer" }),
			files: Type.Optional(Type.Array(Type.String(), { description: "Files/dirs to focus on, if known" })),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
			runSubAgent(
				ctx,
				params.files?.length ? `${params.task}\n\nFocus on: ${params.files.join(", ")}` : params.task,
				"read-only",
				signal,
				onUpdate,
			),
	})

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Spawn a coding sub-agent to complete a bounded task end-to-end (edit files, run tests). Use for independent units of work you can describe fully. Returns a report of what changed and how it was verified. Do NOT use for edits requiring judgment about your current conversation.",
		promptSnippet: "delegate — coding sub-agent for bounded, verifiable tasks",
		promptGuidelines: [
			"Prefer delegate for self-contained tasks (write tests for X, fix lint in Y) — its work stays out of your context.",
			"Give delegate complete, unambiguous instructions; it cannot see your conversation.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Complete task description, including acceptance criteria" }),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
			runSubAgent(ctx, params.task, "coding", signal, onUpdate),
	})
}
