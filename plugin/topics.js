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
    const re = p && p.strict
      ? new RegExp(`(?:\\bproject\\s*[:=]?\\s*\\**\\s*(?:${alt})\\b|#(?:${alt})\\b|\\b(?:${alt})\\s+(?:project|repo|monorepo|topic)\\b)`, "i")
      : new RegExp(`(?:^|[^a-z0-9_-])(?:${alt})(?:$|[^a-z0-9_-])`, "i");
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
function correctTopic({ threadId, text, projects, teamTopic }) {
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
