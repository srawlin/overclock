// paceRequest() sleep must be ref'd — in print/json mode it can be the only
// pending work, and the old unref'd timer let the process exit mid-task —
// while still waking early on abort. The pacing window is module state, so
// each scenario runs in its own fresh child process.
//
// Children run under **node**, not bun: bun keeps the process alive for a
// pending top-level await even when the only timer is unref'd, so the liveness
// regression wouldn't reproduce there (pi itself runs under node). The TS
// module is bundled first because node can't resolve its extensionless
// relative imports.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const MODULE = join(repoRoot, "extensions", "overclock", "provider-tuning.ts")

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

function runChild(name: string, body: string) {
	const dir = mkdtempSync(join(tmpdir(), "overclock-pace-"))
	const bundle = join(dir, "mod.mjs")
	const build = spawnSync("bun", ["build", MODULE, "--target", "node", "--outfile", bundle], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	})
	if (build.status !== 0) {
		rmSync(dir, { recursive: true, force: true })
		return { status: 1, stdout: "", stderr: `bun build failed: ${build.stderr}` }
	}
	const script = join(dir, `${name}.mjs`)
	writeFileSync(script, `import { paceRequest } from ${JSON.stringify(bundle)}\n${body}\n`)
	const r = spawnSync("node", [script], {
		encoding: "utf8",
		timeout: 30_000,
		env: { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: join(dir, "agent") },
	})
	rmSync(dir, { recursive: true, force: true })
	return r
}

const elapsed = (r: { stdout?: string }) => Number(r.stdout?.match(/(?:woke|done) (\d+)/)?.[1])

// --- 1. liveness regression: a ~200ms sleep must run to completion ---
// Fake Date.now 59.8s into the past for the first call so its window entry is
// still live when the second call runs at real time → delay lands ~200ms in
// the future. With an unref'd timer the child exits before printing "woke".
{
	const r = runChild(
		"liveness",
		`const real = Date.now
Date.now = () => real() - 59_800
await paceRequest(600_000)
Date.now = real
const t = real()
await paceRequest(1_000)
console.log("woke", real() - t)`,
	)
	check("liveness: child exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(-200)}`)
	check("liveness: sleep ran to completion", r.stdout?.includes("woke") === true, `stdout=${r.stdout}`)
	check("liveness: slept ~200ms", elapsed(r) >= 150 && elapsed(r) < 5_000, `ms=${elapsed(r)}`)
}

// --- 2. abort mid-sleep: full window → ~10s pace, cancelled at 50ms ---
{
	const r = runChild(
		"abort-mid-sleep",
		`await paceRequest(600_000)
const ac = new AbortController()
const t = Date.now()
setTimeout(() => ac.abort(), 50)
await paceRequest(1_000, ac.signal)
console.log("done", Date.now() - t)`,
	)
	check("abort mid-sleep: exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(-200)}`)
	check("abort mid-sleep: resolved <1s", elapsed(r) < 1_000, `ms=${elapsed(r)}`)
}

// --- 3. already-aborted signal → immediate return, nothing pushed ---
{
	const r = runChild(
		"pre-aborted",
		`await paceRequest(600_000)
const ac = new AbortController()
ac.abort()
const t = Date.now()
await paceRequest(1_000, ac.signal)
console.log("done", Date.now() - t)`,
	)
	check("pre-aborted: exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(-200)}`)
	check("pre-aborted: resolved <50ms", elapsed(r) < 50, `ms=${elapsed(r)}`)
}

// --- 4. under budget → no sleep ---
{
	const r = runChild(
		"under-budget",
		`const t = Date.now()
await paceRequest(1_000)
console.log("done", Date.now() - t)`,
	)
	check("under budget: exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(-200)}`)
	check("under budget: resolved <50ms", elapsed(r) < 50, `ms=${elapsed(r)}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
