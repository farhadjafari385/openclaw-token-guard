import fs from "node:fs";
import { stallText, interruptedText, unactedText, wakeCapText, teamStuckText } from "./voice.js";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mergeRefusals } from "./refusal.js";

// Job tracker: follows every task the orchestrator dispatches from spawn to end,
// and turns silence into action. scanJobs() is pure (state in, actions out);
// the store only persists state across gateway restarts.

const DEFAULT_JOBS = {
  enabled: true,
  stateFile: "~/.openclaw/token-guard-state/jobs.json",
  scanEverySeconds: 60,
  wakeAfterEndMinutes: 4, // a finished task the orchestrator has not acted on
  rewakeAfterMinutes: 20,
  maxWakesPerJob: 2,
  stallMinutes: 30, // a running task with no tool activity (only judged once the guard has seen it work)
  defaultRunTimeoutSeconds: 3600, // when the spawn did not say
  lostAfterTimeoutMinutes: 15, // a "running" task this long past its timeout lost its end event
  endedQuietMinutes: 10, // its run ended (follow-ups included) and no end event came: close it after this quiet
  restartGraceMinutes: 8, // agents need time to load after a restart
  idleCheckMinutes: 30, // open inbox work with nothing running
  idleOrcQuietMinutes: 20,
  maxIdleWakesWithoutChange: 3,
  idleWakeSession: "agent:coordinator:main",
  maxWakesPerDay: 48,
  budgetTokens: 15000000, // tokens a single task may process (input + cache + output)
  // Tool calls a single task may make. The Claude CLI reports almost no usage to plugins (a 6.4M-token
  // task showed up as under 0.1M), so the token budget alone never fired; every tool call reaches the guard.
  budgetCalls: 100,
  // Per-agent call budgets, e.g. { growth: 300 }: browser work takes 15-20 calls for one site (open, snapshot,
  // click, type, check), so a browser agent stopped after one listing at 100 calls.
  budgetCallsByAgent: {},
  // A task this close to its time limit may only write its final answer: the runtime stops a task at its
  // limit with no report, so the next task starts blind (a browser task was stopped at 60 min mid-form).
  wrapUpMinutes: 5,
  keepEndedHours: 48,
  maxBriefChars: 6000,
  maxResultChars: 6000,
};

const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "review", "qa", "open", "planned", "dispatched"]);

function expandHome(p) {
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}

function mergeJobsConfig(cfg) {
  return Object.assign({}, DEFAULT_JOBS, cfg && typeof cfg === "object" ? cfg : {});
}

function emptyState() {
  return {
    version: 1,
    jobs: {},
    claudeLimitedUntil: 0,
    codexLimitedUntil: 0,
    claudeLimitText: "",
    orcActivity: {},
    idle: { lastCheckAt: 0, streak: 0, sig: "", escalatedSig: "" },
    wakesByDay: {},
    notes: {},
    ownerMsgs: {}, // { "<topic>": { id, at } }: the owner's latest message per topic, for reply threading
    askedApproval: {}, // { "<item id>": ts }: the owner was asked to approve it
  };
}

// Telegram message ids of a job's thread; kept from either copy when two copies merge.
const THREAD_FIELDS = ["requestMsgId", "dispatchMsgId", "ackMsgId", "resultMsgId", "answeredAt"];

function shortId(key) {
  return crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 6);
}

// Newest copy of a job: ended beats running, then the later activity wins.
function newerJob(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (j) => (j.status === "running" ? 0 : 1);
  const t = (j) => Math.max(j.endedAt || 0, j.lastActivityAt || 0, j.lastWakeAt || 0, j.spawnedAt || 0);
  let win = t(a) >= t(b) ? a : b;
  if (rank(a) !== rank(b)) win = rank(a) > rank(b) ? a : b;
  const other = win === a ? b : a;
  const missing = THREAD_FIELDS.filter((f) => !win[f] && other[f]);
  const wait = mergeWait(win.waitFor, other.waitFor);
  // Counters only go up: a copy that missed a map query must not lock the task's code again.
  const graphQueries = Math.max(win.graphQueries || 0, other.graphQueries || 0);
  if (!missing.length && wait === win.waitFor && graphQueries === (win.graphQueries || 0)) return win;
  const out = Object.assign({}, win);
  for (const f of missing) out[f] = other[f];
  if (wait !== win.waitFor) out.waitFor = wait;
  if (graphQueries) out.graphQueries = graphQueries;
  return out;
}

