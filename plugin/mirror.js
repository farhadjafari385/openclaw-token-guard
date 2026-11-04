import fs from "node:fs";
import os from "node:os";

// Mirrors team activity into the Telegram group with the Bot API: dispatches,
// results and system events. No model runs, so it costs no tokens, and agents
// cannot skip it. Results are posted by the worker's own bot.

const DEFAULT_MIRROR = {
  enabled: true,
  chatId: "",
  systemTopic: 160,
  defaultTopic: 160,
  projectTopics: {}, // { "<project>": <topic id>, ... } (lowercase keys)
  botTokenFiles: {}, // { "<agentId>": "/path/to/bot.token" }
  accountTokenFiles: {}, // { "<telegram account id>": "/path/to/bot.token" }
  maxResultChars: 1800,
  minIntervalMs: 1100,
  agentNames: {}, // { "<agentId>": "DevSecOps" }
};

function expandHome(p) {
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}

function mergeMirrorConfig(cfg) {
  return Object.assign({}, DEFAULT_MIRROR, cfg && typeof cfg === "object" ? cfg : {});
}

function projectKey(projectLine) {
  return String(projectLine || "").trim().toLowerCase().split(/[\s(,:;/]/)[0].replace(/[^a-z0-9._-]/g, "");
}

function topicFor(cfg, projectLine, fallback) {
  const m = mergeMirrorConfig(cfg);
  const line = String(projectLine || "").toLowerCase();
  const key = projectKey(line);
  const topics = m.projectTopics || {};
  if (key && topics[key] !== undefined) return Number(topics[key]);
  for (const [name, topic] of Object.entries(topics)) if (name && line.includes(name)) return Number(topic);
  if (fallback !== undefined && fallback !== null && fallback !== "" && Number(fallback) > 1) return Number(fallback);
  return Number(m.defaultTopic) || null;
}

function clip(text, n) {
  const s = String(text || "").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function nameOf(cfg, agentId) {
  const names = (cfg && cfg.agentNames) || {};
  return names[agentId] || agentId;
}

function formatDispatch(cfg, job) {
  const model = job.model ? job.model.split("/").pop() : "default model";
  return [
    `▶️ ${nameOf(cfg, job.agentId)} ← ${clip(job.label, 120)}`,
    `${model} · effort ${job.thinking || "default"}`,
    job.doneWhen ? `Done when: ${clip(job.doneWhen, 400)}` : "",
    `[job ${job.short}]`,
  ].filter(Boolean).join("\n");
}

const OUTCOME_ICON = { ok: "✅", error: "❌", timeout: "⌛", killed: "🛑", reset: "↩️", deleted: "🗑", unknown: "❔" };

function formatResult(cfg, job) {
  const m = mergeMirrorConfig(cfg);
  const mins = Number.isFinite(job.endedAt) && Number.isFinite(job.spawnedAt) ? Math.max(1, Math.round((job.endedAt - job.spawnedAt) / 60000)) : null;
  return [
    `${OUTCOME_ICON[job.outcome] || "❔"} ${clip(job.label, 120)} — ${job.outcome}${mins ? ` · ${mins} min` : ""}`,
    job.error ? `Error: ${clip(job.error, 300)}` : "",
    job.resultText ? clip(job.resultText, m.maxResultChars) : "(no final answer captured)",
    `[job ${job.short}]`,
  ].filter(Boolean).join("\n");
}

function createMirror({ cfg, log, fetchImpl = globalThis.fetch, readFile = (p) => fs.readFileSync(p, "utf8"), retryDelayMs = 5000 }) {
  const m = mergeMirrorConfig(cfg);
  const tokens = new Map();
  let chain = Promise.resolve();
  let last = 0;

  // Token for an agent id, or for a Telegram account id (`account:<id>`).
  function token(key) {
    if (!tokens.has(key)) {
      const file = key.startsWith("account:") ? (m.accountTokenFiles || {})[key.slice(8)] : (m.botTokenFiles || {})[key];
      let value = "";
      if (file) {
        try { value = readFile(expandHome(file)).trim(); } catch { value = ""; }
      }
      tokens.set(key, value);
    }
    return tokens.get(key);
  }

  function resolveTopic(topic) {
    if (topic === "system") return Number(m.systemTopic) || null;
    return topic === undefined || topic === null ? Number(m.defaultTopic) || null : Number(topic);
  }

  // One Bot API call through the serial, rate-limited queue. Resolves to the parsed result or null.
  function call(who, method, body) {
    if (!m.enabled || !m.chatId || typeof fetchImpl !== "function") return Promise.resolve(null);
    const next = chain.then(async () => {
      const wait = last + m.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const tok = token(who) || token(m.orchestratorAgent || "coordinator");
      if (!tok) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetchImpl(`https://api.telegram.org/bot${tok}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(Object.assign({ chat_id: m.chatId }, body)),
            signal: AbortSignal.timeout(15000),
          });
          let data = null;
          try { data = typeof res.json === "function" ? await res.json() : null; } catch { data = null; }
          if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
          if (!res.ok && typeof log === "function") log("warn", `token-guard mirror: telegram ${method} failed`, { status: res.status });
          return res.ok ? (data && data.result !== undefined ? data.result : true) : null;
        } catch (error) {
          if (attempt === 2) {
            if (typeof log === "function") log("warn", `token-guard mirror: telegram ${method} error`, { error: String(error && error.message) });
            return null;
          }
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        }
      }
      return null;
    });
    chain = next.catch(() => null);
    return next;
  }

  // Post a message; resolves to its message id (or true when the API gave none), null on failure.
  function post({ agentId, accountId, topic, text }) {
    if (!text) return Promise.resolve(null);
    const body = { text: clip(text, 4000), disable_web_page_preview: true };
    const thread = resolveTopic(topic);
    if (thread && thread > 1) body.message_thread_id = thread;
    return call(accountId ? `account:${accountId}` : agentId || "coordinator", "sendMessage", body)
      .then((r) => (r && typeof r === "object" ? r.message_id : r));
  }

  function edit({ agentId, messageId, text }) {
    return call(agentId || "coordinator", "editMessageText", { message_id: messageId, text: clip(text, 4000), disable_web_page_preview: true });
  }

  function pin({ agentId, messageId }) {
    return call(agentId || "coordinator", "pinChatMessage", { message_id: messageId, disable_notification: true });
  }

  return { post, edit, pin, cfg: m };
}

export { DEFAULT_MIRROR, mergeMirrorConfig, projectKey, topicFor, formatDispatch, formatResult, createMirror };
