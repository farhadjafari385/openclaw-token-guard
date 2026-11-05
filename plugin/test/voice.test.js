import test from "node:test";
import assert from "node:assert/strict";
import {
  mdToHtml, htmlToPlain, splitReport, dispatchText, ackText, resultText, stallText, approvalAskText, approvalReplyText,
  ownerTag, handleOf, titleOf, modelName, guardText,
} from "../voice.js";
import { createMirror, messageIdOf } from "../mirror.js";
import { emptyState, recordSpawn, mergeStates, mergeJobsConfig } from "../jobs.js";

const CFG = {
  orchestratorAgent: "coordinator",
  agentHandles: { coordinator: "orc_bot", devops: "devops_bot", qa: "qa_bot" },
  agentNames: { devops: "DevSecOps Engineer" },
  ownerHandle: "OwnerHandle",
  ownerId: "42",
  ownerName: "Owner",
};

// Telegram rejects a message whose HTML tags do not nest properly; check every generated text.
function assertBalanced(html) {
  const stack = [];
  for (const m of String(html).matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/g)) {
    const [, close, tag] = m;
    assert.ok(["b", "i", "code", "pre", "a", "blockquote"].includes(tag), `unexpected tag <${tag}> in ${html}`);
    if (close) {
      assert.equal(stack.pop(), tag, `unbalanced </${tag}> in ${html}`);
      continue;
    }
    // Telegram nesting rules: code, pre and blockquote never sit inside another entity, nothing sits inside
    // code or pre, and only bold or italic may sit inside a link.
    if (["code", "pre"].includes(tag)) assert.ok(!stack.length, `<${tag}> nested in <${stack.join("><")}> in ${html}`);
    if (tag === "blockquote") assert.ok(!stack.length, `<blockquote> nested in ${html}`);
    assert.ok(!stack.some((t) => t === "code" || t === "pre"), `<${tag}> inside code/pre in ${html}`);
    if (stack.includes("a")) assert.ok(["b", "i"].includes(tag), `<${tag}> inside a link in ${html}`);
    if (stack.includes("blockquote")) assert.ok(["b", "i"].includes(tag), `<${tag}> inside a blockquote in ${html}`);
    stack.push(tag);
  }
  assert.deepEqual(stack, [], `unclosed tags in ${html}`);
  assert.doesNotMatch(String(html).replace(/<\/?[a-z]+(?:\s[^>]*)?>/g, "").replace(/&(amp|lt|gt|quot);/g, ""), /[<>]/, "raw < or > left in text");
}

