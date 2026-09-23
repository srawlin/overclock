export const FASTCODE_GUIDANCE = `## Context budget

This model has a small context window, and every request re-sends the transcript.

- Older tool outputs may appear as stubs like \`[read output pruned: path, ~N tokens]\`. Re-run the tool to fetch the content again — this is cheap.
- Prefer grep/find/ls to locate code, then read only the ranges you need. Avoid reading whole files "just in case".
- Use the explore sub-agent for questions spanning more than ~2 files; use delegate for bounded, verifiable tasks. Their file contents never enter your context.
- Keep replies terse. Do not paste large file contents back in prose.`
