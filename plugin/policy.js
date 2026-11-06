import os from "node:os";
import path from "node:path";
import { DISPATCHABLE, normStatus } from "./board.js";
import { correctTopic, projectsMentioned } from "./topics.js";

// Team policy enforced on every tool call, for every agent. Pure: decisions
// only, no OpenClaw imports. policyDecide() returns undefined (allow),
// { params } (rewrite) or { block, blockReason, rule }.

const HOME = os.homedir();

const DEFAULT_POLICY = {
  orchestratorAgent: "coordinator",
  workspaceRoot: "~/.openclaw/workspace",
  protect: {
    enabled: true,
    paths: [
      "~/.openclaw/openclaw.json*",
      "~/.openclaw/gateway.systemd.env",
      "~/.openclaw/token-guard/**",
      "~/.openclaw/token-guard-state/**",
      "~/.openclaw/team/**",
      "~/.openclaw/inbox/**",
      "~/.openclaw/bin/**",
      "~/.openclaw/extensions/**",
      "~/.openclaw/npm/**",
      "~/.openclaw/state/**",
      "~/.openclaw/secrets/**",
      "~/.openclaw/agents/*/agent/**",
      "~/.openclaw/workspace/AGENTS.md",
      "~/.openclaw/workspace/*/AGENTS.md",
      "~/.openclaw/workspace/*/SOUL.md",
      "~/.openclaw/workspace/*/IDENTITY.md",
      "~/.openclaw/workspace/*/USER.md",
      "~/.openclaw/workspace/*/TOOLS.md",
      "~/.openclaw/workspace/*/HEARTBEAT.md",
      "~/.openclaw/workspace/*/MEMORY.md",
      "~/.openclaw/workspace/*/skills/**",
      "~/.config/systemd/user/openclaw-*",
      "~/openclaw-team/**",
      "~/openclaw-token-guard/**",
    ],
  },
  backChannels: {
    enabled: true,
    blockedTools: ["SendMessage", "TeamCreate", "TeamDelete", "Agent", "Task", "conversations_send", "conversations_turn", "cron", "gateway"],
  },
  orchestratorOnly: { enabled: true },
  pins: { enabled: true },
  board: { enabled: true, requireItems: true, agent: "product" }, // agent = the PM, who may also edit the board
  topics: { enabled: true, chatId: "", teamTopic: 160 },
  taskPaths: { enabled: true, roles: ["writer", "designer", "qa", "reviewer"] },
  projects: {}, // { name: { topic, path, aliases, strict } }
  spawn: {
    enabled: true,
    cleanup: "delete",
    minRunTimeoutSeconds: 1800,
    defaultRunTimeoutSeconds: 3600,
    allowedModels: [
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-5-5",
    ],
    allowedThinking: ["off", "minimal", "low", "medium", "high"],
    // Off by default: while Claude is at its limit, tasks wait for the reset. Set a Codex model here
    // (and add it to allowedModels) to move new tasks to Codex instead.
    codexModel: "",
    claudeFallbackModel: "anthropic/claude-sonnet-5", // when Codex is on and at its limit
    limitedProviders: ["anthropic"],
  },
};

const RULES_MESSAGE =
  "Rules, personas, the guard and the OpenClaw config are managed only in the owner's openclaw-team repo. " +
  "You cannot change them. If a rule is wrong, say so in your final answer (or ask the orchestrator to raise it with the owner).";

function mergePolicy(cfg) {
  const c = cfg || {};
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_POLICY)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = Object.assign({}, value, c[key] && typeof c[key] === "object" ? c[key] : {});
    } else {
      merged[key] = c[key] !== undefined ? c[key] : value;
    }
  }
  return merged;
}

function expandHome(p) {
  return String(p).replace(/^~(?=\/|$)/, HOME).replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
}

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// "**" = anything, "*" = one path segment (or the rest of a file name).
function globBody(pattern) {
  return pattern.split("**").map((part) => part.split("*").map(escapeRe).join("[^/\\s'\"]*")).join("[^\\s'\"]*");
}

const patternCache = new Map();
function compileProtect(paths) {
  const key = JSON.stringify(paths);
  let hit = patternCache.get(key);
  if (hit) return hit;
  const exact = [];
  const inText = [];
  for (const raw of paths || []) {
    const abs = expandHome(raw);
    exact.push(new RegExp(`^${globBody(abs)}$`));
    const rel = abs.startsWith(HOME + "/") ? abs.slice(HOME.length + 1) : null;
    const forms = [globBody(abs)];
    if (rel) forms.push(`~/${globBody(rel)}`, `\\$\\{?HOME\\}?/${globBody(rel)}`);
    inText.push(new RegExp(`(?:${forms.join("|")})`));
  }
  hit = { exact, inText };
  patternCache.set(key, hit);
  return hit;
}

