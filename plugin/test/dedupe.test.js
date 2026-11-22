import test from "node:test";
import assert from "node:assert/strict";
import { checkRepeat, similarity } from "../dedupe.js";

const A = "The 19:40 artisan:16 alert is the same error as yesterday's. It has fired at 19:40 EST two days running, so a daily scheduled command is failing. The fix the team made last time didn't stop it.";

test("a word-for-word repeat to the same chat is caught", () => {
  const s = new Map();
  assert.equal(checkRepeat(s, "o:chat:153", A, 1000), null);
  assert.ok(checkRepeat(s, "o:chat:153", A, 100000));
});

test("the same text to another chat or topic is sent", () => {
  const s = new Map();
  checkRepeat(s, "o:chat:153", A, 1000);
  assert.equal(checkRepeat(s, "o:chat:160", A, 2000), null);
});

test("a repeat after the window is sent", () => {
  const s = new Map();
  checkRepeat(s, "o:c:", A, 0);
  assert.equal(checkRepeat(s, "o:c:", A, 21 * 60000), null);
});

test("a near repeat (small edit) is caught, a different answer is not", () => {
  assert.ok(similarity(A, A.replace("didn't", "did not")) >= 0.85);
  const s = new Map();
  checkRepeat(s, "d", A, 0);
  assert.equal(checkRepeat(s, "d", "Devops found the cause of the QA consumer token 401. Both saved QA tokens have expired; the files are dated Nov 13 and 14.", 1000), null);
});

test("short messages are never held", () => {
  const s = new Map();
  checkRepeat(s, "d", "On it.", 0);
  assert.equal(checkRepeat(s, "d", "On it.", 1000), null);
});

test("a short note quoted inside a longer, different answer is not a repeat", () => {
  const s = new Map();
  checkRepeat(s, "d", A, 0);
  assert.equal(checkRepeat(s, "d", A + " Then devops found the real cause: the cron runs the old image, the new one was never deployed, and the deploy job is manual on master. I asked devops to run it and prove a clean 19:40 run tomorrow with the log.", 1000), null);
});
