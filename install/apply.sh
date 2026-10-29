#!/usr/bin/env bash
# install/apply.sh: install token-guard on this OpenClaw host.
#
#   install/apply.sh --dry-run        show every change, write nothing
#   install/apply.sh [options]        back up, then apply
#
# Options:
#   --oc-home=PATH           OpenClaw home (default ~/.openclaw, or $OC_HOME)
#   --coordinator=ID         coordinator agent id (default: coordinator)
#   --context-tokens=N       Claude Code compaction window (default 200000)
#   --daily-reset-hour=H     reset group sessions daily at H (gateway local time)
#   --group-idle-minutes=M   also reset group sessions after M idle minutes
#   --patch-legacy           replace known legacy "keep polling" rules in AGENTS.md
#   --install-skills         copy skills/* into every agent workspace
#   --skip-plugin            skip the plugin install
#   --skip-config            skip config changes
#
# Changes apply to the running Gateway (plugin install and hot-reloaded config).
# The script never restarts the Gateway.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OC_HOME="${OC_HOME:-$HOME/.openclaw}"
DRY_RUN=0
COORDINATOR_ID="coordinator"
PLAN_ARGS=()
PATCH_LEGACY=0
INSTALL_SKILLS=0
SKIP_PLUGIN=0
SKIP_CONFIG=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --oc-home=*) OC_HOME="${arg#*=}" ;;
    --coordinator=*) COORDINATOR_ID="${arg#*=}" ;;
    --context-tokens=*) PLAN_ARGS+=(--context-tokens "${arg#*=}") ;;
    --daily-reset-hour=*) PLAN_ARGS+=(--daily-reset-hour "${arg#*=}") ;;
    --group-idle-minutes=*) PLAN_ARGS+=(--group-idle-minutes "${arg#*=}") ;;
    --patch-legacy) PATCH_LEGACY=1 ;;
    --install-skills) INSTALL_SKILLS=1 ;;
    --skip-plugin) SKIP_PLUGIN=1 ;;
    --skip-config) SKIP_CONFIG=1 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "apply.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '%s\n' "$*"; }
step() { printf '\n--- %s\n' "$*"; }
FAILED=0
fail_step() { echo "apply.sh: FAILED: $*" >&2; FAILED=1; }
run() {
  if [ "$DRY_RUN" = 1 ]; then log "[dry-run] $*"; else log "[apply] $*"; "$@"; fi
}

PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "apply.sh: python3 is required" >&2; exit 1; }
CONFIG="$OC_HOME/openclaw.json"
[ -f "$CONFIG" ] || { echo "apply.sh: no config at $CONFIG (set --oc-home)" >&2; exit 1; }
PLAN_ARGS+=(--coordinator "$COORDINATOR_ID" --rules-dir "$REPO_ROOT/rules")

# OpenClaw CLI: prefer the node + dist bundled under $OC_HOME/tools (a wrapper on
# PATH can point at an older Node), then `openclaw` on PATH. Use the first that runs.
OPENCLAW_CMD=()
OC_PKG=""
for node_bin in "$OC_HOME"/tools/node-*/bin/node; do
  [ -x "$node_bin" ] || continue
  pkg="$(dirname "$(dirname "$node_bin")")/lib/node_modules/openclaw"
  if [ -f "$pkg/dist/index.js" ] && "$node_bin" "$pkg/dist/index.js" --version >/dev/null 2>&1; then
    OPENCLAW_CMD=("$node_bin" "$pkg/dist/index.js"); OC_PKG="$pkg"; break
  fi
done
if [ "${#OPENCLAW_CMD[@]}" -eq 0 ] && command -v openclaw >/dev/null 2>&1 && openclaw --version >/dev/null 2>&1; then
  OPENCLAW_CMD=(openclaw)
  cli="$(readlink -f "$(command -v openclaw)")"
  dir="$(dirname "$cli")"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] && grep -q '"name": *"openclaw"' "$dir/package.json"; then OC_PKG="$dir"; break; fi
    dir="$(dirname "$dir")"
  done
