// Which project a space belongs to and which source serves it. Pure: no Node APIs,
// `exec` is injected. The runtime's exec rejects when a program can't start or takes
// over 30 s; every helper here treats that as "not available" (null).

// The folder a space sits in: its first terminal's cwd, else the space's own.
export function placeOf(space, panes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return (panes ?? []).find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

async function run(exec, cmd, args, cwd) {
  try {
    const r = await exec(cmd, args, { cwd });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// The git repo of a folder, a linked worktree counting as its main checkout:
// { top, main, name, linked }, or null outside git.
export async function repoOf(exec, folder) {
  const top = await run(exec, "git", ["rev-parse", "--show-toplevel"], folder);
  const common = await run(exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], folder);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

// "git@host:o/r.git", "https://host/o/r", "ssh://git@host:22/o/r.git/" -> { host, owner, name }.
export function parseRemote(url) {
  const s = String(url).trim();
  const m = /^[\w.-]+@([^:/]+):(.+)$/.exec(s) ?? /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(s);
  if (!m) return null;
  const parts = m[2].replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { host: m[1], owner: parts[0], name: parts[1] };
}

// The GitHub repo of a project: { host, owner, name, remote, repoRef }, or null.
// `gh repo set-default` wins, else origin, else the only GitHub remote, whatever its name. Several
// and no origin aren't guessed: { several: true }. A github.com remote counts as is; any other
// host only if gh is logged in to it. repoRef is what goes after `-R`.
export async function resolveGithub(exec, main, ghBin) {
  const listed = await run(exec, "git", ["remote", "-v"], main);
  if (!listed.ok) return null;
  const remotes = []; // origin first, then the rest in git's order
  for (const line of listed.out.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    const parsed = m && parseRemote(m[2]);
    if (parsed) remotes.push({ remote: m[1], ...parsed });
  }
  remotes.sort((a, b) => (b.remote === "origin") - (a.remote === "origin"));

  const hosts = new Map();
  const usable = async (host) => {
    if (host === "github.com") return true;
    if (!hosts.has(host)) hosts.set(host, (await run(exec, ghBin, ["auth", "status", "--hostname", host], main)).ok);
    return hosts.get(host);
  };
  const result = (r) => ({
    host: r.host, owner: r.owner, name: r.name, remote: r.remote,
    repoRef: r.host === "github.com" ? `${r.owner}/${r.name}` : `${r.host}/${r.owner}/${r.name}`,
  });

  // "owner/name", or "host/owner/name" for another host.
  const set = await run(exec, ghBin, ["repo", "set-default", "--view"], main);
  const want = set.ok ? set.out.split("/") : [];
  if (want.length === 2 || want.length === 3) {
    const [name, owner, host] = [...want].reverse();
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    const hit = remotes.find((r) => same(r.owner, owner) && same(r.name, name) && (!host || same(r.host, host)));
    if (hit && (await usable(hit.host))) return result(hit);
  }
  const found = [];
  for (const r of remotes) if (await usable(r.host)) found.push(r);
  if (found[0]?.remote === "origin") return result(found[0]); // sorted first
  if (found.length > 1) return { several: true };
  return found.length ? result(found[0]) : null;
}

// Jira when the project's entry says so, with or without a site and a home project yet; otherwise
// GitHub if there is one.
export function chooseSource(entry, github) {
  if (entry?.source === "jira") return { kind: "jira", entry };
  return github ? { kind: "github", github } : { kind: "setup" };
}

// The branch new work starts from: the remote's HEAD, then gh (`ghInfo` = { bin, repoRef }),
// then a local or remote-tracking main/master. null if none of them answers.
export async function defaultBranch(exec, main, remote, ghInfo) {
  const head = await run(exec, "git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], main);
  const prefix = `${remote}/`;
  if (head.ok && head.out.startsWith(prefix) && head.out.length > prefix.length) return head.out.slice(prefix.length);

  if (ghInfo) {
    const view = await run(exec, ghInfo.bin, ["repo", "view", "-R", ghInfo.repoRef, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], main);
    if (view.ok && view.out) return view.out;
  }
  for (const name of ["main", "master"])
    for (const ref of [`refs/remotes/${remote}/${name}`, `refs/heads/${name}`])
      if ((await run(exec, "git", ["rev-parse", "--verify", "--quiet", ref], main)).ok) return name;
  return null;
}
