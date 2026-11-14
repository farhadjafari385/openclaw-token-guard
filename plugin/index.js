import crypto from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createState, decide, forgetRefusedBrief } from "./guard.js";
import { policyDecide, firstLine, itemsFromBrief, completeBrief, codexEnabled, CHECK_COMMAND, GRAPH_COMMAND } from "./policy.js";
import { ACTIVE, isLimitBlock, normStatus, resultVerdict, nextAfterJob, queueState, renderBoard, renderOverview, auditBoard, parseApproval, looksLikeRequest } from "./board.js";
import { correctTopic, isGeneral, projectOfTopic, projectsMentioned } from "./topics.js";
import { isLimitError, isLimitReply, isRunFailureReply, allowLimitReply, limitResetAt } from "./limits.js";
import {
  createJobStore, mergeJobsConfig, recordSpawn, recordActivity, recordUsage, recordCall, callBudget, recordTime, recordCheck, recordGraph, recordResultText, finalAnswer, missingProof,
  recordEnd, recordProgress, setClaudeLimited, clearClaudeLimited, setCodexLimited, scanJobs, lastAssistantText, noProgressStreak,
} from "./jobs.js";
import { createMirror, topicFor, messageIdOf } from "./mirror.js";
import { secretDecide, findSecret, redactDeep } from "./secrets.js";
import {
  dispatchText, ackText, resultText, guardText, limitText, limitHoldText, budgetText, approvalAskText, approvalReplyText,
  auditText, movedText, mdToHtml, handleOf, boardReplyText, spawnErrorText, nameOf,
} from "./voice.js";
import { inboxArgs, loadInboxItems, runInbox } from "./inbox.js";
import { processBoot } from "./boot.js";
import { selectSkills, skillsLine } from "./skills.js";
import { mergeTriageConfig, triageSnapshot, triageSignature, TRIAGE_PROMPT, parseTriage, triageWakeMessage } from "./triage.js";
import { parseCiLink, ciRequest, ciState, failedParts, DEFAULT_CI } from "./ci.js";
import { allowAgentWake, wakeMessage, DEFAULT_WAKE, WAKE_REASONS } from "./wake.js";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { mergeRefusalConfig, isLoginRefusal, recordRefusal, dueRefusals, closeRefusals, refusalsWithinHour, retryWakeText } from "./refusal.js";

// No top-level await: OpenClaw loads plugin entries through require(), which
// rejects ESM graphs that use it.

const state = createState();
state.lookupInbox = () => loadInboxItems();

// Shared by every copy of the plugin in this process (see boot.js).
const BOOT = processBoot();
const LIMIT_CLEARED_WAKE = "[limit] Claude answers normally again, so the usage limit the guard had recorded is cleared and dispatches go through. " +
  "Dispatch the next items from the queue now. If you told the owner that agents are blocked by a limit, correct it in that same chat in one line.";
const LIMIT_OWNER_WAKE = "[limit] Claude answers normally again. While the usage limit held, the owner wrote to you here and got only the " +
  "limit notice. Answer each of those messages now, as a reply to it, in the order they came. Do not resend anything you already answered.";
const BOOT_ID = BOOT.id;
const BOOT_STARTED_AT = BOOT.startedAt;
// OpenClaw may load the plugin in several generations and not always stop the old ones.
// Only the newest generation runs the follow-up loop.
const GEN_KEY = Symbol.for("token-guard.activeGeneration");

