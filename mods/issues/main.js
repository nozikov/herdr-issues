// Issues: a panel of GitHub / Jira tasks that starts an agent on one.
// main.js is the only file that imports gpui-kit / herdr; everything under lib/ is pure and tested.
// Three copies by props().view: the panel (default), "toggle", the button that opens it, and
// "task", the window of one task. The window reads no settings and holds no source: see lib/bus.js.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, hc, run, spaces, panes, terminals, layout, theme, window, home, knownAgents, notify, props, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { isPanelVisible, shouldRefresh, applyResult, panelMessage, panelsWithIssues } from "./lib/refresh.js";
import { createProjects, errorMessage, loadTasks, browserArgv, bodyPreview, sideOf, EMPTY } from "./lib/panel.js";
import { projectsIn, needsAsking, stillAsked, filtersFor } from "./lib/projects.js";
import { loadSettings, saveSettings } from "./lib/settings.js";
import { saveGlobal, saveSite, removeSite, saveProject, saveSource, saveExtras, pickProjectSite, saveFoundKey, saveFilter, connectKeychainItem, tokenCommandText } from "./lib/form.js";
import { normalizeUrl, siteType, tokenHint, tokenTabCommands, usesKeychain } from "./lib/setup.js";
import { createStarter, findStartedTab, liveCwds } from "./lib/start.js";
import { taskFolders, removeFolder, ignoredFiles, removeQuestion } from "./lib/worktree.js";
import { worktreeRoot } from "./lib/names.js";
import { groupByStatus, isHighPriority, timeAgo } from "./lib/groups.js";
import { SIGNAL, offer, claim, signalFor, windowRequest, windowProps } from "./lib/bus.js";

const CHECK_EVERY = 30000;
const DEBOUNCE = 400;
const PANELS = "workspace.panels";
const COMMENTS_WAIT = 40000; // past the runtime's 30 s limit on a request

const icon = (name) => `mods/issues/icons/${name}.svg`;
const isToggle = () => props()?.view === "toggle";
const isTask = () => props()?.view === "task";
const errText = (e) => String(e?.message ?? e);
const platform = () => window()?.platform;
const stop = (_e, cx) => cx.stop_propagation();
// Row state is per repo: `#12` exists in many of them.
const rowId = (context, key) => `${context.repo.main}\n${key}`;

function togglePanel() {
  if (isPanelVisible(layout())) return run("layout.hide", { id: "panel" });
  run("layout.select", { stack: "panel-body", child: "issues" });
  run("layout.show", { id: "panel" });
}

export default class Issues extends View {
  init(_props, cx) {
    if (isToggle()) {
      const panels = panelsWithIssues(shared(PANELS));
      if (panels) setShared(PANELS, panels);
      return;
    }
    if (isTask()) return this.initWindow(cx);
    this.id = `${Date.now()}-${Math.random()}`; // new each start: see signalFor
    this.windows = 0;
    this.opened = null; // the task window this panel answers: { n, task, context, comments, folders, ignored }
    this.settings = loadSettings(localStorage);
    this.projects = createProjects({ exec, fetch });
    this.starters = new Map(); // repo main path -> starter
    this.filters = { project: "", assignee: "me", state: "open", text: "" };
    this.gen = 0; // a reply of an older generation is dropped
    this.busy = false;
    this.lastAt = 0;
    this.wasVisible = false;
    this.seenSpace = undefined;
    this.typing = 0;
    this.screen = "list"; // or "settings"
    this.phases = new Map(); // row id -> "starting" | "setup"
    this.failures = new Map(); // row id -> { message, output? }
    this.removing = null;
    this.clearRows();

    this.search = InputState.new({ placeholder: "Search, or #123 / PAY-431" });
    this.search.on("change", (_e, cx) => this.typed(cx));
    this.fields = {
      template: TextareaState.new({ rows: 7 }),
      siteUrl: InputState.new({ placeholder: "jira.example.com" }),
      siteEmail: InputState.new({ placeholder: "you@example.com" }),
      siteToken: InputState.new({ placeholder: "Filled in for you" }),
      keychainItem: InputState.new({ placeholder: "herdr-issues-jira" }),
      home: InputState.new({ placeholder: "PAY" }),
      setupCommand: InputState.new({ placeholder: "npm ci" }),
    };
    this.fields.siteUrl.on("change", (_e, cx) => cx.notify()); // the address decides what else to ask
    this.advanced = false;
    this.keychainOpen = false;
    this.agents = [];
    this.formFor = undefined; // the project the form was filled for
    this.fillForm();
    cx.timer.every(CHECK_EVERY, (cx) => {
      this.takeSignal(cx);
      if (this.sync(cx)) cx.notify();
    });
  }

  // Everything that belongs to the rows of one project in one space.
  clearRows() {
    this.context = null;
    this.view = EMPTY;
    this.line = null;
    this.folders = new Map(); // task key -> [folder]
    this.spaceIds = new Set();
    this.seen = []; // Jira projects of this repo so far, so picking one keeps the filter row
    this.folded = new Set(); // statuses folded away; memory only
    this.projectsOpen = false;
    this.asking = null; // key of the task whose ▶ waits for an answer
  }

  // ---------- refreshing ----------

  // Hidden copies may not render, so the timer calls this too. True when a refresh started.
  sync(cx) {
    const visible = isPanelVisible(layout());
    const spaceId = spaces().find((s) => s.active)?.id ?? null;
    const contextChanged = spaceId !== this.seenSpace;
    if (visible && contextChanged) {
      // Whatever is on its way belongs to the old space, and so do the rows. The refresh below
      // starts a new generation at once, so a slow reply can't hold it up.
      this.busy = false;
      this.clearRows();
    }
    const due = shouldRefresh({ visible, wasVisible: this.wasVisible, contextChanged, lastAt: this.lastAt, now: Date.now(), busy: this.busy });
    this.wasVisible = visible;
    if (due) {
      this.seenSpace = spaceId;
      this.refresh(cx);
    }
    return due;
  }

