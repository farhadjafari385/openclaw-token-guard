#!/usr/bin/env bash
# install/verify.sh: PASS/FAIL checklist for a token-guard install on this host.
#
#   install/verify.sh [--oc-home=PATH] [--coordinator=ID]
#
# Exit 0 when every check passes, 1 otherwise.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OC_HOME="${OC_HOME:-$HOME/.openclaw}"
COORDINATOR_ID="coordinator"
for arg in "$@"; do
  case "$arg" in
    --oc-home=*) OC_HOME="${arg#*=}" ;;
    --coordinator=*) COORDINATOR_ID="${arg#*=}" ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "verify.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

CONFIG="$OC_HOME/openclaw.json"
OPENCLAW_CMD=()
for node_bin in "$OC_HOME"/tools/node-*/bin/node; do
  pkg="$(dirname "$(dirname "$node_bin")")/lib/node_modules/openclaw"
  [ -x "$node_bin" ] && [ -f "$pkg/dist/index.js" ] && OPENCLAW_CMD=("$node_bin" "$pkg/dist/index.js") && break
done
[ "${#OPENCLAW_CMD[@]}" -gt 0 ] || { command -v openclaw >/dev/null 2>&1 && OPENCLAW_CMD=(openclaw); }
oc() { "${OPENCLAW_CMD[@]}" "$@"; }
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}${OPENCLAW_GATEWAY_PASSWORD:-}" ] && [ -f "$OC_HOME/gateway.systemd.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$OC_HOME/gateway.systemd.env"
  set +a
fi

FAILS=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

for name in oc-wait oc-wait-pipeline oc-inbox; do
  if [ -x "$OC_HOME/bin/$name" ]; then pass "$name installed"; else fail "$name missing at $OC_HOME/bin/$name"; fi
done
if timeout 20 "$OC_HOME/bin/oc-wait" --every 1 --timeout 10 -- true >/dev/null 2>&1; then
  pass "oc-wait runs"
else
  fail "oc-wait smoke test"
fi
tmp="$(mktemp -d)"
if OC_INBOX_FILE="$tmp/inbox.jsonl" "$OC_HOME/bin/oc-inbox" add --project verify --title "smoke test" --done-when listed >/dev/null 2>&1 \
  && OC_INBOX_FILE="$tmp/inbox.jsonl" "$OC_HOME/bin/oc-inbox" plan 2>/dev/null | grep -q verify; then
  pass "oc-inbox add/plan"
else
  fail "oc-inbox smoke test"
fi

INSPECT_ARGS=()
if [ "${#OPENCLAW_CMD[@]}" -gt 0 ]; then
  if oc config validate >/dev/null 2>&1; then pass "openclaw config validate"; else fail "openclaw config validate"; fi
  if oc plugins inspect token-guard --runtime --json > "$tmp/inspect.json" 2>/dev/null; then
    INSPECT_ARGS=(--inspect "$tmp/inspect.json")
  else
    fail "openclaw plugins inspect token-guard --runtime"
  fi
else
  fail "no OpenClaw CLI found"
fi

python3 "$REPO_ROOT/install/_verify.py" --config "$CONFIG" --coordinator "$COORDINATOR_ID" "${INSPECT_ARGS[@]}"
FAILS=$((FAILS + $?))

if [ "${#OPENCLAW_CMD[@]}" -gt 0 ]; then
  over="$(python3 "$REPO_ROOT/tools/oversized-sessions.py" --oc-home="$OC_HOME" --threshold 1.0 --quiet 2>&1)"
  case $? in
    0) pass "no session past its context window" ;;
    1) fail "sessions past their context window (fix: tools/oversized-sessions.py --threshold 1.0 --reset):"
       printf '%s\n' "$over" | sed 's/^/        /' ;;
    *) fail "could not list sessions: $over" ;;
  esac
fi
rm -rf "$tmp"

echo
if [ "$FAILS" -eq 0 ]; then echo "verify.sh: all checks passed"; exit 0; fi
echo "verify.sh: $FAILS check(s) failed"
exit 1
