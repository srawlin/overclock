// Rebrands the installed pi-coding-agent runtime so pi's user-facing surfaces
// say "overclock" instead of "pi".
//
// 1. Writes `piConfig` into pi's package.json — pi's designed rebrand hook.
//    APP_NAME becomes "overclock" everywhere it's derived: the session-resume
//    hint, update/config/-r instructions, --help output, crash messages, and
//    the agent-dir env vars (OVERCLOCK_CODING_AGENT_DIR / _SESSION_DIR).
//    configDir ".overclock" makes ~/.overclock the default state root.
//
// 2. String-patches the handful of literals piConfig can't reach (they're
//    hardcoded in dist, not APP_NAME-derived): "restart pi" in the project
//    trust warning and "start pi and" in crash-report instructions.
//
// npm wipes both patches whenever pi is reinstalled/upgraded, so this runs as
// a postinstall hook and is idempotent. If a future pi rewords the patched
// strings or drops piConfig, the affected replace simply misses — cosmetic
// only, no breakage.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const piPkgDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
)
const pkgPath = join(piPkgDir, "package.json")
if (!existsSync(pkgPath)) process.exit(0)

// --- 1. piConfig branding ---
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const desired = { name: "overclock", configDir: ".overclock" }
if (pkg.piConfig?.name !== desired.name || pkg.piConfig?.configDir !== desired.configDir) {
	pkg.piConfig = { ...pkg.piConfig, ...desired }
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
	console.log("overclock: applied piConfig branding to pi-coding-agent")
}

// --- 2. literal-string patches ---
const PATCHES = [
	{
		file: join(piPkgDir, "dist", "modes", "interactive", "interactive-mode.js"),
		replacements: [
			["then restart pi.", "then restart overclock."],
			['"start pi and"', '"start overclock and"'],
		],
	},
]
for (const { file, replacements } of PATCHES) {
	if (!existsSync(file)) continue
	const src = readFileSync(file, "utf8")
	const patched = replacements.reduce((s, [from, to]) => s.replaceAll(from, to), src)
	if (patched !== src) {
		writeFileSync(file, patched)
		console.log(`overclock: patched pi literals in ${file.split("/").slice(-1)[0]}`)
	}
}
