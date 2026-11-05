import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listWorktrees, findExisting, taskFolders, ensureWorktree, removeFolder, ignoredFiles, removeQuestion } from "../lib/worktree.js";
import { nodeExec, tempRepo } from "./_util.js";

// Every git call of the whole file, to check that none carries --force.
const seen = [];
const exec = async (cmd, args, opts) => {
  seen.push([cmd, ...args]);
  return nodeExec(cmd, args, opts);
};
// The long-running runner over nodeExec: same shape as runToEnd's result.
const longRun = async (argv, cwd) => {
  seen.push(argv);
  const r = await nodeExec(argv[0], argv.slice(1), { cwd });
  return { code: r.code, output: r.stdout + r.stderr };
};

const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) => nodeExec("git", [...ID, ...args], { cwd });
const rev = async (cwd, ref) => (await git(cwd, "rev-parse", ref)).stdout.trim();
const tmp = async (prefix) => realpath(await mkdtemp(join(tmpdir(), prefix)));
const toClean = [];
after(async () => {
  for (const d of toClean) await rm(d, { recursive: true, force: true });
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter((c) => c.some((a) => /^--force$|^-f$/.test(a))), []);
});

// A repo with a bare `origin`, a root for worktrees and the args every call needs.
async function setup() {
  const r = await tempRepo();
  const origin = await tmp("issues-origin-");
  const root = await tmp("issues-root-");
  toClean.push(r.dir, origin, root);
  await nodeExec("git", ["clone", "-q", "--bare", r.dir, origin]);
  await r.git("remote", "add", "origin", origin);
  await r.git("fetch", "-q", "origin");
  const repo = { top: r.dir, main: r.dir, name: basename(r.dir), linked: false };
  const branch = "412-fix-login";
  const folder = join(root, repo.name, branch);
  const args = { repo, remote: "origin", base: "main", branch, folder, longRun };
  return { repo, origin, root, branch, folder, args, g: r.git };
}

// Moves origin/main one commit ahead of the local main.
async function advanceOrigin(origin) {
  const other = await tmp("issues-other-");
  toClean.push(other);
  await nodeExec("git", ["clone", "-q", origin, other]);
  await git(other, "commit", "-q", "--allow-empty", "-m", "ahead");
  await git(other, "push", "-q", "origin", "main");
}

test("new branch starts at the fetched remote default, with no upstream", async () => {
  const s = await setup();
  await advanceOrigin(s.origin);
  const r = await ensureWorktree(exec, s.args);
  assert.deepEqual(r, { created: true, warning: null });
  assert.equal(await rev(s.folder, "HEAD"), await rev(s.origin, "main"));
  assert.notEqual(await rev(s.folder, "HEAD"), await rev(s.repo.main, "main"));
  assert.notEqual((await git(s.folder, "config", `branch.${s.branch}.remote`)).code, 0);
  assert.equal((await git(s.folder, "symbolic-ref", "--short", "HEAD")).stdout.trim(), s.branch);
});

test("fetch failure uses local default and warns", async () => {
  const s = await setup();
  await s.g("remote", "set-url", "origin", join(s.root, "no-such-remote"));
  const r = await ensureWorktree(exec, s.args);
  assert.equal(r.created, true);
  assert.match(r.warning, /local/i);
  assert.equal(await rev(s.folder, "HEAD"), await rev(s.repo.main, "main"));
});

test("fetch timing out counts as fetch failure", async () => {
  const s = await setup();
  await advanceOrigin(s.origin);
  const timingOut = async (cmd, a, opts) => {
    if (cmd === "git" && a.includes("fetch")) throw new Error("timed out after 30s");
    return exec(cmd, a, opts);
  };
  const r = await ensureWorktree(timingOut, s.args);
  assert.equal(r.created, true);
  assert.match(r.warning, /local/i);
  assert.equal(await rev(s.folder, "HEAD"), await rev(s.repo.main, "main"));
});

test("an existing branch is checked out, not reset", async () => {
  const s = await setup();
  await s.g("branch", s.branch);
  await s.g("checkout", "-q", s.branch);
  await s.g("commit", "-q", "--allow-empty", "-m", "work");
  await s.g("checkout", "-q", "main");
  const before = await rev(s.repo.main, s.branch);
  assert.notEqual(before, await rev(s.repo.main, "main"));
  const r = await ensureWorktree(exec, s.args);
  assert.equal(r.created, true);
  assert.equal(await rev(s.folder, "HEAD"), before);
  assert.equal(await rev(s.repo.main, s.branch), before);
});

test("an existing worktree is reused", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  assert.equal((await ensureWorktree(exec, s.args)).created, false);
});

