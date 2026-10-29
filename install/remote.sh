#!/usr/bin/env bash
# install/remote.sh: copy this repo to an SSH host, test it there, apply, verify.
#
#   install/remote.sh <ssh-host> [--dry-run] [apply.sh options...]
#
# Example: install/remote.sh myserver --patch-legacy --daily-reset-hour=22
# Uses your ~/.ssh/config for the host. Copies to ~/openclaw-token-guard on the
# host (tar over ssh, no rsync needed) and retries flaky connections.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${1:-}"
[ -n "$HOST" ] && [ "${HOST#-}" = "$HOST" ] || { sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 2; }
shift
APPLY_ARGS=("$@")
DRY_RUN=0
for a in "${APPLY_ARGS[@]}"; do [ "$a" = "--dry-run" ] && DRY_RUN=1; done

# Retry only when ssh itself failed to connect (exit 255); real failures stop.
retry() {
  local n=0 rc=0
  while :; do
    rc=0; "$@" || rc=$?
    [ "$rc" -ne 255 ] && return "$rc"
    n=$((n + 1))
    [ "$n" -ge 4 ] && { echo "remote.sh: ssh failed $n times: giving up" >&2; return "$rc"; }
    echo "remote.sh: ssh connection failed, retrying in $((n * 5))s" >&2
    sleep $((n * 5))
  done
}

copy() {
  set -o pipefail
  tar -C "$REPO_ROOT" --exclude=.git --exclude=node_modules --exclude=__pycache__ -czf - . \
    | ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" 'rm -rf ~/openclaw-token-guard.new && mkdir -p ~/openclaw-token-guard.new && tar -xzf - -C ~/openclaw-token-guard.new && rm -rf ~/openclaw-token-guard && mv ~/openclaw-token-guard.new ~/openclaw-token-guard'
}

remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 "$HOST" "$@"
}

echo "=== copy repo to $HOST:~/openclaw-token-guard"
retry copy

echo "=== tests on $HOST"
retry remote 'cd ~/openclaw-token-guard && PATH="$(ls -d ~/.openclaw/tools/node-*/bin 2>/dev/null | head -1):$PATH" tests/run-all.sh > /tmp/token-guard-tests.log 2>&1; rc=$?; tail -n 6 /tmp/token-guard-tests.log; exit $rc'

quoted=""
for a in "${APPLY_ARGS[@]}"; do quoted="$quoted $(printf '%q' "$a")"; done
echo "=== apply on $HOST:$quoted"
retry remote "cd ~/openclaw-token-guard && install/apply.sh$quoted"

if [ "$DRY_RUN" = 0 ]; then
  echo "=== verify on $HOST"
  retry remote 'cd ~/openclaw-token-guard && install/verify.sh'
fi
