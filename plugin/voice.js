// How the team sounds in Telegram: plain first-person sentences, replies to
// the message being answered, and @mentions of whoever is addressed.
// Pure (no I/O). Every text here is Telegram HTML (parse_mode "HTML").
//
// cfg keys used: agentHandles { agentId: "bot_username" }, agentNames { agentId: "Name" },
// ownerHandle "username", ownerId, ownerName, orchestratorAgent, pmAgent.

const esc = (s) => String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function clip(text, n) {
  const s = String(text || "").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function nameOf(cfg, agentId) {
  return (cfg && cfg.agentNames && cfg.agentNames[agentId]) || agentId || "someone";
}

// "@devops_bot" (a real Telegram mention), or the agent's name when no handle is known.
function handleOf(cfg, agentId) {
  const h = cfg && cfg.agentHandles && cfg.agentHandles[agentId];
  return h ? `@${String(h).replace(/^@/, "")}` : esc(nameOf(cfg, agentId));
}

function ownerTag(cfg) {
  if (cfg && cfg.ownerHandle) return `@${String(cfg.ownerHandle).replace(/^@/, "")}`;
  if (cfg && /^\d+$/.test(String(cfg.ownerId || ""))) return `<a href="tg://user?id=${cfg.ownerId}">${esc(cfg.ownerName || "owner")}</a>`;
  return esc((cfg && cfg.ownerName) || "owner");
}

const orcOf = (cfg) => (cfg && cfg.orchestratorAgent) || "coordinator";

// Stable choice, so the same job always reads the same way but jobs vary.
function pick(options, seed) {
  let h = 0;
  for (const c of String(seed || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return options[h % options.length];
}

// "demo: fix the CI cache" -> "Fix the CI cache"
function titleOf(label) {
  const t = String(label || "").replace(/^[^:\n]{1,40}:\s+/, "").trim() || String(label || "").trim() || "this task";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// "anthropic/claude-opus-5-5" -> "Opus 5.5", "openai/gpt-6-astra" -> "GPT-6 Astra"
function modelName(ref) {
  const id = String(ref || "").split("/").pop();
  let m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id);
  if (m) return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  m = /^gpt-([\d.]+)(?:-([a-z]+))?/.exec(id);
  if (m) return `GPT-${m[1]}${m[2] ? ` ${m[2].charAt(0).toUpperCase()}${m[2].slice(1)}` : ""}`;
  return id;
}

const LABELS = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", review: "Review", qa: "QA",
  blocked: "Blocked", done: "Done", dropped: "Dropped", archived: "Archived",
};

// ---- Markdown (as agents write it) to Telegram HTML ----

const REPORT_LABEL = /^(\s*)(RESULT|Checks|Changes|Root cause|Next|Evidence|Blocked|BLOCKED|Summary|Risks?)(\s*:)/;

function spans(text, rich) {
  return String(text).split(/(`[^`\n]+`)/).map((seg) => {
    if (/^`[^`\n]+`$/.test(seg)) return rich ? `<code>${esc(seg.slice(1, -1))}</code>` : esc(seg.slice(1, -1));
    let e = esc(seg).replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
    if (rich) e = e.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, url) => `<a href="${url.replace(/"/g, "&quot;")}">${t}</a>`);
    else e = e.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
    return e;
  }).join("");
}

function lines(text, rich) {
  return String(text).split("\n").map((line) => {
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) return `<b>${spans(h[1].replace(/\*\*/g, ""), false)}</b>`; // no code inside bold (Telegram rule)
    let l = line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    const lab = REPORT_LABEL.exec(l);
    if (lab) return `${lab[1]}<b>${esc(lab[2])}${esc(lab[3].trim())}</b>${spans(l.slice(lab[0].length), rich)}`;
    return spans(l, rich);
  }).join("\n");
}