test("two tasks get two folders and branches", async () => {
  const s = await setup();
  const other = { ...s.args, branch: "413-other", folder: join(s.root, s.repo.name, "413-other") };
  assert.equal((await ensureWorktree(exec, s.args)).created, true);
  assert.equal((await ensureWorktree(exec, other)).created, true);
  const list = await listWorktrees(exec, s.repo.main);
  assert.deepEqual(list.map((w) => w.branch).sort(), ["412-fix-login", "413-other", "main"]);
  assert.deepEqual(list.filter((w) => w.main).map((w) => w.path), [s.repo.main]);
});

test("a folder deleted by hand is recreated", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  await rm(s.folder, { recursive: true });
  const r = await ensureWorktree(exec, s.args);
  assert.equal(r.created, true);
  assert.ok(existsSync(join(s.folder, ".git")));
  assert.equal((await git(s.folder, "symbolic-ref", "--short", "HEAD")).stdout.trim(), s.branch);
});

test("a folder holding another repo is refused and left alone", async () => {
  const s = await setup();
  const foreign = await tempRepo();
  toClean.push(foreign.dir);
  await mkdir(join(s.root, s.repo.name), { recursive: true });
  await nodeExec("git", ["clone", "-q", foreign.dir, s.folder]);
  await writeFile(join(s.folder, "other-file"), "x");
  await assert.rejects(ensureWorktree(exec, s.args), /folder/i);
  assert.ok(existsSync(join(s.folder, "other-file")));
  assert.equal((await listWorktrees(exec, s.repo.main)).length, 1);
});

test("a branch checked out in the main checkout is refused in words", async () => {
  const s = await setup();
  await assert.rejects(ensureWorktree(exec, { ...s.args, branch: "main" }), /main checkout/);
  assert.ok(!existsSync(s.folder));
});

test("a branch checked out in another worktree is refused in words", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  const elsewhere = join(s.root, s.repo.name, "elsewhere");
  await assert.rejects(ensureWorktree(exec, { ...s.args, folder: elsewhere }), /already checked out/);
  assert.ok(!existsSync(elsewhere));
});

test("a failing git worktree add is reported with its output", async () => {
  const s = await setup();
  const failing = async (argv) => ({ code: 128, output: "fatal: disk on fire" });
  await assert.rejects(ensureWorktree(exec, { ...s.args, longRun: failing }), /disk on fire/);
  const killed = async () => ({ code: null, output: "" });
  await assert.rejects(ensureWorktree(exec, { ...s.args, longRun: killed }), /git worktree add/);
});

test("a branch name can't turn into an option", async () => {
  const s = await setup();
  await assert.rejects(ensureWorktree(exec, { ...s.args, branch: "--detach", folder: join(s.root, "x") }));
  assert.ok(!existsSync(join(s.root, "x")));
});

test("listWorktrees skips prunable entries", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  await rm(s.folder, { recursive: true });
  const list = await listWorktrees(exec, s.repo.main);
  assert.deepEqual(list.map((w) => w.branch), ["main"]);
});

test("title edited in the tracker: the old folder and branch come back", async () => {
  const s = await setup();
  const old = { ...s.args, branch: "412-old-title", folder: join(s.root, s.repo.name, "412-old-title") };
  await ensureWorktree(exec, old);
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root), { branch: "412-old-title", folder: old.folder });
});

test("a worktree of another task or of a longer number doesn't match", async () => {
  const s = await setup();
  await ensureWorktree(exec, { ...s.args, branch: "4120-other", folder: join(s.root, s.repo.name, "4120-other") });
  assert.equal(await findExisting(exec, s.repo, "#412", s.root), null);
});

test("taskFolders finds every task's folders from one worktree list", async () => {
  const s = await setup();
  const add = (branch) => ensureWorktree(exec, { ...s.args, branch, folder: join(s.root, s.repo.name, branch) });
  await add("412-one");
  await add("412-two");
  await add("4120-other");
  await add("7-seven");
  const before = seen.filter((c) => c.includes("list")).length;
  const found = await taskFolders(exec, s.repo, ["#412", "#7", "#8"], s.root);
  assert.equal(seen.filter((c) => c.includes("list")).length, before + 1);
  assert.deepEqual([...found.keys()], ["#412", "#7"]);
  assert.deepEqual(found.get("#412").sort(), [join(s.root, s.repo.name, "412-one"), join(s.root, s.repo.name, "412-two")]);
  assert.deepEqual(found.get("#7"), [join(s.root, s.repo.name, "7-seven")]);
});

test("title edited, folder removed: a single matching branch comes back", async () => {
  const s = await setup();
  await s.g("branch", "412-old-title");
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root), { branch: "412-old-title", folder: null });
});

test("two matching branches and no worktree: no guess, reported as ambiguous", async () => {
  const s = await setup();
  await s.g("branch", "412-old-title");
  await s.g("branch", "412-newer-title");
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root), { ambiguous: ["412-newer-title", "412-old-title"] });
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root, "412-other"), { ambiguous: ["412-newer-title", "412-old-title"] });
});

