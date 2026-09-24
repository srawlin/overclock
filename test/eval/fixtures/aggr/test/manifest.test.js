import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(new URL("../out/manifest.js", import.meta.url))
// Parse the known export lines
function grab(name, s) {
	const m = new RegExp("export const " + name + \\s*=\\s*(\\d+)").exec(s) || new RegExp(name + \\s*:\\s*(\\d+)").exec(s)
	return Number(m && m[1])
}
const total = grab("TOTAL_COUNT", raw)
const weight = grab("TOTAL_WEIGHT", raw)
assert.equal(total, 172, "TOTAL_COUNT should be 172 but got " + total)
assert.equal(weight, 330, "TOTAL_WEIGHT should be 330 but got " + weight)
console.log("ok  aggregate " + total + "/" + weight)