// rich=false keeps only bold, for text inside a blockquote (Telegram does not
// allow code or pre entities inside one).
function mdToHtml(md, max = 3000, rich = true) {
  let s = String(md || "").replace(/\r/g, "").trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.split(/```[^\n]*\n?/).map((part, i) => {
    if (i % 2 === 1) return rich ? `<pre>${esc(part.replace(/\n$/, ""))}</pre>` : esc(part.replace(/\n$/, ""));
    return lines(part, rich);
  }).join("");
}

function htmlToPlain(html) {
  return String(html || "")
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (_m, url, t) => (url.startsWith("tg://") ? t : `${t} (${url})`))
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// ---- the worker's report ----

const RESULT_LINE = /^\s*[*_`>]*\s*RESULT\s*[:=-]/im;

// { summary, details }: the plain sentences before the RESULT block, and the block itself.
function splitReport(text) {
  const t = String(text || "").replace(/\r/g, "").trim();
  if (!t) return { summary: "", details: "" };
  const m = RESULT_LINE.exec(t);
  if (!m) {
    const [first, ...rest] = t.split(/\n\s*\n/);
    return { summary: clip(first, 600), details: rest.join("\n\n").trim() };
  }
  let summary = t.slice(0, m.index).trim();
  const details = t.slice(m.index).trim();
  if (!summary) {
    // No plain summary: use the first real line after RESULT (usually Checks).
    const next = details.split("\n").slice(1).map((l) => l.trim()).find((l) => l && !/^[-=*_]{3,}$/.test(l));
    summary = next ? next.replace(/^[*_]*(Checks|Changes|Root cause|Next)[*_]*\s*:\s*/i, "") : "";
  }
  return { summary: clip(summary.replace(/^#+\s*/, ""), 600), details };
}

// ---- messages ----

const ASKS = ["can you take this one?", "over to you:", "this one is yours:"];
const ACKS = ["On it 👍", "On it. I'll report back here.", "👍 Taking it, I'll post the result here."];

function dispatchText(cfg, job) {
  const out = [`${handleOf(cfg, job.agentId)} ${pick(ASKS, job.key || job.short)}`, `<b>${esc(clip(titleOf(job.label), 200))}</b>`];
  if (job.doneWhen) out.push(`Done when: ${esc(clip(job.doneWhen, 400))}`);
  const meta = [
    (job.items || []).join(" "),
    job.model ? modelName(job.model) : "",
    job.thinking ? `${job.thinking} effort` : "",
  ].filter(Boolean).join(" · ");
  if (meta) out.push(`<i>${esc(meta)}</i>`);
  return out.join("\n");
}

function ackText(_cfg, job) {
  return esc(pick(ACKS, `${job.key || job.short || ""}:ack`));
}

const HEADS = { done: "✅ Done", blocked: "⛔ I'm blocked", failed: "❌ Not done yet", waiting: "⏳ Pushed, CI is running (the guard watches it)", unknown: "📝 Finished, please check" };

function resultText(cfg, job, verdict, moves = []) {
  const mins = Number.isFinite(job.endedAt) && Number.isFinite(job.spawnedAt) ? Math.max(1, Math.round((job.endedAt - job.spawnedAt) / 60000)) : null;
  let head = HEADS[verdict] || HEADS.unknown;
  if (job.outcome === "timeout") head = "⌛ I ran out of time";
  else if (job.outcome === "killed") head = "🛑 My task was stopped";
  else if (job.outcome === "lost") head = "❔ My task ended without a report reaching the guard";
  else if (job.outcome === "error") head = "❌ My run failed";
  const { summary, details } = splitReport(job.resultText);
  const first = `${handleOf(cfg, orcOf(cfg))} ${head}${mins ? ` (${mins} min)` : ""}.`;
  const out = [summary ? `${first} ${mdToHtml(summary, 700)}` : first];
  // No dispatch post to reply to: the result names its task and items itself.
  if (cfg.resultsOnly) out.splice(1, 0, `<b>${esc(clip(titleOf(job.label), 200))}</b>${(job.items || []).length ? ` <i>${esc(job.items.join(" "))}</i>` : ""}`);
  if (job.error) out.push(`Error: <code>${esc(clip(job.error, 300))}</code>`);
  if (details) out.push(`<blockquote expandable>${mdToHtml(details, 2600, false)}</blockquote>`);
  if (!job.resultText) out.push("I left no written report; my session history has the details.");
  if (job.missingEvidence && job.missingEvidence.length) out.push(`⚠️ Cited proof that does not exist: ${job.missingEvidence.map((f) => `<code>${esc(f)}</code>`).join(", ")}`);
  if (moves.length) out.push(`<i>Board: ${moves.map((m) => `${esc(m.id)} → ${LABELS[m.to] || esc(m.to)}`).join(", ")}</i>`);
  return out.join("\n");
}

// Process notes from the PM (the board keeper), about one job.
function stallText(cfg, job, quietMinutes) {
  return `${handleOf(cfg, orcOf(cfg))} no activity from ${handleOf(cfg, job.agentId)} on <b>${esc(titleOf(job.label))}</b> for ${quietMinutes} min. Can you check on it?`;
}

function interruptedText(cfg, job) {
  return `${handleOf(cfg, orcOf(cfg))} the gateway restart cut off ${handleOf(cfg, job.agentId)}'s task <b>${esc(titleOf(job.label))}</b> before it finished. Please restart it.`;
}

function unactedText(cfg, job, waitedMinutes, wakes) {
  return `${ownerTag(cfg)} heads-up: ${handleOf(cfg, job.agentId)}'s result for <b>${esc(titleOf(job.label))}</b> has waited ${waitedMinutes} min, and ${handleOf(cfg, orcOf(cfg))} has not picked it up after ${wakes} reminders. It needs a nudge.`;
}

function wakeCapText(cfg, max) {
  return `${ownerTag(cfg)} I've used today's ${max} automatic reminders for ${handleOf(cfg, orcOf(cfg))}. Open work now needs a nudge from you.`;
}

function teamStuckText(cfg, items, reminders) {
  const list = items.slice(0, 12).map((it) => `• ${esc(clip(it.title || it.id, 80))} (${esc(it.project || "?")}, ${esc(LABELS[it.status] || it.status || "?")}, ${esc(it.id)})`).join("\n");
  return `${ownerTag(cfg)} the team is stuck: these items have not moved after ${reminders} reminders to ${handleOf(cfg, orcOf(cfg))}.\n${list}${items.length > 12 ? `\n…and ${items.length - 12} more` : ""}`;
}

function budgetText(cfg, job, used) {
  return `💸 ${handleOf(cfg, job.agentId)}, <b>${esc(titleOf(job.label))}</b> has used its budget (${esc(String(used))}). The guard is stopping new steps: please report what you have now.`;
}

const GUARD_WHAT = {
  protectedFile: "changing a protected file (rules, guard or config)",
  protectedConfig: "changing the OpenClaw config",
  backChannel: "using a side channel instead of the team topics",
  spawnByWorker: "starting another agent (only the orchestrator hands out work)",
  sendByWorker: "messaging another session directly",
  orchestratorOnly: "doing specialist work itself (the orchestrator only dispatches)",
  modelPin: "pinning a model that is not allowed",
};

function guardText(cfg, rule, info) {
  return `🛡 Guard stopped ${handleOf(cfg, info.agentId)}: ${esc(GUARD_WHAT[rule] || rule)}${info.tool ? ` (<code>${esc(info.tool)}</code>)` : ""}.`;
}

function limitText(_cfg, untilMs, provider = "claude", spawn = {}) {
  const iso = new Date(untilMs).toISOString();
  const until = iso.slice(0, 10) === new Date().toISOString().slice(0, 10) ? iso.slice(11, 16) : `${new Date(untilMs).toUTCString().slice(0, 11)} ${iso.slice(11, 16)}`;
  if (provider === "codex") {
    return `⚠️ Codex's usage limit is reached until ${until} UTC. New tasks run on ${esc(modelName((spawn && spawn.claudeFallbackModel) || "anthropic/claude-sonnet-5-5"))} until then.`;
  }
  if (!(spawn && spawn.codexModel)) {
    return `⚠️ Claude's usage limit is reached until ${until} UTC. New tasks wait until then (no Codex fallback) and pick up again by themselves.`;
  }
  return `⚠️ Claude's usage limit is reached until ${until} UTC. New tasks run on ${esc(modelName(spawn.codexModel))} until then.`;
}

// Sent in place of OpenClaw's "couldn't finish this reply" while Claude's usage limit holds.
function limitHoldText(_cfg, untilMs, now = Date.now()) {
  const iso = new Date(untilMs).toISOString();
  const until = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? iso.slice(11, 16) : `${new Date(untilMs).toUTCString().slice(0, 11)} ${iso.slice(11, 16)}`;
  const mins = Math.max(1, Math.round((untilMs - now) / 60000));
  const left = mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  return `⏸ Claude's usage limit is reached, so I can't answer until ${until} UTC (in about ${left}). Nothing is broken, and your message is kept: I answer it as soon as the limit resets.`;
}

// The orchestrator asks the owner to approve checked work (archiving needs both).
function approvalAskText(cfg, items) {
  if (items.length === 1) {
    const it = items[0];
    return `${ownerTag(cfg)} ✅ <b>${esc(clip(it.title || it.id, 120))}</b> is done and I've checked it. Reply <code>approve ${esc(it.id)}</code> to archive it.`;
  }
  const list = items.map((it) => `• ${esc(clip(it.title || it.id, 90))} (${esc(it.id)})`).join("\n");
  return `${ownerTag(cfg)} these are done and I've checked them:\n${list}\nReply <code>approve ${items.map((it) => esc(it.id)).join(" ")}</code> to archive them (or <code>approve all</code>).`;
}

// The orchestrator's answer under a worker's result when it moved the item without saying so:
// its own note, the worker mentioned, and the move.
function boardReplyText(cfg, job, id, status, note) {
  const said = String(note || "").trim();
  const body = said ? mdToHtml(clip(said, 700), 800) : "thanks, I've taken it from here.";
  return `${handleOf(cfg, job.agentId)} ${body}\n<i>Board: ${esc(id)} → ${LABELS[status] || esc(status)}</i>`;
}

// The reply to the owner's "approve …" message.
function approvalReplyText(cfg, archived, waiting, notDone) {
  const name = (it) => `${esc(clip(it.title || it.id, 80))} (${esc(it.id)})`;
  const out = [];
  if (archived.length) out.push(`🗄 Thanks, archived: ${archived.map(name).join(", ")}.`);
  if (waiting.length) out.push(`👍 Noted. ${waiting.map(name).join(", ")} ${waiting.length === 1 ? "gets" : "get"} archived once I've checked ${waiting.length === 1 ? "it" : "them"} too.`);
  if (notDone.length) out.push(`${notDone.map(name).join(", ")} ${notDone.length === 1 ? "is" : "are"} not done yet, so I can't archive ${notDone.length === 1 ? "it" : "them"}.`);
  return out.join("\n") || "I couldn't find those items on the board.";
}

function auditText(_cfg, status, report) {
  return `🧾 Board check${status && status !== "ok" && status !== "done" ? ` (${esc(status)})` : ""}: ${report ? mdToHtml(report, 1800) : "nothing to fix."}`;
}

// A dispatch the runtime refused (not the guard): the real error, so nobody has to guess the cause.
// (On 2026-11-07 every dispatch failed for an hour on "account or native runtime is unavailable" while
// the account had 88% of its window left; the orchestrator told the owner it was a usage limit.)
function spawnErrorText(_cfg, agentId, error, limitedUntil, retryAfterSeconds) {
  const why = limitedUntil
    ? `The guard recorded a usage limit until ${new Date(limitedUntil).toISOString().slice(11, 16)} UTC.`
    : retryAfterSeconds
      ? `This is OpenClaw's own Claude login check, not a usage limit: the guard has none recorded. The guard asked OpenClaw to check the login again and will wake the orchestrator to send it again in ${Math.max(1, Math.round(retryAfterSeconds / 60))} min.`
      : "The guard has no usage limit recorded, so do not call it one: the operator checks it.";
  return `⚠️ Dispatch to ${esc(agentId ? nameOf(_cfg, agentId) : "an agent")} failed: <code>${esc(String(error || "").slice(0, 240))}</code>\n${why}`;
}

function movedText(_cfg, project) {
  return `↪️ Moved to the <b>${esc(project || "team")}</b> topic.`;
}

export {
  limitHoldText,
  esc, clip, nameOf, handleOf, ownerTag, titleOf, modelName, mdToHtml, htmlToPlain, splitReport,
  dispatchText, ackText, resultText, stallText, interruptedText, unactedText, wakeCapText, teamStuckText,
  budgetText, guardText, limitText, approvalAskText, approvalReplyText, auditText, movedText, boardReplyText, spawnErrorText,
};