// A CI wait only moves forward: once a copy has marked it done (or checked it), a copy holding an
// older version must not undo that. (On 2026-11-07 a stale copy's save dropped "done", and the item
// stayed locked as "already being worked on" with no task running.)
function mergeWait(w, o) {
  if (!w || !o || w.url !== o.url) return w || o;
  const done = w.done || o.done;
  const checkedAt = Math.max(w.checkedAt || 0, o.checkedAt || 0);
  if (done === w.done && checkedAt === (w.checkedAt || 0)) return w;
  return Object.assign({}, w, done ? { done } : {}, checkedAt ? { checkedAt } : {});
}

// Merge two states (two plugin generations, or memory and disk) without losing either's work.
function mergeStates(a, b) {
  const out = Object.assign(emptyState(), a, { jobs: {} });
  for (const key of new Set([...Object.keys(a.jobs || {}), ...Object.keys(b.jobs || {})])) {
    out.jobs[key] = newerJob((a.jobs || {})[key], (b.jobs || {})[key]);
  }
  out.claudeLimitedAt = Math.max(a.claudeLimitedAt || 0, b.claudeLimitedAt || 0);
  out.claudeLimitClearedAt = Math.max(a.claudeLimitClearedAt || 0, b.claudeLimitClearedAt || 0);
  // A limit cleared after it was recorded stays cleared, whichever copy still holds the old one.
  out.claudeLimitedUntil = out.claudeLimitClearedAt > out.claudeLimitedAt ? 0 : Math.max(a.claudeLimitedUntil || 0, b.claudeLimitedUntil || 0);
  out.codexLimitedUntil = Math.max(a.codexLimitedUntil || 0, b.codexLimitedUntil || 0);
  out.ownerLimitNoticeAt = Math.max(a.ownerLimitNoticeAt || 0, b.ownerLimitNoticeAt || 0);
  out.ownerLimitAnsweredAt = Math.max(a.ownerLimitAnsweredAt || 0, b.ownerLimitAnsweredAt || 0);
  out.claudeLimitText = (a.claudeLimitedUntil || 0) >= (b.claudeLimitedUntil || 0) ? a.claudeLimitText : b.claudeLimitText;
  out.orcActivity = Object.assign({}, b.orcActivity, a.orcActivity);
  for (const [k, v] of Object.entries(b.orcActivity || {})) out.orcActivity[k] = Math.max(v, out.orcActivity[k] || 0);
  out.wakesByDay = Object.assign({}, b.wakesByDay);
  for (const [k, v] of Object.entries(a.wakesByDay || {})) out.wakesByDay[k] = Math.max(v, out.wakesByDay[k] || 0);
  const ia = a.idle || {}, ib = b.idle || {};
  out.idle = (ia.lastCheckAt || 0) >= (ib.lastCheckAt || 0) ? ia : ib;
  out.boardMessages = Object.assign({}, b.boardMessages, a.boardMessages);
  out.pmAudit = ((a.pmAudit || {}).lastAt || 0) >= ((b.pmAudit || {}).lastAt || 0) ? a.pmAudit : b.pmAudit;
  out.notes = Object.assign({}, b.notes, a.notes);
  out.ownerMsgs = Object.assign({}, b.ownerMsgs);
  for (const [k, v] of Object.entries(a.ownerMsgs || {})) if (!out.ownerMsgs[k] || (v && v.at) >= out.ownerMsgs[k].at) out.ownerMsgs[k] = v;
  out.askedApproval = Object.assign({}, b.askedApproval, a.askedApproval);
  out.triageWakesByDay = Object.assign({}, b.triageWakesByDay);
  for (const [k, v] of Object.entries(a.triageWakesByDay || {})) out.triageWakesByDay[k] = Math.max(v, out.triageWakesByDay[k] || 0);
  const asks = new Map();
  for (const ask of [...(b.ownerAsks || []), ...(a.ownerAsks || [])]) asks.set(`${ask.at}:${ask.topic}`, Object.assign({}, asks.get(`${ask.at}:${ask.topic}`), ask, { captured: Boolean(ask.captured || (asks.get(`${ask.at}:${ask.topic}`) || {}).captured) }));
  out.ownerAsks = [...asks.values()].sort((x, y) => x.at - y.at).slice(-50);
  out.refusals = mergeRefusals(a.refusals, b.refusals);
  return out;
}

