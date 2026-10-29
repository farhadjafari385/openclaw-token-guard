#!/usr/bin/env bash
# tests/live-gateway-test.sh: prove token-guard inside a real OpenClaw Gateway
# without touching your own. Starts a throwaway Gateway (temp state dir, own
# port, no channels, no models), loads the plugin from this repo, fires tool
# calls at POST /tools/invoke and checks which ones the guard blocks.
#
#   tests/live-gateway-test.sh [--oc-home=PATH] [--port=N] [--keep]
#
# Needs: an OpenClaw install (node + dist under ~/.openclaw/tools), curl, python3.
# Makes no model calls.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OC_HOME="${OC_HOME:-$HOME/.openclaw}"
PORT=28999
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --oc-home=*) OC_HOME="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --keep) KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

NODE=""; DIST=""; OC_PKG=""
for node_bin in "$OC_HOME"/tools/node-*/bin/node; do
  pkg="$(dirname "$(dirname "$node_bin")")/lib/node_modules/openclaw"
  if [ -x "$node_bin" ] && [ -f "$pkg/dist/index.js" ]; then NODE="$node_bin"; DIST="$pkg/dist/index.js"; OC_PKG="$pkg"; break; fi
done
[ -n "$NODE" ] || { echo "no OpenClaw install under $OC_HOME/tools" >&2; exit 2; }
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is busy; pass --port=N" >&2; exit 2; fi

