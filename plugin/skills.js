// Skills for a task: the guard names, in every brief, the skills of that agent that fit the task best,
// so they are used without anyone having to remember them. Deterministic word matching against each
// skill's own description (no model call). Pure: no OpenClaw imports.

const STOP = new Set(("the and for with that this from your you are use when what which into onto over under about " +
  "any all can will must should not but its it's has have had was were been being also only more most such than then " +
  "them they their there here how why who whom where while after before every each other some same very just like " +
  "make makes made using used uses user users work works task tasks owner team agent agents project projects").split(" "));

// Words that mean the same thing for picking a skill.
const SAME = {
  fix: ["bug"], fixes: ["bug"], broken: ["bug"], crash: ["bug", "failure"], crashes: ["bug", "failure"], error: ["bug"],
  errors: ["bug"], red: ["failure", "bug"], flaky: ["bug", "test"], regression: ["bug", "test"], bugfix: ["bug", "fix"],
  postgres: ["postgresql", "sql"], postgresql: ["sql"], database: ["sql"], migration: ["sql", "schema"],
  generic: ["slop"], "ai-made": ["slop", "generic"], templated: ["generic"], ugly: ["polish", "generic"],
  responsive: ["mobile", "layout"], phone: ["mobile"], unreadable: ["readable", "typography"], readable: ["typography"],
  a11y: ["accessibility"], wcag: ["accessibility"], deploy: ["release"], release: ["deploy"],
  pr: ["review"], mr: ["review"], merge: ["review"], ci: ["pipeline"], pipeline: ["ci"],
};

// A light stem so that "failing", "failed" and "failure" meet.
function stem(w) {
  if (w.length <= 5) return w;
  return w.replace(/(ingly|ing|edly|ed|ures|ure|ies|es|s)$/, "") || w;
}

function words(text) {
  const out = [];
  for (const raw of String(text || "").toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").split(" ")) {
    const w = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (w.length <= 2 || STOP.has(w)) continue;
    out.push(stem(w));
    for (const x of SAME[w] || []) out.push(stem(x));
  }
  return out;
}

// skills: [{ name, about, always }] for one agent. Returns the names to use, best first.
function selectSkills(brief, skills, max = 5) {
  const list = (skills || []).filter((s) => s && s.name);
  if (!list.length) return [];
  const docs = list.map((s) => new Set(words(`${s.name.replace(/-/g, " ")} ${s.about || ""}`)));
  const df = new Map();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const n = list.length;
  const briefWords = new Set(words(brief));
  const scored = list.map((s, i) => {
    let score = 0;
    for (const w of briefWords) if (docs[i].has(w)) score += Math.log(1 + n / df.get(w));
    for (const part of s.name.split("-")) if (part.length > 2 && briefWords.has(stem(part))) score += 1.5; // the name itself is the strongest signal
    return { name: s.name, score, always: Boolean(s.always) };
  });
  const always = scored.filter((s) => s.always).map((s) => s.name);
  const best = scored.filter((s) => !s.always && s.score >= 2).sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.name);
  return [...always, ...best];
}

function skillsLine(names) {
  return names.length ? `Skills for this task (open each one's SKILL.md before you start and follow it): ${names.join(", ")}` : "";
}

export { selectSkills, skillsLine, words };
