// Mode "safety" (owner 2026-11-22: "I don't want a babysitter for 11 senior agents").
//
// In this mode the guard stops only what can hurt the owner or break the team's structure: secrets, the gateway,
// access tokens, protected rules and config, git history, real usage limits, a restart in progress, and who does what
// (the orchestrator dispatches, a worker works). Every other rule (queues, budgets, brief format, waiting, polling,
// models, topics) is off: `on(rule)` is false for it, so its check never fires and the agents decide.
//
// Measured 2026-11-20..22: of 971 dispatches 270 started; about 580 of the refusals were the guard's own process rules.

const SAFETY_RULES = new Set([
  // secrets (secrets.js enforces all of its rules in every mode)
  "secretRead", "secretInPush", "secretInFile", "secretInCommand", "secretOutbound",
  // the gateway, the host and access
  "gatewayControl", "tokenRotate", "vmOnHost", "protectedFile", "protectedConfig", "backChannel", "modelPin", "spawnRuntime",
  // git history and main
  "gitSafety",
  // what really cannot run now: a usage limit, the weekly reserve, a restart, a task at its time limit
  "claudeLimited", "bothLimited", "weeklyPace", "maintenance", "taskTime",
  // who does what
  "orchestratorOnly", "subagentsOff", "spawnByWorker", "sendByWorker", "sendToStandingChat", "sendToSpent",
  // the board is the record: a task has an item, a real project, and only checked work is approved
  "boardItems", "unknownProject", "boardApproval", "userPathProof",
  // the same call or the same message again and again
  "retryBlocked", "repeatMessage",
  // fuses against a runaway (owner 2026-11-22: "no loop wasting, no call wasting"): set far above normal work, they end
  // a task or an orchestrator run that will not stop, and a third try on an item whose last tries moved nothing
  // (2026-11: one woken run made 617 Opus calls in six hours; items past 10 tasks took half of all tasks)
  "taskBudget", "runBudget", "loopBreak",
]);

// Does this rule stop a call in this mode? warn: never; safety: only the rules above; otherwise always.
function enforces(mode, rule) {
  if (mode === "warn") return false;
  if (mode === "safety") return SAFETY_RULES.has(rule);
  return true;
}

// Is this rule's check evaluated at all? Only safety mode switches checks off; warn still evaluates and logs them.
function ruleOn(mode, rule) {
  return mode !== "safety" || SAFETY_RULES.has(rule);
}

export { SAFETY_RULES, enforces, ruleOn };
