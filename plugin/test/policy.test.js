import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { policyDecide, isProtectedPath, mergePolicy, writesProtected, orchestratorMutation, DEFAULT_POLICY } from "../policy.js";

const H = os.homedir();
const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100:topic:151" };
const DEVOPS = { agentId: "devops", sessionKey: "agent:devops:subagent:abc" };
const WRITER_TOPIC = { agentId: "writer", sessionKey: "agent:writer:telegram:group:-100:topic:151" };
const exec = (command, extra = {}) => ({ toolName: "exec", params: { command, ...extra } });
const blocked = (r) => Boolean(r && r.block);
const rule = (r) => (r && r.rule) || null;
const P = mergePolicy({});

test("protected paths: rules, personas, config, guard, secrets and team repo", () => {
  for (const p of [
    `${H}/.openclaw/openclaw.json`, `${H}/.openclaw/openclaw.json.bak`, `${H}/.openclaw/workspace/devops/AGENTS.md`,
    `${H}/.openclaw/workspace/qa/SOUL.md`, `${H}/.openclaw/workspace/writer/skills/x/SKILL.md`, `${H}/.openclaw/token-guard/plugin/guard.js`,
    `${H}/.openclaw/secrets/telegram-qa.token`, `${H}/openclaw-team/team.toml`, `${H}/.config/systemd/user/openclaw-gateway.service`,
  ]) assert.equal(isProtectedPath(P, p), true, p);
  for (const p of [`${H}/projects/o/AGENTS.md`, `${H}/.openclaw/workspace/devops/memory/2026-11-04.md`, "/tmp/x.json", `${H}/projects/o/src/a.ts`]) {
    assert.equal(isProtectedPath(P, p), false, p);
  }
});

test("Edit/Write on protected files is blocked for every agent; project files are fine", () => {
  const edit = (file_path) => ({ toolName: "Edit", params: { file_path, old_string: "a", new_string: "b" } });
  assert.equal(rule(policyDecide(edit(`${H}/.openclaw/workspace/devops/AGENTS.md`), DEVOPS, {}, {})), "protectedFile");
  assert.equal(rule(policyDecide(edit("AGENTS.md"), DEVOPS, {}, {})), "protectedFile"); // relative = own workspace
  assert.equal(rule(policyDecide({ toolName: "mcp__openclaw__write", params: { path: "~/.openclaw/openclaw.json", content: "{}" } }, DEVOPS, {}, {})), "protectedFile");
  assert.equal(policyDecide(edit(`${H}/projects/o/src/a.ts`), DEVOPS, {}, {}), undefined);
  assert.equal(policyDecide(edit(`${H}/projects/o/AGENTS.md`), DEVOPS, {}, {}), undefined);
  const patch = { toolName: "apply_patch", params: { patch: "*** Begin Patch\n*** Update File: /home/x/.openclaw/token-guard/plugin/guard.js\n" } };
  assert.equal(blocked(policyDecide(patch, DEVOPS, {}, {})), H === "/home/x");
});

test("shell writes to protected files are blocked; reads are allowed", () => {
  for (const cmd of [
    `sed -i 's/a/b/' ${H}/.openclaw/workspace/coordinator/AGENTS.md`,
    "echo x >> ~/.openclaw/workspace/devops/AGENTS.md",
    'cp /tmp/g.js "$HOME/.openclaw/token-guard/plugin/guard.js"',
    "cd ~/.openclaw/token-guard/plugin && sed -i s/4/400/ guard.js",
    `python3 -c "import json; d=json.load(open('${H}/.openclaw/openclaw.json')); json.dump(d, open('${H}/.openclaw/openclaw.json','w'))"`,
    "sed -i 's/x/y/' AGENTS.md",
    "rm ~/.openclaw/secrets/gitlab-main.token",
  ]) assert.equal(rule(policyDecide(exec(cmd), DEVOPS, {}, {})), "protectedFile", cmd);
  for (const cmd of [
    "cat ~/.openclaw/workspace/devops/AGENTS.md",
    "grep -n token ~/.openclaw/openclaw.json",
    `python3 -c "import json; c=json.load(open('${H}/.openclaw/openclaw.json')); print(len(c['agents'])>0)"`,
    'GITLAB_TOKEN="$(cat ~/.openclaw/secrets/gitlab-main.token)" curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://gitlab.com/api/v4/user',
    "cd /srv/projects/demo && sed -i 's/a/b/' AGENTS.md",
    "sed -i 's/a/b/' src/app.ts",
  ]) assert.equal(policyDecide(exec(cmd), DEVOPS, {}, {}), undefined, cmd);
  assert.equal(policyDecide(exec("sed -i 's/a/b/' AGENTS.md", { workdir: "/srv/projects/demo" }), DEVOPS, {}, {}), undefined);
});

