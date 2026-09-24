import { factorial, gcd, Range } from "../src/lib.js"

function eq(a, b, msg) {
	const ok = JSON.stringify(a) === JSON.stringify(b)
	console.log(`${ok ? "ok" : "FAIL"}  ${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
	return ok
}

let pass = 0
let fail = 0
function check(ok) {
	if (ok) pass++
	else fail++
}

check(eq(factorial(0), 1, "factorial(0)"))
check(eq(factorial(1), 1, "factorial(1)"))
check(eq(factorial(3), 6, "factorial(3)")) // 6
check(eq(factorial(4), 24, "factorial(4)")) // 24 — current code gives 120 (off-by-one)
check(eq(gcd(12, 18), 6, "gcd(12,18)"))
check(eq(gcd(100, 0), 100, "gcd(100,0)"))
const r = new Range(1, 5)
check(eq(r.count(), 5, "range count"))
check(eq(r.sum(), 15, "range sum 1..5"))
check(r.contains(3), "range contains 3")
check(!r.contains(6), "range excludes 6")

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)