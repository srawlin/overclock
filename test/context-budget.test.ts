import { installContextBudget, pruneContext } from "../extensions/fastcode/context-budget"

type Handler = (event: any, ctx: any) => any
const handlers: Record<string, Handler> = {}
const fakePi = { on: (event: string, h: Handler) => (handlers[event] = h) } as any
installContextBudget(fakePi)
const contextHandler = handlers["context"]

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

const big = "x".repeat(4000) // ~1000 tokens each
const toolCall = (id: string, name: string, args: any) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	timestamp: 0,
})
const toolResult = (id: string, name: string, text: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
})
const user = { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }
const assistant = { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 0 }

// 20 sequential read results of ~1000 tokens = ~20000 tool tokens; keep=16000 → oldest stubbed
const messages: any[] = [user]
for (let i = 0; i < 20; i++) {
	messages.push(toolCall(`c${i}`, "read", { path: `f${i}.ts` }), toolResult(`c${i}`, "read", big))
}
messages.push(assistant, toolCall("c9", "read", { path: "fresh.ts" }), toolResult("c9", "read", big))

const out = contextHandler({ type: "context", messages }, {})
check("handler returns messages", Array.isArray(out?.messages))
const stubbed = out.messages.filter(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[read output elided"),
)
check("oldest results stubbed", stubbed.length >= 1 && stubbed.length <= 6, `got ${stubbed.length}`)
check("stub mentions path", stubbed.every((m: any) => m.content[0].text.includes("f") && m.content[0].text.includes(".ts")))
check("stub preserves toolCallId", stubbed.every((m: any) => m.toolCallId.startsWith("c")))
check("stub does not invite re-run", stubbed.every((m: any) => !m.content[0].text.includes("Re-run")))
const last = out.messages[out.messages.length - 1]
check("in-flight result untouched", last.role === "toolResult" && last.content[0].text === big)

// determinism: stubbed set is stable across calls
const out2 = contextHandler({ type: "context", messages }, {})
check("deterministic", JSON.stringify(out.messages) === JSON.stringify(out2.messages))

// small session: nothing pruned
const small = [user, toolCall("a", "read", { path: "x" }), toolResult("a", "read", "short"), assistant]
check("small session untouched", contextHandler({ type: "context", messages: small }, {}) === undefined)

// stubbed messages are never re-stubbed (idempotent)
const out3 = contextHandler({ type: "context", messages: out.messages }, {})
const stubbed3 = out3?.messages.filter(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[read output"),
)
check("idempotent stubs", !out3 || stubbed3.length === stubbed.length)

// dedupe: repeated reads of the same path keep only the newest result
const dup: any[] = [user]
for (let i = 0; i < 4; i++) {
	dup.push(toolCall(`d${i}`, "read", { path: "same.ts" }), toolResult(`d${i}`, "read", `${big}${i}`))
}
dup.push(assistant, toolCall("e", "bash", { command: "ls" }), toolResult("e", "bash", "small"))
const dupOut = pruneContext(dup)
const dupMsgs = dupOut.messages as any[]
const keptSame = dupMsgs.filter(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith(big),
)
const superseded = dupMsgs.filter(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[read output superseded"),
)
check("dedupe keeps newest read only", keptSame.length === 1 && keptSame[0].content[0].text.endsWith("3"))
check("older duplicates superseded", superseded.length === 3 && dupOut.stats.dedupedResults === 3)

// bash dedupe keys on the exact command
const bashDup: any[] = [user]
for (let i = 0; i < 3; i++) {
	bashDup.push(toolCall(`b${i}`, "bash", { command: "npm test" }), toolResult(`b${i}`, "bash", `${big}run${i}`))
}
bashDup.push(toolCall("b9", "bash", { command: "npm build" }), toolResult("b9", "bash", `${big}other`))
bashDup.push(assistant)
const bashOut = pruneContext(bashDup)
const bashSuperseded = bashOut.messages.filter(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[bash output superseded"),
)
check("bash dedupes on identical command", bashSuperseded.length === 2)
const npmBuildKept = bashOut.messages.some(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).endsWith("other"),
)
check("different command not deduped", npmBuildKept)

// read dedupe distinguishes offset/limit ranges
const ranges: any[] = [
	user,
	toolCall("r1", "read", { path: "f.ts", offset: 0, limit: 100 }),
	toolResult("r1", "read", `${big}part1`),
	toolCall("r2", "read", { path: "f.ts", offset: 100, limit: 100 }),
	toolResult("r2", "read", `${big}part2`),
	assistant,
]
const rangeOut = pruneContext(ranges)
const rangeStubs = rangeOut.messages.filter(
	(m: any) => m.role === "toolResult" && String(m.content[0].text).includes("superseded"),
)
check("different read ranges not deduped", rangeStubs.length === 0)

// old toolCall args get truncated, in-flight args untouched
const longCmd = "n".repeat(2000)
const argMsgs: any[] = [
	user,
	toolCall("t1", "bash", { command: longCmd }),
	toolResult("t1", "bash", "done"),
	assistant,
	toolCall("t2", "bash", { command: longCmd }),
	toolResult("t2", "bash", "done"),
]
const argOut = pruneContext(argMsgs)
const argMsgsOut = argOut.messages as any[]
const oldCall = argMsgsOut[1].content[0]
const freshCall = argMsgsOut[4].content[0]
check(
	"old toolCall args truncated",
	oldCall.arguments.command.length < 700 && oldCall.arguments.command.endsWith("[elided]"),
)
check("in-flight toolCall args untouched", freshCall.arguments.command === longCmd)

// oversized in-flight result gets middle-truncated, not stubbed
const huge = "h".repeat(60_000)
const flight: any[] = [
	user,
	assistant,
	toolCall("f1", "bash", { command: "dump" }),
	toolResult("f1", "bash", huge),
]
const flightOut = pruneContext(flight)
const flightRes = flightOut.messages[3] as any
check(
	"in-flight oversized result truncated",
	flightRes.content[0].text.length < huge.length && flightRes.content[0].text.includes("elided"),
)
check("truncated keeps head and tail", flightRes.content[0].text.startsWith("hhh") && flightRes.content[0].text.endsWith("hhh"))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