test("markdown from agents becomes safe Telegram HTML", () => {
  const md = "## Summary\n**Pipeline** `#42` is green & fast: [MR !7](https://gitlab.example/mr/7?a=1&b=2)\n- one <b>tag</b>\n```\nif (a < b) x();\n```\nunclosed **bold and `tick";
  const html = mdToHtml(md);
  assertBalanced(html);
  assert.match(html, /^<b>Summary<\/b>\n<b>Pipeline<\/b> <code>#42<\/code> is green &amp; fast: <a href="https:\/\/gitlab\.example\/mr\/7\?a=1&amp;b=2">MR !7<\/a>/);
  assert.match(html, /\n• one &lt;b&gt;tag&lt;\/b&gt;\n<pre>if \(a &lt; b\) x\(\);<\/pre>/);
  const plain = mdToHtml(md, 3000, false); // inside a blockquote: bold only
  assertBalanced(plain);
  assert.doesNotMatch(plain, /<(code|pre|a)\b/);
  assert.match(plain, /MR !7 \(https:\/\/gitlab\.example\/mr\/7\?a=1&amp;b=2\)/);
  assert.equal(htmlToPlain('<b>x</b> &amp; <a href="https://a.b">link</a> <a href="tg://user?id=1">Owner</a>'), "x & link (https://a.b) Owner");
  assertBalanced(mdToHtml("# Deploy `v2` now\n**RESULT:** done `x`"));
  for (const tricky of ["**", "``", "`a**b`", "**a `b** c`", "<<>>&&", "# ", "[x](javascript:alert(1))", "*** ---"]) assertBalanced(mdToHtml(tricky));
  assert.doesNotMatch(mdToHtml("[x](javascript:alert(1))"), /<a /);
});

test("a worker's report: plain summary first, the RESULT block folded", () => {
  const report = "I fixed the cache key so the pipeline reuses the image. It is green now.\n\nRESULT: done\nChecks: pipeline 42 green -> PASS\nChanges: .gitlab-ci.yml";
  assert.deepEqual(splitReport(report), {
    summary: "I fixed the cache key so the pipeline reuses the image. It is green now.",
    details: "RESULT: done\nChecks: pipeline 42 green -> PASS\nChanges: .gitlab-ci.yml",
  });
  assert.equal(splitReport("RESULT: done\nChecks: pipeline 42 green -> PASS").summary, "pipeline 42 green -> PASS");
  assert.deepEqual(splitReport("All good, nothing to change.\n\nDetails here."), { summary: "All good, nothing to change.", details: "Details here." });
  const job = { key: "k1", agentId: "devops", label: "demo: fix CI cache", spawnedAt: 0, endedAt: 12 * 60000, outcome: "ok", resultText: report };
  const text = resultText(CFG, job, "done", [{ id: "ab12cd34", to: "review" }]);
  assertBalanced(text);
  assert.match(text, /^@orc_bot ✅ Done \(12 min\)\. I fixed the cache key/);
  assert.match(text, /<blockquote expandable><b>RESULT:<\/b> done\n<b>Checks:<\/b> pipeline 42 green -&gt; PASS/);
  assert.match(text, /<i>Board: ab12cd34 → Review<\/i>$/);
  const blocked = resultText(CFG, Object.assign({}, job, { resultText: "I need the owner's OK to touch production.\nRESULT: blocked" }), "blocked", []);
  assert.match(blocked, /^@orc_bot ⛔ I'm blocked \(12 min\)\. I need the owner's OK/);
  const timeout = resultText(CFG, Object.assign({}, job, { outcome: "timeout", resultText: "", error: "run timed out <60m>" }), "failed", []);
  assertBalanced(timeout);
  assert.match(timeout, /⌛ I ran out of time/);
  assert.match(timeout, /Error: <code>run timed out &lt;60m&gt;<\/code>/);
  assert.match(timeout, /I left no written report/);
});

test("dispatch, acknowledgement and process notes read like a team", () => {
  const job = { key: "agent:devops:subagent:1", agentId: "devops", label: "demo: fix CI cache", doneWhen: "pipeline green on main", items: ["ab12cd34"], model: "anthropic/claude-opus-5-5", thinking: "medium" };
  const d = dispatchText(CFG, job);
  assertBalanced(d);
  assert.match(d, /^@devops_bot (can you take this one\?|over to you:|this one is yours:)\n<b>Fix CI cache<\/b>\nDone when: pipeline green on main\n<i>ab12cd34 · Opus 5\.5 · medium effort<\/i>$/);
  assert.equal(dispatchText(CFG, job), d); // stable for the same job
  assert.match(ackText(CFG, job), /On it|Taking it/);
  assert.match(stallText(CFG, job, 31), /^@orc_bot no activity from @devops_bot on <b>Fix CI cache<\/b> for 31 min/);
  assert.equal(titleOf("ai: research vector DBs"), "Research vector DBs");
  assert.equal(modelName("openai/gpt-6-astra"), "GPT-6 Astra");
  assert.equal(modelName("anthropic/claude-sonnet-5"), "Sonnet 5");
  assert.equal(handleOf(CFG, "writer"), "writer");
  assert.equal(handleOf(CFG, "devops"), "@devops_bot");
  assert.match(guardText(CFG, "protectedFile", { agentId: "devops", tool: "exec" }), /^🛡 Guard stopped @devops_bot: changing a protected file/);
});

test("the owner is mentioned for approvals, by handle or by id", () => {
  assert.equal(ownerTag(CFG), "@OwnerHandle");
  assert.equal(ownerTag({ ownerId: "42", ownerName: "A & B" }), '<a href="tg://user?id=42">A &amp; B</a>');
  const one = approvalAskText(CFG, [{ id: "ab12cd34", title: "Fix CI <cache>" }]);
  assertBalanced(one);
  assert.equal(one, "@OwnerHandle ✅ <b>Fix CI &lt;cache&gt;</b> is done and I've checked it. Reply <code>approve ab12cd34</code> to archive it.");
  const two = approvalAskText(CFG, [{ id: "ab12cd34", title: "A" }, { id: "cd34ef56", title: "B" }]);
  assertBalanced(two);
  assert.match(two, /Reply <code>approve ab12cd34 cd34ef56<\/code> to archive them \(or <code>approve all<\/code>\)\.$/);
  const reply = approvalReplyText(CFG, [{ id: "ab12cd34", title: "A" }], [{ id: "cd34ef56", title: "B" }], []);
  assert.equal(reply, "🗄 Thanks, archived: A (ab12cd34).\n👍 Noted. B (cd34ef56) gets archived once I've checked it too.");
});

test("mirror: HTML replies, and fallbacks when Telegram rejects formatting or the reply", async () => {
  assert.equal(messageIdOf("1234"), 1234);
  assert.equal(messageIdOf("telegram:-100:77"), 77);
  assert.equal(messageIdOf("abc"), null);
  const calls = [];
  const replies = [
    { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities: unclosed tag" }) },
    { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 11 } }) },
    { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: message to be replied not found" }) },
    { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 12 } }) },
  ];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); return replies.shift(); };
  const m = createMirror({ cfg: { chatId: "-100", botTokenFiles: { coordinator: "/t" }, minIntervalMs: 0 }, fetchImpl, readFile: () => "T" });
  assert.equal(await m.post({ agentId: "coordinator", topic: 151, text: "<b>bad &amp; text", html: true, replyTo: 5 }), 11);
  assert.deepEqual(calls[0], { chat_id: "-100", text: "<b>bad &amp; text", disable_web_page_preview: true, parse_mode: "HTML", message_thread_id: 151, reply_parameters: { message_id: 5, allow_sending_without_reply: true } });
  assert.deepEqual(calls[1], { chat_id: "-100", text: "bad & text", disable_web_page_preview: true, message_thread_id: 151, reply_parameters: { message_id: 5, allow_sending_without_reply: true } });
  assert.equal(await m.post({ agentId: "coordinator", topic: 151, text: "<b>ok</b>", html: true, replyTo: "9" }), 12);
  assert.equal(calls[2].parse_mode, "HTML");
  assert.equal(calls[3].reply_parameters, undefined); // retried as a normal message
  assert.equal(calls[3].parse_mode, "HTML");
});

