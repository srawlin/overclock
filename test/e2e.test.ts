// End-to-end smoke: runs the real bin/overclock against a local mock that
// speaks OpenAI-style SSE. Exercises the whole path — launcher bootstrap,
// pi startup, extension load, provider registration (OVERCLOCK_API_BASE),
// context + payload hooks, SSE parsing, and the metrics log — with no
// Cerebras key and no network.
//
// The heavyweight correctness eval (real API, real tasks) is test/eval/.

import { spawn, spawnSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent"
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

function sseChunk(delta: Record<string, unknown>, finish: string | null, usage?: unknown): string {
	return `data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "qwen-3.8-27b", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
}

function sse(): string {
	return (
		sseChunk({ role: "assistant" }, null) +
		sseChunk({ content: REPLY }, null) +
		sseChunk({}, "stop", { prompt_tokens: 42, completion_tokens: 4, total_tokens: 46 }) +
		"data: [DONE]\n\n"
	)
}

const sseText = (text: string) =>
	sseChunk({ role: "assistant" }, null) +
	sseChunk({ content: text }, null) +
	sseChunk({}, "stop", { prompt_tokens: 42, completion_tokens: 4, total_tokens: 46 }) +
	"data: [DONE]\n\n"

let callSeq = 0
const sseToolCall = (name: string, args: string) =>
	sseChunk({ role: "assistant" }, null) +
	sseChunk({ tool_calls: [{ index: 0, id: `call_${++callSeq}`, type: "function", function: { name, arguments: args } }] }, null) +
	sseChunk({}, "tool_calls", { prompt_tokens: 42, completion_tokens: 4, total_tokens: 46 }) +
	"data: [DONE]\n\n"

// Turn-cap scenarios: classify each POST. Sub-agent requests carry the explore
// system prompt; the main loop's requests either start the explore call or
// arrive with its tool result.
let mockMode: "fixed" | "cap-complies" | "cap-ignores" = "fixed"
let explorePosts = 0
let exploreResultText = ""
let finalMainPosts = 0

function turncapReply(bodyJson: Record<string, unknown>): string {
	const messages = (bodyJson.messages ?? []) as { role?: string; content?: unknown }[]
	const sys = messages.find((m) => m.role === "system")
	const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "")
	const bodyStr = JSON.stringify(bodyJson)
	if (sysText.includes("read-only exploration sub-agent")) {
		explorePosts++
		if (bodyStr.includes("Turn limit reached"))
			return mockMode === "cap-complies" ? sseText("partial-answer-from-explore") : sseToolCall("ls", `{"path":"."}`)
		return sseToolCall("ls", `{"path":"."}`)
	}
	const toolMsg = messages.find((m) => m.role === "tool")
	if (toolMsg) {
		finalMainPosts++
		exploreResultText = typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content)
		return sseText("done")
	}
	return sseToolCall("explore", `{"task":"find the bug"}`)
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

// --- 1a2. F8: --safe is consumed by the launcher (pi would reject it) ---
{
	const r = spawnSync(BIN, ["--safe", "--version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] })
	check("--safe --version exits 0 (flag consumed)", r.status === 0, `status=${r.status} stderr=${r.stderr?.slice(0, 200)}`)
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
		res.end(mockMode === "fixed" || !lastPayload ? sse() : turncapReply(lastPayload))
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
	check("key resolved via !command file (Bearer test-key)", lastAuth === "Bearer test-key", `auth=${lastAuth}`)

	// --- 2b. F2/F6: key landed in a 0600 file, agent dir is 0700 ---
	{
		const keyFile = join(home, ".config", "overclock", "key")
		check("key file written", existsSync(keyFile))
		check("key file mode 0600", existsSync(keyFile) && (statSync(keyFile).mode & 0o777) === 0o600, `mode=${existsSync(keyFile) ? (statSync(keyFile).mode & 0o777).toString(8) : "n/a"}`)
		check("key file holds the key", existsSync(keyFile) && readFileSync(keyFile, "utf8") === "test-key")
		check("agent dir mode 0700", (statSync(agentDir).mode & 0o777) === 0o700, `mode=${(statSync(agentDir).mode & 0o777).toString(8)}`)
	}

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

	// --- 5. F15: --safe must not execute configured MCP servers ---
	// Global mcp.json (agent dir) + a *remembered-trusted* project's
	// .overclock/mcp.json each spawn a marker command at session start. Default
	// mode must run both (control — proves the setup is live); --safe must run
	// neither, while still reaching the mock with the five read-only tools.
	{
		// realpath: pi canonicalizes cwd (/var → /private/var on macOS) before
		// trust lookup, so store trust under the canonical path pi will see.
		const projDir = realpathSync(mkdtempSync(join(tmpdir(), "overclock-e2e-proj-")))
		mkdirSync(join(projDir, ".overclock"), { recursive: true })
		const projMarker = join(projDir, "mcp-marker-proj")
		const globalMarker = join(projDir, "mcp-marker-global")
		// distinct server names — project and global mcp.json merge by name,
		// and a collision would shadow one probe.
		const mcp = (name: string, marker: string) =>
			JSON.stringify({ mcpServers: { [name]: { command: "sh", args: ["-c", `touch ${marker}; sleep 5`] } } })
		writeFileSync(join(projDir, ".overclock", "mcp.json"), mcp("probe-proj", projMarker))
		writeFileSync(join(agentDir, "mcp.json"), mcp("probe-global", globalMarker))
		new ProjectTrustStore(agentDir).set(projDir, true)

		const runOC = (args: string[], cwd: string) =>
			new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
				const c = spawn(BIN, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] })
				let stdout = ""
				let stderr = ""
				c.stdout.on("data", (d) => (stdout += d))
				c.stderr.on("data", (d) => (stderr += d))
				c.on("exit", (status) => res({ status, stdout, stderr }))
				setTimeout(() => c.kill("SIGKILL"), 90_000)
			})
		// markers land when the MCP extension spawns the server — allow ~2s
		// after exit before judging, so the assertions aren't racy.
		const settle = async (p: string) => {
			for (let i = 0; i < 40 && !existsSync(p); i++) await new Promise((r) => setTimeout(r, 50))
			return existsSync(p)
		}

		// control — default mode, trusted project
		const rc = await runOC(["-p", "hello"], projDir)
		const projHit = await settle(projMarker)
		const globHit = await settle(globalMarker)
		check("F15 control: project mcp.json command ran", projHit)
		check("F15 control: global mcp.json command ran", globHit)
		check("F15 control: run exits 0", rc.status === 0, `status=${rc.status} stderr=${rc.stderr?.slice(-200)}`)

		// safe — neither config may execute, safe tools on the wire
		rmSync(projMarker, { force: true })
		rmSync(globalMarker, { force: true })
		const postsBeforeSafe = posts
		const rs = await runOC(["--safe", "-p", "hello"], projDir)
		await new Promise((r) => setTimeout(r, 2000))
		check("F15 safe: project mcp.json NOT executed", !existsSync(projMarker))
		check("F15 safe: global mcp.json NOT executed", !existsSync(globalMarker))
		check("F15 safe: run exits 0", rs.status === 0, `status=${rs.status} stderr=${rs.stderr?.slice(-200)}`)
		check("F15 safe: request still reached mock", posts > postsBeforeSafe)
		check(
			"F15 safe: wire tools are exactly the safe five",
			(lastPayload?.tools as { function?: { name?: string } }[] | undefined)
				?.map((t) => t.function?.name)
				.join(",") === "read,grep,find,ls,explore",
		)

		// --safe must reject --approve/-a (pi would take the last one)
		for (const flag of ["-a", "--approve"]) {
			const before = posts
			const ra = await runOC(["--safe", flag, "-p", "hello"], projDir)
			check(`F15: --safe ${flag} exits 1`, ra.status === 1, `status=${ra.status}`)
			check(`F15: --safe ${flag} explains`, /cannot be combined/.test(ra.stderr ?? ""), ra.stderr?.slice(0, 160))
			check(`F15: --safe ${flag} sent no request`, posts === before)
		}
		// args after `--` are prompt text, not flags
		const rp = await runOC(["-p", "--", "--safe", "-a"], projDir)
		check("F15: `-- --safe -a` not treated as flags", rp.status === 0 && !/cannot be combined/.test(rp.stderr ?? ""), `status=${rp.status} ${rp.stderr?.slice(0, 160)}`)

		rmSync(join(agentDir, "mcp.json"), { force: true })
		rmSync(projDir, { recursive: true, force: true })
	}

	// --- 6. F13: sub-agent turn cap ---
	// With OVERCLOCK_SUBAGENT_MAX_TURNS=3, the explore sub-agent gets a wrap-up
	// steer after its 3rd tool turn. "Complies" answers with text on turn 4;
	// "ignores" calls a tool again and is aborted. Either way: 4 explore
	// requests, a capped tool result, and a completed main loop.
	{
		const capCwd = realpathSync(mkdtempSync(join(tmpdir(), "overclock-e2e-cap-")))
		const capEnv = { ...env, OVERCLOCK_SUBAGENT_MAX_TURNS: "3" }
		const runCap = () =>
			new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
				const c = spawn(BIN, ["-p", "investigate with explore"], { env: capEnv, cwd: capCwd, stdio: ["ignore", "pipe", "pipe"] })
				let stdout = ""
				let stderr = ""
				c.stdout.on("data", (d) => (stdout += d))
				c.stderr.on("data", (d) => (stderr += d))
				c.on("exit", (status) => res({ status, stdout, stderr }))
				setTimeout(() => c.kill("SIGKILL"), 90_000)
			})

		mockMode = "cap-complies"
		explorePosts = 0
		exploreResultText = ""
		finalMainPosts = 0
		const rComp = await runCap()
		mockMode = "fixed"
		check("cap/complies: run exits 0", rComp.status === 0, `status=${rComp.status} stderr=${rComp.stderr?.slice(-200)}`)
		check("cap/complies: explore stopped at 4 requests (3 turns + wrap-up)", explorePosts === 4, `posts=${explorePosts}`)
		check("cap/complies: tool result carries the partial answer", exploreResultText.includes("partial-answer-from-explore"), exploreResultText.slice(0, 160))
		check("cap/complies: tool result notes the 3-turn limit", exploreResultText.includes("3-turn limit"), exploreResultText.slice(0, 160))
		check("cap/complies: main loop finished", finalMainPosts === 1, `finalMainPosts=${finalMainPosts}`)
		{
			const files = readdirSync(join(agentDir, "logs")).filter((f) => f.startsWith("metrics-"))
			const recs = files.flatMap((f) =>
				readFileSync(join(agentDir, "logs", f), "utf8")
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
			const sub = recs.find((l) => l.kind === "subagent" && l.capped === true)
			check("cap/complies: metrics has capped subagent record", !!sub)
			check("cap/complies: subagent record has maxTurns=3", sub?.maxTurns === 3, JSON.stringify(sub))
		}

		mockMode = "cap-ignores"
		explorePosts = 0
		exploreResultText = ""
		finalMainPosts = 0
		const rIgn = await runCap()
		mockMode = "fixed"
		check("cap/ignores: run exits 0", rIgn.status === 0, `status=${rIgn.status} stderr=${rIgn.stderr?.slice(-200)}`)
		check("cap/ignores: explore aborted at 4 requests (no 5th)", explorePosts === 4, `posts=${explorePosts}`)
		check("cap/ignores: tool result notes the 3-turn limit", exploreResultText.includes("3-turn limit"), exploreResultText.slice(0, 160))
		check("cap/ignores: main loop finished", finalMainPosts === 1, `finalMainPosts=${finalMainPosts}`)

		rmSync(capCwd, { recursive: true, force: true })
	}
} finally {
	server.close()
	rmSync(home, { recursive: true, force: true })
	rmSync(hostileDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
