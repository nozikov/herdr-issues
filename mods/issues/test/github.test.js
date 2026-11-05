import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGithubSource } from "../sources/github.js";
import { redact } from "../sources/error.js";

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const filters = { assignee: "me", state: "open", text: "" };

// A fake exec recording calls; `reply` is a result, or a function returning a result/promise.
function setup(reply) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof reply === "function" ? reply(args) : reply;
  };
  const source = createGithubSource({ exec, ghBin: "gh", repoRef: "o/r", cwd: "/repo" });
  return { calls, source };
}
const ok = async (name) => ({ code: 0, stdout: await fixture(name), stderr: "" });

test("default list uses the exact arguments", async () => {
  const { calls, source } = setup(await ok("gh-issue-list.json"));
  await source.list(filters);
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args, ["issue", "list", "-R", "o/r", "--limit", "100",
    "--json", "number,title,body,labels,assignees,state,url,updatedAt",
    "--state", "open", "--assignee", "@me", "--search=sort:updated-desc"]);
  assert.equal(calls[0].opts.cwd, "/repo");
});
test("anyone and all drop the assignee and widen the state", async () => {
  const { calls, source } = setup(await ok("gh-issue-list.json"));
  await source.list({ assignee: "anyone", state: "all", text: "" });
  assert.ok(!calls[0].args.includes("--assignee"));
  assert.ok(calls[0].args.includes("all"));
});
test("search text stays one argument", async () => {
  const { calls, source } = setup(await ok("gh-issue-list.json"));
  await source.list({ assignee: "me", state: "open", text: "--web; $(x)" });
  assert.ok(calls[0].args.includes("--search=sort:updated-desc --web; $(x)"));
});
test("tasks have the shared shape, newest updated first", async () => {
  const { source } = setup(await ok("gh-issue-list.json"));
  const tasks = await source.list(filters);
  assert.deepEqual(Object.keys(tasks[0]).sort(),
    ["assignee", "body", "key", "labels", "markdown", "priority", "state", "title", "updatedAt", "url"]);
  assert.match(tasks[0].key, /^#\d+$/);
  assert.deepEqual(tasks.map((t) => t.key), ["#42", "#99", "#17"]);
  assert.deepEqual(tasks[0], {
    key: "#42", title: "Export button does nothing", url: "https://github.com/example/demo/issues/42",
    state: "open", assignee: "alice", labels: ["bug", "ui"], updatedAt: "2026-11-03T10:00:00Z",
    body: "Click it, nothing happens.", markdown: "Click it, nothing happens.", priority: "",
  });
  assert.equal(tasks[2].assignee, "");
  assert.deepEqual(tasks[2].labels, []);
});
test("get takes #123", async () => {
  const { calls, source } = setup(await ok("gh-issue-view.json"));
  const task = await source.get("#123");
  assert.deepEqual(calls[0].args.slice(0, 5), ["issue", "view", "123", "-R", "o/r"]);
  assert.equal(task.key, "#123");
  assert.equal(task.assignee, "carol");
});
test("get refuses anything but a number", async () => {
  const { calls, source } = setup(await ok("gh-issue-view.json"));
  await assert.rejects(source.get("#1 --web"), { kind: "notFound" });
  assert.equal(calls.length, 0);
});
for (const [stderr, kind] of [
  ["To get started with GitHub CLI, please run: gh auth login", "auth"],
  ["error connecting to api.github.com", "network"],
  ["GraphQL: Could not resolve to an Issue with the number of 9.", "notFound"],
  ["boom", "other"],
]) test(`stderr maps to ${kind}`, async () => {
  const { source } = setup({ code: 1, stdout: "", stderr });
  await assert.rejects(source.list(filters), { kind });
  await assert.rejects(source.get("#9"), { kind });
});
test("gh not installed is an other error", async () => {
  const { source } = setup(() => { throw new Error("spawn gh ENOENT"); });
  await assert.rejects(source.list(filters), { kind: "other" });
});
test("hitting the exec time limit is a network error", async () => {
  const { source } = setup(() => { throw new Error("gh took longer than 30 s"); });
  await assert.rejects(source.list(filters), { kind: "network" });
});
test("a token in stderr doesn't reach the message", async () => {
  const { source } = setup({ code: 1, stdout: "", stderr: "boom gho_abc123 for request" });
  await assert.rejects(source.list(filters), (e) => e.kind === "other" && !e.message.includes("gho_abc123"));
});
test("redact masks listed secrets and gh tokens", () => {
  assert.equal(redact("tok=s3cret and ghp_Zz9", ["s3cret"]), "tok=*** and ***");
});

test("comments: one read of the issue, in order, cleaned for reading", async () => {
  const stdout = JSON.stringify({ comments: [
    { author: { login: "alice" }, createdAt: "2026-11-01T10:00:00Z", body: "see ![shot](https://x.test/p.png)" },
    { author: null, createdAt: "2026-11-02T10:00:00Z", body: "**ok**" },
  ] });
  const { calls, source } = setup({ code: 0, stdout, stderr: "" });
  assert.deepEqual(await source.comments("#12"), [
    { author: "alice", created: "2026-11-01T10:00:00Z", body: "see shot" },
    { author: "", created: "2026-11-02T10:00:00Z", body: "**ok**" },
  ]);
  assert.deepEqual(calls[0].args, ["issue", "view", "12", "-R", "o/r", "--json", "comments"]);
});

test("comments: a key that isn't a number reaches nothing", async () => {
  const { calls, source } = setup({ code: 0, stdout: "{}", stderr: "" });
  await assert.rejects(source.comments("#1; rm -rf"), (e) => e.kind === "notFound");
  await assert.rejects(source.comments("--web"), (e) => e.kind === "notFound");
  assert.equal(calls.length, 0);
});

test("comments: a reply with none is an empty list", async () => {
  const { source } = setup({ code: 0, stdout: "{}", stderr: "" });
  assert.deepEqual(await source.comments("#12"), []);
});

test("the shown text is cleaned, the agent's text stays as it came", async () => {
  const raw = [{ number: 1, title: "t", body: "![a](https://x.test/p.png)", labels: [], assignees: [], state: "OPEN", url: "https://x.test/1", updatedAt: "2026-11-01T10:00:00Z" }];
  const { source } = setup({ code: 0, stdout: JSON.stringify(raw), stderr: "" });
  const [task] = await source.list(filters);
  assert.equal(task.body, "![a](https://x.test/p.png)");
  assert.equal(task.markdown, "a");
});
