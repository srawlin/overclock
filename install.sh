#!/usr/bin/env bash
# overclock installer
#   curl -fsSL https://raw.githubusercontent.com/srawlin/overclock/main/install.sh | bash
#
# What it does:
#   1. clones (or updates) the repo into ~/.local/share/overclock
#   2. npm-installs its runtime deps (pi-coding-agent etc.)
#   3. symlinks bin/overclock into ~/.local/bin
#   4. helps you set CEREBRAS_API_KEY (writes ~/.config/overclock/env)
#
# Overrides: OVERCLOCK_HOME, OVERCLOCK_BIN_DIR, OVERCLOCK_BRANCH
set -euo pipefail

REPO_HTTPS="https://github.com/srawlin/overclock.git"
REPO_SSH="git@github.com:srawlin/overclock.git"
BRANCH="${OVERCLOCK_BRANCH:-${FASTCODE_BRANCH:-main}}"
DEST="${OVERCLOCK_HOME:-$HOME/.local/share/overclock}"
BIN_DIR="${OVERCLOCK_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '  %s\n' "$*"; }
fail() { printf 'overclock install: %s\n' "$*" >&2; exit 1; }

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
	say "updating $DEST (local changes are discarded)"
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
# npm ci installs exactly the lockfile — fails on drift rather than resolving
# fresh ranges. Audit output is kept so advisories surface (F9).
(cd "$DEST" && npm ci --omit=dev --no-fund --loglevel=error)

# --- link -------------------------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$DEST/bin/overclock" "$BIN_DIR/overclock"
chmod +x "$DEST/bin/overclock"

# Remove a stale fastcode symlink left by the pre-rename installer.
if [ -L "$BIN_DIR/fastcode" ]; then
	case "$(readlink "$BIN_DIR/fastcode")" in
		*/fastcode/bin/fastcode|*/overclock/bin/*) rm -f "$BIN_DIR/fastcode" ;;
	esac
fi

case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) say "note: $BIN_DIR is not on your PATH — add it or run $BIN_DIR/overclock" ;;
esac

# --- API key -----------------------------------------------------------------
ENV_FILE="$HOME/.config/overclock/env"
LEGACY_ENV_FILE="$HOME/.config/fastcode/env"
if [ -n "${CEREBRAS_API_KEY:-}" ] || grep -qs "CEREBRAS_API_KEY" "$ENV_FILE" 2>/dev/null; then
	: # already configured
elif grep -qs "CEREBRAS_API_KEY" "$LEGACY_ENV_FILE" 2>/dev/null; then
	# carry the key forward to the renamed location — lock down perms, the
	# source may be world-readable (F6)
	mkdir -p "$(dirname "$ENV_FILE")"
	chmod 700 "$(dirname "$ENV_FILE")"
	cp "$LEGACY_ENV_FILE" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	say "migrated config from $LEGACY_ENV_FILE -> $ENV_FILE"
elif [ -r /dev/tty ]; then
	printf '  CEREBRAS_API_KEY (from https://cloud.cerebras.ai): ' > /dev/tty
	read -rs KEY < /dev/tty || true
	printf '\n' > /dev/tty
	if [ -n "${KEY:-}" ]; then
		mkdir -p "$(dirname "$ENV_FILE")"
		chmod 700 "$(dirname "$ENV_FILE")"
		printf 'CEREBRAS_API_KEY=%s\n' "$KEY" > "$ENV_FILE"
		chmod 600 "$ENV_FILE"
		say "saved key to $ENV_FILE"
	else
		say "skipped — add CEREBRAS_API_KEY to $ENV_FILE later"
	fi
else
	say "add your key:  echo 'CEREBRAS_API_KEY=...' > $ENV_FILE"
fi

printf '\n  done — run: overclock\n\n'
