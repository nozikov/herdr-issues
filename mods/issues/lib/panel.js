// What the panel shows and where it comes from, apart from drawing it.
// Pure: no Node APIs; every effect comes in as an argument.
import { placeOf, repoOf, resolveGithub, chooseSource, defaultBranch } from "./project.js";
import { guessProjectKey } from "./setup.js";
import { parseLookup, isProjectKey } from "./jql.js";
import { panelMessage } from "./refresh.js";
import { pickAgent } from "./settings.js";
import { sanitize } from "./prompt.js";
import { homeFirst } from "./projects.js";
import { createGithubSource } from "../sources/github.js";
import { createJiraSource, validateSite } from "../sources/jira.js";

const PREVIEW = 4000;

export const EMPTY = { tasks: [], note: null, error: null };

// The panel's words for a source error. Only `other` shows the error's own (redacted) message.
// `canConnect`: the Connect button can put the missing token where the site reads it.
export function errorMessage(error, sourceId, canConnect = false) {
  if (error?.kind === "auth" && sourceId === "jira" && error.missing && canConnect)
    return { ...panelMessage("jiraAuth"), detail: "The token isn't in the keychain yet. Press Connect and paste it into the tab that opens." };
  if (error?.kind === "auth") return panelMessage(sourceId === "jira" ? "jiraAuth" : "ghAuth");
  if (error?.kind === "network") return panelMessage("network");
  return { ...panelMessage("other"), detail: String(error?.message ?? "") };
}

// `#123` looks up on GitHub and `PAY-431` on Jira. In the other tracker it's plain search text.
export function lookupKey(text, sourceId) {
  const key = parseLookup(text)?.key;
  if (!key || key.startsWith("#") !== (sourceId === "github")) return null;
  return key;
}

const asError = (e) => ({ kind: e?.kind ?? "other", message: String(e?.message ?? e), ...(e?.missing ? { missing: true } : {}) });

// { tasks, line? } or { error }. A lookup goes first and its task leads the list, which then runs
// without the key as search text. A task that doesn't exist is a line above the list, not a failure.
// The tasks of the `home` project lead the list.
export async function loadTasks(source, filters, home = "") {
  const key = lookupKey(filters.text, source.id);
  let exact = null;
  let line = null;
  if (key) {
    try {
      exact = await source.get(key);
    } catch (e) {
      if (e?.kind !== "notFound") return { error: asError(e) };
      line = `No task ${key}`;
    }
  }
  try {
    const listed = homeFirst(await source.list(key ? { ...filters, text: "" } : filters), home);
    const tasks = exact ? [exact, ...listed.filter((t) => t.key !== exact.key)] : listed;
    return line ? { tasks, line } : { tasks };
  } catch (e) {
    return { error: asError(e) };
  }
}

// The command that opens a tracker's URL, or null. The URL comes from the tracker, so only plain
// http(s) goes through. There may be no `URL` in the runtime.
export function browserArgv(platform, url) {
  if (!/^https?:\/\/[^\s]+$/i.test(String(url))) return null;
  const cmd = { macos: "open", linux: "xdg-open" }[platform];
  return cmd ? [cmd, url] : null;
}

// Tracker text as the row shows it: no control bytes, and short enough to draw.
export function bodyPreview(text) {
  const clean = sanitize(text).trim();
  return clean.length > PREVIEW ? `${clean.slice(0, PREVIEW)}…\n\nOpen in browser to read the rest.` : clean;
}

// Which side of the GitHub | Jira switch is on, "" with no project to set one for.
export function sideOf(context) {
  if (context?.state === "ready") return context.source.id;
  if (context?.state === "noRemote" || context?.state === "severalRemotes") return "github";
  return ["connect", "pickSite", "setup"].includes(context?.state) ? "jira" : "";
}

