#!/usr/bin/env node
// overclock eval harness — runs a fixed set of tasks through the real overclock
// CLI end-to-end, measuring wall clock, LLM latency (TTFT / tok-s / turns) and
// tool behavior, and verifying correctness. This is the "did we get faster AND
// stay smart" scoreboard.
//
// Usage:
//   node test/eval/run.mjs                     # run all tasks
//   node test/eval/run.mjs --only fix-bug      # single task (prefix match)
//   node test/eval/run.mjs --repeat 3          # repeat each task N times
//   OVERCLOCK_MODEL=cerebras/gpt-oss-120b node test/eval/run.mjs   # compare models
//
// Env:
//   OVERCLOCK_MODEL   — model id (default: the harness default, cerebras/qwen-3.8-27b)
//   OVERCLOCK_FAST=1  — enables OVERCLOCK_FAST experiment knobs in the extension
//   (legacy FASTCODE_* names still work — the launcher/knobs read both)
//
// Each task spawns:  bin/overclock --mode json --print "<task hint>"
// in a fresh throwaway copy of the fixture. We parse the JSON event stream for
// per-turn timing, read the metrics JSONL for the run rollup, then run the
// task's `verify` command (usually the fixture's test suite) for correctness.

import { spawn, execFileSync } from "node:child_process"
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	cpSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../..")
const FIXTURE = (name = "calc") => join(here, "fixtures", name)
const BIN = join(repoRoot, "bin", "overclock")
const MODEL = process.env.OVERCLOCK_MODEL || process.env.FASTCODE_MODEL || "cerebras/qwen-3.8-27b"
const FAST_ON = process.env.OVERCLOCK_FAST === "1" || process.env.FASTCODE_FAST === "1"
const TIMEOUT_MS = 240_000

// ---------------------------------------------------------------------------
// Tasks. `hint` is sent as the user prompt; `verify` is a shell command run in
// the task worktree (0 = passed). Prompts are terse and unambiguous — the point
// is to measure the harness, not prompt engineering.
// ---------------------------------------------------------------------------
const TASKS = [
	{
		name: "fix-bug",
		fixture: "calc",
		hint: "The calc fixture's test suite is failing. Find and fix the bug in src/lib.js so that `node test/calc.test.js` passes. Only change what's needed, then run the test to confirm.",
		verify: "node test/calc.test.js",
	},
	{
		name: "add-feature",
		fixture: "calc-fixed",
		hint: "Add a `lcm(a, b)` function to src/lib.js (least common multiple; lcm(0,x)=0). Export it and add tests to test/calc.test.js covering lcm(4,6)=12, lcm(0,5)=0, lcm(7,3)=21. Run `node test/calc.test.js` to confirm all pass.",
		verify: "node test/calc.test.js",
	},
	{
		name: "explore-then-fix",
		fixture: "calc",
		hint: "Using the explore tool, figure out which function in src/lib.js is buggy and why the suite fails. Then fix it so `node test/calc.test.js` passes. Report the file:line of the fix.",
		verify: "node test/calc.test.js",
	},
	{
		name: "aggr-scan",
		fixture: "aggr",
		hint: "Create out/manifest.json with the exact keys total_count and total_weight, each an integer. The values must equal the sum of the COUNT and WEIGHT constants across every module in src/ (skip index.js). Read each module file directly and sum accurately; do not guess.",
		verify: "node tests/verify_manifest.mjs",
	},
]

// ---------------------------------------------------------------------------
const sh = (cmd, cwd) =>
	execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })

function makeWorktree(agentDir, task) {
	const wt = join(agentDir, "work-" + Math.random().toString(36).slice(2, 8))
	cpSync(FIXTURE(task.fixture), wt, { recursive: true })
	return wt
}

const parseJsonl = (text) =>
	text.split("\n").reduce((acc, line) => {
		line = line.trim()
		if (!line) return acc
		try {
			acc.push(JSON.parse(line))
		} catch {}
		return acc
	}, [])