function createJobStore(file) {
  const target = expandHome(file || DEFAULT_JOBS.stateFile);
  let data = emptyState();
  let dirty = false;
  const readDisk = () => {
    try { return Object.assign(emptyState(), JSON.parse(fs.readFileSync(target, "utf8")) || {}); } catch { return null; }
  };
  return {
    get data() { return data; },
    load() {
      data = readDisk() || emptyState();
      return data;
    },
    // Pick up what another plugin generation wrote, keeping our own newer work.
    refresh() {
      const disk = readDisk();
      if (disk) {
        const merged = mergeStates(data, disk);
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, merged);
      }
      return data;
    },
    touch() { dirty = true; },
    save(force = false) {
      if (!dirty && !force) return;
      const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const disk = readDisk();
        const merged = disk ? mergeStates(data, disk) : data;
        fs.writeFileSync(tmp, JSON.stringify(merged));
        fs.renameSync(tmp, target);
        if (merged !== data) { for (const k of Object.keys(data)) delete data[k]; Object.assign(data, merged); }
        dirty = false;
      } catch {
        // state is best effort; the gateway must never fail because of it. A failed write (a full
        // disk) must not leave its temp file behind on every save.
        try { fs.unlinkSync(tmp); } catch { /* never written */ }
      }
    },
  };
}

// ---- state updates (all mutate `data` and return whether something changed) ----

function recordSpawn(data, info, bootId, now, cfg) {
  const key = info.childSessionKey;
  if (!key) return null;
  const prev = data.jobs[key] || {};
  const job = Object.assign({
    key,
    short: shortId(key),
    status: "running",
    spawnedAt: now,
    lastActivityAt: now,
    wakes: 0,
    usedTokens: 0,
  }, prev, {
    agentId: info.agentId || prev.agentId || "",
    label: info.label || prev.label || "",
    project: info.project || prev.project || "",
    topic: info.topic || prev.topic || null,
    requesterSessionKey: info.requesterSessionKey || prev.requesterSessionKey || "",
    model: info.model || prev.model || "",
    thinking: info.thinking || prev.thinking || "",
    doneWhen: info.doneWhen || prev.doneWhen || "",
    brief: String(info.brief || prev.brief || "").slice(0, cfg.maxBriefChars),
    items: info.items || prev.items || [],
    runTimeoutSeconds: Number(info.runTimeoutSeconds || prev.runTimeoutSeconds) || 0,
    bootId,
  });
  data.jobs[key] = job;
  return job;
}

function recordActivity(data, sessionKey, agentId, orchestratorAgent, now) {
  let changed = false;
  const job = data.jobs[sessionKey];
  if (job && job.status === "running") {
    job.lastActivityAt = now;
    if (now - (Number.isFinite(job.spawnedAt) ? job.spawnedAt : now) > 60000) job.activitySeen = true; // the guard can see this task work
    if (job.stallNotifiedAt) job.stallNotifiedAt = 0;
    changed = true;
  }
  if (agentId === orchestratorAgent && sessionKey) {
    data.orcActivity[sessionKey] = now;
    changed = true;
  }
  return changed;
}

function recordUsage(data, sessionKey, usage, cfg) {
  const job = data.jobs[sessionKey];
  if (!job || job.status !== "running" || !usage) return null;
  const n = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.output || 0);
  job.usedTokens = (job.usedTokens || 0) + n;
  if (!job.overBudget && cfg.budgetTokens > 0 && job.usedTokens > cfg.budgetTokens) {
    job.overBudget = true;
    return job;
  }
  return null;
}

// The tool calls one task of this agent may make.
function callBudget(cfg, agentId) {
  const own = cfg && cfg.budgetCallsByAgent && Number(cfg.budgetCallsByAgent[agentId]);
  return own > 0 ? own : Number(cfg && cfg.budgetCalls) || 0;
}

