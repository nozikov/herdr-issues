// Task folders: git worktrees under <root>/<repo>/<branch>. Pure: no Node APIs, `exec` is
// injected (the runtime's exec rejects when a program can't start or takes over 30 s).
// The anti-goals: two tasks in one folder, a second copy of the same work, deleting anything
// but a clean linked worktree of this repo. On any doubt, refuse.
import { matchesTask } from "./names.js";

const git = (exec, cwd, ...args) => exec("git", args, { cwd });

// Real path of an existing folder, else null. There is no realpath without Node, so ask the OS.
async function realOf(exec, path) {
  try {
    const r = await exec("realpath", ["--", path], {});
    const out = (r.stdout ?? "").trim();
    return r.code === 0 && out ? out : null;
  } catch {
    return null;
  }
}

// Real path of a folder that may not exist yet: its parent's real path plus its name.
async function realOrParent(exec, path) {
  const whole = await realOf(exec, path);
  if (whole) return whole;
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  if (cut <= 0) return path;
  const parent = await realOf(exec, path.slice(0, cut));
  return parent ? `${parent}/${path.slice(cut + 1)}` : path;
}

const within = (path, dir) => path === dir || path.startsWith(`${dir.replace(/\/+$/, "")}/`);

// [{ path, branch (null when detached), main }] of `git worktree list`, prunable entries left out.
export async function listWorktrees(exec, main) {
  const r = await git(exec, main, "worktree", "list", "--porcelain");
  if (r.code !== 0) throw new Error(`git worktree list failed: ${(r.stderr || r.stdout).trim()}`);
  const out = [];
  for (const block of r.stdout.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const first = lines.find((l) => l.startsWith("worktree "));
    if (!first || lines.some((l) => l === "prunable" || l.startsWith("prunable "))) continue;
    const ref = lines.find((l) => l.startsWith("branch "));
    out.push({
      path: first.slice("worktree ".length),
      branch: ref ? ref.slice("branch ".length).replace(/^refs\/heads\//, "") : null,
      main: out.length === 0, // git lists the main working tree first
    });
  }
  return out;
}

const branchRefs = async (exec, main) => {
  const r = await git(exec, main, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  if (r.code !== 0) throw new Error(`git for-each-ref failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.split("\n").filter(Boolean);
};

// Linked worktrees on a branch under <root>/<repo>/: [{ branch, folder }], with the folder spelled
// from `root` as given, whatever real path git reports.
async function rootTrees(exec, repo, root) {
  const realRoot = (await realOf(exec, root)) ?? root;
  const base = root.replace(/\/+$/, "");
  const prefixes = [...new Set([`${realRoot}/${repo.name}/`, `${base}/${repo.name}/`])];
  const trees = [];
  for (const w of await listWorktrees(exec, repo.main)) {
    const prefix = prefixes.find((p) => w.path.startsWith(p));
    if (!w.main && w.branch && prefix) trees.push({ branch: w.branch, folder: `${base}/${repo.name}/${w.path.slice(prefix.length)}` });
  }
  return trees;
}

// The folders of many tasks from one look at the worktrees: Map key -> [folder], only keys that
// have one. A task normally has one folder; several are for the caller to refuse to guess at.
export async function taskFolders(exec, repo, keys, root) {
  const trees = await rootTrees(exec, repo, root);
  const out = new Map();
  for (const key of keys) {
    const folders = trees.filter((t) => matchesTask(t.branch, key)).map((t) => t.folder);
    if (folders.length) out.set(key, folders);
  }
  return out;
}

// The folder and branch a task already has, found by its key, so a title edited in the tracker
// doesn't make a second copy of the work. Returns { branch, folder|null }, { ambiguous: [branches] }
// when several match and `preferred` (the computed branch name) isn't one of them, or null when
// nothing matches. One worktree under root wins, then `preferred`, then a single matching branch.
export async function findExisting(exec, repo, key, root, preferred) {
  const trees = (await rootTrees(exec, repo, root)).filter((t) => matchesTask(t.branch, key));
  const pick = (items, toResult) => {
    if (items.length === 1) return toResult(items[0]);
    const want = items.find((i) => (i.branch ?? i) === preferred);
    return want ? toResult(want) : { ambiguous: items.map((i) => i.branch ?? i).sort() };
  };
  if (trees.length) return pick(trees, (t) => t);
  const branches = (await branchRefs(exec, repo.main)).filter((b) => matchesTask(b, key));
  return branches.length ? pick(branches, (b) => ({ branch: b, folder: null })) : null;
}

const exists = async (exec, main, ref) => (await git(exec, main, "rev-parse", "--verify", "--quiet", ref)).code === 0;

// Makes the folder a worktree on `branch`. A new branch starts at <remote>/<base> after a fetch,
// or at the local <base> (with a warning) when the fetch fails. An existing branch is checked
// out as it is. Reuses a folder that is already this worktree. `longRun(argv, cwd)` runs the
// slow `git worktree add` to its end: Promise<{code, output}>.
// Resolves { created, warning }; rejects with a readable Error.
export async function ensureWorktree(exec, { repo, remote, base, branch, folder, longRun }) {
  const main = repo.main;
  // Names are data: none of them may become a git option.
  for (const [what, value] of [["branch", branch], ["base branch", base], ["remote", remote ?? ""]])
    if (/^-/.test(value)) throw new Error(`Bad ${what} name: ${value}`);
  if (!branch || (await git(exec, main, "check-ref-format", `refs/heads/${branch}`)).code !== 0)
    throw new Error(`"${branch}" is not a valid branch name`);

  await git(exec, main, "worktree", "prune");

  const mine = new Set([folder, await realOrParent(exec, folder)]);
  const list = await listWorktrees(exec, main);
  const here = list.find((w) => mine.has(w.path));
  if (here) {
    if (here.branch === branch) return { created: false, warning: null };
    throw new Error(`Folder ${folder} already holds a worktree on ${here.branch ?? "a detached HEAD"}, not on ${branch}`);
  }
  const elsewhere = list.find((w) => w.branch === branch);
  if (elsewhere?.main) throw new Error(`Branch ${branch} is checked out in the main checkout (${elsewhere.path}). Switch it there first.`);
  if (elsewhere) throw new Error(`Branch ${branch} is already checked out in ${elsewhere.path}`);

  let warning = null;
  let argv;
  if (await exists(exec, main, `refs/heads/${branch}`)) {
    argv = ["git", "worktree", "add", "--", folder, branch];
  } else {
    let start = null;
    if (remote) {
      let fetched = false;
      try {
        fetched = (await git(exec, main, "fetch", "--", remote, base)).code === 0;
      } catch {
        // timed out or couldn't start: same as a failed fetch
      }
      if (fetched && (await exists(exec, main, `refs/remotes/${remote}/${base}`))) start = `${remote}/${base}`;
      else warning = `Could not fetch ${remote}, so the branch starts at the local ${base}`;
    }
    if (!start) {
      if (!(await exists(exec, main, `refs/heads/${base}`))) throw new Error(`Branch ${base} not found, nothing to start ${branch} from`);
      start = base;
    }
    argv = ["git", "worktree", "add", "--no-track", "-b", branch, "--", folder, start];
  }

  const r = await longRun(argv, main);
  if (r.code !== 0)
    throw new Error(`git worktree add failed for folder ${folder}: ${(r.output ?? "").trim() || "it did not finish"}`);
  return { created: true, warning };
}

// Names that are plainly built again by a tool, so the question doesn't list them.
const GENERATED = new Set(["node_modules", "target", "build", "dist", ".gradle", ".venv"]);
const NAMES_SHOWN = 5;

// Ignored files that removing the folder would lose, sorted; a folder of them is one name, under the pattern that matched. null
// when git can't say. `-z` keeps a name with a space as it is.
export async function ignoredFiles(exec, folder) {
  const r = await git(exec, folder, "status", "--porcelain", "-z", "--ignored=matching");
  if (r.code !== 0) return null;
  return r.stdout.split("\0").filter((e) => e.startsWith("!! ")).map((e) => e.slice(3))
    .filter((name) => !name.split("/").some((part) => GENERATED.has(part))).sort();
}

export function removeQuestion(folder, ignored) {
  const question = `Remove ${folder}? The branch stays.`;
  if (!ignored.length) return question;
  const more = ignored.length - NAMES_SHOWN;
  return `${question} Ignored files go too: ${ignored.slice(0, NAMES_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

// Removes a clean linked worktree of this repo under `root`; the branch stays. Anything doubtful
// is a refusal: { ok: false, reason }. busyCwds are the working folders of open terminals.
export async function removeFolder(exec, { repo, folder, root, busyCwds, ignored = [] }) {
  const refuse = (reason) => ({ ok: false, reason });
  try {
    const realFolder = await realOf(exec, folder);
    const realRoot = await realOf(exec, root);
    if (!realFolder || !realRoot) return refuse(`Can't resolve ${folder}, leaving it alone`);
    if (realFolder === realRoot || !within(realFolder, realRoot)) return refuse(`${folder} is outside ${root}, leaving it alone`);

    const entry = (await listWorktrees(exec, repo.main)).find((w) => w.path === realFolder || w.path === folder);
    if (!entry) return refuse(`${folder} is not a worktree of this repository`);
    if (entry.main) return refuse(`${folder} is the main checkout`);

    for (const cwd of busyCwds ?? []) {
      const plain = cwd.replace(/\/+$/, "");
      const real = (await realOf(exec, plain)) ?? plain;
      if ([plain, real].some((c) => within(c, realFolder) || within(c, folder.replace(/\/+$/, ""))))
        return refuse(`A terminal is open in ${folder}. Close its tab first.`);
    }

    const status = await git(exec, realFolder, "status", "--porcelain", "--untracked-files=all");
    if (status.code !== 0) return refuse(`Can't check ${folder}: ${(status.stderr || status.stdout).trim()}`);
    if (status.stdout.trim()) return refuse(`${folder} has uncommitted or untracked files`);

    // `git worktree remove` takes ignored files without a word, so they go only if they were shown.
    const now = await ignoredFiles(exec, realFolder);
    if (!now) return refuse(`Can't check the ignored files of ${folder}`);
    if (now.join("\0") !== [...ignored].sort().join("\0")) return refuse(`${folder}: the ignored files changed since you confirmed, so nothing was removed.`);

    const removed = await git(exec, repo.main, "worktree", "remove", "--", realFolder);
    if (removed.code !== 0) return refuse(`git worktree remove failed: ${(removed.stderr || removed.stdout).trim()}`);
    return { ok: true };
  } catch (e) {
    return refuse(`Can't check ${folder}: ${e?.message ?? e}`);
  }
}
