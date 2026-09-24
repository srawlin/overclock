#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const root = new URL("./fixtures/aggr", import.meta.url).pathname
mkdirSync(join(root, "src"), { recursive: true })
mkdirSync(join(root, "test"), { recursive: true })
mkdirSync(join(root, "out"), { recursive: true })

// 12 modules, each exporting COUNT and WEIGHT. Values are fixed so the
// aggregate is a stable ground truth.
const M = [
	["alpha", 42, 7, "feature-flag counters"],
	["beta", 17, 33, "throughput rates"],
	["gamma", 8, 11, "geo routing tables"],
	["delta", 25, 19, "cache tier sizes"],
	["epsilon", 5, 41, "rate-limit slots"],
	["zeta", 3, 27, "token budgets"],
	["eta", 14, 47, "shard keys"],
	["theta", 21, 13, "retry schedules"],
	["iota", 9, 23, "schema tags"],
	["kappa", 6, 37, "metric emitters"],
	["lambda", 12, 29, "query plans"],
	["mu", 10, 43, "batch windows"],
]

// Deterministic pseudo-random filler based on name
let seed = 1
function rand() { seed = (seed * 16807) % 2147483647; return seed }

let totalCount = 0
let totalWeight = 0
const modList = []

for (const [name, count, weight, blurb] of M) {
	totalCount += count
	totalWeight += weight
	// ~60 lines of realistic-ish filler to make reads produce substantial output
	const filler = Array.from({ length: 54 }, (_, i) =>
		"\t// " + name + " sample " + (i + 1) + " [w=" + (rand() % 97) + "]"
	).join("\n")

	const body =
		"// " + name + ".js\n" +
		"// " + blurb + ". Fixed values (COUNT, WEIGHT); do not change.\n" +
		"export const COUNT = " + count + "\n" +
		"export const WEIGHT = " + weight + "\n" +
		"\n" +
		"export function describe() {\n" +
		"\treturn " + JSON.stringify(name + "/" + count + "/" + weight) + "\n" +
		"}\n" +
		"\n" +
		"export const META = " + JSON.stringify(name + "/" + blurb) + "\n" +
		"\n" +
		filler + "\n"

	const f = join(root, "src", name + ".js")
	writeFileSync(f, body)
	modList.push({ name, file: "src/" + name + ".js", count, weight })
}

// Barrel index re-exports only names — NOT the numeric constants.
const idx = [
	"// index.js — barrel re-export (names only; constants NOT re-exported).",
	...M.map(([n]) => "export { describe as " + n + "Describe, META as " + n + "Meta } from \"./" + n + ".js\""),
	"",
].join("\n")
writeFileSync(join(root, "src", "index.js"), idx)

// The test: read out/manifest.js (which the agent must produce) and check that
// it agrees with the ground truth totals. The manifest test imports the
// manifest path and parses it as ESM.
const TEST =
	"import assert from \"node:assert/strict\"\n" +
	"import { readFileSync } from \"node:fs\"\n" +
	"import { dirname } from \"node:path\"\n" +
	"import { fileURLToPath } from \"node:url\"\n" +
	"const here = dirname(fileURLToPath(import.meta.url))\n" +
	"const raw = readFileSync(new URL(\"../out/manifest.js\", import.meta.url))\n" +
	"// Parse the known export lines\n" +
	"function grab(name, s) {\n" +
	"\tconst m = new RegExp(\"export const \" + name + \\\\s*=\\\\s*(\\\\d+)\").exec(s) || new RegExp(name + \\\\s*:\\\\s*(\\\\d+)\").exec(s)\n" +
	"\treturn Number(m && m[1])\n" +
	"}\n" +
	"const total = grab(\"TOTAL_COUNT\", raw)\n" +
	"const weight = grab(\"TOTAL_WEIGHT\", raw)\n" +
	"assert.equal(total, " + totalCount + ", \"TOTAL_COUNT should be " + totalCount + " but got \" + total)\n" +
	"assert.equal(weight, " + totalWeight + ", \"TOTAL_WEIGHT should be " + totalWeight + " but got \" + weight)\n" +
	"console.log(\"ok  aggregate \" + total + \"/\" + weight)\n"

writeFileSync(join(root, "test", "manifest.test.js"), TEST)

// Write a .gitignore so the worktree doesn't track out/
writeFileSync(join(root, ".gitignore"), "out/\n")

console.log("wrote " + M.length + " modules; TOTAL_COUNT=" + totalCount + " TOTAL_WEIGHT=" + totalWeight)