// One tool call by a running task; returns the job when this call used up its budget.
function recordCall(data, sessionKey, cfg) {
  const job = data.jobs[sessionKey];
  if (!job || job.status !== "running") return null;
  job.toolCalls = (job.toolCalls || 0) + 1;
  const budget = callBudget(cfg, job.agentId);
  if (!job.overBudget && budget > 0 && job.toolCalls > budget) {
    job.overBudget = true;
    return job;
  }
  return null;
}

// A running task that has reached its wrap-up point (wrapUpMinutes before its time limit); returns the job
// the first time only, so the caller logs it once.
function recordTime(data, sessionKey, cfg, now = Date.now()) {
  const job = data.jobs[sessionKey];
  if (!job || job.status !== "running" || job.timeUp || !(Number(cfg.wrapUpMinutes) > 0) || !job.spawnedAt) return null;
  const limit = (Number(job.runTimeoutSeconds) || Number(cfg.defaultRunTimeoutSeconds) || 0) * 1000;
  if (!limit || now < job.spawnedAt + limit - cfg.wrapUpMinutes * 60000) return null;
  job.timeUp = true;
  return job;
}

// A task queried its project's code map (graphify): searching and reading code is open from now on.
function recordGraph(data, sessionKey) {
  const job = data.jobs[sessionKey];
  if (!job || job.status !== "running") return false;
  job.graphQueries = (job.graphQueries || 0) + 1;
  return true;
}

// A task ran one of its project's pipeline steps locally (lint, typecheck, tests, security, build).
function recordCheck(data, sessionKey) {
  const job = data.jobs[sessionKey];
  if (!job || job.status !== "running") return false;
  job.checksRun = (job.checksRun || 0) + 1;
  return true;
}

const HAS_RESULT = /^\s*[*_`>]*\s*RESULT\s*[:=-]/im;

// Proof files a report cites that do not exist. Shortened ("…", "...") or pattern paths ({a,b}, *) are not
// literal files, so they are not judged (they produced false "missing proof" flags).
function missingProof(text, exists) {
  const cited = [...new Set(String(text || "").match(/(?:~|\/home|\/tmp|\/srv)\/[^\s`'")\]]+\.(?:png|jpe?g|webp|gif|webm|mp4|json|log|txt|html)/gi) || [])]
    .filter((f) => !/\.\.\.|…|[{}*?]/.test(f)).slice(0, 30);
  return cited.filter((f) => { try { return !exists(f); } catch { return false; } }).slice(0, 10);
}

// The worker's final answer among its text blocks: from the last block with a RESULT line to the end,
// else the last block. (Joining every block kept the run's narration and cut the real report off.)
function finalAnswer(texts) {
  const list = (texts || []).filter((t) => typeof t === "string" && t.trim());
  if (!list.length) return "";
  for (let i = list.length - 1; i >= 0; i--) if (HAS_RESULT.test(list[i])) return list.slice(i).join("\n").trim();
  return list[list.length - 1].trim();
}

function recordResultText(data, sessionKey, text, cfg) {
  const job = data.jobs[sessionKey];
  if (!job || !text) return false;
  const next = String(text).trim();
  // Never replace a real report (with its RESULT line) by later text without one.
  if (job.resultText && HAS_RESULT.test(job.resultText) && !HAS_RESULT.test(next)) return false;
  job.resultText = next.length > cfg.maxResultChars ? `${next.slice(0, cfg.maxResultChars - 1)}…` : next;
  return true;
}

// The real end of the child's run (subagent_progress "ended"), kept for its end event.
function recordProgress(data, sessionKey, phase, outcome, now) {
  const job = data.jobs[sessionKey];
  if (!job) return false;
  if (phase === "ended" && outcome) job.runOutcome = outcome;
  if (job.status === "running") job.lastActivityAt = now;
  return true;
}

function recordEnd(data, sessionKey, outcome, error, now) {
  const job = data.jobs[sessionKey];
  if (!job || job.status === "ended") return null;
  job.status = "ended";
  // "deleted"/"reset" describe the session clean-up, not the run: use the run's own outcome.
  const cleanup = outcome === "deleted" || outcome === "reset";
  job.outcome = (cleanup ? job.runOutcome || "ok" : outcome) || job.runOutcome || "unknown";
  job.error = error ? String(error).slice(0, 500) : "";
  job.endedAt = now;
  return job;
}

