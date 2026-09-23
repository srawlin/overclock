import { installContextBudget } from "../extensions/fastcode/context-budget"

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

// 8 sequential read results of ~1000 tokens = ~8000 tool tokens; keep=6000 → oldest stubbed
const messages: any[] = [user]
for (let i = 0; i < 8; i++) {
	messages.push(toolCall(`c${i}`, "read", { path: `f${i}.ts` }), toolResult(`c${i}`, "read", big))
}
messages.push(assistant, toolCall("c9", "read", { path: "fresh.ts" }), toolResult("c9", "read", big))

const out = contextHandler({ type: "context", messages }, {})
check("handler returns messages", Array.isArray(out?.messages))
const stubbed = out.messages.filter((m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[read output pruned"))
check("oldest results stubbed", stubbed.length >= 1 && stubbed.length <= 3, `got ${stubbed.length}`)
check("stub mentions path", stubbed.every((m: any) => m.content[0].text.includes("f") && m.content[0].text.includes(".ts")))
check("stub preserves toolCallId", stubbed.every((m: any) => m.toolCallId.startsWith("c")))
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
const stubbed3 = out3?.messages.filter((m: any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[read output pruned"))
check("idempotent stubs", !out3 || stubbed3.length === stubbed.length)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
