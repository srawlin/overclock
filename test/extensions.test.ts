import { OVERCLOCK_GUIDANCE } from "../extensions/overclock/prompt"
import { registerSubAgentTools, resolveSubAgentModel } from "../extensions/overclock/subagents"
import { logoLines } from "../extensions/overclock/logo"
import { newerVersion } from "../extensions/overclock/version-check"
import overclock, { resolveApiBase } from "../extensions/overclock"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		passed++
		console.log(`  ok  ${name}`)
	} else {
		failed++
		console.log(`FAIL  ${name} ${extra}`)
	}
}

// --- item 1+2: guidance steers toward dedicated tools and durable notes ---
check("guidance prefers dedicated tools over bash", OVERCLOCK_GUIDANCE.includes("Prefer the read, grep, find, and ls tools over bash"))
check("guidance prescribes durable notes file", OVERCLOCK_GUIDANCE.includes("NOTES.md"))
check("guidance explains stubs mean already-seen", OVERCLOCK_GUIDANCE.includes("already received that output"))
check("guidance mentions verify tool", OVERCLOCK_GUIDANCE.includes("verify"))

// --- item 3+4: tool registration ---
const tools: any[] = []
const fakePi = { registerTool: (t: any) => tools.push(t) } as any
registerSubAgentTools(fakePi)
const names = tools.map((t) => t.name)
check("explore, delegate, verify registered", ["explore", "delegate", "verify"].every((n) => names.includes(n)), names.join(","))

const delegate = tools.find((t) => t.name === "delegate")
check(
	"delegate warns about shared files in parallel",
	delegate.promptGuidelines.some((g: string) => g.includes("disjoint set of files")),
)
const verify = tools.find((t) => t.name === "verify")
check("verify returns PASS/FAIL contract", verify.description.includes("PASS or FAIL"))
check("verify takes task + files params", "task" in (verify.parameters?.properties ?? {}) && "files" in verify.parameters.properties)
check("verify positioned as independent checker", verify.promptGuidelines.some((g: string) => g.includes("fresh agent")))

// --- explore model routing ---
// Invariant: the MAIN session's model is never re-routed mid-task. Only
// sub-agents may use a different model, and only `explore` has a default.
const mainModel = { provider: "cerebras", id: "qwen-3.8-27b" }
const ossModel = { provider: "cerebras", id: "gpt-oss-120b" }
const ctx = {
	model: mainModel,
	modelRegistry: { find: (p: string, id: string) => (p === "cerebras" && id === "gpt-oss-120b" ? ossModel : undefined) },
} as any

// Default: explore → cheaper search model; delegate/verify → main model.
delete process.env.OVERCLOCK_EXPLORE_MODEL
delete process.env.FASTCODE_EXPLORE_MODEL
check("default: explore → gpt-oss-120b", resolveSubAgentModel(ctx, "explore") === ossModel)
check("invariant: delegate never re-routed", resolveSubAgentModel(ctx, "delegate") === mainModel)
check("invariant: verify never re-routed", resolveSubAgentModel(ctx, "verify") === mainModel)

// Env escape hatches.
process.env.OVERCLOCK_EXPLORE_MODEL = ""
check("empty env → fall back to main model (escape hatch)", resolveSubAgentModel(ctx, "explore") === mainModel)
process.env.OVERCLOCK_EXPLORE_MODEL = "gpt-oss-120b"
check("flag id form → gpt-oss-120b", resolveSubAgentModel(ctx, "explore") === ossModel)
process.env.OVERCLOCK_EXPLORE_MODEL = "cerebras/gpt-oss-120b"
check("flag provider/id form works", resolveSubAgentModel(ctx, "explore") === ossModel)
process.env.OVERCLOCK_EXPLORE_MODEL = "nonexistent-model"
check("unknown flag id falls back to ctx.model", resolveSubAgentModel(ctx, "explore") === mainModel)

// Legacy FASTCODE_* name still honored (rename migration), but OVERCLOCK_* wins.
delete process.env.OVERCLOCK_EXPLORE_MODEL
process.env.FASTCODE_EXPLORE_MODEL = "gpt-oss-120b"
check("legacy FASTCODE_EXPLORE_MODEL honored", resolveSubAgentModel(ctx, "explore") === ossModel)
process.env.OVERCLOCK_EXPLORE_MODEL = ""
check("OVERCLOCK_* overrides legacy FASTCODE_*", resolveSubAgentModel(ctx, "explore") === mainModel)
delete process.env.OVERCLOCK_EXPLORE_MODEL
delete process.env.FASTCODE_EXPLORE_MODEL