// Finds projects and their sources, remembering what is slow to ask.
export function createProjects({ exec, fetch }) {
  const repos = new Map(); // folder -> repo
  const githubs = new Map(); // main path -> resolveGithub's answer
  const jiras = new Map(); // site -> source; it holds the token in memory
  const guessed = new Set(); // repo and site pairs whose home project was guessed at
  let bin = null;

  // There is no process.env in the runtime.
  const ghBin = () => {
    bin ??= exec("sh", ["-c", 'printf %s "$HERDR_ISSUES_GH_BIN"'], {}).then((r) => r.stdout?.trim() || "gh", () => "gh");
    return bin;
  };

  async function repoFor(folder) {
    if (repos.has(folder)) return repos.get(folder);
    const repo = await repoOf(exec, folder);
    if (repo) repos.set(folder, repo); // a folder outside git may become a repo
    return repo;
  }

  async function githubFor(main) {
    if (!githubs.has(main)) githubs.set(main, await resolveGithub(exec, main, await ghBin()));
    return githubs.get(main);
  }

  function jiraFor(site) {
    const id = JSON.stringify(site);
    if (!jiras.has(id)) jiras.set(id, createJiraSource({ site, exec, fetch }));
    return jiras.get(id);
  }

  const guessId = (repo, site) => `${repo.main}\n${site.name}`;

  return {
    // Checks the machine before anything runs: nothing may run for a remote space.
    // state: noProject | remote | ready, noRemote (GitHub is asked for and there is none),
    // severalRemotes (which one isn't for this mod to guess), or what
    // a Jira project still needs: connect (a site), pickSite; setup is the gear form for a site
    // that can't be used.
    async contextOf(space, panes, settings) {
      if (!space) return { state: "noProject" };
      const spaceId = space.id;
      if (space.machine) return { state: "remote", spaceId };
      const folder = placeOf(space, panes);
      const repo = folder ? await repoFor(folder) : null;
      if (!repo) return { state: "noProject", spaceId };

      const entry = settings.projects[repo.main] ?? null;
      const base = { spaceId, repo, entry };
      const github = entry?.source === "jira" ? null : await githubFor(repo.main);
      if (github?.several) return { ...base, state: "severalRemotes" };
      const choice = chooseSource(entry, github);
      if (choice.kind === "github") {
        const { github } = choice;
        const source = createGithubSource({ exec, ghBin: await ghBin(), repoRef: github.repoRef, cwd: repo.main });
        return { ...base, state: "ready", github, source, sourceName: "GitHub", label: `${github.owner}/${github.name}` };
      }
      if (entry?.source === "github") return { ...base, state: "noRemote" };

      const { sites } = settings;
      if (!sites.length) return { ...base, state: "connect" };
      const named = sites.find((s) => s.name === entry?.site);
      const site = named ?? (sites.length === 1 ? sites[0] : null);
      if (!site) return { ...base, state: "pickSite" };
      if (validateSite(site)) return { ...base, state: "setup" };
      // A key only counts on its own site. A guess names no site, so it's on the only one there is.
      const own = named || (entry && !entry.site);
      const home = own && isProjectKey(entry.projectKey) ? entry.projectKey : "";
      const filter = named && isProjectKey(entry.filter) ? entry.filter : "";
      const homeSet = Boolean(own && entry.homeSet);
      return { ...base, state: "ready", github: null, site, source: jiraFor(site), sourceName: "Jira", label: site.name, home, filter, homeSet };
    },

    // The home project of a Jira project with none decided, once per repo and site: the key, or null.
    // `homeSet` comes first: it outlives this session, and "none" is a decision too.
    // It only orders the list, so nothing about it may reach the screen: a failure is no key.
    async guessHome({ repo, site, source, home, homeSet }) {
      if (homeSet || !site || home || guessed.has(guessId(repo, site))) return null;
      guessed.add(guessId(repo, site));
      return guessProjectKey(exec, repo.main, (k) => source.projectExists(k)).catch(() => null);
    },

    // Ids of the local spaces of this project, with `spaceId` always among them.
    async spaceIds(spaces, panes, main, spaceId) {
      const ids = new Set([spaceId]);
      for (const space of spaces) {
        if (space.machine) continue;
        const folder = placeOf(space, panes);
        if (folder && (await repoFor(folder))?.main === main) ids.add(space.id);
      }
      return ids;
    },

    // What ▶ needs to start new work: { agentArgv, remote, base } or { problem }.
    async plan(context, settings, agents) {
      const agent = pickAgent(agents, settings, context.entry);
      if (!agent) return { problem: "No agent is installed. Install one, or pick another in the settings." };
      const { repo, github } = context;
      let remote = github?.remote ?? null;
      if (!github) {
        const listed = await exec("git", ["remote"], { cwd: repo.main }).catch(() => null);
        const names = listed?.code === 0 ? listed.stdout.split("\n").map((n) => n.trim()).filter(Boolean) : [];
        remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null;
      }
      const ghInfo = github ? { bin: await ghBin(), repoRef: github.repoRef } : null;
      const base = await defaultBranch(exec, repo.main, remote ?? "origin", ghInfo);
      if (!base) return { problem: "Can't find the default branch of this repository." };
      return { agentArgv: agent.run, remote, base };
    },

    // The refresh button asks again about remotes; saved settings also drop the Jira sources.
    forget({ sources = false } = {}) {
      githubs.clear();
      if (sources) jiras.clear();
    },
  };
}
