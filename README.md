# openclaw-token-guard

**Stop OpenClaw agents from burning your Claude / Codex token limits.**

If your OpenClaw agents hit the weekly or 5-hour limit far faster than the work
explains, the cause is usually not the work. It is agents *waiting badly*:
polling a process, `sleep`-looping until CI finishes, re-checking status, or
nudging each other. Every tool call re-sends the whole session, so ten status
checks on a 400k-token session cost about 4M tokens and produce nothing.

Instructions alone do not fix this; agents break rules. This toolkit enforces
them in code, inside the OpenClaw gateway.

## What you get

| Part | What it does |
|---|---|
| `plugin/` (token-guard) | A gateway plugin on `before_tool_call` that **blocks** polling loops, long foreground sleeps, `while … sleep` loops, repeated identical commands and status checks, and runaway runs (checkpoint every 120 tool calls, hard stop at 400). It also makes the coordinator start **every task in a fresh session**: a new brief sent into a specialist's existing chat is refused (use `sessions_spawn`), a brief may hold at most 4 inbox items, only small items of one project and owner may share a session, and forking the coordinator's own history into a child is refused. Fails open: a guard bug never blocks every tool. |
| `bin/oc-wait`, `bin/oc-wait-pipeline` | Background waiters. The agent starts one, ends its turn, and OpenClaw wakes it when the job finishes, at zero token cost while waiting. `oc-wait-pipeline` waits for the GitLab pipeline of an exact commit (`--sha`) and prints failed job logs. |
| `bin/oc-inbox` + `task_inbox` tool | One inbox for many tasks/bugs. Each item has an owner, a size (small, medium, large) and an area; `plan` gives every medium or large item its own session and groups only small items of the same project, owner and area (at most 4 per session). |
| `rules/` | Short AGENTS.md blocks for the coordinator and for specialists, replacing "keep polling until done" style rules. |
| `skills/` | `token-guard` (how to wait) and `task-intake` (how to batch) skills. |
| `install/` | One installer for any host: dry run, backup, apply, verify, rollback, and a remote deploy over SSH. |
| `tools/token-audit.py` | Finds where your tokens went: per-session usage and polling patterns from Claude Code transcripts. |
| `tools/oversized-sessions.py` | Finds sessions that already outgrew their context window and, with `--reset`, backs up and resets them. `verify.sh` fails while any session is past its window. |

The installer also sets a 200k compaction window for Claude Code sessions,
gives compaction 15 minutes instead of OpenClaw's 180-second default, turns on
OpenClaw's loop detection, and can reset group sessions daily, so no session
grows until compaction itself no longer fits.

Why the compaction timeout matters: for a Claude CLI session, OpenClaw compacts
by running `claude --resume <session> /compact` with the session's own model and
thinking level. On a large session with high thinking that can take longer than
180 seconds; OpenClaw then kills it ("CLI exceeded timeout (180s)") after Claude
has already read the whole session, and every retry pays for it again.

## Running a whole team (v2)

Besides the token rules above, the plugin runs an agent team end to end. Every part is code, so agents cannot
skip it, and none of it calls a model unless something needs a decision:

