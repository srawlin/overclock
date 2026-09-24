import { hardBudgetTokens, keepRecentToolTokens, maxCompletionTokens, tightKeepTokens } from "../extensions/overclock/knobs"

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

const NAMES = [
	"OVERCLOCK_FAST",
	"OVERCLOCK_KEEP_TOKENS",
	"OVERCLOCK_HARD_BUDGET_TOKENS",
	"OVERCLOCK_TIGHT_KEEP_TOKENS",
	"OVERCLOCK_MAX_OUT_TOKENS",
	"FASTCODE_FAST",
	"FASTCODE_KEEP_TOKENS",
	"FASTCODE_HARD_BUDGET_TOKENS",
	"FASTCODE_TIGHT_KEEP_TOKENS",
	"FASTCODE_MAX_OUT_TOKENS",
]
function clearEnv() {
	for (const n of NAMES) delete process.env[n]
}
clearEnv()

// --- defaults (no env) ---
check("default keep window 16k", keepRecentToolTokens() === 16_000)
check("default hard budget 80k", hardBudgetTokens() === 80_000)
check("default tight keep 4k", tightKeepTokens() === 4_000)
check("default max out 16k", maxCompletionTokens() === 16_384)

// --- FAST preset ---
process.env.OVERCLOCK_FAST = "1"
check("fast preset tightens keep", keepRecentToolTokens() === 8_000)
check("fast preset tightens hard budget", hardBudgetTokens() === 20_000)
check("fast preset tightens tight keep", tightKeepTokens() === 2_000)
check("fast preset caps output 8k", maxCompletionTokens() === 8_192)

// --- individual override beats preset ---
process.env.OVERCLOCK_KEEP_TOKENS = "12345"
check("explicit override beats preset", keepRecentToolTokens() === 12_345)
delete process.env.OVERCLOCK_KEEP_TOKENS

// --- preset only on exact "1" ---
process.env.OVERCLOCK_FAST = "0"
check("FAST=0 is off", keepRecentToolTokens() === 16_000)
process.env.OVERCLOCK_FAST = "yes"
check("FAST=yes is off", keepRecentToolTokens() === 16_000)

// --- garbage values fall back ---
process.env.OVERCLOCK_FAST = "1"
process.env.OVERCLOCK_HARD_BUDGET_TOKENS = "nope"
check("invalid int falls back to preset", hardBudgetTokens() === 20_000)
process.env.OVERCLOCK_HARD_BUDGET_TOKENS = "-5"
check("negative falls back", hardBudgetTokens() === 20_000)
process.env.OVERCLOCK_HARD_BUDGET_TOKENS = ""
check("empty falls back", hardBudgetTokens() === 20_000)

// --- legacy FASTCODE_* names still work (rename migration) ---
clearEnv()
process.env.FASTCODE_FAST = "1"
check("legacy FASTCODE_FAST enables preset", keepRecentToolTokens() === 8_000)
process.env.FASTCODE_KEEP_TOKENS = "7777"
check("legacy FASTCODE_KEEP_TOKENS honored", keepRecentToolTokens() === 7_777)
process.env.OVERCLOCK_KEEP_TOKENS = "9999"
check("OVERCLOCK_* wins over legacy", keepRecentToolTokens() === 9_999)

clearEnv()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
