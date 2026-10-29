import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  createState,
  decide,
  endRun,
  hasSleepLoop,
  invokesWaiter,
  parseDurationSeconds,
  totalSleepSeconds,
} from "../guard.js";
import { inboxArgs } from "../inbox.js";

const MAIN = { agentId: "devops", sessionKey: "agent:devops:telegram:group:-100", runId: "r1" };
const SUB = { agentId: "devops", sessionKey: "agent:devops:subagent:abc", runId: "r2" };
const COORD = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-100", runId: "r3" };
const CRON = { agentId: "coordinator", sessionKey: "agent:coordinator:cron:job1:run:x", runId: "r4" };

const exec = (command, extra = {}) => ({ toolName: "exec", params: { command, ...extra } });
const poll = (sessionId, action = "poll") => ({ toolName: "process", params: { action, sessionId } });
const blocked = (r) => Boolean(r && r.block === true);

function run(state, ctx, events, cfg = {}) {
  return events.map((e) => decide(e, ctx, state, cfg));
}

test("duration and sleep parsing", () => {
  assert.equal(parseDurationSeconds("240"), 240);
  assert.equal(parseDurationSeconds("5s"), 5);
  assert.equal(parseDurationSeconds("1m"), 60);
  assert.equal(parseDurationSeconds("0.5"), 0.5);
  assert.equal(parseDurationSeconds("2h"), 7200);
  assert.equal(totalSleepSeconds("sleep 10 && sleep 15"), 25);
  assert.equal(totalSleepSeconds("sleep 1m; sleep 30s"), 90);
  assert.equal(totalSleepSeconds("python3 -c 'import time; time.sleep(45)'"), 45);
  assert.equal(totalSleepSeconds('grep -n "sleep" src/app.py'), 0);
  assert.equal(totalSleepSeconds("echo hi"), 0);
});

test("waiter detection only matches real invocations", () => {
  assert.equal(invokesWaiter("~/.openclaw/bin/oc-wait --every 30 -- curl -fs x"), true);
  assert.equal(invokesWaiter("cd /srv && oc-wait-pipeline --project 1 --pipeline 2"), true);
  assert.equal(invokesWaiter("python3 ~/.openclaw/bin/oc-wait-pipeline --project a/b --ref main"), true);
  assert.equal(invokesWaiter("nohup timeout 7200 oc-wait --pid 42"), true);
  assert.equal(invokesWaiter("FOO=1 oc-wait --file /tmp/x --match done"), true);
  assert.equal(invokesWaiter("cat ~/.openclaw/bin/oc-wait"), false);
  assert.equal(invokesWaiter("grep -n oc-wait README.md"), false);
});

test("sleep loop detection", () => {
  assert.equal(hasSleepLoop("while true; do curl -fs x && break; sleep 5; done"), true);
  assert.equal(hasSleepLoop("until test -f /tmp/done; do sleep 2; done"), true);
  assert.equal(hasSleepLoop("for i in 1 2 3; do curl -fs x && break; sleep 2; done"), false);
  assert.equal(hasSleepLoop("for i in $(seq 1 60); do check; sleep 10; done"), true);
  assert.equal(hasSleepLoop("python3 - <<'EOF'\nimport time\nwhile True:\n    time.sleep(1)\nEOF"), true);
  assert.equal(hasSleepLoop("watch -n 5 kubectl get pods"), true);
  assert.equal(hasSleepLoop("kubectl rollout status deploy/web --watch"), false);
  assert.equal(hasSleepLoop("grep watch notes.txt"), false);
  assert.equal(hasSleepLoop('grep -n "while.*sleep" src/'), false);
  assert.equal(hasSleepLoop("sleep 5"), false);
});

