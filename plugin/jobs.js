import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
  stallMinutes: 30, // a running task with no tool activity
  restartGraceMinutes: 8, // agents need time to load after a restart
  idleCheckMinutes: 30, // open inbox work with nothing running
  idleOrcQuietMinutes: 20,
  maxIdleWakesWithoutChange: 3,
  idleWakeSession: "agent:coordinator:main",
  maxWakesPerDay: 48,
  budgetTokens: 15000000, // tokens a single task may process (input + cache + output)
  keepEndedHours: 48,
  maxBriefChars: 6000,
  maxResultChars: 3000,
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
    claudeLimitText: "",
    orcActivity: {},
    idle: { lastCheckAt: 0, streak: 0, sig: "", escalatedSig: "" },
    wakesByDay: {},
    notes: {},
  };
}

function shortId(key) {
  return crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 6);
}

function createJobStore(file) {
  const target = expandHome(file || DEFAULT_JOBS.stateFile);
  let data = emptyState();
  let dirty = false;
  return {
    get data() { return data; },
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
        data = Object.assign(emptyState(), parsed || {});
      } catch {
        data = emptyState();
      }
      return data;
    },
    touch() { dirty = true; },
    save(force = false) {
      if (!dirty && !force) return;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, target);
        dirty = false;
      } catch {
        // state is best effort; the gateway must never fail because of it
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

function recordResultText(data, sessionKey, text, cfg) {
  const job = data.jobs[sessionKey];
  if (!job || !text) return false;
  job.resultText = String(text).slice(0, cfg.maxResultChars);
  return true;
}

function recordEnd(data, sessionKey, outcome, error, now) {
  const job = data.jobs[sessionKey];
  if (!job || job.status === "ended") return null;
  job.status = "ended";
  job.outcome = outcome || "unknown";
  job.error = error ? String(error).slice(0, 500) : "";
  job.endedAt = now;
  return job;
}

function setClaudeLimited(data, untilMs, text) {
  if (untilMs > (data.claudeLimitedUntil || 0)) {
    data.claudeLimitedUntil = untilMs;
    data.claudeLimitText = String(text || "").slice(0, 200);
    return true;
  }
  return false;
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
  "Only stop for something that needs the owner's approval, and then ask once with your recommendation.";

function scanJobs(data, rawCfg, now, env) {
  const cfg = mergeJobsConfig(rawCfg);
  const actions = [];
  const orchestrator = env.orchestratorAgent || "coordinator";
  const wake = (sessionKey, message, reason) => {
    if (!sessionKey) return false;
    if (!canWake(data, cfg, now)) {
      const day = dayKey(now);
      if (data.notes.wakeCap !== day) {
        data.notes.wakeCap = day;
        actions.push({ kind: "post", agentId: orchestrator, topic: "system", text: `⚠️ Job tracker: the daily limit of ${cfg.maxWakesPerDay} automatic follow-ups is used up. Open work now needs you to nudge the orchestrator.` });
      }
      return false;
    }
    countWake(data, now);
    actions.push({ kind: "wake", sessionKey, message, reason });
    return true;
  };

  for (const job of Object.values(data.jobs)) {
    // Cut off by a restart: the child no longer exists in this gateway process.
    if (job.status === "running" && job.bootId !== env.bootId) {
      if (now - env.bootStartedAt >= cfg.restartGraceMinutes * 60000) {
        job.status = "interrupted";
        job.endedAt = now;
        actions.push({ kind: "post", agentId: orchestrator, topic: job.topic || "system", text: `🔁 ${describe(job)} was cut off by a gateway restart. The orchestrator is re-dispatching it. [job ${job.short}]` });
        wake(job.requesterSessionKey,
          `[job-tracker] Task ${describe(job)} was cut off by a gateway restart and did not finish. ` +
          `Re-dispatch it now with sessions_spawn (agentId "${job.agentId}", same label), using this brief:\n---\n${job.brief || "(brief not recorded: rebuild it from task_inbox)"}\n---`,
          "interrupted");
      }
      continue;
    }
    if (job.status === "running") {
      const quiet = now - (job.lastActivityAt || job.spawnedAt);
      if (quiet >= cfg.stallMinutes * 60000 && !job.stallNotifiedAt) {
        job.stallNotifiedAt = now;
        actions.push({ kind: "post", agentId: orchestrator, topic: job.topic || "system", text: `⏸ ${describe(job)} shows no activity for ${minutes(quiet)} min. The orchestrator is checking it. [job ${job.short}]` });
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
            `Done when: ${job.doneWhen || "(see brief)"}\nResult:\n${job.resultText || "(no final text was captured; read it with sessions_history on " + job.key + ")"}\n\n${ACT_NOW}`,
            "ended");
        } else if (job.wakes >= cfg.maxWakesPerJob && !job.escalated && due) {
          job.escalated = true;
          actions.push({ kind: "post", agentId: orchestrator, topic: job.topic || "system", text: `🚩 The orchestrator has not acted on the result of ${describe(job)} for ${minutes(now - job.endedAt)} min after ${job.wakes} reminders. Please check. [job ${job.short}]` });
        }
      }
    }
  }

  // Forget old jobs.
  for (const [key, job] of Object.entries(data.jobs)) {
    if (job.status !== "running" && now - (job.endedAt || job.spawnedAt) > cfg.keepEndedHours * 3600000) delete data.jobs[key];
  }

  // Open work that nobody is moving.
  if (now - (data.idle.lastCheckAt || 0) >= cfg.idleCheckMinutes * 60000) {
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
          "Continue now: run task_inbox plan and dispatch the next batch with sessions_spawn, or set an item to blocked with the exact reason " +
          "(and ask the owner once if it needs him). Never leave open work idle.",
          "idle");
      } else if (data.idle.escalatedSig !== sig) {
        data.idle.escalatedSig = sig;
        actions.push({ kind: "post", agentId: orchestrator, topic: "system", text: `🚩 The team is stalled: these items have not moved after ${cfg.maxIdleWakesWithoutChange} reminders to the orchestrator:\n${list}` });
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

export {
  DEFAULT_JOBS,
  mergeJobsConfig,
  emptyState,
  shortId,
  createJobStore,
  recordSpawn,
  recordActivity,
  recordUsage,
  recordResultText,
  recordEnd,
  setClaudeLimited,
  scanJobs,
  lastAssistantText,
};
