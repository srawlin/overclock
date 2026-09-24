// End-to-end smoke: runs the real bin/overclock against a local mock that
// speaks OpenAI-style SSE. Exercises the whole path — launcher bootstrap,
// pi startup, extension load, provider registration (OVERCLOCK_API_BASE),
// context + payload hooks, SSE parsing, and the metrics log — with no
// Cerebras key and no network.
//
// The heavyweight correctness eval (real API, real tasks) is test/eval/.

import { spawn, spawnSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const BIN = join(repoRoot, "bin", "overclock")

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

const REPLY = "pong-from-mock"

function sse(): string {
	const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) =>
		`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "qwen-3.8-27b", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
	return (
		chunk({ role: "assistant" }, null) +
		chunk({ content: REPLY }, null) +
		chunk({}, "stop", { prompt_tokens: 42, completion_tokens: 4, total_tokens: 46 }) +
		"data: [DONE]\n\n"
	)
}

// --- 1. launcher smoke: --version must work with no API key, fast ---
// (pi prints the version to stderr; -p waits on stdin EOF, so stdin is /dev/null)
{
	const r = spawnSync(BIN, ["--version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] })
	check("--version exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(0, 200)}`)
	check("--version prints something", ((r.stdout ?? "") + (r.stderr ?? "")).trim().length > 0)
}

// --- 1a. F3: invoking through a symlink resolves HERE to the repo ---
{
	const linkDir = mkdtempSync(join(tmpdir(), "overclock-e2e-link-"))
	const link = join(linkDir, "overclock")
	symlinkSync(BIN, link)
	const r = spawnSync(link, ["--version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] })
	check("symlinked --version exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(0, 200)}`)
	check("symlinked run uses bundled pi (no PATH fallback)", !(r.stderr ?? "").includes("using pi from PATH"), r.stderr?.slice(0, 200))
	rmSync(linkDir, { recursive: true, force: true })
}

// --- 1b. rebrand: --help addresses "overclock", pi's package.json is piConfig-patched ---
{
	const r = spawnSync(BIN, ["--help"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] })
	const help = `${r.stdout ?? ""}${r.stderr ?? ""}`
	check("--help exits 0", r.status === 0)
	check("--help brands as overclock", /(^|\s)overclock(\s|$)/m.test(help) && help.includes("OVERCLOCK_CODING_AGENT_DIR"))
	check("--help has no stray 'pi' command refs", !/(^|\s)pi (--|-[a-zA-Z]|update|config|install)/m.test(help))
	const piPkg = JSON.parse(
		readFileSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
	)
	check("pi package.json carries piConfig name", piPkg?.piConfig?.name === "overclock", JSON.stringify(piPkg?.piConfig))
}

// --- 1c. launcher arg guard: bare `--session` gets a clear error, not pi's "Unknown option" ---
{
	const r = spawnSync(BIN, ["--session"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
	check("bare --session exits nonzero", r.status !== 0)
	check("bare --session explains missing value", /requires a value/.test(r.stderr ?? ""), r.stderr?.slice(0, 160))
	const r2 = spawnSync(BIN, ["--session", "--mode", "json"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
	check("--session followed by flag also caught", r2.status !== 0 && /requires a value/.test(r2.stderr ?? ""))
}

// --- 2. full loop against mock SSE server ---
const home = mkdtempSync(join(tmpdir(), "overclock-e2e-home-"))
const hostileDir = mkdtempSync(join(tmpdir(), "overclock-e2e-env-"))
const agentDir = join(home, "agent")
let posts = 0
let sawAuth = false
let sawClearThinking = false
let lastAuth: string | undefined
let lastPayload: Record<string, unknown> | undefined

const server: Server = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ object: "list", data: [] }))
		return
	}
	let body = ""
	req.on("data", (c) => (body += c))
	req.on("end", () => {
		posts++
		lastAuth = req.headers.authorization as string | undefined
		sawAuth ||= (lastAuth ?? "").includes("Bearer")
		try {
			lastPayload = JSON.parse(body)
			if (lastPayload && (lastPayload as any).clear_thinking === true) sawClearThinking = true
		} catch {}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		})
		res.end(sse())
	})
})

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const port = (server.address() as { port: number }).port

