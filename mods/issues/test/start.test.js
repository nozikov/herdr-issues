import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findStartedTab, runSetup, cancelSetup, liveCwds, createStarter } from "../lib/start.js";
import { DEFAULT_TEMPLATE } from "../lib/prompt.js";
import { nodeExec, tempRepo } from "./_util.js";

const toClean = [];
after(async () => {
  for (const d of toClean) await rm(d, { recursive: true, force: true });
});

// ---- findStartedTab ----

const space = (id, tabs) => ({ id, tabs });

test("a named tab in any space of the project is found", () => {
  const spaces = [space("a", []), space("b", [{ id: "t", name: "PAY-1", named: true }])];
  assert.equal(findStartedTab(spaces, new Set(["a", "b"]), "PAY-1").tab.id, "t");
  assert.equal(findStartedTab(spaces, new Set(["a", "b"]), "PAY-1").space.id, "b");
});

test("an unnamed tab showing its position isn't a task", () => {
  const spaces = [space("a", [{ id: "t", name: "2", named: false }])];
  assert.equal(findStartedTab(spaces, new Set(["a"]), "2"), null);
});

test("a tab in another project's space doesn't count", () => {
  const spaces = [space("x", [{ id: "t", name: "PAY-1", named: true }])];
  assert.equal(findStartedTab(spaces, new Set(["a", "b"]), "PAY-1"), null);
});

// ---- runSetup, cancelSetup, liveCwds over a scripted hc ----

function scriptedHc({ polls, output = "tail\n", address = "term-7" }) {
  const calls = [];
  let i = 0;
  const hc = async (args) => {
    calls.push(args);
    if (args[0] === "run") return { code: 0, stdout: JSON.stringify({ address }) + "\n", stderr: "" };
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify(polls[Math.min(i++, polls.length - 1)]), stderr: "" };
    if (args[0] === "read") return { code: 0, stdout: output, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { hc, calls };
}
const done = (exit_code) => ({ state: "finished", exit_code, reason: "exited" });
const live = { state: "live" };
const noSleep = async () => {};

test("setup gets branch and folder as arguments, and no task text", async () => {
  const { hc, calls } = scriptedHc({ polls: [done(0)] });
  const r = await runSetup({ hc, sleep: noSleep, branch: "b;x", folder: "/f", command: "npm ci", onStart() {} });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls[0], ["run", "--bg", "--json", "--no-parent", "--cwd", "/f", "--", "sh", "-c", "npm ci", "herdr-issues-setup", "b;x", "/f"]);
});

test("runSetup has no time limit: it polls until the terminal ends", async () => {
  const { hc, calls } = scriptedHc({ polls: [...Array(100).fill(live), done(0)] });
  const r = await runSetup({ hc, sleep: noSleep, branch: "b", folder: "/f", command: "true" });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.filter((c) => c[0] === "get").length, 101);
});

test("a failed setup reports its output", async () => {
  const { hc } = scriptedHc({ polls: [done(1)], output: "npm ERR! x\n" });
  assert.deepEqual(await runSetup({ hc, sleep: noSleep, branch: "b", folder: "/f", command: "npm ci" }), { ok: false, output: "npm ERR! x\n" });
});

test("onStart gets the address of the setup terminal", async () => {
  const { hc } = scriptedHc({ polls: [done(0)], address: "term-9" });
  const seen = [];
  await runSetup({ hc, sleep: noSleep, branch: "b", folder: "/f", command: "true", onStart: (a) => seen.push(a) });
  assert.deepEqual(seen, ["term-9"]);
});

test("cancelSetup kills the terminal", async () => {
  const calls = [];
  await cancelSetup(async (args) => (calls.push(args), { code: 0, stdout: "", stderr: "" }), "term-7");
  assert.deepEqual(calls, [["kill", "term-7"]]);
});

