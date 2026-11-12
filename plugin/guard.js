import os from "node:os";

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
  blockVmOnHost: true, // emulators and virtual machines may not start on the gateway's host (exec host "node" may)
  maxBackgroundSleepSeconds: 60,
  minLoopSleepSeconds: 5,
  maxRepeatCommand: 4,
  maxRepeatMessage: 3,
  maxBlockedRetries: 0, // identical retries of a call already blocked in this run that are tolerated; 0 = refuse the first retry
  forbiddenModelPatterns: ["fable"], // sessions_spawn model overrides matching any of these are blocked
  forbiddenThinking: ["xhigh", "max"], // sessions_spawn thinking levels that are blocked
  checkpointEvery: 120, // 0 disables; never applies to subagents
  maxToolCallsPerRun: 400,
  maxStatusChecksPerRun: 12,
  statusExemptSessionPatterns: [":cron:"],
  briefMinChars: 600,
  requireBriefFields: ["Project:", "Scope:", "Items:", "Done when:", "Stop if:"],
  briefCheckAgents: ["coordinator"], // [] = every agent
  requireSpawnForBriefs: true, // a new brief starts a fresh session (sessions_spawn), never an existing chat
  dedupeWindowMs: 6 * 60 * 60 * 1000, // identical brief to the same target inside this window is blocked
  maxItemsPerBrief: 4, // inbox items per session; only small items may share one
  exemptSessionPatterns: [],
  runIdleResetMs: 120000, // runs without a runId: start a fresh count after this gap
  ttlMs: 6 * 60 * 60 * 1000,
  maxTrackedRuns: 5000,
};

const STATUS_TOOLS = new Set(["sessions_history", "sessions_list", "session_status"]);
const INBOX_ID = /\b[0-9a-f]{8}\b/g;
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

// Commands that stop, restart or kill the gateway. An agent runs inside the
// gateway, so doing this cuts off its own run and every other agent's, and a
// bare `stop` leaves the gateway down with nobody left to start it.
// ~/.openclaw/bin/oc-gateway-restart is the one allowed way: it schedules the
// restart outside the gateway, so it always completes.
const GATEWAY_CONTROL = [
  /\bsystemctl\b[^;&|\n]*\b(stop|restart|kill|try-restart|reload-or-restart|disable|mask)\b[^;&|\n]*\bopenclaw-gateway/,
  /\bopenclaw\s+gateway\s+(stop|restart|start|run|install|uninstall)\b/,
  /\b(pkill|killall)\b[^;&|\n]*\b(openclaw|node|entry\.js|MainThread)\b/,
  /\bkill\b[^;&|\n]*\$\(\s*(pgrep|pidof)\b[^)]*\b(openclaw|node|entry)/,
];
const GATEWAY_CONTROL_REASON =
  "token-guard: blocked a command that stops, restarts or kills the OpenClaw gateway. You run inside the gateway: " +
  "this cuts off your own run and every agent's session, and a stop leaves it down. If a restart is really needed " +
  "(e.g. to load a changed plugin), run `~/.openclaw/bin/oc-gateway-restart` once, as your LAST action, and end your turn; " +
  "it holds new tasks, waits for the running ones to finish, then restarts the gateway safely from outside. Agents come back about 10 minutes after the restart.";

// Rotating an access token through its API revokes the old one at once. Twice a task rotated the team's GitLab
// token and lost the new value before saving it, and the whole team lost GitLab (2026-11-10, 2026-11-11).
const TOKEN_ROTATE = [/personal_access_tokens\/(self|\d+)\/rotate/, /\/(group|project)_access_tokens\/\d+\/rotate/, /\/access_tokens\/\d+\/rotate/];
const TOKEN_ROTATE_REASON =
  "token-guard: blocked rotating an access token through its API. A rotation revokes the old token at once, and twice " +
  "a task lost the new one before saving it, so the whole team lost GitLab. Do not rotate tokens: say in your RESULT which " +
  "token leaked and where; the operator rotates it.";