function agentWorkspace(policy, agentId) {
  return path.join(expandHome(policy.workspaceRoot), agentId || "");
}

function resolveToolPath(policy, agentId, p) {
  const s = expandHome(String(p || "").trim());
  if (!s) return "";
  return path.resolve(agentWorkspace(policy, agentId), s);
}

function isProtectedPath(policy, absPath) {
  if (!absPath) return false;
  return compileProtect(policy.protect.paths).exact.some((re) => re.test(absPath));
}

// Workspace-managed file names, for commands that name them relative to the workspace.
const MANAGED_BASENAMES = /(?:^|[\s'"=;&|(])(?:\.\/)?(AGENTS|SOUL|IDENTITY|USER|TOOLS|HEARTBEAT|MEMORY)\.md\b/;

function mentionsProtected(policy, command, agentId, workdir) {
  const { inText } = compileProtect(policy.protect.paths);
  if (inText.some((re) => re.test(command))) return true;
  // A bare AGENTS.md etc. is the agent's own workspace file unless the command clearly works elsewhere.
  const elsewhere = workdir && !expandHome(workdir).startsWith(expandHome(policy.workspaceRoot));
  if (!elsewhere && MANAGED_BASENAMES.test(command) && !/(?:^|\s)cd\s+(?!~\/\.openclaw|\$HOME\/\.openclaw|\/home\/[^/]+\/\.openclaw)\S/.test(command)) {
    return true;
  }
  return false;
}

// ---- tool helpers ----

function bareTool(name) {
  return String(name || "").split("__").pop();
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit", "apply_patch", "file_write", "fs_write", "create_file", "str_replace_editor"]);

function toolWritePaths(toolName, params) {
  const out = [];
  for (const key of ["file_path", "path", "notebook_path", "target", "filePath", "file"]) {
    if (typeof params[key] === "string") out.push(params[key]);
  }
  if (Array.isArray(params.files)) for (const f of params.files) if (f && typeof f.path === "string") out.push(f.path);
  if (Array.isArray(params.edits)) for (const e of params.edits) if (e && typeof e.file_path === "string") out.push(e.file_path);
  const patch = typeof params.patch === "string" ? params.patch : typeof params.input === "string" ? params.input : "";
  if (patch) {
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
    for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (m[1].trim() !== "/dev/null") out.push(m[1].trim());
  }
  return out;
}

// ---- shell analysis (on the raw text: paths inside quotes count) ----

function rawParts(command) {
  return String(command).split(/&&|\|\||[;|&\n]/).map((s) => s.trim()).filter(Boolean);
}

function headWord(segment) {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["sudo", "nohup", "env", "command", "builtin", "nice", "time", "exec", "doas"].includes(words[i]) || words[i].startsWith("-"))) i += 1;
  if (words[i] === "timeout") { i += 1; while (i < words.length && words[i].startsWith("-")) i += 1; i += 1; }
  return String(words[i] || "").replace(/^["'(]+/, "").split("/").pop();
}

const WRITE_HEADS = new Set(["cp", "mv", "rm", "ln", "install", "rsync", "dd", "truncate", "touch", "chmod", "chown", "chgrp",
  "chattr", "patch", "sponge", "unlink", "rmdir", "shred", "tee", "ed", "ex", "vi", "vim", "nvim", "nano", "emacs", "scp", "mkdir", "tar", "unzip"]);
const INTERPRETER_HEADS = /^(python[0-9.]*|node|perl|ruby|php|bash|sh|zsh|dash)$/;
const CODE_WRITES = /open\([^)]*['"][wax+]|\.write(?:_text|_bytes)?\(|json\.dump\(|os\.(?:remove|rename|replace|unlink|chmod|chown|makedirs|mkdir)|shutil\.|\.(?:unlink|rename|replace|touch|chmod)\(|writeFile|appendFile|copyFile|rmSync|renameSync|unlinkSync|mkdirSync|fs\.(?:rm|cp|rename|write)|\bsed\s+-i|\btee\b/;
const REDIRECT = /(?:^|[^0-9&<>|])>{1,2}\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g;

function redirectTargets(command) {
  const out = [];
  for (const m of String(command).matchAll(REDIRECT)) {
    const t = m[1].replace(/^["']|["']$/g, "");
    if (t && t !== "/dev/null" && !t.startsWith("&")) out.push(t);
  }
  return out;
}

function writesProtected(policy, command, agentId, workdir) {
  if (!mentionsProtected(policy, command, agentId, workdir)) return false;
  // Redirections into a protected path.
  for (const t of redirectTargets(command)) {
    if (isProtectedPath(policy, resolveToolPath(policy, agentId, t)) || MANAGED_BASENAMES.test(` ${t}`)) return true;
  }
  // Interpreter code (python -c, node -e, heredocs) may write anywhere in the command, so judge it as a whole.
  const parts = rawParts(command);
  if (parts.some((segment) => INTERPRETER_HEADS.test(headWord(segment))) && CODE_WRITES.test(command)) return true;
  let inProtectedDir = false;
  for (const segment of parts) {
    const head = headWord(segment);
    const mentions = mentionsProtected(policy, segment, agentId, workdir);
    if (head === "cd") { inProtectedDir = mentions; continue; }
    const touches = mentions || inProtectedDir;
    if (!touches) continue;
    if (WRITE_HEADS.has(head)) return true;
    if (/\bsed\b[^|;&]*\s-[a-zA-Z]*i/.test(segment) || /\bperl\b[^|;&]*\s-[a-zA-Z]*i/.test(segment) || /\bawk\b[^|;&]*-i\s+inplace/.test(segment)) return true;
    if (head === "git" && /\bgit\b[^;&|]*\b(checkout|restore|reset|stash|apply|am|rm|mv|clean|pull|merge|rebase|commit|push)\b/.test(segment)) return true;
    if (/(?:^|\s)tee\b/.test(segment)) return true;
  }
  return false;
}

const MUTATING_OPENCLAW = new RegExp(
  "\\bopenclaw\\s+(?:" + [
    "config\\s+(?:set|patch|unset|apply|edit|import|reset|restore)",
    "plugins?\\s+(?:install|uninstall|enable|disable|update|reload|link)",
    "(?:cron|automations?)\\s+(?:add|create|edit|update|rm|remove|delete|enable|disable|run|scratch)",
    "secrets\\s+(?:store\\s+(?:set|rm|import)|apply|configure|reload)",
    "agents?\\s+(?:add|create|delete|remove|set|update|rename|bind|unbind)",
    "models\\s+(?:set|fallbacks|aliases|auth)",
    "doctor\\b[^;&|\\n]*--(?:fix|repair|force)",
    "gateway\\s+(?:install|uninstall)",
    "hooks?\\s+(?:install|enable|disable|uninstall)",
    "channels?\\s+(?:add|remove|login|logout|set|enable|disable)",
    "memory\\s+(?:promote|reset|forget)",
    "update\\b",
  ].join("|") + ")", "i");

// ---- git safety (every agent) ----

const PROTECTED_BRANCH = "(?:refs\\/heads\\/)?(?:main|master|prod|production)";
const GIT_RULES = [
  { re: /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*\s--no-verify\b/, why: "git push --no-verify skips the hooks that protect main and block secrets" },
  { re: new RegExp(`\\bgit\\b[^;&|\\n]*\\bpush\\b[^;&|\\n]*(?:\\s|:|\\+)${PROTECTED_BRANCH}(?=\\s|$|;|&|\\|)`), why: "pushing to main, master or production directly; push an agent/<task-id> branch and open a merge request" },
  { re: /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*\s(?:--mirror|--all)\b/, why: "git push --mirror/--all also pushes protected branches" },
  { re: /\bgit\b(?:\s+-C\s+\S+)?\s+config\b[^;&|\n]*\bcore\.hookspath\s+\S/i, why: "changing core.hooksPath switches off the protective hooks" },
  { re: /\bgit\b[^;&|\n]*\s-c\s+core\.hookspath=/i, why: "overriding core.hooksPath switches off the protective hooks" },
];

function gitViolation(command) {
  const text = String(command || "").replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const rule of GIT_RULES) if (rule.re.test(text)) return rule.why;
  return null;
}

// ---- orchestrator-only ----

const ORC_MUTATIONS = [
  /\bgit\b[^;&|\n]*\b(commit|push|merge|rebase|reset|revert|cherry-pick|am|apply|tag|checkout|switch|restore|stash|rm|mv|clean|pull|init|clone)\b/,
  /\b(docker|podman)\b[^;&|\n]*\b(run|start|stop|restart|rm|rmi|build|push|pull|exec|compose|kill|create|update|prune|cp)\b/,
  /\bsystemctl\b[^;&|\n]*\b(start|stop|restart|reload|enable|disable|mask|kill|daemon-reload|edit|set-property)\b/,
  /\b(apt|apt-get|dnf|yum|snap|pip3?|npm|pnpm|yarn|bun|npx|cargo|gem|composer)\b[^;&|\n]*\b(install|add|remove|uninstall|publish|upgrade|update|run|exec|dlx|build|deploy|ci|create)\b/,
  /\bcurl\b[^;&|\n]*(?:-X\s*["']?(?:POST|PUT|PATCH|DELETE)|--request\s*["']?(?:POST|PUT|PATCH|DELETE)|\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)\b)/i,
  /\bwget\b[^;&|\n]*--(?:post|method|body)/i,
  /\b(gh|glab)\b[^;&|\n]*\b(create|merge|close|edit|delete|approve|rebase|revert|comment|review|cancel|retry|rerun|set)\b/,
  /\b(kubectl|helm|terraform|ansible|ansible-playbook|pulumi)\b[^;&|\n]*\b(apply|delete|install|upgrade|destroy|create|patch|run)\b/,
  /(?:^|[\s;&|])(?:ssh|scp|rsync|sftp)\s/,
  /(?:^|[\s;&|])(?:\.\/)?[\w./-]*deploy[\w.-]*\.sh\b/,
  /(?:^|[\s;&|])(?:sudo|doas)\s/,
  /\bsed\s+-[a-zA-Z]*i/,
  /\bperl\s+-[a-zA-Z]*i/,
  /(?:^|[\s;&|])(?:rm|mv|cp|ln|chmod|chown|chattr|truncate|dd|install|tee|touch|mkdir|tar|unzip|patch)\s/,
  /\b(kill|pkill|killall)\s/,
];

function orchestratorMutation(policy, command, agentId) {
  const ws = agentWorkspace(policy, agentId);
  for (const t of redirectTargets(command)) {
    const abs = resolveToolPath(policy, agentId, t);
    if (!(abs.startsWith("/tmp/") || abs.startsWith(ws + "/"))) return `writes to ${t}`;
  }
  const shellOnly = String(command).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const re of ORC_MUTATIONS) {
    const m = re.exec(shellOnly);
    if (m) return m[0].trim().slice(0, 60);
  }
  return null;
}

// ---- spawn policy ----

// Whether tasks may move to Codex while Claude is at its limit (spawn.codexModel set).
function codexEnabled(cfg) {
  return Boolean(mergePolicy(cfg).spawn.codexModel);
}

function isClaudeModel(model, policy) {
  const provider = String(model || "").split("/")[0];
  return (policy.spawn.limitedProviders || []).includes(provider);
}

function normaliseModel(model, allowed) {
  const m = String(model || "").trim();
  if (!m) return "";
  if (allowed.includes(m)) return m;
  const hit = allowed.find((a) => a.split("/").pop() === m || a.endsWith("/" + m));
  return hit || null;
}

function firstLine(text, field) {
  const re = new RegExp(`^[\\s>*#_\\-]*${field}\\s*:?\\s*(.+)$`, "im");
  const m = re.exec(String(text || ""));
  return m ? m[1].trim() : "";
}

// Board ids on the brief's Items: line(s); falls back to every id in the brief.
function itemsFromBrief(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => /^[\s>*#_-]*items\s*:/i.test(l));
  if (start < 0) return [...new Set(String(text || "").match(/\b[0-9a-f]{8}\b/g) || [])];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^[\s>*#_-]*[A-Za-z][A-Za-z ]{1,20}:/.test(lines[i]) && !/\b[0-9a-f]{8}\b\s*:/.test(lines[i])) break;
    out.push(...(lines[i].match(/\b[0-9a-f]{8}\b/g) || []));
  }
  return [...new Set(out)];
}

function projectName(policy, line) {
  const names = projectsMentioned(` project: ${line} `, policy.projects);
  return names[0] || "";
}

function spawnRewrite(params, policy, pstate, now) {
  const sp = policy.spawn;
  const next = Object.assign({}, params);
  const notes = [];
  if (sp.cleanup) next.cleanup = sp.cleanup;
  next.context = "isolated";
  if (next.mode && next.mode !== "run") next.mode = "run";
  if (next.thread) delete next.thread;
  const rt = Number(next.runTimeoutSeconds) || 0;
  if (rt < sp.minRunTimeoutSeconds) next.runTimeoutSeconds = Math.max(sp.defaultRunTimeoutSeconds, sp.minRunTimeoutSeconds);
  if (!next.label) {
    const project = firstLine(next.task, "Project").split(/[\s(]/)[0];
    const title = String(next.task || "").split("\n").map((l) => l.trim()).find((l) => l && !/^[A-Za-z ]+:/.test(l)) || "task";
    next.label = `${project || "task"}: ${title}`.slice(0, 80);
  }
  // Route around a subscription at its limit, never into it. (A Codex limit was once read as a
  // Claude limit, which sent every task to the exhausted Codex and failed them in seconds.)
  const claudeUntil = (pstate && pstate.claudeLimitedUntil) || 0;
  const codexUntil = (pstate && pstate.codexLimitedUntil) || 0;
  const claudeOff = claudeUntil > now;
  const codexOff = codexUntil > now;
  const wantsClaude = !next.model || isClaudeModel(next.model, policy);
  if (claudeOff && !codexOff && wantsClaude && sp.codexModel) {
    notes.push(`Claude is limited until ${new Date(claudeUntil).toISOString().slice(11, 16)} UTC: ${next.model || "default model"} -> ${sp.codexModel}`);
    next.model = sp.codexModel;
  } else if (codexOff && !claudeOff && !wantsClaude) {
    notes.push(`Codex is limited until ${new Date(codexUntil).toISOString().slice(11, 16)} UTC: ${next.model} -> ${sp.claudeFallbackModel}`);
    next.model = sp.claudeFallbackModel;
  }
  return { params: next, notes };
}


// Titles of items that are really a step of another item.
const GATE_TITLE = /^\s*(retry|re-?try|resume|re-?dispatch|re-?review|qa gate|review gate|live proof|live qa|live frames|qa pr|qa:|review:|verify pr|merge pr)\b/i;

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "fix", "add", "make", "is", "it", "not", "no", "from", "at", "by", "be"]);
function words(text) {
  return new Set(String(text || "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
}

// An open item in the same project whose title says the same thing (most of the words shared).
function similarOpenItem(board, project, title) {
  const a = words(title);
  if (a.size < 2) return null;
  const proj = String(project || "").toLowerCase();
  for (const it of board.values()) {
    if (!["backlog", "todo", "in_progress", "review", "qa", "blocked"].includes(String(it.status || "").toLowerCase().replace(/[\s-]+/g, "_"))) continue;
    if (proj && String(it.project || "").toLowerCase() !== proj) continue;
    const b = words(it.title);
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    if (Math.min(a.size, b.size) >= 3 && shared / Math.min(a.size, b.size) >= 0.75) return it;
  }
  return null;
}


// A brief that misses a required line gets it from its board items instead of a rejection (on
// 2026-11-05 the orchestrator lost 23 turns resending briefs for a missing Done when or Stop if).
function completeBrief(task, board) {
  const text = String(task || "");
  if (!board || typeof board.get !== "function") return text;
  const ids = itemsFromBrief(text).filter((id) => board.has(id));
  if (!ids.length) return text;
  const items = ids.map((id) => board.get(id));
  const has = (field) => text.split("\n").some((l) => l.replace(/^[\s>*#_\-]+/, "").toLowerCase().startsWith(`${field}:`));
  const add = [];
  const projects = [...new Set(items.map((it) => String(it.project || "").trim()).filter(Boolean))];
  if (!has("project") && projects.length === 1) add.push(`Project: ${projects[0]}`);
  if (!has("items")) add.push(`Items: ${ids.join(" ")}`);
  if (!has("scope")) add.push("Scope: in: exactly these items and the owner's words for them; out: anything else (put it under Next in your report)");
  const done = items.map((it) => String(it.done_when || "").trim()).filter(Boolean);
  if (!has("done when") && done.length) add.push(`Done when: ${done.join(" AND ")}`);
  if (!has("stop if")) add.push("Stop if: anything that needs the owner's OK (a production change, money, credentials, anything public, deleting data)");
  return add.length ? `${text.trimEnd()}\n${add.join("\n")}` : text;
}

// ---- decision ----

function policyDecide(event, ctx, pstate, rawConfig, log, now = Date.now()) {
  const policy = mergePolicy(rawConfig);
  if (!event) return undefined;
  const agentId = (ctx && ctx.agentId) || "";
  const sessionKey = (ctx && ctx.sessionKey) || "";
  const tool = bareTool(event.toolName);
  const params = event.params && typeof event.params === "object" ? event.params : {};
  const orchestrator = agentId === policy.orchestratorAgent;
  const subagent = sessionKey.includes(":subagent:");
  const enforce = (rawConfig && rawConfig.mode) !== "warn";
  const block = (rule, reason) => {
    if (typeof log === "function") log(enforce ? "warn" : "info", `token-guard ${enforce ? "blocked" : "would block"} ${tool} (${rule})`, { rule, agentId, sessionKey, toolName: tool });
    if (pstate && typeof pstate.onBlock === "function") pstate.onBlock(rule, { agentId, sessionKey, tool });
    return enforce ? { block: true, blockReason: reason, rule } : undefined;
  };

  // Per-task budget: a worker over budget may only finish with its final answer.
  const job = pstate && typeof pstate.jobFor === "function" ? pstate.jobFor(sessionKey) : null;
  if (job && job.overBudget) {
    return block("taskBudget",
      `token-guard: this task used its token budget (${Math.round((job.usedTokens || 0) / 1e6)}M). Stop now and write your final answer: ` +
      "RESULT (done / partly done / blocked), what is finished with evidence, what is left, and the exact next step.");
  }

  // 1. Rules, guard and config are read-only for every agent.
  if (policy.protect.enabled) {
    if (WRITE_TOOLS.has(tool)) {
      for (const p of toolWritePaths(tool, params)) {
        if (isProtectedPath(policy, resolveToolPath(policy, agentId, p))) return block("protectedFile", `token-guard: ${p} is protected. ${RULES_MESSAGE}`);
      }
    }
    if (tool === "exec") {
      const command = typeof params.command === "string" ? params.command : "";
      const git = gitViolation(command);
      if (git) return block("gitSafety", `token-guard: blocked: ${git}. Merges to main happen only through a reviewed merge request (the Team Lead merges when the pipeline is green).`);
      if (MUTATING_OPENCLAW.test(command)) return block("protectedConfig", `token-guard: changing OpenClaw config, plugins, crons, secrets, agents or models is not allowed for agents. ${RULES_MESSAGE}`);
      if (/(?:^|[\s;&|])chattr\s/.test(command)) return block("protectedFile", `token-guard: chattr is not allowed. ${RULES_MESSAGE}`);
      if (writesProtected(policy, command, agentId, params.workdir || params.cwd)) return block("protectedFile", `token-guard: this command would change a protected file. ${RULES_MESSAGE}`);
    }
  }

  // 2. No back channels: work and results flow only through the orchestrator's spawns, where they are mirrored to the group.
  if (policy.backChannels.enabled) {
    if ((policy.backChannels.blockedTools || []).includes(tool)) {
      const read = (tool === "cron" || tool === "gateway") && /^(list|status|get|show|runs)$/.test(String(params.action || ""));
      if (!read) {
        return block("backChannel",
          tool === "cron" ? "token-guard: agents cannot create or change automations (no watchdogs). The job tracker follows up on work automatically."
            : tool === "gateway" ? `token-guard: the gateway tool is not available to agents. ${RULES_MESSAGE}`
              : `token-guard: ${tool} is a hidden side channel. All team work goes through the orchestrator's dispatches, which are posted in the group automatically.`);
      }
    }
    if (tool === "sessions_spawn" && !orchestrator) {
      return block("spawnByWorker", "token-guard: only the orchestrator starts tasks. Put what you need from another role in your final answer; the orchestrator dispatches it.");
    }
    if (tool === "sessions_send") {
      const target = String(params.sessionKey || "");
      if (!orchestrator) {
        return block("sendByWorker", "token-guard: agents do not message each other directly. Put the information in your final answer; it reaches the orchestrator and is posted in the group.");
      }
      if (!target.includes(":subagent:")) {
        return block("sendToStandingChat",
          "token-guard: work goes to a fresh task session with sessions_spawn, never into an agent's standing chat. " +
          "sessions_send is only for a short follow-up to one of your running tasks (its childSessionKey).");
      }
    }
  }

  // 3. Model pins on standing sessions disable fallback, so they are refused. Thinking may change.
  if (policy.pins.enabled) {
    if ((tool === "sessions" && String(params.action || "") === "patch") || tool === "session_status") {
      if (params.model || params.modelOverride || params.provider || params.providerOverride) {
        return block("modelPin",
          "token-guard: pinning a session's model switches off its fallback, so a Claude limit then stops the work. " +
          "Change only thinking here; choose a task's model with sessions_spawn model.");
      }
    }
  }

  // 4. The orchestrator orchestrates: no file edits outside its own workspace, no commits, deploys or server changes.
  if (policy.orchestratorOnly.enabled && orchestrator) {
    if (WRITE_TOOLS.has(tool)) {
      const ws = agentWorkspace(policy, agentId);
      for (const p of toolWritePaths(tool, params)) {
        const abs = resolveToolPath(policy, agentId, p);
        if (!(abs.startsWith(ws + "/") || abs.startsWith("/tmp/"))) {
          return block("orchestratorOnly", `token-guard: you are the orchestrator; you do not edit ${p}. Dispatch it to the owning specialist with sessions_spawn.`);
        }
      }
    }
    if (tool === "exec") {
      const command = typeof params.command === "string" ? params.command : "";
      const what = orchestratorMutation(policy, command, agentId);
      if (what) {
        return block("orchestratorOnly",
          `token-guard: you are the orchestrator; you do not run "${what}" yourself. Read-only checks are fine. ` +
          "Dispatch the change to its owner with sessions_spawn (devops: servers, CI, DNS, deploys; writer: code; reviewer: merges).");
      }
    }
  }

  // 5. The board: everyone reads it; only the orchestrator and the PM change it; only the orchestrator approves.
  if (policy.board.enabled && tool === "task_inbox") {
    const action = String(params.action || "");
    if (!["list", "show", "board", "plan"].includes(action)) {
      if (action === "approve" && !orchestrator) {
        return block("boardApproval", "token-guard: only the orchestrator approves finished work (the owner approves in Telegram).");
      }
      if (!orchestrator && agentId !== policy.board.agent) {
        return block("boardWrite", "token-guard: only the orchestrator and the PM change the board. Put your status in your final answer: the board moves automatically when your task ends.");
      }
      // One request = one item for its whole life: retries and gates move the same item.
      if (action === "add") {
        const title = String(params.title || "");
        if (GATE_TITLE.test(title)) {
          return block("itemPerStep", "token-guard: do not add an item for a retry, a gate or a proof step. Keep the owner's original item and move it (task_inbox set: in_progress, review, qa) and dispatch the next agent on that same item id.");
        }
        const board = pstate && typeof pstate.boardItems === "function" ? pstate.boardItems() : null;
        const twin = board ? similarOpenItem(board, String(params.project || ""), title) : null;
        if (twin) {
          return block("duplicateItem", `token-guard: this is the same request as open item ${twin.id} ("${String(twin.title).slice(0, 80)}"). Keep one item per request: update ${twin.id} (task_inbox set, with a note) instead of adding a new one.`);
        }
      }
    }
  }

  // 6. Topics: a group post goes to the topic of the project it is about (or the team topic), never General.
  if (policy.topics.enabled && tool === "message" && policy.topics.chatId) {
    const chat = String(params.target || params.to || params.chatId || "");
    if (chat.includes(String(policy.topics.chatId))) {
      const thread = params.threadId !== undefined ? params.threadId : params.messageThreadId;
      const text = String(params.message || params.content || params.text || "");
      const right = correctTopic({ threadId: thread, text, projects: policy.projects, teamTopic: policy.topics.teamTopic });
      if (right.topic && String(right.topic) !== String(thread === undefined || thread === null ? "" : thread)) {
        const next = Object.assign({}, params, { threadId: String(right.topic) });
        delete next.messageThreadId;
        delete next.replyTo; // a reply cannot cross topics
        if (typeof log === "function") log("info", "token-guard moved a post to its project topic", { agentId, from: thread, to: right.topic });
        if (pstate && typeof pstate.onNote === "function") pstate.onNote(`${agentId}'s post moved from topic ${thread || "General"} to ${right.project || "team"} (${right.topic})`);
        return { params: next };
      }
    }
  }

  // 7. A task stays on its task: code roles write only inside their task's project.
  if (policy.taskPaths.enabled && subagent && job && WRITE_TOOLS.has(tool) && (policy.taskPaths.roles || []).includes(agentId)) {
    const name = projectName(policy, job.project || "");
    const root = name && policy.projects[name] && policy.projects[name].path ? expandHome(policy.projects[name].path) : "";
    if (root && !root.includes("<")) {
      const ws = agentWorkspace(policy, agentId);
      for (const p of toolWritePaths(tool, params)) {
        const abs = resolveToolPath(policy, agentId, p);
        if (!(abs === root || abs.startsWith(root + "/") || abs.startsWith("/tmp/") || abs.startsWith(ws + "/"))) {
          return block("outOfTask", `token-guard: ${p} is outside this task's project (${name}: ${root}). Stay on your task; anything else goes under "Next" in your report.`);
        }
      }
    }
  }

  // 8. Spawn policy: fresh isolated task sessions that are deleted when done, enough time to finish, allowed models only.
  if (policy.spawn.enabled && tool === "sessions_spawn" && orchestrator && !subagent) {
    const allowed = policy.spawn.allowedModels || [];
    if (params.model) {
      const m = normaliseModel(params.model, allowed);
      if (m === null) return block("spawnModel", `token-guard: model "${params.model}" is not allowed. Use one of: ${allowed.join(", ")}.`);
    }
    if (params.thinking && !(policy.spawn.allowedThinking || []).includes(String(params.thinking).toLowerCase())) {
      return block("spawnThinking", `token-guard: thinking "${params.thinking}" is not allowed. Use one of: ${(policy.spawn.allowedThinking || []).join(", ")}.`);
    }
    if (policy.board.enabled && policy.board.requireItems && pstate && typeof pstate.boardItems === "function") {
      const board = pstate.boardItems();
      const ids = itemsFromBrief(params.task).filter((id) => board.has(id));
      if (ids.length === 0) {
        return block("boardItems", "token-guard: every task starts from the board. Record it with task_inbox add (or find its id with task_inbox list) and put its id on the brief's Items: line.");
      }
      const running = typeof pstate.runningItemIds === "function" ? pstate.runningItemIds() : new Set();
      for (const id of ids) {
        const st = normStatus(board.get(id).status);
        if (!DISPATCHABLE.has(st)) return block("boardItems", `token-guard: ${id} is ${st} on the board. Reopen it with task_inbox set before dispatching.`);
        if (running.has(id)) return block("boardBusy", `token-guard: ${id} is already being worked on in another task. Wait for that result; one task at a time per item.`);
      }
      const projects = new Set(ids.map((id) => String(board.get(id).project || "").toLowerCase()));
      if (projects.size > 1) return block("mixedProjects", `token-guard: these items belong to different projects (${[...projects].join(", ")}). One task, one project: dispatch them separately.`);
      const briefProject = projectName(policy, firstLine(params.task, "Project")) || String(firstLine(params.task, "Project")).toLowerCase().split(/[\s(]/)[0];
      const itemProject = [...projects][0];
      if (briefProject && itemProject && !itemProject.includes(briefProject) && !briefProject.includes(itemProject) && projectName(policy, itemProject) !== briefProject) {
        return block("projectMismatch", `token-guard: the brief says Project ${briefProject} but its items are ${itemProject}. Fix the brief or the items.`);
      }
    }
    // A deploy is restarting the gateway: a task started now would be cut off by the restart.
    if (pstate && typeof pstate.maintenanceSince === "function") {
      const since = pstate.maintenanceSince();
      if (since && now - since < 30 * 60000) {
        return block("maintenance", "token-guard: the gateway is being restarted for maintenance, so a task started now would be cut off. Do not dispatch now and leave the items as they are: the job tracker wakes you again once the gateway is back.");
      }
    }
    const claudeUntil = (pstate && pstate.claudeLimitedUntil) || 0;
    const codexUntil = (pstate && pstate.codexLimitedUntil) || 0;
    const at = (ms) => new Date(ms).toISOString().slice(11, 16);
    if (claudeUntil > now && !policy.spawn.codexModel) {
      return block("claudeLimited", `token-guard: Claude is at its usage limit until ${at(claudeUntil)} UTC and there is no fallback (Codex is off), so this task would fail at once. Do not dispatch now and leave its items in To do: the job tracker wakes you again once the limit has reset.`);
    }
    if (claudeUntil > now && codexUntil > now) {
      return block("bothLimited", `token-guard: Claude (until ${at(claudeUntil)} UTC) and Codex (until ${at(codexUntil)} UTC) are both at their usage limits, so this task would fail at once. Do not dispatch now and leave its items in To do: the job tracker wakes you again once a limit has reset.`);
    }
    const input = Object.assign({}, params);
    if (input.model) input.model = normaliseModel(input.model, allowed);
    if (input.thinking) input.thinking = String(input.thinking).toLowerCase();
    const { params: next, notes } = spawnRewrite(input, policy, pstate, now);
    if (notes.length && typeof log === "function") log("info", "token-guard spawn rewrite", { notes });
    if (notes.length && pstate && typeof pstate.onNote === "function") pstate.onNote(notes.join("; "));
    return { params: next };
  }

  return undefined;
}

export {
  completeBrief,
  similarOpenItem,
  DEFAULT_POLICY,
  mergePolicy,
  codexEnabled,
  expandHome,
  isProtectedPath,
  mentionsProtected,
  writesProtected,
  orchestratorMutation,
  gitViolation,
  toolWritePaths,
  spawnRewrite,
  firstLine,
  itemsFromBrief,
  policyDecide,
};
