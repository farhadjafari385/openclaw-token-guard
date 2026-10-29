// Pure, unit-testable decision logic for token-guard. No OpenClaw imports here.
//
// decide(event, ctx, state, config, log) is called from a before_tool_call hook
// and returns undefined (allow), { params } (rewrite) or { block, blockReason }.

const DEFAULT_CONFIG = {
  enabled: true,
  mode: "enforce", // "enforce" | "warn" (warn logs only, never blocks or rewrites)
  maxPollsPerJob: 2,
  maxPollsPerRun: 4,
  subagentMaxPollsPerRun: 40,
  maxForegroundSleepSeconds: 20,
  maxBackgroundSleepSeconds: 60,
  minLoopSleepSeconds: 5,
  maxRepeatCommand: 4,
  maxRepeatMessage: 3,
  checkpointEvery: 120, // 0 disables; never applies to subagents
  maxToolCallsPerRun: 400,
  maxStatusChecksPerRun: 12,
  statusExemptSessionPatterns: [":cron:"],
  briefMinChars: 600,
  requireBriefFields: ["Project:", "Items:", "Done when:"],
  briefCheckAgents: ["coordinator"], // [] = every agent
  exemptSessionPatterns: [],
  runIdleResetMs: 120000, // runs without a runId: start a fresh count after this gap
  ttlMs: 6 * 60 * 60 * 1000,
  maxTrackedRuns: 5000,
};

const STATUS_TOOLS = new Set(["sessions_history", "sessions_list", "session_status"]);
const NON_PROGRESS_TOOLS = new Set(["exec", "process", "message", ...STATUS_TOOLS]);
const WAITERS = new Set(["oc-wait", "oc-wait-pipeline"]);
const WRAPPERS = new Set(["nohup", "exec", "env", "command", "builtin", "nice", "setsid", "stdbuf"]);
const INTERPRETERS = /^(python[0-9.]*|bash|sh)$/;

function mergeConfig(cfg) {
  const merged = Object.assign({}, DEFAULT_CONFIG);
  for (const [key, value] of Object.entries(cfg || {})) {
    if (value !== undefined && value !== null && key in DEFAULT_CONFIG) merged[key] = value;
  }
  return merged;
}

function matchesAny(value, patterns) {
  if (typeof value !== "string" || !Array.isArray(patterns)) return false;
  return patterns.some((p) => typeof p === "string" && p !== "" && value.includes(p));
}

function isSubagentSession(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.includes(":subagent:");
}

// ---- command analysis ----

function parseDurationSeconds(tok) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(String(tok).trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === "m") return n * 60;
  if (unit === "h") return n * 3600;
  if (unit === "d") return n * 86400;
  return n;
}

const SHELL_HEADS = /^(bash|sh|zsh|dash|ssh)$/;
const PYTHON_HEADS = /^python[0-9.]*$/;

// Blank out quoted strings so their contents are not read as commands.
function stripQuoted(text) {
  return String(text).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
}

// Code passed in quotes to an interpreter: `bash -c '...'`, `ssh host '...'`,
// `python3 -c '...'`.
function quotedCode(text) {
  const shell = [];
  const python = [];
  const re = /(?:^|[\s;&|(])((?:\S*\/)?(?:bash|sh|zsh|dash|ssh|python[0-9.]*))\b([^'"\n;&|]*?)(['"])((?:(?!\3)[\s\S])*)\3/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const head = baseName(m[1]);
    const flags = m[2];
    if (PYTHON_HEADS.test(head)) {
      if (/(^|\s)-c\s*$/.test(flags)) python.push(m[4]);
    } else if (head === "ssh" || /(^|\s)-[a-z]*c\s*$/.test(flags)) {
      shell.push(m[4]);
    }
  }
  return { shell, python };
}

// The parts of a command that run. Heredoc bodies fed to programs that only
// store or print them (cat > file, tee) are data and are dropped; bodies fed
// to an interpreter stay, as shell or python. Quoted strings are blanked, but
// code quoted for an interpreter (bash -c, ssh, python -c) is kept.
function executableParts(command) {
  const shellLines = [];
  const python = [];
  const extraShell = [];
  const lines = String(command).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    shellLines.push(m ? line.slice(0, m.index) : line);
    if (!m) continue;
    const delimiter = m[2];
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== delimiter) body.push(lines[j++]);
    i = j;
    const before = rawSegments(stripQuoted(line.slice(0, m.index)));
    const head = headOf(before[before.length - 1] || "");
    if (PYTHON_HEADS.test(head)) python.push(body.join("\n"));
    else if (SHELL_HEADS.test(head)) extraShell.push(body.join("\n"));
  }
  const outer = shellLines.join("\n");
  const quoted = quotedCode(outer);
  const shell = [stripQuoted(outer), ...extraShell, ...quoted.shell.map(stripQuoted)].join("\n");
  return { shell, python: [...python, ...quoted.python].join("\n") };
}