test("scripts written to files are data, not waits", () => {
  const write = "cat > /tmp/w.sh <<'EOF'\n#!/bin/bash\nwhile true; do date; sleep 1; done\nsleep 300\nEOF\nchmod +x /tmp/w.sh";
  assert.equal(hasSleepLoop(write), false);
  assert.equal(totalSleepSeconds(write), 0);
  const tee = "tee deploy.sh >/dev/null <<EOF\nfor i in 1 2 3; do curl x; sleep 30; done\nEOF";
  assert.equal(hasSleepLoop(tee), false);
  const pyEdit = "python3 - <<'EOF'\nsrc = open('a.py').read()\nsrc = src.replace('while ok: time.sleep(5)', 'wait()')\nopen('a.py','w').write(src)\nEOF";
  assert.equal(hasSleepLoop(pyEdit), false);
  assert.equal(totalSleepSeconds(pyEdit), 0);
  assert.equal(totalSleepSeconds('git commit -m "remove sleep 30 from deploy"'), 0);
  assert.equal(totalSleepSeconds('echo "sleep 30" >> notes.txt'), 0);
  // ...but scripts that run are still checked
  assert.equal(hasSleepLoop("bash <<'EOF'\nwhile true; do date; sleep 2; done\nEOF"), true);
  assert.equal(hasSleepLoop("python3 - <<'EOF'\nimport time\nwhile True:\n    time.sleep(1)\nEOF"), true);
  assert.equal(hasSleepLoop("python3 -c 'import time\nwhile True: time.sleep(3)'"), true);
  assert.equal(totalSleepSeconds("(sleep 30; echo x)"), 30);
  assert.equal(totalSleepSeconds("cd /srv && sleep 25 && curl -s x"), 25);
  // code quoted for an interpreter runs, so it is checked
  assert.equal(hasSleepLoop('bash -c "while true; do date; sleep 1; done"'), true);
  assert.equal(totalSleepSeconds("ssh -o ConnectTimeout=20 host 'sleep 30; tail -n 5 /var/log/app.log'"), 30);
  // a python script that edits source code mentioning loops is not a loop
  const jsEdit = "python3 - <<'EOF'\np='guard.js'\nt=open(p).read()\nt=t.replace('while ((m = re.exec(s)) !== null) total += 1;', '')\nt=t.replace('time.sleep(5)', 'wait()')\nopen(p,'w').write(t)\nEOF";
  assert.equal(hasSleepLoop(jsEdit), false);
  assert.equal(totalSleepSeconds(jsEdit), 0);
  assert.equal(hasSleepLoop("while read line; do echo \"$line\"; done < /tmp/done.txt"), false);
});

