#!/usr/bin/env bash
# Smoke-test pear against a real pi binary.
#
# Covers what unit tests cannot: that the extension actually loads into pi, that
# commands run end to end, and that the packaged install path works. Behavioural
# depth (every checkpoint outcome, every race) lives in test/, which does not
# need a pi process.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# pi needs Node >= 22; a bare shell may resolve something older.
PINNED_NODE="$(awk '/^nodejs /{print $2}' "$ROOT/.tool-versions" 2>/dev/null || true)"
if [[ -n "${PINNED_NODE}" && -d "${HOME}/.asdf/installs/nodejs/${PINNED_NODE}/bin" ]]; then
  export PATH="${HOME}/.asdf/installs/nodejs/${PINNED_NODE}/bin:${PATH}"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "smoke-pi: need Node >= 22, found $(node --version)" >&2
  exit 1
fi

PI="${ROOT}/node_modules/.bin/pi"
EXT="${ROOT}/adapters/pi/extensions/pear.ts"
if [[ ! -x "$PI" ]]; then
  echo "smoke-pi: $PI not found — run npm ci" >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/pear-smoke-XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

export PI_CODING_AGENT_DIR="$WORKDIR/pi-home"
mkdir -p "$PI_CODING_AGENT_DIR"

cd "$WORKDIR"
git init -q
git config user.email "smoke@test"
git config user.name "smoke"
echo "hello" > README.md
git add README.md
git commit -q -m init

mode_on_disk() {
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(".pear/config.json","utf8")).mode??"(unset)")}catch{console.log("(no file)")}'
}

fail() { echo "smoke-pi: $1" >&2; exit 1; }

echo "== leg a: extension loads =="
if ! "$PI" -e "$EXT" --help >"$WORKDIR/help.txt" 2>&1; then
  cat "$WORKDIR/help.txt" >&2
  fail "extension failed to load"
fi
grep -qE "Failed to load extension" "$WORKDIR/help.txt" && {
  cat "$WORKDIR/help.txt" >&2
  fail "extension reported a load error"
}
# Flags from earlier versions must not linger.
if grep -qE "nav-model|pause-lines|pause-edits|no-nav|min-lines|--debounce|--interval" "$WORKDIR/help.txt"; then
  fail "stale pear flags are still registered"
fi
echo "ok: loads cleanly, no stale flags"

echo "== leg b: /pear-mode persists =="
"$PI" -e "$EXT" --no-session -p "/pear-mode agent-driver" >/dev/null 2>&1
[[ "$(mode_on_disk)" == "agent-driver" ]] || fail "expected mode=agent-driver, got $(mode_on_disk)"
"$PI" -e "$EXT" --no-session -p "/pear-mode off" >/dev/null 2>&1
[[ "$(mode_on_disk)" == "off" ]] || fail "expected mode=off, got $(mode_on_disk)"
echo "ok: mode round-trips through .pear/config.json"

echo "== leg c: unknown config keys survive a write =="
mkdir -p .pear
cat > .pear/config.json <<'JSON'
{
  "mode": "off",
  "maxChangesPerCheckpoint": 4,
  "someFutureSetting": {"keep": "me"}
}
JSON
"$PI" -e "$EXT" --no-session -p "/pear-mode agent-driver" >/dev/null 2>&1
node -e '
  const c = JSON.parse(require("fs").readFileSync(".pear/config.json","utf8"));
  if (c.mode !== "agent-driver") { console.error("mode not updated:", c.mode); process.exit(1); }
  if (c.maxChangesPerCheckpoint !== 4) { console.error("budget lost"); process.exit(1); }
  if (!c.someFutureSetting || c.someFutureSetting.keep !== "me") { console.error("unknown key dropped"); process.exit(1); }
' || fail "a config write dropped fields it should have preserved"
echo "ok: unknown keys preserved"

echo "== leg d: a human-driver config activates and is not rewritten =="
cat > .pear/config.json <<'JSON'
{
  "mode": "human-driver",
  "reviewModel": "some/model"
}
JSON
BEFORE="$(shasum .pear/config.json | cut -d' ' -f1)"
"$PI" -e "$EXT" --no-session -p "/pear-status" >"$WORKDIR/human.txt" 2>&1 \
  || { cat "$WORKDIR/human.txt" >&2; fail "a human-driver session failed to start"; }