// A virtual machine on the gateway's host. On 2026-11-11 an Android emulator a task started there took the
// memory; the kernel killed the gateway, and the team answered nothing for 8 hours.
const VM_START = [
  /(^|[\s;&|/"'(])emulator\s+(-avd\b|@)/,
  /(^|[\s;&|/"'(])qemu-system-[\w-]+/,
  /\b(VBoxHeadless|virt-install)\b/,
  /\b[Vv][Bb]ox[Mm]anage\s+startvm\b/,
];
const VM_REASON =
  "token-guard: blocked starting an emulator or virtual machine on the gateway's host. It shares its memory with the " +
  "gateway and every agent: on 2026-11-11 one made the kernel kill the gateway and the team answered nothing for 8 hours. " +
  "Check an app without running it here (build, unit tests, lint, the APK's manifest and size), or run the emulator " +
  "on the laptop node (exec host \"node\") when it is online.";

// The whole command, quotes included: a launch usually sits inside `sg kvm -c "..."` or `bash -c "..."`.
function startsVm(command) {
  if (typeof command !== "string" || !command) return false;
  return VM_START.some((re) => re.test(command));
}

function controlsGateway(command) {
  if (typeof command !== "string" || !command) return false;
  const shell = executableParts(command).shell;
  return GATEWAY_CONTROL.some((re) => re.test(shell));
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

const MAX_PARSE_CHARS = 16 * 1024;
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
let lastParts = null; // one-entry memo: decide() analyses the same command several times
function executableParts(command) {
  if (lastParts && lastParts.command === command) return lastParts.result;
  const result = computeExecutableParts(command);
  lastParts = { command, result };
  return result;
}

function computeExecutableParts(command) {
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
  // quotedCode's regex backtracks badly on huge input (80KB took 2.6s), so quoted interpreter code is not
  // extracted past MAX_PARSE_CHARS; decide() blocks such commands when they call an interpreter (oversizeCommand).
  const quoted = outer.length > MAX_PARSE_CHARS ? { shell: [], python: [] } : quotedCode(outer);
  const shell = [stripQuoted(outer), ...extraShell, ...quoted.shell.map(stripQuoted)].join("\n");
  return { shell, python: [...python, ...quoted.python].join("\n") };
}

function rawSegments(shellText) {
  return String(shellText).split(/&&|\|\||[;|&\n]/);
}

// Simple commands: split on ; && || | & and newlines, dropping leading shell
// keywords (do, then, else) so `do sleep 5` yields `sleep 5`.
let lastSegments = null; // one-entry memo, same reason as executableParts
function segments(shellText) {
  if (lastSegments && lastSegments.text === shellText) return lastSegments.result;
  const result = computeSegments(shellText);
  lastSegments = { text: shellText, result };
  return result;
}

const headWordsCache = new Map(); // cleared whenever a new command is analysed
function computeSegments(shellText) {
  headWordsCache.clear();
  return rawSegments(shellText).map((s) => s.trim().replace(/^(?:(?:do|then|else|elif|time|!)\s+)+/, ""));
}

function headWords(segment) {
  let hit = headWordsCache.get(segment);
  if (hit === undefined) {
    hit = computeHeadWords(segment);
    headWordsCache.set(segment, hit);
  }
  return hit;
}

function computeHeadWords(segment) {
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

const WAITER_PATH_PREFIXES = ["~/.openclaw/bin/", "$HOME/.openclaw/bin/", `${os.homedir()}/.openclaw/bin/`];

// True only when the command is exactly one simple command whose program is
// the real waiter at ~/.openclaw/bin/oc-wait or ~/.openclaw/bin/oc-wait-pipeline.
// Chains (`oc-wait ...; sleep 600`), lookalike paths and any substitution
// ($( ` <( >( ) are not exempt. The path may be quoted ("$HOME/.openclaw/bin/oc-wait").
function isSoleWaiter(command) {
  if (typeof command !== "string" || command.length > MAX_PARSE_CHARS) return false;
  if (/\$\(|`|<\(|>\(/.test(command)) return false;
  const parts = segments(executableParts(command).shell).filter(Boolean);
  if (parts.length !== 1) return false;
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  if (!m) return false;
  const quoted = m[1] !== undefined || m[2] !== undefined;
  const first = m[1] ?? m[2] ?? m[3];
  if (quoted && first.startsWith("~")) return false; // ~ does not expand inside quotes
  if (m[2] !== undefined && first.startsWith("$")) return false; // $HOME does not expand in single quotes
  return WAITER_PATH_PREFIXES.some((p) => first.startsWith(p) && WAITERS.has(first.slice(p.length)));
}

// Over MAX_PARSE_CHARS the quoted code of an interpreter is not extracted, so a
// padded `bash -c 'sleep 600'` would hide its sleep. Such commands are blocked.
function callsInterpreter(command) {
  return commandHeads(command).some((h) => SHELL_HEADS.test(h) || PYTHON_HEADS.test(h));
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
    blockedSigs: new Map(),
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

// ---- briefs ----

function briefLines(text) {
  return String(text).split("\n").map((line) => line.replace(/^[\s>*#_\-]+/, "").toLowerCase());
}

function missingBriefFields(text, cfg) {
  const lines = briefLines(text);
  return cfg.requireBriefFields.filter((field) => !lines.some((line) => line.startsWith(String(field).toLowerCase())));
}

// A brief is a new piece of work: long, or shaped like one (Project: and Done when: lines).
function isBrief(text, cfg) {
  if (text.length >= cfg.briefMinChars) return true;
  const lines = briefLines(text);
  return lines.some((line) => line.startsWith("project:")) && lines.some((line) => line.startsWith("done when:"));
}

// Inbox items a brief names, as far as the inbox knows them.
function briefItems(text, state) {
  if (!state || typeof state.lookupInbox !== "function") return [];
  const ids = [...new Set(String(text).match(INBOX_ID) || [])];
  if (ids.length === 0) return [];
  const inbox = state.lookupInbox();
  return ids.map((id) => inbox.get(id)).filter(Boolean);
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

  let callSig = "";
  try { callSig = `${toolName}|${JSON.stringify(params)}`; } catch { callSig = ""; }
  const block = (rule, reason) => {
    if (callSig && rule !== "retryBlocked") run.blockedSigs.set(callSig, 0);
    state.blocks.set(rule, (state.blocks.get(rule) || 0) + 1);
    if (typeof log === "function") {
      log(enforce ? "warn" : "info", `token-guard ${enforce ? "blocked" : "would block"} ${toolName} (${rule})`, {
        rule, agentId, sessionKey, toolName,
      });
    }
    return enforce ? { block: true, blockReason: reason } : undefined;
  };

  // An identical call that was already blocked in this run is refused again without re-evaluating it.
  if (callSig && run.blockedSigs.has(callSig)) {
    const tries = run.blockedSigs.get(callSig) + 1;
    run.blockedSigs.set(callSig, tries);
    if (tries > cfg.maxBlockedRetries) {
      return block("retryBlocked",
        `token-guard: this exact ${toolName} call was already blocked in this run and was sent again unchanged. ` +
        "Do not retry it: change the approach (use the remedy in the earlier block message), or end your turn and report the blocker.");
    }
  }

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
  const statusCheck = STATUS_TOOLS.has(toolName) || (toolName === "subagents" && (params.action || "list") === "list");
  if (statusCheck && !matchesAny(sessionKey, cfg.statusExemptSessionPatterns)) {
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

  if (toolName === "gateway") {
    const action = String(params.action || params.method || params.command || "").toLowerCase();
    if (/restart|stop|shutdown|update|reload/.test(action)) return block("gatewayControl", GATEWAY_CONTROL_REASON);
  }

  if (toolName === "exec") {
    const command = typeof params.command === "string" ? params.command : "";
    if (controlsGateway(command)) return block("gatewayControl", GATEWAY_CONTROL_REASON);
    if (cfg.blockVmOnHost && String(params.host || "") !== "node" && startsVm(command)) return block("vmOnHost", VM_REASON);
    if (TOKEN_ROTATE.some((re) => re.test(command))) return block("tokenRotate", TOKEN_ROTATE_REASON);
    const background = params.background === true;
    const awaitResults = params.awaitResults === true;

    if (isSoleWaiter(command)) {
      if (!subagent && !background && !awaitResults && enforce) {
        if (typeof log === "function") log("info", "token-guard moved a waiter to the background", { agentId, sessionKey });
        return { params: Object.assign({}, params, { background: true }) };
      }
      return undefined;
    }

    if (command.length > MAX_PARSE_CHARS && callsInterpreter(command)) {
      return block("oversizeCommand",
        `token-guard: blocked a ${command.length}-character command that runs bash/sh/zsh/dash/ssh/python: ` +
        `it is too large to check for sleeps. Write the script to a file in a separate step (cat > file <<'EOF'), then run the file.`);
    }
    const sleepSeconds = totalSleepSeconds(command);
    if (!background) {
      // awaitResults still waits in the foreground, so sleeps stay checked.
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

  if (toolName === "sessions_spawn") {
    const model = String(params.model || "").toLowerCase();
    if (model && (cfg.forbiddenModelPatterns || []).some((p) => model.includes(String(p).toLowerCase()))) {
      return block("forbiddenModel", `token-guard: model "${params.model}" is not allowed for spawned sessions. Use Sonnet (default) or Haiku; Opus only for hard reasoning with the reason stated in the brief.`);
    }
    const thinking = String(params.thinking || "").toLowerCase();
    if (thinking && (cfg.forbiddenThinking || []).includes(thinking)) {
      return block("forbiddenThinking", `token-guard: thinking level "${params.thinking}" is not allowed. Use off, low or medium.`);
    }
  }

  const briefAgents = Array.isArray(cfg.briefCheckAgents) ? cfg.briefCheckAgents : [];
  const briefChecked = briefAgents.length === 0 || briefAgents.includes(agentId);
  if (briefChecked && (toolName === "sessions_send" || toolName === "sessions_spawn")) {
    const spawn = toolName === "sessions_spawn";
    const text = String((spawn ? params.task : params.message) || "");
    if (spawn && params.context === "fork") {
      return block("forkSpawn",
        "token-guard: context \"fork\" copies your whole session into the child, so every call of that task re-reads it. " +
        "Spawn with context \"isolated\" and put what the child needs in the brief.");
    }
    const brief = isBrief(text, cfg);
    // A brief counts as sent only if no check below blocks it: a blocked brief was never sent, and
    // calling its corrected resend "already sent" told the orchestrator a task ran that never did.
    let recordedKey = null;
    const refuse = (rule, reason) => {
      if (recordedKey) state.sentBriefs.delete(recordedKey);
      return block(rule, reason);
    };
    if (brief) {
      state.sentBriefs = state.sentBriefs || new Map();
      const key = `${spawn ? "spawn:" + (params.agentId || "") : params.sessionKey || ""}|${text.replace(/\s+/g, " ").trim().toLowerCase()}`;
      const prev = state.sentBriefs.get(key);
      if (prev !== undefined && now - prev < cfg.dedupeWindowMs) {
        return block("duplicateBrief", "token-guard: this exact brief was already sent to this target; not sending it again.");
      }
      state.sentBriefs.set(key, now);
      recordedKey = key;
      for (const [k, t] of state.sentBriefs) if (now - t >= cfg.dedupeWindowMs) state.sentBriefs.delete(k);
    }
    const target = String(params.sessionKey || "");
    if (!spawn && brief && cfg.requireSpawnForBriefs && !isSubagentSession(target)) {
      const owner = target.startsWith("agent:") ? target.split(":")[1] : String(params.agentId || params.label || "the owner");
      return refuse("briefToExistingChat",
        `token-guard: a new task starts in a fresh session, not in ${target || owner}'s existing chat, which every call would re-read in full. ` +
        `Use sessions_spawn with agentId "${owner}", context "isolated", label "<project>: <short title>", and this brief as task ` +
        "(runTimeoutSeconds 3600 if it builds, deploys or waits on CI). sessions_send is only for short follow-ups " +
        `(under ${cfg.briefMinChars} characters) to a task's own child session (its childSessionKey).`);
    }
    if (text.length >= cfg.briefMinChars) {
      const missing = missingBriefFields(text, cfg);
      if (missing.length > 0) {
        return refuse("briefFields",
          `token-guard: this brief is missing ${missing.join(", ")}. Every brief of ${cfg.briefMinChars}+ characters needs ` +
          `one line each for ${cfg.requireBriefFields.join(", ")} (Items: the task_inbox ids). Add them and resend.`);
      }
    }
    const items = briefItems(text, state);
    if (items.length > cfg.maxItemsPerBrief) {
      return refuse("tooManyItems",
        `token-guard: ${items.length} inbox items in one brief; one session takes at most ${cfg.maxItemsPerBrief} small items. ` +
        "Split it: run task_inbox plan and start one session per batch.");
    }
    if (items.length > 1) {
      const big = items.filter((it) => it.size !== "small");
      const mixed = new Set(items.map((it) => `${it.project || ""}|${it.owner || ""}`)).size > 1;
      if (big.length > 0 || mixed) {
        return refuse("mixedBatch",
          (big.length > 0
            ? `token-guard: ${big.map((it) => `${it.id} (${it.size})`).join(", ")} must each get a fresh session of its own. `
            : "token-guard: these items belong to different projects or owners. ") +
          "Only small items of the same project, owner and area share one session. Run task_inbox plan and start one session per batch.");
      }
    }
  }

  return undefined;
}

// A spawn the runtime refused was never sent: forget its brief so the same dispatch can be sent again.
// The brief is recorded before the runtime runs the spawn (and the guard may add lines to it after),
// so forget this target's briefs from the last two minutes rather than match the text.
function forgetRefusedBrief(state, agentId, now = Date.now(), withinMs = 2 * 60000) {
  let forgotten = 0;
  if (!state || !state.sentBriefs || !agentId) return forgotten;
  for (const [key, at] of state.sentBriefs) {
    if (key.startsWith(`spawn:${agentId}|`) && now - at < withinMs) { state.sentBriefs.delete(key); forgotten += 1; }
  }
  return forgotten;
}

export {
  forgetRefusedBrief,
  DEFAULT_CONFIG,
  mergeConfig,
  isSubagentSession,
  parseDurationSeconds,
  totalSleepSeconds,
  commandHeads,
  invokesWaiter,
  isSoleWaiter,
  callsInterpreter,
  hasSleepLoop,
  normaliseCommand,
  isProgressTool,
  isBrief,
  createState,
  cleanupState,
  endRun,
  decide,
};