function rawSegments(shellText) {
  return String(shellText).split(/&&|\|\||[;|&\n]/);
}

// Simple commands: split on ; && || | & and newlines, dropping leading shell
// keywords (do, then, else) so `do sleep 5` yields `sleep 5`.
function segments(shellText) {
  return rawSegments(shellText).map((s) => s.trim().replace(/^(?:(?:do|then|else|elif|time|!)\s+)+/, ""));
}

function headWords(segment) {
  const words = String(segment).trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^[({]+/, ""));
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) { i += 1; continue; }
    if (w === "timeout") { i += 1; while (i < words.length && words[i].startsWith("-")) i += 1; i += 1; continue; }
    break;
  }
  return words.slice(i);
}

function baseName(word) {
  return String(word || "").replace(/^["']|["']$/g, "").split("/").pop();
}

function headOf(segment) {
  return baseName(headWords(segment)[0]);
}

// Python statements the command runs (python heredocs and `python -c` code),
// one per line or `;`. Only statements count, so code that merely mentions
// time.sleep inside a quoted string on the same line does not.
function pythonStatements(python) {
  return String(python).split(/\n|;/).map((s) => s.trim()).filter(Boolean);
}

const PY_SLEEP = /^(?:time\.)?sleep\(\s*(\d+(?:\.\d+)?)\s*\)/;

// Seconds of sleep the command itself will spend: `sleep N` run as a command,
// and Python time.sleep(N) in `python -c` code or a python heredoc.
function totalSleepSeconds(command) {
  if (typeof command !== "string") return 0;
  const { shell, python } = executableParts(command);
  let total = 0;
  for (const segment of segments(shell)) {
    const words = headWords(segment);
    if (baseName(words[0]) !== "sleep") continue;
    for (const w of words.slice(1)) {
      if (/^\d/.test(w)) total += parseDurationSeconds(w.replace(/[)}]+$/, ""));
    }
  }
  for (const statement of pythonStatements(python)) {
    const m = PY_SLEEP.exec(statement.replace(/^while\b[^:]*:\s*/, ""));
    if (m) total += parseFloat(m[1]);
  }
  return total;
}

// First program of each simple command, skipping VAR=value assignments,
// wrappers like nohup/env and `timeout N`. For `python3 script` / `bash script`
// the script's basename is returned too.
function commandHeads(command) {
  if (typeof command !== "string") return [];
  const heads = [];
  for (const segment of segments(executableParts(command).shell)) {
    const words = headWords(segment);
    if (!words.length) continue;
    const head = baseName(words[0]);
    heads.push(head);
    if (INTERPRETERS.test(head) && words[1] && !words[1].startsWith("-")) heads.push(baseName(words[1]));
  }
  return heads;
}

function invokesWaiter(command) {
  return commandHeads(command).some((h) => WAITERS.has(h));
}

