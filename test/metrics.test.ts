import { toolEnd, toolStart, turnEnd, turnFirstToken, turnOutput, turnStart, turnToolCall } from "../extensions/overclock/metrics"

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

function sleep(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// --- turn lifecycle ---
turnStart("t2")
sleep(15)
turnFirstToken("t2")
sleep(15)
turnFirstToken("t2") // second call must NOT overwrite (first-token semantics)
turnOutput("t2", 100)
turnOutput("t2", 50)
turnToolCall("t2")
const rec = turnEnd("t2")!
check("turnEnd returns record", rec !== undefined)
check("firstToken < totalMs", rec.firstTokenMs <= rec.totalMs)
// first-token semantics: the ~15ms stamp must be the FIRST call's, not the
// second's (~30ms). Compare the delta instead of an absolute bound —
// Atomics.wait can oversleep arbitrarily under CI load, but the gap between
// the two stamps is still the second sleep (~15ms), whereas an overwritten
// stamp would sit at ~0ms from totalMs.
check("firstToken recorded once (≈15ms gap from total)", rec.totalMs - rec.firstTokenMs >= 5, `first=${rec.firstTokenMs}ms total=${rec.totalMs}ms`)
check("output tokens summed", rec.outputTok === 150)
check("toolCalls counted", rec.toolCalls === 1)
check("tokensPerSec derived", rec.outputTokPerSec > 0)
check("turnEnd clears the record", turnEnd("t2") === undefined)

// --- first token never arriving → treat as full latency ---
turnStart("t3")
sleep(10)
const rec3 = turnEnd("t3")!
check("no-content turn: firstTokenMs = totalMs", rec3.firstTokenMs === rec3.totalMs)

// --- unknown keys are safe ---
check("turnEnd unknown key → undefined", turnEnd("nope") === undefined)
turnFirstToken("nope") // must not throw
turnOutput("nope", 5)
turnToolCall("nope")
check("orphan calls don't throw", true)

// --- tool timers ---
toolStart("tc1", "bash")
sleep(5)
const trec = toolEnd("tc1", false)!
check("toolEnd returns name+ms", trec.name === "bash" && trec.ms >= 4)
check("toolEnd clears record", toolEnd("tc1", false) === undefined)
check("toolEnd unknown → undefined", toolEnd("nope", true) === undefined)
toolStart("tc2", "edit")
check("tool isError propagates", toolEnd("tc2", true)!.isError === true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
