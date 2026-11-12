// Which Telegram topic a team message belongs in. Pure.
//
// projects: { "<name>": { topic, aliases: [...], strict: bool } }. A strict name
// (short or common words like "ai" or "graph") only counts when written as a
// project: "Project: ai", "#ai", "the ai project", "ai repo".

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const cache = new Map();
function matchers(projects) {
  const key = JSON.stringify(projects || {});
  let hit = cache.get(key);
  if (hit) return hit;
  hit = [];
  for (const [name, p] of Object.entries(projects || {})) {
    const names = [name, ...((p && p.aliases) || [])].map((n) => String(n).toLowerCase()).filter(Boolean);
    const alt = names.map(escapeRe).join("|");
    // "strict" is for a project whose own name is a common word ("ai"): that name counts only when written
    // as a project. Its aliases are distinctive names and match like any other name.
    const plain = (list) => `(?:^|[^a-z0-9_-])(?:${list.map(escapeRe).join("|")})(?:$|[^a-z0-9_-])`;
    const aliases = names.slice(1);
    const re = p && p.strict
      // A name ends where a hyphen would not continue it: "project: acme-hub" is not the alias "acme"
      // (2026-11-08: \b treated "-" as an end, so every task of the hub project was taken for the other one).
      ? new RegExp(`(?:\\bproject\\s*[:=]?\\s*\\**\\s*(?:${alt})(?![a-z0-9_-])|#(?:${alt})(?![a-z0-9_-])|(?<![a-z0-9_-])(?:${alt})\\s+(?:project|repo|monorepo|topic)\\b${aliases.length ? `|${plain(aliases)}` : ""})`, "i")
      : new RegExp(plain(names), "i");
    hit.push({ name, topic: Number(p && p.topic), re });
  }
  cache.set(key, hit);
  return hit;
}

function projectsMentioned(text, projects) {
  const t = String(text || "");
  // A brief's Project: line decides on its own.
  const line = /^[\s>*#_-]*project\s*:\s*\**\s*([^\n]+)/im.exec(t);
  if (line) {
    // The project's own name first on the line decides, whatever else the line mentions.
    const head = String(line[1]).trim().toLowerCase().replace(/^\**\s*/, "").split(/[\s(*,;]/)[0];
    if (head && Object.prototype.hasOwnProperty.call(projects || {}, head)) return [head];
    const fromLine = matchers(projects).filter((m) => m.re.test(` project: ${line[1]} `) || new RegExp(`(?:^|[^a-z0-9_-])${escapeRe(m.name)}(?:$|[^a-z0-9_-])`, "i").test(line[1]));
    if (fromLine.length) return [...new Set(fromLine.map((m) => m.name))];
  }
  return [...new Set(matchers(projects).filter((m) => m.re.test(t)).map((m) => m.name))];
}

function topicOfProject(projects, name) {
  const p = (projects || {})[name];
  return p ? Number(p.topic) : null;
}

function projectOfTopic(projects, topic) {
  const t = Number(topic);
  for (const [name, p] of Object.entries(projects || {})) if (Number(p.topic) === t) return name;
  return null;
}

function isGeneral(threadId) {
  return threadId === undefined || threadId === null || threadId === "" || Number(threadId) <= 1;
}

// The topic a group message must go to, given where it is aimed and what it says.
// keep: topics whose posts stay where they are whatever project they name (the Postmortems topic: on 2026-11-12 three
// postmortems naming the ai project were moved out of it, and the owner saw none there).
function correctTopic({ threadId, text, projects, teamTopic, keep = [] }) {
  if (!isGeneral(threadId) && (keep || []).map(Number).includes(Number(threadId))) return { topic: Number(threadId), project: projectOfTopic(projects, threadId) };
  const mentioned = projectsMentioned(text, projects);
  const team = Number(teamTopic) || null;
  if (mentioned.length === 1) {
    const t = topicOfProject(projects, mentioned[0]);
    if (t) return { topic: t, project: mentioned[0] };
  }
  if (isGeneral(threadId)) return { topic: team, project: null };
  return { topic: Number(threadId), project: projectOfTopic(projects, threadId) };
}

export { projectsMentioned, topicOfProject, projectOfTopic, isGeneral, correctTopic };
