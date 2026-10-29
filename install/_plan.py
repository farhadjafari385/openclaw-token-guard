#!/usr/bin/env python3
"""Compute the token-guard config changes for one OpenClaw host.

Reads openclaw.json and the agent workspaces it names, and prints one JSON
object per line: {"path": ..., "value": ..., "mode": "set"|"replace", "why": ...}.
apply.sh turns each line into `openclaw config set <path> <value> --strict-json`
(plus `--replace` when mode is "replace"). Every value is the complete new
value with existing entries preserved. Nothing is written here.

Usage: _plan.py CONFIG [--coordinator ID] [--context-tokens N]
                [--daily-reset-hour H] [--group-idle-minutes M]
                [--rules-dir DIR] [--workspaces]
--workspaces prints "<agentId>\\t<workspace>" lines instead of the plan.
"""
import argparse
import json
import math
import os
import sys

MODELS = [
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
]
BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"]
DEFAULT_FILE_MAX = 20000
DEFAULT_TOTAL_MAX = 60000
BLOCK_BEGIN = "<!-- token-guard:begin -->"
BLOCK_END = "<!-- token-guard:end -->"


def load_config(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def workspaces(config):
    """(agent_id, workspace) for every configured agent with a workspace."""
    agents = config.get("agents") or {}
    found = []
    entries = agents.get("entries")
    if isinstance(entries, dict):
        for agent_id, entry in entries.items():
            if isinstance(entry, dict) and entry.get("workspace"):
                found.append((agent_id, os.path.expanduser(entry["workspace"])))
    for entry in agents.get("list") or []:
        if isinstance(entry, dict) and entry.get("id") and entry.get("workspace"):
            if all(entry["id"] != a for a, _ in found):
                found.append((entry["id"], os.path.expanduser(entry["workspace"])))
    return found


def chars(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return len(fh.read())
    except OSError:
        return 0


def block_chars(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return len(fh.read())
    except OSError:
        return 0


def existing_block_chars(path):
    """Size of a token-guard block already inside a file (replaced, not added)."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return 0
    if BLOCK_BEGIN in text and BLOCK_END in text:
        return text.index(BLOCK_END) + len(BLOCK_END) - text.index(BLOCK_BEGIN)
    return 0


def round_up(n, step=1000):
    return int(math.ceil(n / step) * step)


def bootstrap_needs(config, coordinator, rules_dir):
    """Largest single bootstrap file and largest per-agent total after the rule blocks are in."""
    spec = block_chars(os.path.join(rules_dir, "specialist.md"))
    coord = block_chars(os.path.join(rules_dir, "coordinator.md"))
    max_file, max_total = 0, 0
    for agent_id, ws in workspaces(config):
        block = coord if agent_id == coordinator else spec
        total = 0
        for name in BOOTSTRAP_FILES:
            path = os.path.join(ws, name)
            size = chars(path)
            if name == "AGENTS.md":
                size = size - existing_block_chars(path) + block + 2
            max_file = max(max_file, size)
            total += size
        max_total = max(max_total, total)
    return max_file, max_total


def merged_models(config, context_tokens):
    providers = (config.get("models") or {}).get("providers") or {}
    existing = (providers.get("anthropic") or {}).get("models")
    models = [dict(m) for m in existing if isinstance(m, dict)] if isinstance(existing, list) else []
    by_id = {m.get("id"): m for m in models}
    for model_id, name in MODELS:
        entry = by_id.get(model_id)
        if entry is None:
            entry = {"id": model_id}
            models.append(entry)
            by_id[model_id] = entry
        entry["name"] = entry.get("name") or name
        entry["contextTokens"] = context_tokens
    return models


def agent_tools(config, agent_id):
    agents = config.get("agents") or {}
    entries = agents.get("entries")
    if isinstance(entries, dict) and isinstance(entries.get(agent_id), dict):
        return entries[agent_id].get("tools") or {}, f"agents.entries.{agent_id}.tools"
    for index, entry in enumerate(agents.get("list") or []):
        if isinstance(entry, dict) and entry.get("id") == agent_id:
            return entry.get("tools") or {}, f"agents.list[{index}].tools"
    return {}, f"agents.entries.{agent_id}.tools"


def plan(config, args):
    ops = []

    def op(path, value, why, mode="set"):
        ops.append({"path": path, "value": value, "mode": mode, "why": why})

    providers = (config.get("models") or {}).get("providers") or {}
    existing_models = (providers.get("anthropic") or {}).get("models")
    models = merged_models(config, args.context_tokens)
    if existing_models != models:
        op("models.providers.anthropic.models", models,
           f"Claude Code compacts at {args.context_tokens} tokens instead of the 1M default",
           mode="replace" if existing_models else "set")

    if ((config.get("tools") or {}).get("loopDetection") or {}).get("enabled") is not True:
        op("tools.loopDetection.enabled", True, "OpenClaw's own repeated-call detector as a second net")

    defaults = (config.get("agents") or {}).get("defaults") or {}
    timeout = (defaults.get("compaction") or {}).get("timeoutSeconds")
    if not isinstance(timeout, (int, float)) or timeout < args.compaction_timeout:
        op("agents.defaults.compaction.timeoutSeconds", args.compaction_timeout,
           f"compaction gets {args.compaction_timeout}s instead of the 180s default; a compaction killed "
           "at the limit has already paid for reading the whole session")

    max_file, max_total = bootstrap_needs(config, args.coordinator, args.rules_dir)
    file_limit = defaults.get("bootstrapMaxChars") or DEFAULT_FILE_MAX
    total_limit = defaults.get("bootstrapTotalMaxChars") or DEFAULT_TOTAL_MAX
    if max_file > file_limit:
        op("agents.defaults.bootstrapMaxChars", round_up(max_file + 2000),
           f"largest AGENTS.md-style file is {max_file} chars; the {file_limit} limit cut part of it from the prompt")
    if max_total > total_limit:
        op("agents.defaults.bootstrapTotalMaxChars", round_up(max_total + 4000),
           f"largest per-agent bootstrap total is {max_total} chars (limit {total_limit})")

    tools, tools_path = agent_tools(config, args.coordinator)
    also = list(tools.get("alsoAllow") or [])
    allow = tools.get("allow")
    if isinstance(allow, list) and allow:
        if "task_inbox" not in allow:
            op(f"{tools_path}.allow", allow + ["task_inbox"], "coordinator needs the task_inbox tool")
    elif "task_inbox" not in also:
        op(f"{tools_path}.alsoAllow", also + ["task_inbox"], "coordinator needs the task_inbox tool")

    if args.daily_reset_hour is not None:
        session = config.get("session") or {}
        base = session.get("reset") or {}
        group = {"mode": "daily", "atHour": args.daily_reset_hour}
        idle = args.group_idle_minutes
        if idle is None and base.get("mode") == "idle" and base.get("idleMinutes"):
            idle = base["idleMinutes"]
        if idle:
            group["idleMinutes"] = idle
        current = (session.get("resetByType") or {}).get("group")
        if current != group:
            op("session.resetByType.group", group,
               "group sessions (team topics) start fresh every day" + (f" and after {idle} idle minutes" if idle else ""))

    if args.coordinator != "coordinator":
        op("plugins.entries.token-guard.config.briefCheckAgents", [args.coordinator], "brief check applies to this coordinator id")
    return ops


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--coordinator", default="coordinator")
    ap.add_argument("--context-tokens", type=int, default=200000)
    ap.add_argument("--compaction-timeout", type=int, default=900)
    ap.add_argument("--daily-reset-hour", type=int)
    ap.add_argument("--group-idle-minutes", type=int)
    ap.add_argument("--rules-dir", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rules"))
    ap.add_argument("--workspaces", action="store_true")
    args = ap.parse_args(argv)
    if args.daily_reset_hour is not None and not 0 <= args.daily_reset_hour <= 23:
        ap.error("--daily-reset-hour must be 0-23")
    config = load_config(args.config)
    if args.workspaces:
        for agent_id, ws in workspaces(config):
            print(f"{agent_id}\t{ws}")
        return 0
    for item in plan(config, args):
        print(json.dumps(item))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
