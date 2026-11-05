import { sourceError, redact } from "./error.js";
import { buildJql, isProjectKey } from "../lib/jql.js";
import { adfToText } from "../lib/adf.js";
import { adfToMarkdown, wikiToMarkdown, safeMarkdown } from "../lib/markup.js";

const FIELDS = "summary,description,status,assignee,labels,updated,priority";
const LIMIT = 100;
const COMMENTS = 50;
const MAX_PAGES = 5;
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const originOf = (url) => /^(https?:\/\/[^/?#]+)/i.exec(String(url))?.[1].toLowerCase() ?? null;

// btoa takes Latin-1 only, so turn the text into UTF-8 bytes first.
function base64Utf8(text) {
  return btoa(encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

// Returns the problem in words, or null when the site config is usable.
export function validateSite(site) {
  if (!site || typeof site !== "object") return "The Jira site is not configured";
  const url = String(site.url ?? "");
  if (/^http:\/\//i.test(url)) {
    if (!site.allowInsecure) return "An insecure http:// site would send the token in clear text; use https:// or set allowInsecure";
  } else if (!/^https:\/\//i.test(url)) {
    return "The site URL must start with https://";
  }
  // Settings hold no secrets, so a password in the address must not reach them.
  if (/^[a-z]+:\/\/[^/]*@/i.test(url)) return "The site address can't hold a user name or password";
  if (/[?#]/.test(url)) return "The site address can't hold ? or #: enter only the host and any path";
  if (site.type !== "cloud" && site.type !== "server") return 'The site type must be "cloud" or "server"';
  if (site.type === "cloud" && !site.email) return "A Jira Cloud site needs an email";
  if (!Array.isArray(site.tokenCommand) || site.tokenCommand.length === 0 || !site.tokenCommand.every((a) => typeof a === "string")) {
    return "The site needs a tokenCommand: a non-empty list of strings";
  }
  return null;
}

export function createJiraSource({ site, exec, fetch }) {
  const problem = validateSite(site);
  if (problem) {
    const refuse = async () => { throw sourceError("other", problem); };
    return { id: "jira", list: refuse, get: refuse, comments: refuse, projectExists: refuse };
  }
  const base = site.url.replace(/\/+$/, "");
  const origin = originOf(base);
  const cloud = site.type === "cloud";
  const api = `${base}/rest/api/${cloud ? 3 : 2}`;

  let token = null; // the token in use, until Jira refuses it
  let verified = false; // /myself has accepted `token`

  // Cloud's v3 gives ADF, Server's v2 gives wiki markup.
  const readable = (text) => safeMarkdown(cloud ? adfToMarkdown(text) : wikiToMarkdown(text));

  function toTask(raw) {
    const f = raw.fields ?? {};
    return {
      key: raw.key,
      title: f.summary ?? "",
      url: `${base}/browse/${raw.key}`,
      state: f.status?.name ?? "",
      assignee: f.assignee?.displayName ?? "",
      labels: f.labels ?? [],
      updatedAt: f.updated ?? "",
      body: cloud ? adfToText(f.description) : f.description ?? "",
      markdown: readable(f.description),
      priority: f.priority?.name ?? "",
    };
  }

  // There is no token to try yet, which is different from Jira refusing one.
  const noToken = (message) => Object.assign(sourceError("auth", message), { missing: true });

  async function readToken() {
    if (token) return token;
    const [cmd, ...args] = site.tokenCommand;
    let res;
    try {
      res = await exec(cmd, args);
    } catch (e) {
      // Fixed words: the message of a failed start holds the command, which may be a pasted token.
      throw sourceError(/took longer than 30 s/.test(String(e?.message ?? e)) ? "network" : "auth", "The token command could not run");
    }
    // stderr stays unread: a failing command may print the secret.
    if (res.code !== 0) throw noToken(`The token command failed with code ${res.code}`);
    const value = String(res.stdout).trim();
    if (!value) throw noToken("The token command printed nothing");
    token = value;
    return token;
  }

  function forget() {
    token = null;
    verified = false;
  }

  function headers(secret) {
    return {
      Accept: "application/json",
      Authorization: cloud ? `Basic ${base64Utf8(`${site.email}:${secret}`)}` : `Bearer ${secret}`,
    };
  }

  async function send(url, secret) {
    let res;
    const hide = [secret, cloud ? base64Utf8(`${site.email}:${secret}`) : null];
    try {
      res = await fetch(url, { method: "GET", headers: headers(secret) });
    } catch (e) {
      const msg = redact(e?.message ?? e, hide);
      if (/cross-origin redirect/i.test(msg)) throw sourceError("other", "The Jira site redirected to another host");
      throw sourceError("network", msg);
    }
    if (res.url && originOf(res.url) !== origin) {
      throw sourceError("other", "The reply came from a different host than the Jira site");
    }
    if (res.status === 401 || res.status === 403) {
      forget();
      throw sourceError("auth", `Jira refused the credentials (HTTP ${res.status})`);
    }
    if (res.status === 404) throw sourceError("notFound", "Jira has no such resource (HTTP 404)");
    if (!res.ok) throw sourceError("other", `Jira answered with HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw sourceError("other", "Jira returned something that isn't JSON (a login page?)");
    }
    if (!data || typeof data !== "object") throw sourceError("other", "Jira returned an unexpected reply");
    return data;
  }

  // Checks the token against /myself once. Resolves the token.
  async function verify() {
    const secret = await readToken();
    if (!verified) {
      await send(`${api}/myself`, secret);
      verified = true;
    }
    return secret;
  }

  async function request(path) {
    return send(`${api}${path}`, await verify());
  }

  const enc = encodeURIComponent;

  return {
    id: "jira",

    async list(filters) {
      let jql;
      try {
        jql = buildJql(filters);
      } catch (e) {
        throw sourceError("other", e.message);
      }
      const q = `jql=${enc(jql)}&fields=${enc(FIELDS)}&maxResults=${LIMIT}`;
      const issuesOf = (page) => {
        if (!Array.isArray(page.issues)) throw sourceError("other", "Jira returned an unexpected reply");
        return page.issues.map(toTask);
      };
      const tasks = [];
      if (cloud) {
        const seen = new Set();
        let pageToken = null;
        for (let pages = 0; pages < MAX_PAGES; pages++) {
          const page = await request(`/search/jql?${q}` + (pageToken ? `&nextPageToken=${enc(pageToken)}` : ""));
          const found = issuesOf(page);
          tasks.push(...found);
          pageToken = page.nextPageToken ?? null;
          if (!found.length || !pageToken || seen.has(pageToken) || tasks.length >= LIMIT) break;
          seen.add(pageToken);
        }
      } else {
        tasks.push(...issuesOf(await request(`/search?${q}`)));
      }
      return tasks.slice(0, LIMIT);
    },

    async get(key) {
      if (!KEY.test(key)) throw sourceError("notFound", `Not a Jira issue key: ${key}`);
      const raw = await request(`/issue/${key}?fields=${enc(FIELDS)}`);
      if (typeof raw.key !== "string") throw sourceError("other", "Jira returned an unexpected reply");
      return toTask(raw);
    },

    // The newest ones, oldest first. `key` is checked before it reaches the URL.
    async comments(key) {
      if (!KEY.test(key)) throw sourceError("notFound", `Not a Jira issue key: ${key}`);
      const reply = await request(`/issue/${key}/comment?orderBy=-created&maxResults=${COMMENTS}`);
      if (!Array.isArray(reply.comments)) throw sourceError("other", "Jira returned an unexpected reply");
      return reply.comments.map((c) => ({ author: c.author?.displayName ?? "", created: c.created ?? "", body: readable(c.body) })).reverse();
    },

    // Only the project's own 404 means no: a 404 from /myself means this is no Jira API.
    async projectExists(key) {
      if (!isProjectKey(key)) return false;
      const secret = await verify();
      try {
        await send(`${api}/project/${key}`, secret);
        return true;
      } catch (e) {
        if (e.kind === "notFound") return false;
        throw e;
      }
    },
  };
}
