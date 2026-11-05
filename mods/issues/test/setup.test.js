import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, hostOf, siteType, tokenItem, tokenReadCommand, tokenStoreCommand, siteFromUrl, usesKeychain, isKeychainItemName, tokenTabCommands, tokenHint, keyCandidates, guessProjectKey } from "../lib/setup.js";
import { sourceError } from "../sources/error.js";

test("normalizeUrl", () => {
  assert.equal(normalizeUrl(" jira.example.com/ "), "https://jira.example.com");
  assert.equal(normalizeUrl("http://x.corp/jira/"), "http://x.corp/jira");
  assert.equal(normalizeUrl("HTTPS://x.corp"), "HTTPS://x.corp");
  assert.equal(normalizeUrl("ftp://x.corp"), "ftp://x.corp");
  assert.equal(normalizeUrl("  "), "");
});

test("hostOf reads the host, not what surrounds it", () => {
  assert.equal(hostOf("https://Jira.Example.com:8443/jira"), "jira.example.com");
  assert.equal(hostOf("https://x.atlassian.net@evil.example/"), "evil.example");
  assert.equal(hostOf("https://evil.example#.atlassian.net"), "evil.example");
  assert.equal(hostOf("https://evil.example?x=.atlassian.net"), "evil.example");
  assert.equal(hostOf("nonsense"), "");
});

test("siteType follows the address", () => {
  assert.equal(siteType("https://acme.atlassian.net"), "cloud");
  assert.equal(siteType("https://ACME.atlassian.net/"), "cloud");
  assert.equal(siteType("https://jira.example.com"), "server");
  assert.equal(siteType("https://atlassian.net.evil.example"), "server");
  assert.equal(siteType("https://x.atlassian.net@evil.example"), "server");
  assert.equal(siteType("https://evilatlassian.net"), "server");
});

test("token item is named after the host", () => {
  assert.equal(tokenItem("https://jira.example.com/jira"), "herdr-issues-jira-jira.example.com");
});

test("token commands per platform", () => {
  assert.deepEqual(tokenReadCommand("macos", "i"), ["security", "find-generic-password", "-s", "i", "-w"]);
  assert.deepEqual(tokenReadCommand("linux", "i"), ["secret-tool", "lookup", "service", "i"]);
  assert.deepEqual(tokenStoreCommand("macos", "i"), ["security", "add-generic-password", "-U", "-a", "herdr-issues", "-s", "i", "-w"]);
  assert.deepEqual(tokenStoreCommand("linux", "i"), ["secret-tool", "store", "--label=Herdr Issues Jira", "service", "i"]);
});

test("the store command never carries a value after -w", () => {
  assert.equal(tokenStoreCommand("macos", "i").at(-1), "-w");
});

test("siteFromUrl fills everything in", () => {
  assert.deepEqual(siteFromUrl("jira.example.com", "macos"), {
    name: "jira.example.com", url: "https://jira.example.com", type: "server", email: "",
    tokenCommand: ["security", "find-generic-password", "-s", "herdr-issues-jira-jira.example.com", "-w"],
    allowInsecure: false,
  });
});

test("usesKeychain: only the command the mod fills in counts", () => {
  const site = siteFromUrl("jira.example.com", "macos");
  assert.equal(usesKeychain(site, "macos"), true);
  assert.equal(usesKeychain({ ...site, tokenCommand: ["pass", "jira"] }, "macos"), false);
  assert.equal(usesKeychain(site, "linux"), false);
});

const tokenSite = { url: "https://jira.example.com" };
const localSpace = { id: "S", machine: null, tabs: [{ id: "t1", name: "1", named: false }] };

const prompt = ["tab.new", {
  name: "Jira token", space: "S", folder: "/r",
  argv: ["security", "add-generic-password", "-U", "-a", "herdr-issues", "-s", "herdr-issues-jira-jira.example.com", "-w"],
}];

test("the token prompt opens in a new tab of the space", () => {
  assert.deepEqual(tokenTabCommands(localSpace, "/r", tokenSite, "macos"), [prompt]);
});

test("a token tab that's already there goes after the new one opens, so it's never the space's last", () => {
  const tabs = [{ id: "t2", name: "Jira token", named: true }];
  const commands = tokenTabCommands({ ...localSpace, tabs }, "/r", tokenSite, "macos");
  assert.deepEqual(commands, [prompt, ["tab.close", { id: "t2" }]]);
});

