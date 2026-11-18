// task_inbox tool helpers: map tool params to oc-inbox CLI arguments and run it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normStatus } from "./board.js";

const INBOX_ACTIONS = ["add", "list", "plan", "set", "show", "approve", "board"];
const INBOX_FLAGS = {
  project: "--project",
  title: "--title",
  type: "--type",
  priority: "--priority",
  details: "--details",
  done_when: "--done-when",
  source: "--source",
  status: "--status",
  batch: "--batch",
  note: "--note",
  owner: "--owner",
  size: "--size",
  area: "--area",
  rank: "--rank",
};
const ACTION_FIELDS = {
  add: ["project", "title", "type", "priority", "details", "done_when", "source", "owner", "size", "area"],
  list: ["status", "project"],
  plan: [],
  set: ["status", "batch", "note", "owner", "size", "area", "done_when", "priority", "rank", "project"],
  show: [],
  approve: [],
  board: ["project"],
};

function inboxArgs(params) {
  const p = params && typeof params === "object" ? params : {};
  const action = String(p.action || "").trim();
  if (!INBOX_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${INBOX_ACTIONS.join(", ")}`);
  }
  const args = [action];
  if (action === "set" || action === "show") {
    if (!p.id) throw new Error(`action ${action} needs id`);
    args.push(String(p.id));
  }
  if (action === "approve") {
    const ids = String(p.id || "").match(/\b[0-9a-f]{8}\b/g) || [];
    if (ids.length === 0) throw new Error("action approve needs id (one or more 8-character item ids)");
    return ["approve", ...ids, "--by", "orchestrator"];
  }
  if (action === "add" && (!p.project || !p.title)) {
    throw new Error("action add needs project and title");
  }
  for (const key of ACTION_FIELDS[action]) {
    const value = p[key];
    if (value !== undefined && value !== null && String(value) !== "") args.push(INBOX_FLAGS[key], String(value));
  }
  if ((action === "list" || action === "plan" || action === "board") && p.json === true) args.push("--json");
  if (action === "add" || action === "set") args.push("--by", String(p.by || "agent"));
  return args;
}

function runInbox(args, { bin = process.env.OC_INBOX_BIN || join(homedir(), ".openclaw", "bin", "oc-inbox"), timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile("python3", [bin, ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, text: [String(stdout || "").trim(), String(stderr || "").trim()].filter(Boolean).join("\n") });
    });
  });
}

function inboxFile() {
  return process.env.OC_INBOX_FILE || join(homedir(), ".openclaw", "inbox", "inbox.jsonl");
}

// How many status moves an item keeps (oc-inbox HISTORY_KEEP).
const HISTORY_KEEP = 20;

// A status move, recorded the way oc-inbox _move records it (no entry when the status does not change).
function moveItem(it, to, ev, note = ev.note) {
  const from = it.status;
  if (from === to) return;
  it.status = to;
  it.history.push({ ts: ev.ts ?? null, from, to, by: ev.by ?? null, note: note ?? null });
  if (it.history.length > HISTORY_KEEP) it.history = it.history.slice(-HISTORY_KEEP);
}

// Current items by id, folded from the inbox event log exactly as oc-inbox fold_state does, with the same fields
// (details, source, batch and history included). 2026-11-18: this fold used to drop them, so briefs never carried
// the owner's words, replies lost their source message, and every check that reads history (stranded moves, the
// "Rescoped:" streak reset, "User path:" proof) saw an empty one. tests/test_inbox_parity.py keeps the two folds equal.
function loadInboxItems(file = inboxFile()) {
  const items = new Map();
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return items;
  }
  for (const line of raw.split("\n")) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || !ev.id) continue;
    if (ev.kind === "add") {
      items.set(ev.id, {
        id: ev.id, project: ev.project, title: ev.title, type: ev.type || "task", priority: ev.priority || "normal",
        rank: null, details: ev.details ?? null, done_when: ev.done_when ?? null, source: ev.source ?? null,
        owner: ev.owner ?? null, size: ev.size || "medium", area: ev.area ?? null, status: normStatus(ev.status || "backlog"),
        batch: null, note: null, orc_approved_ts: null, owner_approved_ts: null, history: [],
        created_ts: ev.ts ?? null, updated_ts: ev.ts ?? null,
      });
      continue;
    }
    const it = items.get(ev.id);
    if (!it) continue;
    if (ev.kind === "set") {
      for (const key of ["owner", "size", "area", "done_when", "title", "priority", "project"]) if (ev[key]) it[key] = ev[key];
      if ("rank" in ev) it.rank = Number(ev.rank) > 0 ? Number(ev.rank) : null; // the PM's queue position (0 clears it)
      if ("batch" in ev) it.batch = ev.batch;
      if ("note" in ev) it.note = ev.note;
      if (ev.status) {
        const to = normStatus(ev.status);
        if (to !== "done" && to !== "dropped") { it.orc_approved_ts = null; it.owner_approved_ts = null; }
        moveItem(it, to, ev);
      }
      it.updated_ts = ev.ts ?? null;
    } else if (ev.kind === "approve" && (it.status === "done" || it.status === "dropped")) {
      if (ev.by === "owner") it.owner_approved_ts = ev.ts; else it.orc_approved_ts = ev.ts;
      if (it.orc_approved_ts && it.owner_approved_ts) moveItem(it, "archived", ev, "approved by the orchestrator and the owner");
      it.updated_ts = ev.ts ?? null;
    }
  }
  return items;
}

export { INBOX_ACTIONS, inboxArgs, runInbox, loadInboxItems };
