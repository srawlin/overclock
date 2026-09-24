#!/usr/bin/env bash
# fastcode installer
#   curl -fsSL https://raw.githubusercontent.com/srawlin/fastcode/dev/install.sh | bash
#
# What it does:
#   1. clones (or updates) the repo into ~/.local/share/fastcode
#   2. npm-installs its runtime deps (pi-coding-agent etc.)
#   3. symlinks bin/fastcode into ~/.local/bin
#   4. helps you set CEREBRAS_API_KEY (writes ~/.config/fastcode/env)
#
# Overrides: FASTCODE_HOME, FASTCODE_BIN_DIR, FASTCODE_BRANCH
set -euo pipefail

REPO_HTTPS="https://github.com/srawlin/fastcode.git"
REPO_SSH="git@github.com:srawlin/fastcode.git"
BRANCH="${FASTCODE_BRANCH:-dev}"
DEST="${FASTCODE_HOME:-$HOME/.local/share/fastcode}"
BIN_DIR="${FASTCODE_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '  %s\n' "$*"; }
fail() { printf 'fastcode install: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required"

# --- node >= 22.19 -----------------------------------------------------------
node_ok() {
	command -v node >/dev/null 2>&1 &&
		[ "$(node -p 'parseInt(process.version.slice(1))' 2>/dev/null || echo 0)" -ge 22 ]
}
if ! node_ok; then
	# an nvm install may exist without being loaded in this shell
	NEWEST="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
	[ -n "$NEWEST" ] && export PATH="$NEWEST:$PATH"
fi
node_ok || fail "node >= 22.19 required — install from https://nodejs.org or via nvm"

# --- clone or update --------------------------------------------------------
if [ -d "$DEST/.git" ]; then
	say "updating $DEST"
	git -C "$DEST" fetch --quiet origin "$BRANCH"
	git -C "$DEST" reset --hard --quiet "origin/$BRANCH"
else
	mkdir -p "$(dirname "$DEST")"
	# HTTPS works for public repos; fall back to SSH while the repo is private.
	if GIT_TERMINAL_PROMPT=0 git ls-remote --quiet "$REPO_HTTPS" >/dev/null 2>&1; then
		say "cloning $REPO_HTTPS -> $DEST"
		git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_HTTPS" "$DEST"
	else
		say "cloning $REPO_SSH -> $DEST"
		git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_SSH" "$DEST"
	fi
fi

# --- deps -------------------------------------------------------------------
say "installing dependencies"
(cd "$DEST" && npm install --omit=dev --no-fund --no-audit --loglevel=error)

# --- link -------------------------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$DEST/bin/fastcode" "$BIN_DIR/fastcode"
chmod +x "$DEST/bin/fastcode"

case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) say "note: $BIN_DIR is not on your PATH — add it or run $BIN_DIR/fastcode" ;;
esac

# --- API key -----------------------------------------------------------------
ENV_FILE="$HOME/.config/fastcode/env"
if [ -n "${CEREBRAS_API_KEY:-}" ] || grep -qs "CEREBRAS_API_KEY" "$ENV_FILE" 2>/dev/null; then
	: # already configured
elif [ -r /dev/tty ]; then
	printf '  CEREBRAS_API_KEY (from https://cloud.cerebras.ai): ' > /dev/tty
	read -r KEY < /dev/tty || true
	if [ -n "${KEY:-}" ]; then
		mkdir -p "$(dirname "$ENV_FILE")"
		printf 'CEREBRAS_API_KEY=%s\n' "$KEY" > "$ENV_FILE"
		chmod 600 "$ENV_FILE"
		say "saved key to $ENV_FILE"
	else
		say "skipped — add CEREBRAS_API_KEY to $ENV_FILE later"
	fi
else
	say "add your key:  echo 'CEREBRAS_API_KEY=...' > $ENV_FILE"
fi

printf '\n  done — run: fastcode\n\n'
