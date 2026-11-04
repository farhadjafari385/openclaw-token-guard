<!-- token-guard:begin -->
## Token guard: intake, sessions and dispatch (the human's firm rule; enforced by the token-guard plugin)

Tokens are the scarcest resource. Every model call re-reads its whole session,
so a session holding many tasks gets more expensive with every call. One task
gets one fresh, small session; only small related items share one.

Intake, one box for everything:
1. Split every human message into its distinct problems and record each with
   the `task_inbox` tool (action `add`): project, title, owner (the specialist
   agent id), size, area, type, priority, details, done_when, source.
   - size `small`: one quick change in one place (a typo, a config value, one
     small bug). `medium`: a normal task. `large`: several files, a feature, a
     migration, or anything that waits on CI or a deploy.
   - area: the part of the project it touches ("login page", "CI", "API").
   The inbox warns about duplicates: merge them instead of adding twice.
2. Acknowledge with the inbox ids. If a project, path, expected behaviour or
   "done when" is missing, ask the human once, in one message, for all of
   them. Never guess. If the human says more is coming, collect until "go".

Plan:
3. `task_inbox` action `plan` turns the open items into sessions: every
   medium or large item gets its own; small items with the same project,
   owner and area share one (at most 4). Follow the plan; never merge batches.

Dispatch, one fresh session per batch:
4. Start each batch with `sessions_spawn`: `agentId` = the owner,
   `context: "isolated"`, `label` = "<project>: <short title>", `task` = the
   brief, plus `runTimeoutSeconds: 3600` when it builds, deploys or waits on CI.
   Never put a new brief into a specialist's existing chat with
   `sessions_send`: token-guard blocks it. `sessions_send` is only for a short
   follow-up (an answer, a correction) to that batch's own `childSessionKey`.
5. Every brief needs these lines, or token-guard blocks it: `Project:` (name,
   path), `Scope:` (in and out), `Items:` (inbox ids, one per line), `Done when:`
   (exact checks or tests), `Stop if:` (what needs the human).
6. After dispatching, end your turn. Each child's result comes back to you by
   itself; never poll it. Check a silent child at most once, after 30 minutes.
7. "Done" means the checks passed; "waiting on X" is progress, not done. Keep
   the inbox current (`task_inbox` action `set`: dispatched, done or blocked)
   and report to the human once per batch: done, checks passed, blocked and why.
8. The same waiting rules apply to you: no polling, no sleep loops.
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
