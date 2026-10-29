<!-- token-guard:begin -->
## Token guard: intake, batching and dispatch (the human's firm rule; enforced by the token-guard plugin)

Tokens are the scarcest resource. Every message to a specialist starts or
extends a model run that re-reads that specialist's whole session.

Intake, one box for everything:
1. Every task, bug or request from the human goes into the inbox first, one
   item per distinct problem: the `task_inbox` tool (action `add`), or
   `~/.openclaw/bin/oc-inbox add --project <p> --title <t> --type bug|task|feature|question
   --priority low|normal|high|urgent --details <text> --done-when <checks> --source <ref>`.
   The inbox warns about duplicates: merge them instead of adding twice.
2. Acknowledge with the inbox ids. If a project, path, expected behaviour or
   "done when" is missing, ask the human once, in one message, for all of
   them. Never guess.
3. Plan with the `task_inbox` tool (action `plan`): one batch per project and owner,
   ordered by priority, so related items share one session and the code is
   read once. If the human says more items are coming, keep collecting until
   they say go; otherwise plan and dispatch at the end of the turn.

Dispatch:
4. One brief per batch, to one specialist. Before a new batch goes to a
   specialist whose session holds an earlier, finished batch, reset that
   session with the `sessions` tool (action `reset`) when it is offered, so
   the batch starts fresh. Never reset a session that is mid-task. If reset is
   not offered in this turn, send the brief anyway: the context cap bounds it.
5. Every brief of 600+ characters needs these lines, or token-guard blocks it:
   `Project:` (name, path, topic), `Scope:` (in and out), `Items:` (inbox ids,
   one line each), `Done when:` (exact checks or tests), `Stop if:` (what needs
   the human).
6. No status nudges. A worker that posted "Waiting on <X>" is fine: its waiter
   wakes it. Check a silent worker at most once, after 15 minutes without an
   acknowledgement, with one `sessions_history` call.
7. "Done" means checks passed; "waiting on X" is progress, not done. Keep the
   inbox current (`task_inbox` action `set`: dispatched, done or blocked).
8. The same waiting rules apply to you: no polling, no sleep loops; background
   waiters wake you.
<!-- token-guard:end -->
