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
import { createMirror, topicFor, formatDispatch, formatResult } from "./mirror.js";
import { inboxArgs, loadInboxItems, runInbox } from "./inbox.js";

// No top-level await: OpenClaw loads plugin entries through require(), which
// rejects ESM graphs that use it.

const state = createState();
state.lookupInbox = () => loadInboxItems();

const BOOT_ID = crypto.randomUUID();
const BOOT_STARTED_AT = Date.now();

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
    const mirror = createMirror({ cfg: Object.assign({ orchestratorAgent: orchestrator }, cfg.mirror), log });
    const post = (agentId, topic, text) => { mirror.post({ agentId, topic, text }).catch(() => {}); };
    const projects = cfg.projects || {};
    const topicsCfg = cfg.topics || {};
    const boardCfg = Object.assign({ enabled: true, agent: "product", auditEveryMinutes: 180, view: true }, cfg.board || {});
    const ownerId = String(cfg.ownerId || "");
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
      const hash = crypto.createHash("sha1").update(text.replace(/· \d\d:\d\d UTC/, "")).digest("hex").slice(0, 12);
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
    const systemNote = (key, text) => {
      const now = Date.now();
      if (now - (noted.get(key) || 0) < 30 * 60000) return;
      noted.set(key, now);
      post(orchestrator, "system", text);
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
          systemNote(`${rule}:${info.agentId}`, `🛡 Guard blocked ${info.agentId}: ${rule} (${info.tool}).`);
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
        post(orchestrator, "system",
          `⚠️ Claude limit hit (${source}): "${String(text).slice(0, 120)}". New tasks go to Codex until ${new Date(until).toISOString().slice(11, 16)} UTC.`);
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
        post(orchestrator, job.topic, formatDispatch(cfg.mirror, job));
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
          const params = (res && res.params) || (pol && pol.params);
          if (event.toolName === "sessions_spawn" && ctx && ctx.agentId === orchestrator) rememberSpawn(params || event.params || {}, ctx);
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
        post(job.agentId, job.topic, formatResult(cfg.mirror, job));
        const verdict = resultVerdict(job.resultText, job.outcome);
        const board = loadInboxItems();
        const moves = (job.items || []).filter((id) => board.has(id)).map((id) => {
          const before = normStatus(board.get(id).status);
          const next = nextAfterJob(before, job.agentId, verdict);
          return next !== before ? systemMove(id, next, `${job.agentId} task ended: ${verdict} [job ${job.short}]`) : null;
        });
        Promise.all(moves).then(() => refreshItems(job.items || []));
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
      mirror.post({ accountId: ctx.accountId, topic: right.topic, text: event.content }).catch(() => null);
      const pointerKey = `${ctx.runId || ctx.sessionKey || ""}:${current}`;
      if (!pointed.has(pointerKey)) {
        pointed.add(pointerKey);
        if (pointed.size > 500) pointed.clear();
        mirror.post({ accountId: ctx.accountId, topic: current || 1, text: `↪️ Continued in the ${right.project || "team"} topic.` }).catch(() => null);
      }
      log("info", "token-guard moved a reply to its topic", { from: current, to: right.topic, accountId: ctx.accountId });
      return { cancel: true, cancelReason: `token-guard: belongs in topic ${right.topic}; reposted there` };
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
      const approval = parseApproval(event.content);
      if (approval) {
        const board = loadInboxItems();
        const project = projectOfTopic(projects, topic);
        const ids = approval.all
          ? [...board.values()].filter((it) => ["done", "dropped"].includes(normStatus(it.status)) && (!project || project === "team" || projectFor(it) === project)).map((it) => it.id)
          : approval.ids.filter((id) => board.has(id));
        if (ids.length) {
          runInbox(["approve", ...ids, "--by", "owner"]).then((r) => {
            post(orchestrator, topic > 1 ? topic : teamTopic, `🗄 Your approval: ${String((r && r.text) || "").split("\n").slice(0, 12).join("; ")}`);
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
      const over = recordUsage(store.data, key, event && event.usage, jobsCfg);
      if (over) {
        store.touch();
        post(orchestrator, over.topic || "system", `💸 ${over.agentId} · ${over.label} reached its task budget (${Math.round(over.usedTokens / 1e6)}M tokens) and is being made to finish. [job ${over.short}]`);
      }
    }));

    // ---- follow-up loop: no model runs unless there is something to act on ----
    let timer;
    const tick = async () => {
      if (!jobsCfg.enabled) return;
      let inboxItems = [];
      try { inboxItems = [...loadInboxItems().values()]; } catch { inboxItems = []; }
      const actions = scanJobs(store.data, jobsCfg, Date.now(), {
        bootId: BOOT_ID,
        bootStartedAt: BOOT_STARTED_AT,
        orchestratorAgent: orchestrator,
        inboxItems,
        idleWakeSession: jobsCfg.idleWakeSession,
      });
      if (boardCfg.enabled) {
        try { await auditTick(inboxItems); } catch (error) { log("warn", "token-guard board audit failed", { error: String(error && error.message) }); }
      }
      store.touch();
      store.save();
      for (const action of actions) {
        if (action.kind === "post") post(action.agentId, action.topic, action.text);
        if (action.kind === "wake") {
          try {
            if (!api.runtime || !api.runtime.subagent || typeof api.runtime.subagent.run !== "function") throw new Error("runtime.subagent.run unavailable");
            await api.runtime.subagent.run({ sessionKey: action.sessionKey, message: action.message, deliver: true });
            log("info", "token-guard woke the orchestrator", { reason: action.reason, sessionKey: action.sessionKey });
          } catch (error) {
            log("warn", "token-guard could not wake the orchestrator", { reason: action.reason, error: String(error && error.message) });
            systemNote(`wakefail:${action.reason}`, `🚩 Job tracker could not wake the orchestrator (${action.reason}): ${String(error && error.message).slice(0, 160)}`);
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
      const pm = boardCfg.agent || "product";
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
        post(pm, teamTopic, `🧾 Board audit (${res && res.status ? res.status : "done"})\n${String(text || "(no report)").slice(0, 1800)}`);
        for (const ask of store.data.ownerAsks) ask.captured = true; // the PM has seen them
        if (typeof api.runtime.subagent.deleteSession === "function") await api.runtime.subagent.deleteSession({ sessionKey }).catch(() => null);
        const board = loadInboxItems();
        for (const p of new Set([...board.values()].map((it) => projectFor(it)))) refreshBoard(p);
      } catch (error) {
        log("warn", "token-guard PM board audit failed", { error: String(error && error.message) });
      }
    };

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "token-guard-jobs",
        start() {
          if (timer) clearInterval(timer);
          timer = setInterval(() => { tick().catch(() => {}); }, Math.max(15, Number(jobsCfg.scanEverySeconds) || 60) * 1000);
          if (timer && typeof timer.unref === "function") timer.unref();
        },
        stop() {
          if (timer) clearInterval(timer);
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
