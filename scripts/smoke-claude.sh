#!/usr/bin/env bash
# Smoke-test pear's Claude Code plugin: manifest validity, a real marketplace
# install (with symlink dereferencing into an isolated HOME), and hook behavior.
set -euo pipefail

export PATH="${HOME}/.asdf/installs/nodejs/22.22.3/bin:${PATH}"
ROOT="$(git rev-parse --show-toplevel)"

if ! command -v claude >/dev/null 2>&1; then
  echo "smoke-claude: 'claude' CLI not found on PATH — install Claude Code to run this smoke test" >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/pear-smoke-claude-XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "== leg a: manifests validate =="
claude plugin validate "$ROOT" --strict
claude plugin validate "$ROOT/adapters/claude-code" --strict
echo "ok: marketplace and plugin manifests are valid"

echo "== leg b: install into an isolated HOME dereferences the vendor symlinks =="
export HOME="$WORKDIR/claude-home"
mkdir -p "$HOME"
claude plugin marketplace add "$ROOT" --scope user >/dev/null
claude plugin install pear-claude-code@pear --scope user >/dev/null

CACHE="$(find "$HOME/.claude/plugins/cache/pear/pear-claude-code" -maxdepth 1 -mindepth 1 -type d | sort | tail -1)"
if [[ -z "$CACHE" ]]; then
  echo "smoke-claude: plugin cache directory not found after install" >&2
  exit 1
fi
if [[ -L "$CACHE/_vendor/core" || -L "$CACHE/_vendor/adapters/shared" ]]; then
  echo "smoke-claude: _vendor entries are still symlinks in the cache — dereferencing didn't happen" >&2
  exit 1
fi
if [[ ! -f "$CACHE/_vendor/core/git.ts" || ! -f "$CACHE/_vendor/adapters/shared/hook-checkpoint.ts" ]]; then
  echo "smoke-claude: vendored core/shared files missing from the installed plugin cache" >&2
  exit 1
fi
echo "ok: install vendored core/ and adapters/shared/ as real files in the cache"

echo "== leg c: the installed hook scripts behave correctly with CLAUDE_PLUGIN_ROOT set =="
export CLAUDE_PLUGIN_ROOT="$CACHE"
REPO="$WORKDIR/repo"
mkdir -p "$REPO"
cd "$REPO"
echo ".pear/" > .gitignore
git init -q
git config user.email "smoke@test"
git config user.name "smoke"
git add .gitignore
git commit -q -m "init"
mkdir -p "$REPO/.pear"
cat > "$REPO/.pear/config.json" <<'JSON'
{ "mode": "agent-driver", "maxChangesPerCheckpoint": 5 }
JSON

run_hook() { node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/hooks/$1" <<<"$2"; }
field() {
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const path = process.argv[1].split(".");
    let v = data;
    for (const k of path) v = v?.[k];
    process.stdout.write(v === undefined ? "" : String(v));
  ' "$2" <<<"$1"
}
checkpoint_field() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$REPO/.pear/checkpoint.json" "$1"
}

for i in 1 2 3 4 5; do
  OUT=$(run_hook pre-tool-use.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REPO/f$i.txt\",\"content\":\"x\"},\"tool_use_id\":\"toolu_0$i\"}")
  DECISION=$(field "$OUT" hookSpecificOutput.permissionDecision)
  if [[ "$DECISION" == "deny" ]]; then
    echo "smoke-claude: call $i unexpectedly denied: $OUT" >&2
    exit 1
  fi
done
PENDING5=$(checkpoint_field pending)
[[ "$PENDING5" == "5" ]] || { echo "smoke-claude: expected pending=5, got $PENDING5" >&2; exit 1; }

OUT6=$(run_hook pre-tool-use.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REPO/f6.txt\",\"content\":\"x\"},\"tool_use_id\":\"toolu_06\"}")
DECISION6=$(field "$OUT6" hookSpecificOutput.permissionDecision)
REASON6=$(field "$OUT6" hookSpecificOutput.permissionDecisionReason)
[[ "$DECISION6" == "deny" ]] || { echo "smoke-claude: 6th call should deny, got: $OUT6" >&2; exit 1; }
[[ "$REASON6" == *"NOT EXECUTED"* ]] || { echo "smoke-claude: deny reason missing steering contract: $REASON6" >&2; exit 1; }
echo "ok: 5 calls allowed, 6th denies with steering contract"

# The deny at call 6 resets the checkpoint immediately (mirrors
# pear-runtime.ts's never-deferred reset): pending/confirmed/reservations all
# advance to a fresh baseline in the same write. Settling a call reserved
# *before* the deny is now a no-op — its reservation no longer exists.
run_hook post-tool-use.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"PostToolUseFailure\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REPO/f1.txt\"},\"tool_use_id\":\"toolu_01\",\"error\":\"boom\"}" >/dev/null
run_hook post-tool-use.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REPO/f2.txt\"},\"tool_response\":{\"filePath\":\"$REPO/f2.txt\",\"success\":true},\"tool_use_id\":\"toolu_02\"}" >/dev/null
PENDING_C=$(checkpoint_field pending); CONFIRMED_C=$(checkpoint_field confirmed)
[[ "$PENDING_C" == "0" && "$CONFIRMED_C" == "0" ]] || { echo "smoke-claude: expected pending=0 confirmed=0 for pre-deny settles (reservation cleared by the reset), got pending=$PENDING_C confirmed=$CONFIRMED_C" >&2; exit 1; }
echo "ok: settling a pre-deny reservation is a no-op after the immediate reset"

# The next call after the deny resumes against the fresh baseline.
run_hook pre-tool-use.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REPO/f7.txt\",\"content\":\"x\"},\"tool_use_id\":\"toolu_07\"}" >/dev/null
PENDING_E=$(checkpoint_field pending)
[[ "$PENDING_E" == "1" ]] || { echo "smoke-claude: expected pending=1 for the post-steering call, got $PENDING_E" >&2; exit 1; }
run_hook post-tool-use.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$REPO/f7.txt\"},\"tool_response\":{\"filePath\":\"$REPO/f7.txt\",\"success\":true},\"tool_use_id\":\"toolu_07\"}" >/dev/null
PENDING_F=$(checkpoint_field pending); CONFIRMED_F=$(checkpoint_field confirmed)
[[ "$PENDING_F" == "0" && "$CONFIRMED_F" == "1" ]] || { echo "smoke-claude: expected pending=0 confirmed=1 after the post-steering call settles, got pending=$PENDING_F confirmed=$CONFIRMED_F" >&2; exit 1; }
echo "ok: the post-steering call reserves and settles against the fresh baseline"

cat > "$REPO/.pear/config.json" <<'JSON'
{ "mode": "human-driver" }
JSON

run_hook session-start.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" >/dev/null
sleep 0.5
[[ -f "$REPO/.pear/daemon.pid" ]] || { echo "smoke-claude: SessionStart did not create .pear/daemon.pid" >&2; exit 1; }
PID=$(cat "$REPO/.pear/daemon.pid")
kill -0 "$PID" 2>/dev/null || { echo "smoke-claude: daemon pid $PID is not alive" >&2; exit 1; }
echo "ok: SessionStart spawned a live daemon from the vendored cache copy"

run_hook session-end.ts "{\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}" >/dev/null
sleep 0.5
if kill -0 "$PID" 2>/dev/null; then
  echo "smoke-claude: daemon pid $PID still alive after SessionEnd" >&2
  exit 1
fi
echo "ok: SessionEnd stopped the daemon"

echo "smoke-claude: all legs passed"
