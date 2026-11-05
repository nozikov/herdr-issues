import test from "node:test";
import assert from "node:assert/strict";
import { tokenCommandText, saveGlobal, saveSite, removeSite, saveProject, saveExtras, pickProjectSite, saveFoundKey, saveFilter, saveSource, saveKeychainItem, connectKeychainItem } from "../lib/form.js";
import { parseArgv } from "../lib/settings.js";
import { DEFAULT_TEMPLATE } from "../lib/prompt.js";

const empty = { defaultAgent: null, template: "T", sites: [], projects: {} };
const values = { url: "jira.test/", email: "x@y", tokenCommand: "", allowInsecure: false };
const READ = ["security", "find-generic-password", "-s", "herdr-issues-jira-jira.test", "-w"];
const save = (settings, previous, over = {}) => saveSite(settings, previous, { ...values, ...over }, "macos");

test("a token command survives the trip through the form", () => {
  for (const argv of [["security", "-s", "a b"], ["x", 'say "hi"'], ["x", "it's"], ["x", ""]]) assert.deepEqual(parseArgv(tokenCommandText(argv)), argv);
  assert.equal(tokenCommandText(undefined), "");
});

test("global: an empty template falls back to the default", () => {
  const { settings } = saveGlobal(empty, { defaultAgent: "", template: "  " });
  assert.equal(settings.template, DEFAULT_TEMPLATE);
  assert.equal(settings.defaultAgent, null);
  assert.equal(saveGlobal(empty, { defaultAgent: "codex", template: "x" }).settings.defaultAgent, "codex");
});

test("global: the question before another project's task is kept, on by default", () => {
  assert.equal(saveGlobal(empty, { defaultAgent: "", template: "x", askOtherProject: false }).settings.askOtherProject, false);
  assert.equal(saveGlobal(empty, { defaultAgent: "", template: "x" }).settings.askOtherProject, true);
});

test("a site needs only its address: the rest is worked out", () => {
  const { settings } = save(empty, "");
  assert.deepEqual(settings.sites, [{ name: "jira.test", url: "https://jira.test", type: "server", email: "", tokenCommand: READ, allowInsecure: false }]);
});

test("a Cloud address keeps the email", () => {
  const { settings } = save(empty, "", { url: "acme.atlassian.net" });
  assert.equal(settings.sites[0].type, "cloud");
  assert.equal(settings.sites[0].email, "x@y");
});

test("a typed token command wins", () => {
  assert.deepEqual(save(empty, "", { tokenCommand: "pass jira" }).settings.sites[0].tokenCommand, ["pass", "jira"]);
});

test("a bad site says why", () => {
  assert.match(save(empty, "", { url: " " }).problem, /address/);
  assert.match(save(empty, "", { url: "foo bar" }).problem, /address/);
  assert.match(save(empty, "", { url: "http://jira.test" }).problem, /Allow insecure/);
  assert.match(save(empty, "", { url: "ftp://jira.test" }).problem, /https/);
  assert.match(save(empty, "", { url: "acme.atlassian.net", email: "" }).problem, /email/);
  assert.match(save(save(empty, "").settings, "").problem, /already/);
});

test("an address with a password, a query or a fragment is never stored", () => {
  for (const url of ["https://u:p@jira.test", "jira.test/?x=1", "jira.test#a"]) {
    const r = save(empty, "", { url });
    assert.equal(r.settings, undefined);
    assert.ok(r.problem);
  }
  assert.match(save(empty, "", { url: "https://u:p@jira.test" }).problem, /password/);
});

test("http needs the explicit tick", () => {
  assert.equal(save(empty, "", { url: "http://jira.test", allowInsecure: true }).settings.sites[0].allowInsecure, true);
});

test("a site moved to another host keeps its projects, and a filled-in command follows it", () => {
  const one = { ...save(empty, "").settings, projects: { "/a": { source: "jira", site: "jira.test", projectKey: "PAY", agent: "", setupCommand: "" } } };
  const { settings } = save(one, "jira.test", { url: "new.test", tokenCommand: tokenCommandText(READ) });
  assert.deepEqual(settings.sites.map((s) => s.name), ["new.test"]);
  assert.equal(settings.projects["/a"].site, "new.test");
  assert.equal(settings.sites[0].tokenCommand[3], "herdr-issues-jira-new.test");
});

