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
   - In a task session started by the coordinator (a subagent session) there
     is no automatic wake: run the same waiter in the foreground instead, one
     call that waits without using tokens (`--timeout 9m`, command timeout 10
     minutes). If it times out, run it once more; never check in between.
3. A task is done only when its checks pass. "Waiting on X" is progress, not
   done: never report done before the waiter returns success.
4. One brief is one task session. Work only on its Items. Your final answer
   goes back to the coordinator by itself: result, changed files, checks run
   and passed, blockers. If a brief lacks the project, path, scope or "Done
   when", or conflicts with these rules, ask once in that answer. Never guess
   and never widen the scope.
5. Keep tool output small (`| tail -n 40`, `--quiet`, `grep`) and reports
   compact: result, changed files, checks run, blockers. No log dumps.
6. When token-guard blocks a call, do what its message says. Never work around
   it with another spelling of the same poll or sleep.
## Owner operating rules: team discipline

These rules govern day-to-day team discipline on top of the intake and
waiting rules above. Each line says whether token-guard enforces it (config
in `plugin/guard.js`) or whether it is a discipline rule agents must follow.

1. **Brief-spam lock** — a new task never goes into an existing specialist
   chat; it always starts a fresh session (`requireSpawnForBriefs`,
   enforced). A follow-up (answer, correction) to that session's own batch
   is still allowed via `sessions_send`.
2. **Batching and parallel limits** — at most `maxItemsPerBrief` (default 4)
   inbox items share one session, only when small, same project, owner and
   area (enforced via `task_inbox` plan + brief-field check). Running many
   unrelated sessions in parallel for one request is a discipline rule: plan
   batches first, then dispatch.
3. **Model and effort lock** — each role uses its assigned model; subagents
   default to Sonnet, drop to Haiku for mechanical work, Opus only when the
   task needs it, reason stated in the brief. Discipline rule (model choice
   is outside tool-call hooks, not enforced by the plugin).
4. **No-waiting** — no polling, no sleep loops, background waiters only
   (`maxPollsPerJob`, `maxPollsPerRun`, `maxForegroundSleepSeconds`,
   `minLoopSleepSeconds`, all enforced; see above).
5. **PM intake** — new work is triaged into inbox items with project, scope
   and "done when" before any session is spawned (enforced: `requireBriefFields`,
   `briefMinChars`). Discipline rule: only the coordinator/PM performs
   intake; specialists never invent scope from a partial ask.
6. **Orchestrator-only** — a specialist never takes a new task directly from
   another specialist; every task comes from the coordinator. Discipline
   rule, not enforced by the plugin.
7. **Session hygiene** — reset or end a session once its task is done;
   delete stale sessions; start fresh per new task rather than reusing an
   old one. `requireSpawnForBriefs` enforces "fresh session per task";
   closing/deleting finished sessions is a discipline rule the plugin
   cannot see from a tool call.
8. **Agents coordinate in their topic** — cross-role discussion for a task
   happens in that task's own topic/session, not scattered elsewhere.
   Discipline rule.
9. **Orchestrator decides** — when roles disagree, the orchestrator (or the
   human, if escalated) makes the call; specialists do not override a
   dispatched plan unilaterally. Discipline rule.
10. **Never ask the owner to do tasks, check, test, or follow up** — the
    team carries every task from zero to done itself: run checks, read logs,
    confirm the fix, chase the pipeline. The human is asked only for
    approvals needing their authority (production, money, credentials,
    anything public/external) — never for the team's own verification work.
    Discipline rule.
Gateway restarts: you run inside the OpenClaw gateway. Never stop, restart or kill it
(`systemctl ... openclaw-gateway`, `openclaw gateway stop|restart`, `pkill`); token-guard
blocks it. If a restart is truly needed, run `~/.openclaw/bin/oc-gateway-restart` once as your
last action and end the turn; it restarts safely from outside. All agents are offline for
about 10 minutes afterwards, so batch changes and restart at most once.
<!-- token-guard:end -->