test("OpenClaw config, plugin, cron, secret and model changes are blocked; reads are fine", () => {
  for (const cmd of [
    "openclaw config set agents.entries.coordinator.model.primary anthropic/claude-sonnet-5",
    "openclaw config patch --file /tmp/p.json", "openclaw plugins reload token-guard", "openclaw cron add --every 10m",
    "openclaw secrets store set X", "openclaw doctor --fix", "openclaw models set x", "sudo chattr -i ~/.openclaw/openclaw.json",
  ]) assert.equal(blocked(policyDecide(exec(cmd), DEVOPS, {}, {})), true, cmd);
  for (const cmd of ["openclaw config get agents", "openclaw sessions --json", "openclaw cron list", "openclaw secrets store list"]) {
    assert.equal(policyDecide(exec(cmd), DEVOPS, {}, {}), undefined, cmd);
  }
});

test("back channels: hidden agent tools, worker spawns and agent-to-agent sends are blocked", () => {
  for (const toolName of ["SendMessage", "TeamCreate", "Agent", "Task", "conversations_send", "mcp__openclaw__cron", "gateway"]) {
    assert.equal(rule(policyDecide({ toolName, params: { action: "add" } }, DEVOPS, {}, {})), "backChannel", toolName);
  }
  assert.equal(policyDecide({ toolName: "cron", params: { action: "list" } }, DEVOPS, {}, {}), undefined);
  assert.equal(rule(policyDecide({ toolName: "sessions_spawn", params: { agentId: "qa", task: "x" } }, WRITER_TOPIC, {}, {})), "spawnByWorker");
  assert.equal(rule(policyDecide({ toolName: "sessions_send", params: { sessionKey: "agent:coordinator:main", message: "done" } }, DEVOPS, {}, {})), "sendByWorker");
  assert.equal(rule(policyDecide({ toolName: "sessions_send", params: { sessionKey: "agent:devops:telegram:group:-100", message: "do X" } }, COORD, {}, {})), "sendToStandingChat");
  assert.equal(policyDecide({ toolName: "sessions_send", params: { sessionKey: "agent:devops:subagent:abc", message: "use port 8080" } }, COORD, {}, {}), undefined);
});

test("model pins on sessions are refused; thinking changes are allowed", () => {
  assert.equal(rule(policyDecide({ toolName: "sessions", params: { action: "patch", model: "anthropic/claude-haiku-5-5" } }, COORD, {}, {})), "modelPin");
  assert.equal(rule(policyDecide({ toolName: "session_status", params: { model: "x" } }, COORD, {}, {})), "modelPin");
  assert.equal(policyDecide({ toolName: "sessions", params: { action: "patch", thinking: "high" } }, COORD, {}, {}), undefined);
});

test("the orchestrator cannot do specialist work; read-only checks are fine", () => {
  for (const cmd of [
    "git -C /srv/projects/demo push origin agent/x", "docker compose up -d", "sudo systemctl restart nginx",
    "curl -X POST https://api.cloudflare.com/client/v4/zones/x/dns_records -d '{}'", "ssh deploy@host ls",
    "echo hi > /srv/projects/demo/README.md", "./scripts/deploy.sh --prod", "npm run build", "rm -rf /srv/projects/demo/dist",
  ]) assert.equal(rule(policyDecide(exec(cmd), COORD, {}, {})), "orchestratorOnly", cmd);
  for (const cmd of [
    "git -C /srv/projects/demo log --oneline -5", "curl -s https://app.example.com/ -o /dev/null -w '%{http_code}'",
    "cat /srv/projects/demo/package.json", "glab ci view", "gh run view 123", "echo note > /tmp/x.txt",
  ]) assert.equal(policyDecide(exec(cmd), COORD, {}, {}), undefined, cmd);
  assert.equal(rule(policyDecide({ toolName: "Edit", params: { file_path: `${H}/projects/o/a.ts` } }, COORD, {}, {})), "orchestratorOnly");
  assert.equal(policyDecide({ toolName: "Write", params: { file_path: `${H}/.openclaw/workspace/coordinator/memory/n.md` } }, COORD, {}, {}), undefined);
  // the same commands are fine for the owning specialist
  assert.equal(policyDecide(exec("docker compose up -d"), DEVOPS, {}, {}), undefined);
});

