import { decide, createState, totalSleepSeconds, isSoleWaiter } from "/home/team/.openclaw/token-guard/plugin/guard.js";
import { createQueue } from "/home/team/.openclaw/token-guard/plugin/queue.js";
let fail = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fail++; };
const cfg = { queueBusySessions: true };
const ctx = { agentId: "coordinator", sessionKey: "agent:coordinator:telegram:group:-1000000000001:topic:160", runId: "r1" };
const busyState = () => { const s = createState(); s.queue = createQueue({ log() {}, deliver() {} }); s.isBusy = () => true; return s; };
const target = "agent:writer:telegram:group:-1000000000001:topic:153";
const pad = "x".repeat(700);
// 1: brief missing Model/Effort to busy session
let s = busyState();
let r = decide({ toolName: "sessions_send", params: { sessionKey: target, message: `Project: ai\nScope: a\nItems: a1b2c3d4\nDone when: ok\nStop if: x\n${pad}` } }, ctx, s, cfg, null);
ok("brief missing Model/Effort to busy session is blocked (briefFields)", r && r.block && /missing/.test(r.blockReason) && s.queue.pending.size === 0);
// complete brief to busy session still queues
s = busyState();
r = decide({ toolName: "sessions_send", params: { sessionKey: target, message: `Project: ai\nScope: a\nItems: a1b2c3d4\nDone when: ok\nStop if: x\nModel: sonnet\nEffort: low\n${pad}` } }, ctx, s, cfg, null);
ok("complete brief to busy session is queued", r && r.block && /queued/.test(r.blockReason) && s.queue.pending.size === 1);
// short followup to busy session queues
s = busyState();
r = decide({ toolName: "sessions_send", params: { sessionKey: target, message: "status?" } }, ctx, s, cfg, null);
ok("short follow-up to busy session queued", r && /queued/.test(r.blockReason));
// queue passes meta through
let got; const q = createQueue({ log() {}, deliver: async (k, m, meta) => { got = [k, m, meta]; } });
q.enqueue("k", "m", { agentId: "a" }); await q.onRunEnd("k");
ok("queue delivers message + meta", got && got[1] === "m" && got[2].agentId === "a");
// 2: ReDoS
// Gateway is long-running, so warm the JIT, then take the median of 5 distinct 80KB inputs per shape.
const shapes = [
  (n) => "bash -c '" + "a b ".repeat(20000) + n + "\n" + "echo \"" + "q".repeat(5000),
  (n) => "ssh " + "x ".repeat(40000) + n,
  (n) => ("python3 -c 'a' ; ").repeat(4700) + n,
];
const timeOf = (cmd) => { const t = performance.now(); decide({ toolName: "exec", params: { command: cmd } }, { ...ctx, runId: "t" + Math.random() }, createState(), {}, null); return performance.now() - t; };
for (let i = 0; i < 3; i++) for (const f of shapes) timeOf(f(" w" + i));
const med = (f) => { const xs = [0, 1, 2, 3, 4].map((i) => timeOf(f(" m" + i))).sort((x, y) => x - y); return xs[2]; };
const [ms, ms2, ms3] = shapes.map(med);
const big = shapes[0](""), big2 = shapes[1](""), big3 = shapes[2]("");
console.log(`median ms (warm, via decide): ${ms.toFixed(1)} ${ms2.toFixed(1)} ${ms3.toFixed(1)} (len ${big.length}/${big2.length}/${big3.length})`);
ok("80KB commands parse < 50ms", Math.max(ms, ms2, ms3) < 50);
// 3
const E = (command, extra = {}) => decide({ toolName: "exec", params: { command, ...extra } }, { ...ctx, runId: "r" + Math.random() }, createState(), {}, null);
ok("/tmp/x/oc-wait; sleep 600 blocked", E("/tmp/x/oc-wait; sleep 600")?.block === true);
ok("~/.openclaw/bin/oc-wait; sleep 600 blocked", E("~/.openclaw/bin/oc-wait --every 30 -- true; sleep 600")?.block === true);
ok("awaitResults + sleep 600 blocked", E("sleep 600", { awaitResults: true })?.block === true);
r = E("~/.openclaw/bin/oc-wait --every 30 --timeout 2h -- test -f /tmp/done");
ok("real oc-wait passes (moved to background)", r && !r.block && r.params?.background === true);
r = E("~/.openclaw/bin/oc-wait-pipeline --project 1 --pipeline 2", { background: true });
ok("real oc-wait-pipeline background passes", r === undefined);
r = E("/home/team/.openclaw/bin/oc-wait --every 30 -- sleep 600", { awaitResults: true });
ok("real oc-wait with awaitResults passes", r === undefined);
ok("plain command passes", E("ls -la") === undefined);
ok("short sleep passes", E("sleep 5") === undefined);
// normal brief to spawn passes
r = decide({ toolName: "sessions_spawn", params: { agentId: "writer", context: "isolated", task: `Project: ai\nScope: a\nItems: a1b2c3d4\nDone when: ok\nStop if: x\nModel: sonnet\nEffort: low\n${pad}` } }, ctx, createState(), {}, null);
ok("normal brief via sessions_spawn passes", r === undefined);
r = decide({ toolName: "sessions_send", params: { sessionKey: target, message: `Project: ai\nScope: a\nItems: a1b2c3d4\nDone when: ok\nStop if: x\nModel: sonnet\nEffort: low\n${pad}` } }, ctx, createState(), {}, null);
ok("normal complete brief to idle topic passes", r === undefined);
// ---- round 2: B1, R1-R3
const pad16 = " ".repeat(20000);
ok("B1 padded 'sleep 600' blocked", E("sleep 600" + pad16)?.block === true);
ok("B1 padded bash -c 'sleep 600' blocked (oversizeCommand)", /too large/.test(E("bash -c 'sleep 600'" + pad16)?.blockReason || ""));
ok("B1 padded ssh host 'sleep 600' blocked", E("ssh h 'sleep 600'" + pad16)?.block === true);
ok("B1 padded python3 -c time.sleep blocked", E("python3 -c 'import time; time.sleep(600)'" + pad16)?.block === true);
ok("B1 padded plain echo passes", E("echo hi" + pad16) === undefined);
ok("B1 80KB bash -c blocked fast", (() => { const t = performance.now(); const x = E("bash -c '" + "a b ".repeat(20000) + "'"); return x?.block && performance.now() - t < 50; })());
ok("R1 waiter with sh -c 'sleep 600' blocked", E("~/.openclaw/bin/oc-wait --every 30 -- sh -c 'sleep 600'")?.block === true);
ok("R1 waiter -- bash -c 'sleep 600' awaitResults blocked", E("~/.openclaw/bin/oc-wait -- bash -c 'sleep 600'", { awaitResults: true })?.block === true);
ok('R2 quoted "$HOME/.openclaw/bin/oc-wait" exempt (backgrounded)', E('"$HOME/.openclaw/bin/oc-wait" --every 30 -- test -f /tmp/d')?.params?.background === true);
ok('R2 quoted path chained with sleep 600 blocked', E('"$HOME/.openclaw/bin/oc-wait"; sleep 600')?.block === true);
ok("R2 single-quoted $HOME not exempt", !isSoleWaiter("'$HOME/.openclaw/bin/oc-wait' -- true"));
ok("R3 $( in waiter args not exempt (not rewritten to background)", !isSoleWaiter("~/.openclaw/bin/oc-wait -- test -f $(sleep 600)") && E("~/.openclaw/bin/oc-wait -- test -f $(sleep 600)")?.params?.background !== true);
ok("R3 backtick not exempt (not rewritten to background)", !isSoleWaiter("~/.openclaw/bin/oc-wait -- test -f `sleep 600`") && E("~/.openclaw/bin/oc-wait -- test -f `sleep 600`")?.params?.background !== true);
ok("R3 <( not exempt (not rewritten to background)", !isSoleWaiter("~/.openclaw/bin/oc-wait -- cat <(sleep 600)") && E("~/.openclaw/bin/oc-wait -- cat <(sleep 600)")?.params?.background !== true);
ok("R3 >( not exempt (not rewritten to background)", !isSoleWaiter("~/.openclaw/bin/oc-wait -- tee >(sleep 600)") && E("~/.openclaw/bin/oc-wait -- tee >(sleep 600)")?.params?.background !== true);
ok("R3 plain waiter still exempt", E("~/.openclaw/bin/oc-wait --every 30 -- test -f /tmp/d")?.params?.background === true);
console.log(fail ? `${fail} FAILED` : "ALL PASS"); process.exit(fail ? 1 : 0);