SBX="$(mktemp -d /tmp/token-guard-live.XXXXXX)"
TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
mkdir -p "$SBX/state" "$SBX/plugin/node_modules" "$SBX/home/.openclaw/bin"
cp "$REPO_ROOT"/plugin/{index.js,guard.js,inbox.js,package.json,openclaw.plugin.json} "$SBX/plugin/"
ln -s "$OC_PKG" "$SBX/plugin/node_modules/openclaw"
[ -d "$OC_PKG/node_modules/typebox" ] && cp -rL "$OC_PKG/node_modules/typebox" "$SBX/plugin/node_modules/typebox"
cp "$REPO_ROOT"/bin/* "$SBX/home/.openclaw/bin/"

cat > "$SBX/openclaw.json" <<JSON
{
  "gateway": {
    "mode": "local", "bind": "loopback", "port": $PORT,
    "auth": { "mode": "token", "token": "$TOKEN" },
    "tools": { "allow": ["exec", "sessions_send"] }
  },
  "tools": { "profile": "full", "alsoAllow": ["task_inbox"], "exec": { "host": "gateway", "mode": "full" } },
  "plugins": {
    "load": { "paths": ["$SBX/plugin"] },
    "entries": { "token-guard": { "enabled": true, "config": { "briefCheckAgents": [] } } }
  }
}
JSON

export OPENCLAW_STATE_DIR="$SBX/state" OPENCLAW_CONFIG_PATH="$SBX/openclaw.json"
export OC_INBOX_FILE="$SBX/inbox.jsonl" OC_INBOX_BIN="$SBX/home/.openclaw/bin/oc-inbox"
"$NODE" "$DIST" gateway --port "$PORT" > "$SBX/gateway.log" 2>&1 &
GW_PID=$!
cleanup() {
  kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null
  if [ "$KEEP" = 1 ]; then echo "kept $SBX"; else rm -rf "$SBX"; fi
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  kill -0 "$GW_PID" 2>/dev/null || { echo "sandbox gateway exited; log:"; tail -n 30 "$SBX/gateway.log"; exit 1; }
  sleep 1
done

FAILS=0
SKIPS=0
invoke() { # tool json-args -> prints "HTTP_CODE BODY"
  curl -s -m 60 -o "$SBX/out.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"tool\":\"$1\",\"args\":$2,\"sessionKey\":\"agent:main:main\"}" "http://127.0.0.1:$PORT/tools/invoke"
}
expect() { # name tool args want(blocked|allowed) [grep]
  local name="$1" tool="$2" args="$3" want="$4" pattern="${5:-}"
  local code; code="$(invoke "$tool" "$args")"
  local body; body="$(cat "$SBX/out.json" 2>/dev/null)"
  local got="error"
  if [ "$code" = "403" ] && printf '%s' "$body" | grep -q 'token-guard'; then got="blocked"; fi
  if [ "$code" = "200" ]; then got="allowed"; fi
  if [ "$got" = "error" ] && [ "$code" = "404" ] && printf '%s' "$body" | grep -q 'Tool not available'; then
    printf 'SKIP  %-46s %s is not exposed over HTTP here (unit tests + live agent check cover it)\n' "$name" "$tool"
    SKIPS=$((SKIPS + 1))
    return
  fi
  if [ "$got" = "$want" ] && { [ -z "$pattern" ] || printf '%s' "$body" | grep -q "$pattern"; }; then
    printf 'PASS  %-46s HTTP %s\n' "$name" "$code"
  else
    printf 'FAIL  %-46s HTTP %s want %s, got %s: %s\n' "$name" "$code" "$want" "$got" "$(printf '%s' "$body" | head -c 300)"
    FAILS=$((FAILS + 1))
  fi
}

echo "=== plugin loaded in sandbox gateway"
"$NODE" "$DIST" plugins inspect token-guard --runtime --json > "$SBX/inspect.json" 2>/dev/null
if grep -q '"status": *"error"' "$SBX/inspect.json"; then echo "FAIL  plugin load error: $(grep -o '"error": *"[^"]*' "$SBX/inspect.json" | head -1 | cut -c1-200)"; FAILS=$((FAILS + 1)); fi
if grep -q before_tool_call "$SBX/inspect.json"; then echo "PASS  before_tool_call hook registered"; else echo "FAIL  hook not registered"; FAILS=$((FAILS + 1)); fi
if python3 -c 'import json,sys; r=open(sys.argv[1]).read(); d=json.loads(r[r.index("{"):]); sys.exit(0 if "task_inbox" in json.dumps(d.get("tools")) else 1)' "$SBX/inspect.json"; then echo "PASS  task_inbox tool registered"; else echo "FAIL  task_inbox not registered"; FAILS=$((FAILS + 1)); fi

echo "=== tool calls through the real hook path"
expect "exec: short command runs"                exec '{"command":"echo token-guard-ok"}' allowed
expect "exec: foreground sleep 25s blocked"       exec '{"command":"sleep 25; echo late"}' blocked 'foreground sleep'
expect "exec: while/sleep loop blocked"           exec '{"command":"while true; do date; sleep 3; done"}' blocked 'sleep/watch loop'
expect "exec: background sleep 120s blocked"      exec '{"command":"sleep 120; echo x","background":true}' blocked 'background sleep'
expect "exec: waiter allowed (moved to background)" exec "{\"command\":\"$SBX/home/.openclaw/bin/oc-wait --every 1 --timeout 5 -- true\"}" allowed
expect "process: poll #1 of job"                  process '{"action":"poll","sessionId":"job-x"}' allowed
expect "process: poll #2 of job"                  process '{"action":"poll","sessionId":"job-x"}' allowed
expect "process: poll #3 of job blocked"          process '{"action":"poll","sessionId":"job-x"}' blocked 'check #3'
expect "process: kill never blocked"              process '{"action":"kill","sessionId":"job-x"}' allowed
for i in 1 2 3; do expect "exec: status command run $i" exec '{"command":"echo same-status"}' allowed; done
expect "exec: same command 4th time blocked"      exec '{"command":"echo same-status"}' blocked 'same command ran 4 times'
LONG="$(python3 -c 'print("Please fix it. " * 60)')"
expect "sessions_send: brief without fields blocked" sessions_send "{\"sessionKey\":\"agent:main:other\",\"message\":\"$LONG\"}" blocked 'missing Project:'
expect "task_inbox: add"                          task_inbox '{"action":"add","project":"sandbox","title":"Live test item","type":"bug","done_when":"test passes"}' allowed
expect "task_inbox: plan lists the item"          task_inbox '{"action":"plan"}' allowed 'Live test item'

echo
grep -c 'token-guard blocked' "$SBX/gateway.log" | xargs -I{} echo "gateway log: {} block lines"
if [ "$FAILS" -eq 0 ]; then echo "live-gateway-test: all checks passed ($SKIPS skipped)"; exit 0; fi
echo "live-gateway-test: $FAILS check(s) failed (rerun with --keep and read gateway.log)"
exit 1
