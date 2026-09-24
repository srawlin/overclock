// verify_manifest.mjs — verifies out/manifest.json holds the correct aggregates.
//
// The expected totals are hard-coded (172 / 330) as the ground truth for this
// deterministic fixture. We additionally re-read the source modules and require
// they still sum to those hard-coded values, so the agent cannot game a correct
// manifest by editing a module's constants. If the fixture constants ever change,
// update EXPECTED below.
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const EXPECTED = { total_count: 172, total_weight: 330 }

let manifest
try {
	manifest = JSON.parse(readFileSync(join(root, "out", "manifest.json"), "utf8"))
} catch {
	console.error("FAIL: out/manifest.json does not exist or is not valid JSON")
	process.exit(1)
}

// Sanity: the source modules must still sum to the hard-coded ground truth.
let count = 0
let weight = 0
for (const f of readdirSync(join(root, "src"))) {
	if (f === "index.js") continue
	const t = readFileSync(join(root, "src", f), "utf8")
	const cm = /export const COUNT = (\d+)/.exec(t)
	const wm = /export const WEIGHT = (\d+)/.exec(t)
	if (cm) count += Number(cm[1])
	if (wm) weight += Number(wm[1])
}
if (count !== EXPECTED.total_count || weight !== EXPECTED.total_weight) {
	console.error(
		`FAIL: source modules were modified (now ${count}/${weight}, expect ` +
			`${EXPECTED.total_count}/${EXPECTED.total_weight}). The task is to only create out/manifest.json.`,
	)
	process.exit(1)
}

let ok = true
for (const key of ["total_count", "total_weight"]) {
	const want = EXPECTED[key]
	const got = manifest[key]
	if (got !== want) {
		console.error(`FAIL: ${key} is ${JSON.stringify(got)}, expected ${want}`)
		ok = false
	} else {
		console.log(`ok  ${key} = ${got}`)
	}
}
process.exit(ok ? 0 : 1)