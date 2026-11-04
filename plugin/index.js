import crypto from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createState, decide } from "./guard.js";
import { policyDecide, firstLine, itemsFromBrief } from "./policy.js";
import { normStatus, resultVerdict, nextAfterJob, renderBoard, renderOverview, auditBoard, parseApproval, looksLikeRequest } from "./board.js";
import { correctTopic, isGeneral, projectOfTopic, projectsMentioned } from "./topics.js";
import { isLimitError, limitResetAt } from "./limits.js";
import {
  createJobStore, mergeJobsConfig, recordSpawn, recordActivity, recordUsage, recordResultText,
  recordEnd, setClaudeLimited, scanJobs, lastAssistantText,
} from "./jobs.js";
import { createMirror, topicFor, messageIdOf } from "./mirror.js";
import {
  dispatchText, ackText, resultText, guardText, limitText, budgetText, approvalAskText, approvalReplyText,
  auditText, movedText, mdToHtml, handleOf,
} from "./voice.js";
import { inboxArgs, loadInboxItems, runInbox } from "./inbox.js";

// No top-level await: OpenClaw loads plugin entries through require(), which
// rejects ESM graphs that use it.

const state = createState();
state.lookupInbox = () => loadInboxItems();

const BOOT_ID = crypto.randomUUID();
const BOOT_STARTED_AT = Date.now();
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
      const last = (store.data.ownerMsgs || {})[String(topic)];
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
      for (const j of Object.values(store.data.jobs)) {
        if (!j.resultMsgId || j.answeredAt || Number(j.topic) !== Number(topic) || now - (j.endedAt || 0) > 3 * 3600000) continue;
        if (!best || (j.endedAt || 0) > (best.endedAt || 0)) best = j;
      }
      if (best) { best.answeredAt = now; store.touch(); }
      return best;
    };
    const withMention = (text, agentId) => {
      const h = handleOf(voice, agentId);
      const t = String(text === undefined || text === null ? "" : text);
      if (!h.startsWith("@") || !t.trim() || t.includes(h)) return t;
      return `${h} ${t}`;
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
      if (!id || /\btg:\d+:\d+\b/.test(String(p.source || ""))) return null;
      return Object.assign({}, p, { source: `${p.source ? `${p.source} ` : ""}tg:${topic}:${id}`.trim() });
    };
    // After the orchestrator approves checked work, ask the owner once (archiving needs both approvals).
    const askOwnerToApprove = (ids) => {
      const board = loadInboxItems();
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

    const runningItemIds = () => {
      const ids = new Set();
      for (const j of Object.values(store.data.jobs)) if (j.status === "running") for (const id of j.items || []) ids.add(id);
      return ids;
    };
    const pstate = {
      get claudeLimitedUntil() { return store.data.claudeLimitedUntil || 0; },
      boardItems: () => loadInboxItems(),
      runningItemIds,
      jobFor: (sessionKey) => {
        const job = store.data.jobs[sessionKey];
        return job && job.status === "running" ? job : null;
      },
      onBlock: (rule, info) => {
        if (["protectedFile", "protectedConfig", "backChannel", "spawnByWorker", "sendByWorker", "orchestratorOnly", "modelPin"].includes(rule)) {
          systemNote(`${rule}:${info.agentId}`, guardText(voice, rule, info), { html: true });
        }
      },
      onNote: (text) => systemNote("spawn-note", `🔀 ${text}`),
    };

    const markLimited = (text, source) => {
      if (!isLimitError(text)) return;
      const until = limitResetAt(text);
      if (setClaudeLimited(store.data, until, text)) {
        store.touch();
        store.save();
        log("info", "token-guard: Claude limit", { source, text: String(text).slice(0, 160) });
        post(orchestrator, "system", limitText(voice, until, cfg.spawn && cfg.spawn.codexModel), { html: true });
      }
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
        doneWhen: firstLine(p.brief, "Done when"),
        brief: p.brief,
        items,
      }, BOOT_ID, Date.now(), jobsCfg);
      store.touch();
      store.save();
      if (job) {
        const key = childSessionKey;
        const replyTo = requestMessageFor(job.topic, items, board);
        if (replyTo) setJob(key, { requestMsgId: replyTo });
        const thread = say(orchestrator, job.topic, dispatchText(voice, store.data.jobs[key] || job), { html: true, replyTo })
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
          if (recordActivity(store.data, ctx && ctx.sessionKey, ctx && ctx.agentId, orchestrator, now)) store.touch();
          const pol = policyDecide(event, ctx, pstate, cfg, log, now);
          if (pol && pol.block) return { block: true, blockReason: pol.blockReason };
          const rewritten = pol && pol.params ? Object.assign({}, event, { params: pol.params }) : event;
          const res = decide(rewritten, ctx, state, cfg, log, now);
          if (res && res.block) return res;
          let params = (res && res.params) || (pol && pol.params);
          if (event.toolName === "sessions_spawn" && ctx && ctx.agentId === orchestrator) rememberSpawn(params || event.params || {}, ctx);
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
      if (bare === "task_inbox") {
        const action = String((event.params && event.params.action) || "");
        if (["add", "set", "approve"].includes(action)) {
          if (action === "add") markAskCaptured(ctx && ctx.sessionKey);
          const ids = String((event.params && event.params.id) || "").match(/\b[0-9a-f]{8}\b/g) || [];
          const out = JSON.stringify(event.result || "").match(/\b[0-9a-f]{8}\b/g) || [];
          refreshItems([...ids, ...out]);
          if (action === "approve" && ctx && ctx.agentId === orchestrator) askOwnerToApprove(ids);
        }
        return;
      }
      if (event.toolName !== "sessions_spawn" || !ctx || ctx.agentId !== orchestrator) return;
      let r = event.result;
      if (r && Array.isArray(r.content)) r = r.content.map((c) => c && c.text).join("\n");
      if (typeof r === "string") { try { r = JSON.parse(r.slice(r.indexOf("{"))); } catch { r = null; } }
      const key = r && (r.childSessionKey || (r.details && r.details.childSessionKey));
      if (key) startJob(key, String((event.params && event.params.agentId) || ""), String((event.params && event.params.label) || ""), ctx.sessionKey, null);
    }));

    api.on("subagent_spawned", safe("subagent_spawned", (event, ctx) => {
      startJob(event.childSessionKey, event.agentId, event.label, ctx && ctx.requesterSessionKey, event.requester && event.requester.threadId);
      const job = store.data.jobs[event.childSessionKey];
      if (job && event.resolvedModel && !job.model) { job.model = event.resolvedModel; store.touch(); }
    }));

    api.on("agent_end", safe("agent_end", (event, ctx) => {
      const key = ctx && ctx.sessionKey;
      if (!key) return;
      const now = Date.now();
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

    api.on("subagent_ended", safe("subagent_ended", (event) => {
      const key = event.targetSessionKey;
      if (event.error) markLimited(event.error, "task");
      const job = recordEnd(store.data, key, event.outcome, event.error, event.endedAt || Date.now());
      if (!job) return;
      store.touch();
      const finish = () => {
        store.save();
        const cur = store.data.jobs[key] || job;
        const verdict = resultVerdict(cur.resultText, cur.outcome);
        const board = loadInboxItems();
        const plan = (cur.items || []).filter((id) => board.has(id)).map((id) => {
          const before = normStatus(board.get(id).status);
          return { id, before, to: nextAfterJob(before, cur.agentId, verdict) };
        }).filter((m) => m.to !== m.before);
        // The worker answers its dispatch, from its own bot, once the dispatch is posted.
        Promise.resolve(threads.get(key)).catch(() => null).then(() => {
          threads.delete(key);
          const j = store.data.jobs[key] || cur;
          return say(j.agentId, j.topic, resultText(voice, j, verdict, plan), { html: true, replyTo: j.dispatchMsgId || null });
        }).then((id) => { if (typeof id === "number") setJob(key, { resultMsgId: id }); });
        Promise.all(plan.map((m) => systemMove(m.id, m.to, `${cur.agentId} task ended: ${verdict} [job ${cur.short}]`)))
          .then(() => refreshItems(cur.items || []));
      };
      if (job.resultText || !api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.getSessionMessages !== "function") return finish();
      api.runtime.subagent.getSessionMessages({ sessionKey: key, limit: 8 })
        .then((res) => { recordResultText(store.data, key, lastAssistantText(res && res.messages), jobsCfg); })
        .catch(() => {})
        .finally(finish);
    }));

    // ---- topics: a reply that belongs in another topic is cancelled and reposted there ----
    const pointed = new Set();
    api.on("message_sending", safe("message_sending", (event, ctx) => {
      if (!topicsCfg.enabled || !chatId || !ctx || ctx.channelId !== "telegram") return undefined;
      if (!String(event.to || "").includes(chatId)) return undefined;
      const right = correctTopic({ threadId: event.threadId, text: event.content, projects, teamTopic });
      const current = isGeneral(event.threadId) ? null : Number(event.threadId);
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
        store.data.ownerMsgs[String(topic)] = { id: msgId, at: Date.now() };
        store.touch();
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
        store.data.ownerAsks.push({ at: Date.now(), topic, text: String(event.content).slice(0, 400), captured: false });
        store.touch();
      }
    }));

    api.on("llm_output", safe("llm_output", (event, ctx) => {
      const key = ctx && ctx.sessionKey;
      // The worker's latest text, so the result is known even if agent_end carries none.
      const job = key && store.data.jobs[key];
      const texts = event && Array.isArray(event.assistantTexts) ? event.assistantTexts.filter((t) => typeof t === "string" && t.trim()) : [];
      if (job && texts.length && recordResultText(store.data, key, texts.join("\n"), jobsCfg)) store.touch();
      const over = recordUsage(store.data, key, event && event.usage, jobsCfg);
      if (over) {
        store.touch();
        post(pm, over.topic || "system", budgetText(voice, over, Math.round(over.usedTokens / 1e6)), { html: true, replyTo: over.dispatchMsgId || null });
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
      });
      if (boardCfg.enabled) {
        try { await auditTick(inboxItems); } catch (error) { log("warn", "token-guard board audit failed", { error: String(error && error.message) }); }
      }
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
      const due = now - (store.data.pmAudit.lastAt || 0) >= (boardCfg.auditEveryMinutes || 180) * 60000;
      if (!serious.length || !due || !api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.run !== "function") return;
      store.data.pmAudit.lastAt = now;
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
        post(pm, teamTopic, auditText(voice, res && res.status, text), { html: true });
        for (const ask of store.data.ownerAsks) ask.captured = true; // the PM has seen them
        if (typeof api.runtime.subagent.deleteSession === "function") await api.runtime.subagent.deleteSession({ sessionKey }).catch(() => null);
        const board = loadInboxItems();
        for (const p of new Set([...board.values()].map((it) => projectFor(it)))) refreshBoard(p);
      } catch (error) {
        log("warn", "token-guard PM board audit failed", { error: String(error && error.message) });
      }
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

    const text = (description) => Type.Optional(Type.String({ description }));
    api.registerTool({
      name: "task_inbox",
      optional: true,
      description:
        "One inbox for all incoming tasks and bugs. add: record one item (project, title, owner, size, area, type, priority, details, done_when, source). " +
        "list: show items. plan: group open items into sessions: every medium or large item gets its own fresh session; small items of the " +
        "same project, owner and area share one (max 4); flags items that need info. " +
        "set: change an item's status (open|planned|dispatched|done|blocked|dropped), owner, size or area. show: one item.",
      parameters: Type.Object({
        action: Type.String({ description: "add | list | plan | set | show" }),
        id: text("Item id for set/show."),
        project: text("Project name (add, list filter)."),
        title: text("One-line title (add)."),
        type: text("bug | task | feature | question (add)."),
        priority: text("low | normal | high | urgent (add)."),
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
