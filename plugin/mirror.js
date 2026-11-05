import fs from "node:fs";
import os from "node:os";
import { dispatchText, resultText, htmlToPlain, clip } from "./voice.js";

// Mirrors team activity into the Telegram group with the Bot API: dispatches,
// acknowledgements, results and process notes, written as a threaded team
// conversation (voice.js). No model runs, so it costs no tokens, and agents
// cannot skip it. Each message is posted by the bot of the agent speaking.

const DEFAULT_MIRROR = {
  enabled: true,
  chatId: "",
  systemTopic: 160,
  defaultTopic: 160,
  projectTopics: {}, // { "<project>": <topic id>, ... } (lowercase keys)
  botTokenFiles: {}, // { "<agentId>": "/path/to/bot.token" }
  accountTokenFiles: {}, // { "<telegram account id>": "/path/to/bot.token" }
  minIntervalMs: 1100,
  agentNames: {}, // { "<agentId>": "DevSecOps Engineer" }
  agentHandles: {}, // { "<agentId>": "devops_bot" }
  ownerHandle: "",
  ownerName: "",
  pmAgent: "product",
  acks: true, // the worker's bot replies "On it" to its dispatch
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

// Kept for callers and tests: the dispatch and result posts (Telegram HTML).
function formatDispatch(cfg, job) {
  return dispatchText(mergeMirrorConfig(cfg), job);
}

function formatResult(cfg, job, verdict, moves) {
  return resultText(mergeMirrorConfig(cfg), job, verdict, moves);
}

// Telegram message id from a hook field ("1234", or "...:1234"), else null.
function messageIdOf(value) {
  const m = /(?:^|:)(\d{1,12})$/.exec(String(value === undefined || value === null ? "" : value).trim());
  return m ? Number(m[1]) : null;
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
  // A 400 on formatted text is retried once as plain text, and a 400 on a reply as a normal message.
  function call(who, method, body) {
    if (!m.enabled || !m.chatId || typeof fetchImpl !== "function") return Promise.resolve(null);
    const next = chain.then(async () => {
      const tok = token(who) || token(m.orchestratorAgent || "coordinator");
      if (!tok) return null;
      let payload = Object.assign({ chat_id: m.chatId }, body);
      for (let attempt = 0, fallbacks = 0; attempt < 3;) {
        const wait = last + m.minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        try {
          const res = await fetchImpl(`https://api.telegram.org/bot${tok}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
          });
          let data = null;
          try { data = typeof res.json === "function" ? await res.json() : null; } catch { data = null; }
          if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
          // An edit with unchanged text is not a failure. (Treating it as one made the board view post
          // and pin a new copy of itself, 58 times on 2026-11-05.)
          if (!res.ok && /message is not modified/i.test(String((data && data.description) || ""))) return true;
          if (!res.ok && res.status === 400 && fallbacks < 2 && (payload.parse_mode || payload.reply_parameters)) {
            fallbacks += 1;
            const desc = String((data && data.description) || "");
            payload = Object.assign({}, payload);
            if (payload.parse_mode && (!payload.reply_parameters || /entit|pars|tag/i.test(desc))) {
              delete payload.parse_mode;
              if (payload.text) payload.text = htmlToPlain(payload.text);
            } else {
              delete payload.reply_parameters;
            }
            if (typeof log === "function") log("info", `token-guard mirror: telegram ${method} retry without ${payload.parse_mode ? "reply" : "formatting"}`, { description: desc.slice(0, 120) });
            continue;
          }
          if (!res.ok && typeof log === "function") log("warn", `token-guard mirror: telegram ${method} failed`, { status: res.status, description: String((data && data.description) || "").slice(0, 160) });
          return res.ok ? (data && data.result !== undefined ? data.result : true) : null;
        } catch (error) {
          attempt += 1;
          if (attempt >= 3) {
            if (typeof log === "function") log("warn", `token-guard mirror: telegram ${method} error`, { error: String(error && error.message) });
            return null;
          }
          await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
        }
      }
      return null;
    });
    chain = next.catch(() => null);
    return next;
  }

  // Post a message; resolves to its message id (or true when the API gave none), null on failure.
  // html: the text is Telegram HTML. replyTo: the message id this one answers (same topic).
  function post({ agentId, accountId, topic, text, html = false, replyTo = null }) {
    if (!text) return Promise.resolve(null);
    const body = { text: clip(text, 4000), disable_web_page_preview: true };
    if (html) body.parse_mode = "HTML";
    const thread = resolveTopic(topic);
    if (thread && thread > 1) body.message_thread_id = thread;
    const reply = messageIdOf(replyTo);
    if (reply) body.reply_parameters = { message_id: reply, allow_sending_without_reply: true };
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

export { DEFAULT_MIRROR, mergeMirrorConfig, projectKey, topicFor, formatDispatch, formatResult, messageIdOf, createMirror };
