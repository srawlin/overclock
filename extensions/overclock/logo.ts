// overclock startup banner — installed via ctx.ui.setHeader in session_start,
// replacing pi's built-in "pi vX" header in interactive mode.
//
// "over" is figlet Slant (literally slanted) + ANSI italic; "clock" is figlet
// Standard upright. The component is a plain { render } object — pi-tui's
// Component is structural, so no pi-tui import needed.

const ITALIC = "\x1b[3m"
const ITALIC_OFF = "\x1b[23m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

// figlet "Slant" over + figlet "Standard" clock, merged at a fixed 24-col split.
const OVER = [
	"                        ",
	"  ____ _   _____  _____ ",
	" / __ \\ | / / _ \\/ ___/ ",
	"/ /_/ / |/ /  __/ /     ",
	"\\____/|___/\\___/_/      ",
]

const CLOCK = [
	"       _            _",
	"   ___| | ___   ___| | __",
	"  / __| |/ _ \\ / __| |/ /",
	" | (__| | (_) | (__|   <",
	"  \\___|_|\\___/ \\___|_|\\_\\",
]

const TAGLINE = "Cerebras-fast coding agent"
const DISCLAIMER = "personal project — not affiliated with Cerebras"

/** Logo lines with ANSI styling applied (over = italic, tagline = dim). */
export function logoLines(): string[] {
	return [
		"",
		...OVER.map((line, i) => `${ITALIC}${line}${ITALIC_OFF}${CLOCK[i]}`),
		`    ${DIM}${TAGLINE}${RESET}`,
		`    ${DIM}${DISCLAIMER}${RESET}`,
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
