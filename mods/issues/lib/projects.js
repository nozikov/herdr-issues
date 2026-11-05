// Jira projects among the tasks of one repo: the filter row, the order, the question before ▶.
// Pure: no Node APIs, the Herdr runtime has none. A task's key is untrusted text from the tracker.
import { isProjectKey } from "./jql.js";

// "PAY" from "PAY-431", "" for "#12" or anything else.
export function taskProject(key) {
  const project = /^(.+)-\d+$/.exec(String(key ?? ""))?.[1];
  return isProjectKey(project) ? project : "";
}

// The projects of the tasks and of `known`, each once, sorted.
export function projectsIn(tasks, known = []) {
  return [...new Set([...known, ...tasks.map((t) => taskProject(t.key))])].filter(isProjectKey).sort();
}

// Home project tasks first, each group in the order it came in.
export function homeFirst(tasks, home) {
  const isHome = (t) => taskProject(t.key) === home;
  return home ? [...tasks.filter(isHome), ...tasks.filter((t) => !isHome(t))] : [...tasks];
}

// True when ▶ must ask first, because the task may not belong in this repo. GitHub issues do.
export function needsAsking({ task, home, resuming, askOff }) {
  if (String(task.key).startsWith("#") || resuming || askOff) return false;
  return !home || taskProject(task.key) !== home;
}

// The key of the question still open once the rows changed: it follows its task, and goes with it.
export function stillAsked(key, tasks) {
  return tasks.some((t) => t.key === key) ? key : null;
}

// The filters for a load in this context. The picked project belongs to the repo. Without one, a
// Jira list stays on "me", so the panel never asks for every task on the site.
export function filtersFor(filters, context) {
  const project = context.filter ?? "";
  return { ...filters, project, assignee: project || context.github ? filters.assignee : "me" };
}
