// Branch and worktree names. Pure: no Node APIs, the Herdr runtime has none.
const MAX_BRANCH = 50;

const trimDashes = (s) => s.replace(/^-+|-+$/g, "");

// "#412" -> "412"; anything outside [A-Za-z0-9] becomes "-", so the result is safe in a ref name.
export function safeKey(key) {
  return trimDashes(String(key).replace(/[^A-Za-z0-9]+/g, "-"));
}

// "<key>-<slug of title>", at most 50 characters. The key is never cut.
export function branchName(key, title) {
  const k = safeKey(key);
  const slug = trimDashes(String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  const room = MAX_BRANCH - k.length - 1;
  const cut = room > 0 ? trimDashes(slug.slice(0, room)) : "";
  return cut ? `${k}-${cut}` : k;
}

export const worktreeRoot = (home) => `${home}/.herdr/worktrees`;

export const worktreeFolder = (home, repoName, branch) => `${worktreeRoot(home)}/${repoName}/${branch}`;

// True when the branch starts with the task key as a whole word: "4120-x" is not task 412,
// and "413-regression-from-412" is not either.
export function matchesTask(branch, key) {
  const k = safeKey(key);
  return k !== "" && (branch === k || branch.startsWith(`${k}-`));
}