test("spawn policy: delete when done, isolated, enough time, allowed models and thinking", () => {
  const spawn = (extra) => ({ toolName: "sessions_spawn", params: { agentId: "devops", task: "Project: demo (/srv/o)\nFix CI", ...extra } });
  const r = policyDecide(spawn({ model: "claude-sonnet-5", thinking: "LOW", runTimeoutSeconds: 600 }), COORD, {}, {});
  assert.equal(r.params.cleanup, "delete");
  assert.equal(r.params.context, "isolated");
  assert.equal(r.params.runTimeoutSeconds, 3600);
  assert.equal(r.params.model, "anthropic/claude-sonnet-5");
  assert.equal(r.params.thinking, "low");
  assert.match(r.params.label, /^demo: /);
  assert.equal(policyDecide(spawn({ runTimeoutSeconds: 5400, label: "x" }), COORD, {}, {}).params.runTimeoutSeconds, 5400);
  assert.equal(rule(policyDecide(spawn({ model: "anthropic/claude-fable-5-1" }), COORD, {}, {})), "spawnModel");
  assert.equal(rule(policyDecide(spawn({ thinking: "xhigh" }), COORD, {}, {})), "spawnThinking");
});

const CODEX_ON = { spawn: { codexModel: "openai/gpt-6-astra", allowedModels: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "openai/gpt-6-astra"] } };

test("with Codex turned on (spawn.codexModel), new tasks go to Codex while Claude is limited", () => {
  const now = Date.now();
  const spawn = (extra) => ({ toolName: "sessions_spawn", params: { agentId: "writer", task: "Project: ai\nX", ...extra } });
  const limited = { claudeLimitedUntil: now + 3600000 };
  assert.equal(policyDecide(spawn({ model: "anthropic/claude-opus-5-5" }), COORD, limited, CODEX_ON, null, now).params.model, "openai/gpt-6-astra");
  assert.equal(policyDecide(spawn({}), COORD, limited, CODEX_ON, null, now).params.model, "openai/gpt-6-astra");
  assert.equal(policyDecide(spawn({ model: "anthropic/claude-opus-5-5" }), COORD, { claudeLimitedUntil: now - 1 }, CODEX_ON, null, now).params.model, "anthropic/claude-opus-5-5");
});

test("Codex is off by default: while Claude is limited a task waits (blocked), it never moves to Codex", () => {
  const now = Date.now();
  const spawn = (extra) => ({ toolName: "sessions_spawn", params: { agentId: "writer", task: "Project: ai\nX", ...extra } });
  const limited = { claudeLimitedUntil: now + 3600000 };
  const r = policyDecide(spawn({ model: "anthropic/claude-opus-5-5" }), COORD, limited, {}, null, now);
  assert.equal(r.block, true);
  assert.match(r.blockReason, /no fallback \(Codex is off\)/);
  assert.equal(policyDecide(spawn({}), COORD, limited, {}, null, now).block, true);
  // a Codex model is not even allowed by default
  assert.equal(rule(policyDecide(spawn({ model: "openai/gpt-6-astra" }), COORD, {}, {})), "spawnModel");
  // once the limit has reset, the task runs on the model it asked for
  assert.equal(policyDecide(spawn({ model: "anthropic/claude-opus-5-5" }), COORD, { claudeLimitedUntil: now - 1 }, {}, null, now).params.model, "anthropic/claude-opus-5-5");
});

test("a task over its token budget may only finish", () => {
  const ps = { jobFor: (k) => (k === DEVOPS.sessionKey ? { overBudget: true, usedTokens: 16e6 } : null) };
  assert.equal(rule(policyDecide(exec("ls"), DEVOPS, ps, {})), "taskBudget");
  assert.equal(policyDecide(exec("ls"), WRITER_TOPIC, ps, {}), undefined);
});

test("a task over its tool-call budget is told how many calls it made", () => {
  const ps = { jobFor: (k) => (k === DEVOPS.sessionKey ? { overBudget: true, toolCalls: 101 } : null) };
  const r = policyDecide(exec("ls"), DEVOPS, ps, {});
  assert.equal(rule(r), "taskBudget");
  assert.match(r.blockReason, /101 tool calls/);
});

