#!/usr/bin/env python3
"""token-audit: analyse Claude Code transcripts for token usage and polling patterns.

Scans ~/.claude/projects/*/*.jsonl (or --root) for assistant usage entries
within a --days window, reports totals, weighted "units", breakdowns by
agent/day/model, a polling-call share, top sessions, and a max-context bucket
histogram.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys
from collections import defaultdict

AGENT_DIR_PREFIX_RE = re.compile(r"^-home-[^-]+(?:-[^-]+)*?--openclaw-workspace-")


def strip_agent_prefix(dirname):
    # Spec: strip "-home-<user>--openclaw-workspace-" prefix if present.
    m = re.match(r"^-home-[^/]+?--openclaw-workspace-(.*)$", dirname)
    if m:
        return m.group(1)
    return dirname


def is_exec_tool(name):
    return bool(name) and name.split("__")[-1] == "exec"


def is_process_tool(name):
    return bool(name) and name.split("__")[-1] == "process"


def parse_sleep_commands(command):
    if not isinstance(command, str):
        return False
    return bool(re.search(r"(?:^|[\s;&|()])sleep\s+\d", command))


def normalize_command(command):
    if not isinstance(command, str):
        return ""
    return re.sub(r"\s+", " ", command.strip())


def weighted_units(input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h):
    return (
        input_tokens * 1.0
        + cache_read * 0.1
        + cache_write_5m * 1.25
        + cache_write_1h * 2.0
        + output_tokens * 5.0
    )


def iter_jsonl_files(root, days):
    cutoff = None
    if days is not None:
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    pattern = os.path.join(root, "*", "*.jsonl")
    for path in glob.glob(pattern):
        yield path


def parse_timestamp(ts):
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.datetime.fromisoformat(ts)
    except ValueError:
        return None


def analyse(root, days, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=days) if days is not None else None

    seen_message_ids = set()
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    weighted_total = 0.0

    by_agent = defaultdict(lambda: {"weighted": 0.0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
    by_day = defaultdict(lambda: {"weighted": 0.0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
    by_model = defaultdict(lambda: {"weighted": 0.0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0})

    session_totals = defaultdict(lambda: {"weighted": 0.0, "max_context": 0})
    session_agent = {}

    total_calls = 0
    polling_calls = 0

    for path in iter_jsonl_files(root, days):
        project_dir = os.path.basename(os.path.dirname(path))
        agent = strip_agent_prefix(project_dir)

        # per-session, per-turn command run tracker for "repeated 3+ times in one turn"
        turn_command_counts = defaultdict(lambda: defaultdict(int))

        try:
            with open(path, "r") as f:
                lines = f.readlines()
        except OSError:
            continue

        session_id = None
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue

            session_id = d.get("sessionId", session_id)
            if session_id:
                session_agent.setdefault(session_id, agent)

            ts = parse_timestamp(d.get("timestamp"))
            if cutoff is not None and ts is not None and ts < cutoff:
                continue

            if d.get("type") != "assistant":
                continue
            message = d.get("message") or {}
            msg_id = message.get("id")
            if msg_id is not None:
                if msg_id in seen_message_ids:
                    continue
                seen_message_ids.add(msg_id)

            usage = message.get("usage") or {}
            input_tokens = usage.get("input_tokens", 0) or 0
            output_tokens = usage.get("output_tokens", 0) or 0
            cache_read = usage.get("cache_read_input_tokens", 0) or 0
            cache_creation = usage.get("cache_creation") or {}
            cache_5m = cache_creation.get("ephemeral_5m_input_tokens")
            cache_1h = cache_creation.get("ephemeral_1h_input_tokens")
            if cache_5m is None and cache_1h is None:
                cache_write_total = usage.get("cache_creation_input_tokens", 0) or 0
                cache_5m = cache_write_total
                cache_1h = 0
            else:
                cache_5m = cache_5m or 0
                cache_1h = cache_1h or 0
            cache_write_total = cache_5m + cache_1h

            units = weighted_units(input_tokens, output_tokens, cache_read, cache_5m, cache_1h)

            model = message.get("model") or "unknown"
            day_key = ts.strftime("%Y-%m-%d") if ts else "unknown"

            totals["input"] += input_tokens
            totals["output"] += output_tokens
            totals["cache_read"] += cache_read
            totals["cache_write"] += cache_write_total
            weighted_total += units

            for bucket, key in ((by_agent, agent), (by_day, day_key), (by_model, model)):
                b = bucket[key]
                b["weighted"] += units
                b["input"] += input_tokens
                b["output"] += output_tokens
                b["cache_read"] += cache_read
                b["cache_write"] += cache_write_total

            if session_id:
                st = session_totals[session_id]
                st["weighted"] += units
                context_size = input_tokens + cache_read + cache_write_total
                if context_size > st["max_context"]:
                    st["max_context"] = context_size

            # polling classification: inspect tool_use entries in this message
            content = message.get("content") or []
            turn_id = d.get("promptId") or msg_id
            for c in content:
                if not isinstance(c, dict) or c.get("type") != "tool_use":
                    continue
                total_calls += 1
                name = c.get("name")
                tool_input = c.get("input") or {}
                is_poll = False
                if is_process_tool(name) and tool_input.get("action") in ("poll", "log", "list"):
                    is_poll = True
                elif is_exec_tool(name) and parse_sleep_commands(tool_input.get("command")):
                    is_poll = True
                elif is_exec_tool(name):
                    cmd = normalize_command(tool_input.get("command"))
                    if cmd and session_id:
                        turn_command_counts[(session_id, turn_id)][cmd] += 1
                        if turn_command_counts[(session_id, turn_id)][cmd] >= 3:
                            is_poll = True
                if is_poll:
                    polling_calls += 1

    # top 10 sessions by weighted total
    top_sessions = sorted(session_totals.items(), key=lambda kv: kv[1]["weighted"], reverse=True)[:10]
    top_sessions_out = [
        {
            "session": sid,
            "agent": session_agent.get(sid, "unknown"),
            "weighted": round(st["weighted"], 2),
            "max_context": st["max_context"],
        }
        for sid, st in top_sessions
    ]

    # context bucket histogram (per session max context)
    buckets = {"<100k": 0, "100-200k": 0, "200-500k": 0, ">500k": 0}
    for st in session_totals.values():
        mc = st["max_context"]
        if mc < 100_000:
            buckets["<100k"] += 1
        elif mc < 200_000:
            buckets["100-200k"] += 1
        elif mc < 500_000:
            buckets["200-500k"] += 1
        else:
            buckets[">500k"] += 1

    def round_bucket(d):
        return {k: {kk: (round(vv, 2) if kk == "weighted" else vv) for kk, vv in v.items()} for k, v in d.items()}

    return {
        "totals": totals,
        "weighted_total": round(weighted_total, 2),
        "by_agent": round_bucket(by_agent),
        "by_day": round_bucket(by_day),
        "by_model": round_bucket(by_model),
        "polling": {
            "total_calls": total_calls,
            "polling_calls": polling_calls,
            "share": round(polling_calls / total_calls, 4) if total_calls else 0.0,
        },
        "top_sessions": top_sessions_out,
        "max_context_buckets": buckets,
    }


def main(argv):
    parser = argparse.ArgumentParser(prog="token-audit")
    parser.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--alert-weighted", type=float)
    args = parser.parse_args(argv)

    result = analyse(args.root, args.days)

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        t = result["totals"]
        print(f"Window: last {args.days} day(s), root={args.root}")
        print(f"Totals: input={t['input']} output={t['output']} cache_read={t['cache_read']} cache_write={t['cache_write']}")
        print(f"Weighted units: {result['weighted_total']}")
        print("\nBy agent:")
        for k, v in sorted(result["by_agent"].items(), key=lambda kv: -kv[1]["weighted"]):
            print(f"  {k:30} weighted={v['weighted']}")
        print("\nBy day:")
        for k, v in sorted(result["by_day"].items()):
            print(f"  {k:12} weighted={v['weighted']}")
        print("\nBy model:")
        for k, v in sorted(result["by_model"].items(), key=lambda kv: -kv[1]["weighted"]):
            print(f"  {k:30} weighted={v['weighted']}")
        p = result["polling"]
        print(f"\nPolling share: {p['polling_calls']}/{p['total_calls']} = {p['share']*100:.1f}%")
        print("\nTop sessions by weighted total:")
        for s in result["top_sessions"]:
            print(f"  {s['session']}  agent={s['agent']}  weighted={s['weighted']}  max_context={s['max_context']}")
        print("\nMax-context-per-session buckets:")
        for k, v in result["max_context_buckets"].items():
            print(f"  {k:10} {v}")

    if args.alert_weighted is not None and result["weighted_total"] > args.alert_weighted:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
