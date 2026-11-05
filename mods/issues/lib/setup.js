// What the mod works out for itself, so connecting Jira takes one field.
// Pure: no Node APIs, `exec` is injected.

const MAX_GUESSES = 5;
const TOKEN_TAB = "Jira token";
const KEY_IN_BRANCH = /(?:^|[/_-])([A-Z][A-Z0-9_]+)-\d+/;

// `https://` is added when no scheme is typed; other schemes stay, for validateSite to refuse.
export function normalizeUrl(text) {
  const s = String(text).trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

// The host, lowercase, past any user@ and before any port, path, query or fragment. "" if none.
export function hostOf(url) {
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?([^/?#:]+)/i.exec(String(url))?.[1].toLowerCase() ?? "";
}

export function siteType(url) {
  return hostOf(url).endsWith(".atlassian.net") ? "cloud" : "server";
}

export function tokenItem(url) {
  return `herdr-issues-jira-${hostOf(url)}`;
}

export function tokenReadCommand(platform, item) {
  return platform === "macos" ? ["security", "find-generic-password", "-s", item, "-w"] : ["secret-tool", "lookup", "service", item];
}

// The system's own prompt asks for the token, so it is never a process argument: `-w` stays last.
export function tokenStoreCommand(platform, item) {
  return platform === "macos"
    ? ["security", "add-generic-password", "-U", "-a", "herdr-issues", "-s", item, "-w"]
    : ["secret-tool", "store", "--label=Herdr Issues Jira", "service", item];
}

export function siteFromUrl(text, platform) {
  const url = normalizeUrl(text);
  return { name: hostOf(url), url, type: siteType(url), email: "", tokenCommand: tokenReadCommand(platform, tokenItem(url)), allowInsecure: false };
}

// True when the site reads the keychain item Connect writes, so Connect can help.
export function usesKeychain(site, platform) {
  return JSON.stringify(site.tokenCommand) === JSON.stringify(tokenReadCommand(platform, tokenItem(site.url)));
}

const LONGEST_NAME = 64;

// False for what looks like a token rather than a name: too long, or long with nothing to separate
// words. Checked before any process starts, because a name becomes a process argument and is stored.
export function isKeychainItemName(text) {
  const s = String(text).trim();
  return s !== "" && s.length <= LONGEST_NAME && (s.length < 20 || /[-. ]/.test(s));
}

// True when what was typed as a token command has the shape of a token. It must not be saved or
// run: a command alone is a path, and a word that long is a path or an address.
export function looksLikeToken(argv) {
  if (argv.length === 1 && !/^(\/|\.\.?\/|~\/)/.test(argv[0])) return true;
  return argv.some((word) => word.length > LONGEST_NAME && !/[/:]/.test(word));
}

// The commands that show the token prompt, as [name, args] for `run`. An earlier token tab goes too:
// its prompt may have ended, leaving a shell, and this way there is one tab with a live prompt. It
// closes after the new one opens and without `confirmed`, because closing a space's last tab closes
// the space. Only in a local space, because the site reads this machine's keychain.
export function tokenTabCommands(space, folder, site, platform) {
  if (!space || space.machine) return [];
  const old = (space.tabs ?? []).filter((t) => t.named && t.name === TOKEN_TAB);
  return [
    ["tab.new", { name: TOKEN_TAB, space: space.id, folder, argv: tokenStoreCommand(platform, tokenItem(site.url)) }],
    ...old.map((t) => ["tab.close", { id: t.id }]),
  ];
}

export function tokenHint(type) {
  return type === "cloud"
    ? "Create an API token at id.atlassian.com, under Security. Connect opens a prompt to paste it into; it goes to your keychain."
    : "Create a token in Jira under Profile → Personal Access Tokens. Connect opens a prompt to paste it into; it goes to your keychain.";
}

// Project keys found in branch names, most frequent first, ties in branch order.
export function keyCandidates(branches) {
  const counts = new Map();
  for (const branch of branches) {
    const key = KEY_IN_BRANCH.exec(branch)?.[1];
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
}

// The first key from the branches that `exists` confirms, else null. `UTF-8-fix` looks like a key,
// so nothing counts unconfirmed. A rejection of `exists` goes through: the site didn't answer,
// which says nothing about the key.
export async function guessProjectKey(exec, main, exists) {
  let listed;
  try {
    listed = await exec("git", ["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: main });
  } catch {
    return null;
  }
  if (listed.code !== 0) return null;
  for (const key of keyCandidates(listed.stdout.split("\n")).slice(0, MAX_GUESSES)) {
    if (await exists(key)) return key;
  }
  return null;
}
