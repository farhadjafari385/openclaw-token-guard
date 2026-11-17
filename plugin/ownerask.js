// The owner's standing order (2026-11-17): the orchestrator never stops to ask the owner what it can decide itself.
// Between 2026-11-16 08:00 and 2026-11-17 08:00 it asked ten times ("Which app is this for?", "Is it OK to use it
// just for those two numbers?") and the work waited for the answer. Only what the owner alone holds may be asked:
// money, the owner's own accounts, sign-ins, codes sent to the owner's phone, IDs and signatures, deleting data.

// A question that needs something only the owner has: these may still go to the owner.
const OWNER_ONLY = /\b(pay|paid|payment|purchase|buy|spend|budget|money|price|invoice|merchant|bank|card|billing|account|sign[- ]?in|log[- ]?in|login|password|passkey|2fa|otp|code|sms|phone|scan|qr|identity|passport|id card|national id|kyc|signature|sign the|legal|contract|delete|deleting|wipe|drop the database)\b/i;

// Sentences that ask the owner to decide or act.
const ASKS = /\b(should i|shall i|do you want|would you like|want me to|which (one|option|app|project|way|of)|is it ok|is that ok|ok to|okay to|can i|may i|do you approve|approve|confirm|can you|could you|would you|please (send|share|provide|tell|choose|pick|decide)|let me know|your call|up to you)\b/i;

function sentences(text) {
  return String(text || "")
    .replace(/[“”"«»][^“”"«»]{0,300}[“”"«»]/g, " ") // quoted words (often the owner's own question) are not asks
    .replace(/`[^`]*`/g, " ")
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.replace(/^[\s>*_\-•\d.)]+/, "").trim())
    .filter(Boolean);
}

// The first question in `text` that asks the owner for a decision the team can make itself; null if none.
function ownerQuestion(text) {
  for (const s of sentences(text)) {
    if (!s.endsWith("?")) continue;
    if (!ASKS.test(s)) continue;
    if (OWNER_ONLY.test(s)) continue;
    return s.slice(0, 300);
  }
  return null;
}

// Per session: at most one hold per window, so a reply is never held twice in a row (the owner still gets an answer).
function allowHold(holds, key, now = Date.now(), windowMs = 10 * 60000) {
  if (holds.has(key) && now - holds.get(key) < windowMs) return false;
  holds.set(key, now);
  if (holds.size > 500) holds.delete(holds.keys().next().value);
  return true;
}

function decideWakeText(question, where) {
  return `[owner-ask] Your message to the owner was not sent: it asked "${question}". ` +
    "The owner's standing order: never ask what you can decide. Decide it now yourself (take the default you would " +
    "recommend), act on it (dispatch, or do the read-only check yourself), and then tell the owner in one short " +
    `message ${where} what you decided and what is running, with links. Ask only for what the owner alone holds: ` +
    "money, the owner's own accounts or sign-ins, a code sent to the owner's phone, an ID or signature, or deleting data.";
}

export { ownerQuestion, allowHold, decideWakeText, OWNER_ONLY, ASKS };
