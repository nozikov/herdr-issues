import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, lookupKey, loadTasks, browserArgv, bodyPreview, createProjects, sideOf } from "../lib/panel.js";
import { panelMessage } from "../lib/refresh.js";
import { sourceError } from "../sources/error.js";

test("error kinds map to panel states", () => {
  assert.deepEqual(errorMessage({ kind: "auth" }, "github"), panelMessage("ghAuth"));
  assert.deepEqual(errorMessage({ kind: "auth" }, "jira"), panelMessage("jiraAuth"));
  assert.deepEqual(errorMessage({ kind: "network" }, "jira"), panelMessage("network"));
  const other = errorMessage({ kind: "other", message: "gh: boom" }, "github");
  assert.equal(other.title, panelMessage("other").title);
  assert.equal(other.detail, "gh: boom");
});

test("a token not in the keychain points at Connect, only when Connect can help", () => {
  const missing = { kind: "auth", message: "x", missing: true };
  assert.match(errorMessage(missing, "jira", true).detail, /Connect/);
  assert.equal(errorMessage(missing, "jira", true).title, panelMessage("jiraAuth").title);
  assert.equal(errorMessage(missing, "jira", false).detail, undefined);
  assert.equal(errorMessage({ kind: "auth", message: "401" }, "jira", true).detail, undefined);
});

test("a key looks up only in its own tracker", () => {
  assert.equal(lookupKey("#12", "github"), "#12");
  assert.equal(lookupKey("pay-4", "jira"), "PAY-4");
  assert.equal(lookupKey("pay-4", "github"), null);
  assert.equal(lookupKey("#12", "jira"), null);
  assert.equal(lookupKey("fix login", "github"), null);
});

const fake = (over = {}) => {
  const calls = [];
  return {
    calls,
    id: "github",
    async get(key) { calls.push(["get", key]); return { key, title: "exact" }; },
    async list(filters) { calls.push(["list", filters]); return [{ key: "#1" }, { key: "#12" }]; },
    ...over,
  };
};
const filters = { assignee: "me", state: "open", text: "" };

test("plain search goes to the list", async () => {
  const s = fake();
  const r = await loadTasks(s, { ...filters, text: "login" });
  assert.deepEqual(r, { tasks: [{ key: "#1" }, { key: "#12" }] });
  assert.deepEqual(s.calls, [["list", { ...filters, text: "login" }]]);
});

test("a lookup leads the list once, and the key isn't searched as text", async () => {
  const s = fake();
  const r = await loadTasks(s, { ...filters, text: "#12" });
  assert.deepEqual(r.tasks.map((t) => t.key), ["#12", "#1"]);
  assert.deepEqual(s.calls[1], ["list", filters]);
});

test("home project tasks come first, and a lookup stays above them", async () => {
  const jira = fake({ id: "jira", async list() { return [{ key: "ZED-1" }, { key: "PAY-2" }]; } });
  assert.deepEqual((await loadTasks(jira, filters, "PAY")).tasks.map((t) => t.key), ["PAY-2", "ZED-1"]);
  const exact = await loadTasks(jira, { ...filters, text: "ABC-9" }, "PAY");
  assert.deepEqual(exact.tasks.map((t) => t.key), ["ABC-9", "PAY-2", "ZED-1"]);
});

test("a lookup keeps the picked project on the list under it", async () => {
  const s = fake({ id: "jira" });
  await loadTasks(s, { ...filters, project: "PAY", text: "ABC-9" });
  assert.deepEqual(s.calls[1], ["list", { ...filters, project: "PAY" }]);
});

test("a key that doesn't exist is a line, and the list still shows", async () => {
  const s = fake({ async get() { throw sourceError("notFound", "no"); } });
  const r = await loadTasks(s, { ...filters, text: "#99" });
  assert.equal(r.line, "No task #99");
  assert.equal(r.tasks.length, 2);
});

test("any other failure of a lookup or a list is an error", async () => {
  const auth = fake({ async get() { throw sourceError("auth", "401"); } });
  assert.deepEqual(await loadTasks(auth, { ...filters, text: "#1" }), { error: { kind: "auth", message: "401" } });
  const down = fake({ async list() { throw sourceError("network", "x"); } });
  assert.deepEqual(await loadTasks(down, filters), { error: { kind: "network", message: "x" } });
  const odd = fake({ async list() { throw new Error("odd"); } });
  assert.deepEqual(await loadTasks(odd, filters), { error: { kind: "other", message: "odd" } });
});