test("a site moved to another host keeps a command the person typed", () => {
  const one = save(empty, "", { tokenCommand: "pass jira" }).settings;
  assert.deepEqual(save(one, "jira.test", { url: "new.test", tokenCommand: "pass jira" }).settings.sites[0].tokenCommand, ["pass", "jira"]);
});

test("a keychain item becomes the site's token command, on either platform", () => {
  const onMac = saveKeychainItem(empty, "", values, " my token ", "macos").settings;
  assert.deepEqual(onMac.sites[0].tokenCommand, ["security", "find-generic-password", "-s", "my token", "-w"]);
  const onLinux = saveKeychainItem(empty, "", values, "jira", "linux").settings;
  assert.deepEqual(onLinux.sites[0].tokenCommand, ["secret-tool", "lookup", "service", "jira"]);
});

test("a keychain item replaces the command of a site that's connected", () => {
  const one = save(empty, "").settings;
  const { settings } = saveKeychainItem(one, "jira.test", values, "other-item", "macos");
  assert.equal(settings.sites.length, 1);
  assert.equal(settings.sites[0].tokenCommand[3], "other-item");
});

test("the keychain field takes a name, not a command", () => {
  assert.match(saveKeychainItem(empty, "", values, "  ", "macos").problem, /name/);
  assert.match(saveKeychainItem(empty, "", values, "security find-generic-password -s x -w", "macos").problem, /name/);
  assert.match(saveKeychainItem(empty, "", values, "secret-tool lookup service x", "linux").problem, /name/);
  assert.match(saveKeychainItem(empty, "", values, "-x", "macos").problem, /name/);
  assert.match(saveKeychainItem(empty, "", { ...values, url: "" }, "x", "macos").problem, /address/);
});

const TOKEN_WORDS = "That looks like the token itself. Enter the name of the keychain item, not its value.";
const keychain = (exec, over = {}) => connectKeychainItem({ exec, settings: empty, previous: "", values, item: "my-jira-token", platform: "macos", ...over });
const found = async () => ({ code: 0, stdout: "secret-token\n", stderr: "" });

test("a value that looks like the token starts no process, is not echoed, and asks to clear the field", async () => {
  for (const item of ["dGhpc0lzQUZha2VUb2tlbkZvclRlc3RzT25seTEyMzQ=", "x".repeat(190)]) {
    const r = await keychain(async () => assert.fail("a process started"), { item });
    assert.deepEqual(r, { problem: TOKEN_WORDS, clear: true });
    assert.deepEqual(saveKeychainItem(empty, "", values, item, "macos"), { problem: TOKEN_WORDS, clear: true });
  }
});

test("a keychain item is saved only after reading it worked", async () => {
  const calls = [];
  const r = await keychain(async (cmd, args) => (calls.push([cmd, ...args]), found()));
  assert.deepEqual(calls, [["security", "find-generic-password", "-s", "my-jira-token", "-w"]]);
  assert.deepEqual(r.settings.sites[0].tokenCommand, ["security", "find-generic-password", "-s", "my-jira-token", "-w"]);
  assert.ok(!JSON.stringify(r).includes("secret-token"));
});

test("a failed read saves nothing", async () => {
  const one = save(empty, "").settings;
  const failing = [
    async () => ({ code: 44, stdout: "", stderr: "not found" }),
    async () => ({ code: 0, stdout: "\n", stderr: "" }),
    async () => { throw new Error("no such program"); },
  ];
  for (const exec of failing) {
    assert.deepEqual(await keychain(exec), { problem: "No keychain item with that name" });
    assert.deepEqual(await keychain(exec, { settings: one, previous: "jira.test" }), { problem: "No keychain item with that name" });
  }
});

test("a bad address fails before the keychain is asked", async () => {
  const r = await keychain(async () => assert.fail("a process started"), { values: { ...values, url: "" } });
  assert.match(r.problem, /address/);
});

test("removing a site", () => {
  assert.deepEqual(removeSite(save(empty, "").settings, "jira.test").settings.sites, []);
});

test("a removed site takes its projects' source, home and filter with it, nothing else", () => {
  const two = save(save(empty, "").settings, "", { url: "other.test" }).settings;
  const on = (site) => ({ source: "jira", site, projectKey: "PAY", filter: "OPS", agent: "codex", setupCommand: "x" });
  const { settings } = removeSite({ ...two, projects: { "/a": on("jira.test"), "/b": on("other.test") } }, "jira.test");
  assert.deepEqual(settings.projects["/a"], { source: "", site: "", projectKey: "", filter: "", homeSet: false, agent: "codex", setupCommand: "x" });
  assert.deepEqual(settings.projects["/b"], on("other.test"));
});

