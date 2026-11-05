import test from "node:test";
import assert from "node:assert/strict";
import { runToEnd } from "../lib/runner.js";

// A scripted hc: `polls` get replies in order (the last one repeats), everything else is recorded.
function fakeHc({ polls, output = "tail\n", address = "term-7", runReply, failOn } = {}) {
  const calls = [];
  let i = 0;
  const hc = async (args) => {
    calls.push(args);
    if (failOn === args[0]) throw new Error(`hc ${args[0]} timed out`);
    if (args[0] === "run") return { code: 0, stdout: runReply ?? JSON.stringify({ address }) + "\n", stderr: "" };
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify(polls[Math.min(i++, polls.length - 1)]), stderr: "" };
    if (args[0] === "read") return { code: 0, stdout: output, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { hc, calls };
}
const done = (exit_code, reason = "exited") => ({ state: "finished", exit_code, reason });
const running = { state: "running" };
const noSleep = async () => {};

test("success: exit code 0 and the tail of the output", async () => {
  const { hc, calls } = fakeHc({ polls: [done(0)], output: "ok\n" });
  const r = await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "status"] });
  assert.deepEqual(r, { code: 0, output: "ok\n" });
  assert.deepEqual(calls[0], ["run", "--bg", "--json", "--no-parent", "--cwd", "/w", "--", "git", "status"]);
  assert.deepEqual(calls.find((c) => c[0] === "read"), ["read", "term-7", "--lines", "40"]);
});

test("failure keeps the exit code and the output", async () => {
  const { hc } = fakeHc({ polls: [done(128)], output: "fatal: nope\n" });
  assert.deepEqual(await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] }), { code: 128, output: "fatal: nope\n" });
});

test("a killed terminal has no code, even when it reports exit_code 1", async () => {
  const { hc } = fakeHc({ polls: [done(1, "killed")] });
  const r = await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] });
  assert.equal(r.code, null);
});

test("polls until finished, sleeping 1 s between polls, calling onStart once", async () => {
  const polls = [...Array(40).fill(running), done(0)];
  const { hc, calls } = fakeHc({ polls });
  const sleeps = [];
  const started = [];
  const r = await runToEnd({ hc, sleep: async (ms) => sleeps.push(ms), cwd: "/w", argv: ["git", "x"], onStart: (a) => started.push(a) });
  assert.equal(r.code, 0);
  assert.equal(calls.filter((c) => c[0] === "get").length, 41);
  assert.ok(sleeps.length >= 40 && sleeps.every((ms) => ms === 1000));
  assert.deepEqual(started, ["term-7"]);
  assert.deepEqual(calls.find((c) => c[0] === "get"), ["get", "term-7", "--json"]);
});

test("rm comes after read, and last", async () => {
  const { hc, calls } = fakeHc({ polls: [done(0)] });
  await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] });
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf("read") < names.indexOf("rm"));
  assert.deepEqual(calls.at(-1), ["rm", "term-7"]);
});

test("a single-string argv is refused: hc would run it as a shell command", async () => {
  const { hc, calls } = fakeHc({ polls: [done(0)] });
  const r = await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git status"] });
  assert.equal(r.code, null);
  assert.match(r.output, /argv/);
  assert.equal(calls.length, 0);
});

test("hc rejecting resolves with the message, no code", async () => {
  const { hc } = fakeHc({ polls: [done(0)], failOn: "run" });
  const r = await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] });
  assert.equal(r.code, null);
  assert.match(r.output, /timed out/);
});

test("an unparsable run reply resolves with no code", async () => {
  const { hc } = fakeHc({ polls: [done(0)], runReply: "not json" });
  const r = await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] });
  assert.equal(r.code, null);
  assert.ok(r.output.length > 0);
});

// An hc whose `get` replies come from `gets`: a function (n) => reply, or throws to reject.
function scripted(gets) {
  let n = 0;
  return async (args) => {
    if (args[0] === "run") return { code: 0, stdout: '{"address":"t"}', stderr: "" };
    if (args[0] === "get") return gets(n++);
    return { code: 0, stdout: "out", stderr: "" };
  };
}
const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
const finished = { state: "finished", exit_code: 0, reason: "exited" };

test("a failing read or rm keeps the known exit code", async () => {
  for (const failOn of ["read", "rm"]) {
    const { hc } = fakeHc({ polls: [done(0)], failOn });
    assert.equal((await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] })).code, 0, failOn);
  }
  const { hc } = fakeHc({ polls: [done(3)], failOn: "read" });
  assert.deepEqual(await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] }), { code: 3, output: "" });
});

test("a single rejected, failing or unparsable poll doesn't end the wait", async () => {
  const bad = [
    () => { throw new Error("hc get timed out"); },
    () => ({ code: 1, stdout: "", stderr: "boom" }),
    () => ({ code: 0, stdout: "", stderr: "" }),
  ];
  for (const first of bad) {
    const r = await runToEnd({ hc: scripted((n) => (n === 0 ? first() : ok(finished))), sleep: noSleep, cwd: "/w", argv: ["git", "x"] });
    assert.deepEqual(r, { code: 0, output: "out" });
  }
});

test("five failed polls in a row end the wait with an unknown outcome", async () => {
  let gets = 0;
  const hc = scripted(() => { gets++; throw new Error("hc get timed out"); });
  const r = await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] });
  assert.equal(r.code, null);
  assert.match(r.output, /unknown/);
  assert.equal(gets, 5);
});

test("a good reply resets the count of failures", async () => {
  // four failures, one good, repeated, then finished: never five in a row
  const hc = scripted((n) => {
    if (n >= 20) return ok(finished);
    if (n % 5 === 4) return ok({ state: "running" });
    throw new Error("hc get timed out");
  });
  assert.equal((await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] })).code, 0);
});

test("a run reply without an address resolves with no code", async () => {
  const { hc } = fakeHc({ polls: [done(0)], runReply: "{}" });
  assert.equal((await runToEnd({ hc, sleep: noSleep, cwd: "/w", argv: ["git", "x"] })).code, null);
});