test("several matches: the computed branch name wins when it is one of them", async () => {
  const s = await setup();
  await s.g("branch", "412-old-title");
  await s.g("branch", "412-newer-title");
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root, "412-newer-title"), { branch: "412-newer-title", folder: null });
  for (const b of ["412-old-title", "412-newer-title"]) await ensureWorktree(exec, { ...s.args, branch: b, folder: join(s.root, s.repo.name, b) });
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root), { ambiguous: ["412-newer-title", "412-old-title"] });
  assert.deepEqual(await findExisting(exec, s.repo, "#412", s.root, "412-old-title"), { branch: "412-old-title", folder: join(s.root, s.repo.name, "412-old-title") });
});

test("a task whose number only appears later in another branch name doesn't match", async () => {
  const s = await setup();
  const b = "413-regression-from-412";
  await ensureWorktree(exec, { ...s.args, branch: b, folder: join(s.root, s.repo.name, b) });
  assert.equal(await findExisting(exec, s.repo, "#412", s.root), null);
});

test("a failing for-each-ref or worktree list rejects instead of saying nothing is there", async () => {
  const s = await setup();
  const failing = (word) => async (cmd, a, opts) =>
    a.includes(word) ? { code: 128, stdout: "", stderr: "fatal" } : exec(cmd, a, opts);
  await assert.rejects(findExisting(failing("for-each-ref"), s.repo, "#412", s.root), /for-each-ref/);
  await assert.rejects(findExisting(failing("worktree"), s.repo, "#412", s.root), /worktree list/);
});

test("remove: clean folder goes, branch stays", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  assert.deepEqual(await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [] }), { ok: true });
  assert.ok(!existsSync(s.folder));
  assert.equal((await s.g("rev-parse", "--verify", s.branch)).code, 0);
});

test("remove refuses uncommitted and untracked files", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  const a = { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [] };
  await writeFile(join(s.folder, "new.txt"), "x");
  let r = await removeFolder(exec, a);
  assert.equal(r.ok, false);
  assert.match(r.reason, /uncommitted/i);
  assert.ok(existsSync(s.folder));

  await rm(join(s.folder, "new.txt"));
  await writeFile(join(s.folder, "tracked.txt"), "x");
  await git(s.folder, "add", "tracked.txt");
  await git(s.folder, "commit", "-q", "-m", "tracked");
  await writeFile(join(s.folder, "tracked.txt"), "changed");
  r = await removeFolder(exec, a);
  assert.equal(r.ok, false);
  assert.match(r.reason, /uncommitted/i);
  assert.ok(existsSync(join(s.folder, "tracked.txt")));
});

test("remove refuses when a terminal is in the folder or below it", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  await mkdir(join(s.folder, "src"));
  for (const cwd of [s.folder, `${s.folder}/src`]) {
    const r = await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [cwd] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Close its tab first/);
    assert.ok(existsSync(s.folder));
  }
});

test("a sibling folder with a shared prefix doesn't count as busy", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  const r = await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [`${s.folder}-2`] });
  assert.equal(r.ok, true);
});

test("remove refuses the main checkout", async () => {
  const s = await setup();
  const r = await removeFolder(exec, { repo: s.repo, folder: s.repo.main, root: s.repo.main, busyCwds: [] });
  assert.equal(r.ok, false);
  assert.ok(existsSync(join(s.repo.main, ".git")));
  // also when the root is set wide enough to contain it
  const wide = await removeFolder(exec, { repo: s.repo, folder: s.repo.main, root: join(s.repo.main, ".."), busyCwds: [] });
  assert.equal(wide.ok, false);
  assert.ok(existsSync(join(s.repo.main, ".git")));
});

test("remove refuses a folder outside the root, also through ..", async () => {
  const s = await setup();
  const outside = join(s.root, "..", `${basename(s.root)}-elsewhere`, "wt");
  await mkdir(join(outside, ".."), { recursive: true });
  toClean.push(join(outside, ".."));
  await s.g("worktree", "add", "-q", "-b", "outside-branch", outside);
  for (const folder of [outside, `${s.root}/../${basename(s.root)}-elsewhere/wt`, `${s.root}/${s.repo.name}/../../${basename(s.root)}-elsewhere/wt`]) {
    const r = await removeFolder(exec, { repo: s.repo, folder, root: s.root, busyCwds: [] });
    assert.equal(r.ok, false);
    assert.ok(existsSync(outside));
  }
});

test("remove refuses a worktree of another repo", async () => {
  const s = await setup();
  const other = await tempRepo();
  toClean.push(other.dir);
  const folder = join(s.root, "other", "x");
  await other.git("worktree", "add", "-q", "-b", "x", folder);
  const r = await removeFolder(exec, { repo: s.repo, folder, root: s.root, busyCwds: [] });
  assert.equal(r.ok, false);
  assert.ok(existsSync(folder));
});

