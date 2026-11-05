// When the panel refreshes, and what it says when it cannot show tasks.
// Pure: no Node APIs, the Herdr runtime has none.

export const INTERVAL = 300000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// True when the layout's panel column is open and shows the issues panel.
// The panel sits deep in the tree (root > work > work-body > panel), so search by id.
export function isPanelVisible(layoutRoot) {
  const panel = find(layoutRoot, "panel");
  if (!panel || panel.hidden) return false;
  return find(panel, "panel-body")?.active === "issues";
}

export function shouldRefresh({ visible, wasVisible, contextChanged, lastAt, now, busy }) {
  if (!visible || busy) return false;
  return !wasVisible || contextChanged || now - lastAt >= INTERVAL;
}

// The `tabs` mod closes a panel it doesn't know on spaces where it wasn't opened. The list with
// issues added, or null when it's there already. Anything but a list counts as the shipped default.
export function panelsWithIssues(panels) {
  const list = Array.isArray(panels) ? panels : ["files", "changes"];
  return list.includes("issues") ? null : [...list, "issues"];
}

export const NOTE = "Showing the last tasks: couldn't refresh";

// A good result clears note and error; a failed one keeps the rows and notes it,
// or, with no rows to keep, raises the error.
export function applyResult(view, result) {
  if (result.error) {
    if (view.tasks.length > 0) return { ...view, note: NOTE, error: null };
    return { ...view, note: null, error: result.error };
  }
  return { tasks: result.tasks, note: null, error: null };
}

const MESSAGES = {
  noProject: { title: "No project in this space", body: "Open a space that has a git project, or add a folder with a git repository to it." },
  noRemote: { title: "No GitHub remote", body: "This repository has no github.com remote. Add one in a terminal, then refresh.", detail: "git remote add origin git@github.com:OWNER/REPO.git" },
  severalRemotes: { title: "Several GitHub remotes", body: "None of them is origin, so the panel won't guess. Pick one in a terminal, then refresh.", detail: "gh repo set-default" },
  remote: { title: "Issues works in local spaces only", body: "Switch to a local space to see its tasks." },
  ghAuth: { title: "Not logged in to GitHub", body: "Run `gh auth login` in a terminal, then refresh." },
  jiraAuth: { title: "Jira token missing or rejected", body: "Check the token command and the site in the settings (gear icon), then refresh." },
  network: { title: "Can't reach the tracker", body: "Check your connection or VPN, then refresh." },
  noTasks: { title: "No tasks", body: "Nothing matches the filters. Try wider ones." },
  other: { title: "Something went wrong", body: "Refresh to try again. If it keeps failing, check the project settings." },
};

// Fixed wording only: error text from a source is never included.
export function panelMessage(state) {
  return MESSAGES[state] ?? null;
}
