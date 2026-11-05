// The ▶ flow: find or create a task's worktree and start an agent in a new tab.
// Pure: no Node APIs; every effect comes in through `deps`.
// The anti-goals: the wrong space, two tasks in one folder, a second copy of the work, task text
// reaching a shell, an agent started with an added flag.
import { branchName, worktreeFolder, worktreeRoot } from "./names.js";
import { buildPrompt } from "./prompt.js";
import { findExisting, ensureWorktree } from "./worktree.js";
import { runToEnd } from "./runner.js";
import { deliver } from "./deliver.js";

const PENDING = "issues.pendingSetup";

// The tab of this task in any space of the project. An unnamed tab shows its position,
// so "2" is not a task.
export function findStartedTab(spaces, projectSpaceIds, key) {
  for (const space of spaces ?? []) {
    if (!projectSpaceIds.has(space.id)) continue;
    const tab = (space.tabs ?? []).find((t) => t.named && t.name === key);
    if (tab) return { space, tab };
  }
  return null;
}

// Runs the project's setup command in the folder, to its end. Branch and folder are positional
// arguments of the shell ($1, $2); no task text goes in. { ok: true } or { ok: false, output }.
export async function runSetup({ hc, sleep, branch, folder, command, onStart }) {
  const r = await runToEnd({
    hc,
    sleep,
    cwd: folder,
    argv: ["sh", "-c", command, "herdr-issues-setup", branch, folder],
    onStart,
  });
  return r.code === 0 ? { ok: true } : { ok: false, output: r.output };
}

// Rejects when `hc kill` doesn't succeed, so the caller knows the setup may still be running.
export async function cancelSetup(hc, address) {
  const r = await hc(["kill", address]);
  if (r?.code !== 0) throw new Error(`hc kill ${address} failed: ${String(r?.stderr || r?.stdout || `exit code ${r?.code}`).trim()}`);
}

// Folders of open terminals: panes with a cwd, and terminals still live.
export function liveCwds(panes, terminals) {
  return [
    ...(panes ?? []).filter((p) => p.cwd).map((p) => p.cwd),
    ...(terminals ?? []).filter((t) => t.state === "live" && t.cwd).map((t) => t.cwd),
  ];
}

// deps = { exec, hc, run, spaces(), storage, home }
// ctx  = { space, repo, remote, base, projectSpaceIds, agentArgv, setupCommand, template,
//          sleep, onRow(key, "starting"|"setup"|null) }
// A starter lives as long as the panel. sleep and onRow come with each start, because they need
// the `cx` of the task running that start, which must not outlive it.
// Outcome: { status: "selected" } | { status: "started", warning } | { status: "failed", message, output? }
export function createStarter(deps) {
  const { exec, hc, run, storage, home } = deps;
  const starting = new Map(); // key -> promise of the ▶ in progress
  const setups = new Map(); // key -> address of its running setup terminal
  const cancelled = new Set(); // keys whose cancel was requested during the current start

  // The runtime's localStorage gives undefined as well as null; broken JSON counts as empty.
  const readPending = () => {
    try {
      const list = JSON.parse(storage.getItem(PENDING) ?? "[]");
      return Array.isArray(list) ? list.filter((f) => typeof f === "string") : [];
    } catch {
      return [];
    }
  };
  const writePending = (list) => {
    try {
      storage.setItem(PENDING, JSON.stringify(list));
    } catch {
      // can't be saved: the setup then may not run again
    }
  };

  const failed = (message, output) => (output === undefined ? { status: "failed", message } : { status: "failed", message, output });
  const errText = (e) => String(e?.message ?? e);

  async function begin(task, ctx) {
    const key = task.key;
    const { sleep, onRow } = ctx;
    const started = findStartedTab(await deps.spaces(), ctx.projectSpaceIds, key);
    if (started) {
      run("tab.select", { id: started.tab.id }); // switches the space too
      return { status: "selected" };
    }

    onRow(key, "starting");
    try {
      const { repo } = ctx;
      let found;
      try {
        found = await findExisting(exec, repo, key, worktreeRoot(home), branchName(key, task.title));
      } catch (e) {
        return failed(errText(e));
      }
      if (found?.ambiguous) return failed(`Several branches match ${key}: ${found.ambiguous.join(", ")}. Nothing was created.`);

      const branch = found?.branch ?? branchName(key, task.title);
      const folder = found?.folder ?? worktreeFolder(home, repo.name, branch);

      let made;
      try {
        made = await ensureWorktree(exec, {
          repo,
          remote: ctx.remote,
          base: ctx.base,
          branch,
          folder,
          longRun: (argv, cwd) => runToEnd({ hc, sleep, cwd, argv }),
        });
      } catch (e) {
        return failed(errText(e));
      }

      if (ctx.setupCommand && (made.created || readPending().includes(folder))) {
        const pending = readPending();
        if (!pending.includes(folder)) writePending([...pending, folder]);
        onRow(key, "setup");
        const result = await runSetup({
          hc,
          sleep,
          branch,
          folder,
          command: ctx.setupCommand,
          onStart: (address) => {
            setups.set(key, address);
            // Cancel came before the terminal had an address: kill it now.
            if (cancelled.has(key)) cancelSetup(hc, address).catch(() => {});
          },
        });
        setups.delete(key);
        // A requested cancel wins, whatever the setup ended with.
        if (cancelled.has(key)) return failed("Setup cancelled");
        if (!result.ok) return failed("Setup failed", result.output);
        writePending(readPending().filter((f) => f !== folder));
      }

      deliver({ run, space: ctx.space, name: key, folder, argv: ctx.agentArgv, task: buildPrompt(ctx.template, task) });
      return { status: "started", warning: made.warning };
    } finally {
      onRow(key, null);
    }
  }

  return {
    async start(task, ctx) {
      const running = starting.get(task.key);
      if (running) {
        await running.catch(() => {});
        return { status: "selected" };
      }
      // Always resolves to an Outcome.
      const p = begin(task, ctx).catch((e) => failed(errText(e)));
      starting.set(task.key, p);
      try {
        return await p;
      } finally {
        starting.delete(task.key);
        cancelled.delete(task.key);
        setups.delete(task.key);
      }
    },

    // Cancels the start of the task: its ▶ ends as "Setup cancelled" and the setup runs again
    // on the next ▶, because the folder stays pending. The request is recorded at once; the
    // terminal is killed now, or as soon as it has an address. Rejects when the kill fails.
    async cancel(key) {
      if (!starting.has(key)) return;
      cancelled.add(key);
      const address = setups.get(key);
      if (address) await cancelSetup(hc, address);
    },
  };
}
