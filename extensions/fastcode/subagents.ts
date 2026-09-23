import { Agent } from "@mariozechner/pi-agent-core"
import { streamSimple, type TextContent } from "@mariozechner/pi-ai"
import {
	convertToLlm,
	createBashTool,
	createCodingTools,
	createReadOnlyTools,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { pruneContext } from "./context-budget"
import { logMetrics } from "./metrics"
import { paceRequest } from "./provider-tuning"

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

const VERIFY_PROMPT = `You are an independent verification sub-agent in a coding CLI. You did NOT make the change under review — evaluate it skeptically.
Rules: run the relevant tests/build/lint commands; inspect the actual diff or named files; check the change against the stated criteria, not just whether it runs.
Finish with a verdict: PASS or FAIL, followed by concrete evidence (commands run, relevant output, file:line references). Never modify files — observation and commands only.`

interface SubAgentDetails {
	turns: number
	inputTokens?: number
	outputTokens?: number
	error?: string
}

function errorResult(text: string): AgentToolResult<SubAgentDetails> {
	return { content: [{ type: "text", text }], details: { turns: 0, error: text } }
}

type SubAgentName = "explore" | "delegate" | "verify"
type Toolset = "read-only" | "coding" | "verify"

/** Model routing per sub-agent role. FASTCODE_EXPLORE_MODEL overrides the
 *  model used for explore agents (accepts "id" or "provider/id") — e.g.
 *  gpt-oss-120b at ~4x cheaper input for what is fundamentally search work. */
export function resolveSubAgentModel(ctx: ExtensionContext, name: SubAgentName) {
	const override = name === "explore" ? process.env.FASTCODE_EXPLORE_MODEL : undefined
	if (!override) return ctx.model
	const [provider, id] = override.includes("/") ? override.split("/", 2) : ["cerebras", override]
	return ctx.modelRegistry.find(provider, id) ?? ctx.model
}

async function runSubAgent(
	ctx: ExtensionContext,
	name: SubAgentName,
	task: string,
	tools: Toolset,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<SubAgentDetails>) => void) | undefined,
): Promise<AgentToolResult<SubAgentDetails>> {
	const model = resolveSubAgentModel(ctx, name)
	if (!model) return errorResult("no active model")
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok) return errorResult(`cannot resolve credentials: ${auth.error}`)
	if (!auth.apiKey) return errorResult(`no API key for provider ${model.provider}`)

	await acquire()
	const start = Date.now()
	try {
		const agent = new Agent({
			initialState: {
				systemPrompt:
					tools === "read-only" ? EXPLORE_PROMPT : tools === "verify" ? VERIFY_PROMPT : DELEGATE_PROMPT,
				model,
				// verify: read-only inspection plus bash for tests/builds — it
				// can check work but not change it.
				tools:
					tools === "read-only"
						? createReadOnlyTools(ctx.cwd)
						: tools === "verify"
							? [...createReadOnlyTools(ctx.cwd), createBashTool(ctx.cwd)]
							: createCodingTools(ctx.cwd),
			},
			convertToLlm,
			// Same per-request pruning as the main loop — inner transcripts are
			// disposable but still ride the wire every turn.
			transformContext: async (messages) => pruneContext(messages).messages,
			streamFn: (m, c, o) =>
				streamSimple(m, c, {
					...o,
					// Inner requests bypass extension hooks, so the provider tuning
					// has to be applied here: low reasoning, capped output
					// reservation, clear_thinking, and shared TPM pacing.
					reasoning: o?.reasoning ?? "low",
					maxTokens: Math.min(o?.maxTokens ?? 16_384, 16_384),
					onPayload: async (payload, _model) => {
						const p = payload as Record<string, unknown>
						if (typeof p.model === "string" && p.model.includes("qwen")) p.clear_thinking = true
						const reserved = typeof p.max_completion_tokens === "number" ? p.max_completion_tokens : 16_384
						await paceRequest(Math.ceil(JSON.stringify(p).length / 4) + reserved)
						return p
					},
				}),
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
		let inputTokens = 0
		let outputTokens = 0
		for (const m of agent.state.messages) {
			if (m.role === "assistant" && "usage" in m && m.usage) {
				const u = m.usage as { input?: number; cacheRead?: number; output?: number }
				inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0)
				outputTokens += u.output ?? 0
			}
		}
		logMetrics({ kind: "subagent", name, model: model.id, turns, inputTokens, outputTokens, ms: Date.now() - start })
		return {
			content: [{ type: "text", text: text || "(sub-agent produced no output)" }],
			details: { turns, inputTokens, outputTokens },
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
				"explore",
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
			"When running delegates in parallel, give each a disjoint set of files — parallel tasks that share files will overwrite each other.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Complete task description, including acceptance criteria" }),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
			runSubAgent(ctx, "delegate", params.task, "coding", signal, onUpdate),
	})

	pi.registerTool({
		name: "verify",
		label: "Verify",
		description:
			"Spawn an independent verification sub-agent to check work you did not write. It runs tests/builds and inspects diffs, then returns PASS or FAIL with concrete evidence. Use after code changes when correctness matters — a fresh agent catches what you cannot see in your own work.",
		promptSnippet: "verify — independent checker sub-agent (PASS/FAIL + evidence)",
		promptGuidelines: [
			"Use verify after completing code changes — a fresh agent catches what you cannot see in your own work.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "What to verify and the acceptance criteria" }),
			files: Type.Optional(Type.Array(Type.String(), { description: "Files/diffs to check, if known" })),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
			runSubAgent(
				ctx,
				"verify",
				params.files?.length ? `${params.task}\n\nCheck: ${params.files.join(", ")}` : params.task,
				"verify",
				signal,
				onUpdate,
			),
	})
}