  refresh(cx) {
    const gen = ++this.gen;
    this.busy = true;
    this.lastAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const context = await this.projects.contextOf(spaces().find((s) => s.active), panes(), this.settings);
        if (gen !== this.gen) return;
        if (context.repo?.main !== this.context?.repo?.main) this.clearRows();
        this.context = context;
        if (context.state !== "ready" || this.screen === "settings") {
          if (this.formFor !== context.repo?.main) {
            this.fillForm();
            this.loadAgents(cx);
          }
        }
        if (context.state !== "ready") {
          this.busy = false;
          this.view = EMPTY;
          return cx.notify();
        }
        cx.notify(); // the header knows the source now
        this.filters = filtersFor(this.filters, context);
        const result = await loadTasks(context.source, this.filters, context.home);
        if (gen !== this.gen) return;
        const marks = result.tasks ? await this.marksOf(context, result.tasks) : null;
        if (gen !== this.gen) return;
        this.view = applyResult(this.view, result);
        this.line = result.line ?? null;
        if (marks) Object.assign(this, marks);
        if (result.tasks) {
          this.seen = projectsIn(result.tasks, [...this.seen, context.home, context.filter]);
          this.asking = stillAsked(this.asking, this.view.tasks);
          this.guessHome(context, cx);
        }
      } catch (e) {
        if (gen !== this.gen) return;
        this.view = applyResult(this.view, { error: { kind: "other", message: errText(e) } });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Comes after the list and only orders it, so it never holds the list up and leaves nothing on
  // screen. The panel may have been hidden while the list loaded: the next refresh then guesses.
  guessHome(context, cx) {
    if (!isPanelVisible(layout())) return;
    cx.spawn(async (cx) => {
      const key = await this.projects.guessHome(context);
      if (!key) return;
      const { settings } = saveFoundKey(this.settings, context.repo.main, context.entry, key);
      if (settings === this.settings) return; // the project moved on while the guess ran
      try {
        this.store(settings);
      } catch {
        return; // the next start guesses again
      }
      if (this.context?.repo?.main !== context.repo.main || !isPanelVisible(layout())) return;
      this.refresh(cx);
      cx.notify();
    });
  }

  // The dots: one look at the worktrees and the spaces of the project, not one per row.
  async marksOf(context, tasks) {
    const keys = tasks.map((t) => t.key);
    const folders = await taskFolders(exec, context.repo, keys, worktreeRoot(home())).catch(() => this.folders);
    return { folders, spaceIds: await this.projects.spaceIds(spaces(), panes(), context.repo.main, context.spaceId) };
  }

  async remark(context) {
    if (this.context?.repo?.main === context.repo.main) Object.assign(this, await this.marksOf(context, this.view.tasks));
  }

  typed(cx) {
    const text = this.search.value();
    if (text === this.filters.text) return;
    this.filters = { ...this.filters, text };
    const n = ++this.typing;
    cx.timer.after(DEBOUNCE, (cx) => {
      if (n !== this.typing) return;
      this.refresh(cx);
      cx.notify();
    });
  }

  setFilter(name, value, cx) {
    this.filters = { ...this.filters, [name]: value };
    this.refresh(cx);
    cx.notify();
  }

  // Remembered per repo. The refresh takes it from there, and gives Anyone back to "me" on All.
  pickFilter(project, cx) {
    const { repo, site } = this.context;
    try {
      this.store(saveFilter(this.settings, repo.main, site.name, project).settings);
    } catch (e) {
      this.line = `Couldn't save the filter: ${errText(e)}`;
      return cx.notify();
    }
    this.refresh(cx);
    cx.notify();
  }

  // The header's switch: only the source changes, so the other side is there on the way back.
  switchSource(source, cx) {
    const main = this.context?.repo?.main;
    if (!main || sideOf(this.context) === source) return;
    try {
      this.store(saveSource(this.settings, main, source).settings);
    } catch (e) {
      this.line = `Couldn't save the source: ${errText(e)}`;
      return cx.notify();
    }
    this.source = source;
    this.view = EMPTY;
    this.line = null;
    this.asking = null;
    this.projectsOpen = false;
    this.refresh(cx);
    cx.notify();
  }

  refreshNow(cx) {
    this.projects.forget();
    this.refresh(cx);
    cx.notify();
  }

  // ---------- acting on a task ----------

  starterFor(main) {
    if (!this.starters.has(main)) this.starters.set(main, createStarter({ exec, hc, run, spaces: () => spaces(), storage: localStorage, home: home() }));
    return this.starters.get(main);
  }

  // `context` came with the row: a task only ever starts in the space and repo it was listed for.
  async startTask(task, context, id, cx) {
    const projectSpaceIds = await this.projects.spaceIds(spaces(), panes(), context.repo.main, context.spaceId);
    const started = findStartedTab(spaces(), projectSpaceIds, task.key);
    const plan = started ? {} : await this.projects.plan(context, this.settings, await knownAgents());
    if (plan.problem) return { status: "failed", message: plan.problem };
    return this.starterFor(context.repo.main).start(task, {
      ...plan,
      space: context.spaceId,
      repo: context.repo,
      projectSpaceIds,
      setupCommand: context.entry?.setupCommand ?? "",
      template: this.settings.template,
      sleep: (ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve())),
      onRow: (_key, phase) => {
        if (!phase) return; // the row stays "starting" until the outcome is in
        this.phases.set(id, phase);
        cx.notify();
      },
    });
  }