function setCodexLimited(data, untilMs, text) {
  if (untilMs > (data.codexLimitedUntil || 0)) {
    data.codexLimitedUntil = untilMs;
    data.codexLimitText = String(text || "").slice(0, 200);
    return true;
  }
  return false;
}

function setClaudeLimited(data, untilMs, text, now = Date.now()) {
  if (untilMs > (data.claudeLimitedUntil || 0)) {
    data.claudeLimitedUntil = untilMs;
    data.claudeLimitText = String(text || "").slice(0, 200);
    data.claudeLimitedAt = now;
    return true;
  }
  return false;
}

// A model answered normally after the limit was recorded, so the limit is gone (usage was added, the plan changed,
// or it covered fewer models than its text said). On 2026-11-12 one task's "weekly limit · resets Nov 13, 9pm" held
// every dispatch for two days while every model answered. Answers within `graceMs` of the limit may have been in
// flight when it hit. Returns true when it cleared one.
function clearClaudeLimited(data, now = Date.now(), graceMs = 60000) {
  if (!((data.claudeLimitedUntil || 0) > now)) return false;
  if (now - (data.claudeLimitedAt || 0) < graceMs) return false;
  data.claudeLimitedUntil = 0;
  data.claudeLimitClearedAt = now;
  return true;
}

// ---- scan ----

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function canWake(data, cfg, now) {
  const day = dayKey(now);
  return (data.wakesByDay[day] || 0) < cfg.maxWakesPerDay;
}

