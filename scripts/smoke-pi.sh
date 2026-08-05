#!/usr/bin/env bash
# Smoke-test pear as a pi extension (dev path + packaged install).
set -euo pipefail

# Prefer asdf node >=22; bare env may be older.
export PATH="${HOME}/.asdf/installs/nodejs/22.22.3/bin:${PATH}"
ROOT="$(git rev-parse --show-toplevel)"
PI="${ROOT}/node_modules/.bin/pi"
if [[ ! -x "$PI" ]]; then
  echo "smoke-pi: $PI not found — run npm install" >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/pear-smoke-XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "== leg a: pi -e extension loads with no flags registered =="
cd "$WORKDIR"
git init -q
git config user.email "smoke@test"
git config user.name "smoke"
echo "hello" > README.md
git add README.md
git commit -q -m "init"

if ! "$PI" -e "$ROOT/adapters/pi/extensions/pear.ts" --help >"$WORKDIR/help.txt" 2>&1; then
  echo "smoke-pi: extension failed to load via --help" >&2
  cat "$WORKDIR/help.txt" >&2
  exit 1
fi
if grep -qE "nav-model|pause-lines|pause-edits|no-nav|min-lines|--debounce|--interval" "$WORKDIR/help.txt"; then
  echo "smoke-pi: old flags are still registered" >&2
  cat "$WORKDIR/help.txt" >&2
  exit 1
fi
echo "ok: extension loads with no pear flags"

echo "== leg b: /pear-mode agent-driver persists mode without a live model =="
"$PI" -e "$ROOT/adapters/pi/extensions/pear.ts" --no-session -p "/pear-mode agent-driver" >/dev/null 2>&1
MODE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".pear/config.json","utf8")).mode)')"
if [[ "$MODE" != "agent-driver" ]]; then
  echo "smoke-pi: expected .pear/config.json mode=agent-driver, got $MODE" >&2
  exit 1
fi
echo "ok: /pear-mode agent-driver persisted config without a live model"

echo "== leg c: /pear-mode off reverts without a live model =="
"$PI" -e "$ROOT/adapters/pi/extensions/pear.ts" --no-session -p "/pear-mode off" >/dev/null 2>&1
MODE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".pear/config.json","utf8")).mode)')"
if [[ "$MODE" != "off" ]]; then
  echo "smoke-pi: expected .pear/config.json mode=off, got $MODE" >&2
  exit 1
fi
echo "ok: /pear-mode off persisted"

echo "== leg d: deterministic gate proof — checkpoint block, off passthrough, human-driver fallback =="
node --experimental-strip-types "$ROOT/scripts/smoke-pear-runtime.ts"

echo "== leg e: packaged install via pi manifest loads the extension cleanly =="
# Plan called for git:file://…; this pi version installs local paths instead.
# Source is still derived from git rev-parse --show-toplevel (never hardcoded).
export PI_CODING_AGENT_DIR="$WORKDIR/pi-home"
mkdir -p "$PI_CODING_AGENT_DIR"
"$PI" install "$ROOT" -na
if ! "$PI" --help >"$WORKDIR/help2.txt" 2>&1; then
  echo "smoke-pi: packaged install --help failed" >&2
  cat "$WORKDIR/help2.txt" >&2
  exit 1
fi
if grep -qE "Failed to load extension" "$WORKDIR/help2.txt"; then
  echo "smoke-pi: packaged extension failed to load" >&2
  cat "$WORKDIR/help2.txt" >&2
  exit 1
fi
echo "ok: packaged install loads the extension cleanly"

echo "smoke-pi: all legs passed"