test("merging job copies keeps the thread's message ids", () => {
  const cfg = mergeJobsConfig({});
  const a = emptyState();
  const b = emptyState();
  recordSpawn(a, { childSessionKey: "k", agentId: "qa" }, "g", 1000, cfg);
  a.jobs.k.dispatchMsgId = 101;
  recordSpawn(b, { childSessionKey: "k", agentId: "qa" }, "g", 1000, cfg);
  Object.assign(b.jobs.k, { status: "ended", endedAt: 5000, resultMsgId: 202 });
  b.ownerMsgs = { 151: { id: 7, at: 10 } };
  a.ownerMsgs = { 151: { id: 9, at: 20 }, 152: { id: 3, at: 5 } };
  const m = mergeStates(a, b);
  assert.equal(m.jobs.k.status, "ended");
  assert.equal(m.jobs.k.dispatchMsgId, 101);
  assert.equal(m.jobs.k.resultMsgId, 202);
  assert.deepEqual(m.ownerMsgs, { 151: { id: 9, at: 20 }, 152: { id: 3, at: 5 } });
});

test("every copy of the plugin in one process shares one boot, so running tasks are never taken for cut off", async () => {
  const a = await import("../boot.js?copy=a");
  const b = await import("../boot.js?copy=b");
  assert.notEqual(a, b); // two module copies, as OpenClaw's plugin generations are
  assert.equal(a.processBoot().id, b.processBoot().id);
  assert.ok(a.processBoot().startedAt <= Date.now() && a.processBoot().startedAt > Date.now() - process.uptime() * 1000 - 5000);
  const { scanJobs } = await import("../jobs.js");
  const cfg = mergeJobsConfig({});
  const d = emptyState();
  const boot = a.processBoot();
  recordSpawn(d, { childSessionKey: "agent:qa:subagent:9", agentId: "qa", label: "x", requesterSessionKey: "agent:coordinator:main" }, boot.id, Date.now(), cfg);
  const env = { bootId: b.processBoot().id, bootStartedAt: Date.now() - 60 * 60000, orchestratorAgent: "coordinator", inboxItems: [] };
  assert.deepEqual(scanJobs(d, cfg, Date.now(), env).filter((x) => x.reason === "interrupted"), []);
  assert.equal(d.jobs["agent:qa:subagent:9"].status, "running");
});

test("mirror: an edit with unchanged text counts as done, so the board view never re-posts itself", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" }) }; };
  const m = createMirror({ cfg: { chatId: "-1", botTokenFiles: { coordinator: "/t" }, minIntervalMs: 0 }, fetchImpl, readFile: () => "T" });
  assert.equal(await m.edit({ agentId: "coordinator", messageId: 5, text: "same" }), true);
  assert.equal(calls, 1);
});