function countWake(data, now) {
  const day = dayKey(now);
  data.wakesByDay[day] = (data.wakesByDay[day] || 0) + 1;
  for (const d of Object.keys(data.wakesByDay)) if (d < dayKey(now - 7 * 86400000)) delete data.wakesByDay[d];
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

function describe(job) {
  return `${job.agentId} · ${job.label || job.short}`;
}

const ACT_NOW =
  "Act in this turn. If the result meets its Done when with evidence: accept it, update task_inbox, and dispatch the next gate " +
  "(review, QA, release) if one is due. If it does not: send it back with sessions_spawn and the exact gaps. " +
  "Only stop for something that needs the owner's approval, and then ask once with your recommendation. " +
  "Then answer in the project's Telegram topic with the message tool, like a teammate: your message is threaded under the worker's " +
  "result automatically. Mention the worker, say in plain words what you checked and what happens next, and mention whoever is next. " +
  "This run's own reply is not delivered.";

function scanJobs(data, rawCfg, now, env) {
  const cfg = mergeJobsConfig(rawCfg);
  const actions = [];
  const orchestrator = env.orchestratorAgent || "coordinator";
  const voice = Object.assign({ orchestratorAgent: orchestrator }, env.voice || {});
  const pm = env.pmAgent || voice.pmAgent || "product"; // the PM keeps the board moving, so it chases
  const wake = (sessionKey, message, reason) => {
    if (!sessionKey) return false;
    // Claude at its limit and no Codex to run on (off, or limited too): a wake cannot run, so do not spend one.
    if ((data.claudeLimitedUntil || 0) > now && (!env.codexEnabled || (data.codexLimitedUntil || 0) > now)) return false;
    if (!canWake(data, cfg, now)) {
      const day = dayKey(now);
      if (data.notes.wakeCap !== day) {
        data.notes.wakeCap = day;
        actions.push({ kind: "post", agentId: pm, topic: "system", html: true, text: wakeCapText(voice, cfg.maxWakesPerDay) });
      }
      return false;
    }
    countWake(data, now);
    actions.push({ kind: "wake", sessionKey, message, reason });
    return true;
  };

  const lostLimit = (job) => ((job.runTimeoutSeconds || cfg.defaultRunTimeoutSeconds) * 1000) + cfg.lostAfterTimeoutMinutes * 60000;
  for (const job of Object.values(data.jobs)) {
    // A run cannot outlive its timeout: past it (plus margin), its end event was lost. Close it
    // quietly (before the restart check, so a restart never revives old phantoms as "cut off").
    if (job.status === "running" && now - job.spawnedAt > lostLimit(job)) {
      job.status = "ended";
      job.outcome = "lost";
      job.endedAt = now;
      job.wakes = cfg.maxWakesPerJob; // the board audit re-queues its items; no reminder storm
      job.escalated = true;
      continue;
    }
    // Cut off by a restart: the child no longer exists in this gateway process.
    if (job.status === "running" && job.bootId !== env.bootId) {
      if (now - env.bootStartedAt >= cfg.restartGraceMinutes * 60000) {
        job.status = "interrupted";
        job.endedAt = now;
        actions.push({ kind: "post", agentId: pm, topic: job.topic || "system", html: true, replyTo: job.dispatchMsgId || null, text: interruptedText(voice, job) });
        wake(job.requesterSessionKey,
          `[job-tracker] Task ${describe(job)} was cut off by a gateway restart and did not finish. ` +
          `Re-dispatch it now with sessions_spawn (agentId "${job.agentId}", same label), using this brief:\n---\n${job.brief || "(brief not recorded: rebuild it from task_inbox)"}\n---`,
          "interrupted");
      }
      continue;
    }
    if (job.status === "running") {
      const quiet = now - (job.lastActivityAt || job.spawnedAt);
      // Only a task the guard has seen working can be judged silent: a worker's own CLI tools
      // are invisible to it, and judging those produced false stall alarms on most long tasks.
      if (job.activitySeen && quiet >= cfg.stallMinutes * 60000 && !job.stallNotifiedAt) {
        job.stallNotifiedAt = now;
        actions.push({ kind: "post", agentId: pm, topic: job.topic || "system", html: true, replyTo: job.ackMsgId || job.dispatchMsgId || null, text: stallText(voice, job, minutes(quiet)) });
        wake(job.requesterSessionKey,
          `[job-tracker] Task ${describe(job)} has had no tool activity for ${minutes(quiet)} min (job ${job.short}, child ${job.key}). ` +
          "Check it once with sessions_history. If it is stuck, stop it and re-dispatch it with sessions_spawn (same brief, say what happened); " +
          "if it is legitimately waiting (a CI run), let it be. Do not leave it hanging.",
          "stall");
      }
      continue;
    }
    if (job.status === "ended") {
      const seenAt = data.orcActivity[job.requesterSessionKey] || 0;
      const seen = seenAt > (job.endedAt || 0) + 2000;
      if (!seen && now - job.endedAt >= cfg.wakeAfterEndMinutes * 60000) {
        const due = !job.lastWakeAt || now - job.lastWakeAt >= cfg.rewakeAfterMinutes * 60000;
        if (job.wakes < cfg.maxWakesPerJob && due) {
          job.wakes += 1;
          job.lastWakeAt = now;
          wake(job.requesterSessionKey,
            `[job-tracker] Task finished: ${describe(job)}, outcome ${job.outcome}${job.error ? ` (${job.error})` : ""} [job ${job.short}].\n` +
            `Done when: ${job.doneWhen || "(see brief)"}\nResult:\n${job.resultText || "(no final text was captured; read it with sessions_history on " + job.key + ")"}\n` +
            `${job.missingEvidence && job.missingEvidence.length ? `\nWARNING: these files cited as proof do not exist: ${job.missingEvidence.join(", ")}. Treat those claims as unproven.\n` : ""}\n${ACT_NOW}`,
            "ended");
        } else if (job.wakes >= cfg.maxWakesPerJob && !job.escalated && due) {
          job.escalated = true;
          actions.push({ kind: "post", agentId: pm, topic: job.topic || "system", html: true, replyTo: job.resultMsgId || null, text: unactedText(voice, job, minutes(now - job.endedAt), job.wakes) });
        }
      }
    }
  }

  // Forget old jobs.
  for (const [key, job] of Object.entries(data.jobs)) {
    if (job.status !== "running" && now - (job.endedAt || job.spawnedAt) > cfg.keepEndedHours * 3600000) delete data.jobs[key];
  }

  // Open work that nobody is moving (the triage check decides this when it is on).
  if (!env.triage && now - (data.idle.lastCheckAt || 0) >= cfg.idleCheckMinutes * 60000) {
    data.idle.lastCheckAt = now;
    const running = Object.values(data.jobs).filter((j) => j.status === "running");
    const covered = new Set();
    for (const j of running) for (const id of (j.items && j.items.length ? j.items : String(j.brief || "").match(/\b[0-9a-f]{8}\b/g) || [])) covered.add(id);
    const open = [...(env.inboxItems || [])].filter((it) => OPEN_STATUSES.has(it.status || "open") && !covered.has(it.id));
    const lastOrc = Math.max(0, ...Object.values(data.orcActivity));
    if (open.length > 0 && running.length === 0 && now - lastOrc >= cfg.idleOrcQuietMinutes * 60000) {
      const sig = crypto.createHash("sha1").update(open.map((it) => `${it.id}:${it.status}`).sort().join(",")).digest("hex").slice(0, 12);
      data.idle.streak = sig === data.idle.sig ? data.idle.streak + 1 : 1;
      data.idle.sig = sig;
      const list = open.slice(0, 12).map((it) => `- ${it.id} ${it.project || "?"}: ${it.title || ""} (${it.status || "open"}, owner ${it.owner || "?"})`).join("\n");
      if (data.idle.streak <= cfg.maxIdleWakesWithoutChange) {
        wake(env.idleWakeSession || cfg.idleWakeSession,
          `[job-tracker] There is open work and no task is running:\n${list}${open.length > 12 ? `\n(+${open.length - 12} more)` : ""}\n` +
          "Continue now: run task_inbox plan and dispatch the next batch with sessions_spawn (one task per item or small same-area batch, " +
          "brief lines Project, Scope, Items, Done when, Stop if), or set an item to blocked with the exact reason. Dispatches are posted to " +
          "the project topics automatically, so do not repeat them. If an item needs the owner, ask once in its project topic with the message " +
          "tool and mention the owner. This run's own reply is not delivered.",
          "idle");
      } else if (data.idle.escalatedSig !== sig) {
        data.idle.escalatedSig = sig;
        actions.push({ kind: "post", agentId: pm, topic: "system", html: true, text: teamStuckText(voice, open, cfg.maxIdleWakesWithoutChange) });
      }
    } else if (open.length === 0) {
      data.idle.streak = 0;
      data.idle.sig = "";
    }
  }
  return actions;
}

// Last assistant text in an agent_end / getSessionMessages message list.
function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    let m = messages[i];
    if (m && m.message && typeof m.message === "object") m = m.message;
    if (!m || (m.role && m.role !== "assistant")) continue;
    const c = m.content;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      const text = c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n").trim();
      if (text) return text;
    }
    if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  }
  return "";
}