// --- F5: OVERCLOCK_API_BASE validation (https required; http loopback only) ---
{
	const set = (v: string | undefined) => {
		delete process.env.OVERCLOCK_API_BASE
		delete process.env.FASTCODE_API_BASE
		if (v !== undefined) process.env.OVERCLOCK_API_BASE = v
	}
	const DEFAULT = "https://api.cerebras.ai/v1"
	set(undefined)
	check("api base: unset → cerebras default", resolveApiBase() === DEFAULT)
	set("https://api.cerebras.ai/v1")
	check("api base: https kept", resolveApiBase() === "https://api.cerebras.ai/v1")
	set("https://proxy.corp.example/v1")
	check("api base: https proxy kept", resolveApiBase() === "https://proxy.corp.example/v1")
	set("http://127.0.0.1:8123/v1")
	check("api base: http loopback kept", resolveApiBase() === "http://127.0.0.1:8123/v1")
	set("http://localhost:8080")
	check("api base: http localhost kept", resolveApiBase() === "http://localhost:8080")
	set("http://evil.example.com")
	check("api base: remote http refused → default", resolveApiBase() === DEFAULT)
	set("ftp://x")
	check("api base: non-http scheme refused", resolveApiBase() === DEFAULT)
	set("not a url")
	check("api base: garbage refused → default", resolveApiBase() === DEFAULT)
	set(undefined)
	process.env.FASTCODE_API_BASE = "https://legacy.example/v1"
	check("api base: legacy FASTCODE_API_BASE honored", resolveApiBase() === "https://legacy.example/v1")
	delete process.env.FASTCODE_API_BASE
}

// --- /exit command (regression: pi only ships /quit — /exit used to go to the model) ---
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "overclock-ext-test-"))
const commands: any[] = []
const handlers: Record<string, (...args: any[]) => any> = {}
const fakePiFull = {
	registerTool: () => {},
	registerCommand: (name: string, opts: any) => commands.push({ name, ...opts }),
	registerProvider: () => {},
	registerFlag: () => {},
	on: (event: string, h: (...args: any[]) => any) => (handlers[event] = h),
	getFlag: () => undefined,
} as any
overclock(fakePiFull)
const exitCmd = commands.find((c) => c.name === "exit")
check("/exit command registered", exitCmd !== undefined)
{
	let shutdownCalled = false
	let abortCalled = false
	const cmdCtx = { shutdown: () => (shutdownCalled = true), abort: () => (abortCalled = true), isIdle: () => false } as any
	await exitCmd.handler("", cmdCtx)
	check("/exit calls shutdown", shutdownCalled)
	check("/exit aborts in-flight turn when busy", abortCalled)
	shutdownCalled = false
	abortCalled = false
	await exitCmd.handler("", { ...cmdCtx, isIdle: () => true })
	check("/exit skips abort when idle", shutdownCalled && !abortCalled)
}

// --- logo banner ---
const lines = logoLines()
const joined = lines.join("\n")
check("logo renders 5 art rows + tagline + disclaimer + padding", lines.length === 9)
check("logo has italic ANSI on over", joined.includes("\x1b[3m") && joined.includes("\x1b[23m"))
check("logo contains both words' glyphs", joined.includes("_____  _____") && joined.includes("\\___|_|"))

// --- system prompt rebrands pi → overclock (model-facing identity) ---
{
	const res = handlers.before_agent_start?.({
		systemPrompt: "You are an expert coding assistant operating inside pi, a coding agent harness.",
	})
	check("system prompt rebrands pi → overclock", res?.systemPrompt?.includes("operating inside overclock,") === true, JSON.stringify(res?.systemPrompt?.slice(0, 90)))
	check("system prompt appends guidance", res?.systemPrompt?.includes("## Context budget") === true)
}

// --- version check ---
check("newer minor detected", newerVersion("0.88.0", "0.87.1"))
check("newer patch detected", newerVersion("0.87.2", "0.87.1"))
check("same version not newer", !newerVersion("0.87.1", "0.87.1"))
check("older not newer", !newerVersion("0.86.9", "0.87.1"))
check("garbage not newer", !newerVersion("nope", "0.87.1") && !newerVersion("0.88.0", ""))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
