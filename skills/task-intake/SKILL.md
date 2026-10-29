---
name: task-intake
description: Collect many tasks or bugs into one inbox, plan batches per project, and dispatch one clear brief per batch; use when a human sends several requests.
---

# One box, then a plan, then batches

Sending every request straight to a specialist makes each one extend a long
session that is re-read on every tool call, and mixes projects in one context.
Collect first, plan once, dispatch batches.

## Procedure

1. **Collect.** Record each distinct task or bug with the `task_inbox` tool
   (action `add`: project, title, type bug|task|feature|question, priority
   low|normal|high|urgent, details, done_when, source), or
   `~/.openclaw/bin/oc-inbox add ...` where exec is available. Merge the
   duplicates the inbox warns about.
2. **Acknowledge** with the inbox ids. Ask the human once, in one message, for
   every missing project, path, expected behaviour or "done when". Never guess.
3. **Plan** with the `task_inbox` tool (action `plan`): one batch per project and
   owner, highest priority first. Items flagged NEEDS INFO stay out of batches
   until answered.
4. **Dispatch** one brief per batch to one specialist. Reset the specialist's
   session first if it holds an earlier finished batch and the `sessions` tool
   offers `reset`. Brief format:

   ```
   Project: <name>, <path>, topic <id>
   Scope: <files/areas in>; out of scope: <...>
   Items: <inbox id> <one line>, ...
   Done when: <exact checks/tests that must pass>
   Stop if: <what needs the human>
   ```

5. **Track.** `task_inbox` action `set` with status dispatched, done or blocked. No
   status nudges: a worker that posted "Waiting on X" is woken by its waiter.
6. **Report** once per batch to the human: what was done, checks that passed,
   what is blocked and why.

## Why it saves tokens

- Related items share one session, so code and context are read once.
- A fresh session per batch keeps every call small.
- Clear "Done when" lines stop guessing, rework and back-and-forth.