test("the setup terminal is removed once its output is read, after success and after failure", async () => {
  for (const code of [0, 1]) {
    const { hc, calls } = scriptedHc({ polls: [done(code)] });
    await runSetup({ hc, sleep: noSleep, branch: "b", folder: "/f", command: "true" });
    const names = calls.map((c) => c[0]);
    assert.ok(names.indexOf("read") < names.indexOf("rm"));
    assert.deepEqual(calls.at(-1), ["rm", "term-7"]);
  }
});

test("liveCwds leaves out finished terminals", () => {
  assert.deepEqual(
    liveCwds([{ cwd: "/a", terminal: "t1" }, { terminal: "t2" }], [{ cwd: "/b", state: "live" }, { cwd: "/c", state: "finished" }]),
    ["/a", "/b"],
  );
});

// ---- createStarter over a real repository and a hc that really runs what it is given ----

// `hc` runs `run` for real (nodeExec), answers `get` when the process ends, and records every call.
// The command "hold" waits until `kill`.
// `opts` can change a run later: killCode (reply of kill), onKill(proc) instead of ending the
// process, beforeSetupReply() called when the setup terminal exists but `run` hasn't replied yet.
function realHc(log, opts = {}) {
  const procs = new Map();
  let n = 0;
  return async (args) => {
    log.push(["hc", ...args]);
    const reply = (stdout) => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "run") {
      const rest = args.slice(args.indexOf("--") + 1);
      const cwd = args[args.indexOf("--cwd") + 1];
      const address = `term-${++n}`;
      let release;
      const held = rest[0] === "sh" && rest[2] === "hold";
      const p = held ? new Promise((res) => (release = res)) : nodeExec(rest[0], rest.slice(1), { cwd });
      procs.set(address, { p, release });
      if (rest.includes("herdr-issues-setup") && opts.beforeSetupReply) opts.beforeSetupReply();
      return reply(JSON.stringify({ address }) + "\n");
    }
    const proc = procs.get(args[1]);
    if (args[0] === "get") {
      const r = await proc.p;
      return reply(JSON.stringify(r.killed ? { state: "finished", exit_code: null, reason: "killed" } : { state: "finished", exit_code: r.code, reason: "exited" }));
    }
    if (args[0] === "read") {
      const r = await proc.p;
      return reply((r.stdout ?? "") + (r.stderr ?? ""));
    }
    if (args[0] === "kill") {
      if (opts.onKill) opts.onKill(proc);
      else proc.release({ killed: true });
      if (opts.killCode) return { code: opts.killCode, stdout: "", stderr: "no such terminal" };
    }
    return reply("");
  };
}

const task = { key: "PAY-1", title: "Double charge", url: "https://t/PAY-1", body: "It charges twice." };
const memoryStorage = (initial) => {
  const m = new Map(initial === undefined ? [] : [["issues.pendingSetup", initial]]);
  // like the runtime's localStorage: undefined, not null, for a missing key
  return { getItem: (k) => m.get(k), setItem: (k, v) => void m.set(k, v) };
};

async function world(overrides = {}) {
  const r = await tempRepo();
  const home = await realpath(await mkdtemp(join(tmpdir(), "issues-home-")));
  toClean.push(r.dir, home);
  const log = [];
  const commands = [];
  const rows = [];
  let tabs = overrides.tabs ?? [];
  const exec = async (cmd, args, opts) => (log.push(["exec", cmd, ...args]), nodeExec(cmd, args, opts));
  const storage = overrides.storage ?? memoryStorage();
  const hcOpts = {};
  const starter = createStarter({
    exec,
    hc: realHc(log, hcOpts),
    run: (name, args) => (overrides.runThrows?.(name), commands.push({ name, args }), null),
    spaces: () => {
      if (overrides.spacesThrows) throw new Error("spaces are gone");
      return [{ id: "S", tabs }];
    },
    storage,
    home,
  });
  const repo = { main: r.dir, name: basename(r.dir) };
  const ctx = {
    space: "S",
    repo,
    remote: null,
    base: "main",
    projectSpaceIds: new Set(["S"]),
    agentArgv: ["claude"],
    setupCommand: "",
    template: DEFAULT_TEMPLATE,
    sleep: async () => {},
    onRow: (key, state) => rows.push([key, state]),
    ...overrides.ctx,
  };
  return { hcOpts, starter, ctx, log, commands, rows, home, repo, git: r.git, storage, setTabs: (t) => (tabs = t) };
}
const newTabs = (commands) => commands.filter((c) => c.name === "tab.new");
const setupRuns = (log) => log.filter((c) => c[0] === "hc" && c[1] === "run" && c.includes("herdr-issues-setup")).length;