fi
oc() { "${OPENCLAW_CMD[@]}" "$@"; }

# The CLI talks to the running Gateway for plugin installs. When the Gateway
# token is a secret reference kept in the service environment, load that file.
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}${OPENCLAW_GATEWAY_PASSWORD:-}" ] && [ -f "$OC_HOME/gateway.systemd.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$OC_HOME/gateway.systemd.env"
  set +a
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$OC_HOME/backups/token-guard-$TS"
PLUGIN_DIR="$OC_HOME/token-guard/plugin"
WORKSPACES="$("$PY" "$REPO_ROOT/install/_plan.py" "$CONFIG" --workspaces)"

step "Target"
log "OpenClaw home:  $OC_HOME"
log "OpenClaw CLI:   ${OPENCLAW_CMD[*]:-NOT FOUND} $( [ "${#OPENCLAW_CMD[@]}" -gt 0 ] && oc --version 2>/dev/null | head -1)"
log "OpenClaw pkg:   ${OC_PKG:-NOT FOUND}"
log "Agents:         $(printf '%s\n' "$WORKSPACES" | cut -f1 | tr '\n' ' ')"
log "Mode:           $([ "$DRY_RUN" = 1 ] && echo 'dry run (no writes)' || echo apply)"
[ "${#OPENCLAW_CMD[@]}" -gt 0 ] || { echo "apply.sh: no working OpenClaw CLI found" >&2; exit 1; }

step "Backup"
run mkdir -p "$BACKUP_DIR/agents"
run cp -p "$CONFIG" "$BACKUP_DIR/openclaw.json.bak"
while IFS=$'\t' read -r agent_id workspace; do
  [ -n "$workspace" ] && [ -f "$workspace/AGENTS.md" ] || continue
  run mkdir -p "$BACKUP_DIR/agents/$agent_id"
  run cp -p "$workspace/AGENTS.md" "$BACKUP_DIR/agents/$agent_id/AGENTS.md.bak"
  [ "$DRY_RUN" = 1 ] || printf '%s\t%s\n' "$agent_id" "$workspace/AGENTS.md" >> "$BACKUP_DIR/agents/index.tsv"
done <<< "$WORKSPACES"

step "Waiters and inbox (oc-wait, oc-wait-pipeline, oc-inbox)"
run mkdir -p "$OC_HOME/bin"
for name in oc-wait oc-wait-pipeline oc-inbox; do
  run install -m 0755 "$REPO_ROOT/bin/$name" "$OC_HOME/bin/$name"
done

step "AGENTS.md rules"
if [ "$PATCH_LEGACY" = 1 ]; then
  legacy_files=()
  while IFS=$'\t' read -r _ workspace; do
    [ -n "$workspace" ] && [ -f "$workspace/AGENTS.md" ] && legacy_files+=("$workspace/AGENTS.md")
  done <<< "$WORKSPACES"
  if [ "${#legacy_files[@]}" -gt 0 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      "$PY" "$REPO_ROOT/tools/patch-legacy-wait-rules.py" "${legacy_files[@]}" || fail_step "legacy rule patch"
    else
      "$PY" "$REPO_ROOT/tools/patch-legacy-wait-rules.py" --apply "${legacy_files[@]}" || fail_step "legacy rule patch"
    fi
  fi
fi
while IFS=$'\t' read -r agent_id workspace; do
  [ -n "$workspace" ] || continue
  if [ "$agent_id" = "$COORDINATOR_ID" ]; then block="$REPO_ROOT/rules/coordinator.md"; else block="$REPO_ROOT/rules/specialist.md"; fi
  if [ ! -f "$workspace/AGENTS.md" ]; then log "skip $agent_id: no AGENTS.md in $workspace"; continue; fi
  if [ "$DRY_RUN" = 1 ]; then
    "$PY" "$REPO_ROOT/install/_apply_rules_block.py" "$workspace/AGENTS.md" "$block" --dry-run || fail_step "rules for $agent_id"
  else
    "$PY" "$REPO_ROOT/install/_apply_rules_block.py" "$workspace/AGENTS.md" "$block" || fail_step "rules for $agent_id"
  fi
done <<< "$WORKSPACES"

if [ "$INSTALL_SKILLS" = 1 ]; then
  step "Skills"
  while IFS=$'\t' read -r agent_id workspace; do
    [ -n "$workspace" ] || continue
    for skill in "$REPO_ROOT"/skills/*/; do
      run mkdir -p "$workspace/skills/$(basename "$skill")"
      run cp -p "$skill/SKILL.md" "$workspace/skills/$(basename "$skill")/SKILL.md"
    done
  done <<< "$WORKSPACES"
fi

if [ "$SKIP_PLUGIN" = 0 ]; then
  step "Plugin (token-guard)"
  run rm -rf "$PLUGIN_DIR"
  run mkdir -p "$PLUGIN_DIR/node_modules"
  run cp -p "$REPO_ROOT/plugin/index.js" "$REPO_ROOT/plugin/guard.js" "$REPO_ROOT/plugin/inbox.js" \
    "$REPO_ROOT/plugin/package.json" "$REPO_ROOT/plugin/openclaw.plugin.json" "$PLUGIN_DIR/"
  # A linked local plugin resolves imports from its own folder: point
  # node_modules at the host's OpenClaw package and its TypeBox copy.
  if [ -n "$OC_PKG" ]; then
    run ln -sfn "$OC_PKG" "$PLUGIN_DIR/node_modules/openclaw"
    if [ -d "$OC_PKG/node_modules/typebox" ]; then
      # Copied, not linked: the install safety scan rejects symlinks that leave the plugin folder.
      run cp -rL "$OC_PKG/node_modules/typebox" "$PLUGIN_DIR/node_modules/typebox"
    else
      log "typebox not found under $OC_PKG/node_modules: task_inbox tool will be skipped"
    fi
  else
    fail_step "OpenClaw package dir not found; cannot link plugin imports"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] openclaw plugins install --link $PLUGIN_DIR --force --accept-capabilities"
  else
    log "[apply] openclaw plugins install --link $PLUGIN_DIR --force --accept-capabilities"
    oc plugins install --link "$PLUGIN_DIR" --force --accept-capabilities || fail_step "plugins install"
  fi
fi

if [ "$SKIP_CONFIG" = 0 ]; then
  step "Config"
  # Plan after the rule blocks are in, so bootstrap limits include them.
  PLAN="$("$PY" "$REPO_ROOT/install/_plan.py" "$CONFIG" "${PLAN_ARGS[@]}")" || { fail_step "config plan"; PLAN=""; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["path"])' "$line")"
    value="$("$PY" -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["value"]))' "$line")"
    mode="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["mode"])' "$line")"
    why="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["why"])' "$line")"
    log "# $why"
    extra=()
    [ "$mode" = "replace" ] && extra=(--replace)
    if [ "$DRY_RUN" = 1 ]; then
      log "[dry-run] openclaw config set $path '$value' --strict-json ${extra[*]:-}"
    else
      log "[apply] openclaw config set $path '$value' --strict-json ${extra[*]:-}"
      oc config set "$path" "$value" --strict-json "${extra[@]}" || fail_step "config set $path"
    fi
  done <<< "$PLAN"
  if [ "$DRY_RUN" = 0 ]; then
    oc config validate || fail_step "config validate"
  fi
fi

step "Done"
if [ "$DRY_RUN" = 1 ]; then
  log "Dry run only; nothing was written."
else
  log "Backups: $BACKUP_DIR   (undo: install/rollback.sh $BACKUP_DIR)"
  log "Next: install/verify.sh. A Gateway restart is optional (frees memory); the plugin and config apply live."
fi
exit "$FAILED"
