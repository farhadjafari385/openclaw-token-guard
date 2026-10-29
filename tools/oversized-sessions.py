#!/usr/bin/env python3
"""oversized-sessions: find OpenClaw sessions that outgrew their context window, and reset them.

A session past its window cannot compact: compaction has to send the whole
session to the model, and every "compact" or "fix yourself" message is another
full-size run that fails. Only a reset gets it back. This tool lists such
sessions and, with --reset, backs up every affected agent database and resets
them through the running gateway (sub-agent sessions are archived instead,
since a reset keeps their Claude CLI binding).

  oversized-sessions.py                    report sessions at >= 80% of their window
  oversized-sessions.py --threshold 1.0    only sessions past their window
  oversized-sessions.py --reset            back up, then reset/archive them

Exit code: 0 when nothing matched (or every reset succeeded), 1 otherwise.
"""
import argparse
import glob
import json
import os
import sqlite3
import subprocess
import sys
import time

DEFAULT_WINDOW = 200000


def find_openclaw(oc_home):
    for node in sorted(glob.glob(os.path.join(oc_home, "tools", "node-*", "bin", "node"))):
        entry = os.path.join(os.path.dirname(os.path.dirname(node)), "lib", "node_modules", "openclaw", "dist", "index.js")
        if os.access(node, os.X_OK) and os.path.isfile(entry):
            return [node, entry]
    return ["openclaw"]


def parse_json_output(text):
    # The CLI may print a banner line before the JSON.
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON in openclaw output")
    return json.loads(text[start:])


def agent_of(key):
    parts = str(key).split(":")
    return parts[1] if len(parts) > 2 and parts[0] == "agent" else None


def is_subagent(key):
    return ":subagent:" in str(key)


def select(sessions, threshold, default_window=DEFAULT_WINDOW):
    """Sessions whose totalTokens reach threshold x their window, largest first."""
    out = []
    for s in sessions:
        tokens = s.get("totalTokens") or 0
        window = s.get("contextTokens") or default_window
        # The listing reports the configured cap; never trust a window above it.
        window = min(window, default_window)
        if tokens > 0 and tokens >= threshold * window:
            out.append({"key": s.get("key"), "agent": s.get("agentId") or agent_of(s.get("key")),
                        "tokens": tokens, "window": window, "status": s.get("status")})
    return sorted(out, key=lambda r: -r["tokens"])


def backup_agents(oc_home, agents, dest):
    os.makedirs(dest, exist_ok=True)
    os.chmod(dest, 0o700)
    for agent in sorted(agents):
        src = os.path.join(oc_home, "agents", agent, "agent", "openclaw-agent.sqlite")
        if not os.path.isfile(src):
            raise FileNotFoundError(src)
        with sqlite3.connect(f"file:{src}?mode=ro", uri=True) as s, sqlite3.connect(os.path.join(dest, f"{agent}.sqlite")) as d:
            s.backup(d)


def reset_one(oc, row, timeout_ms=60000):
    if is_subagent(row["key"]):
        cmd = oc + ["sessions", "archive", row["key"], "--agent", row["agent"]]
    else:
        params = json.dumps({"key": row["key"], "agentId": row["agent"], "reason": "reset"})
        cmd = oc + ["gateway", "call", "sessions.reset", "--json", "--timeout", str(timeout_ms), "--params", params]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_ms / 1000 + 30)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout).strip()[-300:]
    if is_subagent(row["key"]):
        return True, "archived"
    try:
        entry = parse_json_output(proc.stdout).get("entry") or {}
    except ValueError as exc:
        return False, str(exc)
    return entry.get("totalTokens") in (0, None), f"reset, tokens {entry.get('totalTokens')}"


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--oc-home", default=os.environ.get("OC_HOME", os.path.expanduser("~/.openclaw")))
    ap.add_argument("--threshold", type=float, default=0.8, help="fraction of the window (default 0.8)")
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW, help="context cap in tokens (default 200000)")
    ap.add_argument("--from-json", help="read `openclaw sessions --all-agents --json` output from a file")
    ap.add_argument("--reset", action="store_true", help="back up agent databases, then reset/archive matches")
    ap.add_argument("--quiet", action="store_true", help="print only matches")
    args = ap.parse_args(argv)

    oc = find_openclaw(args.oc_home)
    if args.from_json:
        with open(args.from_json, encoding="utf-8") as fh:
            listing = parse_json_output(fh.read())
    else:
        proc = subprocess.run(oc + ["sessions", "--all-agents", "--limit", "all", "--json"],
                              capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            print(f"oversized-sessions: openclaw sessions failed: {proc.stderr.strip()[-300:]}", file=sys.stderr)
            return 2
        listing = parse_json_output(proc.stdout)

    sessions = listing.get("sessions") or []
    rows = select(sessions, args.threshold, args.window)
    if not args.quiet:
        print(f"{len(sessions)} sessions checked; {len(rows)} at >= {args.threshold:.0%} of their window")
    for r in rows:
        print(f"{r['tokens'] // 1000:>6}k/{r['window'] // 1000}k  {r['key']}")
    if not rows:
        return 0
    if not args.reset:
        if not args.quiet:
            print("Run again with --reset to back up and reset them (sub-agent sessions are archived).")
        return 1

    dest = os.path.join(args.oc_home, "backups", "oversized-sessions-" + time.strftime("%Y%m%d-%H%M%S"))
    backup_agents(args.oc_home, {r["agent"] for r in rows}, dest)
    print(f"backed up {len({r['agent'] for r in rows})} agent database(s) to {dest}")
    failed = 0
    for r in rows:
        ok, detail = reset_one(oc, r)
        failed += 0 if ok else 1
        print(("OK    " if ok else "FAIL  ") + f"{r['key']}: {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