  resuming(task) {
    return Boolean(findStartedTab(spaces(), this.spaceIds, task.key)) || this.folders.has(task.key);
  }

  // ▶: a task that may not belong in this repo waits for the answer to the question in its row.
  press(task, context, cx) {
    if (!needsAsking({ task, home: context.home, resuming: this.resuming(task), askOff: !this.settings.askOtherProject })) return this.begin(task, context, cx);
    this.asking = task.key;
    cx.notify();
  }

  begin(task, context, cx) {
    const id = rowId(context, task.key);
    this.asking = null;
    if (this.phases.has(id) || this.removing === id) return cx.notify();
    this.phases.set(id, "starting");
    this.failures.delete(id);
    cx.notify();
    cx.spawn(async (cx) => {
      const outcome = await this.startTask(task, context, id, cx).catch((e) => ({ status: "failed", message: errText(e) }));
      this.phases.delete(id);
      if (outcome.status === "failed") this.failures.set(id, outcome);
      if (outcome.warning) notify({ title: `${task.key}: started`, body: outcome.warning, level: "warning" });
      if (outcome.status === "started") await this.remark(context).catch(() => {});
      cx.notify();
    });
  }

  cancel(task, context, cx) {
    const id = rowId(context, task.key);
    cx.spawn(async (cx) => {
      try {
        await this.starterFor(context.repo.main).cancel(task.key);
      } catch (e) {
        this.failures.set(id, { message: `Couldn't stop the setup: ${errText(e)}` });
        cx.notify();
      }
    });
  }

