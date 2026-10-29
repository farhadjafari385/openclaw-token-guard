---
name: token-guard
description: Wait for CI, deploys, builds or long tests without burning tokens; use before any wait, poll, sleep or repeated status check.
---

# Waiting without burning tokens

Every tool call re-sends the whole conversation. Ten status checks on a
400k-token session cost 4M tokens; one background waiter costs nothing until it
finishes.

## Procedure

1. Start the long job once (pipeline push, deploy, test run).
2. Start ONE waiter as an exec call with `background: true`:
   - GitLab pipeline:
     `~/.openclaw/bin/oc-wait-pipeline --project <id or group/path> --pipeline <id>`
     (`--ref <branch>` or `--mr <iid>` pick the latest pipeline). It prints the
     status and, on failure, the failed jobs with the tail of their logs.
   - Any condition: `~/.openclaw/bin/oc-wait --every 30 --timeout 2h -- <command that exits 0 when done>`
   - A process: `~/.openclaw/bin/oc-wait --pid <pid>`
   - A file or log line: `~/.openclaw/bin/oc-wait --file <path> --match <regex>`
3. Post one short "Waiting on <what>" line where the human watches, then end
   your turn. OpenClaw wakes the session when the waiter exits and hands you its
   output.
4. On wake: read the waiter output, fix or report. "Done" only when checks pass.

Subagent sessions get no automatic wake: keep waits short there (polling the
waiter is allowed), and for long waits report "Waiting on <what>" to the
parent and end.

## Never

- `process poll` / `process log` in a loop (more than 2 checks per job is blocked)
- `sleep` of 20 s or more, or `while/until` loops with `sleep`, in a foreground command
- the same status command 4 times without other progress
- reporting "done" while the waiter is still running

## Keep output small

Pipe long output through `tail -n 40` or `grep`. Every line you read is
re-sent on every later call in this session.
