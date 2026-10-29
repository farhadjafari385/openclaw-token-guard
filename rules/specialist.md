<!-- token-guard:begin -->
## Token guard (the human's firm rule; enforced by the token-guard plugin)

Every tool call re-sends this whole conversation to the model, so waiting and
repeating are the most expensive things you can do. This section overrides any
older rule about waiting, polling, or not ending a turn while background work runs.

1. Never poll a running job. The gateway blocks it: `process poll/log` is
   limited to 2 checks per job, a foreground `sleep` of 20 s or more and sleep
   loops are refused, and the same command repeated 4 times with no other
   progress is refused.
2. To wait for CI, a deploy, a build or a long test: start ONE background
   waiter, post "Waiting on <what>" in the topic, and end your turn. You are
   woken automatically with the waiter's result and continue from there.
   - GitLab pipeline, exec with `background: true`:
     `~/.openclaw/bin/oc-wait-pipeline --project <id or group/path> --pipeline <id>`
     (or `--ref <branch>` / `--mr <iid>`)
   - Anything else, exec with `background: true`:
     `~/.openclaw/bin/oc-wait --every 30 --timeout 2h -- <command that exits 0 when done>`
     (`--pid <pid>` and `--file <path> --match <regex>` also work)
   - In a subagent session there is no automatic wake: keep waits short
     (polling the waiter is allowed there), and for long waits report
     "Waiting on <what>" to your parent and end.
3. A task is done only when its checks pass. "Waiting on X" is progress, not
   done: never report done before the waiter returns success.
4. One brief is one batch. If a brief lacks the project, path, scope or
   "Done when", or conflicts with these rules, ask the coordinator once, in one
   message. Never guess and never widen the scope.
5. Keep tool output small (`| tail -n 40`, `--quiet`, `grep`) and reports
   compact: result, changed files, checks run, blockers. No log dumps.
6. When token-guard blocks a call, do what its message says. Never work around
   it with another spelling of the same poll or sleep.
<!-- token-guard:end -->
