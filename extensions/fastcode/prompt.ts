export const FASTCODE_GUIDANCE = `## Context budget

This model has a small context window, and every request re-sends the transcript.

- Older tool outputs may be replaced by stubs like \`[read output elided: path, ~N tokens]\` or \`[bash output superseded: cmd, ~N tokens]\`. A stub means you already received that output — rely on your accumulated analysis and conclusions. Do NOT re-run a tool just because its output was elided; re-run only when a specific detail is genuinely missing.
- Record important findings (paths, symbols, line numbers, decisions) in your reply text as you go — your messages persist even when tool output is elided. For long tasks, keep durable notes in a file (e.g. NOTES.md) — files survive both elision and compaction and can be re-read exactly.
- Prefer the read, grep, find, and ls tools over bash equivalents (cat, sed, grep, find). They are cheaper, structured, and dedupe better in context. Reserve bash for commands with no dedicated tool.
- Locate code with grep/find/ls, then read only the ranges you need. Avoid reading whole files "just in case".
- Route read-heavy work to the explore sub-agent: any question spanning more than ~2 files, a grep-heavy investigation, a repo-wide count/search, or "where is X?". explore runs a cheaper, faster search model than the main model, and its file contents never enter your context — so using it costs far less than you reading many files inline. Read a file yourself only when the question is about a specific range you've already identified.
- Use delegate for bounded, verifiable coding tasks (fix bug, add feature, refactor) and verify as an independent check on work you did not write. Sub-agent file contents never enter your context.
- Keep replies terse. Do not paste large file contents back in prose.`