AFTER="$(shasum .pear/config.json | cut -d' ' -f1)"
[[ "$BEFORE" == "$AFTER" ]] || fail "config was modified (before=$BEFORE after=$AFTER)"
# human-driver is a real mode now: it must not be reported as unavailable.
if grep -qi "isn't available" "$WORKDIR/human.txt"; then
  cat "$WORKDIR/human.txt" >&2
  fail "human-driver was treated as a legacy mode"
fi
echo "ok: human-driver runs, unknown keys and file left byte-identical"

echo "== leg e: session stays alive and usable after pear commands =="
# Liveness proxy available without a model: pi must exit 0 and keep processing
# further prompts in the same invocation after pear has run its command path.
rm -f .pear/config.json
if ! "$PI" -e "$EXT" --no-session \
      -p "/pear-mode agent-driver" \
      -p "/pear-status" \
      -p "/pear-config 120" \
      -p "/pear-status" >"$WORKDIR/live.txt" 2>&1; then
  cat "$WORKDIR/live.txt" >&2
  fail "pi did not survive a sequence of pear commands"
fi
node -e '
  const c = JSON.parse(require("fs").readFileSync(".pear/config.json","utf8"));
  if (c.reviewBudget !== 120) { console.error("later command did not take effect:", c); process.exit(1); }
' || fail "a command after the first did not run — session did not stay live"
echo "ok: multiple sequential commands all ran"

echo "== leg e2: a legacy change-count budget is migrated, not overwritten =="
rm -f .pear/config.json
mkdir -p .pear
printf '{\n  "mode": "agent-driver",\n  "maxChangesPerCheckpoint": 5\n}\n' > .pear/config.json
"$PI" -e "$EXT" --no-session -p "/pear-status" >"$WORKDIR/migrate.txt" 2>&1 \
  || { cat "$WORKDIR/migrate.txt" >&2; fail "session with a legacy budget failed"; }
node -e '
  const c = JSON.parse(require("fs").readFileSync(".pear/config.json","utf8"));
  if (c.maxChangesPerCheckpoint !== 5) { console.error("legacy key lost:", c); process.exit(1); }
  if ("reviewBudget" in c) { console.error("must not write a derived value:", c); process.exit(1); }
' || fail "the legacy budget key must survive untouched"
echo "ok: legacy budget read, file left untouched"

echo "== leg f: no ctx.abort() in shipped adapter code =="
# Comments may discuss ctx.abort(); code may not call it. Strip comments first,
# so prose about the bug we fixed does not read as the bug itself.
if ! node -e '
  const fs = require("node:fs");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  let bad = false;
  for (const f of process.argv.slice(1)) {
    const hits = strip(fs.readFileSync(f, "utf8")).match(/\bctx\s*\.\s*abort\s*\(/g);
    if (hits) { console.error(f + ": " + hits.length + " ctx.abort() call site(s)"); bad = true; }
  }
  process.exit(bad ? 1 : 0);
' "$EXT" "$ROOT/adapters/pi/runtime.ts"; then
  fail "ctx.abort() found — blocking must never abort the agent run"
fi
echo "ok: no abort call sites"

echo "== leg g: packaged install loads =="
"$PI" install "$ROOT" -na
if ! "$PI" --help >"$WORKDIR/help2.txt" 2>&1; then
  cat "$WORKDIR/help2.txt" >&2
  fail "packaged install --help failed"
fi
grep -qE "Failed to load extension" "$WORKDIR/help2.txt" && {
  cat "$WORKDIR/help2.txt" >&2
  fail "packaged extension failed to load"
}
echo "ok: packaged install loads cleanly"

echo
echo "smoke-pi: all legs passed"
echo
echo "Not covered here (needs a live model + a terminal) — see MANUAL-CHECKLIST"
echo "in scripts/manual-checklist.md before shipping a behavioural change."