test("no token tab command skips Herdr's question about closing a space", () => {
  const tabs = [...localSpace.tabs, { id: "t2", name: "Jira token", named: true }, { id: "t3", name: "Jira token", named: true }];
  const commands = tokenTabCommands({ ...localSpace, tabs }, "/r", tokenSite, "macos");
  assert.equal(commands.length, 3);
  for (const [, args] of commands) assert.ok(!("confirmed" in args));
});

test("only a named tab counts as the token tab", () => {
  const tabs = [{ id: "t2", name: "Jira token", named: false }];
  assert.deepEqual(tokenTabCommands({ ...localSpace, tabs }, "/r", tokenSite, "macos"), [prompt]);
});

test("no token prompt goes to a remote space, or to no space", () => {
  assert.deepEqual(tokenTabCommands({ ...localSpace, machine: "box" }, "/r", tokenSite, "macos"), []);
  assert.deepEqual(tokenTabCommands(undefined, "/r", tokenSite, "macos"), []);
});

test("a keychain item name looks like a name", () => {
  for (const name of ["my-jira-token", "Jira Token", "herdr-issues-jira-jira.example.com", "abcdefghijklmnopqrs", "a".repeat(30) + "-" + "b".repeat(33)]) assert.equal(isKeychainItemName(name), true, name);
});

test("what looks like the token itself isn't a name", () => {
  const base64 = "dGhpc0lzQUZha2VUb2tlbkZvclRlc3RzT25seTEyMzQ="; // 44 characters
  assert.equal(base64.length, 44);
  for (const value of [base64, "x".repeat(190), "abcdefghijklmnopqrst", `${"a-".repeat(32)}a`]) assert.equal(isKeychainItemName(value), false, value);
});

test("hints fit the type", () => {
  assert.match(tokenHint("cloud"), /id\.atlassian\.com/);
  assert.match(tokenHint("server"), /Personal Access Tokens/);
  assert.doesNotMatch(tokenHint("server"), /atlassian\.com/);
});

test("keyCandidates: most frequent first, keys only", () => {
  assert.deepEqual(keyCandidates(["feature/ABC-7-x", "ABC-1", "origin/bugfix/ABC-2", "PAY-431-y", "main", "412-fix"]), ["ABC", "PAY"]);
});

test("keyCandidates ignores lowercase and digits-only prefixes", () => {
  assert.deepEqual(keyCandidates(["feature/abc-1", "v2-3", "2026-11"]), []);
});

test("keyCandidates: equally frequent keys keep the branch order", () => {
  assert.deepEqual(keyCandidates(["ZED-1", "ABC-1"]), ["ZED", "ABC"]);
});

// A repo with these branches; records the call.
function branches(names) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: `${names.join("\n")}\n`, stderr: "" };
  };
  return { exec, calls };
}

test("guessProjectKey takes the first the site confirms", async () => {
  const { exec, calls } = branches(["UTF-8-fix", "UTF-8-fix2", "ABC-1"]);
  const asked = [];
  const key = await guessProjectKey(exec, "/r", async (k) => (asked.push(k), k === "ABC"));
  assert.equal(key, "ABC");
  assert.deepEqual(asked, ["UTF", "ABC"]);
  assert.deepEqual(calls, [{
    cmd: "git",
    args: ["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    opts: { cwd: "/r" },
  }]);
});

test("guessProjectKey gives null when nothing is confirmed, and asks at most 5 keys", async () => {
  const { exec } = branches(["AA-1", "BB-1", "CC-1", "DD-1", "EE-1", "FF-1", "GG-1"]);
  const asked = [];
  assert.equal(await guessProjectKey(exec, "/r", async (k) => (asked.push(k), false)), null);
  assert.deepEqual(asked, ["AA", "BB", "CC", "DD", "EE"]);
});

test("guessProjectKey asks nothing when no branch holds a key", async () => {
  const { exec } = branches(["main", "412-fix"]);
  assert.equal(await guessProjectKey(exec, "/r", async () => assert.fail("asked")), null);
});

test("guessProjectKey lets an auth failure through", async () => {
  const { exec } = branches(["ABC-1"]);
  await assert.rejects(guessProjectKey(exec, "/r", async () => { throw sourceError("auth", "401"); }), { kind: "auth" });
});

test("guessProjectKey counts a git failure as no guess", async () => {
  assert.equal(await guessProjectKey(async () => ({ code: 128, stdout: "", stderr: "bad" }), "/r", async () => true), null);
  assert.equal(await guessProjectKey(async () => { throw new Error("no git"); }, "/r", async () => true), null);
});