test("one orchestrator run may make only so many tool calls; telling the owner stays allowed", () => {
  const RUN = Object.assign({ runId: "run-1" }, COORD);
  const calls = new Map([["run-1", 61], ["run-2", 60]]);
  const ps = { runCalls: (id) => calls.get(id) || 0 };
  const r = policyDecide(exec("curl -s https://example.com"), RUN, ps, {});
  assert.equal(rule(r), "runBudget");
  assert.match(r.blockReason, /made 60 tool calls/);
  assert.equal(rule(policyDecide({ toolName: "message", params: { action: "send", message: "status" } }, RUN, ps, {})), null);
  assert.equal(rule(policyDecide(exec("ls"), Object.assign({}, RUN, { runId: "run-2" }), ps, {})), null); // the 60th call is fine
  // workers are budgeted per task instead, and 0 turns the run limit off
  assert.equal(rule(policyDecide(exec("ls"), Object.assign({ runId: "run-1" }, DEVOPS), ps, {})), null);
  assert.equal(rule(policyDecide(exec("ls"), RUN, ps, { orchestratorMaxCallsPerRun: 0 })), null);
});

test("warn mode logs and never blocks", () => {
  assert.equal(policyDecide(exec("openclaw config set x y"), DEVOPS, {}, { mode: "warn" }), undefined);
});

test("helpers", () => {
  assert.equal(writesProtected(P, "ls -la", "devops"), false);
  assert.equal(orchestratorMutation(P, "curl -s https://x/y", "coordinator"), null);
});

test("git safety: no hook bypass, no direct pushes to protected branches (every agent)", () => {
  for (const cmd of ["git push --no-verify origin agent/1", "git push origin main", "git push origin HEAD:main", "git push origin +master",
    "git -C /srv/x push origin main", "git config core.hooksPath /dev/null", "git -c core.hooksPath=/tmp push origin agent/2", "git push --mirror origin"]) {
    assert.equal(rule(policyDecide(exec(cmd), DEVOPS, {}, {})), "gitSafety", cmd);
  }
  for (const cmd of ["git push origin agent/123-main-fix", "git push -u origin agent/abc", "git config --get core.hooksPath", "git log main..HEAD"]) {
    assert.equal(policyDecide(exec(cmd), DEVOPS, {}, {}), undefined, cmd);
  }
});

test("every setting the policy reads is allowed by the plugin's config schema (OpenClaw refuses unknown keys)", async () => {
  const fs = await import("node:fs");
  const schema = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")).configSchema;
  assert.deepEqual(Object.keys(DEFAULT_POLICY).filter((k) => !(k in schema.properties)), []);
  for (const k of ["jobs", "triage", "skills", "mirror", "topics", "board", "projects"]) assert.ok(k in schema.properties, k);
});

test("the brief's Model: and Effort: lines decide the task's model and thinking", () => {
  const brief = (extra) => `Project: demo (/srv/demo)\nScope: x\nItems:\na1b2c3d4\nDone when: tests pass\nStop if: y\n${extra}`;
  const spawn = (task, params = {}) => ({ toolName: "sessions_spawn", params: Object.assign({ agentId: "writer", task }, params) });
  const cfg = { board: { requireItems: false } };
  let r = policyDecide(spawn(brief("Model: anthropic/claude-sonnet-5-5\nEffort: medium")), COORD, {}, cfg);
  assert.deepEqual([r.params.model, r.params.thinking], ["anthropic/claude-sonnet-5-5", "medium"]);
  r = policyDecide(spawn(brief("Model: haiku-5-5\nEffort: low"), { model: "anthropic/claude-opus-5-5", thinking: "high" }), COORD, {}, cfg);
  assert.deepEqual([r.params.model, r.params.thinking], ["anthropic/claude-haiku-5-5", "low"]); // the brief wins
  assert.equal(rule(policyDecide(spawn(brief("Model: openai/gpt-6\nEffort: low")), COORD, {}, cfg)), "spawnModel");
  assert.equal(rule(policyDecide(spawn(brief("Model: sonnet-5\nEffort: xhigh")), COORD, {}, cfg)), "spawnThinking");
  assert.equal(policyDecide(spawn(brief("Model: sonnet-5\nEffort: low")), COORD, {}, cfg).params.model, "anthropic/claude-sonnet-5");
  assert.equal(policyDecide(spawn(brief("Model: claude-opus-5-5\nEffort: high")), COORD, {}, cfg).params.model, "anthropic/claude-opus-5-5");
  assert.equal(rule(policyDecide(spawn(brief("Model: 5\nEffort: low")), COORD, {}, cfg)), "spawnModel"); // not a model name
  // "Model routing ..." in the text is not a Model: line
  r = policyDecide(spawn(brief("Model routing policy for wake-ups"), { model: "anthropic/claude-sonnet-5" }), COORD, {}, cfg);
  assert.equal(r.params.model, "anthropic/claude-sonnet-5");
});