test("process polls: 2 per job and 4 per run for normal sessions", () => {
  const s = createState();
  const r = run(s, MAIN, [poll("A"), poll("A"), poll("A"), poll("B"), poll("B")]);
  assert.deepEqual(r.map(blocked), [false, false, true, false, true]);
  assert.match(r[2].blockReason, /^token-guard: blocked check #3 of job A/);
  assert.match(r[2].blockReason, /end your turn/);
  // other actions are never blocked
  assert.equal(decide({ toolName: "process", params: { action: "kill", sessionId: "A" } }, MAIN, s, {}), undefined);
  assert.equal(decide({ toolName: "process", params: { action: "write", sessionId: "A" } }, MAIN, s, {}), undefined);
});

test("process polls: subagents get a larger run budget and no per-job cap", () => {
  const s = createState();
  const r = run(s, SUB, Array.from({ length: 41 }, () => poll("A")));
  assert.equal(r.slice(0, 40).some(blocked), false);
  assert.equal(blocked(r[40]), true);
  assert.match(r[40].blockReason, /parent/);
});

test("exec: foreground sleeps and loops are blocked; background and awaitResults are not", () => {
  const s = createState();
  assert.equal(blocked(decide(exec("sleep 240; curl -s x"), MAIN, s, {})), true);
  assert.equal(blocked(decide(exec("sleep 19 && curl -s x"), MAIN, s, {})), false);
  assert.equal(blocked(decide(exec("while true; do curl -s x; sleep 3; done"), MAIN, s, {})), true);
  assert.equal(blocked(decide(exec("sleep 30; curl -s x", { background: true }), MAIN, s, {})), false);
  assert.equal(blocked(decide(exec("sleep 30; curl -s y", { awaitResults: true }), SUB, s, {})), false);
});

test("exec: long background sleeps are blocked for normal sessions only", () => {
  const s = createState();
  const r = decide(exec("sleep 240 && curl -s x", { background: true }), MAIN, s, {});
  assert.equal(blocked(r), true);
  assert.match(r.blockReason, /oc-wait/);
  assert.equal(decide(exec("sleep 240 && curl -s x", { background: true }), SUB, s, {}), undefined);
});

test("exec: waiters are moved to the background, never blocked", () => {
  const s = createState();
  const cmd = "~/.openclaw/bin/oc-wait-pipeline --project 1 --pipeline 2";
  assert.deepEqual(decide(exec(cmd), MAIN, s, {}), { params: { command: cmd, background: true } });
  assert.equal(decide(exec(cmd, { background: true }), MAIN, s, {}), undefined);
  assert.equal(decide(exec(cmd), SUB, s, {}), undefined);
  assert.equal(decide(exec(cmd), MAIN, s, { mode: "warn" }), undefined);
  // a waiter whose check sleeps is still treated as a waiter, not a foreground sleep
  assert.equal(decide(exec("oc-wait --every 30 --timeout 2h -- sleep 25"), MAIN, createState(), {}).params.background, true);
});

test("exec: repeated commands are blocked on the 4th run without progress, even when alternating", () => {
  const s = createState();
  const a = exec("curl -s https://gitlab.com/api/v4/projects/1/pipelines/2");
  const b = exec("tail -n 20 /tmp/build.log");
  const r = run(s, MAIN, [a, b, a, b, a, b, a]);
  assert.deepEqual(r.map(blocked), [false, false, false, false, false, false, true]);
  assert.match(r[6].blockReason, /same command ran 4 times/);
});

test("exec: real progress resets the repeat counter; status and message calls do not", () => {
  const s = createState();
  const t = exec("npm test");
  run(s, MAIN, [t, t, t]);
  assert.equal(decide({ toolName: "edit", params: {} }, MAIN, s, {}), undefined);
  assert.equal(blocked(decide(t, MAIN, s, {})), false);
  const s2 = createState();
  run(s2, MAIN, [t, t, t, { toolName: "message", params: { message: "still working" } }, { toolName: "session_status", params: {} }]);
  assert.equal(blocked(decide(t, MAIN, s2, {})), true);
});

test("checkpoint every 120 calls for normal sessions; message resets it; subagents exempt", () => {
  const s = createState();
  const r = run(s, MAIN, Array.from({ length: 121 }, (_, i) => ({ toolName: "read", params: { path: `f${i}` } })));
  assert.equal(r.slice(0, 120).some(blocked), false);
  assert.equal(blocked(r[120]), true);
  assert.match(r[120].blockReason, /checkpoint/);
  const s2 = createState();
  run(s2, MAIN, Array.from({ length: 119 }, () => ({ toolName: "read", params: {} })));
  decide({ toolName: "message", params: { message: "progress: 3/5 done" } }, MAIN, s2, {});
  assert.equal(run(s2, MAIN, Array.from({ length: 100 }, () => ({ toolName: "read", params: {} }))).some(blocked), false);
  const s3 = createState();
  assert.equal(run(s3, SUB, Array.from({ length: 300 }, () => ({ toolName: "read", params: {} }))).some(blocked), false);
});

test("hard cap per run blocks everything except message", () => {
  const s = createState();
  const cfg = { checkpointEvery: 0 };
  const r = run(s, MAIN, Array.from({ length: 401 }, () => ({ toolName: "read", params: {} })), cfg);
  assert.equal(r.slice(0, 400).some(blocked), false);
  assert.equal(blocked(r[400]), true);
  assert.match(r[400].blockReason, /budget of 400/);
  assert.equal(decide({ toolName: "message", params: { message: "status: stopping" } }, MAIN, s, cfg), undefined);
});

test("status checks: 12 per run, cron sessions exempt", () => {
  const s = createState();
  const r = run(s, COORD, Array.from({ length: 13 }, () => ({ toolName: "sessions_history", params: {} })));
  assert.equal(r.slice(0, 12).some(blocked), false);
  assert.equal(blocked(r[12]), true);
  const s2 = createState();
  assert.equal(run(s2, CRON, Array.from({ length: 30 }, () => ({ toolName: "session_status", params: {} }))).some(blocked), false);
});

test("briefs from the coordinator need Project, Items and Done when lines", () => {
  const filler = "x".repeat(700);
  const send = (message) => ({ toolName: "sessions_send", params: { message } });
  const s = createState();
  const r = decide(send(`Project: emberkin\n${filler}`), COORD, s, {});
  assert.equal(blocked(r), true);
  assert.match(r.blockReason, /missing Items:, Done when:/);
  const good = `- **Project:** emberkin, /srv/o, topic 151\nItems: a1b2 fix login\nDone when: npm test passes\n${filler}`;
  assert.equal(decide(send(good), COORD, createState(), {}), undefined);
  assert.equal(decide(send(filler), MAIN, createState(), {}), undefined);
  assert.equal(decide(send("short note"), COORD, createState(), {}), undefined);
  assert.equal(blocked(decide(send(filler), MAIN, createState(), { briefCheckAgents: [] })), true);
});

test("the same message three times in a run is blocked", () => {
  const s = createState();
  const m = { toolName: "message", params: { message: "Still working on it" } };
  assert.deepEqual(run(s, MAIN, [m, m, m]).map(blocked), [false, false, true]);
});

test("warn mode logs but never blocks or rewrites", () => {
  const s = createState();
  const logs = [];
  const log = (level, msg) => logs.push(`${level}:${msg}`);
  assert.equal(decide(exec("sleep 300"), MAIN, s, { mode: "warn" }, log), undefined);
  assert.ok(logs.some((l) => l.includes("would block") && l.includes("foregroundSleep")));
  assert.equal(s.blocks.get("foregroundSleep"), 1);
});

test("exempt sessions, disabled guard and malformed events are never blocked", () => {
  assert.equal(decide(exec("sleep 300"), MAIN, createState(), { exemptSessionPatterns: [":telegram:group:"] }), undefined);
  assert.equal(decide(exec("sleep 300"), MAIN, createState(), { enabled: false }), undefined);
  assert.equal(decide(undefined, MAIN, createState(), {}), undefined);
  assert.equal(decide({ toolName: "exec" }, MAIN, createState(), {}), undefined);
  assert.equal(decide({ toolName: "exec", params: "nonsense" }, undefined, createState(), {}), undefined);
});

test("runs without a runId are keyed by session and reset after an idle gap", () => {
  const s = createState();
  const ctx = { agentId: "devops", sessionKey: "agent:devops:main" };
  const t0 = 1_000_000;
  decide(poll("A"), ctx, s, {}, null, t0);
  decide(poll("A"), ctx, s, {}, null, t0 + 1000);
  assert.equal(blocked(decide(poll("A"), ctx, s, {}, null, t0 + 2000)), true);
  assert.equal(decide(poll("A"), ctx, s, {}, null, t0 + 2000 + DEFAULT_CONFIG.runIdleResetMs + 1), undefined);
});

test("endRun clears a run; TTL and size caps prune old runs", () => {
  const s = createState();
  run(s, MAIN, [poll("A"), poll("A")]);
  endRun(s, {}, MAIN);
  assert.equal(decide(poll("A"), MAIN, s, {}), undefined);
  const s2 = createState();
  decide(poll("A"), MAIN, s2, {}, null, 0);
  decide(poll("A"), { ...MAIN, runId: "other" }, s2, {}, null, DEFAULT_CONFIG.ttlMs + 10);
  assert.equal(s2.runs.has("run:r1"), false);
  const s3 = createState();
  for (let i = 0; i < 20; i++) decide(poll("A"), { ...MAIN, runId: `r${i}` }, s3, { maxTrackedRuns: 10 }, null, i);
  assert.ok(s3.runs.size <= 10);
});

test("task_inbox argument mapping", () => {
  assert.deepEqual(inboxArgs({ action: "add", project: "emberkin", title: "Login 500", type: "bug", done_when: "e2e passes" }),
    ["add", "--project", "emberkin", "--title", "Login 500", "--type", "bug", "--done-when", "e2e passes"]);
  assert.deepEqual(inboxArgs({ action: "set", id: "a1b2", status: "done", note: "merged" }), ["set", "a1b2", "--status", "done", "--note", "merged"]);
  assert.deepEqual(inboxArgs({ action: "plan", json: true }), ["plan", "--json"]);
  assert.deepEqual(inboxArgs({ action: "list", project: "ai", title: "ignored" }), ["list", "--project", "ai"]);
  assert.throws(() => inboxArgs({ action: "rm" }), /action must be one of/);
  assert.throws(() => inboxArgs({ action: "set" }), /needs id/);
  assert.throws(() => inboxArgs({ action: "add", project: "x" }), /needs project and title/);
});
