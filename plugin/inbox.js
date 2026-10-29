// task_inbox tool helpers: map tool params to oc-inbox CLI arguments and run it.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const INBOX_ACTIONS = ["add", "list", "plan", "set", "show"];
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
};
const ACTION_FIELDS = {
  add: ["project", "title", "type", "priority", "details", "done_when", "source"],
  list: ["status", "project"],
  plan: [],
  set: ["status", "batch", "note"],
  show: [],
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
  if (action === "add" && (!p.project || !p.title)) {
    throw new Error("action add needs project and title");
  }
  for (const key of ACTION_FIELDS[action]) {
    const value = p[key];
    if (value !== undefined && value !== null && String(value) !== "") args.push(INBOX_FLAGS[key], String(value));
  }
  if ((action === "list" || action === "plan") && p.json === true) args.push("--json");
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

export { INBOX_ACTIONS, inboxArgs, runInbox };