function latestMetrics(agentDir) {
	let files = []
	try {
		files = readdirSync(join(agentDir, "logs"))
			.filter((f) => f.startsWith("metrics-") && f.endsWith(".jsonl"))
			.map((f) => join(agentDir, "logs", f))
			.sort()
	} catch {
		return []
	}
	if (!files.length) return []
	return parseJsonl(readFileSync(files[files.length - 1], "utf8"))
}

function summarizeStream(evts) {
	let turns = 0
	let toolCalls = 0
	let toolErrs = 0
	let agentEnded = false
	let sawError = false
	for (const e of evts) {
		if (e.type === "turn_end") turns++
		else if (e.type === "tool_execution_start") toolCalls++
		else if (e.type === "tool_execution_end") toolErrs += e.isError ? 1 : 0
		else if (e.type === "agent_end") agentEnded = true
		else if (typeof e.type === "string" && e.type.includes("error")) sawError = true
	}
	return { turns, toolCalls, toolErrs, agentEnded, sawError }
}

function summarizeMetrics(met) {
	let inputTok = 0
	let cacheReadTok = 0
	let outputTok = 0
	let ttftSum = 0
	let ttftN = 0
	let tokPerSec = 0
	for (const m of met) {
		if (m.kind === "usage") {
			inputTok += (m.input ?? 0) + (m.cacheRead ?? 0)
			cacheReadTok += m.cacheRead ?? 0
			outputTok += m.output ?? 0
		} else if (m.kind === "turn") {
			ttftSum += m.firstTokenMs ?? 0
			ttftN++
		} else if (m.kind === "run_end") {
			tokPerSec = m.tokensPerSec ?? 0
		}
	}
	return {
		inputTok,
		cacheReadTok,
		outputTok,
		ttftMs: ttftN ? Math.round(ttftSum / ttftN) : 0,
		tokPerSec,
	}
}

async function runOnce(task, idx, agentDir) {
	const wt = makeWorktree(agentDir, task)
	const t0 = Date.now()
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		OVERCLOCK_MODEL: MODEL,
	}

	let timedOut = false
	let stdout = ""
	let stderr = ""
	let exitCode = 0
	await new Promise((resolveP) => {
		const child = spawn(BIN, ["--mode", "json", "--print", task.hint], { cwd: wt, env, stdio: ["ignore", "pipe", "pipe"] })
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, TIMEOUT_MS)
		child.stdout.on("data", (d) => (stdout += d))
		child.stderr.on("data", (d) => (stderr += d))
		child.on("close", (code) => {
			clearTimeout(timer)
			exitCode = code ?? 0
			resolveP()
		})
	})
	const wallMs = Date.now() - t0

	const stream = summarizeStream(parseJsonl(stdout))
	const metSum = summarizeMetrics(latestMetrics(agentDir))

	let correct = 0
	let verifyErr = ""
	try {
		sh(task.verify, wt)
		correct = 1
	} catch (e) {
		verifyErr = String(e?.stderr || e?.message || e).slice(0, 300)
	}
	let diff = ""
	try {
		diff = sh("git --no-pager diff --stat", wt)
	} catch {}

	const res = {
		task: task.name,
		idx,
		correct,
		failed: timedOut || stream.sawError,
		timedOut,
		exitCode,
		wallSec: Math.round((wallMs / 1000) * 10) / 10,
		turns: stream.turns,
		toolCalls: stream.toolCalls,
		toolErrs: stream.toolErrs,
		ttftMs: metSum.ttftMs,
		tokPerSec: metSum.tokPerSec,
		inputTok: metSum.inputTok,
		cacheReadTok: metSum.cacheReadTok,
		outputTok: metSum.outputTok,
		verifyErr,
		diff,
	}
	if (!KEEP) rmSync(wt, { recursive: true, force: true })
	return res
}

