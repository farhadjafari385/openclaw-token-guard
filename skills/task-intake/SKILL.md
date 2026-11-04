---
name: task-intake
description: Collect many tasks or bugs into one inbox, plan them into sessions (one per real task, small related items together), and start each batch in a fresh session; use when a human sends one or several requests.
---

# One box, then a plan, then batches

Sending every request straight to a specialist makes each one extend a long
session that is re-read on every tool call, and mixes projects in one context.
Collect first, plan once, dispatch batches.

## Procedure

1. **Collect.** Split the human's message into distinct problems and record
   each with the `task_inbox` tool (action `add`: project, title, owner, size
   small|medium|large, area, type bug|task|feature|question, priority
   low|normal|high|urgent, details, done_when, source), or
   `~/.openclaw/bin/oc-inbox add ...` where exec is available. Merge the
   duplicates the inbox warns about.
   - `small`: one quick change in one place. `medium`: a normal task.
     `large`: several files, a feature, a migration, CI or deploy waits.
   - `area`: the part of the project it touches ("login page", "CI").
2. **Acknowledge** with the inbox ids. Ask the human once, in one message, for
   every missing project, path, expected behaviour or "done when". Never guess.
3. **Plan** with the `task_inbox` tool (action `plan`). Every medium or large
   item gets its own session; small items with the same project, owner and
   area share one (at most 4). Items flagged NEEDS INFO wait for the answer.
4. **Dispatch** each batch into a fresh session with `sessions_spawn`
   (`agentId` = owner, `context: "isolated"`, `label` = "<project>: <title>",
   `runTimeoutSeconds: 3600` for builds, deploys and CI waits). Never send a
   new brief into an existing chat. Brief format:

   ```
   Project: <name>, <path>
   Scope: <files/areas in>; out of scope: <...>
   Items: <inbox id> <one line>, ...
   Done when: <exact checks/tests that must pass>
   Stop if: <what needs the human>
   ```

5. **Track.** `task_inbox` action `set` with status dispatched, done or blocked.
   End your turn after dispatching: each child's result comes back by itself.
   Follow-ups to a running batch go to its `childSessionKey` with `sessions_send`.
6. **Report** once per batch to the human: what was done, checks that passed,
   what is blocked and why.

## Example

"The login button is grey on mobile, the footer has a typo, and deploy the
new pricing page to production" becomes three inbox items:

| Item | Owner | Size | Area | Session |
|---|---|---|---|---|
| Login button grey on mobile | writer | small | web UI | B1 (shared) |
| Footer typo | writer | small | web UI | B1 (shared) |
| Deploy pricing page | devops | large | deploy | B2 (own) |

Two fresh sessions, not one big one and not three.

## Why it saves tokens

- A fresh session per batch keeps every call small: no earlier task's history
  is re-read.
- Small related items share one session, so their code is read once.
- Clear "Done when" lines stop guessing, rework and back-and-forth.