// Tasks in a row on one item that moved nothing (2026-11-14: 631 tasks on 88 open items; a small item took 33, mostly
// "blocked" and "partly", while 19 items were never started). Counted newest first, back to the last result that
// made progress, within `windowMs`, and only since the item's last move whose note starts "Rescoped:" or
// "Operator:" (the item was split or its blocker removed). A task cut off by a restart counts neither way.
const PROGRESS_RESULTS = new Set(["done", "waiting", "pass", "passed", "merged", "approve", "approved", "changes"]);
const STREAK_RESET = /^\s*(rescoped|operator)\b/i;
function noProgressStreak(jobs, id, item, now = Date.now(), windowMs = 48 * 3600000) {
  let since = now - windowMs;
  for (const h of (item && item.history) || []) {
    const t = Date.parse(h && h.ts);
    if (STREAK_RESET.test(String((h && h.note) || "")) && Number.isFinite(t) && t > since) since = t;
  }
  const mine = (jobs || []).filter((j) => j && j.status !== "running" && (j.items || []).includes(id) && (j.spawnedAt || 0) > since)
    .sort((a, b) => (b.spawnedAt || 0) - (a.spawnedAt || 0));
  let n = 0;
  for (const j of mine) {
    if (j.outcome === "killed" || j.outcome === "lost") continue;
    const m = /RESULT:\s*(\w+)/i.exec(String(j.resultText || ""));
    if (m && PROGRESS_RESULTS.has(m[1].toLowerCase())) break;
    n += 1;
  }
  return n;
}

export {
  DEFAULT_JOBS,
  mergeJobsConfig,
  emptyState,
  shortId,
  createJobStore,
  mergeStates,
  recordSpawn,
  recordActivity,
  recordUsage,
  recordCall,
  callBudget,
  recordTime,
  recordCheck,
  recordGraph,
  recordResultText,
  finalAnswer,
  missingProof,
  recordEnd,
  recordProgress,
  setClaudeLimited,
  clearClaudeLimited,
  setCodexLimited,
  scanJobs,
  lastAssistantText,
  noProgressStreak,
};