const project = { source: "jira", site: "jira.test" };
const entry = (over = {}) => ({ source: "", site: "", projectKey: "", filter: "", homeSet: false, agent: "", setupCommand: "", ...over });

test("a Jira project needs a known site and no key", () => {
  const one = save(empty, "").settings;
  assert.match(saveProject(empty, "/a", project).problem, /site/);
  assert.deepEqual(saveProject(one, "/a", project).settings.projects["/a"], entry({ source: "jira", site: "jira.test" }));
});

test("saving the same site keeps the home project and the filter", () => {
  const one = save(empty, "").settings;
  const saved = { ...one, projects: { "/a": entry({ source: "jira", site: "jira.test", projectKey: "PAY", filter: "OPS" }) } };
  assert.deepEqual(saveProject(saved, "/a", project).settings.projects["/a"], saved.projects["/a"]);
});

test("moving to another site drops them: a key only counts on its own site", () => {
  const two = save(save(empty, "").settings, "", { url: "other.test" }).settings;
  const saved = { ...two, projects: { "/a": entry({ source: "jira", site: "jira.test", projectKey: "PAY", filter: "OPS", homeSet: true }) } };
  assert.deepEqual(saveProject(saved, "/a", { ...project, site: "other.test" }).settings.projects["/a"], entry({ source: "jira", site: "other.test" }));
});

test("Save in the gear works when the project's site is gone", () => {
  const one = save(empty, "").settings;
  assert.equal(saveProject(one, "/a", { ...project, site: "gone.test" }).settings.projects["/a"].site, "jira.test");
  const two = save(one, "", { url: "other.test" }).settings;
  assert.match(saveProject(two, "/a", { ...project, site: "gone.test" }).problem, /Pick/);
  assert.match(saveProject(empty, "/a", { ...project, site: "gone.test" }).problem, /Connect/);
});

test("moving a project to GitHub doesn't lose its Jira side", () => {
  const jira = entry({ source: "jira", site: "jira.test", projectKey: "DEMO", filter: "OTHER", homeSet: true });
  const saved = { ...empty, projects: { "/a": jira } };
  assert.deepEqual(saveProject(saved, "/a", { ...project, source: "github" }).settings.projects["/a"], { ...jira, source: "github" });
});

test("the switch sets the source and nothing else, there and back", () => {
  const jira = entry({ source: "jira", site: "jira.test", projectKey: "DEMO", filter: "OTHER", homeSet: true, agent: "codex", setupCommand: "npm ci" });
  const saved = { ...empty, projects: { "/a": jira } };
  const github = saveSource(saved, "/a", "github").settings;
  assert.deepEqual(github.projects["/a"], { ...jira, source: "github" });
  assert.deepEqual(saveSource(github, "/a", "jira").settings.projects["/a"], jira);
});

test("the switch works with no entry yet, and takes only its two sides", () => {
  assert.deepEqual(saveSource(empty, "/a", "github").settings.projects["/a"], entry({ source: "github" }));
  assert.deepEqual(saveSource(empty, "/a", "jira").settings.projects["/a"], entry({ source: "jira" }));
  assert.match(saveSource(empty, "/a", "other").problem, /source/i);
});

test("saving the source leaves the Advanced fields as they are, and the other way round", () => {
  const a = saveExtras(empty, "/a", { agent: "codex", setupCommand: " npm ci " }).settings;
  assert.deepEqual(a.projects["/a"], entry({ agent: "codex", setupCommand: "npm ci" }));
  const b = saveProject(a, "/a", { ...project, source: "github" }).settings;
  assert.equal(b.projects["/a"].agent, "codex");
  assert.equal(b.projects["/a"].source, "github");
  const c = saveExtras(b, "/a", { agent: "", setupCommand: "" }).settings;
  assert.equal(c.projects["/a"].source, "github");
});

test("Advanced sets the home project on the project's site", () => {
  const extras = { agent: "", setupCommand: "" };
  const { settings } = saveExtras(empty, "/a", { ...extras, home: " pay ", site: "jira.test" });
  assert.deepEqual(settings.projects["/a"], entry({ source: "jira", site: "jira.test", projectKey: "PAY", homeSet: true }));
});