test("started task: selects it and creates nothing", async () => {
  const w = await world({ tabs: [{ id: "t9", name: "PAY-1", named: true }] });
  const out = await w.starter.start(task, w.ctx);
  assert.deepEqual(out, { status: "selected" });
  assert.deepEqual(w.log, []);
  assert.deepEqual(w.commands, [{ name: "tab.select", args: { id: "t9" } }]);
  assert.deepEqual(w.rows, []);
});

test("second ▶ while the first is running does nothing", async () => {
  const w = await world();
  const [a, b] = await Promise.all([w.starter.start(task, w.ctx), w.starter.start(task, w.ctx)]);
  assert.equal(newTabs(w.commands).length, 1);
  assert.equal(a.status, "started");
  assert.equal(b.status, "selected");
});

test("after a failure ▶ works again", async () => {
  const w = await world();
  const bad = await w.starter.start(task, { ...w.ctx, base: "nope" });
  assert.equal(bad.status, "failed");
  assert.match(bad.message, /nope/);
  assert.equal(newTabs(w.commands).length, 0);
  assert.deepEqual(w.rows.at(-1), ["PAY-1", null]);
  const good = await w.starter.start(task, w.ctx);
  assert.equal(good.status, "started");
  assert.equal(newTabs(w.commands).length, 1);
});

test("tab.new gets the space, key, folder, exact argv and the prompt", async () => {
  const w = await world();
  const out = await w.starter.start(task, { ...w.ctx, agentArgv: ["claude"] });
  assert.deepEqual(out, { status: "started", warning: null });
  const { args } = newTabs(w.commands)[0];
  assert.equal(args.space, "S");
  assert.equal(args.name, "PAY-1");
  assert.equal(args.folder, `${w.home}/.herdr/worktrees/${w.repo.name}/PAY-1-double-charge`);
  assert.deepEqual(args.argv, ["claude"]);
  assert.ok(args.task.startsWith("Work on this task."));
  assert.match(args.task, /PAY-1: Double charge/);
  assert.equal(w.commands.length, 1, "no select after tab.new");
});

test("a fetch that fails is reported as a warning", async () => {
  const w = await world();
  const out = await w.starter.start(task, { ...w.ctx, remote: "origin" });
  assert.equal(out.status, "started");
  assert.match(out.warning, /Could not fetch origin/);
});

test("setup runs only for a new folder, before the agent", async () => {
  const w = await world();
  const ctx = { ...w.ctx, setupCommand: "true" };
  await w.starter.start(task, ctx);
  assert.equal(setupRuns(w.log), 1);
  const firstRun = w.log.findIndex((c) => c.includes("herdr-issues-setup"));
  assert.ok(firstRun >= 0);
  assert.equal(newTabs(w.commands).length, 1);
  // second ▶ (the tab is not in the list): the folder exists, setup passed, so it doesn't run again
  await w.starter.start(task, ctx);
  assert.equal(setupRuns(w.log), 1);
  assert.equal(newTabs(w.commands).length, 2);
  assert.deepEqual(w.rows.slice(0, 3), [["PAY-1", "starting"], ["PAY-1", "setup"], ["PAY-1", null]]);
});

test("setup failure stops before the agent, with output", async () => {
  const w = await world();
  const out = await w.starter.start(task, { ...w.ctx, setupCommand: "echo 'npm ERR! boom'; exit 1" });
  assert.equal(out.status, "failed");
  assert.match(out.output, /npm ERR/);
  assert.equal(newTabs(w.commands).length, 0);
});