  // `ignored`: what the window's question listed. removeFolder compares it with what's there.
  remove(task, folder, ignored, context, cx) {
    const id = rowId(context, task.key);
    if (this.phases.has(id) || this.removing) return cx.notify();
    this.removing = id;
    this.failures.delete(id);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await removeFolder(exec, { repo: context.repo, folder, ignored, root: worktreeRoot(home()), busyCwds: liveCwds(panes(), terminals()) });
      this.removing = null;
      if (r.ok) await this.remark(context).catch(() => {});
      else this.failures.set(id, { message: r.reason });
      cx.notify();
    });
  }

  // A click on a row. The window gets the task now and the comments when they're in.
  openTask(task, context, hasWork, cx) {
    if (this.openingTask) return;
    this.openingTask = true;
    cx.spawn(async (cx) => {
      const folders = this.folders.get(task.key) ?? [];
      // Asked now, so the question can name them. null: git couldn't say, and Remove stays away.
      const ignored = folders.length === 1 ? await ignoredFiles(exec, folders[0]).catch(() => null) : [];
      this.openingTask = false;
      const id = rowId(context, task.key);
      const n = ++this.windows;
      const comments = `${this.id}:${n}`;
      if (this.opened) claim(this.opened.comments); // nobody came for them
      offer(comments, new Promise((resolve) => {
        cx.spawn(async () => resolve(await context.source.comments(task.key).then((list) => ({ comments: list }), () => ({ error: true }))));
      }));
      this.opened = { n, task, context, comments, folders, ignored }; // what the window will confirm
      openOverlay({
        mod: "issues", kind: "dialog", width: 720, height: 0.85,
        props: windowProps({ task, panel: this.id, n, comments, folders, ignored, hasWork, busy: this.phases.has(id) || this.removing === id }),
      });
    });
  }

  // Start or Remove folder from the window: one signal, and the panel's usual path from there.
  takeSignal(cx) {
    const action = signalFor(shared(SIGNAL), this.id, this.opened);
    if (!action) return;
    const opened = this.opened;
    this.opened = null;
    cx.spawn(async (cx) => {
      setShared(SIGNAL, null);
      const r = windowRequest({ action, opened, current: this.context, tasks: this.view.tasks, folders: this.folders });
      if (r.line) {
        this.line = r.line;
        return cx.notify();
      }
      this.folded.delete(r.task.state); // the question or the failure shows under the row
      if (r.go === "start") this.press(r.task, r.context, cx);
      else this.remove(r.task, r.folder, r.ignored, r.context, cx);
    });
  }

  // ---------- settings ----------

  openSettings(cx) {
    this.fillForm();
    this.screen = "settings";
    this.loadAgents(cx);
    cx.notify();
  }

  loadAgents(cx) {
    cx.spawn(async (cx) => {
      this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed);
      cx.notify();
    });
  }

  fillForm() {
    const { settings, fields: f } = this;
    const main = this.context?.repo?.main;
    const entry = main ? settings.projects[main] : null;
    this.formFor = main;
    this.notes = {};
    f.template.set_value(settings.template);
    this.defaultAgent = settings.defaultAgent ?? "";
    this.pickSite(settings.sites[0] ?? null);
    this.source = entry?.source || (this.context?.github ? "github" : "jira");
    this.projectSite = entry?.site || settings.sites[0]?.name || "";
    this.projectAgent = entry?.agent ?? "";
    this.askOther = settings.askOtherProject;
    this.homeShown = this.context?.home ?? "";
    f.home.set_value(this.homeShown);
    f.setupCommand.set_value(entry?.setupCommand ?? "");
  }

  pickSite(site) {
    const f = this.fields;
    this.siteBeingEdited = site?.name ?? "";
    this.siteInsecure = site?.allowInsecure ?? false;
    f.siteUrl.set_value(site?.url ?? "");
    f.siteEmail.set_value(site?.email ?? "");
    f.siteToken.set_value(tokenCommandText(site?.tokenCommand));
  }

  store(settings) {
    saveSettings(localStorage, settings);
    this.settings = loadSettings(localStorage);
  }

  // Keeps a { settings } or shows a { problem } in the section it came from. True when stored.
  commit(section, result, cx) {
    let note = "Saved";
    if (result.problem) note = result.problem;
    else {
      try {
        this.store(result.settings);
        this.projects.forget({ sources: true });
        this.refresh(cx);
      } catch (e) {
        note = `Couldn't save the settings: ${errText(e)}`;
        result = { problem: note };
      }
    }
    this.notes = { [section]: note };
    cx.notify();
    return !result.problem;
  }

  siteValues() {
    const f = this.fields;
    return { url: f.siteUrl.value(), email: f.siteEmail.value(), tokenCommand: f.siteToken.value(), allowInsecure: this.siteInsecure };
  }

  saveSiteForm(cx) {
    const result = saveSite(this.settings, this.siteBeingEdited, this.siteValues(), platform());
    if (result.clear) this.fields.siteToken.set_value("");
    if (!this.commit("site", result, cx)) return;
    this.pickSite(this.settings.sites.find((s) => s.url === normalizeUrl(this.fields.siteUrl.value())) ?? null);
    this.projectSite ||= this.siteBeingEdited;
  }

  removeSiteForm(cx) {
    if (!this.commit("site", removeSite(this.settings, this.siteBeingEdited), cx)) return;
    this.pickSite(this.settings.sites[0] ?? null);
  }

  // Keeps the site, then opens the system's prompt in a tab. The token goes from there to the
  // keychain: the mod never sees it. Until it's there, the panel shows the auth state.
  connect(cx) {
    const result = saveSite(this.settings, "", { ...this.siteValues(), tokenCommand: "" }, platform());
    if (!this.commit("connect", result, cx)) return;
    const site = this.settings.sites.at(-1);
    this.pickSite(site);
    this.projectSite ||= site.name;
    this.openTokenPrompt(site);
  }

  openTokenPrompt(site) {
    const c = this.context;
    const space = spaces().find((s) => (c?.spaceId ? s.id === c.spaceId : s.active));
    for (const [name, args] of tokenTabCommands(space, c?.repo?.main ?? home(), site, platform())) run(name, args);
  }

  // The token is in the keychain already, under a name of the person's. `site`: the one to change,
  // null when the connect form is adding it. The refresh after saving checks the connection.
  useKeychainItem(site, cx) {
    const field = this.fields.keychainItem;
    const values = site ?? this.siteValues();
    cx.spawn(async (cx) => {
      const result = await connectKeychainItem({ exec, settings: this.settings, previous: site?.name ?? "", values, item: field.value(), platform: platform() });
      if (result.clear) field.set_value("");
      if (!this.commit("keychain", result, cx)) return;
      this.keychainOpen = false;
      this.view = EMPTY;
      this.projectSite ||= this.settings.sites[0]?.name ?? "";
      cx.notify();
    });
  }

  pickProject(name, cx) {
    const main = this.context?.repo?.main;
    if (main) this.commit("connect", pickProjectSite(this.settings, main, name), cx);
  }

  saveProjectForm(cx) {
    const main = this.context?.repo?.main;
    if (!main) return;
    if (!this.commit("project", saveProject(this.settings, main, { source: this.source, site: this.projectSite }), cx)) return;
    this.view = EMPTY;
    this.screen = "list";
  }

  saveAdvancedForm(cx) {
    const f = this.fields;
    const { repo, site } = this.context ?? {};
    const { settings } = saveGlobal(this.settings, { defaultAgent: this.defaultAgent, template: f.template.value(), askOtherProject: this.askOther });
    const extras = { agent: this.projectAgent, setupCommand: f.setupCommand.value(), ...(site ? { home: f.home.value(), homeWas: this.homeShown, site: site.name } : {}) };
    if (this.commit("advanced", repo ? saveExtras(settings, repo.main, extras) : { settings }, cx)) this.homeShown = f.home.value().trim().toUpperCase();
  }

  // ---------- drawing ----------

  iconButton(id, name, t, onClick) {
    // An svg takes no color from its parent: without its own it doesn't show.
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(svg(icon(name)).size(14).text_color(t.muted));
  }

  // A small choice or action in text.
  chip(id, label, on, t, onClick) {
    return div().id(id).h(24).px(9).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  primary(id, label, t, onClick) {
    return div().id(id).h(26).px(12).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(12).bg(t.solid).text_color(t.solid_foreground).on_click(onClick).child(label);
  }

  input(state, t) {
    return div().h(30).px(9).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text().on_mouse_down("left", stop)
      .child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground));
  }

  message({ title, body, detail }, t) {
    return v_flex().p(14).gap(6)
      .child(div().font_semibold().child(title))
      .child(div().text_size(12).text_color(t.muted).child(body))
      .when(Boolean(detail), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(detail)));
  }

  // A source error, with the way out of a Jira token problem.
  problem(error, context, t) {
    const site = context.site;
    const canConnect = Boolean(site) && usesKeychain(site, platform());
    return this.message(errorMessage(error, context.source.id, canConnect), t)
      .when(error.kind === "auth" && Boolean(site), (el) => el.child(h_flex().gap(6).pt(4)
        .when(canConnect, (e) => e.child(this.primary("connect-again", "Connect", t, () => this.openTokenPrompt(site))))
        .child(this.chip("check-connection", "Check connection", false, t, (_e, cx) => this.refreshNow(cx))))
        .child(this.keychainBlock(site, t)));
  }

  keychainBlock(site, t) {
    if (!this.keychainOpen) return div().id("keychain-open").pt(2).cursor_pointer().text_size(12).text_color(t.accent)
      .on_click((_e, cx) => { this.keychainOpen = true; this.notes = {}; cx.notify(); }).child("Already in the keychain");
    return v_flex().gap(6).pt(2)
      .child(this.field("Keychain item name", this.input(this.fields.keychainItem, t), t, "The name the token is saved under. Only the name, not a command."))
      .child(h_flex().child(this.primary("keychain-use", "Use it", t, (_e, cx) => this.useKeychainItem(site, cx))))
      .when(Boolean(this.notes.keychain) && this.notes.keychain !== "Saved", (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.notes.keychain)));
  }

  sourceSwitch(t) {
    const on = sideOf(this.context);
    const side = (id, label) => this.chip(`side-${id}`, label, on === id, t, (_e, cx) => this.switchSource(id, cx));
    return h_flex().flex_none().gap(2).child(side("github", "GitHub")).child(side("jira", "Jira"));
  }

  header(t, inForm) {
    const c = this.context;
    const settings = this.screen === "settings";
    return h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
      .when(settings, (el) => el.child(this.iconButton("issues-back", "back", t, (_e, cx) => { this.screen = "list"; cx.notify(); })).child(div().flex_none().font_semibold().child("Settings")))
      .when(!settings, (el) => el.child(this.sourceSwitch(t)))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(c?.label ?? c?.repo?.name ?? ""))
      .when(this.busy, (el) => el.child(svg(icon("spinner")).size(12).flex_none().text_color(t.dim).spin(900)))
      .when(!settings, (el) => el.child(this.iconButton("issues-refresh", "refresh", t, (_e, cx) => this.refreshNow(cx))))
      .when(!inForm, (el) => el.child(this.iconButton("issues-settings", "gear", t, (_e, cx) => this.openSettings(cx))));
  }

  // Only project keys get here: projectsIn lets nothing else through, and saveFilter checks again.
  projectMenu(context, t) {
    const keys = projectsIn(this.view.tasks, [...this.seen, context.home, context.filter]);
    const pick = (key, label) => h_flex().id(`project-${label}`).h(26).flex_none().px(8).items_center().rounded(5).cursor_pointer().text_size(12)
      .text_color(context.filter === key ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.projectsOpen = false; this.pickFilter(key, cx); }).child(label);
    return v_flex().gap(2)
      .child(h_flex().id("project-menu").h(28).px(9).gap(6).items_center().rounded(6).border_1().border_color(t.input).cursor_pointer().text_size(12)
        .on_click((_e, cx) => { this.projectsOpen = !this.projectsOpen; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().child(context.filter || "All projects"))
        .child(div().flex_none().text_color(t.dim).child(this.projectsOpen ? "▴" : "▾")))
      .when(this.projectsOpen, (el) => el.child(v_flex().id("project-list").max_h(180).overflow_y_scrollbar().p(2).rounded(6).bg(t.raised)
        .child(pick("", "All projects"))
        .children(keys.map((key) => pick(key, key)))));
  }

  filterBar(t) {
    const { project, assignee, state } = this.filters;
    const context = this.context;
    const pick = (name, value, label, on) => this.chip(`filter-${value}`, label, on, t, (_e, cx) => this.setFilter(name, value, cx));
    return v_flex().flex_none().px(10).py(8).gap(8).border_b(1).border_color(t.border)
      .when(Boolean(context.site), (el) => el.child(this.projectMenu(context, t)))
      .child(h_flex().gap(4).items_center()
        .child(pick("assignee", "me", "Assigned", assignee === "me"))
        .when(Boolean(project) || Boolean(context.github), (el) => el.child(pick("assignee", "anyone", "Anyone", assignee === "anyone")))
        .child(div().w(8))
        .child(pick("state", "open", "All open", state === "open"))
        .child(pick("state", "all", "All", state === "all")))
      .child(this.input(this.search, t));
  }

  failureLines(failure, t) {
    return v_flex().px(26).pb(6).gap(4)
      .child(div().text_size(12).text_color(t.blocked).child(failure.message))
      .when(Boolean(failure.output), (el) => el.child(div().text_size(11).text_color(t.dim).child(bodyPreview(failure.output))));
  }

  row(task, context, all, t) {
    const id = rowId(context, task.key);
    const phase = this.phases.get(id);
    const failure = this.failures.get(id);
    const hasWork = Boolean(findStartedTab(all, this.spaceIds, task.key)) || this.folders.has(task.key);
    const age = timeAgo(task.updatedAt, Date.now());
    return v_flex().flex_none().rounded(7)
      .child(h_flex().id(`task-${task.key}`).px(8).py(6).gap(7).items_start().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openTask(task, context, hasWork, cx))
        .child(div().w(10).h(18).flex_none().flex().items_center().justify_center().when(hasWork, (el) => el.child(div().size(6).rounded(3).bg(t.accent))))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().child(task.title))
          .child(h_flex().flex_wrap().gap(6).text_size(11.5).text_color(t.dim)
            .child(div().child(task.key))
            .when(isHighPriority(task.priority), (el) => el.child(div().text_color(t.blocked).child("High")))
            .when(Boolean(age), (el) => el.child(div().child(age)))))
        .child(phase
          ? div().size(24).flex_none().flex().items_center().justify_center().child(svg(icon("spinner")).size(12).text_color(t.working).spin(900))
          : this.iconButton(`play-${task.key}`, "play", t, (_e, cx) => { cx.stop_propagation(); this.press(task, context, cx); }).on_mouse_down("left", stop)))
      .when(this.asking === task.key && !phase, (el) => el.child(h_flex().px(26).pb(6).gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child(`Start ${task.key} in ${context.repo.name}?`))
        .child(this.primary(`start-${task.key}`, "Start", t, (_e, cx) => this.begin(task, context, cx)))
        .child(this.chip(`keep-${task.key}`, "Cancel", false, t, (_e, cx) => { this.asking = null; cx.notify(); }))))
      .when(phase === "setup", (el) => el.child(h_flex().px(26).pb(6).gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(t.muted).child("Setting up…"))
        .child(this.chip(`cancel-${task.key}`, "Cancel", false, t, (_e, cx) => this.cancel(task, context, cx)))))
      .when(this.removing === id, (el) => el.child(div().px(26).pb(6).text_size(12).text_color(t.muted).child("Removing the folder…")))
      .when(Boolean(failure), (el) => el.child(this.failureLines(failure, t)));
  }

  group({ state, tasks }, context, all, t) {
    const shut = this.folded.has(state);
    return v_flex().flex_none().gap(1)
      .child(h_flex().id(`group-${state}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (shut) this.folded.delete(state);
          else this.folded.add(state);
          cx.notify();
        })
        .child(div().w(10).flex_none().child(shut ? "▸" : "▾"))
        .child(div().min_w(0).truncate().font_semibold().child(state || "No status"))
        .child(div().flex_none().text_color(t.dim).child(String(tasks.length))))
      .when(!shut, (el) => el.children(tasks.map((task) => this.row(task, context, all, t))));
  }

  list(t) {
    const { tasks, note, error } = this.view;
    const context = this.context;
    const all = spaces();
    if (error) return this.problem(error, context, t);
    return v_flex().id("issues-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
      .when(Boolean(note), (el) => el.child(div().px(8).py(4).text_size(11.5).text_color(t.blocked).child(note)))
      .when(Boolean(this.line), (el) => el.child(div().px(8).py(4).text_size(12).text_color(t.muted).child(this.line)))
      .children(context.site ? groupByStatus(tasks).map((g) => this.group(g, context, all, t)) : tasks.map((task) => this.row(task, context, all, t)))
      .when(!tasks.length, (el) => el.child(this.busy ? div().p(8).text_size(12).text_color(t.dim).child("Loading tasks…") : this.message(panelMessage("noTasks"), t)));
  }

  body(t) {
    const state = this.context?.state;
    if (state === "ready") return v_flex().flex_1().min_h(0).child(this.filterBar(t)).child(this.list(t));
    if (state === "remote" || state === "noProject" || state === "noRemote" || state === "severalRemotes") return this.message(panelMessage(state), t);
    if (state === "connect") return v_flex().id("issues-connect").flex_1().min_h(0).overflow_y_scrollbar().child(this.connectBlock(t));
    if (state === "pickSite") return this.pickSiteBlock(t);
    return div().p(14).text_size(12).text_color(t.dim).child("Loading…");
  }

  field(label, control, t, hint) {
    return v_flex().gap(3)
      .child(div().text_size(11.5).text_color(t.muted).child(label))
      .child(control)
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  section(title, note, t, ...children) {
    return v_flex().flex_none().gap(8).p(12).border_b(1).border_color(t.border)
      .child(div().font_semibold().child(title))
      .children(children)
      .when(Boolean(note), (el) => el.child(div().text_size(12).text_color(note === "Saved" ? t.muted : t.blocked).child(note)));
  }

  agentChoice(prefix, label, value, set, t) {
    const pick = (id, name, key) => this.chip(`${prefix}-${id}`, name, value === key, t, (_e, cx) => { set(key); cx.notify(); });
    return h_flex().flex_wrap().gap(4).child(pick("auto", label, "")).children(this.agents.map((a) => pick(a.key, a.name, a.key)));
  }

  checkbox(id, label, on, t, onClick) {
    return h_flex().id(id).gap(7).items_center().cursor_pointer().on_click(onClick)
      .child(div().size(14).flex_none().rounded(3).border_1().border_color(t.input).when(on, (el) => el.bg(t.accent)))
      .child(div().text_size(12).child(label));
  }

  insecureBox(t) {
    return v_flex().gap(3)
      .child(this.checkbox("site-insecure", "Allow insecure (http://)", this.siteInsecure, t, (_e, cx) => { this.siteInsecure = !this.siteInsecure; cx.notify(); }))
      .when(this.siteInsecure, (el) => el.child(div().text_size(11).text_color(t.blocked).child("The token then travels in clear text. Use this only for an internal server on a network you trust.")));
  }

  // What the address decides: email for Cloud, the checkbox for http.
  siteAddressFields(t, hint) {
    const f = this.fields;
    const url = normalizeUrl(f.siteUrl.value());
    return [
      this.field("Jira address", this.input(f.siteUrl, t), t, hint?.(siteType(url))),
      ...(siteType(url) === "cloud" ? [this.field("Email", this.input(f.siteEmail, t), t)] : []),
      ...(/^http:\/\//i.test(url) ? [this.insecureBox(t)] : []),
    ];
  }

  connectBlock(t) {
    return this.section("Connect Jira", this.notes.connect, t,
      ...this.siteAddressFields(t, tokenHint),
      h_flex().child(this.primary("connect", "Connect", t, (_e, cx) => this.connect(cx))),
      this.keychainBlock(null, t));
  }

  pickSiteBlock(t) {
    return this.section("Which Jira site is this project on?", this.notes.connect, t,
      h_flex().flex_wrap().gap(4).children(this.settings.sites.map((s) => this.chip(`pick-${s.name}`, s.name, false, t, (_e, cx) => this.pickProject(s.name, cx)))));
  }

  projectSection(t) {
    const { sites } = this.settings;
    const jira = this.source === "jira";
    const pickSource = (id, label) => this.chip(`source-${id}`, label, this.source === id, t, (_e, cx) => { this.source = id; cx.notify(); });
    return this.section(`Project: ${this.context.repo.name}`, this.notes.project, t,
      this.field("Source", h_flex().gap(4).child(pickSource("github", "GitHub")).child(pickSource("jira", "Jira")), t),
      ...(jira && sites.length > 1 ? [this.field("Jira site", h_flex().flex_wrap().gap(4).children(sites.map((s) => this.chip(`project-site-${s.name}`, s.name, s.name === this.projectSite, t, (_e, cx) => { this.projectSite = s.name; cx.notify(); }))), t)] : []),
      ...(jira && !sites.length ? [] : [h_flex().child(this.primary("save-project", "Save", t, (_e, cx) => this.saveProjectForm(cx)))]));
  }

  sitesSection(t) {
    const f = this.fields;
    return this.section("Jira sites", this.notes.site, t,
      h_flex().flex_wrap().gap(4)
        .children(this.settings.sites.map((s) => this.chip(`site-pick-${s.name}`, s.name, s.name === this.siteBeingEdited, t, (_e, cx) => { this.pickSite(s); this.notes = {}; cx.notify(); })))
        .child(this.chip("site-add", "Add site", !this.siteBeingEdited, t, (_e, cx) => { this.pickSite(null); this.notes = {}; cx.notify(); })),
      ...this.siteAddressFields(t),
      this.field("Token command", this.input(f.siteToken, t), t, "Prints the token. Leave it for the keychain item Connect fills, or use your own."),
      h_flex().gap(6)
        .child(this.primary("save-site", "Save site", t, (_e, cx) => this.saveSiteForm(cx)))
        .when(Boolean(this.siteBeingEdited), (el) => el.child(this.chip("site-remove", "Remove site", false, t, (_e, cx) => this.removeSiteForm(cx)))));
  }

  advancedSection(t) {
    const hasProject = Boolean(this.context?.repo);
    const area = div().rounded(6).border_1().border_color(t.input).bg(t.background).p(6).cursor_text().on_mouse_down("left", stop)
      .child(Textarea.new(this.fields.template).text_size(12).text_color(t.foreground));
    return this.section("Agent and first message", this.notes.advanced, t,
      this.field("Default agent", this.agentChoice("agent", "Automatic", this.defaultAgent, (k) => { this.defaultAgent = k; }, t), t),
      ...(hasProject ? [
        this.field("Agent for this project", this.agentChoice("project-agent", "Default", this.projectAgent, (k) => { this.projectAgent = k; }, t), t),
        this.field("Setup command", this.input(this.fields.setupCommand, t), t, "Runs with sh -c in each new folder before the agent starts. $1 is the branch, $2 the folder."),
      ] : []),
      this.field("First message", area, t, "{key}, {title}, {url} and {body} are filled in from the task."),
      ...(this.context?.site ? [this.field("Home project", this.input(this.fields.home, t), t, "This repo's Jira project, like PAY. Its tasks come first and start without a question. May be empty.")] : []),
      this.checkbox("ask-other", "Ask before starting another project's task", this.askOther, t, (_e, cx) => { this.askOther = !this.askOther; cx.notify(); }),
      h_flex().child(this.primary("save-advanced", "Save", t, (_e, cx) => this.saveAdvancedForm(cx))));
  }

  form(t) {
    const c = this.context;
    // One address field exists: the connect form takes it when no site is there to edit.
    // Nothing to connect from a remote space: the token prompt would run on another machine.
    const connecting = this.source === "jira" && !this.settings.sites.length && c?.state !== "remote";
    return v_flex().id("issues-form").flex_1().min_h(0).overflow_y_scrollbar()
      .when(c?.state === "setup", (el) => el.child(div().p(12).text_size(12).text_color(t.muted).border_b(1).border_color(t.border)
        .child("This project needs a look: its Jira site is incomplete.")))
      .when(Boolean(c?.repo), (el) => el.child(this.projectSection(t)))
      .when(connecting, (el) => el.child(this.connectBlock(t)))
      .child(h_flex().id("advanced").h(34).flex_none().px(12).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.advanced = !this.advanced; cx.notify(); }).child(this.advanced ? "▾ Advanced" : "▸ Advanced"))
      .when(this.advanced, (el) => el.child(this.advancedSection(t)).when(!connecting, (e) => e.child(this.sitesSection(t))));
  }

  // ---------- the task window ----------

  initWindow(cx) {
    this.comments = null; // null until they're in
    this.commentsFailed = false;
    this.copied = false;
    this.confirmingRemove = false;
    this.linkProblem = null;
    const promise = claim(props().comments);
    if (!promise) {
      this.commentsFailed = true;
      return;
    }
    cx.spawn(async (cx) => {
      const reply = await Promise.race([promise, cx.sleep(COMMENTS_WAIT).then(() => ({ error: true }))]);
      this.comments = reply.comments ?? null;
      this.commentsFailed = !reply.comments;
      cx.notify();
    });
  }

  // The panel does the work; see takeSignal. The signal holds no tracker text.
  ask(action) {
    const { panel, n, overlay } = props();
    setShared(SIGNAL, { panel, n, action });
    closeOverlay(overlay);
  }

  openLink(url, cx) {
    const argv = browserArgv(platform(), url);
    if (!argv) {
      this.linkProblem = "This link isn't a web address.";
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const r = await exec(argv[0], argv.slice(1)).catch((e) => ({ code: 1, stderr: errText(e) }));
      if (r.code === 0) return;
      this.linkProblem = `Couldn't open the browser: ${String(r.stderr ?? "").trim()}`;
      cx.notify();
    });
  }

  // Text is safeMarkdown's by now. The link handler replaces TextView's own opening: a click is
  // the only way out, and it goes through browserArgv.
  markdown(id, text) {
    return TextView.markdown(id, text).selectable(true).on_link_click((url, cx) => this.openLink(url, cx));
  }

  fact(label, value, t, color) {
    return v_flex().flex_none().gap(2)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(div().text_size(12).text_color(color ?? t.foreground).child(value));
  }

  commentsBlock(t) {
    const line = (text, color) => div().text_size(12).text_color(color).child(text);
    const list = this.comments ?? [];
    return v_flex().flex_none().gap(10)
      .child(div().font_semibold().child("Comments"))
      .when(this.commentsFailed, (el) => el.child(line("Couldn't load the comments.", t.blocked)))
      .when(!this.commentsFailed && !this.comments, (el) => el.child(line("Loading comments…", t.dim)))
      .when(Boolean(this.comments) && !list.length, (el) => el.child(line("No comments.", t.dim)))
      .children(list.map((c, i) => v_flex().flex_none().gap(3)
        .child(div().text_size(11.5).text_color(t.dim).child([c.author, timeAgo(c.created, Date.now())].filter(Boolean).join(" · ")))
        .child(this.markdown(`comment-${i}`, c.body))));
  }

  windowActions(p, t) {
    const { task, folders, ignored, busy, branch } = p;
    const asking = this.confirmingRemove;
    return v_flex().flex_none().gap(6)
      .child(h_flex().gap(6).items_center()
        .child(this.chip("task-browser", "Open in browser", false, t, (_e, cx) => this.openLink(task.url, cx)))
        .child(this.chip("task-branch", this.copied ? "Copied" : "Copy branch name", false, t, (_e, cx) => { cx.write_to_clipboard(branch); this.copied = true; cx.notify(); }))
        .when(folders.length === 1 && Boolean(ignored) && !busy && !asking, (el) => el.child(this.chip("task-remove", "Remove folder", false, t, (_e, cx) => { this.confirmingRemove = true; cx.notify(); }))))
      .when(folders.length > 1, (el) => el.child(div().text_size(12).text_color(t.dim).child(`Several folders match this task, so none can be removed from here: ${folders.join(", ")}`)))
      .when(folders.length === 1 && !ignored, (el) => el.child(div().text_size(12).text_color(t.dim).child("Couldn't list this folder's ignored files, so it can't be removed from here.")))
      .when(asking, (el) => el.child(v_flex().gap(6).text_size(12)
        .child(div().text_color(t.muted).child(removeQuestion(folders[0], ignored)))
        .child(h_flex().gap(6)
          .child(this.chip("task-remove-yes", "Remove", false, t, () => this.ask("remove")))
          .child(this.chip("task-remove-no", "Keep", false, t, (_e, cx) => { this.confirmingRemove = false; cx.notify(); })))))
      .when(Boolean(this.linkProblem), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.linkProblem)));
  }

  taskWindow(t) {
    const p = props();
    const { task, hasWork, busy, overlay } = p;
    const updated = timeAgo(task.updatedAt, Date.now());
    return v_flex().id("issues-task").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(task.key))
        .child(this.iconButton("task-close", "close", t, () => closeOverlay(overlay))))
      .child(v_flex().id("task-body").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(14)
        .child(h_flex().flex_none().gap(12).items_start()
          .child(div().flex_1().min_w(0).text_size(17).font_semibold().child(task.title))
          .when(!busy, (el) => el.child(this.primary("task-start", hasWork ? "Continue" : "Start", t, () => this.ask("start")))))
        .child(h_flex().flex_none().flex_wrap().gap(18)
          .child(this.fact("Status", task.state || "None", t))
          .when(Boolean(task.priority), (el) => el.child(this.fact("Priority", task.priority, t, isHighPriority(task.priority) ? t.blocked : null)))
          .child(this.fact("Assignee", task.assignee || "Unassigned", t))
          .when(Boolean(updated), (el) => el.child(this.fact("Updated", updated, t)))
          .when(task.labels?.length > 0, (el) => el.child(this.fact("Labels", task.labels.join(", "), t))))
        .child(task.markdown ? v_flex().flex_none().child(this.markdown("task-description", task.markdown)) : div().flex_none().text_size(12).text_color(t.dim).child("No description."))
        .child(this.commentsBlock(t))
        .child(this.windowActions(p, t)));
  }

  toggle(t) {
    const open = isPanelVisible(layout());
    // Drawn like the tabs mod's Files and Changes buttons, so the row reads as one.
    const color = open ? t.foreground : t.muted;
    return h_flex().size_full().items_center().justify_center().bg(t.chrome)
      .child(h_flex().id("issues-toggle").h(26).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(color).bg(open ? t.selected : t.chrome).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click(() => togglePanel())
        .child(svg(icon("issues")).size(14).text_color(color)).child("Issues"));
  }

  render(cx) {
    const t = theme();
    if (isToggle()) return this.toggle(t);
    if (isTask()) return this.taskWindow(t);
    this.takeSignal(cx);
    this.sync(cx);
    const inForm = this.screen === "settings" || this.context?.state === "setup";
    return v_flex().id("issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t, inForm))
      .child(inForm ? this.form(t) : this.body(t));
  }
}
