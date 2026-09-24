import { createRequire } from "node:module"

// pi's own update banner is suppressed in bin/fastcode (PI_SKIP_VERSION_CHECK=1):
// it names "pi" and suggests `pi update`, which fastcode users don't have on
// PATH — the notice reads like a fastcode update and the fix command fails.
// This check reports the same signal with fastcode branding and the correct
// upgrade path (bump the npm dep in this repo).
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version"
const PI_PACKAGE = "@earendil-works/pi-coding-agent"

function installedPiVersion(): string | undefined {
	try {
		const req = createRequire(import.meta.url)
		const pkg = req(`${PI_PACKAGE}/package.json`) as { version?: string }
		return pkg.version
	} catch {
		return undefined
	}
}

export function newerVersion(candidate: string, current: string): boolean {
	const parse = (v: string) => v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
	const c = parse(candidate)
	const cur = parse(current)
	if (!c || !cur) return false
	for (let i = 1; i <= 3; i++) {
		const d = Number(c[i]) - Number(cur[i])
		if (d !== 0) return d > 0
	}
	return false
}

/** Fire-and-forget: checks pi.dev for a newer pi runtime and notifies the user.
 *  Never throws, never blocks startup — the fetch is unref'd via timeout. */
export function checkPiUpdate(notify: (message: string, type?: "info" | "warning" | "error") => void): void {
	const current = installedPiVersion()
	if (!current || process.env.PI_OFFLINE) return
	void (async () => {
		try {
			const res = await fetch(LATEST_VERSION_URL, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(8_000),
			})
			if (!res.ok) return
			const data = (await res.json()) as { version?: string }
			if (typeof data.version === "string" && newerVersion(data.version, current)) {
				notify(
					`pi runtime update available: ${current} → ${data.version} ` +
						`(fastcode is built on pi). Upgrade: npm install ${PI_PACKAGE}@latest in the fastcode repo.`,
					"info",
				)
			}
		} catch {
			// offline or endpoint down — stay silent
		}
	})()
}
