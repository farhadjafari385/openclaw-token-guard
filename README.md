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
| `plugin/` (token-guard) | A gateway plugin on `before_tool_call` that **blocks** polling loops, long foreground sleeps, `while … sleep` loops, repeated identical commands and status checks, and runaway runs (checkpoint every 120 tool calls, hard stop at 400). Fails open: a guard bug never blocks every tool. |
| `bin/oc-wait`, `bin/oc-wait-pipeline` | Background waiters. The agent starts one, ends its turn, and OpenClaw wakes it when the job finishes, at zero token cost while waiting. `oc-wait-pipeline` waits for the GitLab pipeline of an exact commit (`--sha`) and prints failed job logs. |
| `bin/oc-inbox` + `task_inbox` tool | One inbox for many tasks/bugs: collect, plan one batch per project, dispatch one complete brief per batch, instead of firing each request at an agent separately. |
| `rules/` | Short AGENTS.md blocks for the coordinator and for specialists, replacing "keep polling until done" style rules. |
| `skills/` | `token-guard` (how to wait) and `task-intake` (how to batch) skills. |
| `install/` | One installer for any host: dry run, backup, apply, verify, rollback, and a remote deploy over SSH. |
| `tools/token-audit.py` | Finds where your tokens went: per-session usage and polling patterns from Claude Code transcripts. |
| `tools/oversized-sessions.py` | Finds sessions that already outgrew their context window and, with `--reset`, backs up and resets them. `verify.sh` fails while any session is past its window. |

The installer also sets a 200k compaction window for Claude Code sessions,
turns on OpenClaw's loop detection, and can reset group sessions daily, so no
session grows until compaction itself no longer fits.

## Requirements

- OpenClaw **2026.10.5** or newer (gateway running)
- Python 3, and Node 20+ on `PATH` for the plugin tests (`install/` finds OpenClaw's bundled Node by itself)
- Linux (tested on Ubuntu). The scripts use GNU tools; macOS is untested.

## Install

```bash
git clone https://github.com/<you>/openclaw-token-guard.git
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
`--context-tokens=N`, `--daily-reset-hour=H`, `--install-skills`,
`--skip-plugin`, `--skip-config`. The script never restarts the gateway; if the
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