test("a missing token stays marked on the way to the panel", async () => {
  const s = fake({ async list() { throw Object.assign(sourceError("auth", "no token"), { missing: true }); } });
  assert.equal((await loadTasks(s, filters)).error.missing, true);
});

test("only http(s) URLs reach the browser", () => {
  assert.deepEqual(browserArgv("macos", "https://x.test/1"), ["open", "https://x.test/1"]);
  assert.deepEqual(browserArgv("linux", "http://x.test/1"), ["xdg-open", "http://x.test/1"]);
  assert.equal(browserArgv("macos", "file:///etc/passwd"), null);
  assert.equal(browserArgv("macos", "-a Calculator"), null);
  assert.equal(browserArgv("macos", "https://x.test/1 --evil"), null);
  assert.equal(browserArgv("macos", undefined), null);
  assert.equal(browserArgv("windows", "https://x.test/1"), null);
});

test("body preview drops control bytes and cuts long text", () => {
  assert.equal(bodyPreview("a\x1b[31mb\x07  \n"), "ab");
  const long = bodyPreview("x".repeat(5000));
  assert.ok(long.length < 4100);
  assert.match(long, /Open in browser/);
});

// A fake machine: answers by the command line, and logs each call.
function machine(answers) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    for (const [pattern, stdout] of answers) if (pattern.test(line)) return stdout === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout, stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return { exec, calls };
}
const gitRepo = [
  [/--show-toplevel/, "/w/app\n"],
  [/--git-common-dir/, "/w/app/.git\n"],
];
const githubRemote = [[/^git remote -v/, "origin\tgit@github.com:o/app.git (fetch)\n"]];
const noSettings = { sites: [], projects: {}, defaultAgent: null, template: "" };
const space = { id: "S", machine: null, folder: "/w/app", tabs: [] };
const site = { name: "work", url: "https://j.test", type: "server", email: "", tokenCommand: ["t"], allowInsecure: false };
const jiraEntry = { source: "jira", site: "work", projectKey: "PAY", agent: "", setupCommand: "" };

test("a remote space runs nothing", async () => {
  const m = machine([]);
  const p = createProjects({ exec: m.exec, fetch });
  assert.deepEqual(await p.contextOf({ ...space, machine: "box" }, [], noSettings), { state: "remote", spaceId: "S" });
  assert.deepEqual(m.calls, []);
});

test("no space or no repo means no project", async () => {
  const p = createProjects({ exec: machine([]).exec, fetch });
  assert.equal((await p.contextOf(undefined, [], noSettings)).state, "noProject");
  assert.equal((await p.contextOf(space, [], noSettings)).state, "noProject");
});

test("a GitHub repo works with no setup, and is asked about only once", async () => {
  const m = machine([...gitRepo, ...githubRemote]);
  const p = createProjects({ exec: m.exec, fetch });
  const c = await p.contextOf(space, [], noSettings);
  assert.equal(c.state, "ready");
  assert.equal(c.sourceName, "GitHub");
  assert.equal(c.label, "o/app");
  assert.equal(c.source.id, "github");
  const count = m.calls.length;
  await p.contextOf(space, [], noSettings);
  assert.equal(m.calls.length, count);
  p.forget();
  await p.contextOf(space, [], noSettings);
  assert.ok(m.calls.filter((l) => l.startsWith("git remote -v")).length === 2);
  assert.equal(m.calls.filter((l) => l.includes("HERDR_ISSUES_GH_BIN")).length, 1);
});

test("HERDR_ISSUES_GH_BIN replaces gh", async () => {
  const m = machine([...gitRepo, ...githubRemote, [/HERDR_ISSUES_GH_BIN/, "/opt/gh"]]);
  await createProjects({ exec: m.exec, fetch }).contextOf(space, [], noSettings);
  assert.ok(m.calls.some((l) => l.startsWith("/opt/gh repo set-default")));
});

test("no GitHub remote, no entry, no site: the connect form", async () => {
  const c = await createProjects({ exec: machine(gitRepo).exec, fetch }).contextOf(space, [], noSettings);
  assert.equal(c.state, "connect");
  assert.equal(c.repo.main, "/w/app");
});

