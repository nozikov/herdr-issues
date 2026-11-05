import test from "node:test";
import assert from "node:assert/strict";
import { offer, claim, signalFor, windowRequest, windowProps } from "../lib/bus.js";

test("comments are handed over once, in memory", async () => {
  offer("p:1", Promise.resolve({ comments: [] }));
  assert.deepEqual(await claim("p:1"), { comments: [] });
  assert.equal(claim("p:1"), null);
  assert.equal(claim("p:2"), null);
});

test("a signal counts only for the panel and the window it names", () => {
  const opened = { n: 3 };
  const signal = { panel: "a", n: 3, action: "start" };
  assert.equal(signalFor(signal, "a", opened), "start");
  assert.equal(signalFor({ ...signal, action: "remove" }, "a", opened), "remove");
  assert.equal(signalFor(signal, "b", opened), null);
  assert.equal(signalFor({ ...signal, n: 2 }, "a", opened), null);
  assert.equal(signalFor(signal, "a", null), null);
  assert.equal(signalFor({ ...signal, action: "other" }, "a", opened), null);
  assert.equal(signalFor(null, "a", opened), null);
  assert.equal(signalFor("start", "a", opened), null);
});

const repo = { main: "/w/app", name: "app" };
const task = { key: "DEMO-1", title: "T" };
const context = { repo };
const request = (over = {}) => ({ action: "start", opened: { task, context }, current: context, tasks: [task], folders: new Map(), ...over });

test("start uses the panel's own task and the context it was listed for", () => {
  const fresh = { ...task, title: "newer" };
  assert.deepEqual(windowRequest(request({ tasks: [fresh] })), { go: "start", task: fresh, context });
});

test("a request from another project is dropped with a line", () => {
  const r = windowRequest(request({ current: { repo: { main: "/w/other" } } }));
  assert.equal(r.go, undefined);
  assert.match(r.line, /DEMO-1/);
  assert.match(windowRequest(request({ current: null })).line, /DEMO-1/);
});

test("a request from another space of the same repo is dropped too", () => {
  const here = { repo, spaceId: "s1" };
  const r = windowRequest(request({ opened: { task, context: here }, current: { repo, spaceId: "s2" } }));
  assert.equal(r.go, undefined);
  assert.match(r.line, /DEMO-1/);
  assert.equal(windowRequest(request({ opened: { task, context: here }, current: { repo, spaceId: "s1" } })).go, "start");
});

test("a task gone from the list is not started", () => {
  const r = windowRequest(request({ tasks: [] }));
  assert.equal(r.go, undefined);
  assert.match(r.line, /DEMO-1/);
});

test("remove needs exactly one folder, read from the panel", () => {
  const one = new Map([["DEMO-1", ["DEMO-1-t"]]]);
  const opened = { task, context, folders: ["DEMO-1-t"], ignored: [".env"] };
  assert.deepEqual(windowRequest(request({ action: "remove", opened, folders: one })), { go: "remove", task, context, folder: "DEMO-1-t", ignored: [".env"] });
  assert.match(windowRequest(request({ action: "remove" })).line, /folder/);
  assert.match(windowRequest(request({ action: "remove", folders: new Map([["DEMO-1", ["a", "b"]]]) })).line, /folder/);
});

test("only the folder the window confirmed is removed", () => {
  const panel = new Map([["DEMO-1", ["/w/other"]]]);
  const remove = (shown) => windowRequest(request({ action: "remove", opened: { task, context, folders: shown, ignored: [] }, folders: panel }));
  for (const shown of [["/w/shown"], [], ["/w/other", "/w/shown"], undefined]) {
    const r = remove(shown);
    assert.equal(r.go, undefined);
    assert.equal(r.folder, undefined);
    assert.match(r.line, /DEMO-1/);
    assert.match(r.line, /nothing was removed/);
  }
  assert.equal(remove(["/w/other"]).folder, "/w/other");
  assert.equal(windowRequest(request({ action: "remove", opened: { task, context, folders: ["/w/other"], ignored: null }, folders: panel })).go, undefined, "no list, no removal");
});

test("the window gets what it draws, and not the agent's text", () => {
  const full = { key: "DEMO-1", title: "T", url: "https://x.test/1", state: "Doing", priority: "High", assignee: "A", labels: ["l"], updatedAt: "u", body: "plain", markdown: "**m**" };
  const p = windowProps({ task: full, panel: "a", n: 2, comments: "a:2", folders: ["f"], ignored: [".env"], hasWork: true, busy: false });
  assert.equal(p.view, "task");
  assert.equal(p.panel, "a");
  assert.equal(p.n, 2);
  assert.equal(p.comments, "a:2");
  assert.equal(p.task.markdown, "**m**");
  assert.deepEqual(p.folders, ["f"]);
  assert.deepEqual(p.ignored, [".env"]);
  assert.equal(p.hasWork, true);
  assert.equal(p.busy, false);
  assert.equal(p.branch, "DEMO-1-t");
  assert.equal(JSON.stringify(p).includes("plain"), false);
});
