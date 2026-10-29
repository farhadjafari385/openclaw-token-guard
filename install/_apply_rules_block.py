#!/usr/bin/env python3
"""Idempotently insert/replace a marker-delimited rules block in a text file.

The block in `block_path` must start with "<!-- token-guard:begin -->" and
end with "<!-- token-guard:end -->" (each on its own line). If those markers
already exist in the target file, the content between them (inclusive) is
replaced. Otherwise the block is appended, preceded by a blank line.

Usage: _apply_rules_block.py <target_path> <block_path> [--dry-run]
Exit codes: 0 = ok (written or no-op because already up to date), 1 = error,
2 = would-change (only in --dry-run, so callers can tell apply.sh what to report)
"""
import argparse
import sys

BEGIN = "<!-- token-guard:begin -->"
END = "<!-- token-guard:end -->"


def merge_block(target_text, block_text):
    """Returns (new_text, changed)."""
    block_text = block_text.rstrip("\n")
    if BEGIN not in block_text or END not in block_text:
        raise ValueError("block file is missing begin/end markers")

    if target_text and BEGIN in target_text and END in target_text:
        start = target_text.index(BEGIN)
        end = target_text.index(END) + len(END)
        if end <= start:
            raise ValueError("malformed existing markers in target (end before begin)")
        new_text = target_text[:start] + block_text + target_text[end:]
        return new_text, new_text != target_text

    sep = "" if (not target_text or target_text.endswith("\n\n")) else (
        "\n" if target_text.endswith("\n") else "\n\n"
    )
    new_text = target_text + sep + block_text + "\n"
    return new_text, True


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("target_path")
    parser.add_argument("block_path")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    try:
        with open(args.target_path, "r", encoding="utf-8") as f:
            target_text = f.read()
    except FileNotFoundError:
        target_text = ""

    with open(args.block_path, "r", encoding="utf-8") as f:
        block_text = f.read()

    new_text, changed = merge_block(target_text, block_text)

    if not changed:
        print(f"rules-block: {args.target_path} already up to date")
        return 0

    if args.dry_run:
        print(f"rules-block: would update {args.target_path}")
        return 0

    with open(args.target_path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print(f"rules-block: updated {args.target_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
