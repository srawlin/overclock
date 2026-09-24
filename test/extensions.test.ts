import { FASTCODE_GUIDANCE } from "../extensions/fastcode/prompt"
import { registerSubAgentTools, resolveSubAgentModel } from "../extensions/fastcode/subagents"
import { logoLines } from "../extensions/fastcode/logo"
import fastcode from "../extensions/fastcode"
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
check("guidance prefers dedicated tools over bash", FASTCODE_GUIDANCE.includes("Prefer the read, grep, find, and ls tools over bash"))
check("guidance prescribes durable notes file", FASTCODE_GUIDANCE.includes("NOTES.md"))
check("guidance explains stubs mean already-seen", FASTCODE_GUIDANCE.includes("already received that output"))
check("guidance mentions verify tool", FASTCODE_GUIDANCE.includes("verify"))

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
delete process.env.FASTCODE_EXPLORE_MODEL
check("default: explore → gpt-oss-120b", resolveSubAgentModel(ctx, "explore") === ossModel)
check("invariant: delegate never re-routed", resolveSubAgentModel(ctx, "delegate") === mainModel)
check("invariant: verify never re-routed", resolveSubAgentModel(ctx, "verify") === mainModel)

// Env escape hatches.
process.env.FASTCODE_EXPLORE_MODEL = ""
check("empty env → fall back to main model (escape hatch)", resolveSubAgentModel(ctx, "explore") === mainModel)
process.env.FASTCODE_EXPLORE_MODEL = "gpt-oss-120b"
check("flag id form → gpt-oss-120b", resolveSubAgentModel(ctx, "explore") === ossModel)
process.env.FASTCODE_EXPLORE_MODEL = "cerebras/gpt-oss-120b"
check("flag provider/id form works", resolveSubAgentModel(ctx, "explore") === ossModel)
process.env.FASTCODE_EXPLORE_MODEL = "nonexistent-model"
check("unknown flag id falls back to ctx.model", resolveSubAgentModel(ctx, "explore") === mainModel)
delete process.env.FASTCODE_EXPLORE_MODEL

// --- /exit command (regression: pi only ships /quit — /exit used to go to the model) ---
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "fastcode-ext-test-"))
const commands: any[] = []
const fakePiFull = {
	registerTool: () => {},
	registerCommand: (name: string, opts: any) => commands.push({ name, ...opts }),
	registerProvider: () => {},
	registerFlag: () => {},
	on: () => {},
	getFlag: () => undefined,
} as any
fastcode(fakePiFull)
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
check("logo renders 5 art rows + tagline + padding", lines.length === 8)
check("logo has italic ANSI on fast", joined.includes("\x1b[3m") && joined.includes("\x1b[23m"))
check("logo contains both words' glyphs", joined.includes("/ __/___") && joined.includes("\\__,_|"))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