test("a GitHub repo with no entry makes no Jira call, even with a site connected", async () => {
  const m = machine([...gitRepo, ...githubRemote]);
  const noFetch = async () => assert.fail("fetched");
  const c = await createProjects({ exec: m.exec, fetch: noFetch }).contextOf(space, [], { ...noSettings, sites: [site] });
  assert.equal(c.sourceName, "GitHub");
  assert.ok(!m.calls.some((l) => l.includes("for-each-ref")));
});

test("a project set to GitHub with no such remote stays on GitHub and says so", async () => {
  const settings = { ...noSettings, sites: [site], projects: { "/w/app": { ...jiraEntry, source: "github", site: site.name } } };
  const c = await createProjects({ exec: machine(gitRepo).exec, fetch }).contextOf(space, [], settings);
  assert.equal(c.state, "noRemote");
  assert.equal(c.repo.main, "/w/app");
  assert.equal(c.source, undefined);
});

test("the side of the switch", () => {
  assert.equal(sideOf({ state: "ready", source: { id: "github" } }), "github");
  assert.equal(sideOf({ state: "ready", source: { id: "jira" } }), "jira");
  assert.equal(sideOf({ state: "noRemote" }), "github");
  assert.equal(sideOf({ state: "severalRemotes" }), "github");
  assert.equal(sideOf({ state: "connect" }), "jira");
  assert.equal(sideOf({ state: "pickSite" }), "jira");
  assert.equal(sideOf({ state: "setup" }), "jira");
  assert.equal(sideOf({ state: "noProject" }), "");
  assert.equal(sideOf(null), "");
});

test("no remote: the message names the command", () => {
  const m = panelMessage("noRemote");
  assert.match(m.title, /GitHub/);
  assert.match(m.detail, /^git remote add origin /);
});

test("no entry and one site: that site is used, and the tasks show at once", async () => {
  const c = await createProjects({ exec: machine(gitRepo).exec, fetch }).contextOf(space, [], { ...noSettings, sites: [site] });
  assert.equal(c.state, "ready");
  assert.equal(c.site, site);
  assert.equal(c.source.id, "jira");
  assert.equal(c.home, "");
  assert.equal(c.filter, "");
});

test("no entry and several sites: asks which, and remembers the answer", async () => {
  const p = createProjects({ exec: machine(gitRepo).exec, fetch });
  const sites = [site, { ...site, name: "two" }];
  assert.equal((await p.contextOf(space, [], { ...noSettings, sites })).state, "pickSite");
  const picked = { ...noSettings, sites, projects: { "/w/app": { ...jiraEntry, site: "two", projectKey: "" } } };
  const c = await p.contextOf(space, [], picked);
  assert.equal(c.state, "ready");
  assert.equal(c.site.name, "two");
});

const lookFor = (branches, status) => {
  const m = machine([...gitRepo, [/for-each-ref/, branches], [/^t$/, "tok\n"]]);
  const requests = [];
  const fetchFake = async (url) => {
    requests.push(url);
    const code = /\/myself/.test(url) ? 200 : status(url);
    return { status: code, ok: code < 400, json: async () => ({}) };
  };
  return { m, requests, p: createProjects({ exec: m.exec, fetch: fetchFake }) };
};
const oneSite = { ...noSettings, sites: [site] };

test("the guess gives the key the site confirms", async () => {
  const { p } = lookFor("UTF-8-fix\nABC-1\n", (url) => (/project\/ABC$/.test(url) ? 200 : 404));
  assert.equal(await p.guessHome(await p.contextOf(space, [], oneSite)), "ABC");
});

test("the guess runs once per repo and site, whatever came of it", async () => {
  const { p, m } = lookFor("UTF-8-fix\n", () => 404);
  const context = await p.contextOf(space, [], oneSite);
  assert.equal(await p.guessHome(context), null);
  assert.equal(await p.guessHome(context), null);
  p.forget({ sources: true });
  assert.equal(await p.guessHome(context), null);
  assert.equal(m.calls.filter((l) => l.includes("for-each-ref")).length, 1);
  await p.guessHome({ ...context, site: { ...site, name: "two" } });
  assert.equal(m.calls.filter((l) => l.includes("for-each-ref")).length, 2);
});

