#!/usr/bin/env bash
# install/rollback.sh: undo install/apply.sh from its backup directory.
#
#   install/rollback.sh <backup-dir> [--oc-home=PATH] [--keep-plugin]
#
# Restores openclaw.json and every AGENTS.md saved in <backup-dir>, then
# disables the token-guard plugin (unless --keep-plugin).
set -euo pipefail

OC_HOME="${OC_HOME:-$HOME/.openclaw}"
BACKUP_DIR=""
KEEP_PLUGIN=0
for arg in "$@"; do
  case "$arg" in
    --oc-home=*) OC_HOME="${arg#*=}" ;;
    --keep-plugin) KEEP_PLUGIN=1 ;;
    -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "rollback.sh: unknown argument: $arg" >&2; exit 2 ;;
    *) [ -z "$BACKUP_DIR" ] || { echo "rollback.sh: extra argument: $arg" >&2; exit 2; }; BACKUP_DIR="$arg" ;;
  esac
done
[ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || { echo "Usage: rollback.sh <backup-dir> [--oc-home=PATH] [--keep-plugin]" >&2; exit 2; }

OPENCLAW_CMD=()
for node_bin in "$OC_HOME"/tools/node-*/bin/node; do
  pkg="$(dirname "$(dirname "$node_bin")")/lib/node_modules/openclaw"
  [ -x "$node_bin" ] && [ -f "$pkg/dist/index.js" ] && OPENCLAW_CMD=("$node_bin" "$pkg/dist/index.js") && break
done
[ "${#OPENCLAW_CMD[@]}" -gt 0 ] || { command -v openclaw >/dev/null 2>&1 && OPENCLAW_CMD=(openclaw); }

restored=0
if [ -f "$BACKUP_DIR/openclaw.json.bak" ]; then
  cp -p "$BACKUP_DIR/openclaw.json.bak" "$OC_HOME/openclaw.json"
  echo "restored $OC_HOME/openclaw.json"
  restored=$((restored + 1))
fi
if [ -f "$BACKUP_DIR/agents/index.tsv" ]; then
  while IFS=$'\t' read -r agent_id target; do
    src="$BACKUP_DIR/agents/$agent_id/AGENTS.md.bak"
    [ -f "$src" ] || continue
    cp -p "$src" "$target"
    echo "restored $target"
    restored=$((restored + 1))
  done < "$BACKUP_DIR/agents/index.tsv"
fi
if [ "$KEEP_PLUGIN" = 0 ] && [ "${#OPENCLAW_CMD[@]}" -gt 0 ]; then
  "${OPENCLAW_CMD[@]}" plugins disable token-guard && echo "disabled plugin token-guard" || echo "plugin disable failed (continuing)"
fi
echo "rollback.sh: restored $restored file(s). Restart the Gateway to reload the restored config: openclaw gateway restart"
