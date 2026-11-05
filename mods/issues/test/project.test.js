import test from "node:test";
import assert from "node:assert/strict";
import { realpath, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemote, placeOf, repoOf, resolveGithub, chooseSource, defaultBranch } from "../lib/project.js";
import { createProjects } from "../lib/panel.js";
import { panelMessage } from "../lib/refresh.js";
import { nodeExec, tempRepo } from "./_util.js";

// Real git, scripted gh: `gh` answers from the table, everything else runs for real.
// gh = { setDefault: stdout or undefined (exit 1), authed: [hosts], view: default branch name }
function withGh(gh = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    if (cmd !== "gh") return nodeExec(cmd, args, opts);
    calls.push(args);
    if (args[0] === "repo" && args[1] === "set-default")
      return gh.setDefault ? { code: 0, stdout: gh.setDefault + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "no default" };
    if (args[0] === "auth") return { code: (gh.authed ?? []).includes(args[3]) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "repo" && args[1] === "view")
      return gh.view ? { code: 0, stdout: gh.view + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

async function repoWith(remotes) {
  const repo = await tempRepo();
  for (const [name, url] of Object.entries(remotes)) await repo.git("remote", "add", name, url);
  return repo;
}

test("parseRemote", () => {
  for (const url of ["git@github.com:o/r.git", "https://github.com/o/r", "https://github.com/o/r.git/",
                     "ssh://git@github.com/o/r.git"])
    assert.deepEqual(parseRemote(url), { host: "github.com", owner: "o", name: "r" });
  assert.equal(parseRemote("/local/path"), null);
  assert.equal(parseRemote("https://github.com/only-owner"), null);
  assert.deepEqual(parseRemote("ssh://git@ghe.corp:2222/o/r.git"), { host: "ghe.corp", owner: "o", name: "r" });
});

test("placeOf: first terminal's folder, else the space's", () => {
  const s = { folder: "/f", tabs: [{ id: "a" }] };
  assert.equal(placeOf(s, [{ tab: "b", cwd: "/x" }, { tab: "a", cwd: "/y" }]), "/y");
  assert.equal(placeOf(s, []), "/f");
  assert.equal(placeOf(s, [{ tab: "a", cwd: "" }]), "/f");
  assert.equal(placeOf(null, []), null);
});

test("a linked worktree counts as its repo", async () => {
  const repo = await tempRepo();
  const wt = repo.dir + "-wt";
  assert.equal((await repo.git("worktree", "add", wt, "-b", "x")).code, 0);
  const r = await repoOf(nodeExec, wt);
  assert.equal(r.main, await realpath(repo.dir));
  assert.equal(r.linked, true);
  const m = await repoOf(nodeExec, repo.dir);
  assert.equal(m.main, repo.dir);
  assert.equal(m.linked, false);
});

test("outside git is null", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "issues-nogit-")));
  assert.equal(await repoOf(nodeExec, dir), null);
});

test("a program that can't start is null, not a crash", async () => {
  const boom = async () => { throw new Error("timeout"); };
  assert.equal(await repoOf(boom, "/x"), null);
  assert.equal(await resolveGithub(boom, "/x", "gh"), null);
  assert.equal(await defaultBranch(boom, "/x", "origin"), null);
});

test("set-default wins over origin, with the remote pointing at it", async () => {
  const { dir } = await repoWith({ origin: "git@github.com:me/r.git", upstream: "https://github.com/up/r.git" });
  const { exec } = withGh({ setDefault: "up/r" });
  assert.deepEqual(await resolveGithub(exec, dir, "gh"),
    { host: "github.com", owner: "up", name: "r", remote: "upstream", repoRef: "up/r" });
});

test("no set-default falls back to origin", async () => {
  const { dir } = await repoWith({ upstream: "https://github.com/up/r.git", origin: "git@github.com:me/r.git" });
  const { exec } = withGh();
  assert.deepEqual(await resolveGithub(exec, dir, "gh"),
    { host: "github.com", owner: "me", name: "r", remote: "origin", repoRef: "me/r" });
});

test("a repo with no usable remote is null", async () => {
  const { dir } = await repoWith({});
  assert.equal(await resolveGithub(withGh().exec, dir, "gh"), null);
  const local = await repoWith({ origin: "/some/local/path" });
  assert.equal(await resolveGithub(withGh().exec, local.dir, "gh"), null);
});

test("an Enterprise host goes through to the repo reference", async () => {
  const { dir } = await repoWith({ origin: "git@ghe.corp:o/r.git" });
  const { exec, calls } = withGh({ authed: ["ghe.corp"] });
  assert.deepEqual(await resolveGithub(exec, dir, "gh"),
    { host: "ghe.corp", owner: "o", name: "r", remote: "origin", repoRef: "ghe.corp/o/r" });
  assert.deepEqual(calls.find((a) => a[0] === "auth"), ["auth", "status", "--hostname", "ghe.corp"]);
});

test("a host gh isn't logged in to, off github.com, is not GitHub", async () => {
  const { dir } = await repoWith({ origin: "git@gitlab.example:o/r.git" });
  assert.equal(await resolveGithub(withGh({ authed: [] }).exec, dir, "gh"), null);
});

test("github.com is not asked about", async () => {
  const { dir } = await repoWith({ origin: "git@github.com:o/r.git" });
  const { exec, calls } = withGh();
  await resolveGithub(exec, dir, "gh");
  assert.equal(calls.some((a) => a[0] === "auth"), false);
});

