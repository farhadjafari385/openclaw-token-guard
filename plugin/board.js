// The task board: columns, allowed moves, automatic moves when a task's job
// ends, the Telegram board view, the board audit, and owner approvals.
// Pure: no OpenClaw imports. bin/oc-inbox implements the same table in Python.

const COLUMNS = ["backlog", "todo", "in_progress", "review", "qa", "blocked", "done", "dropped", "archived"];
const LEGACY = { open: "backlog", planned: "todo", dispatched: "in_progress" };
const LABELS = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", review: "Review", qa: "QA", blocked: "Blocked",
  done: "Done, awaiting approval", dropped: "Dropped, awaiting approval", archived: "Archived",
};
const ICONS = { backlog: "▫️", todo: "📌", in_progress: "🔄", review: "👀", qa: "🧪", blocked: "⛔", done: "✅", dropped: "🗑", archived: "🗄" };

// Moves an agent may make with task_inbox set. Archiving needs the orchestrator's and the owner's approval.
const TRANSITIONS = {
  backlog: ["todo", "blocked", "dropped"],
  todo: ["backlog", "in_progress", "blocked", "dropped"],
  in_progress: ["review", "qa", "todo", "blocked", "dropped"],
  review: ["qa", "done", "in_progress", "todo", "blocked", "dropped"],
  qa: ["done", "in_progress", "todo", "blocked", "dropped"],
  blocked: ["backlog", "todo", "in_progress", "review", "qa", "dropped"],
  done: ["in_progress", "todo"],
  dropped: ["backlog", "todo"],
  archived: [],
};
const DISPATCHABLE = new Set(["backlog", "todo", "blocked", "in_progress", "review", "qa"]);
const OPEN = new Set(["backlog", "todo", "in_progress", "review", "qa", "blocked"]);

function normStatus(status) {
  const s = String(status || "backlog").toLowerCase().replace(/[\s-]+/g, "_");
  return LEGACY[s] || (COLUMNS.includes(s) ? s : "backlog");
}

function canMove(from, to) {
  const a = normStatus(from);
  const b = normStatus(to);
  return a === b || (TRANSITIONS[a] || []).includes(b);
}

// Run outcomes that mean the work did not finish. "deleted" and "reset" are not among them:
// OpenClaw reports "deleted" when it cleans up a finished task's session (cleanup: delete).
// Counting it as failed sent finished work back to To do (26 times by 2026-11-05).
const FAILED_OUTCOMES = new Set(["error", "timeout", "killed", "lost"]);

// The worker's verdict, from the RESULT line of its report.
function resultVerdict(text, outcome) {
  if (outcome && FAILED_OUTCOMES.has(outcome)) return "failed";
  const m = /^\s*[*_`>]*\s*RESULT\s*[:=-]\s*[*_`]*\s*([a-z ]+)/im.exec(String(text || ""));
  const v = m ? m[1].trim().toLowerCase() : "";
  if (/^(done|approved|pass|passed|merged|released|shipped|complete|completed)\b/.test(v)) return "done";
  if (/^blocked\b/.test(v)) return "blocked";
  if (/^(changes requested|fail|failed|partly|partially|partial|not done)\b/.test(v)) return "failed";
  return "unknown"; // no clear verdict (or no text captured): the orchestrator checks it in Review
}

// Columns a task's end may move an item out of: the work it was dispatched for. An item someone
// has moved since (Done, Blocked, To do...) is left alone, so a late or duplicate result can
// never undo the orchestrator's decision (on 2026-11-04 late "failed" results reopened Done items).
const AUTO_FROM = new Set(["in_progress", "review", "qa"]);

// Where an item goes when a task working on it ends (unchanged when it is no longer in that work).
function nextAfterJob(before, role, verdict) {
  const s = normStatus(before);
  if (!AUTO_FROM.has(s)) return s;
  if (verdict === "blocked") return "blocked";
  if (verdict === "failed") return "todo";
  if (verdict !== "done") return "review"; // no clear verdict: the orchestrator checks it
  if (role === "reviewer") return "qa";
  if (role === "qa") return "done";
  if (role === "devops" && s === "qa") return "done"; // release after QA
  return "review";
}

const SHORT = {
  backlog: "in backlog", todo: "to do", in_progress: "in progress", review: "in review", qa: "in QA",
  blocked: "blocked", done: "done", dropped: "dropped",
};

function itemLine(it) {
  const title = String(it.title || "(untitled)").slice(0, 70);
  const who = it.owner ? ` — ${it.owner}` : "";
  let extra = "";
  if (it.status === "done" || it.status === "dropped") {
    extra = ` (orchestrator ${it.orc_approved_ts ? "✓" : "…"}, you ${it.owner_approved_ts ? "✓" : "…"})`;
  } else if (it.status === "blocked" && it.note) {
    extra = `\n     ↳ ${String(it.note).slice(0, 90)}`;
  }
  return `${title}${who} · ${it.id}${extra}`;
}

