// Settings kept in localStorage. They hold no secrets: only the command that prints a token.
// Pure: no Node APIs, the Herdr runtime has none.
import { DEFAULT_TEMPLATE } from "./prompt.js";
import { isProjectKey } from "./jql.js";

const KEY = "issues.settings";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);

function cleanSite(s) {
  if (!isObject(s)) return null;
  return {
    name: str(s.name),
    url: str(s.url),
    type: s.type === "server" ? "server" : "cloud",
    email: str(s.email),
    tokenCommand: Array.isArray(s.tokenCommand) ? s.tokenCommand.filter((a) => typeof a === "string") : [],
    allowInsecure: s.allowInsecure === true,
  };
}

function cleanProject(p) {
  if (!isObject(p)) return null;
  return {
    source: str(p.source),
    site: str(p.site),
    projectKey: str(p.projectKey), // the home project
    filter: isProjectKey(p.filter) ? p.filter : "", // "" is All
    homeSet: p.homeSet === true || isProjectKey(p.projectKey), // decided, also as "none": no more guessing
    agent: str(p.agent),
    setupCommand: str(p.setupCommand),
  };
}

// Keeps only the known fields, so a stray `token` can never be stored or loaded.
function clean(raw) {
  const r = isObject(raw) ? raw : {};
  const projects = {};
  if (isObject(r.projects)) {
    for (const [path, p] of Object.entries(r.projects)) {
      const c = cleanProject(p);
      if (c) projects[path] = c;
    }
  }
  return {
    defaultAgent: typeof r.defaultAgent === "string" && r.defaultAgent ? r.defaultAgent : null,
    template: typeof r.template === "string" ? r.template : DEFAULT_TEMPLATE,
    askOtherProject: r.askOtherProject !== false,
    sites: Array.isArray(r.sites) ? r.sites.map(cleanSite).filter(Boolean) : [],
    projects,
  };
}

export function loadSettings(storage) {
  let raw = null;
  try {
    const text = storage.getItem(KEY);
    if (typeof text === "string") raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  return clean(raw);
}

export function saveSettings(storage, settings) {
  storage.setItem(KEY, JSON.stringify(clean(settings)));
}

// Project override, then the global default, then Claude Code, then the first installed.
// An agent that is not installed is never picked.
export function pickAgent(agents, settings, entry) {
  const usable = (key) => (key ? agents.find((a) => a.key === key && a.installed) : undefined);
  const found = usable(entry?.agent) ?? usable(settings?.defaultAgent) ?? usable("claude") ?? agents.find((a) => a.installed);
  return found ? { key: found.key, run: found.run } : null;
}

// Splits on whitespace; single and double quotes group words, and are removed.
export function parseArgv(text) {
  const out = [];
  let cur = "";
  let started = false;
  let quote = null;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}
