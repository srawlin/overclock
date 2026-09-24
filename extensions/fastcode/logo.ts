// fastcode startup banner — installed via ctx.ui.setHeader in session_start,
// replacing pi's built-in "pi vX" header in interactive mode.
//
// "fast" is figlet Slant (literally slanted) + ANSI italic; "code" is figlet
// Standard upright. The component is a plain { render } object — pi-tui's
// Component is structural, so no pi-tui import needed.

const ITALIC = "\x1b[3m"
const ITALIC_OFF = "\x1b[23m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

// figlet "Slant" fast + figlet "Standard" code, merged at a fixed 23-col split.
const FAST = [
	"    ____           __  ",
	"   / __/___ ______/ /_ ",
	"  / /_/ __ `/ ___/ __/ ",
	" / __/ /_/ (__  ) /_   ",
	"/_/  \\__,_/____/\\__/   ",
]

const CODE = [
	"                _",
	"   ___ ___   __| | ___",
	"  / __/ _ \\ / _` |/ _ \\",
	" | (_| (_) | (_| |  __/",
	"  \\___\\___/ \\__,_|\\___|",
]

const TAGLINE = "Cerebras-fast coding agent"

/** Logo lines with ANSI styling applied (fast = italic, tagline = dim). */
export function logoLines(): string[] {
	return [
		"",
		...FAST.map((line, i) => `${ITALIC}${line}${ITALIC_OFF}${CODE[i]}`),
		`    ${DIM}${TAGLINE}${RESET}`,
		"",
	]
}

/** pi-tui Component rendering the logo verbatim (no word-wrap). */
export function logoComponent() {
	return {
		render: () => logoLines(),
		invalidate: () => {},
	}
}
