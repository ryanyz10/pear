#!/usr/bin/env bash
# Smoke-test pear's native oh-my-pi (omp) extension: standalone --extension
# load, then an installed (`omp plugin link`) load via ambient discovery.
set -euo pipefail

# Prefer asdf node >=22; bare env may be older.
export PATH="${HOME}/.asdf/installs/nodejs/22.22.3/bin:${PATH}"
ROOT="$(git rev-parse --show-toplevel)"
EXT="$ROOT/adapters/omp/extensions/pear.ts"

if ! command -v omp >/dev/null 2>&1; then
  echo "smoke-omp: 'omp' CLI not found on PATH — install oh-my-pi to run this smoke test" >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/pear-smoke-omp-XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

REPO="$WORKDIR/repo"
mkdir -p "$REPO"

TIMEOUT=20
# Deliberately unresolvable model: startup reaches provider selection and stops
# there, so no leg depends on ambient credentials and no leg ever reaches a
# provider. Its rejection line is the post-startup marker each leg must see.
NO_MODEL="pear-smoke/none"
MARKER="Model \"$NO_MODEL\" not found"

STATUS=0
OUT=""
run_omp() {
  STATUS=0
  OUT="$(timeout "$TIMEOUT" omp "$@" </dev/null 2>&1)" || STATUS=$?
}

fail() {
  echo "smoke-omp: $1" >&2
  echo "--- exit status: $STATUS ---" >&2
  echo "${OUT:-<no output>}" >&2
  exit 1
}

check_loaded() {
  local label="$1"
  [[ "$STATUS" -ne 124 ]] || fail "$label timed out after ${TIMEOUT}s"
  ! grep -q "Failed to load extension" <<<"$OUT" || fail "$label reported a load failure"
  ! grep -q "unknown flag" <<<"$OUT" || fail "$label rejected a flag"
  grep -qF "$MARKER" <<<"$OUT" || fail "$label did not reach model selection (expected \"$MARKER\")"
}

echo "== leg a: --extension dev-path loads pear.ts with no flags registered =="
export HOME="$WORKDIR/home-a"
mkdir -p "$HOME"
run_omp --extension "$EXT" --no-session --cwd "$REPO" --model "$NO_MODEL" -p ""
check_loaded "adapters/omp/extensions/pear.ts (--extension)"
echo "ok: pear.ts loads cleanly via --extension"

echo "== leg b: omp plugin link + ambient discovery loads the same extension =="
export HOME="$WORKDIR/home-b"
mkdir -p "$HOME"
timeout 120 omp plugin link "$ROOT" --scope user >/dev/null
run_omp --no-session --cwd "$REPO" --model "$NO_MODEL" -p ""
check_loaded "linked pear plugin (ambient discovery)"
echo "ok: omp plugin link + ambient discovery loads pear.ts cleanly"

echo "== leg c: deterministic gate proof — checkpoint block, off passthrough, human-driver fallback =="
node --experimental-strip-types "$ROOT/scripts/smoke-pear-runtime.ts"

echo "smoke-omp: all legs passed"
