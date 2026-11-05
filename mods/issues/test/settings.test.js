import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings, saveSettings, pickAgent, parseArgv } from "../lib/settings.js";
import { DEFAULT_TEMPLATE } from "../lib/prompt.js";

const memory = (initial) => {
  const m = new Map(initial === undefined ? [] : [["issues.settings", initial]]);
  return { getItem: (k) => (m.has(k) ? m.get(k) : undefined), setItem: (k, v) => m.set(k, String(v)), raw: () => m.get("issues.settings") };
};
const agent = (key, installed = true) => ({ key, run: [key], installed });
const DEFAULTS = { defaultAgent: null, template: DEFAULT_TEMPLATE, askOtherProject: true, sites: [], projects: {} };

test("Claude Code when installed, else the first installed", () => {
  const a = [{ key: "codex", run: ["codex"], installed: true }, { key: "claude", run: ["claude"], installed: true }];
  assert.equal(pickAgent(a, {}, {}).key, "claude");
  assert.equal(pickAgent([a[0]], {}, {}).key, "codex");
});
test("project override beats the global default; nothing installed is null", () => {
  const a = [agent("claude"), agent("codex"), agent("gemini")];
  assert.equal(pickAgent(a, { defaultAgent: "codex" }, {}).key, "codex");
  assert.equal(pickAgent(a, { defaultAgent: "codex" }, { agent: "gemini" }).key, "gemini");
  assert.equal(pickAgent([agent("claude", false), agent("codex", false)], {}, {}), null);
  assert.equal(pickAgent([], {}, {}), null);
});
test("a configured agent that is not installed is skipped", () => {
  const a = [agent("claude"), agent("codex", false), agent("gemini")];
  assert.equal(pickAgent(a, { defaultAgent: "codex" }, { agent: "codex" }).key, "claude");
  assert.equal(pickAgent(a, { defaultAgent: "gemini" }, { agent: "codex" }).key, "gemini");
  assert.equal(pickAgent([agent("claude", false), agent("gemini")], {}, {}).key, "gemini");
});
test("agent run is passed through unchanged", () => {
  assert.deepEqual(pickAgent([{ key: "claude", run: ["claude", "--x"], installed: true }], {}, {}).run, ["claude", "--x"]);
});
test("settings survive a round trip and hold no token field", () => {
  const site = { name: "Work", url: "https://j.example", type: "cloud", email: "a@b.c", tokenCommand: ["security", "find", "-w"], allowInsecure: false };
  const settings = {
    defaultAgent: "codex",
    template: "{key}",
    askOtherProject: false,
    sites: [{ ...site, token: "SECRET" }],
    projects: { "/p/main": { source: "jira", site: "Work", projectKey: "PAY", filter: "OPS", agent: "claude", setupCommand: "npm i", token: "SECRET" } },
  };
  const s = memory();
  saveSettings(s, settings);
  assert.ok(!s.raw().includes("SECRET"));
  assert.deepEqual(loadSettings(s), {
    defaultAgent: "codex",
    template: "{key}",
    askOtherProject: false,
    sites: [site],
    projects: { "/p/main": { source: "jira", site: "Work", projectKey: "PAY", filter: "OPS", homeSet: true, agent: "claude", setupCommand: "npm i" } },
  });
});
test("a stray token field in stored JSON is dropped on load", () => {
  const stored = JSON.stringify({ sites: [{ name: "W", url: "https://j", type: "server", tokenCommand: ["x"], token: "SECRET" }] });
  assert.ok(!JSON.stringify(loadSettings(memory(stored))).includes("SECRET"));
});
test("an entry saved before the filter existed keeps its home project and opens on All", () => {
  const stored = JSON.stringify({ projects: { "/p": { source: "jira", site: "Work", projectKey: "PAY", agent: "", setupCommand: "" } } });
  const { projects, askOtherProject } = loadSettings(memory(stored));
  assert.equal(projects["/p"].projectKey, "PAY");
  assert.equal(projects["/p"].filter, "");
  assert.equal(askOtherProject, true);
});
test("a stored filter that isn't a project key is All", () => {
  for (const filter of ['PAY" OR 1=1', "pay", 7, null]) {
    const stored = JSON.stringify({ projects: { "/p": { source: "jira", site: "W", filter } } });
    assert.equal(loadSettings(memory(stored)).projects["/p"].filter, "");
  }
});
test("an entry that already has a home project counts as set", () => {
  const stored = JSON.stringify({ projects: { "/p": { source: "jira", site: "W", projectKey: "PAY" } } });
  assert.equal(loadSettings(memory(stored)).projects["/p"].homeSet, true);
});
test("homeSet is false unless it's really true or there is a home project", () => {
  for (const homeSet of [undefined, "yes", 1, null]) {
    const stored = JSON.stringify({ projects: { "/p": { source: "jira", site: "W", projectKey: "", homeSet } } });
    assert.equal(loadSettings(memory(stored)).projects["/p"].homeSet, false);
  }
});
test("a cleared home project stays cleared after a reload", () => {
  const stored = JSON.stringify({ projects: { "/p": { source: "jira", site: "W", projectKey: "", homeSet: true } } });
  const s = memory(stored);
  saveSettings(s, loadSettings(s));
  const entry = loadSettings(s).projects["/p"];
  assert.equal(entry.projectKey, "");
  assert.equal(entry.homeSet, true);
});
test("only false turns the question off", () => {
  assert.equal(loadSettings(memory('{"askOtherProject":"no"}')).askOtherProject, true);
  assert.equal(loadSettings(memory('{"askOtherProject":false}')).askOtherProject, false);
});
test("nothing stored gives defaults", () => {
  assert.deepEqual(loadSettings(memory()), DEFAULTS);
  assert.deepEqual(loadSettings(memory(null)), DEFAULTS);
});
test("broken JSON gives defaults", () => {
  assert.deepEqual(loadSettings(memory("{nope")), DEFAULTS);
  assert.deepEqual(loadSettings(memory("[1]")), DEFAULTS);
  assert.deepEqual(loadSettings(memory('"x"')), DEFAULTS);
  assert.deepEqual(loadSettings(memory('{"sites":5,"projects":[],"template":3,"defaultAgent":7}')), DEFAULTS);
});
test("parseArgv", () => {
  assert.deepEqual(parseArgv(`security find-generic-password -s "a b" -w`),
    ["security", "find-generic-password", "-s", "a b", "-w"]);
  assert.deepEqual(parseArgv(`echo 'a "b" c'  x`), ["echo", 'a "b" c', "x"]);
  assert.deepEqual(parseArgv(""), []);
  assert.deepEqual(parseArgv(`a "" b`), ["a", "", "b"]);
});