test("clearing the home project is a decision: it stays empty and marked", () => {
  const before = { ...empty, projects: { "/a": entry({ source: "jira", site: "jira.test", projectKey: "PAY", homeSet: true }) } };
  const { settings } = saveExtras(before, "/a", { agent: "", setupCommand: "", home: "", homeWas: "PAY", site: "jira.test" });
  assert.deepEqual(settings.projects["/a"], entry({ source: "jira", site: "jira.test", homeSet: true }));
});

test("saving Advanced with the field left as it was decides nothing", () => {
  const { settings } = saveExtras(empty, "/a", { agent: "codex", setupCommand: "", home: "", homeWas: "", site: "jira.test" });
  assert.deepEqual(settings.projects["/a"], entry({ agent: "codex" }));
  const decided = { ...empty, projects: { "/a": entry({ source: "jira", site: "jira.test", homeSet: true }) } };
  assert.equal(saveExtras(decided, "/a", { agent: "codex", setupCommand: "", home: "", homeWas: "", site: "jira.test" }).settings.projects["/a"].homeSet, true);
});

test("a guess that landed while the gear was open survives Save", () => {
  const guessed = saveFoundKey(empty, "/a", null, "ABC").settings;
  const { settings } = saveExtras(guessed, "/a", { agent: "codex", setupCommand: "", home: "", homeWas: "", site: "jira.test" });
  assert.equal(settings.projects["/a"].projectKey, "ABC");
  assert.equal(settings.projects["/a"].agent, "codex");
});

test("a home project left as it was isn't checked again", () => {
  const before = { ...empty, projects: { "/a": entry({ source: "jira", site: "jira.test", projectKey: "PAY", homeSet: true }) } };
  assert.equal(saveExtras(before, "/a", { agent: "x", setupCommand: "", home: "pay", homeWas: "PAY", site: "jira.test" }).settings.projects["/a"].projectKey, "PAY");
});

test("a GitHub repo's Advanced has no home project to decide", () => {
  assert.equal(saveExtras(empty, "/a", { agent: "x", setupCommand: "" }).settings.projects["/a"].homeSet, false);
});

test("Advanced refuses a home project that isn't a key", () => {
  for (const home of ["no way", "security find-generic-password -s x -w", 'PAY" OR 1=1']) {
    assert.deepEqual(saveExtras(empty, "/a", { agent: "", setupCommand: "", home, site: "jira.test" }), { problem: "A project key looks like PAY" });
  }
});

test("picking a site for a project is remembered, and starts it on All", () => {
  const before = { ...empty, projects: { "/a": entry({ source: "jira", site: "old.test", projectKey: "PAY", filter: "OPS", homeSet: true, agent: "codex" }) } };
  assert.deepEqual(pickProjectSite(before, "/a", "jira.test").settings.projects["/a"], entry({ source: "jira", site: "jira.test", agent: "codex" }));
});

test("a confirmed guess becomes the home project, keeping the rest", () => {
  const before = saveExtras(empty, "/a", { agent: "codex", setupCommand: "x" }).settings;
  const { settings } = saveFoundKey(before, "/a", before.projects["/a"], "ABC");
  assert.deepEqual(settings.projects["/a"], entry({ projectKey: "ABC", homeSet: true, agent: "codex", setupCommand: "x" }));
});

test("a guess never replaces a home project set meanwhile", () => {
  const before = { ...empty, projects: { "/a": entry({ source: "jira", site: "jira.test", projectKey: "PAY" }) } };
  assert.equal(saveFoundKey(before, "/a", before.projects["/a"], "ABC").settings.projects["/a"].projectKey, "PAY");
});

test("a guess never fills a home project cleared meanwhile", () => {
  const before = { ...empty, projects: { "/a": entry({ source: "jira", site: "jira.test", homeSet: true }) } };
  assert.equal(saveFoundKey(before, "/a", before.projects["/a"], "ABC").settings.projects["/a"].projectKey, "");
});

test("a late guess doesn't undo the switch to GitHub", () => {
  const jira = entry({ source: "jira", site: "jira.test" });
  const began = { ...empty, projects: { "/a": jira } };
  const moved = saveSource(began, "/a", "github").settings;
  assert.equal(saveFoundKey(moved, "/a", jira, "ABC").settings, moved);
  const fresh = saveSource(empty, "/a", "github").settings; // no entry when the guess began
  assert.equal(saveFoundKey(fresh, "/a", null, "ABC").settings, fresh);
});