test("a cleared home project isn't guessed again, also after a restart", async () => {
  const settings = { ...oneSite, projects: { "/w/app": { ...jiraEntry, projectKey: "", homeSet: true } } };
  const { p, m, requests } = lookFor("ABC-1\n", () => 200); // a fresh createProjects is a restart
  const context = await p.contextOf(space, [], settings);
  assert.equal(context.homeSet, true);
  assert.equal(await p.guessHome(context), null);
  assert.ok(!m.calls.some((l) => l.includes("for-each-ref")));
  assert.equal(requests.length, 0);
});

test("a new repo is still guessed once", async () => {
  const { p, m } = lookFor("ABC-1\n", () => 200);
  const context = await p.contextOf(space, [], oneSite);
  assert.equal(context.homeSet, false);
  assert.equal(await p.guessHome(context), "ABC");
  assert.equal(m.calls.filter((l) => l.includes("for-each-ref")).length, 1);
});

test("a decision made on a site that's gone doesn't count on the next one", async () => {
  const settings = { ...oneSite, projects: { "/w/app": { ...jiraEntry, site: "gone", projectKey: "", homeSet: true } } };
  const { p } = lookFor("ABC-1\n", () => 200);
  assert.equal((await p.contextOf(space, [], settings)).homeSet, false);
});

test("two refreshes at once make one guess", async () => {
  const { p, m } = lookFor("ABC-1\n", () => 200);
  const context = await p.contextOf(space, [], oneSite);
  await Promise.all([p.guessHome(context), p.guessHome(context)]);
  assert.equal(m.calls.filter((l) => l.includes("for-each-ref")).length, 1);
});

test("a guess made with no site named counts on the only site, and only there", async () => {
  const guessed = { source: "", site: "", projectKey: "DEMO", homeSet: true, agent: "", setupCommand: "" };
  const settings = { ...noSettings, sites: [site], projects: { "/w/app": guessed } };
  const c = await createProjects({ exec: machine(gitRepo).exec, fetch }).contextOf(space, [], settings);
  assert.equal(c.home, "DEMO");
  assert.equal(c.homeSet, true);
  const named = { ...settings, projects: { "/w/app": { ...guessed, site: "gone" } } };
  assert.equal((await createProjects({ exec: machine(gitRepo).exec, fetch }).contextOf(space, [], named)).home, "");
});

test("a failed guess is no key, and no error", async () => {
  const denied = createProjects({
    exec: machine([...gitRepo, [/for-each-ref/, "ABC-1\n"]]).exec,
    fetch: async () => assert.fail("no token, no request"),
  });
  assert.equal(await denied.guessHome(await denied.contextOf(space, [], oneSite)), null);
});

test("a project with a home, or on GitHub, guesses nothing", async () => {
  const { p, m, requests } = lookFor("ABC-1\n", () => 200);
  assert.equal(await p.guessHome({ repo: { main: "/w/app" }, site, source: {}, home: "PAY" }), null);
  assert.equal(await p.guessHome({ repo: { main: "/w/app" }, github: {} }), null);
  assert.ok(!m.calls.some((l) => l.includes("for-each-ref")));
  assert.equal(requests.length, 0);
});

test("a project whose site is gone doesn't keep its key on another site", async () => {
  const p = createProjects({ exec: machine(gitRepo).exec, fetch });
  const gone = { ...jiraEntry, site: "gone", filter: "OPS" };
  const onlyOther = await p.contextOf(space, [], { ...noSettings, sites: [site], projects: { "/w/app": gone } });
  assert.equal(onlyOther.state, "ready");
  assert.equal(onlyOther.site, site);
  assert.equal(onlyOther.home, "");
  assert.equal(onlyOther.filter, "");
  const several = await p.contextOf(space, [], { ...noSettings, sites: [site, { ...site, name: "two" }], projects: { "/w/app": gone } });
  assert.equal(several.state, "pickSite");
});

test("a site failing validateSite gets no token command and no request", async () => {
  const m = machine(gitRepo);
  const p = createProjects({ exec: m.exec, fetch: async () => assert.fail("fetched") });
  const c = await p.contextOf(space, [], { ...noSettings, sites: [{ ...site, url: "http://j.test" }] });
  assert.equal(c.state, "setup");
  assert.ok(!m.calls.some((l) => l === "t"));
});

