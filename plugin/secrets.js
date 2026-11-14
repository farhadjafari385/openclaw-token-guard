import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Secret safety for every agent (the owner, 2026-11-13: "BE SURE NOTHING SENSITIVE DATA EXPOSED IN
// PUBLIC PAGES OR IN A PLACE SOMEONE TO FIND IT"). A secret is any value stored in the secrets folder,
// or anything shaped like a well-known credential. Pure decisions plus a cached loader; never logs a value.
//   secretDecide()  refuses a tool call that carries a secret out (message, browser, http body, file,
//                   git push) or reads the secrets folder outside an approved consumer.
//   redact*()       replace secrets in text, transcripts and outgoing posts with [REDACTED:<name>].

const HOME = os.homedir();

const DEFAULT_SECRETS = {
  enabled: true,
  dir: "~/.openclaw/secrets",
  // Extra regexes (strings) for commands allowed to read the secrets folder, beyond the built-in consumers.
  allowCommands: [],
  scanPush: true,
};

// Well-known credential shapes (the core gitleaks rules), matched even when the value is not in the folder.
const PATTERNS = [
  ["telegram-bot-token", /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{50,}/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b[rs]k_live_[A-Za-z0-9]{20,}/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

function expandHome(p) {
  const s = String(p || "");
  return s === "~" ? HOME : s.startsWith("~/") ? path.join(HOME, s.slice(2)) : s;
}

function mergeSecrets(cfg) {
  const c = (cfg && cfg.secrets) || {};
  return Object.assign({}, DEFAULT_SECRETS, c);
}

// ---- the value set ----

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const classes = (s) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;

// A stored line part looks like a secret (not a username, email, URL, date or plain word).
function secretish(raw, names) {
  const s = String(raw || "").trim().replace(/^[`"']+|[`"']+$/g, "");
  if (s.length < 8 || s.length > 4096 || /\s/.test(s)) return null;
  if (EMAIL.test(s) || /^(?:https?:\/\/|\/|~|\.\/)/.test(s)) return null;
  if (/^[\d\-:T.+Z]+$/.test(s) || /^[a-z_\-.]+$/.test(s)) return null;
  if (/^[A-Z0-9_]+$/.test(s) && !/\d/.test(s)) return null;
  if (/[`*()]|\.(?:token|pass|key|secret|md|txt|pem|b64|json|sh|py)\b/.test(s)) return null;
  if (/^[A-Za-z][a-z]+[.,:;!?]?$/.test(s)) return null;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(s) && !/\d.*[A-Za-z].*\d/.test(s)) return null;
  if (names && (names.has(s) || names.has(s.replace(/[.,:;]+$/, "")))) return null;
  if (s.length >= 20 && classes(s) >= 2) return s;
  return classes(s) >= 3 ? s : null;
}

function valuesFromText(text, name, names, add) {
  if (/PRIVATE KEY/.test(text) || name.endsWith(".b64")) {
    text.split(/\r?\n/).forEach((l, i) => {
      const t = l.trim();
      if (t.length >= 40 && !t.startsWith("-----")) add(t.slice(0, 64), name);
    });
    return;
  }
  try {
    const walk = (o) => {
      if (typeof o === "string") add(secretish(o, names), name);
      else if (o && typeof o === "object") Object.values(o).forEach(walk);
    };
    const j = JSON.parse(text);
    if (j && typeof j === "object") { walk(j); return; }
  } catch { /* not JSON */ }
  const registry = name.startsWith("ACCOUNTS-REGISTRY");
  const keep = (v) => {
    const s = secretish(v, names);
    if (!s) return;
    if (registry && (s.length < 16 || !/\d/.test(s))) return; // the registry lists names; only keep real values
    add(s, name);
  };
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    keep(l);
    const m = /^[\w .\-/]+?\s*[:=]\s*(.+)$/.exec(l);
    if (m) keep(m[1]);
    l.split("|").forEach(keep);
    l.split(/[\s,;]+/).forEach(keep);
  }
}

// Every value in the folder: Map(value -> secret file name). Unreadable files are skipped.
function loadSecretValues(dir) {
  const root = expandHome(dir);
  const files = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(root);
  const names = new Set(files.map((p) => path.basename(p)));
  const values = new Map();
  const add = (v, name) => {
    if (!v || values.has(v)) return;
    for (const n of names) if (n.length > 8 && v.startsWith(n)) return;
    values.set(v, name);
  };
  for (const p of files) {
    const name = path.relative(root, p);
    if (p.endsWith(".pub") || path.basename(p).startsWith(".saved-by")) continue;
    let text;
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > 2_000_000 || buf.includes(0)) continue;
      text = buf.toString("utf8");
    } catch { continue; }
    valuesFromText(text, name, names, add);
  }
  return values;
}

// Cached matcher, rebuilt when the folder changes (a new secret is caught from its first use).
let cache = { key: "", at: 0, values: new Map(), re: null };
function matcher(cfg) {
  const s = mergeSecrets(cfg);
  const dir = expandHome(s.dir);
  const now = Date.now();
  if (cache.dir === dir && now - cache.at < 30_000) return cache;
  let key = "";
  try {
    // Names and change times of every file: an added, replaced or edited secret rebuilds the set.
    key = fs.readdirSync(dir).map((n) => {
      try { return `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`; } catch { return n; }
    }).join("|");
  } catch { key = "none"; }
  if (cache.dir === dir && cache.key === key) { cache.at = now; return cache; }
  const values = s.values instanceof Map ? s.values : loadSecretValues(dir);
  const sorted = [...values.keys()].sort((a, b) => b.length - a.length);
  const re = sorted.length ? new RegExp(sorted.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
  cache = { dir, key, at: now, values, re };
  return cache;
}

function resetSecretCache() {
  cache = { key: "", at: 0, values: new Map(), re: null };
}

// The first secret in the text: { name, kind } (never the value), or null.
function findSecret(text, cfg) {
  const t = String(text || "");
  if (!t) return null;
  const m = matcher(cfg);
  if (m.re) {
    m.re.lastIndex = 0;
    const hit = m.re.exec(t);
    if (hit) return { name: m.values.get(hit[0]) || "secret", kind: "value" };
  }
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(t)) return { name, kind: "pattern" };
  }
  return null;
}

function redactText(text, cfg) {
  if (typeof text !== "string" || !text) return text;
  const m = matcher(cfg);
  let out = text;
  if (m.re) out = out.replace(m.re, (v) => `[REDACTED:${String(m.values.get(v) || "secret").split("#")[0]}]`);
  for (const [name, re] of PATTERNS) out = out.replace(re, `[REDACTED:${name}]`);
  return out;
}

// A deep copy with every string redacted, or the same object when nothing changed.
function redactDeep(value, cfg, depth = 0) {
  if (typeof value === "string") return redactText(value, cfg);
  if (!value || typeof value !== "object" || depth > 12) return value;
  let changed = false;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    const r = redactDeep(v, cfg, depth + 1);
    if (r !== v) changed = true;
    out[k] = r;
  }
  return changed ? out : value;
}

function findSecretDeep(value, cfg, depth = 0) {
  if (typeof value === "string") return findSecret(value, cfg);
  if (!value || typeof value !== "object" || depth > 12) return null;
  for (const v of Object.values(value)) {
    const hit = findSecretDeep(v, cfg, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ---- reading the secrets folder ----

const SECRET_DIR_RE = /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s'"]+|\/root)?\/?\.openclaw\/secrets\b/;

// The value given to oc-secret-save on a heredoc is the one place a value may appear: it is the input.
const SAVE_HEREDOC = /(\boc-secret-save\b[^\n]*?<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
function stripSaveInput(command) {
  return String(command || "").replace(SAVE_HEREDOC, (m, head, q, tag) => `${head}${tag}`);
}

// Consumers that take a secret without printing it.
const CONSUMERS = [
  /\boc-secret-save\b/,                                        // stores a value
  /\bcurl\b[^\n]*?(?:\s-K\s*-|\s--config[=\s]+-)(?=\s|$)/,     // curl reads its config (headers, URL) from stdin
  /\bcurl\b[^\n]*?\s(?:-H|--header)\s+@/,                      // curl headers from a file
  /--password-stdin\b/,                                        // docker/helm login
  /\bGIT_ASKPASS=/,                                            // git asks a helper for the token
  /\b(?:ssh|scp|sftp|rsync)\b[^\n]*\s-i\s/,                    // an SSH key as identity file
  /\bGIT_SSH_COMMAND=/,
];
// Commands that only look at names, sizes or existence.
const METADATA = /^\s*(?:ls|stat|test|\[|\[\[|file|du|wc\s+-[cl]|find)\b/;
const LEAKY = /\btee\b|\/dev\/(?:stdout|stderr|tty)|>&\s*2|\bxxd\b|\bbase64\b|\bod\b|\bstrings\b|-exec\b|\becho\b[^|]*\$\(|\bprintenv\b/;

function statements(command) {
  // Statements split on ; && || and newlines (outside quotes is not tracked: a split inside quotes only
  // makes the check stricter). Pipelines stay together: `cat f | curl -K -` is one consumer.
  return String(command || "").split(/;|&&|\|\||\n/).map((s) => s.trim()).filter(Boolean);
}

// Why a command reads the secrets folder in a way that can print a value, or "".
function secretReadViolation(rawCommand, cfg) {
  const s = mergeSecrets(cfg);
  const command = stripSaveInput(rawCommand);
  if (!SECRET_DIR_RE.test(command)) return "";
  const extra = (s.allowCommands || []).map((r) => { try { return new RegExp(r); } catch { return null; } }).filter(Boolean);
  const askpass = /\bGIT_ASKPASS\b/.test(command);
  for (const st of statements(command)) {
    if (!SECRET_DIR_RE.test(st)) continue;
    if (extra.some((re) => re.test(st))) continue;
    if (METADATA.test(st) && !LEAKY.test(st)) continue;
    if (CONSUMERS.some((re) => re.test(st)) && !LEAKY.test(st)) continue;
    // Writing a GIT_ASKPASS helper that names the file (the path goes into the helper, not to output).
    if (askpass && /^(?:printf|echo|cat)\b[^|]*>\s*\S/.test(st) && !/>\s*&|\/dev\/std/.test(st)) continue;
    return st.length > 120 ? `${st.slice(0, 117)}...` : st;
  }
  return "";
}

const READ_TOOLS = new Set(["Read", "read", "Grep", "grep", "NotebookRead", "file_fetch", "dir_fetch", "view_image", "pdf", "fs_read", "read_file"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit", "apply_patch", "file_write", "fs_write", "create_file", "str_replace_editor"]);
const SHELL_TOOLS = new Set(["exec", "bash", "Bash", "shell"]);
const GIT_PUSH = /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)*\s+push\b/;

function underSecrets(p, cfg) {
  const s = mergeSecrets(cfg);
  const dir = path.resolve(expandHome(s.dir));
  const abs = path.resolve(expandHome(String(p || "")));
  return abs === dir || abs.startsWith(dir + path.sep) || SECRET_DIR_RE.test(String(p || ""));
}

function toolPaths(params) {
  const out = [];
  for (const key of ["file_path", "path", "notebook_path", "target", "filePath", "file", "pdf"]) {
    if (typeof params[key] === "string") out.push(params[key]);
  }
  for (const key of ["paths", "pdfs"]) if (Array.isArray(params[key])) out.push(...params[key].filter((x) => typeof x === "string"));
  return out;
}

// The repo a push runs in: `git -C <dir> push`, `cd <dir> && git push`, else the tool's workdir.
function pushDir(command, workdir) {
  const c = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(?:-\S+\s+)*push\b/.exec(command);
  if (c) return expandHome(c[1].replace(/^["']|["']$/g, ""));
  const cd = /(?:^|[;&|\n]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)[^\n]*?\bgit\b[^\n]*\bpush\b/.exec(command);
  if (cd) return path.resolve(expandHome(workdir || process.cwd()), expandHome(cd[1].replace(/^["']|["']$/g, "")));
  return expandHome(workdir || process.cwd());
}

// The commits a push would publish: those on no remote yet (all of them for a repo with no remote).
function outgoingDiff(dir) {
  try {
    return execFileSync("git", ["-C", dir, "log", "-p", "--no-color", "--no-ext-diff", "--max-count=200", "HEAD", "--not", "--remotes"], {
      encoding: "utf8", timeout: 8000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

const HOW =
  "Secrets are used only through a consumer that never prints them: `curl -K -` reading its config from stdin, " +
  "GIT_ASKPASS, `--password-stdin`, `ssh -i`, or `~/.openclaw/bin/oc-secret-save` to store one. Never paste a value " +
  "into a message, page, form, file, command line or commit.";

// The decision for one tool call. undefined = allow; { block, blockReason, rule } = refuse.
function secretDecide(event, ctx, cfg, log) {
  const s = mergeSecrets(cfg);
  if (!s.enabled || !event) return undefined;
  const tool = String(event.toolName || "").split("__").pop();
  const params = event.params && typeof event.params === "object" ? event.params : {};
  const agentId = (ctx && ctx.agentId) || "";
  const enforce = !cfg || cfg.mode !== "warn";
  const block = (rule, reason) => {
    if (typeof log === "function") log(enforce ? "warn" : "info", `token-guard ${enforce ? "blocked" : "would block"} ${tool} (${rule})`, { rule, agentId, sessionKey: ctx && ctx.sessionKey, toolName: tool });
    return enforce ? { block: true, blockReason: reason, rule } : undefined;
  };

  // 1. Reading the secrets folder into output.
  if (READ_TOOLS.has(tool) && toolPaths(params).some((p) => underSecrets(p, cfg))) {
    return block("secretRead", `token-guard: reading a file in the secrets folder would put its value in your transcript. ${HOW}`);
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof params.command === "string" ? params.command : "";
    const why = secretReadViolation(command, cfg);
    if (why) return block("secretRead", `token-guard: \`${why}\` reads the secrets folder where its value can be printed. ${HOW}`);
  }

  // 2. A secret value in the call itself: a message, a browser fill, an HTTP body, a URL, a file, a command line.
  const scanned = SHELL_TOOLS.has(tool) && typeof params.command === "string"
    ? Object.assign({}, params, { command: stripSaveInput(params.command) })
    : params;
  const hit = findSecretDeep(scanned, cfg);
  if (hit) {
    const where = WRITE_TOOLS.has(tool) ? "write it into a file" : SHELL_TOOLS.has(tool) ? "put it on a command line or in a request body" : `send it out through ${tool}`;
    return block(WRITE_TOOLS.has(tool) ? "secretInFile" : SHELL_TOOLS.has(tool) ? "secretInCommand" : "secretOutbound",
      `token-guard: this call contains a secret (${hit.name}) and would ${where}. ${HOW}`);
  }

  // 3. A push whose new commits carry a secret.
  if (s.scanPush && SHELL_TOOLS.has(tool) && GIT_PUSH.test(String(params.command || ""))) {
    const diff = outgoingDiff(pushDir(String(params.command), params.workdir || params.cwd));
    const leak = findSecret(diff, cfg);
    if (leak) {
      return block("secretInPush", `token-guard: a commit you are about to push contains a secret (${leak.name}). Remove it, rewrite those commits, and rotate the value if it was ever pushed. ${HOW}`);
    }
  }
  return undefined;
}

export {
  DEFAULT_SECRETS,
  PATTERNS,
  findSecret,
  findSecretDeep,
  loadSecretValues,
  redactDeep,
  redactText,
  resetSecretCache,
  secretDecide,
  secretReadViolation,
  secretish,
  stripSaveInput,
};