function renderBoard(projectName, items, now = Date.now(), maxPerColumn = 8) {
  const list = [...items].filter((it) => normStatus(it.status) !== "archived");
  const lines = [`📋 ${projectName} board · updated ${new Date(now).toISOString().slice(11, 16)} UTC`];
  for (const col of COLUMNS) {
    if (col === "archived") continue;
    const inCol = list.filter((it) => normStatus(it.status) === col);
    if (inCol.length === 0) continue;
    lines.push("", `${ICONS[col]} ${LABELS[col]} (${inCol.length})`);
    for (const it of inCol.slice(0, maxPerColumn)) lines.push(`  • ${itemLine(Object.assign({}, it, { status: col }))}`);
    if (inCol.length > maxPerColumn) lines.push(`  • …and ${inCol.length - maxPerColumn} more`);
  }
  if (lines.length === 1) lines.push("", "Nothing open right now.");
  const waiting = list.filter((it) => ["done", "dropped"].includes(normStatus(it.status)) && !it.owner_approved_ts);
  if (waiting.length) lines.push("", `To archive, reply here: approve ${waiting.slice(0, 4).map((it) => it.id).join(" ")}${waiting.length > 4 ? " …" : ""} (or: approve all)`);
  return lines.join("\n").slice(0, 3900);
}

function renderOverview(byProject, now = Date.now()) {
  const lines = [`📋 Team board · updated ${new Date(now).toISOString().slice(11, 16)} UTC`, ""];
  for (const [project, items] of Object.entries(byProject)) {
    const counts = {};
    for (const it of items) {
      const s = normStatus(it.status);
      if (s !== "archived") counts[s] = (counts[s] || 0) + 1;
    }
    const parts = COLUMNS.filter((c) => counts[c]).map((c) => `${ICONS[c]} ${counts[c]} ${SHORT[c]}`);
    if (parts.length) lines.push(`• ${project}: ${parts.join(", ")}`);
  }
  if (lines.length === 2) lines.push("No open work.");
  return lines.join("\n");
}

// Board problems that code can see for free. The PM audit fixes the rest.
function auditBoard(items, runningItemIds, ownerAsks, now = Date.now(), cfg = {}) {
  const lostAfter = (cfg.lostMinutes || 15) * 60000;
  const waitAfter = (cfg.gateWaitHours || 2) * 3600000;
  const staleAfter = (cfg.backlogStaleHours || 24) * 3600000;
  const issues = [];
  for (const it of items) {
    const s = normStatus(it.status);
    const age = now - Date.parse(it.updated_ts || it.created_ts || 0);
    if (s === "in_progress" && !runningItemIds.has(it.id) && age > lostAfter) issues.push({ kind: "lost", id: it.id, text: `${it.id} is In progress but no task is running for it` });
    if ((s === "review" || s === "qa") && !runningItemIds.has(it.id) && age > waitAfter) issues.push({ kind: "waiting", id: it.id, text: `${it.id} has waited in ${LABELS[s]} for ${Math.round(age / 3600000)}h with no task` });
    if (s === "todo" && (!it.owner || !it.done_when)) issues.push({ kind: "incomplete", id: it.id, text: `${it.id} is in To do without ${!it.owner ? "an owner" : "a Done when"}` });
    if (s === "backlog" && age > staleAfter) issues.push({ kind: "stale", id: it.id, text: `${it.id} has sat in Backlog for ${Math.round(age / 3600000)}h` });
  }
  for (const ask of ownerAsks || []) {
    if (!ask.captured && now - ask.at > (cfg.captureMinutes || 30) * 60000) {
      issues.push({ kind: "missed", text: `owner message in topic ${ask.topic} may not be on the board: "${String(ask.text).slice(0, 140)}"` });
    }
  }
  return issues;
}

// Owner approval in a Telegram message: "approve a1b2c3d4 e5f6a7b8", "approved all", "archive 1a2b3c4d".
function parseApproval(text) {
  const t = String(text || "");
  if (!/\b(approve|approved|approves|archive|confirm|confirmed)\b/i.test(t)) return null;
  const ids = [...new Set(t.match(/\b[0-9a-f]{8}\b/g) || [])];
  const all = /\b(all|everything|them)\b/i.test(t);
  if (ids.length === 0 && !all) return null;
  return { ids, all: ids.length === 0 && all };
}

// Does an owner message look like a request that belongs on the board?
function looksLikeRequest(text) {
  const t = String(text || "").trim();
  if (t.length < 25 || parseApproval(t)) return false;
  return /\b(fix|add|make|change|create|deploy|remove|delete|build|implement|update|move|rename|need|needs|should|must|want|why|broken|bug|error|issue|not working|doesn'?t work|failing|failed|wrong|missing|improve|redesign|check)\b/i.test(t);
}

export {
  COLUMNS, LEGACY, LABELS, TRANSITIONS, DISPATCHABLE, OPEN, AUTO_FROM, FAILED_OUTCOMES,
  normStatus, canMove, resultVerdict, nextAfterJob, renderBoard, renderOverview, auditBoard, parseApproval, looksLikeRequest,
};
