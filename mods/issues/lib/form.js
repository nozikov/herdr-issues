// The settings form's text and choices, turned into settings. Each save returns { settings } or
// { problem } in words. Pure: no Node APIs, the Herdr runtime has none.
import { currentTemplate } from "./prompt.js";
import { parseArgv } from "./settings.js";
import { isProjectKey } from "./jql.js";
import { validateSite } from "../sources/jira.js";
import { siteFromUrl, hostOf, usesKeychain, tokenReadCommand, isKeychainItemName, looksLikeToken } from "./setup.js";

// Back to what parseArgv reads. It has no escapes, so a word is quoted with the quote it lacks.
export function tokenCommandText(argv) {
  return (argv ?? []).map((a) => (a && !/[\s'"]/.test(a) ? a : a.includes('"') ? `'${a}'` : `"${a}"`)).join(" ");
}

export function saveGlobal(settings, { defaultAgent, template, askOtherProject }) {
  return { settings: { ...settings, defaultAgent: defaultAgent || null, template: currentTemplate(template), askOtherProject: askOtherProject !== false } };
}

// A site from its address: `previous` is the name of the site being edited, "" for a new one. An
// empty token command is filled in, and a filled-in one follows the site to a new host. Projects
// follow it too.
export function saveSite(settings, previous, values, platform) {
  const site = siteFromUrl(values.url, platform);
  if (!hostOf(site.url) || /\s/.test(site.url)) return { problem: "Enter the site address, like jira.example.com" };
  if (site.name !== previous && settings.sites.some((s) => s.name === site.name)) return { problem: `${site.name} is already connected` };
  const old = settings.sites.find((s) => s.name === previous);
  const typed = parseArgv(values.tokenCommand);
  const filledIn = old && usesKeychain({ ...old, tokenCommand: typed }, platform);
  if (typed.length && !filledIn) {
    if (looksLikeToken(typed)) return { problem: "That looks like a token. Enter the command that prints it, with its full path if it's one word.", clear: true };
    site.tokenCommand = typed;
  }
  if (site.type === "cloud") site.email = values.email.trim();
  site.allowInsecure = values.allowInsecure;
  if (/^http:\/\//i.test(site.url) && !site.allowInsecure) return { problem: "An http:// site sends the token in clear text: use https://, or tick Allow insecure" };
  const problem = validateSite(site);
  if (problem) return { problem };

  const sites = old ? settings.sites.map((s) => (s === old ? site : s)) : [...settings.sites, site];
  const projects = Object.fromEntries(Object.entries(settings.projects).map(([path, p]) => [path, previous && p.site === previous ? { ...p, site: site.name } : p]));
  return { settings: { ...settings, sites, projects } };
}

// A token kept under another name: the person gives the item, the command is built from it.
export function saveKeychainItem(settings, previous, values, item, platform) {
  const name = item.trim();
  if (!name || name.startsWith("-") || /^(security|secret-tool)\s/.test(name)) return { problem: "Enter the name of the keychain item, not a command" };
  // Never repeats what was typed, and `clear` asks for the field to be emptied: it may be the token.
  if (!isKeychainItemName(name)) return { problem: "That looks like the token itself. Enter the name of the keychain item, not its value.", clear: true };
  return saveSite(settings, previous, { ...values, tokenCommand: tokenCommandText(tokenReadCommand(platform, name)) }, platform);
}

// saveKeychainItem, once reading the item has worked, so a wrong name is never stored. What the read
// prints is only looked at here, and goes nowhere.
export async function connectKeychainItem({ exec, settings, previous, values, item, platform }) {
  const result = saveKeychainItem(settings, previous, values, item, platform);
  if (result.problem) return result;
  const [cmd, ...args] = tokenReadCommand(platform, item.trim());
  const read = await exec(cmd, args).catch(() => null);
  if (read?.code !== 0 || !String(read.stdout).trim()) return { problem: "No keychain item with that name" };
  return result;
}

const NO_HOME = { projectKey: "", filter: "", homeSet: false };

// Its projects start over: a key only means something on the site that confirmed it.
export function removeSite(settings, name) {
  const projects = Object.fromEntries(Object.entries(settings.projects).map(([path, p]) => [path, p.site === name ? { ...p, source: p.source === "github" ? "github" : "", site: "", ...NO_HOME } : p.site ? p : { ...p, ...NO_HOME }]));
  return { settings: { ...settings, sites: settings.sites.filter((s) => s.name !== name), projects } };
}

export const KEY_SHAPE = "A project key looks like DEMO";

const NO_ENTRY = { source: "", site: "", ...NO_HOME, agent: "", setupCommand: "" };

const withEntry = (settings, main, changes) => ({
  settings: { ...settings, projects: { ...settings.projects, [main]: { ...NO_ENTRY, ...settings.projects[main], ...changes } } },
});

// The switch. It changes the source only, so the Jira side is still there on the way back.
export function saveSource(settings, main, source) {
  if (source !== "github" && source !== "jira") return { problem: "Pick a source" };
  return withEntry(settings, main, { source });
}

// The gear's project part: source and site. A home project and a filter stay while the site does.
export function saveProject(settings, main, values) {
  const { sites } = settings;
  if (values.source !== "jira") return saveSource(settings, main, "github");
  // With one site there is no choice on the form, so a name left from a removed site can't stand.
  const site = sites.find((s) => s.name === values.site) ?? (sites.length === 1 ? sites[0] : null);
  if (!sites.length) return { problem: "Connect a Jira site first" };
  if (!site) return { problem: "Pick a Jira site" };
  const moved = settings.projects[main]?.site !== site.name;
  return withEntry(settings, main, { source: "jira", site: site.name, ...(moved ? NO_HOME : {}) });
}

// Advanced's project part. It leaves the source and the home project alone, unless the Home project
// field changed against `homeWas`, what it showed (`home`, "" for none). A change is the person's
// decision, so nothing is guessed after it, and it only counts on the project's site (`site`). A
// field left as it was decides nothing, and a guess that landed meanwhile stays.
export function saveExtras(settings, main, { agent, setupCommand, home, homeWas, site }) {
  const changes = { agent, setupCommand: setupCommand.trim() };
  const typed = home?.trim().toUpperCase();
  if (typed !== undefined && typed !== homeWas) {
    if (typed && !isProjectKey(typed)) return { problem: KEY_SHAPE };
    Object.assign(changes, { projectKey: typed, homeSet: true, source: "jira", site });
  }
  return withEntry(settings, main, changes);
}

// The answer to "which site?": remembered at once, so it's asked once per project.
export function pickProjectSite(settings, main, site) {
  return withEntry(settings, main, { source: "jira", site, ...NO_HOME });
}

// A confirmed guess. `began` is the entry when the guess began, null for none. The person's own
// choice wins, also one made while the guess ran: a guess only ever adds the home project, and only
// to an entry still on that source and site. With no change, the same settings come back.
export function saveFoundKey(settings, main, began, projectKey) {
  const entry = settings.projects[main];
  const moved = (entry?.source ?? "") !== (began?.source ?? "") || (entry?.site ?? "") !== (began?.site ?? "");
  if (moved || entry?.homeSet || isProjectKey(entry?.projectKey)) return { settings };
  return withEntry(settings, main, { projectKey, homeSet: true });
}

// The project picked in the filter row; anything but a key is All.
export function saveFilter(settings, main, site, filter) {
  return withEntry(settings, main, { source: "jira", site, filter: isProjectKey(filter) ? filter : "" });
}