test("a Jira entry with a usable site gives a Jira source, the same one each time", async () => {
  const m = machine(gitRepo);
  const p = createProjects({ exec: m.exec, fetch });
  const settings = { ...noSettings, sites: [site], projects: { "/w/app": jiraEntry } };
  const a = await p.contextOf(space, [], settings);
  assert.equal(a.sourceName, "Jira");
  assert.equal(a.home, "PAY");
  assert.equal(a.filter, "");
  assert.equal(a.label, "work");
  assert.equal(a.site, site);
  assert.ok(!m.calls.some((l) => l.startsWith("git remote -v")));
  assert.equal((await p.contextOf(space, [], settings)).source, a.source);
  p.forget();
  assert.equal((await p.contextOf(space, [], settings)).source, a.source);
  p.forget({ sources: true });
  assert.notEqual((await p.contextOf(space, [], settings)).source, a.source);
});

test("a Jira entry whose site or key can't be used goes back to the steps that fix it", async () => {
  const p = createProjects({ exec: machine(gitRepo).exec, fetch });
  const withEntry = (sites, entry) => ({ ...noSettings, sites, projects: { "/w/app": entry } });
  assert.equal((await p.contextOf(space, [], withEntry([], jiraEntry))).state, "connect");
  assert.equal((await p.contextOf(space, [], withEntry([{ ...site, url: "ftp://x" }], jiraEntry))).state, "setup");
  const bad = await p.contextOf(space, [], withEntry([site], { ...jiraEntry, projectKey: "bad key", filter: "bad key" }));
  assert.equal(bad.state, "ready");
  assert.equal(bad.home, "");
  assert.equal(bad.filter, "");
});

test("project spaces: worktrees count, remote and other spaces don't", async () => {
  const answers = async (cmd, args, opts) => {
    const inApp = opts.cwd.startsWith("/w/app") || opts.cwd.startsWith("/wt/");
    if (!inApp) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: args.includes("--show-toplevel") ? `${opts.cwd}\n` : "/w/app/.git\n", stderr: "" };
  };
  const p = createProjects({ exec: answers, fetch });
  const spaces = [
    { id: "A", folder: "/w/app", machine: null, tabs: [] },
    { id: "B", folder: "/x", machine: null, tabs: [{ id: "t" }] },
    { id: "C", folder: "/other", machine: null, tabs: [] },
    { id: "D", folder: "/w/app", machine: "box", tabs: [] },
  ];
  const ids = await p.spaceIds(spaces, [{ tab: "t", cwd: "/wt/app/12-x" }], "/w/app", "Z");
  assert.deepEqual([...ids].sort(), ["A", "B", "Z"]);
});

const claude = { key: "claude", installed: true, run: ["claude"] };
const repo = { main: "/w/app", name: "app" };

test("plan: a GitHub project starts from its remote's default branch", async () => {
  const m = machine([[/symbolic-ref/, "up/trunk\n"]]);
  const p = createProjects({ exec: m.exec, fetch });
  const out = await p.plan({ repo, entry: null, github: { remote: "up", repoRef: "o/app" } }, noSettings, [claude]);
  assert.deepEqual(out, { agentArgv: ["claude"], remote: "up", base: "trunk" });
});

test("plan: a Jira project uses origin when there is one, and no remote otherwise", async () => {
  const withOrigin = machine([[/^git remote$/, "origin\nother\n"], [/symbolic-ref/, "origin/main\n"]]);
  const a = await createProjects({ exec: withOrigin.exec, fetch }).plan({ repo, entry: null, github: null }, noSettings, [claude]);
  assert.deepEqual(a, { agentArgv: ["claude"], remote: "origin", base: "main" });
  const local = machine([[/refs\/heads\/main/, "abc\n"]]);
  const b = await createProjects({ exec: local.exec, fetch }).plan({ repo, entry: null, github: null }, noSettings, [claude]);
  assert.deepEqual(b, { agentArgv: ["claude"], remote: null, base: "main" });
});

test("plan: says what's missing", async () => {
  const p = createProjects({ exec: machine([]).exec, fetch });
  assert.match((await p.plan({ repo, entry: null, github: null }, noSettings, [])).problem, /agent/);
  assert.match((await p.plan({ repo, entry: null, github: null }, noSettings, [claude])).problem, /default branch/);
});
