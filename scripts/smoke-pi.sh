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

echo "== leg a: pi -e extension loads =="
cd "$WORKDIR"
git init -q
git config user.email "smoke@test"
git config user.name "smoke"
echo "hello" > README.md
git add README.md
git commit -q -m "init"

if ! "$PI" -e "$ROOT/adapters/pi/extensions/pear.ts" --help 2>&1 | tee "$WORKDIR/help.txt" | grep -qE "nav-model|pause-lines|no-nav"; then
  echo "smoke-pi: expected pear flags in --help output" >&2
  cat "$WORKDIR/help.txt" >&2
  exit 1
fi
echo "ok: extension flags registered"

echo "== leg b: packaged install via pi manifest =="
# Plan called for git:file://…; this pi version installs local paths instead.
# Source is still derived from git rev-parse --show-toplevel (never hardcoded).
export PI_CODING_AGENT_DIR="$WORKDIR/pi-home"
mkdir -p "$PI_CODING_AGENT_DIR"
"$PI" install "$ROOT" -na
if ! "$PI" --help 2>&1 | tee "$WORKDIR/help2.txt" | grep -qE "nav-model|pause-lines|no-nav"; then
  echo "smoke-pi: packaged extension flags missing from --help after install" >&2
  cat "$WORKDIR/help2.txt" >&2
  exit 1
fi
echo "ok: packaged install exposes pear flags"

echo "smoke-pi: all legs passed"
