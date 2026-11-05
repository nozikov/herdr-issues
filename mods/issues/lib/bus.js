// Between the panel and its task window, which are two copies of this mod. Pure: no Node APIs.
//
// The window can't read settings and holds no source, so the panel does the work. Tracker text
// stays off the disk, and `shared` is written to shared.json:
// - the task goes in the overlay's props;
// - comments go through memory, as a promise. Copies of a mod share it (AGENTS.md: "a shared
//   promise"). With none to claim, the window says it couldn't load them;
// - Start and Remove folder go through `shared` as a signal that holds no tracker text: which
//   panel, which of its windows, what to do. The panel knows the task, the context and the folder.
import { branchName } from "./names.js";

export const SIGNAL = "issues.window";

const SLOT = Symbol.for("herdr.issues.handover");
const box = () => (globalThis[SLOT] ??= new Map());

export function offer(id, promise) {
  box().set(id, promise);
}

// The promise, once; null when there is none.
export function claim(id) {
  const promise = box().get(id) ?? null;
  box().delete(id);
  return promise;
}

// The action this panel must take, or null. The panel's id is new each start, so a signal that
// outlived a restart in shared.json does nothing.
export function signalFor(signal, panel, opened) {
  if (!opened || signal?.panel !== panel || signal.n !== opened.n) return null;
  return signal.action === "start" || signal.action === "remove" ? signal.action : null;
}

// What a window's request comes to, on the panel's own data: { go, task, context, folder? } or a
// { line } that says why not. A task only ever starts in the repo and the space it was listed for.
export function windowRequest({ action, opened, current, tasks, folders }) {
  const { key } = opened.task;
  const { context } = opened;
  if (current?.repo?.main !== context.repo.main || current.spaceId !== context.spaceId) return { line: `${key} belongs to another project or space, so nothing was done.` };
  const task = tasks.find((t) => t.key === key);
  if (!task) return { line: `${key} is no longer in the list, so nothing was done.` };
  if (action === "start") return { go: "start", task, context };
  const found = folders.get(key) ?? [];
  if (found.length !== 1) return { line: `${key}: no single folder to remove.` };
  // The window asked about `opened.folders`: what was confirmed is what goes, or nothing does.
  const shown = opened.folders ?? [];
  if (shown.length !== 1 || shown[0] !== found[0]) return { line: `${key}: the folder changed since you confirmed, so nothing was removed.` };
  if (!opened.ignored) return { line: `${key}: couldn't check its ignored files, so nothing was removed.` };
  return { go: "remove", task, context, folder: found[0], ignored: opened.ignored };
}

// The overlay's props: what the window draws. `body` is the agent's text and stays behind.
export function windowProps({ task, panel, n, comments, folders, ignored, hasWork, busy }) {
  const { key, title, url, state, priority, assignee, labels, updatedAt, markdown } = task;
  return {
    view: "task", panel, n, comments, folders, ignored, hasWork, busy,
    branch: branchName(key, title),
    task: { key, title, url, state, priority, assignee, labels, updatedAt, markdown },
  };
}