try {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		CEREBRAS_API_KEY: "test-key",
		OVERCLOCK_API_BASE: `http://127.0.0.1:${port}/v1`,
		TERM: "dumb",
	}
	// NOTE: async spawn required — spawnSync would block this process's event
	// loop and the in-process mock server could never accept the connection.
	const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
		const c = spawn(BIN, ["-p", "say hi"], { env, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		c.stdout.on("data", (d) => (stdout += d))
		c.stderr.on("data", (d) => (stderr += d))
		c.on("exit", (status) => res({ status, stdout, stderr }))
		setTimeout(() => c.kill("SIGKILL"), 90_000)
	})

	check("mock received a POST", posts >= 1, `posts=${posts} stderr=${r.stderr?.slice(-400)}`)
	check("request carried Authorization header", sawAuth)
	check("clear_thinking applied to wire payload", sawClearThinking)
	check("model id reaches wire", (lastPayload?.model as string | undefined)?.includes("qwen") === true, JSON.stringify(lastPayload?.model))
	check("e2e run exits 0", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(-400)}`)
	check("stdout contains mock reply", (r.stdout ?? "").includes(REPLY), JSON.stringify(r.stdout?.slice(-200)))

	// --- 3. metrics pipeline wrote records ---
	const logsDir = join(agentDir, "logs")
	const files = readdirSync(logsDir).filter((f) => f.startsWith("metrics-"))
	check("metrics file written", files.length >= 1)
	const lines = files.flatMap((f) =>
		readFileSync(join(logsDir, f), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l)
				} catch {
					return null
				}
			})
			.filter(Boolean),
	)
	const kinds = new Set(lines.map((l) => l.kind))
	check("metrics has turn record", kinds.has("turn"), [...kinds].join(","))
	check("metrics has usage record", kinds.has("usage"), [...kinds].join(","))
	const usage = lines.find((l) => l.kind === "usage")
	check("usage echoes mock totals", usage?.input === 42 && usage?.output === 4, JSON.stringify(usage))
	const turn = lines.find((l) => l.kind === "turn")
	check("turn record has latency fields", typeof turn?.firstTokenMs === "number" && typeof turn?.tokensPerSec === "number", JSON.stringify(turn))

	// --- 4. F1: a hostile repo-local .env must not execute code or override
	// config — only CEREBRAS_API_KEY may be parsed out of it ---
	const pwnFile = join(hostileDir, "pwned")
	writeFileSync(
		join(hostileDir, ".env"),
		[
			"PWNED=$(touch " + pwnFile + ")",
			"touch " + pwnFile,
			"OVERCLOCK_API_BASE=http://127.0.0.1:1/evil",
			"CEREBRAS_API_KEY=dotenv-key",
		].join("\n") + "\n",
	)
	{
		// no CEREBRAS_API_KEY in env → launcher must parse (not source) ./.env
		const { CEREBRAS_API_KEY: _drop, ...env2 } = env
		const postsBefore = posts
		const r2 = await new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
			const c = spawn(BIN, ["-p", "say hi"], { env: env2, cwd: hostileDir, stdio: ["ignore", "pipe", "pipe"] })
			let stdout = ""
			let stderr = ""
			c.stdout.on("data", (d) => (stdout += d))
			c.stderr.on("data", (d) => (stderr += d))
			c.on("exit", (status) => res({ status, stdout, stderr }))
			setTimeout(() => c.kill("SIGKILL"), 90_000)
		})
		check("hostile .env: no code executed", !existsSync(pwnFile))
		check("hostile .env: request still reached the mock (API_BASE not overridden)", posts > postsBefore, `posts=${posts} stderr=${r2.stderr?.slice(-300)}`)
		check("hostile .env: key parsed and sent", lastAuth === "Bearer dotenv-key", `auth=${lastAuth}`)
	}
} finally {
	server.close()
	rmSync(home, { recursive: true, force: true })
	rmSync(hostileDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