test("a late guess stays off a project moved to another site", () => {
  const jira = entry({ source: "jira", site: "jira.test" });
  const moved = { ...empty, projects: { "/a": { ...jira, site: "other.test" } } };
  assert.equal(saveFoundKey(moved, "/a", jira, "ABC").settings, moved);
});

test("a guess writes the home project and never the source or the site", () => {
  const jira = entry({ source: "jira", site: "jira.test" });
  const on = saveFoundKey({ ...empty, projects: { "/a": jira } }, "/a", jira, "ABC").settings.projects["/a"];
  assert.deepEqual(on, { ...jira, projectKey: "ABC", homeSet: true });
  const none = saveFoundKey(empty, "/a", null, "ABC").settings.projects["/a"];
  assert.equal(none.source, "");
  assert.equal(none.site, "");
});

test("removing a site leaves a GitHub project on GitHub, without that site's data", () => {
  const github = entry({ source: "github", site: "jira.test", projectKey: "DEMO", filter: "OTHER", homeSet: true, agent: "codex" });
  const before = { ...empty, sites: [{ name: "jira.test" }], projects: { "/a": github } };
  assert.deepEqual(removeSite(before, "jira.test").settings.projects["/a"], entry({ source: "github", agent: "codex" }));
});

test("removing a site leaves a GitHub project on another site alone", () => {
  const github = entry({ source: "github", site: "other.test", projectKey: "DEMO", homeSet: true });
  const before = { ...empty, sites: [{ name: "jira.test" }, { name: "other.test" }], projects: { "/a": github } };
  assert.deepEqual(removeSite(before, "jira.test").settings.projects["/a"], github);
});

test("removing a site takes a guess made with no site named, and leaves the source", () => {
  const two = { ...empty, sites: [{ name: "jira.test" }], projects: { "/a": entry({ source: "jira", projectKey: "ABC", homeSet: true }) } };
  assert.deepEqual(removeSite(two, "jira.test").settings.projects["/a"], entry({ source: "jira" }));
});

test("the filter is remembered per repo, on its site", () => {
  const { settings } = saveFilter(empty, "/a", "jira.test", "PAY");
  assert.deepEqual(settings.projects["/a"], entry({ source: "jira", site: "jira.test", filter: "PAY" }));
  assert.equal(saveFilter(settings, "/a", "jira.test", "").settings.projects["/a"].filter, "");
});

test("a filter that isn't a key is All: a task's key is untrusted text", () => {
  assert.equal(saveFilter(empty, "/a", "jira.test", 'PAY" OR 1=1').settings.projects["/a"].filter, "");
});

const token44 = "aB3dE6".repeat(8).slice(0, 44);
const token190 = "aB3-_=".repeat(32).slice(0, 190);

test("a pasted token is refused on Save, and not repeated", () => {
  const before = save(empty, "").settings;
  for (const [typed, secret] of [[token44, token44], [token190, token190], [`security ${token190}`, token190], [`"${token44}"`, token44], ["gettoken", "gettoken"]]) {
    const r = save(before, "jira.test", { tokenCommand: typed });
    assert.equal(r.settings, undefined, typed);
    assert.match(r.problem, /command/);
    assert.equal(r.problem.includes(secret), false);
    assert.equal(r.clear, true);
  }
});

test("a token with a slash in it is no path", () => {
  const r = save(empty, "", { tokenCommand: `${token44.slice(0, 20)}/${token44.slice(20)}+x==` });
  assert.equal(r.settings, undefined);
});

test("real token commands pass", () => {
  for (const typed of ["pass show jira", "/usr/local/bin/get-token", "~/bin/get-token", "./get-token", "op read op://vault/jira/token",
    `pass show ${"long/".repeat(20)}x`, `curl https://x.test/${"a".repeat(80)}`])
    assert.ok(save(empty, "", { tokenCommand: typed }).settings, typed);
});

test("the filled-in keychain command isn't judged by shape", () => {
  const long = save(empty, "", { url: `${"a".repeat(60)}.example.com` }).settings;
  const site = long.sites[0];
  assert.ok(save(long, site.name, { url: site.url, tokenCommand: tokenCommandText(site.tokenCommand) }).settings);
});