test("chooseSource", () => {
  const gh = { host: "github.com", owner: "o", name: "r", remote: "origin", repoRef: "o/r" };
  assert.equal(chooseSource(undefined, gh).kind, "github");
  assert.equal(chooseSource(undefined, null).kind, "setup");
  const jira = { source: "jira", site: "s", projectKey: "PAY" };
  assert.equal(chooseSource(jira, gh).kind, "jira");
  assert.equal(chooseSource(jira, null).kind, "jira");
  assert.deepEqual(chooseSource(jira, null).entry, jira);
  // The switch says Jira: a site with no home project, or no site yet, is still Jira.
  assert.equal(chooseSource({ source: "jira", site: "s" }, null).kind, "jira");
  assert.equal(chooseSource({ source: "jira", site: "s", projectKey: "" }, gh).kind, "jira");
  assert.equal(chooseSource({ source: "jira", site: "" }, gh).kind, "jira");
  assert.equal(chooseSource({ source: "github", site: "s", projectKey: "DEMO" }, gh).kind, "github");
});

test("defaultBranch reads the remote's HEAD, then gh, then main/master", async () => {
  // 1: the remote's HEAD
  const a = await repoWith({ origin: "git@github.com:o/r.git" });
  await a.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.equal(await defaultBranch(withGh({ view: "other" }).exec, a.dir, "origin", { bin: "gh", repoRef: "o/r" }), "trunk");
  // 2: gh
  const b = await repoWith({ origin: "git@github.com:o/r.git" });
  const gh = withGh({ view: "develop" });
  assert.equal(await defaultBranch(gh.exec, b.dir, "origin", { bin: "gh", repoRef: "o/r" }), "develop");
  assert.deepEqual(gh.calls[0], ["repo", "view", "-R", "o/r", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
  // 3: the local main, then master
  assert.equal(await defaultBranch(withGh().exec, b.dir, "origin"), "main");
  await b.git("branch", "-m", "main", "master");
  assert.equal(await defaultBranch(withGh().exec, b.dir, "origin"), "master");
  // none of them
  await b.git("branch", "-m", "master", "odd");
  assert.equal(await defaultBranch(withGh().exec, b.dir, "origin"), null);
});

const agent = { key: "claude", installed: true, run: ["claude"] };
const noSettings = { sites: [], projects: {}, defaultAgent: null, template: "" };
const contextIn = (repo, exec, settings = noSettings) => createProjects({ exec, fetch: async () => assert.fail("no request") })
  .contextOf({ id: "S", machine: null, folder: repo.dir, tabs: [] }, [], settings);

test("a single GitHub remote counts, whatever its name", async () => {
  const repo = await repoWith({ upstream: "git@github.com:o/r.git" });
  const { exec } = withGh({ view: "main" });
  assert.equal((await resolveGithub(exec, repo.dir, "gh")).remote, "upstream");
  const c = await contextIn(repo, exec);
  assert.equal(c.state, "ready");
  assert.equal(c.github.repoRef, "o/r");
  const plan = await createProjects({ exec, fetch }).plan(c, noSettings, [agent]);
  assert.equal(plan.remote, "upstream");
});

test("an origin on a host gh can't use doesn't hide the one GitHub remote", async () => {
  const repo = await repoWith({ origin: "git@git.example.com:o/r.git", mirror: "https://github.com/o/r.git" });
  assert.equal((await resolveGithub(withGh().exec, repo.dir, "gh")).remote, "mirror");
});

test("origin still comes first, and set-default before it", async () => {
  const repo = await repoWith({ origin: "git@github.com:o/r.git", fork: "git@github.com:me/r.git" });
  assert.equal((await resolveGithub(withGh().exec, repo.dir, "gh")).remote, "origin");
  assert.equal((await resolveGithub(withGh({ setDefault: "me/r" }).exec, repo.dir, "gh")).remote, "fork");
});

test("several GitHub remotes and no origin aren't guessed, and the panel says so", async () => {
  const repo = await repoWith({ one: "git@github.com:o/r.git", two: "git@github.com:me/r.git" });
  const { exec } = withGh();
  assert.deepEqual(await resolveGithub(exec, repo.dir, "gh"), { several: true });
  const c = await contextIn(repo, exec);
  assert.equal(c.state, "severalRemotes");
  assert.equal(c.source, undefined);
  const m = panelMessage("severalRemotes");
  assert.match(m.detail, /^gh repo set-default/);
  assert.doesNotMatch(JSON.stringify(m), /no github\.com remote/);
});

test("set-default settles several remotes", async () => {
  const repo = await repoWith({ one: "git@github.com:o/r.git", two: "git@github.com:me/r.git" });
  assert.equal((await resolveGithub(withGh({ setDefault: "me/r" }).exec, repo.dir, "gh")).remote, "two");
});

test("no GitHub remote at all is still none", async () => {
  const repo = await repoWith({ origin: "git@git.example.com:o/r.git" });
  assert.equal(await resolveGithub(withGh().exec, repo.dir, "gh"), null);
});

test("a Jira project with one remote of another name fetches from it", async () => {
  const repo = await repoWith({ upstream: "git@git.example.com:o/r.git" });
  const { exec } = withGh();
  const plan = await createProjects({ exec, fetch }).plan({ repo: { main: repo.dir }, entry: null, github: null }, noSettings, [agent]);
  assert.equal(plan.remote, "upstream");
});

test("a Jira project with several remotes and no origin picks none", async () => {
  const repo = await repoWith({ one: "git@git.example.com:o/r.git", two: "git@git.example.com:p/r.git" });
  const { exec } = withGh();
  const plan = await createProjects({ exec, fetch }).plan({ repo: { main: repo.dir }, entry: null, github: null }, noSettings, [agent]);
  assert.equal(plan.remote, null);
});