// A waiting loop the command runs: shell while/until ... sleep ... done, a
// for-loop that sleeps at least minLoopSleepSeconds per pass, a Python
// while-loop with time.sleep, or the `watch` program. Scripts only written to
// a file (cat > x.sh <<EOF ...) do not run, so they do not count.
function hasSleepLoop(command, minLoopSleepSeconds = DEFAULT_CONFIG.minLoopSleepSeconds) {
  if (typeof command !== "string") return false;
  const { shell, python } = executableParts(command);
  // Walk simple commands, tracking open loops by their keywords.
  const open = [];
  for (const segment of segments(shell)) {
    const first = segment.split(/\s+/)[0].replace(/[)}]+$/, "");
    if (first === "while" || first === "until") open.push({ kind: "while", sleep: 0 });
    else if (first === "for" || first === "select") open.push({ kind: "for", sleep: 0 });
    if (open.length && headOf(segment) === "sleep") {
      const seconds = totalSleepSeconds(segment);
      if (open.some((loop) => loop.kind === "while")) return true;
      for (const loop of open) loop.sleep += seconds;
    }
    if (first === "done") {
      const loop = open.pop();
      if (loop && loop.kind === "for" && loop.sleep >= minLoopSleepSeconds) return true;
    }
  }
  const statements = pythonStatements(python);
  const loopAt = statements.findIndex((s) => /^while\b.*:/.test(s));
  if (loopAt >= 0) {
    const inlineSleep = PY_SLEEP.test(statements[loopAt].replace(/^while\b[^:]*:\s*/, ""));
    if (inlineSleep || statements.slice(loopAt + 1).some((s) => PY_SLEEP.test(s))) return true;
  }
  return commandHeads(command).includes("watch");
}

function normaliseText(text) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/g, " ");
}
const normaliseCommand = normaliseText;

function isProgressTool(toolName) {
  return !NON_PROGRESS_TOOLS.has(toolName);
}

const WAIT_HOWTO =
  "Start ONE waiter as an exec call with background: true " +
  "(`~/.openclaw/bin/oc-wait --every 30 --timeout 2h -- <command that exits 0 when done>`, " +
  "or `~/.openclaw/bin/oc-wait-pipeline --project <id> --pipeline <id>` for GitLab), " +
  'post "Waiting on <what>", then end your turn: you are woken automatically with the result.';
const SUBAGENT_WAIT_HOWTO =
  "A subagent gets no automatic wake: keep waits short, or report \"Waiting on <what>\" to your parent and end.";

function waitRemedy(what, subagent) {
  return `token-guard: blocked ${what}. Polling and sleeping re-send the whole session on every call. ` +
    (subagent ? SUBAGENT_WAIT_HOWTO : WAIT_HOWTO);
}

function pollRemedy(what, subagent) {
  if (subagent) {
    return `token-guard: blocked ${what}: this subagent run used its polling budget. ` +
      'Report "Waiting on <what>" to your parent and end.';
  }
  return `token-guard: blocked ${what}. A background exec job wakes this session automatically when it exits: ` +
    'post "Waiting on <what>" and end your turn now. For remote work (CI, deploys) start a background ' +
    "`~/.openclaw/bin/oc-wait` or `oc-wait-pipeline` waiter first.";
}

// ---- state ----

function createState() {
  return { runs: new Map(), blocks: new Map() };
}

function newRunState(now) {
  return {
    lastSeen: now,
    toolCalls: 0,
    sinceCheckpoint: 0,
    statusChecks: 0,
    pollTotal: 0,
    pollByJob: new Map(),
    commandCounts: new Map(),
    messageCounts: new Map(),
  };
}

function cleanupState(state, now, ttlMs, maxTrackedRuns) {
  for (const [key, run] of state.runs) {
    if (now - run.lastSeen > ttlMs) state.runs.delete(key);
  }
  if (state.runs.size > maxTrackedRuns) {
    const entries = Array.from(state.runs.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < entries.length - maxTrackedRuns; i++) state.runs.delete(entries[i][0]);
  }
}