| Part | What it does |
|---|---|
| `policy.js` | Rules on every tool call: protected files and config, no back channels, only the orchestrator dispatches and it does no specialist work, no model pins, git safety (no `--no-verify`, no pushes to main), one request = one board item, briefs completed from their board items, usage limits respected (a task waits for the reset; Codex only if you turn it on), no dispatch during a gateway restart, budgets: a task may make `jobs.budgetCalls` tool calls (100) and one orchestrator run `orchestratorMaxCallsPerRun` (60). |
| `board.js`, `bin/oc-inbox` | The task board: Backlog, To do, In progress, Review, QA, Done, Archived (plus Blocked and Dropped). A task's end moves its items by the worker's RESULT line; archiving needs the orchestrator's and the owner's approval. |
| `jobs.js`, `triage.js` | Follows every task to its end: unanswered results, silent tasks, restarts and lost end events. Every 10 minutes, when something needs a decision, a cheap model call (no tools) decides whether to wake the orchestrator and at what effort; a board state it already woke the orchestrator for does not wake it again for `triage.sameStateRewakeMinutes` (180). |
| `skills.js` | Names, in every brief, the skills of that agent that fit the task (matched against each skill's own description). |
| `voice.js`, `mirror.js` | Writes the team's Telegram threads: request, dispatch, "on it", result (summary first, details folded), the orchestrator's answer, approval asks, all as replies with @mentions. |
| `index.js` | Wires it into OpenClaw's hooks. |

Configure it under `plugins.entries.token-guard.config` (see `plugin/openclaw.plugin.json`); a team repo can
generate that config (`ownerId`, `projects`, `topics`, `mirror`, `jobs`, `triage`, `skills`).

## One task, one fresh session

Every model call re-reads the whole session, so a chat that collects task
after task gets more expensive with every call (on one server, two devops
chats that received 74 and 88 tasks used over 1B tokens in a week). With
token-guard the coordinator:

1. records each problem in the inbox with an owner, a size and an area,
2. runs `task_inbox plan`, which splits the work into sessions, and
3. starts each batch with `sessions_spawn` (`agentId`, `context: "isolated"`).

Three problems in one Telegram message ("login button grey on mobile", "footer
typo", "deploy the pricing page") become two sessions: the two small web UI
fixes share one, the deploy gets its own. The specialist's result returns to
the coordinator by itself, so nobody polls.

## When a usage limit is hit

By default nothing switches provider. When Claude reports its usage limit, the guard records the reset time,
refuses new dispatches until then (they would fail at once), spends no wakes or triage calls, and moves items
that were blocked only by the limit back to To do once it has reset. The orchestrator is told the reset time in
the System topic. While the limit lasts, each chat and topic gets OpenClaw's limit error once, not once per
message.

**Budgets count tool calls.** The Claude CLI reports almost no token usage to plugins (a task that processed 6.4M
tokens showed up as under 0.1M), so `jobs.budgetTokens` alone never stops a task. Every tool call does reach the
guard, and each one re-reads the whole context, so the budgets count calls: `jobs.budgetCalls` per task (then it
may only write its final answer) and `orchestratorMaxCallsPerRun` per orchestrator run (then it may only message).

**Optional: a second provider.** To let new tasks run on Codex while Claude is limited, set
`spawn.codexModel` (e.g. `"openai/gpt-6-astra"`) and add that model to `spawn.allowedModels`. A Codex limit is
then routed back to `spawn.claudeFallbackModel`, and a dispatch waits only when both are limited.
`apply.sh --fallback-model=openai/gpt-6-astra` also adds the model to OpenClaw's own fallback lists (default
model, sub-agent model, every agent's model); `verify.sh` lists the models without one.

That fallback needs a credential in OpenClaw's own auth store (a Codex CLI login in `~/.codex` is not used by
agent-scoped Codex runs). Sign in once and let every agent inherit it:

```bash
openclaw config set agents.defaults.authInheritance.agentId '"coordinator"' --strict-json
openclaw models auth login --provider openai --method device-code --profile-id openai:default --agent coordinator
```

Avoid `plugins.entries.codex.config.appServer.homeScope: "user"` on a gateway
with many agents: on our 11-agent server it made agent runtime preparation time
out, so no session could start.

## Requirements

- OpenClaw **2026.10.5** or newer (gateway running)
- Python 3, and Node 20+ on `PATH` for the plugin tests (`install/` finds OpenClaw's bundled Node by itself)
- Linux (tested on Ubuntu). The scripts use GNU tools; macOS is untested.

## Install

```bash
git clone https://github.com/farhadjafari385/openclaw-token-guard.git
cd openclaw-token-guard

tests/run-all.sh                         # unit tests: plugin + scripts
install/apply.sh --dry-run               # show every change, write nothing
install/apply.sh --patch-legacy          # back up, then apply
install/verify.sh                        # PASS/FAIL checklist
```

On a server, from your machine:

```bash
install/remote.sh myserver --patch-legacy   # copy, test, apply, verify over SSH
```

Useful options for `apply.sh`: `--coordinator=ID` (your orchestrator agent id),
`--context-tokens=N`, `--compaction-timeout=S`, `--daily-reset-hour=H`,
`--fallback-model=P/M`, `--install-skills`, `--skip-plugin`, `--skip-config`. The script never restarts the gateway; if the
plugin does not load, restart it once yourself.

Undo everything:

```bash
install/rollback.sh <backup-dir printed by apply.sh>
```

## Proving it works without spending tokens

`tests/live-gateway-test.sh` starts a throwaway gateway (own temp folder and
port), loads the guard, and fires real tool calls at it over HTTP to confirm the
blocks happen inside OpenClaw. No model is called.

## Tuning

Set limits under `plugins.entries.token-guard.config` in `openclaw.json`
(see `plugin/openclaw.plugin.json` for every key). Use `"mode": "warn"` to log
what would be blocked before enforcing.

## If a session is already over its window

When a session is past its context window, it rarely recovers on its own:
compacting it means sending the whole oversized session to the model, which is
slow, costly and can time out, and every "compact" or "fix yourself" message
burns another full-size run. Do not ask the agent to fix it. Send `/new` in that
chat, or reset every such session at once (agent databases are backed up first,
old transcripts are kept):

```bash
tools/oversized-sessions.py                         # report sessions at >= 80% of their window
tools/oversized-sessions.py --threshold 1.0 --reset # back up, then reset the ones past it
```

Lowering `contextTokens` only applies to new runs: a session that already grew
past the new cap under the old 1M window stays oversized. Run
`oversized-sessions.py` right after installing.

A reset keeps the session id and the old transcript, and appends a reset
marker: the next turn starts a fresh Claude CLI session with no earlier
history, so the context starts near zero.

## License

MIT