let KEEP = false
function parseArgs() {
	const args = process.argv.slice(2)
	const only = new Set()
	let repeat = 1
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--only") {
			for (const p of (args[++i] ?? "").split(",")) if (p) only.add(p)
		} else if (args[i] === "--repeat") repeat = Math.max(1, parseInt(args[++i], 10) || 1)
		else if (args[i] === "--keep") KEEP = true
	}
	return { only, repeat }
}

async function main() {
	const { only, repeat } = parseArgs()
	const tasks = TASKS.filter((t) => only.size === 0 || [...only].some((p) => t.name === p || t.name.startsWith(p)))
	if (!tasks.length) {
		console.error(`no tasks match --only ${[...only].join(",")}  (available: ${TASKS.map((t) => t.name).join(", ")})`)
		process.exit(2)
	}
	const agentDir = mkdtempSync(join(tmpdir(), "overclock-eval-agent-"))
	console.log(`# overclock eval  model=${MODEL}  fast=${FAST_ON ? "ON" : "off"}  ${tasks.length} task(s) x ${repeat}${KEEP ? "  [--keep]" : ""}`)

	const results = []
	for (const task of tasks) {
		for (let i = 1; i <= repeat; i++) {
			const r = await runOnce(task, i, agentDir)
			results.push(r)
			const verdict = r.correct ? "PASS" : "FAIL"
			const warn = r.failed ? `  [${[r.timedOut ? "timeout" : "", r.toolErrs ? `toolerr=${r.toolErrs}` : ""].filter(Boolean).join(",")}]` : ""
			console.log(
				`  ${verdict}  ${r.task}#${r.idx}: ${r.wallSec}s  ${r.turns}turns  ${r.toolCalls}tools  ttft ${r.ttftMs}ms  ${r.tokPerSec}tok/s  in=${r.inputTok}tok (cache ${r.cacheReadTok})${warn}`,
			)
			if (r.verifyErr.trim()) console.log(`        verify: ${r.verifyErr.trim().split("\n").slice(0, 3).join(" | ")}`)
			if (r.diff.trim()) console.log(`        diff: ${r.diff.trim()}`)
		}
	}

	const pass = results.filter((r) => r.correct).length
	const perTask = {}
	for (const t of tasks) {
		const rs = results.filter((r) => r.task === t.name)
		if (!rs.length) continue
		const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length
		perTask[t.name] = {
			pass: `${rs.filter((r) => r.correct).length}/${rs.length}`,
			avgWallSec: +avg("wallSec").toFixed(1),
			avgTurns: +avg("turns").toFixed(1),
			avgTtftMs: Math.round(avg("ttftMs")),
			avgTokPerSec: Math.round(avg("tokPerSec") * 10) / 10,
			avgInputTok: Math.round(avg("inputTok")),
			avgOutputTok: Math.round(avg("outputTok")),
		}
	}
	const summary = {
		model: MODEL,
		fast: FAST_ON,
		passed: pass,
		total: results.length,
		passRate: results.length ? +((pass / results.length) * 100).toFixed(1) : 0,
		totalWallSec: +results.reduce((a, r) => a + r.wallSec, 0).toFixed(1),
		perTask,
	}
	const outDir = join(here, "results")
	mkdirSync(outDir, { recursive: true })
	const outFile = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${MODEL.replace(/[^a-z0-9.-]/gi, "_")}.json`)
	writeFileSync(outFile, JSON.stringify(summary, null, 2))

	console.log(`\n# SUMMARY  pass ${pass}/${results.length} (${summary.passRate}%)  total wall ${summary.totalWallSec}s`)
	console.log(`# results -> ${outFile}`)
	if (KEEP) console.log(`# kept workspaces for debugging -> ${agentDir}`)
	else rmSync(agentDir, { recursive: true, force: true })
}

main().catch((e) => {
	console.error("overclock-eval crashed:", e)
	process.exit(1)
})