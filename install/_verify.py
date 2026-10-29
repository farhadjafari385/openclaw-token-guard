#!/usr/bin/env python3
"""Config, rules and plugin checks for verify.sh. Prints PASS/FAIL lines and
exits with the number of failures (capped at 100)."""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _plan  # noqa: E402

LEGACY_MARKERS = [
    "Never foreground-poll a job for more than 5 minutes",
    "a worker must wait for its checks",
]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--coordinator", default="coordinator")
    ap.add_argument("--inspect", help="file with `openclaw plugins inspect token-guard --runtime --json` output")
    ap.add_argument("--context-tokens", type=int, default=200000)
    ap.add_argument("--compaction-timeout", type=int, default=900)
    args = ap.parse_args(argv)

    fails = 0

    def check(ok, msg):
        nonlocal fails
        print(("PASS  " if ok else "FAIL  ") + msg)
        if not ok:
            fails += 1

    cfg = _plan.load_config(args.config)
    models = (((cfg.get("models") or {}).get("providers") or {}).get("anthropic") or {}).get("models") or []
    by_id = {m.get("id"): m for m in models if isinstance(m, dict)}
    for model_id, _ in _plan.MODELS:
        tokens = (by_id.get(model_id) or {}).get("contextTokens")
        check(isinstance(tokens, int) and tokens <= args.context_tokens, f"{model_id}: contextTokens {tokens}")
    timeout = ((((cfg.get("agents") or {}).get("defaults") or {}).get("compaction") or {}).get("timeoutSeconds"))
    check(isinstance(timeout, (int, float)) and timeout >= args.compaction_timeout,
          f"agents.defaults.compaction.timeoutSeconds {timeout} (OpenClaw default 180 when unset)")
    check(((cfg.get("tools") or {}).get("loopDetection") or {}).get("enabled") is True, "tools.loopDetection.enabled true")
    entry = ((cfg.get("plugins") or {}).get("entries") or {}).get("token-guard") or {}
    check(entry.get("enabled", True) is not False, f"plugins.entries.token-guard enabled ({entry.get('enabled', 'default')})")
    tools, path = _plan.agent_tools(cfg, args.coordinator)
    check("task_inbox" in (tools.get("alsoAllow") or []) + (tools.get("allow") or []), f"{path} allows task_inbox")

    defaults = (cfg.get("agents") or {}).get("defaults") or {}
    file_limit = defaults.get("bootstrapMaxChars") or _plan.DEFAULT_FILE_MAX
    total_limit = defaults.get("bootstrapTotalMaxChars") or _plan.DEFAULT_TOTAL_MAX
    for agent_id, ws in _plan.workspaces(cfg):
        try:
            with open(os.path.join(ws, "AGENTS.md"), encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            check(False, f"{agent_id}: AGENTS.md missing in {ws}")
            continue
        check(_plan.BLOCK_BEGIN in text and _plan.BLOCK_END in text, f"{agent_id}: token-guard rules present")
        legacy = [m for m in LEGACY_MARKERS if m in " ".join(text.split())]
        check(not legacy, f"{agent_id}: no legacy polling rules" + (f" (found: {legacy})" if legacy else ""))
        sizes = {name: _plan.chars(os.path.join(ws, name)) for name in _plan.BOOTSTRAP_FILES}
        name, biggest = max(sizes.items(), key=lambda kv: kv[1])
        total = sum(sizes.values())
        check(biggest <= file_limit and total <= total_limit,
              f"{agent_id}: rules fit the prompt uncut ({name} {biggest}/{file_limit}, total {total}/{total_limit})")

    if args.inspect:
        raw = open(args.inspect, encoding="utf-8", errors="replace").read()
        try:
            data = json.loads(raw[raw.index("{"):])
            text = json.dumps(data)
        except ValueError:
            data, text = None, ""
        check(data is not None, "plugin inspect returned JSON")
        check("before_tool_call" in text, "plugin registers before_tool_call")
        check("task_inbox" in text, "plugin registers task_inbox")
        bad = any(f'"status": "{s}"' in text for s in ("error", "failed"))
        check(not bad, "plugin has no load error")
    return min(fails, 100)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