export default definePluginEntry({
  id: "token-guard",
  name: "Token Guard",
  description: "Enforces the team's rules on every tool call, follows every task to the end, and mirrors team work into Telegram.",
  register(api) {
    const cfg = api.pluginConfig || {};
    const orchestrator = cfg.orchestratorAgent || "coordinator";
    const jobsCfg = mergeJobsConfig(cfg.jobs);
    const log = (level, message, meta) => {
      try {
        const fn = api.logger && typeof api.logger[level] === "function" ? api.logger[level] : null;
        if (fn) fn.call(api.logger, meta ? `${message} ${JSON.stringify(meta)}` : message);
      } catch {
        // logging must never break a tool call
      }
    };
    // A dispatch refused by OpenClaw's Claude login check (see refusal.js): reading the agent's model
    // list makes OpenClaw check the login again; the orchestrator is then woken to send it again.
    const refusalCfg = mergeRefusalConfig(jobsCfg.refusal);
    const recheckLogin = (agentId) => {
      if (!refusalCfg.command) return;
      try {
        execFile(refusalCfg.command, ["gateway", "call", "models.list", "--params", JSON.stringify({ agentId }), "--json"],
          { timeout: 120000, maxBuffer: 8 << 20, env: process.env }, (error) => {
            if (error) log("warn", "token-guard could not ask OpenClaw to check the Claude login again", { agentId, error: String(error.message || error).slice(0, 200) });
            else log("info", "token-guard asked OpenClaw to check the Claude login again", { agentId });
          });
      } catch (error) {
        log("warn", "token-guard could not ask OpenClaw to check the Claude login again", { agentId, error: String(error && error.message).slice(0, 200) });
      }
    };
    const safe = (name, fn) => (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        log("error", `token-guard ${name} failed`, { error: String(error && error.message) });
        return undefined;
      }
    };

    const store = createJobStore(jobsCfg.stateFile);
    store.load();
    // Another copy of the plugin may have written newer state (message ids, owner messages): read it first.
    let freshAt = 0;
    const fresh = () => {
      if (Date.now() - freshAt > 2000) {
        freshAt = Date.now();
        try { store.refresh(); } catch { /* best effort */ }
      }
      return store.data;
    };
    log("info", "token-guard registered", { boot: BOOT_ID, copy: crypto.randomUUID().slice(0, 8) });
    const ownerId = String(cfg.ownerId || "");
    const boardCfg = Object.assign({ enabled: true, agent: "product", auditEveryMinutes: 180, view: true }, cfg.board || {});
    const pm = boardCfg.agent || "product";
    const mirror = createMirror({ cfg: Object.assign({ orchestratorAgent: orchestrator, ownerId, pmAgent: pm }, cfg.mirror), log });
    const voice = mirror.cfg; // names, @handles and the owner's handle for the team's messages
    // Post as one agent's bot. say() resolves to the new message id (or null); post() fires and forgets.
    const say = (agentId, topic, text, opts = {}) => mirror.post(Object.assign({ agentId, topic, text }, opts)).catch(() => null);
    const post = (agentId, topic, text, opts) => { say(agentId, topic, text, opts); };
    const projects = cfg.projects || {};
    const topicsCfg = cfg.topics || {};
    const teamTopic = Number(topicsCfg.teamTopic || (cfg.mirror && cfg.mirror.systemTopic) || 160);
    const chatId = String(topicsCfg.chatId || (cfg.mirror && cfg.mirror.chatId) || "");

    // ---- the board ----
    const projectFor = (item) => projectsMentioned(` project: ${item && item.project} `, projects)[0] || String((item && item.project) || "").toLowerCase();
    const systemMove = (id, to, note) => runInbox(["set", id, "--status", to, "--by", "system", "--note", String(note || "").slice(0, 300)]).catch(() => null);
    const boardTimers = new Map();
    const refreshBoard = (project) => {
      if (!boardCfg.enabled || !boardCfg.view || !project) return;
      if (boardTimers.has(project)) return;
      boardTimers.set(project, setTimeout(() => {
        boardTimers.delete(project);
        try {
          const all = [...loadInboxItems().values()];
          const items = all.filter((it) => projectFor(it) === project);
          const topic = (projects[project] && projects[project].topic) || teamTopic;
          const text = renderBoard(project, items);
          upsertBoardMessage(`board:${project}`, topic, text);
          const byProject = {};
          for (const it of all) (byProject[projectFor(it) || "?"] = byProject[projectFor(it) || "?"] || []).push(it);
          upsertBoardMessage("board:team", teamTopic, renderOverview(byProject));
        } catch (error) {
          log("warn", "token-guard board refresh failed", { error: String(error && error.message) });
        }
      }, 20000));
    };
    const upsertBoardMessage = (key, topic, text) => {
      store.data.boardMessages = store.data.boardMessages || {};
      const prev = store.data.boardMessages[key];
      const hash = crypto.createHash("sha1").update(text.replace(/\d\d:\d\d UTC/, "")).digest("hex").slice(0, 12);
      if (prev && prev.hash === hash) return;
      const create = () => mirror.post({ agentId: orchestrator, topic, text }).then((id) => {
        if (typeof id === "number") {
          store.data.boardMessages[key] = { topic, messageId: id, hash };
          store.touch();
          store.save();
          mirror.pin({ agentId: orchestrator, messageId: id }).catch(() => null);
        }
      });
      if (prev && prev.messageId && Number(prev.topic) === Number(topic)) {
        mirror.edit({ agentId: orchestrator, messageId: prev.messageId, text }).then((ok) => {
          if (ok) { prev.hash = hash; store.touch(); } else create();
        });
      } else {
        create();
      }
    };
    const refreshItems = (ids) => {
      const board = loadInboxItems();
      for (const p of new Set(ids.map((id) => projectFor(board.get(id))).filter(Boolean))) refreshBoard(p);
    };

    // Rate-limited notes to the System topic (one per key per 30 minutes).
    const noted = new Map();
    const systemNote = (key, text, opts) => {
      const now = Date.now();
      if (now - (noted.get(key) || 0) < 30 * 60000) return;
      noted.set(key, now);
      post(orchestrator, "system", text, opts);
    };

    // ---- the conversation thread of each task: owner's request -> dispatch -> "on it" -> result -> orchestrator ----
    const threads = new Map(); // job key -> promise that settles when the dispatch (and ack) are posted
    const setJob = (key, fields) => {
      const j = store.data.jobs[key];
      if (!j) return;
      Object.assign(j, fields);
      store.touch();
      store.save();
    };
    const topicOfSession = (sessionKey) => {
      const m = /:topic:(\d+)/.exec(String(sessionKey || ""));
      return m ? Number(m[1]) : null;
    };
    const lastOwnerMessage = (topic, maxAgeMs) => {
      const last = (fresh().ownerMsgs || {})[String(topic)];
      return last && last.id && Date.now() - last.at < maxAgeMs ? last.id : null;
    };
    // The owner's message a dispatch answers: the item's recorded source, else the owner's latest message in that topic.
    const requestMessageFor = (topic, itemIds, board) => {
      for (const id of itemIds) {
        const m = /\btg:(\d+):(\d+)\b/.exec(String((board.get(id) || {}).source || ""));
        if (m && Number(m[1]) === Number(topic)) return Number(m[2]);
      }
      return lastOwnerMessage(topic, 60 * 60000);
    };
    // The newest worker result in a topic that the orchestrator has not answered yet (claimed once).
    const takePendingResult = (topic) => {
      const now = Date.now();
      let best = null;
      for (const j of Object.values(fresh().jobs)) {
        if (!j.resultMsgId || j.answeredAt || Number(j.topic) !== Number(topic) || now - (j.endedAt || 0) > 3 * 3600000) continue;
        if (!best || (j.endedAt || 0) > (best.endedAt || 0)) best = j;
      }
      if (best) { best.answeredAt = now; store.touch(); store.save(); }
      return best;
    };
    // The newest unanswered worker result on these items (claimed once): the orchestrator's next move
    // on an item is its answer to that result, so it is posted in the result's thread.
    const takeResultForItems = (ids, topic) => {
      const now = Date.now();
      let best = null;
      for (const j of Object.values(fresh().jobs)) {
        if (!j.resultMsgId || j.answeredAt || now - (j.endedAt || 0) > 6 * 3600000) continue;
        if (topic && Number(j.topic) !== Number(topic)) continue;
        if (!(j.items || []).some((id) => ids.includes(id))) continue;
        if (!best || (j.endedAt || 0) > (best.endedAt || 0)) best = j;
      }
      if (best) { best.answeredAt = now; store.touch(); store.save(); }
      return best;
    };
    // The orchestrator moved an item but did not answer the worker: after a short wait (it may still
    // write its own reply), its board note is posted as the answer under the worker's result.
    const answerBoardMove = (ids, status, note) => {
      if (!ids.length || !status) return;
      const t = setTimeout(() => {
        try {
          for (const id of ids) {
            const job = takeResultForItems([id]);
            if (job) post(orchestrator, job.topic, boardReplyText(voice, job, id, normStatus(status), note), { html: true, replyTo: job.resultMsgId });
          }
        } catch (error) {
          log("warn", "token-guard board reply failed", { error: String(error && error.message) });
        }
      }, 3 * 60000);
      if (t && typeof t.unref === "function") t.unref();
    };
    const withMention = (text, agentId) => {
      const h = handleOf(voice, agentId);
      const t = String(text === undefined || text === null ? "" : text);
      if (!h.startsWith("@") || !t.trim() || t.includes(h)) return t;
      return `${h} ${t}`;
    };
    // Runs in which the orchestrator sent its final reply with the message tool, to the conversation it answers.
    const answeredByTool = new Map();
    const isFinalReplySend = (p, event) => {
      p = p || {};
      if (String(p.action || "send") !== "send" || !/^(true|1)$/i.test(String(p.final))) return false;
      if (p.target || p.to || p.chatId || p.channelId || p.threadId) return false; // sent elsewhere: its own text still answers here
      if (event && event.error) return false;
      return !/"(ok)"\s*:\s*false|"status"\s*:\s*"error"/.test(JSON.stringify((event && event.result) || ""));
    };
    // An orchestrator post in a project topic answers the newest unanswered result there, and mentions its worker.
    const threadOrchestratorPost = (p) => {
      if (!p || p.replyTo || String(p.action || "send") !== "send") return null;
      const chat = String(p.target || p.to || p.chatId || "");
      if (!chatId || !chat.includes(chatId)) return null;
      const topic = Number(p.threadId || p.messageThreadId || 0);
      if (!topic || topic <= 1) return null;
      const pending = takePendingResult(topic);
      if (!pending) return null;
      const field = p.message !== undefined ? "message" : p.content !== undefined ? "content" : p.text !== undefined ? "text" : "message";
      return Object.assign({}, p, { replyTo: String(pending.resultMsgId), [field]: withMention(p[field], pending.agentId) });
    };
    // Board items the orchestrator records from a topic remember the owner's message they came from.
    const withSource = (p, sessionKey) => {
      const topic = topicOfSession(sessionKey);
      const id = topic ? lastOwnerMessage(topic, 2 * 3600000) : null;
      if (!id) return null;
      const out = Object.assign({}, p);
      if (!/\btg:\d+:\d+\b/.test(String(p.source || ""))) out.source = `${p.source ? `${p.source} ` : ""}tg:${topic}:${id}`.trim();
      // The owner's exact words are the spec; they travel with the item into every brief.
      const asks = (fresh().ownerAsks || []).filter((a) => a.topic === topic && Date.now() - a.at < 2 * 3600000);
      const words = String((asks.length ? asks[asks.length - 1].text : ((store.data.ownerMsgs || {})[String(topic)] || {}).text) || "").trim();
      if (words && !/Owner said: «/.test(String(p.details || ""))) out.details = `Owner said: «${words}»\n${p.details || ""}`.trim();
      return out;
    };
    // Every brief carries, for each of its items, the owner's exact words and what happened on it before.
    const withOwnerWords = (p) => {
      const ids = itemsFromBrief(String(p.task || ""));
      if (!ids.length || /The owner's exact words/.test(String(p.task || ""))) return null;
      const board = loadInboxItems();
      const parts = [];
      for (const id of ids) {
        const it = board.get(id);
        if (!it) continue;
        const said = /Owner said: «([\s\S]*?)»/.exec(String(it.details || ""));
        const past = (it.history || []).filter((h) => h.note && h.by !== "system").slice(-4).map((h) => `  - ${h.from} -> ${h.to}: ${String(h.note).slice(0, 240)}`);
        const noteNow = String(it.note || "").trim();
        parts.push(`- ${id} ${it.title || ""}${said ? `\n  Owner said: «${said[1].slice(0, 1200)}»` : ""}` +
          `${noteNow ? `\n  Latest note on the item: ${noteNow.slice(0, 900)}` : ""}${past.length ? `\n  Earlier on this item:\n${past.join("\n")}` : ""}`);
      }
      if (!parts.length) return null;
      return Object.assign({}, p, { task: `${p.task}\n\nThe owner's exact words (this is the spec: do exactly this, keep the change minimal, and do not redo work that is already right):\n${parts.join("\n")}` });
    };
    // Every brief names the skills of that agent that fit the task (from openclaw-team's skill catalog).
    const withSkills = (p) => {
      const catalog = (cfg.skills || {})[String(p.agentId || "")];
      if (!Array.isArray(catalog) || !catalog.length || /Skills for this task/.test(String(p.task || ""))) return null;
      const line = skillsLine(selectSkills(String(p.task || ""), catalog));
      return line ? Object.assign({}, p, { task: `${p.task}\n\n${line}` }) : null;
    };
    // After the orchestrator approves checked work, ask the owner once (archiving needs both approvals).
    const askOwnerToApprove = (ids) => {
      const board = loadInboxItems();
      fresh();
      store.data.askedApproval = store.data.askedApproval || {};
      const byTopic = new Map();
      for (const id of ids) {
        const it = board.get(id);
        if (!it || !["done", "dropped"].includes(normStatus(it.status)) || !it.orc_approved_ts || it.owner_approved_ts) continue;
        if ((store.data.askedApproval[id] || 0) >= (Date.parse(it.orc_approved_ts) || 0)) continue;
        store.data.askedApproval[id] = Date.now();
        const project = projectFor(it);
        const topic = Number((projects[project] && projects[project].topic) || teamTopic);
        if (!byTopic.has(topic)) byTopic.set(topic, []);
        byTopic.get(topic).push(it);
      }
      store.touch();
      for (const [topic, items] of byTopic) {
        const src = items.length === 1 ? /\btg:(\d+):(\d+)\b/.exec(String(items[0].source || "")) : null;
        post(orchestrator, topic, approvalAskText(voice, items), { html: true, replyTo: src && Number(src[1]) === topic ? Number(src[2]) : null });
      }
    };

    // Items a task is working on, or whose pipeline the CI watch is waiting for. Read from the shared
    // state (another copy of the plugin may have ended the wait), and a CI wait holds its item only
    // while the item is still in hand (In progress, Review, QA): moved to Blocked, To do or Done, it
    // is free again.
    const inHand = (id, board) => { const it = board.get(id); return !it || ACTIVE.has(normStatus(it.status)); };
    // A task over its budget or time may only write its final answer: it holds no item and no agent slot, so a
    // fresh spawn for its item is accepted at once. (2026-11-13: a reviewer's job stayed "running" for half an
    // hour after its time was up, and every re-dispatch of its item was refused as "already being worked on".)
    const holdsWork = (j) => j && j.status === "running" && !j.overBudget && !j.timeUp;
    const runningItemIds = () => {
      const ids = new Set();
      const jobs = Object.values(fresh().jobs);
      let board = null;
      for (const j of jobs) {
        if (j.status === "running") { if (holdsWork(j)) for (const id of j.items || []) ids.add(id); continue; }
        if (!j.waitFor || j.waitFor.done) continue;
        if (!board) { try { board = loadInboxItems(); } catch { board = new Map(); } }
        for (const id of j.items || []) if (inHand(id, board)) ids.add(id);
      }
      return ids;
    };
    const queueCfg = { wip: Number.isFinite(Number((cfg.board || {}).wip)) ? Number(cfg.board.wip) : 1, projectOrder: (cfg.board || {}).projectOrder || [],
      maxTasksByAgent: (cfg.board || {}).maxTasksByAgent || {} };
    // Running tasks per agent, from the shared state (another plugin copy may have started one).
    const runningByAgent = () => {
      const n = {};
      for (const j of Object.values(fresh().jobs)) if (holdsWork(j) && j.agentId) n[j.agentId] = (n[j.agentId] || 0) + 1;
      return n;
    };
    const maxNoProgress = boardCfg.maxNoProgress === undefined ? 3 : Number(boardCfg.maxNoProgress) || 0;
    const streakOf = (id, item, jobs) => noProgressStreak(jobs || Object.values(fresh().jobs), id, item, Date.now());
    const queueNow = (inboxItems) => {
      const jobs = maxNoProgress > 0 ? Object.values(fresh().jobs) : null; // read once for the whole queue
      return queueState(inboxItems, Object.assign({}, queueCfg, { running: runningByAgent(),
        stuck: jobs ? (it) => streakOf(it.id, it, jobs) >= maxNoProgress : null }));
    };
    const orcRunCalls = new Map(); // orchestrator run id -> tool calls so far
    const countOrcCall = (runId) => {
      if (!runId) return;
      orcRunCalls.set(runId, (orcRunCalls.get(runId) || 0) + 1);
      if (orcRunCalls.size > 200) orcRunCalls.delete(orcRunCalls.keys().next().value);
    };
    const pstate = {
      get claudeLimitedUntil() { return store.data.claudeLimitedUntil || 0; },
      get codexLimitedUntil() { return store.data.codexLimitedUntil || 0; },
      // The deploy script touches this file before it stops the gateway (and removes it once it is back).
      maintenanceSince: () => {
        try { return fs.statSync(String(jobsCfg.stateFile).replace(/^~/, process.env.HOME || "").replace(/[^/]+$/, "maintenance")).mtimeMs; } catch { return 0; }
      },
      boardItems: () => loadInboxItems(),
      runningItemIds,
      jobFor: (sessionKey) => {
        const job = store.data.jobs[sessionKey];
        return job && job.status === "running" ? job : null;
      },
      // Any job by its session key, running or not (a follow-up must not go into a spent session).
      jobOf: (sessionKey) => fresh().jobs[sessionKey] || null,
      runCalls: (runId) => (runId && orcRunCalls.get(runId)) || 0,
      queue: () => queueNow(loadInboxItems()),
      runningTasks: (agentId) => runningByAgent()[agentId] || 0,
      noProgressStreak: (id, item) => streakOf(id, item),
      onBlock: (rule, info) => {
        if (["protectedFile", "protectedConfig", "backChannel", "spawnByWorker", "sendByWorker", "orchestratorOnly", "modelPin"].includes(rule)) {
          systemNote(`${rule}:${info.agentId}`, guardText(voice, rule, info), { html: true });
        }
      },
      onNote: (text) => systemNote("spawn-note", `🔀 ${text}`),
    };

    // A usage limit belongs to the provider that reported it: Codex limits must not be taken for
    // Claude's (that once routed every task into the exhausted Codex).
    const useCodex = codexEnabled(cfg); // off unless spawn.codexModel is set: Claude's limit then means "wait"
    const markLimited = (text, source) => {
      if (!isLimitError(text) && !/usage limit/i.test(String(text))) return;
      const until = limitResetAt(text);
      const codex = /codex|openai|chatgpt|gpt-\d/i.test(String(text));
      if ((codex ? setCodexLimited : setClaudeLimited)(store.data, until, text)) {
        store.touch();
        store.save();
        log("info", `token-guard: ${codex ? "Codex" : "Claude"} limit`, { source, text: String(text).slice(0, 160) });
        if (!codex || useCodex) post(orchestrator, "system", limitText(voice, until, codex ? "codex" : "claude", cfg.spawn), { html: true });
      }
    };
    // This copy of the plugin may not know a task another copy started: read the shared state first.
    const knowJob = (key) => {
      if (key && !store.data.jobs[key] && String(key).includes(":subagent:")) fresh();
      return key ? store.data.jobs[key] : undefined;
    };

    // Dispatch details from the spawn call, matched to the child when it starts.
    const pending = [];
    const rememberSpawn = (params, ctx) => {
      pending.push({
        at: Date.now(),
        agentId: String(params.agentId || ""),
        label: String(params.label || ""),
        brief: String(params.task || ""),
        model: params.model ? String(params.model) : "",
        thinking: params.thinking ? String(params.thinking) : "",
        runTimeoutSeconds: Number(params.runTimeoutSeconds) || 0,
        requesterSessionKey: (ctx && ctx.sessionKey) || "",
      });
      while (pending.length > 50 || (pending.length && Date.now() - pending[0].at > 30 * 60000)) pending.shift();
    };
    const takePending = (agentId, label) => {
      let i = pending.findIndex((p) => p.agentId === agentId && (!label || p.label === label));
      if (i < 0) i = pending.findIndex((p) => p.agentId === agentId);
      return i >= 0 ? pending.splice(i, 1)[0] : null;
    };

    const startJob = (childSessionKey, agentId, label, requesterSessionKey, requesterThread) => {
      if (!childSessionKey || store.data.jobs[childSessionKey]) return store.data.jobs[childSessionKey];
      const p = takePending(agentId, label) || {};
      const project = firstLine(p.brief, "Project");
      const board = loadInboxItems();
      const items = itemsFromBrief(p.brief).filter((id) => board.has(id));
      const job = recordSpawn(store.data, {
        childSessionKey,
        agentId,
        label: label || p.label,
        project,
        topic: topicFor(cfg.mirror, project, requesterThread),
        requesterSessionKey: requesterSessionKey || p.requesterSessionKey,
        model: p.model,
        thinking: p.thinking,
        runTimeoutSeconds: p.runTimeoutSeconds,
        doneWhen: firstLine(p.brief, "Done when"),
        brief: p.brief,
        items,
      }, BOOT_ID, Date.now(), jobsCfg);
      store.touch();
      store.save();
      if (job) {
        const key = childSessionKey;
        // The next agent on an item answers the previous worker's result in its thread.
        const prior = items.length ? takeResultForItems(items, job.topic) : null;
        const replyTo = prior ? prior.resultMsgId : requestMessageFor(job.topic, items, board);
        if (replyTo) setJob(key, { requestMsgId: replyTo });
        const thread = voice.resultsOnly ? Promise.resolve(null) : say(orchestrator, job.topic, dispatchText(voice, store.data.jobs[key] || job), { html: true, replyTo })
          .then((id) => {
            if (typeof id !== "number") return null;
            setJob(key, { dispatchMsgId: id });
            if (voice.acks === false) return id;
            return say(agentId, job.topic, ackText(voice, job), { html: true, replyTo: id }).then((ackId) => {
              if (typeof ackId === "number") setJob(key, { ackMsgId: ackId });
              return id;
            });
          });
        threads.set(key, thread);
        const moves = items.filter((id) => ["backlog", "todo", "blocked"].includes(normStatus(board.get(id).status)))
          .map((id) => systemMove(id, "in_progress", `dispatched to ${agentId} [job ${job.short}]`));
        Promise.all(moves).then(() => refreshItems(items));
      }
      return job;
    };

    // ---- every tool call ----
    api.on(
      "before_tool_call",
      (event, ctx) => {
        try {
          const now = Date.now();
          knowJob(ctx && ctx.sessionKey);
          if (recordActivity(store.data, ctx && ctx.sessionKey, ctx && ctx.agentId, orchestrator, now)) store.touch();
          // Budgets count tool calls: the Claude CLI reports almost no token usage to plugins.
          if (ctx && ctx.agentId === orchestrator) countOrcCall(ctx.runId);
          const bareName = String(event.toolName || "").split("__").pop();
          if (bareName === "exec" && CHECK_COMMAND.test(String((event.params && event.params.command) || ""))) recordCheck(store.data, ctx && ctx.sessionKey);
          if (bareName === "exec" && GRAPH_COMMAND.test(String((event.params && event.params.command) || "")) && recordGraph(store.data, ctx && ctx.sessionKey)) {
            log("info", "token-guard: the task queried its code map; searching and reading code is open", { sessionKey: ctx && ctx.sessionKey });
            store.touch();
          }
          const spent = recordCall(store.data, ctx && ctx.sessionKey, jobsCfg);
          if (spent) {
            store.save();
            post(pm, spent.topic || "system", budgetText(voice, spent, `${callBudget(jobsCfg, spent.agentId)} tool calls`), { html: true, replyTo: spent.dispatchMsgId || null });
          }
          const late = recordTime(store.data, ctx && ctx.sessionKey, jobsCfg, now);
          if (late) {
            store.save();
            log("info", "token-guard: a task is near its time limit; it may only write its final answer", { agentId: late.agentId, sessionKey: ctx && ctx.sessionKey, label: late.label });
          }
          // A dispatch brief missing a required line is completed from its board items.
          let base = event;
          if (event.toolName === "sessions_spawn" && ctx && ctx.agentId === orchestrator && event.params && event.params.task) {
            const task = completeBrief(event.params.task, loadInboxItems());
            if (task !== event.params.task) base = Object.assign({}, event, { params: Object.assign({}, event.params, { task }) });
          }
          // Secrets first, for every agent: nothing carries a secret out, nothing prints the secrets folder.
          const sec = secretDecide(base, ctx, cfg, log);
          if (sec && sec.block) return { block: true, blockReason: sec.blockReason };
          const pol = policyDecide(base, ctx, pstate, cfg, log, now);
          if (pol && pol.block) return { block: true, blockReason: pol.blockReason };
          const rewritten = pol && pol.params ? Object.assign({}, base, { params: pol.params }) : base;
          const res = decide(rewritten, ctx, state, cfg, log, now);
          if (res && res.block) return res;
          let params = (res && res.params) || (pol && pol.params) || (base !== event ? base.params : undefined);
          if (event.toolName === "sessions_spawn" && ctx && ctx.agentId === orchestrator) {
            params = withOwnerWords(params || event.params || {}) || params;
            params = withSkills(params || event.params || {}) || params;
            rememberSpawn(params || event.params || {}, ctx);
          }
          const bare = String(event.toolName || "").split("__").pop();
          if (ctx && ctx.agentId === orchestrator && bare === "message") params = threadOrchestratorPost(params || event.params || {}) || params;
          if (ctx && (ctx.agentId === orchestrator || ctx.agentId === pm) && bare === "task_inbox" && String((params || event.params || {}).action || "") === "add") {
            params = withSource(params || event.params || {}, ctx.sessionKey) || params;
          }
          return params ? { params } : undefined;
        } catch (error) {
          // before_tool_call fails closed on a thrown error; fail open instead so a
          // guard bug can never block every tool call.
          log("error", "token-guard internal error; allowing the call", { error: String(error && error.message) });
          return undefined;
        }
      },
      { priority: 50 },
    );

    // The spawn result carries the child session key; use it when subagent_spawned is not emitted.
    api.on("after_tool_call", safe("after_tool_call", (event, ctx) => {
      const bare = String(event.toolName || "").split("__").pop();
      if (bare === "message" && ctx && ctx.agentId === orchestrator && ctx.runId) {
        if (isFinalReplySend(event.params, event)) {
          answeredByTool.set(String(ctx.runId), Date.now());
          if (answeredByTool.size > 200) answeredByTool.delete(answeredByTool.keys().next().value);
        }
        return;
      }
      if (bare === "task_inbox") {
        const action = String((event.params && event.params.action) || "");
        if (["add", "set", "approve"].includes(action)) {
          if (action === "add") markAskCaptured(ctx && ctx.sessionKey);
          const ids = String((event.params && event.params.id) || "").match(/\b[0-9a-f]{8}\b/g) || [];
          const out = JSON.stringify(event.result || "").match(/\b[0-9a-f]{8}\b/g) || [];
          refreshItems([...ids, ...out]);
          if (action === "approve" && ctx && ctx.agentId === orchestrator) askOwnerToApprove(ids);
          if (action === "set" && ctx && ctx.agentId === orchestrator && event.params && event.params.status) {
            answerBoardMove(ids, String(event.params.status), event.params.note);
          }
        }
        return;
      }
      if (bare !== "sessions_spawn" || !ctx || ctx.agentId !== orchestrator) return;
      let r = event.result;
      if (r && Array.isArray(r.content)) r = r.content.map((c) => c && c.text).join("\n");
      if (typeof r === "string") { try { r = JSON.parse(r.slice(r.indexOf("{"))); } catch { r = null; } }
      // The runtime refused the dispatch (the guard's own blocks are plain text and never get here):
      // log it so the health check sees it, and say the real error in the team topic once per 30 min.
      if (r && r.status === "error" && r.error) {
        const target = String((event.params && event.params.agentId) || r.role || "");
        const error = String(r.error).replace(/\s+/g, " ").slice(0, 300);
        log("warn", "token-guard: dispatch failed", { agentId: target, error });
        forgetRefusedBrief(state, target);
        const until = (store.data.claudeLimitedUntil || 0) > Date.now() ? store.data.claudeLimitedUntil : 0;
        const retry = !until && refusalCfg.enabled && isLoginRefusal(error) && target;
        if (retry && recordRefusal(store.data, target, error, Date.now())) {
          recheckLogin(target);
          store.touch();
          store.save();
        }
        systemNote(`spawn-error:${error.replace(/"[^"]*"/g, "").slice(0, 80)}`, spawnErrorText(voice, target, error, until, retry ? refusalCfg.retryAfterSeconds : 0), { html: true });
        return;
      }
      const key = r && (r.childSessionKey || (r.details && r.details.childSessionKey));
      if (key) {
        dispatchWent(String((event.params && event.params.agentId) || ""));
        startJob(key, String((event.params && event.params.agentId) || ""), String((event.params && event.params.label) || ""), ctx.sessionKey, null);
      }
    }));

    // A dispatch to this agent went through: a refusal it still had open needs no retry wake.
    const dispatchWent = (agentId) => {
      if (!agentId || !closeRefusals(store.data, agentId, Date.now())) return;
      log("info", "token-guard: a refused dispatch went through when sent again; no retry wake", { agentId });
      store.touch();
      store.save();
    };

    api.on("subagent_spawned", safe("subagent_spawned", (event, ctx) => {
      dispatchWent(event.agentId);
      startJob(event.childSessionKey, event.agentId, event.label, ctx && ctx.requesterSessionKey, event.requester && event.requester.threadId);
      const job = store.data.jobs[event.childSessionKey];
      if (job && event.resolvedModel && !job.model) { job.model = event.resolvedModel; store.touch(); }
    }));

    api.on("agent_end", safe("agent_end", (event, ctx) => {
      const key = ctx && ctx.sessionKey;
      if (!key) return;
      const now = Date.now();
      knowJob(key);
      if (recordActivity(store.data, key, ctx.agentId, orchestrator, now)) store.touch();
      if (event && event.error) markLimited(event.error, ctx.agentId || "agent");
      const job = store.data.jobs[key];
      if (job) {
        const text = lastAssistantText(event && event.messages);
        if (recordResultText(store.data, key, text, jobsCfg)) store.touch();
        else if (!job.resultText) {
          const last = Array.isArray(event && event.messages) ? event.messages[event.messages.length - 1] : undefined;
          log("info", "token-guard: no final text in agent_end", { messages: Array.isArray(event && event.messages) ? event.messages.length : -1, lastKeys: last && typeof last === "object" ? Object.keys(last).slice(0, 8) : typeof last });
        }
      }
    }));

    // The child's run itself ending, with its real outcome (subagent_ended later says "deleted"
    // when the finished session is cleaned up). The job ends here at once: its session can run nothing more
    // (follow-ups go to a fresh session), and waiting for an end event held its item for 10+ minutes.
    api.on("subagent_progress", safe("subagent_progress", (event) => {
      const key = event && event.childSessionKey;
      if (!key || !knowJob(key)) return;
      if (recordProgress(store.data, key, event.phase, event.outcome, Date.now())) { store.touch(); store.save(); }
      if (event.phase === "ended") endJob(key, event.outcome || "ok", "", Date.now());
    }));

    api.on("subagent_ended", safe("subagent_ended", (event) => {
      if (event.error) markLimited(event.error, "task");
      endJob(event.targetSessionKey, event.outcome, event.error, event.endedAt || Date.now());
    }));
    // A task ends: post the worker's result, move its items, follow its CI. Called by subagent_ended,
    // and by the tick when the run ended but no end event came (the orchestrator sent the finished
    // task a follow-up with sessions_send: those runs never send subagent_ended).
    const endJob = (key, outcome, error, endedAt) => {
      knowJob(key);
      const job = recordEnd(store.data, key, outcome, error, endedAt);
      if (!job) return;
      store.touch();
      store.save(); // its item is free from now on (the dispatch check reads the saved state), not after its result is fetched
      const finish = () => {
        store.save();
        const cur = store.data.jobs[key] || job;
        // Proof that is cited must exist: a PASS resting on missing screenshots is no proof.
        const missing = missingProof(cur.resultText, (f) => fs.existsSync(f.replace(/^~/, process.env.HOME || "")));
        if (missing.length) { cur.missingEvidence = missing; store.touch(); }
        let verdict = resultVerdict(cur.resultText, cur.outcome);
        if (verdict === "waiting") {
          const link = parseCiLink(cur.resultText);
          if (link) { cur.waitFor = Object.assign(link, { since: Date.now() }); store.touch(); store.save(); }
          else verdict = "unknown";
        }
        const board = loadInboxItems();
        const plan = (cur.items || []).filter((id) => board.has(id)).map((id) => {
          const before = normStatus(board.get(id).status);
          return { id, before, to: nextAfterJob(before, cur.agentId, verdict) };
        }).filter((m) => m.to !== m.before);
        // The worker answers its dispatch, from its own bot, once the dispatch is posted. With results only, a
        // "CI is running" step is not posted: the guard follows the pipeline and the item's real result comes later.
        Promise.resolve(threads.get(key)).catch(() => null).then(() => {
          threads.delete(key);
          if (voice.resultsOnly && verdict === "waiting") return null;
          const j = fresh().jobs[key] || cur;
          return say(j.agentId, j.topic, resultText(voice, j, verdict, plan), { html: true, replyTo: j.dispatchMsgId || j.requestMsgId || null });
        }).then((id) => { if (typeof id === "number") setJob(key, { resultMsgId: id }); });
        Promise.all(plan.map((m) => systemMove(m.id, m.to, `${cur.agentId} task ended: ${verdict} [job ${cur.short}]`)))
          .then(() => refreshItems(cur.items || []));
      };
      if (job.resultText || !api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.getSessionMessages !== "function") return finish();
      api.runtime.subagent.getSessionMessages({ sessionKey: key, limit: 8 })
        .then((res) => { recordResultText(store.data, key, lastAssistantText(res && res.messages), jobsCfg); })
        .catch(() => {})
        .finally(finish);
    };

    // ---- secrets: no message, reply or transcript keeps a secret value ----
    api.on("message_sending", safe("message_sending:secrets", (event, ctx) => {
      const hit = findSecret(event && event.content, cfg);
      if (!hit) return undefined;
      log("warn", "token-guard refused a message that contains a secret", { secret: hit.name, to: event.to, threadId: event.threadId, agentId: ctx && ctx.agentId });
      return { cancel: true, cancelReason: `token-guard: the message contains a secret (${hit.name}); it was not sent` };
    }), { priority: 100 });
    api.on("reply_payload_sending", safe("reply_payload_sending:secrets", (event, ctx) => {
      const payload = (event && event.payload) || {};
      const hit = findSecret(JSON.stringify(payload), cfg);
      if (!hit) return undefined;
      log("warn", "token-guard refused a reply that contains a secret", { secret: hit.name, sessionKey: ctx && ctx.sessionKey });
      return { cancel: true };
    }), { priority: 100 });
    // Sync hooks: a secret printed by a tool or written by a model is stored as [REDACTED:<name>].
    api.on("tool_result_persist", safe("tool_result_persist:secrets", (event) => {
      const message = event && event.message;
      const out = redactDeep(message, cfg);
      return out !== message ? { message: out } : undefined;
    }), { priority: 100 });
    api.on("before_message_write", safe("before_message_write:secrets", (event) => {
      const message = event && event.message;
      const out = redactDeep(message, cfg);
      return out !== message ? { message: out } : undefined;
    }), { priority: 100 });

    // ---- topics: a reply that belongs in another topic is cancelled and reposted there ----
    const pointed = new Set();
    const limitReplies = new Map(); // destination -> limit reset time
    api.on("message_sending", safe("message_sending", (event, ctx) => {
      // While Claude's usage limit holds, OpenClaw answers every message with "⚠️ OpenClaw couldn't finish this reply ..."
      // (2026-11-12: the owner got it three times in two minutes and read it as broken). Say what it is and until when;
      // the orchestrator answers the owner's messages once the limit clears.
      if (isRunFailureReply(event && event.content)) {
        const s = fresh();
        const until = (s.claudeLimitedUntil || 0) > Date.now() ? s.claudeLimitedUntil : 0;
        if (!until) return undefined; // another failure: OpenClaw's own notice stands
        if (ownerId && String(event.to || "").split(":").pop() === ownerId) {
          store.data.ownerLimitNoticeAt = Date.now();
          store.touch();
          store.save();
        }
        log("info", "token-guard replaced OpenClaw's failed-reply notice with the usage-limit notice", { to: event.to, threadId: event.threadId });
        return { content: limitHoldText(voice, until) };
      }
      // At a usage limit every message gets the same error back; one per chat and topic says it.
      if (isLimitReply(event && event.content)) {
        const dest = `${(ctx && ctx.accountId) || ""}:${event.to || ""}:${event.threadId || ""}`;
        if (!allowLimitReply(limitReplies, dest, event.content)) {
          log("info", "token-guard held back a repeated usage-limit reply", { to: event.to, threadId: event.threadId });
          return { cancel: true, cancelReason: "token-guard: this chat was already told about the usage limit" };
        }
        return undefined;
      }
      if (!topicsCfg.enabled || !chatId || !ctx || ctx.channelId !== "telegram") return undefined;
      const sessionKey = String((ctx && ctx.sessionKey) || "");
      const fromOrc = sessionKey.startsWith(`agent:${orchestrator}:`);
      // The owner's private chat with the orchestrator (a Telegram DM's chat id is the owner's user id).
      const toOwner = !!ownerId && String(event.to || "").split(":").pop() === ownerId;
      if (!String(event.to || "").includes(chatId) && !toOwner) return undefined;
      const current = toOwner || isGeneral(event.threadId) ? null : Number(event.threadId);
      // The orchestrator answering a result: the answer belongs in that task's project topic, under the
      // worker's result, even when the task was dispatched from another topic's session.
      const pendingAnswer = (newerThan = 0) => {
        const now = Date.now();
        return Object.values(fresh().jobs)
          .filter((j) => j.requesterSessionKey === sessionKey && j.resultMsgId && !j.answeredAt && j.topic && Number(j.topic) !== current &&
            now - (j.endedAt || 0) < 3 * 3600000 && (j.endedAt || 0) > newerThan)
          .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0];
      };
      const moveAnswer = (job) => {
        job.answeredAt = Date.now();
        store.touch();
        store.save();
        mirror.post({ accountId: ctx.accountId, topic: job.topic, text: mdToHtml(withMention(event.content, job.agentId), 3500), html: true, replyTo: job.resultMsgId }).catch(() => null);
        log("info", "token-guard moved an answer to its task's topic", { from: toOwner ? "owner chat" : current, to: job.topic });
        return { cancel: true, cancelReason: `token-guard: answers a result in topic ${job.topic}; reposted there` };
      };
      if (toOwner) {
        // A task dispatched while talking to the owner reports back into the owner's chat, and the
        // orchestrator's answer to that result went to the owner instead of the task's thread (and the
        // result stayed "unanswered", so the guard woke it again). Answers to the owner stay: a reply to
        // the owner's message, a send that does not name its session (OpenClaw's replies to an inbound
        // message), and any message while no result is newer than the owner's last message.
        if (event.replyToId || !fromOrc) return undefined;
        const ownerAt = Number(((fresh().ownerMsgs || {})["1"] || {}).at) || 0;
        const job = pendingAnswer(ownerAt);
        return job ? moveAnswer(job) : undefined;
      }
      if (fromOrc && !event.replyToId) {
        const job = pendingAnswer();
        if (job) return moveAnswer(job);
      }
      const right = correctTopic({ threadId: event.threadId, text: event.content, projects, teamTopic, keep: topicsCfg.keepTopics });
      if (!right.topic || right.topic === current) return undefined;
      mirror.post({ accountId: ctx.accountId, topic: right.topic, text: mdToHtml(event.content, 3500), html: true }).catch(() => null);
      const pointerKey = `${ctx.runId || ctx.sessionKey || ""}:${current}`;
      if (!pointed.has(pointerKey)) {
        pointed.add(pointerKey);
        if (pointed.size > 500) pointed.clear();
        mirror.post({ accountId: ctx.accountId, topic: current || 1, text: movedText(voice, right.project), html: true }).catch(() => null);
      }
      log("info", "token-guard moved a reply to its topic", { from: current, to: right.topic, accountId: ctx.accountId });
      return { cancel: true, cancelReason: `token-guard: belongs in topic ${right.topic}; reposted there` };
    }));

    // ---- the orchestrator's own replies in a project topic answer the worker's result they follow ----
    api.on("reply_payload_sending", safe("reply_payload_sending", (event, ctx) => {
      const sessionKey = String((event && event.sessionKey) || (ctx && ctx.sessionKey) || "");
      // It already answered in this run with the message tool, marked final: its closing text repeats that answer
      // ("I sent you ..."), and the owner got every answer twice. OpenClaw drops it only when the words are the same.
      const runId = String((event && event.runId) || (ctx && ctx.runId) || "");
      if (runId && answeredByTool.has(runId) && sessionKey.startsWith(`agent:${orchestrator}:`) && (!event.kind || ["final", "block"].includes(event.kind))) {
        const p = (event && event.payload) || {};
        if (!p.mediaUrl && !(Array.isArray(p.mediaUrls) && p.mediaUrls.length)) {
          log("info", "token-guard dropped the orchestrator's closing text: it already answered with the message tool", { sessionKey, text: String(p.text || "").slice(0, 80) });
          return { cancel: true };
        }
      }
      if (!chatId || !sessionKey.startsWith(`agent:${orchestrator}:`) || !sessionKey.includes(chatId)) return undefined;
      if (event.channel && event.channel !== "telegram") return undefined;
      if (event.kind && !["final", "block"].includes(event.kind)) return undefined;
      const payload = (event && event.payload) || {};
      if (payload.replyToId || !String(payload.text || "").trim()) return undefined; // already answers the owner's message
      const topic = topicOfSession(sessionKey);
      const pending = topic && topic > 1 ? takePendingResult(topic) : null;
      if (!pending) return undefined;
      return { payload: Object.assign({}, payload, { replyToId: String(pending.resultMsgId), text: withMention(payload.text, pending.agentId) }) };
    }));

    // ---- owner messages: approvals to archive, and requests the board must capture ----
    const markAskCaptured = (sessionKey) => {
      const m = /:topic:(\d+)/.exec(String(sessionKey || ""));
      const topic = m ? Number(m[1]) : null;
      const asks = store.data.ownerAsks || [];
      const ask = asks.find((a) => !a.captured && (topic === null || a.topic === topic));
      if (ask) { ask.captured = true; store.touch(); }
    };
    api.on("message_received", safe("message_received", (event, ctx) => {
      if (!ownerId || String(event.senderId || "") !== ownerId) return;
      if (ctx && ctx.channelId && ctx.channelId !== "telegram") return;
      const topic = isGeneral(event.threadId) ? 1 : Number(event.threadId);
      const msgId = messageIdOf(event.messageId || (ctx && ctx.messageId));
      if (msgId && topic) {
        store.data.ownerMsgs = store.data.ownerMsgs || {};
        store.data.ownerMsgs[String(topic)] = { id: msgId, at: Date.now(), text: String(event.content || "").slice(0, 1500) };
        store.touch();
        store.save();
      }
      const approval = parseApproval(event.content);
      if (approval) {
        const board = loadInboxItems();
        const project = projectOfTopic(projects, topic);
        const ids = approval.all
          ? [...board.values()].filter((it) => ["done", "dropped"].includes(normStatus(it.status)) && (!project || project === "team" || projectFor(it) === project)).map((it) => it.id)
          : approval.ids.filter((id) => board.has(id));
        if (ids.length) {
          runInbox(["approve", ...ids, "--by", "owner"]).then(() => {
            const after = loadInboxItems();
            const archived = [], waiting = [], notDone = [];
            for (const id of ids) {
              const it = after.get(id) || { id };
              const st = normStatus(it.status);
              if (st === "archived") archived.push(it);
              else if (["done", "dropped"].includes(st) && it.owner_approved_ts) waiting.push(it);
              else notDone.push(it);
            }
            post(orchestrator, topic > 1 ? topic : teamTopic, approvalReplyText(voice, archived, waiting, notDone), { html: true, replyTo: topic > 1 ? msgId : null });
            refreshItems(ids);
          });
        }
        return;
      }
      if (looksLikeRequest(event.content)) {
        store.data.ownerAsks = (store.data.ownerAsks || []).slice(-49);
        const held = (store.data.claudeLimitedUntil || 0) > Date.now() ? store.data.claudeLimitedUntil : 0; // nobody can act before then
        store.data.ownerAsks.push({ at: Date.now(), topic, text: String(event.content).slice(0, 1500), captured: false, heldUntil: held });
        store.touch();
      }
    }));

    api.on("llm_output", safe("llm_output", (event, ctx) => {
      const key = ctx && ctx.sessionKey;
      // The worker's latest text, so the result is known even if agent_end carries none.
      const job = knowJob(key);
      if (key && recordActivity(store.data, key, ctx.agentId, orchestrator, Date.now())) store.touch(); // a model call is work too
      const texts = event && Array.isArray(event.assistantTexts) ? event.assistantTexts.filter((t) => typeof t === "string" && t.trim()) : [];
      if (job && texts.length && recordResultText(store.data, key, finalAnswer(texts), jobsCfg)) store.touch();
      // A normal answer after a recorded Claude limit: the limit is gone, so tasks may start again.
      if (texts.length && !texts.some((t) => isLimitReply(t) || isLimitError(t)) && clearClaudeLimited(store.data, Date.now())) {
        store.touch();
        store.save();
        log("info", "token-guard: Claude answered normally after the recorded limit; the limit is cleared", { agentId: ctx && ctx.agentId });
        systemNote("claude-limit-cleared", "✅ Claude answers normally again, so the recorded usage limit is cleared and new tasks can start.", { html: true });
        // Wake the orchestrator now: it may have told the owner work is blocked, and the next triage is minutes away.
        const day = new Date().toISOString().slice(0, 10);
        store.data.wakesByDay[day] = (store.data.wakesByDay[day] || 0) + 1;
        if (api.runtime && api.runtime.subagent && typeof api.runtime.subagent.run === "function") {
          api.runtime.subagent.run({ sessionKey: jobsCfg.idleWakeSession, deliver: false, message: LIMIT_CLEARED_WAKE })
            .then(() => log("info", "token-guard woke the orchestrator: the Claude limit is cleared"))
            .catch((error) => log("warn", "token-guard could not wake the orchestrator after clearing the limit", { error: String(error && error.message) }));
          // The owner's messages that got only the limit notice are answered in the owner's own chat.
          if ((store.data.ownerLimitNoticeAt || 0) > (store.data.ownerLimitAnsweredAt || 0)) {
            store.data.ownerLimitAnsweredAt = Date.now();
            store.touch();
            store.save();
            api.runtime.subagent.run({ sessionKey: `agent:${orchestrator}:main`, deliver: false, message: LIMIT_OWNER_WAKE })
              .then(() => log("info", "token-guard woke the orchestrator to answer the owner's messages held by the limit"))
              .catch((error) => log("warn", "token-guard could not wake the orchestrator for the owner's held messages", { error: String(error && error.message) }));
          }
        }
      }
      const over = recordUsage(store.data, key, event && event.usage, jobsCfg);
      if (over) {
        store.touch();
        post(pm, over.topic || "system", budgetText(voice, over, `${Math.round(over.usedTokens / 1e6)}M tokens`), { html: true, replyTo: over.dispatchMsgId || null });
      }
    }));

    // ---- follow-up loop: no model runs unless there is something to act on ----
    let timer;
    const generation = crypto.randomUUID();
    const isActive = () => globalThis[GEN_KEY] === generation;
    const BOOT_GRACE_MS = 10 * 60000; // agents are still loading after a gateway start
    const tick = async () => {
      if (!jobsCfg.enabled || !isActive()) return;
      if (Date.now() - BOOT_STARTED_AT < BOOT_GRACE_MS) return;
      store.refresh();
      // The spawned run ended and the task has been quiet since, but no end event came: close it.
      for (const job of Object.values(store.data.jobs)) {
        if (job.status !== "running" || !job.runOutcome) continue;
        if (Date.now() - (job.lastActivityAt || job.spawnedAt || 0) < jobsCfg.endedQuietMinutes * 60000) continue;
        log("info", "token-guard: a task's run ended without an end event; closing it", { job: job.short, agentId: job.agentId });
        endJob(job.key, job.runOutcome, "", Date.now());
      }
      let inboxItems = [];
      try { inboxItems = [...loadInboxItems().values()]; } catch { inboxItems = []; }
      const actions = scanJobs(store.data, jobsCfg, Date.now(), {
        bootId: BOOT_ID,
        bootStartedAt: BOOT_STARTED_AT,
        orchestratorAgent: orchestrator,
        inboxItems,
        idleWakeSession: jobsCfg.idleWakeSession,
        voice,
        pmAgent: pm,
        // The old idle wake covers a broken triage, and one whose daily budget is spent: with the budget
        // gone and the idle wake off, nothing woke the orchestrator for the rest of the day.
        triage: triageCfg.enabled && store.data.triageHealthy !== false && !triageBudgetSpent(Date.now()),
        codexEnabled: useCodex,
      });
      if (boardCfg.enabled) {
        try { await auditTick(inboxItems); } catch (error) { log("warn", "token-guard board audit failed", { error: String(error && error.message) }); }
        try { await resumeLimitBlocked(inboxItems); } catch (error) { log("warn", "token-guard resume failed", { error: String(error && error.message) }); }
      }
      try { await triageTick(inboxItems); } catch (error) { log("warn", "token-guard triage failed", { error: String(error && error.message) }); }
      try { await ciTick(inboxItems); } catch (error) { log("warn", "token-guard CI watch failed", { error: String(error && error.message) }); }
      try { await refusalTick(); } catch (error) { log("warn", "token-guard dispatch retry failed", { error: String(error && error.message) }); }
      try { writeQueue(inboxItems); } catch (error) { log("warn", "token-guard queue file failed", { error: String(error && error.message) }); }
      store.touch();
      store.save();
      for (const action of actions) {
        if (action.kind === "post") post(action.agentId, action.topic, action.text, { html: Boolean(action.html), replyTo: action.replyTo || null });
        if (action.kind === "wake") {
          try {
            if (!api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.run !== "function") throw new Error("runtime.subagent.run unavailable");
            // deliver: false, so a wake never auto-replies in a DM; the orchestrator posts in the project topic itself.
            await api.runtime.subagent.run({ sessionKey: action.sessionKey, message: action.message, deliver: false });
            log("info", "token-guard woke the orchestrator", { reason: action.reason, sessionKey: action.sessionKey });
          } catch (error) {
            const msg = String(error && error.message);
            log("warn", "token-guard could not wake the orchestrator", { reason: action.reason, error: msg });
            if (/not completed startup|still starting|unavailable/i.test(msg)) {
              rollbackWake(action); // agents still loading: try again on a later tick, quietly
            } else {
              systemNote(`wakefail:${action.reason}`, `🚩 Job tracker could not wake the orchestrator (${action.reason}): ${msg.slice(0, 160)}`);
            }
          }
        }
      }
    };
    // ---- a dispatch refused by OpenClaw's login check: check again, then the orchestrator sends it again ----
    const refusalTick = async () => {
      if (!refusalCfg.enabled) return;
      const now = Date.now();
      for (const [, r] of dueRefusals(store.data, now, refusalCfg)) {
        const name = nameOf(voice, r.agentId);
        const tries = refusalsWithinHour(store.data, r.agentId, now);
        if (tries > refusalCfg.maxPerHour) {
          r.flaggedAt = now;
          store.touch();
          store.save();
          log("warn", "token-guard: dispatches are still refused by the Claude login check", { agentId: r.agentId, refusals: tries });
          systemNote(`refusal-stuck:${r.agentId}`, `🚩 Dispatches to ${name} were refused ${tries} times in an hour by OpenClaw's own Claude login check, not by a usage limit. I stopped retrying. Operator: run <code>claude auth status</code> on the server.`, { html: true });
          continue;
        }
        r.wokeAt = now;
        const day = new Date(now).toISOString().slice(0, 10);
        store.data.wakesByDay[day] = (store.data.wakesByDay[day] || 0) + 1;
        store.touch();
        store.save();
        recheckLogin(r.agentId);
        if (!api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.run !== "function") continue;
        await api.runtime.subagent.run({ sessionKey: jobsCfg.idleWakeSession, deliver: false, message: retryWakeText(name, r.at, tries, refusalCfg.maxPerHour) })
          .then(() => log("info", "token-guard woke the orchestrator to send a refused dispatch again", { agentId: r.agentId, retry: tries }))
          .catch((error) => log("warn", "token-guard could not wake the orchestrator to retry a dispatch", { error: String(error && error.message) }));
      }
    };
    // ---- the CI watch: pipelines are followed by code, not by a model waiting in its session ----
    const ciCfg = Object.assign({}, DEFAULT_CI, jobsCfg.ci || {});
    const home = process.env.HOME || "";
    const readToken = (file) => { try { return file ? fs.readFileSync(String(file).replace(/^~/, home), "utf8").trim() : ""; } catch { return ""; } };
    const ciFetch = async (req) => {
      const headers = { Accept: "application/json", "User-Agent": "token-guard" };
      const token = readToken(req.host === "gitlab" ? ciCfg.gitlabTokenFile : ciCfg.githubTokenFile);
      if (token && req.host === "gitlab") headers["PRIVATE-TOKEN"] = token;
      if (token && req.host === "github") headers.Authorization = `Bearer ${token}`;
      const r = await fetch(req.url, { headers, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${req.host}`);
      return r.json();
    };
    const ciTick = async (inboxItems) => {
      const now = Date.now();
      const board = new Map(inboxItems.map((it) => [it.id, it]));
      for (const job of Object.values(store.data.jobs)) {
        const w = job.waitFor;
        if (!w || w.done) continue;
        // The item was moved on by hand (Blocked, To do, Done): the watch ends without a post or a move.
        const items = (job.items || []).filter((id) => board.has(id));
        if (items.length && !items.some((id) => inHand(id, board))) {
          w.done = { state: "left hand", at: now };
          store.touch();
          store.save();
          log("info", "token-guard CI watch ended: the item is no longer in hand", { url: w.url, items: items.map((id) => `${id} ${normStatus(board.get(id).status)}`).join(", ") });
          continue;
        }
        if (now - (w.checkedAt || 0) < ciCfg.pollSeconds * 1000) continue;
        w.checkedAt = now;
        store.touch();
        let state = "running";
        let parts = [];
        try {
          const body = await ciFetch(ciRequest(w));
          const checks = w.kind === "github-pr" && body && body.head && body.head.sha
            ? await ciFetch({ host: "github", url: `https://api.github.com/repos/${w.repo}/commits/${body.head.sha}/check-runs?per_page=100` }) : null;
          state = ciState(w, body, checks);
          parts = failedParts(w, body, checks);
        } catch (error) {
          w.errors = (w.errors || 0) + 1;
          log("warn", "token-guard CI watch could not read the pipeline", { url: w.url, error: String(error && error.message) });
          if (w.errors < 5) continue;
          state = "unreadable";
        }
        if (state === "running" && now - (w.since || now) < ciCfg.maxWaitMinutes * 60000) continue;
        // No pipeline was created for the MR: there is nothing to wait for, so the item is not held.
        if (state === "none" && now - (w.since || now) < ciCfg.noPipelineMinutes * 60000) continue;
        const outcome = state === "running" ? "still running" : state === "none" ? "no pipeline" : state;
        w.done = { state: outcome, at: now };
        const verdict = outcome === "success" ? "done" : outcome === "failed" ? "failed" : "unknown";
        const plan = (job.items || []).filter((id) => board.has(id))
          .map((id) => { const before = normStatus(board.get(id).status); return { id, before, to: nextAfterJob(before, job.agentId, verdict) }; })
          .filter((m) => m.to !== m.before);
        await Promise.all(plan.map((m) => systemMove(m.id, m.to, `CI ${outcome}: ${w.url} [job ${job.short || ""}]`)));
        refreshItems(job.items || []);
        store.save();
        const moved = plan.map((m) => `${m.id} → ${m.to}`).join(", ") || "no board change";
        const todo = outcome === "success" ? "Dispatch the next gate on the same item."
          : outcome === "no pipeline" ? "It has no pipeline, so there is nothing to wait for: dispatch the next gate on the same item now (for an open MR: review and merge)."
          : outcome === "failed" ? `Dispatch ${job.agentId} again on the same item to fix it${parts.length ? ` (failed: ${parts.join(", ")})` : ""}; give it the pipeline link.`
            : "Open the pipeline yourself and decide (it did not finish in time or could not be read).";
        log("info", "token-guard CI watch: pipeline finished", { url: w.url, outcome, moved });
        post(orchestrator, job.topic || "system", `🔁 CI ${outcome === "success" ? "passed ✅" : outcome === "failed" ? "failed ❌" : outcome} for <b>${String(job.label || "").replace(/[<>&]/g, "")}</b>: ${moved}`, { html: true, replyTo: job.resultMsgId || null });
        const day = new Date(now).toISOString().slice(0, 10);
        store.data.wakesByDay[day] = (store.data.wakesByDay[day] || 0) + 1;
        if (api.runtime && api.runtime.subagent && typeof api.runtime.subagent.run === "function") {
          await api.runtime.subagent.run({ sessionKey: jobsCfg.idleWakeSession, deliver: false,
            message: `[ci] The pipeline of "${job.label}" ended: ${outcome} (${w.url}). Board: ${moved}. ${todo} One item at a time: this item stays in hand until it is Done or Blocked.` })
            .catch((error) => log("warn", "token-guard could not wake the orchestrator after CI", { error: String(error && error.message) }));
        }
      }
    };
    // The queue for the team's UI and anyone reading the state: the item in hand and what comes next.
    let lastQueue = "";
    const writeQueue = (inboxItems) => {
      const q = queueNow(inboxItems);
      const brief = (it) => ({ id: it.id, project: it.project, title: it.title, status: normStatus(it.status), owner: it.owner, rank: it.rank || null, priority: it.priority });
      const waits = Object.values(store.data.jobs).filter((j) => j.waitFor && !j.waitFor.done).map((j) => ({ items: j.items || [], url: j.waitFor.url, since: j.waitFor.since }));
      const out = JSON.stringify({ wip: q.wip, inHand: q.active.map(brief), next: q.next.map(brief), queue: q.queue.slice(0, 40).map(brief), ciWaits: waits }, null, 1);
      if (out === lastQueue) return;
      lastQueue = out;
      fs.writeFileSync(String(jobsCfg.stateFile).replace(/^~/, home).replace(/[^/]+$/, "queue.json"), out);
    };
    const queueText = () => {
      const q = queueNow(loadInboxItems());
      const line = (it, i) => `${i + 1}. ${it.id} [${normStatus(it.status)}] ${it.project || "?"}: ${String(it.title || "").slice(0, 80)} (owner ${it.owner || "?"}${it.rank ? `, rank ${it.rank}` : ""}${it.priority && it.priority !== "normal" ? `, ${it.priority}` : ""})`;
      const caps = queueCfg.maxTasksByAgent || {};
      const run = runningByAgent();
      const full = Object.keys(caps).filter((a) => Number(caps[a]) > 0 && (run[a] || 0) >= Number(caps[a]));
      return [`In hand (${q.active.length} of ${q.wip}):`, ...(q.active.length ? q.active.map(line) : ["- nothing"]),
        ...(full.length ? [`At their limit of tasks at once (nothing new for them now): ${full.map((a) => `${a} ${run[a]}/${caps[a]}`).join(", ")}`] : []),
        ...(Object.keys(caps).length ? ["Can start now:", ...(q.next.length ? q.next.map(line) : ["- nothing"])] : []),
        "Next in the queue:", ...(q.queue.length ? q.queue.slice(0, 15).map(line) : ["- To do is empty"])].join("\n");
    };
    const auditTick = async (inboxItems) => {
      const now = Date.now();
      store.data.ownerAsks = (store.data.ownerAsks || []).filter((a) => now - a.at < 24 * 3600000);
      const issues = auditBoard(inboxItems, runningItemIds(), store.data.ownerAsks, now, boardCfg);
      // Lost work goes back to To do (with a note), so the follow-up loop re-dispatches it.
      for (const issue of issues.filter((i) => i.kind === "lost")) {
        await systemMove(issue.id, "todo", "was In progress with no task running; back to To do for re-dispatch");
        refreshItems([issue.id]);
      }
      const serious = issues.filter((i) => ["waiting", "incomplete", "missed", "stale"].includes(i.kind));
      store.data.pmAudit = store.data.pmAudit || { lastAt: 0 };
      // After a failed run the audit is tried again in 30 minutes, not at the next 3-hour slot.
      const every = (store.data.pmAudit.failed ? 30 : (boardCfg.auditEveryMinutes || 180)) * 60000;
      const due = now - (store.data.pmAudit.lastAt || 0) >= every;
      if (!serious.length || !due || !api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.run !== "function") return;
      // The PM runs on Claude: during a Claude limit the run can only fail (it once posted "Board check
      // (error): nothing to fix" and used up the 3-hour slot). Wait for the reset instead.
      if ((store.data.claudeLimitedUntil || 0) > now) return;
      store.data.pmAudit = { lastAt: now };
      store.touch();
      const sessionKey = `agent:${pm}:subagent:board-audit-${now.toString(36)}`;
      const snapshot = inboxItems.filter((it) => normStatus(it.status) !== "archived")
        .map((it) => `${it.id} [${normStatus(it.status)}] ${it.project || "?"}: ${it.title || ""} (owner ${it.owner || "?"})`).join("\n");
      const message = [
        "Board audit (automatic, from token-guard). You are the PM: keep the board complete and current. Nothing may be lost, missed or mixed between tasks.",
        "Problems found:", ...serious.slice(0, 20).map((i) => `- ${i.text}`),
        "", "Board now:", snapshot.slice(0, 6000),
        "", "Do this now with task_inbox: add any real owner request that is missing (project, title, owner, size, done_when), fill missing owners or Done when, " +
        "and correct a wrong status (with a note). Never dispatch work yourself. Final answer: what you fixed, and anything the orchestrator must act on.",
      ].join("\n");
      try {
        const { runId } = await api.runtime.subagent.run({ sessionKey, message, deliver: false, toolsAlsoAllow: ["task_inbox"] });
        const res = typeof api.runtime.subagent.waitForRun === "function" ? await api.runtime.subagent.waitForRun({ runId, timeoutMs: 20 * 60000 }) : null;
        let text = "";
        if (typeof api.runtime.subagent.getSessionMessages === "function") {
          const got = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 8 });
          text = lastAssistantText(got && got.messages);
        }
        if (res && res.status && res.status !== "ok") {
          // A failed audit fixed nothing: no "nothing to fix" post, no heads-up, owner asks stay open.
          // It is tried again in 30 minutes (after the reset, if a limit stopped it). The saved state
          // keeps the newest lastAt, so the retry is a flag on this run, not an earlier time.
          store.data.pmAudit = { lastAt: now, failed: true };
          store.touch();
          markLimited(res.error, "board-audit");
          log("warn", "token-guard PM board audit did not finish", { status: res.status, error: String(res.error || "").slice(0, 160) });
          if (typeof api.runtime.subagent.deleteSession === "function") await api.runtime.subagent.deleteSession({ sessionKey }).catch(() => null);
          return;
        }
        post(pm, teamTopic, auditText(voice, res && res.status, text), { html: true });
        // The PM's findings reach the orchestrator at once (owner's order), not at its next wake.
        if (String(text || "").trim()) {
          await api.runtime.subagent.run({ sessionKey: jobsCfg.idleWakeSession, deliver: false,
            message: `[PM heads-up] The board audit found and fixed this; act on what is left for you (one item at a time):\n${String(text).slice(0, 2500)}` })
            .catch((error) => log("warn", "token-guard could not pass the PM's heads-up on", { error: String(error && error.message) }));
        }
        for (const ask of store.data.ownerAsks) ask.captured = true; // the PM has seen them
        if (typeof api.runtime.subagent.deleteSession === "function") await api.runtime.subagent.deleteSession({ sessionKey }).catch(() => null);
        const board = loadInboxItems();
        for (const p of new Set([...board.values()].map((it) => projectFor(it)))) refreshBoard(p);
      } catch (error) {
        log("warn", "token-guard PM board audit failed", { error: String(error && error.message) });
      }
    };

    // Items parked in Blocked only because a usage limit stopped their task go back to To do once no
    // limit is active (they used to stay Blocked for good: nothing ever picks Blocked work up again).
    const resumeLimitBlocked = async (inboxItems) => {
      const now = Date.now();
      if ((store.data.claudeLimitedUntil || 0) > now || (useCodex && (store.data.codexLimitedUntil || 0) > now)) return;
      for (const it of inboxItems) {
        if (normStatus(it.status) !== "blocked") continue;
        if (!isLimitBlock(it.note)) continue;
        await systemMove(it.id, "todo", "the usage limit has reset: back to To do so the work resumes");
        refreshItems([it.id]);
        log("info", "token-guard resumed a limit-blocked item", { id: it.id });
      }
    };

    // Every 10 minutes, when something needs a decision: a cheap Haiku call (no tools, light context)
    // decides whether the orchestrator must act, and at what effort; then the orchestrator is woken.
    const triageCfg = mergeTriageConfig(cfg.triage);
    const triageBudgetSpent = (now) => ((store.data.triageWakesByDay || {})[new Date(now).toISOString().slice(0, 10)] || 0) >= triageCfg.maxWakesPerDay;
    const triageTick = async (inboxItems) => {
      const sub = api.runtime && api.runtime.subagent;
      if (!triageCfg.enabled || !sub || typeof sub.run !== "function") return;
      const now = Date.now();
      store.data.triage = store.data.triage || { lastAt: 0 };
      if (now - (store.data.triage.lastAt || 0) < triageCfg.everyMinutes * 60000) return;
      if ((store.data.claudeLimitedUntil || 0) > now) return; // Haiku is Claude; the plain wakes still run
      const lastOrc = Math.max(0, ...Object.values(store.data.orcActivity || {}).map(Number));
      if (now - lastOrc < triageCfg.orchestratorQuietMinutes * 60000) return; // it is working: do not interrupt
      store.data.triage.lastAt = now;
      store.touch();
      store.save();
      const snapshot = triageSnapshot(store.data, inboxItems, now);
      if (!snapshot) return; // nothing to decide: no tokens spent
      // Nothing changed since the last wake: the orchestrator already saw this state (no tokens spent).
      const sig = triageSignature(store.data, inboxItems, now);
      const t = store.data.triage;
      if (t.wokeSig === sig && now - (t.wokeAt || 0) < triageCfg.sameStateRewakeMinutes * 60000) return;
      const sessionKey = `agent:${orchestrator}:subagent:triage-${now.toString(36)}`;
      const [provider, ...rest] = String(triageCfg.model).split("/");
      let decision = null;
      try {
        const { runId } = await sub.run({ sessionKey, message: TRIAGE_PROMPT + snapshot, provider, model: rest.join("/"), lightContext: true, promptMode: "minimal", disableTools: true, deliver: false });
        if (typeof sub.waitForRun === "function") await sub.waitForRun({ runId, timeoutMs: 5 * 60000 });
        const got = typeof sub.getSessionMessages === "function" ? await sub.getSessionMessages({ sessionKey, limit: 6 }) : null;
        decision = parseTriage(lastAssistantText(got && got.messages));
      } catch (error) {
        log("warn", "token-guard triage run failed", { error: String(error && error.message) });
      } finally {
        if (typeof sub.deleteSession === "function") sub.deleteSession({ sessionKey }).catch(() => null);
      }
      store.data.triageHealthy = Boolean(decision);
      store.data.triage.last = decision ? { at: now, wake: decision.wake, effort: decision.effort, why: decision.why } : { at: now, failed: true };
      store.touch();
      log("info", "token-guard triage", store.data.triage.last);
      if (!decision || !decision.wake) return;
      // The triage has its own daily budget: the old reminders once used up the shared cap and the
      // triage's wake was then dropped without a word.
      const day = new Date(now).toISOString().slice(0, 10);
      store.data.triageWakesByDay = store.data.triageWakesByDay || {};
      if ((store.data.triageWakesByDay[day] || 0) >= triageCfg.maxWakesPerDay) {
        log("warn", "token-guard triage wanted to wake the orchestrator but its daily budget is used up", { budget: triageCfg.maxWakesPerDay });
        return;
      }
      store.data.triageWakesByDay[day] = (store.data.triageWakesByDay[day] || 0) + 1;
      store.data.triage.wokeSig = sig;
      store.data.triage.wokeAt = now;
      store.touch();
      store.save();
      log("info", "token-guard triage woke the orchestrator", { effort: decision.effort });
      await sub.run({ sessionKey: jobsCfg.idleWakeSession, message: triageWakeMessage(decision, snapshot), deliver: false });
    };

    // A wake that could not be delivered is not counted, so it is tried again.
    const rollbackWake = (action) => {
      const day = new Date().toISOString().slice(0, 10);
      if (store.data.wakesByDay[day]) store.data.wakesByDay[day] -= 1;
      if (action.reason === "idle") store.data.idle.lastCheckAt = 0;
      if (action.reason === "ended") for (const j of Object.values(store.data.jobs)) if (j.requesterSessionKey === action.sessionKey && j.lastWakeAt) { j.wakes = Math.max(0, (j.wakes || 1) - 1); j.lastWakeAt = 0; }
      store.touch();
    };

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "token-guard-jobs",
        start() {
          globalThis[GEN_KEY] = generation;
          const prev = globalThis[Symbol.for("token-guard.timer")];
          if (prev) clearInterval(prev);
          if (timer) clearInterval(timer);
          timer = setInterval(() => { tick().catch(() => {}); }, Math.max(15, Number(jobsCfg.scanEverySeconds) || 60) * 1000);
          globalThis[Symbol.for("token-guard.timer")] = timer;
          if (timer && typeof timer.unref === "function") timer.unref();
        },
        stop() {
          if (timer) clearInterval(timer);
          if (globalThis[Symbol.for("token-guard.timer")] === timer) globalThis[Symbol.for("token-guard.timer")] = undefined;
          timer = undefined;
          store.save(true);
        },
      });
    }

    // ---- agents wake the orchestrator (owner's order), rate-limited ----
    const wakeCfg = Object.assign({}, DEFAULT_WAKE, cfg.wake || {});
    const wakeState = { last: {}, recent: [] };
    api.registerTool((tctx) => {
      const agentId = String((tctx && tctx.agentId) || "");
      if (!agentId || agentId === orchestrator) return null;
      const callerKey = String((tctx && tctx.sessionKey) || "");
      return {
        name: "wake_orchestrator",
        label: "Wake the orchestrator",
        description: `Wake the orchestrator now when you are blocked, need its decision, or finished something it must act on before your task ends. ` +
          `At most once per ${wakeCfg.perAgentMinutes} minutes, ${wakeCfg.maxChars} characters. Your final report still reaches it as usual.`,
        parameters: Type.Object({
          reason: Type.String({ description: WAKE_REASONS.join(" | ") }),
          message: Type.String({ description: `What the orchestrator must know or decide (at most ${wakeCfg.maxChars} characters).` }),
        }),
        async execute(_id, params) {
          const now = Date.now();
          const gate = allowAgentWake(wakeState, agentId, now, wakeCfg);
          if (!gate.ok) return { content: [{ type: "text", text: `Not sent: ${gate.why}` }], details: { ok: false } };
          const job = knowJob(callerKey) || null;
          const message = wakeMessage(agentId, params && params.reason, params && params.message, job, wakeCfg.maxChars);
          const day = new Date(now).toISOString().slice(0, 10);
          store.data.wakesByDay[day] = (store.data.wakesByDay[day] || 0) + 1;
          store.touch();
          try {
            await api.runtime.subagent.run({ sessionKey: jobsCfg.idleWakeSession, message, deliver: false });
          } catch (error) {
            return { content: [{ type: "text", text: `Not sent: ${String(error && error.message).slice(0, 160)}. Put it in your final report.` }], details: { ok: false } };
          }
          log("info", "token-guard: an agent woke the orchestrator", { agentId, reason: params && params.reason });
          return { content: [{ type: "text", text: "Sent: the orchestrator is awake and has your message. Carry on with your task." }], details: { ok: true } };
        },
      };
    }, { name: "wake_orchestrator" });

    const text = (description) => Type.Optional(Type.String({ description }));
    api.registerTool({
      name: "task_inbox",
      optional: true,
      description:
        "One inbox for all incoming tasks and bugs. add: record one item (project, title, owner, size, area, type, priority, details, done_when, source). " +
        "list: show items. plan: group open items into sessions: every medium or large item gets its own fresh session; small items of the " +
        "same project, owner and area share one (max 4); flags items that need info. " +
        "set: change an item's status, owner, size, area, priority or rank (the PM keeps the queue's order with rank). show: one item. " +
        "queue: the item in hand and the order of the queue (one item at a time).",
      parameters: Type.Object({
        action: Type.String({ description: "add | list | plan | set | show | queue" }),
        id: text("Item id for set/show."),
        project: text("Project name (add, list filter)."),
        title: text("One-line title (add)."),
        type: text("bug | task | feature | question (add)."),
        priority: text("low | normal | high | urgent (add, set)."),
        rank: text("Queue position, set by the PM: 1 = next, 2 = after that (set)."),
        details: text("What is wrong or wanted; expected vs actual (add)."),
        done_when: text("Exact checks that prove it is done (add)."),
        source: text("Where it came from, e.g. a message id (add)."),
        owner: text("Agent id that will do it, e.g. devops (add, set)."),
        size: text("small (one quick change in one place) | medium | large (several files, a feature, CI/deploy waits) (add, set)."),
        area: text("Part of the project it touches, e.g. 'login page' or 'CI' (add, set)."),
        status: text("New status (set) or status filter (list)."),
        batch: text("Batch label (set)."),
        note: text("Short note (set)."),
        json: Type.Optional(Type.Boolean({ description: "JSON output for list/plan." })),
      }),
      async execute(_id, params) {
        if (params && String(params.action || "") === "queue") return { content: [{ type: "text", text: queueText() }], details: { ok: true } };
        let args;
        try {
          args = inboxArgs(params);
        } catch (error) {
          return { content: [{ type: "text", text: `task_inbox: ${error.message}` }], details: { ok: false } };
        }
        const { code, text: output } = await runInbox(args);
        return {
          content: [{ type: "text", text: output || (code === 0 ? "ok" : `task_inbox failed (exit ${code})`) }],
          details: { ok: code === 0, exitCode: code },
        };
      },
    });
  },
});
