export const FASTCODE_GUIDANCE = `## Context budget

This model has a small context window, and every request re-sends the transcript.

- Older tool outputs may be replaced by stubs like \`[read output elided: path, ~N tokens]\` or \`[bash output superseded: cmd, ~N tokens]\`. A stub means you already received that output — rely on your accumulated analysis and conclusions. Do NOT re-run a tool just because its output was elided; re-run only when a specific detail is genuinely missing.
- Record important findings (paths, symbols, line numbers, decisions) in your reply text as you go — your messages persist even when tool output is elided.
- Prefer grep/find/ls to locate code, then read only the ranges you need. Avoid reading whole files "just in case".
- Use the explore sub-agent for questions spanning more than ~2 files; use delegate for bounded, verifiable tasks. Their file contents never enter your context.
- Keep replies terse. Do not paste large file contents back in prose.`