function runKeyFor(event, ctx) {
  const runId = (ctx && ctx.runId) || (event && event.runId);
  if (runId) return { key: `run:${runId}`, hasRunId: true };
  const sessionKey = (ctx && ctx.sessionKey) || "unknown";
  return { key: `session:${sessionKey}`, hasRunId: false };
}

function getRun(state, event, ctx, now, cfg) {
  const { key, hasRunId } = runKeyFor(event, ctx);
  let run = state.runs.get(key);
  if (run && !hasRunId && now - run.lastSeen > cfg.runIdleResetMs) run = undefined;
  if (!run) {
    run = newRunState(now);
    state.runs.set(key, run);
  }
  run.lastSeen = now;
  return run;
}

function endRun(state, event, ctx) {
  state.runs.delete(runKeyFor(event, ctx).key);
}

// ---- decision ----

function decide(event, ctx, state, rawConfig, log, now = Date.now()) {
  const cfg = mergeConfig(rawConfig);
  if (!cfg.enabled || !event) return undefined;

  const sessionKey = (ctx && ctx.sessionKey) || "";
  const agentId = (ctx && ctx.agentId) || "";
  if (matchesAny(sessionKey, cfg.exemptSessionPatterns)) return undefined;

  const run = getRun(state, event, ctx, now, cfg);
  cleanupState(state, now, cfg.ttlMs, cfg.maxTrackedRuns);
  const toolName = event.toolName;
  const params = event.params && typeof event.params === "object" ? event.params : {};
  const subagent = isSubagentSession(sessionKey);
  const enforce = cfg.mode !== "warn";

  const block = (rule, reason) => {
    state.blocks.set(rule, (state.blocks.get(rule) || 0) + 1);
    if (typeof log === "function") {
      log(enforce ? "warn" : "info", `token-guard ${enforce ? "blocked" : "would block"} ${toolName} (${rule})`, {
        rule, agentId, sessionKey, toolName,
      });
    }
    return enforce ? { block: true, blockReason: reason } : undefined;
  };

  // Per-run budget. `message` stays available so the agent can always report.
  run.toolCalls += 1;
  if (toolName === "message") {
    run.sinceCheckpoint = 0;
  } else {
    run.sinceCheckpoint += 1;
    if (run.toolCalls > cfg.maxToolCallsPerRun) {
      return block("maxToolCallsPerRun",
        `token-guard: this run used its budget of ${cfg.maxToolCallsPerRun} tool calls. ` +
        (subagent ? "End now with a short report of what is done and what remains."
          : "Post a short status with the message tool (done, remaining, next step) and end your turn; the work continues in a fresh run."));
    }
    if (!subagent && cfg.checkpointEvery > 0 && run.sinceCheckpoint > cfg.checkpointEvery) {
      run.sinceCheckpoint = 0;
      return block("checkpoint",
        `token-guard: checkpoint after ${cfg.checkpointEvery} tool calls. Post a one-line progress update ` +
        "with the message tool, then continue. If you are repeating yourself or waiting, stop and use a background waiter instead.");
    }
  }

  // Status checks of other sessions.
  if (STATUS_TOOLS.has(toolName) && !matchesAny(sessionKey, cfg.statusExemptSessionPatterns)) {
    run.statusChecks += 1;
    if (run.statusChecks > cfg.maxStatusChecksPerRun) {
      return block("maxStatusChecksPerRun",
        `token-guard: more than ${cfg.maxStatusChecksPerRun} session status checks in one run. ` +
        "Do not chase workers: a waiting worker is woken by its waiter. Act on what you know, or end your turn.");
    }
  }

  // Polling background processes.
  if (toolName === "process") {
    const action = params.action;
    if (action === "poll" || action === "log" || action === "list") {
      run.pollTotal += 1;
      const maxRun = subagent ? cfg.subagentMaxPollsPerRun : cfg.maxPollsPerRun;
      if (run.pollTotal > maxRun) return block("maxPollsPerRun", pollRemedy(`process ${action} #${run.pollTotal} in this run`, subagent));
      if (!subagent && action !== "list") {
        const job = String(params.sessionId || "unknown");
        const count = (run.pollByJob.get(job) || 0) + 1;
        run.pollByJob.set(job, count);
        if (count > cfg.maxPollsPerJob) return block("maxPollsPerJob", pollRemedy(`check #${count} of job ${job}`, subagent));
      }
    }
    return undefined;
  }

  if (toolName === "exec") {
    const command = typeof params.command === "string" ? params.command : "";
    const background = params.background === true;
    const awaitResults = params.awaitResults === true;

    if (invokesWaiter(command)) {
      if (!subagent && !background && !awaitResults && enforce) {
        if (typeof log === "function") log("info", "token-guard moved a waiter to the background", { agentId, sessionKey });
        return { params: Object.assign({}, params, { background: true }) };
      }
      return undefined;
    }

    const sleepSeconds = totalSleepSeconds(command);
    if (!background && !awaitResults) {
      if (sleepSeconds >= cfg.maxForegroundSleepSeconds) {
        return block("foregroundSleep", waitRemedy(`a foreground sleep of ${sleepSeconds}s`, subagent));
      }
      if (hasSleepLoop(command, cfg.minLoopSleepSeconds)) {
        return block("sleepLoop", waitRemedy("a sleep/watch loop", subagent));
      }
    } else if (background && !subagent && sleepSeconds >= cfg.maxBackgroundSleepSeconds) {
      return block("backgroundSleep",
        `token-guard: blocked a background sleep of ${sleepSeconds}s: every timed wake re-reads the whole session. ` +
        "Run `~/.openclaw/bin/oc-wait --every 30 --timeout 2h -- <command that exits 0 when done>` in the background instead; it wakes you once, when the condition is met.");
    }

    const norm = normaliseCommand(command);
    if (norm) {
      const count = (run.commandCounts.get(norm) || 0) + 1;
      run.commandCounts.set(norm, count);
      if (count >= cfg.maxRepeatCommand) {
        return block("repeatCommand",
          `token-guard: blocked: the same command ran ${count} times in this run with no progress in between. ` +
          (subagent ? SUBAGENT_WAIT_HOWTO : WAIT_HOWTO));
      }
    }
    return undefined;
  }

  if (toolName === "message") {
    const text = normaliseText(params.message || params.text || "");
    if (text) {
      const count = (run.messageCounts.get(text) || 0) + 1;
      run.messageCounts.set(text, count);
      if (count >= cfg.maxRepeatMessage) {
        return block("repeatMessage",
          `token-guard: this exact message was already posted ${count - 1} times in this run. ` +
          "Post only new information, or end your turn.");
      }
    }
    return undefined;
  }

  // Anything else is progress: reset the repeat counters.
  if (isProgressTool(toolName)) {
    run.commandCounts.clear();
  }

  if (toolName === "sessions_send") {
    const agents = Array.isArray(cfg.briefCheckAgents) ? cfg.briefCheckAgents : [];
    const checked = agents.length === 0 || agents.includes(agentId);
    const message = typeof params.message === "string" ? params.message : "";
    if (checked && message.length >= cfg.briefMinChars) {
      const lines = message.split("\n").map((line) => line.replace(/^[\s>*#_\-]+/, "").toLowerCase());
      const missing = cfg.requireBriefFields.filter((field) => !lines.some((line) => line.startsWith(String(field).toLowerCase())));
      if (missing.length > 0) {
        return block("briefFields",
          `token-guard: this brief is missing ${missing.join(", ")}. Every brief of ${cfg.briefMinChars}+ characters needs ` +
          `one line each for ${cfg.requireBriefFields.join(", ")} (Items: the task_inbox ids). Add them and resend.`);
      }
    }
  }

  return undefined;
}

export {
  DEFAULT_CONFIG,
  mergeConfig,
  isSubagentSession,
  parseDurationSeconds,
  totalSleepSeconds,
  commandHeads,
  invokesWaiter,
  hasSleepLoop,
  normaliseCommand,
  isProgressTool,
  createState,
  cleanupState,
  endRun,
  decide,
};
