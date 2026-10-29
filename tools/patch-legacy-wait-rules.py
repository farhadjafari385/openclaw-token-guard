#!/usr/bin/env python3
"""Replace the old waiting rules in every agent AGENTS.md with token-guard wording.

The old rules ("a worker must wait for its checks", "never end your turn while
background work is still running", "never foreground-poll for more than 5
minutes") made agents poll running jobs. Matching ignores line wrapping.
Usage: patch-legacy-wait-rules.py [--apply] [--backup-dir DIR] [--root DIR | AGENTS.md ...]
Without --apply it only prints what would change. Only the exact legacy
sentences listed in RULES are touched; everything else stays byte-identical.
"""
import argparse, os, re, shutil, sys, textwrap

RULES = [
    (
        "3. Never foreground-poll a job for more than 5 minutes: check it, report its "
        "job ID and current status, then move on or end the turn; a later check "
        "picks up where you left off.",
        "3. Never poll or sleep-wait on a job. Start a token-guard waiter in the "
        "background, report the job ID and \"Waiting on <what>\", then end the turn; "
        "the waiter wakes you with the result (see \"Token guard\").",
    ),
    (
        "Never end your turn while background work is still running (no async "
        "Agent/Explore launches you don't wait for, no \"running in background\").",
        "Never end your turn while unknown background work is still running (no "
        "async Agent/Explore launches you don't wait for). The one exception is a "
        "token-guard waiter: start it, post \"Waiting on <what>\", end the turn, and "
        "continue when it wakes you.",
    ),
    (
        "Never accept \"running in background\" as a result: a worker must wait for its checks.",
        "Never accept an unverified result: \"done\" means its checks passed. "
        "\"Waiting on <X>\" from a worker is progress, not done; do not nudge it, "
        "its waiter wakes it.",
    ),
]


def pattern(text):
    return re.compile(r"\s+".join(re.escape(tok) for tok in text.split()))


def rewrap(text, start_col, indent):
    lines = textwrap.wrap(text, width=78, initial_indent=" " * start_col, subsequent_indent=indent)
    lines[0] = lines[0][start_col:]
    return "\n".join(lines)


def patch(content):
    changed = 0
    for old, new in RULES:
        rx = pattern(old)
        while True:
            m = rx.search(content)
            if not m:
                break
            line_start = content.rfind("\n", 0, m.start()) + 1
            prefix = content[line_start:m.start()]
            numbered = re.match(r"\s*\d+\.\s", prefix) or re.match(r"\s*\d+\.\s", old)
            indent = "   " if numbered else re.match(r"\s*", prefix).group(0)
            content = content[: m.start()] + rewrap(new, len(prefix), indent) + content[m.end():]
            changed += 1
    return content, changed


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="*", help="AGENTS.md files to patch")
    ap.add_argument("--root", help="patch <root>/*/AGENTS.md")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--backup-dir", help="copy originals here before writing")
    args = ap.parse_args()
    paths = list(args.files)
    if args.root:
        root = os.path.expanduser(args.root)
        paths += [os.path.join(root, d, "AGENTS.md") for d in sorted(os.listdir(root))
                  if os.path.isfile(os.path.join(root, d, "AGENTS.md"))]
    if not paths:
        ap.error("give AGENTS.md files or --root")
    total = 0
    for path in paths:
        if not os.path.isfile(path):
            print(f"{path}: missing, skipped")
            continue
        with open(path, encoding="utf-8") as fh:
            before = fh.read()
        after, n = patch(before)
        label = os.path.basename(os.path.dirname(path)) or path
        if not n:
            print(f"{label}: no legacy wait rules")
            continue
        total += n
        print(f"{label}: {n} legacy rule(s) {'replaced' if args.apply else 'would be replaced'}")
        if args.apply:
            if args.backup_dir:
                dest = os.path.join(args.backup_dir, label)
                os.makedirs(dest, exist_ok=True)
                shutil.copy2(path, os.path.join(dest, "AGENTS.md.legacy.bak"))
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(after)
    print(f"legacy rules: {total} replacement(s){'' if args.apply else ' (dry run)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
