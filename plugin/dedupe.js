// The same answer sent twice to the same chat. On 2026-11-22 the owner got word-for-word repeats
// 30-100 s apart: a message that failed to start ("session changed before durable user-turn admission")
// was replayed by OpenClaw's delivery recovery and answered again. A repeat of a recent message to the
// same chat and topic is dropped. Pure: no OpenClaw imports.

const DEFAULT_DEDUPE = { windowMinutes: 20, minChars: 60, similarity: 0.85, keep: 30 };

const norm = (t) => String(t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function words(t) {
  const w = norm(t).split(" ").filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  if (!out.size && w.length) out.add(w.join(" "));
  return out;
}

function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = words(a);
  const B = words(b);
  let both = 0;
  for (const x of A) if (B.has(x)) both += 1;
  // Share of the shorter message found in the other; lengths must be close, so a short note quoted
  // inside a longer answer is not a repeat.
  const small = Math.min(A.size, B.size);
  const big = Math.max(A.size, B.size);
  if (!small || small / big < 0.7) return 0;
  return both / small;
}

// state: Map dest -> [{ at, text }]. Returns the earlier message when `text` repeats it, else records it.
function checkRepeat(state, dest, text, now, cfg = DEFAULT_DEDUPE) {
  const c = Object.assign({}, DEFAULT_DEDUPE, cfg || {});
  if (norm(text).length < c.minChars) return null;
  const list = (state.get(dest) || []).filter((m) => now - m.at < c.windowMinutes * 60000);
  const hit = list.find((m) => similarity(m.text, text) >= c.similarity);
  if (hit) { state.set(dest, list); return hit; }
  list.push({ at: now, text: String(text) });
  while (list.length > c.keep) list.shift();
  state.set(dest, list);
  return null;
}

export { DEFAULT_DEDUPE, similarity, checkRepeat };
