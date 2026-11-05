import { sourceError, redact } from "./error.js";
import { safeMarkdown } from "../lib/markup.js";

const FIELDS = "number,title,body,labels,assignees,state,url,updatedAt";

function kindOf(stderr) {
  if (/Could not resolve to an Issue|HTTP 404|not found/i.test(stderr)) return "notFound";
  if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(stderr)) return "auth";
  if (/error connecting|timed? ?out|dial tcp|no such host|could not resolve host|network/i.test(stderr)) return "network";
  return "other";
}

function toTask(raw) {
  return {
    key: `#${raw.number}`,
    title: raw.title,
    url: raw.url,
    state: String(raw.state).toLowerCase(),
    assignee: raw.assignees?.[0]?.login ?? "",
    labels: (raw.labels ?? []).map((l) => l.name),
    updatedAt: raw.updatedAt,
    body: raw.body ?? "",
    markdown: safeMarkdown(raw.body),
    priority: "",
  };
}

// repoRef is `owner/repo`, or `host/owner/repo` off github.com.
export function createGithubSource({ exec, ghBin, repoRef, cwd }) {
  async function run(args) {
    let res;
    try {
      res = await exec(ghBin, args, { cwd });
    } catch (e) {
      const msg = redact(e?.message ?? e);
      throw sourceError(/took longer than 30 s/.test(msg) ? "network" : "other", msg);
    }
    if (res.code !== 0) {
      const stderr = redact(res.stderr).trim();
      throw sourceError(kindOf(stderr), stderr || `gh exited with code ${res.code}`);
    }
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw sourceError("other", "gh returned something that isn't JSON");
    }
  }

  return {
    id: "github",

    async list(filters) {
      const args = ["issue", "list", "-R", repoRef, "--limit", "100", "--json", FIELDS,
        "--state", filters.state === "all" ? "all" : "open"];
      if (filters.assignee === "me") args.push("--assignee", "@me");
      args.push(`--search=${["sort:updated-desc", filters.text].filter(Boolean).join(" ")}`);
      const raw = await run(args);
      return raw.map(toTask).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    },

    async get(key) {
      const m = /^#(\d+)$/.exec(key);
      if (!m) throw sourceError("notFound", `Not a GitHub issue key: ${key}`);
      return toTask(await run(["issue", "view", m[1], "-R", repoRef, "--json", FIELDS]));
    },

    async comments(key) {
      const m = /^#(\d+)$/.exec(key);
      if (!m) throw sourceError("notFound", `Not a GitHub issue key: ${key}`);
      const raw = await run(["issue", "view", m[1], "-R", repoRef, "--json", "comments"]);
      return (raw.comments ?? []).map((c) => ({ author: c.author?.login ?? "", created: c.createdAt ?? "", body: safeMarkdown(c.body) }));
    },
  };
}