test("remove refuses a plain folder that isn't a worktree", async () => {
  const s = await setup();
  const folder = join(s.root, s.repo.name, "plain");
  await mkdir(folder, { recursive: true });
  const r = await removeFolder(exec, { repo: s.repo, folder, root: s.root, busyCwds: [] });
  assert.equal(r.ok, false);
  assert.ok(existsSync(folder));
});

test("a failing check refuses", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  const a = { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [] };
  const statusRejects = async (cmd, args, opts) => {
    if (args.includes("status")) throw new Error("timed out");
    return exec(cmd, args, opts);
  };
  let r = await removeFolder(statusRejects, a);
  assert.equal(r.ok, false);
  const statusFails = async (cmd, args, opts) =>
    args.includes("status") ? { code: 128, stdout: "", stderr: "fatal" } : exec(cmd, args, opts);
  r = await removeFolder(statusFails, a);
  assert.equal(r.ok, false);
  assert.ok(existsSync(s.folder));
});

// A task folder with ignored files in it. The exclude file is shared by every worktree.
async function withIgnored(...names) {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  await writeFile(join(s.repo.main, ".git", "info", "exclude"), ".env\nnotes.txt\ncache/\nnode_modules/\ntarget/\nbuild/\ndist/\n.gradle/\n.venv/\n");
  for (const name of names) {
    const path = join(s.folder, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "x");
  }
  return s;
}

test("ignored files are listed, without what is plainly generated", async () => {
  const s = await withIgnored(".env", "notes.txt", "cache/a", "cache/b", "node_modules/x/y.js", "target/a", "build/a", "dist/a", ".gradle/a", ".venv/a", "packages/app/node_modules/z.js");
  assert.deepEqual(await ignoredFiles(exec, s.folder), [".env", "cache/", "notes.txt"]);
});

test("a folder with no ignored files, or only generated ones, lists none", async () => {
  assert.deepEqual(await ignoredFiles(exec, (await withIgnored()).folder), []);
  assert.deepEqual(await ignoredFiles(exec, (await withIgnored("node_modules/a")).folder), []);
});

test("a name with a space stays whole", async () => {
  const s = await setup();
  await ensureWorktree(exec, s.args);
  await writeFile(join(s.repo.main, ".git", "info", "exclude"), "my notes.txt\n");
  await writeFile(join(s.folder, "my notes.txt"), "x");
  assert.deepEqual(await ignoredFiles(exec, s.folder), ["my notes.txt"]);
});

test("a folder git can't read gives no list", async () => {
  assert.equal(await ignoredFiles(async () => ({ code: 128, stdout: "", stderr: "fatal" }), "/nope"), null);
});

test("the question names ignored files, five at most", () => {
  assert.equal(removeQuestion("/f/1", []), "Remove /f/1? The branch stays.");
  assert.equal(removeQuestion("/f/1", [".env"]), "Remove /f/1? The branch stays. Ignored files go too: .env");
  assert.equal(removeQuestion("/f/1", ["a", "b", "c", "d", "e"]), "Remove /f/1? The branch stays. Ignored files go too: a, b, c, d, e");
  assert.equal(removeQuestion("/f/1", ["a", "b", "c", "d", "e", "f", "g"]), "Remove /f/1? The branch stays. Ignored files go too: a, b, c, d, e and 2 more");
});

test("remove goes ahead with the ignored files that were shown", async () => {
  const s = await withIgnored(".env", "node_modules/a");
  assert.deepEqual(await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [], ignored: [".env"] }), { ok: true });
  assert.ok(!existsSync(s.folder));
});

test("remove refuses when the ignored files changed since they were shown", async () => {
  const s = await withIgnored(".env", "notes.txt");
  const r = await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [], ignored: [".env"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nothing was removed/);
  assert.ok(existsSync(join(s.folder, ".env")));
});

test("remove with no list shown counts as none shown", async () => {
  const s = await withIgnored(".env");
  assert.equal((await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [] })).ok, false);
  assert.ok(existsSync(s.folder));
});

test("generated files changing is no reason to refuse", async () => {
  const s = await withIgnored("dist/a");
  assert.deepEqual(await removeFolder(exec, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [], ignored: [] }), { ok: true });
});

test("a list git can't give stops the removal", async () => {
  const s = await withIgnored();
  const failing = async (cmd, a, opts) => (a.includes("--ignored=matching") ? { code: 128, stdout: "", stderr: "fatal" } : exec(cmd, a, opts));
  assert.equal((await removeFolder(failing, { repo: s.repo, folder: s.folder, root: s.root, busyCwds: [], ignored: [] })).ok, false);
  assert.ok(existsSync(s.folder));
});