test("a task pushes only after running its project's checks locally (owner's order)", () => {
  const job = { checksRun: 0 };
  const ps = { jobFor: (k) => (k === DEVOPS.sessionKey ? job : null) };
  const r = policyDecide(exec("git -C /srv/demo push -u origin agent/x"), DEVOPS, ps, {});
  assert.equal(rule(r), "pushWithoutChecks");
  assert.match(r.blockReason, /Local checks/);
  job.checksRun = 2;
  assert.equal(rule(policyDecide(exec("git -C /srv/demo push -u origin agent/x"), DEVOPS, ps, {})), null);
  assert.equal(rule(policyDecide(exec("git status"), DEVOPS, { jobFor: () => ({ checksRun: 0 }) }, {})), null);
  assert.equal(rule(policyDecide(exec("git push origin agent/x"), DEVOPS, { jobFor: () => ({ checksRun: 0 }) }, { requireChecksBeforePush: false })), null);
});

test("secrets: a path in a shell variable or after cd is still protected; oc-secret-save is the one way in", () => {
  // Live 2026-11-08: the orchestrator wrote a password into the secrets folder through a variable.
  const viaVar = "umask 077; f=~/.openclaw/secrets/mailbox.pass; [ -e \"$f\" ] && echo exists || { cat > \"$f\" <<'EOF'\nvalue\nEOF\n} ; ls -la \"$f\"";
  for (const who of [DEVOPS, COORD]) assert.equal(rule(policyDecide(exec(viaVar), who, {}, {})), "protectedFile");
  for (const cmd of [
    'F="$HOME/.openclaw/secrets/new.token"; printf %s abc > "$F"',
    "export D=~/.openclaw/secrets; echo x > ${D}/new.token",
    "for f in ~/.openclaw/secrets/*.token; do : > \"$f\"; done",
    "cd ~/.openclaw/secrets && cat > new.token <<'EOF'\nv\nEOF",
    "t=~/.openclaw/secrets/a.token; cp /tmp/x \"$t\"",
  ]) assert.equal(rule(policyDecide(exec(cmd), DEVOPS, {}, {})), "protectedFile", cmd);
  // Reading a secret into a variable and writing output elsewhere stays allowed.
  for (const cmd of [
    'T="$(cat ~/.openclaw/secrets/gitlab-main.token)"; out=/tmp/mr.json; curl -s -H "PRIVATE-TOKEN: $T" https://gitlab.com/api/v4/user > "$out"',
    "f=~/.openclaw/secrets/gitlab-main.token; curl -s -K - <<<\"header = \\\"PRIVATE-TOKEN: $(cat $f)\\\"\" https://gitlab.com/api/v4/user > /tmp/u.json",
    "cd ~/.openclaw/secrets && ls -la",
  ]) assert.equal(policyDecide(exec(cmd), DEVOPS, {}, {}), undefined, cmd);
  // The sanctioned helper works for workers and for the orchestrator, whatever the value contains.
  const save = "~/.openclaw/bin/oc-secret-save telegram-x_bot.token <<'EOF'\n123:ab>cd; rm -rf ~/.openclaw/secrets | git push origin main\nEOF";
  for (const who of [DEVOPS, COORD, WRITER_TOPIC]) assert.equal(policyDecide(exec(save), who, {}, {}), undefined, who.agentId);
  // Only the heredoc body is skipped: a command after it is still checked.
  assert.equal(rule(policyDecide(exec(`${save}\nrm ~/.openclaw/secrets/gitlab-main.token`), DEVOPS, {}, {})), "protectedFile");
});

test("secrets: every refusal about a credential file says how to store it", () => {
  const write = (file_path) => ({ toolName: "Write", params: { file_path, content: "v" } });
  // Live 2026-11-08: both refusals left the orchestrator with no way to keep the owner's bot token.
  const a = policyDecide(write(`${H}/.openclaw/secrets/sales-bot.token`), COORD, {}, {});
  assert.match(a.blockReason, /oc-secret-save <name> <<'EOF'/);
  const b = policyDecide(write(`${H}/.sales-bot.token`), COORD, {}, {});
  assert.equal(b.rule, "orchestratorOnly");
  assert.match(b.blockReason, /oc-secret-save/);
  assert.match(policyDecide(exec("echo v > ~/.openclaw/secrets/x.token"), DEVOPS, {}, {}).blockReason, /oc-secret-save/);
  // Unrelated refusals stay short.
  assert.doesNotMatch(policyDecide(write(`${H}/.openclaw/openclaw.json`), DEVOPS, {}, {}).blockReason, /oc-secret-save/);
});
