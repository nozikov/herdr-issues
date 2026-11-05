import test from "node:test";
import assert from "node:assert/strict";
import { buildJql, jqlString, parseLookup, isProjectKey } from "../lib/jql.js";

test("default JQL", () => {
  assert.equal(buildJql({ project: "PAY", assignee: "me", state: "open", text: "" }),
    'project = "PAY" AND assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC');
});
test("no project: all my tasks on the site", () => {
  const all = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
  assert.equal(buildJql({ assignee: "me", state: "open", text: "" }), all);
  assert.equal(buildJql({ project: "", assignee: "me", state: "open", text: "" }), all);
  assert.equal(buildJql({ project: null, assignee: "me", state: "open", text: "" }), all);
});
test("without a project the assignee is me, whatever the filter says", () => {
  assert.match(buildJql({ assignee: "anyone", state: "open", text: "" }), /^assignee = currentUser\(\)/);
  assert.match(buildJql({ project: "", assignee: "anyone", state: "all", text: "x" }), /assignee = currentUser\(\)/);
});
test("a picked project allows anyone", () => {
  assert.ok(!buildJql({ project: "PAY", assignee: "anyone", state: "open", text: "" }).includes("currentUser"));
});
test("anyone and all drop their clauses", () => {
  assert.equal(buildJql({ project: "PAY", assignee: "anyone", state: "all", text: "" }),
    'project = "PAY" ORDER BY updated DESC');
});
test("text can't leave its string", () => {
  const jql = buildJql({ project: "PAY", assignee: "me", state: "open", text: 'x" OR project = "SECRET' });
  assert.ok(!/" OR project/.test(jql));
  assert.match(jql, /text ~ "x OR project = SECRET"/);
});
test("text of only special characters adds no clause", () => {
  assert.ok(!buildJql({ project: "PAY", assignee: "me", state: "open", text: '"(:)' }).includes("text ~"));
});
test("jqlString escapes", () => assert.equal(jqlString('a"b\\c'), '"a\\"b\\\\c"'));
test("a bad project key throws", () => {
  assert.throws(() => buildJql({ project: 'PAY" OR 1=1', assignee: "me", state: "open", text: "" }));
});
test("anything given as a project must be a project key", () => {
  for (const project of ["pay", "PAY-1", 'PAY" OR project = "X', "PAY OR 1=1", 0, false, ["PAY"]]) {
    assert.throws(() => buildJql({ project, assignee: "me", state: "open", text: "" }), undefined, String(project));
  }
});
test("isProjectKey", () => {
  assert.ok(isProjectKey("PAY"));
  assert.ok(isProjectKey("MY_PROJ2"));
  assert.ok(!isProjectKey("pay"));
  assert.ok(!isProjectKey("P"));
  assert.ok(!isProjectKey("1PAY"));
  assert.ok(!isProjectKey("PAY-1"));
  assert.ok(!isProjectKey(""));
  assert.ok(!isProjectKey(undefined));
});
test("parseLookup", () => {
  assert.deepEqual(parseLookup(" pay-431 "), { key: "PAY-431" });
  assert.deepEqual(parseLookup("#123"), { key: "#123" });
  assert.equal(parseLookup("fix login"), null);
});