test("failed setup runs again on the next ▶, a passed one doesn't", async () => {
  const w = await world();
  const failing = { ...w.ctx, setupCommand: "exit 1" };
  assert.equal((await w.starter.start(task, failing)).status, "failed");
  assert.equal((await w.starter.start(task, failing)).status, "failed");
  assert.equal(setupRuns(w.log), 2);
  const passing = { ...w.ctx, setupCommand: "true" };
  assert.equal((await w.starter.start(task, passing)).status, "started");
  assert.equal(setupRuns(w.log), 3);
  assert.deepEqual(JSON.parse(w.storage.getItem("issues.pendingSetup")), []);
  assert.equal((await w.starter.start(task, passing)).status, "started");
  assert.equal(setupRuns(w.log), 3);
});

test("broken JSON in storage counts as empty", async () => {
  const w = await world({ storage: memoryStorage("{not json") });
  const out = await w.starter.start(task, { ...w.ctx, setupCommand: "true" });
  assert.equal(out.status, "started");
  assert.deepEqual(JSON.parse(w.storage.getItem("issues.pendingSetup")), []);
});

test("cancel kills the running setup; the folder stays pending and setup runs again", async () => {
  const w = await world();
  const holding = w.starter.start(task, { ...w.ctx, setupCommand: "hold" });
  // wait until the setup terminal is being polled (the worktree add before it polls too)
  const polling = () => {
    const at = w.log.findIndex((c) => c.includes("herdr-issues-setup"));
    return at >= 0 && w.log.slice(at).some((c) => c[1] === "get");
  };
  for (let i = 0; i < 400 && !polling(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(polling());
  await w.starter.cancel("PAY-1");
  const out = await holding;
  assert.deepEqual(out, { status: "failed", message: "Setup cancelled" });
  assert.ok(w.log.some((c) => c[0] === "hc" && c[1] === "kill"));
  assert.equal(newTabs(w.commands).length, 0);
  assert.equal(JSON.parse(w.storage.getItem("issues.pendingSetup")).length, 1);
  const again = await w.starter.start(task, { ...w.ctx, setupCommand: "true" });
  assert.equal(again.status, "started");
  assert.equal(setupRuns(w.log), 2);
});

test("cancel with nothing running does nothing", async () => {
  const w = await world();
  await w.starter.cancel("PAY-1");
  assert.deepEqual(w.log, []);
});

test("an existing worktree of the task is reused even if the title changed", async () => {
  const w = await world();
  await w.starter.start(task, w.ctx);
  const first = newTabs(w.commands)[0].args.folder;
  await w.starter.start({ ...task, title: "Charged twice, different words" }, w.ctx);
  assert.equal(newTabs(w.commands)[1].args.folder, first);
  assert.equal((await w.git("branch", "--list", "PAY-1*")).stdout.trim().split("\n").length, 1);
});

test("several branches for one task: failed, naming them, nothing created", async () => {
  const w = await world();
  await w.git("branch", "PAY-1-a");
  await w.git("branch", "PAY-1-b");
  const out = await w.starter.start({ ...task, title: "Something else" }, w.ctx);
  assert.equal(out.status, "failed");
  assert.match(out.message, /PAY-1-a/);
  assert.match(out.message, /PAY-1-b/);
  assert.equal(w.log.filter((c) => c[0] === "hc").length, 0);
  assert.equal(newTabs(w.commands).length, 0);
});

test("a rejection from git becomes a failed outcome", async () => {
  const w = await world();
  const starter = createStarter({
    exec: async () => { throw new Error("git took longer than 30 s"); },
    hc: realHc([]),
    run: () => null,
    spaces: () => [],
    storage: memoryStorage(),
    home: w.home,
  });
  const out = await starter.start(task, w.ctx);
  assert.equal(out.status, "failed");
  assert.match(out.message, /30 s/);
});

test("a hostile title and body never appear in exec or hc arguments", async () => {
  const w = await world();
  const evil = "$(rm -rf ~)`x`;|";
  const out = await w.starter.start({ ...task, title: evil, body: evil }, { ...w.ctx, setupCommand: "true" });
  assert.equal(out.status, "started");
  for (const call of w.log) for (const arg of call) assert.ok(!/\$\(|`|rm -rf|;\|/.test(arg), `leaked into ${call.join(" ")}`);
  // mode A: only inside tab.new's `task`
  const [tabNew] = newTabs(w.commands);
  assert.ok(tabNew.args.task.includes(evil));
  assert.ok(!/\$\(|`|rm -rf/.test(tabNew.args.folder + tabNew.args.name + tabNew.args.argv.join(" ")));
});

// ---- cancel always wins ----

const waitPolling = async (w) => {
  const polling = () => {
    const at = w.log.findIndex((c) => c.includes("herdr-issues-setup"));
    return at >= 0 && w.log.slice(at).some((c) => c[1] === "get");
  };
  for (let i = 0; i < 400 && !polling(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(polling());
};

test("cancel wins when the setup had already exited 0", async () => {
  const w = await world();
  w.hcOpts.onKill = (proc) => proc.release({ code: 0, stdout: "", stderr: "" }); // finished before the kill landed
  const holding = w.starter.start(task, { ...w.ctx, setupCommand: "hold" });
  await waitPolling(w);
  await w.starter.cancel("PAY-1");
  assert.deepEqual(await holding, { status: "failed", message: "Setup cancelled" });
  assert.equal(newTabs(w.commands).length, 0);
  assert.equal(JSON.parse(w.storage.getItem("issues.pendingSetup")).length, 1);
});

test("cancel wins when hc kill fails, and the failure is reported to the caller", async () => {
  const w = await world();
  let held;
  w.hcOpts.killCode = 1;
  w.hcOpts.onKill = (proc) => (held = proc); // the terminal keeps running
  const holding = w.starter.start(task, { ...w.ctx, setupCommand: "hold" });
  await waitPolling(w);
  await assert.rejects(w.starter.cancel("PAY-1"), /kill/);
  held.release({ code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await holding, { status: "failed", message: "Setup cancelled" });
  assert.equal(newTabs(w.commands).length, 0);
  assert.equal(JSON.parse(w.storage.getItem("issues.pendingSetup")).length, 1);
});

test("cancel before onStart kills the terminal as soon as it has an address", async () => {
  const w = await world();
  w.hcOpts.beforeSetupReply = () => void w.starter.cancel("PAY-1");
  const out = await w.starter.start(task, { ...w.ctx, setupCommand: "hold" });
  assert.deepEqual(out, { status: "failed", message: "Setup cancelled" });
  assert.ok(w.log.some((c) => c[0] === "hc" && c[1] === "kill"));
  assert.equal(newTabs(w.commands).length, 0);
});

test("a cancel record doesn't outlive its start", async () => {
  const w = await world();
  w.hcOpts.onKill = (proc) => proc.release({ code: 0, stdout: "", stderr: "" });
  const holding = w.starter.start(task, { ...w.ctx, setupCommand: "hold" });
  await waitPolling(w);
  await w.starter.cancel("PAY-1");
  await holding;
  const again = await w.starter.start(task, { ...w.ctx, setupCommand: "true" });
  assert.equal(again.status, "started");
});

// ---- start always resolves to an Outcome ----

test("a throwing spaces() is a failed outcome", async () => {
  const w = await world({ spacesThrows: true });
  const out = await w.starter.start(task, w.ctx);
  assert.equal(out.status, "failed");
  assert.match(out.message, /spaces are gone/);
  assert.equal(newTabs(w.commands).length, 0);
});

test("a throwing run on tab.new is a failed outcome, row and starting entry cleared", async () => {
  let boom = true;
  const w = await world({ runThrows: (name) => { if (boom && name === "tab.new") throw new Error("tab.new failed"); } });
  const out = await w.starter.start(task, w.ctx);
  assert.equal(out.status, "failed");
  assert.match(out.message, /tab.new failed/);
  assert.deepEqual(w.rows.at(-1), ["PAY-1", null]);
  boom = false;
  const again = await w.starter.start(task, w.ctx); // not "selected": the entry is gone
  assert.equal(again.status, "started");
});
