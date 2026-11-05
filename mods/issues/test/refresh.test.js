import test from "node:test";
import assert from "node:assert/strict";
import { isPanelVisible, shouldRefresh, INTERVAL, applyResult, panelMessage, panelsWithIssues } from "../lib/refresh.js";

const tree = (hidden, active) => ({ id: "root", children: [{ id: "panel", hidden, children: [{ id: "panel-body", active }] }] });
test("visible only when the panel is open on issues", () => {
  assert.equal(isPanelVisible(tree(false, "issues")), true);
  assert.equal(isPanelVisible(tree(true, "issues")), false);
  assert.equal(isPanelVisible(tree(false, "files")), false);
  assert.equal(isPanelVisible({ id: "root", children: [] }), false);
  assert.equal(isPanelVisible(null), false);
});
const nested = (hidden, active) => ({
  id: "root",
  children: [{ id: "work", children: [{ id: "work-body", children: [{ id: "panel", hidden, children: [{ id: "panel-body", active }] }] }] }],
});
test("finds the panel at its real depth in the layout", () => {
  assert.equal(isPanelVisible(nested(false, "issues")), true);
  assert.equal(isPanelVisible(nested(true, "issues")), false);
  assert.equal(isPanelVisible(nested(false, "files")), false);
});
const base = { visible: true, wasVisible: true, contextChanged: false, lastAt: 0, now: 1000, busy: false };
test("no refresh while hidden, whatever else happened", () => {
  assert.equal(shouldRefresh({ ...base, visible: false, contextChanged: true, now: 1e9 }), false);
});
test("refresh on being shown, on a context change, and after 5 minutes", () => {
  assert.equal(shouldRefresh({ ...base, wasVisible: false }), true);
  assert.equal(shouldRefresh({ ...base, contextChanged: true }), true);
  assert.equal(shouldRefresh({ ...base, now: INTERVAL }), true);
  assert.equal(shouldRefresh({ ...base, now: INTERVAL - 1 }), false);
  assert.equal(INTERVAL, 300000);
});
test("no second refresh while one runs", () => {
  assert.equal(shouldRefresh({ ...base, busy: true, now: 1e9 }), false);
  assert.equal(shouldRefresh({ ...base, busy: true, contextChanged: true }), false);
});
test("a good result replaces rows and clears note and error", () => {
  const v = applyResult({ tasks: [{ key: "a" }], note: "old", error: { kind: "network", message: "x" } }, { tasks: [{ key: "b" }, { key: "c" }] });
  assert.deepEqual(v, { tasks: [{ key: "b" }, { key: "c" }], note: null, error: null });
});
test("failed refresh keeps rows and adds the note", () => {
  const v = applyResult({ tasks: [{ key: "a" }], note: null, error: null }, { error: { kind: "network", message: "x" } });
  assert.equal(v.tasks.length, 1);
  assert.match(v.note, /couldn't refresh/);
  assert.equal(v.error, null);
});
test("failed first load shows the state, not an empty list", () => {
  const err = { kind: "auth", message: "401" };
  const v = applyResult({ tasks: [], note: null, error: null }, { error: err });
  assert.deepEqual(v.error, err);
  assert.equal(v.note, null);
  assert.equal(v.tasks.length, 0);
});
test("every state has words", () => {
  for (const s of ["noProject", "remote", "ghAuth", "jiraAuth", "network", "noTasks", "other"]) {
    const m = panelMessage(s);
    assert.ok(m.title);
    assert.ok(m.body);
  }
  assert.match(panelMessage("remote").title, /local spaces only/i);
  assert.match(panelMessage("ghAuth").body, /gh auth login/);
  assert.equal(panelMessage("nonsense"), null);
});
test("messages never echo error text from a source", () => {
  assert.ok(!JSON.stringify(panelMessage("jiraAuth", { message: "Bearer abc123 rejected" })).includes("abc123"));
  assert.ok(!JSON.stringify(panelMessage("ghAuth", { message: "ghp_secret" })).includes("ghp_secret"));
});

test("the tabs mod's panel list gains issues, once", () => {
  assert.deepEqual(panelsWithIssues(undefined), ["files", "changes", "issues"]);
  assert.deepEqual(panelsWithIssues(null), ["files", "changes", "issues"]);
  assert.deepEqual(panelsWithIssues(["files", "changes", "artifacts"]), ["files", "changes", "artifacts", "issues"]);
  assert.deepEqual(panelsWithIssues([]), ["issues"]);
  assert.equal(panelsWithIssues(["files", "issues"]), null, "nothing to set");
});

test("a shared value that isn't a list counts as none", () => {
  assert.deepEqual(panelsWithIssues("files"), ["files", "changes", "issues"]);
  assert.deepEqual(panelsWithIssues({}), ["files", "changes", "issues"]);
});

test("the list it was given stays as it was", () => {
  const panels = ["files"];
  panelsWithIssues(panels);
  assert.deepEqual(panels, ["files"]);
});
