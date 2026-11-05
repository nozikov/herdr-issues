import test from "node:test";
import assert from "node:assert/strict";
import { taskProject, projectsIn, homeFirst, needsAsking, stillAsked, filtersFor } from "../lib/projects.js";

const tasks = (...keys) => keys.map((key) => ({ key }));
const keys = (list) => list.map((t) => t.key);

test("taskProject reads the project from a key", () => {
  assert.equal(taskProject("PAY-431"), "PAY");
  assert.equal(taskProject("MY_PROJ2-7"), "MY_PROJ2");
});

test("taskProject gives nothing for a GitHub key or text that isn't a key", () => {
  for (const key of ["#12", "", "pay-1", "PAY", 'PA"Y-1', 'PAY" OR 1=1-1', "PAY-1 x", undefined]) assert.equal(taskProject(key), "", String(key));
});

test("projectsIn: the union, sorted, each once", () => {
  assert.deepEqual(projectsIn(tasks("ZED-1", "ABC-2", "ZED-3"), ["MID", "ABC"]), ["ABC", "MID", "ZED"]);
  assert.deepEqual(projectsIn(tasks("ABC-1")), ["ABC"]);
  assert.deepEqual(projectsIn([]), []);
});

test("projectsIn keeps only real keys, also from what it was given", () => {
  assert.deepEqual(projectsIn(tasks("#12", "bad key-1"), ["", 'PAY" OR 1=1', "OK"]), ["OK"]);
});

test("homeFirst: home tasks first, each group in Jira's order", () => {
  assert.deepEqual(keys(homeFirst(tasks("ZED-3", "PAY-2", "ABC-1", "PAY-9"), "PAY")), ["PAY-2", "PAY-9", "ZED-3", "ABC-1"]);
});

test("homeFirst without a home keeps the order, and leaves its input alone", () => {
  const input = tasks("ZED-3", "ABC-1");
  assert.deepEqual(keys(homeFirst(input, "")), ["ZED-3", "ABC-1"]);
  homeFirst(input, "ABC");
  assert.deepEqual(keys(input), ["ZED-3", "ABC-1"]);
});

const ask = (over = {}) => needsAsking({ task: { key: "XYZ-12" }, home: "PAY", resuming: false, askOff: false, ...over });

test("a task of another project asks, and so does any task with no home project", () => {
  assert.equal(ask(), true);
  assert.equal(ask({ home: "" }), true);
  assert.equal(ask({ task: { key: "PAY-1" }, home: "" }), true);
});

test("a task of the home project starts at once", () => {
  assert.equal(ask({ task: { key: "PAY-1" } }), false);
});

test("a key that only starts like the home project is another project", () => {
  assert.equal(ask({ task: { key: "PAYX-1" } }), true);
});

test("resuming and the switch turn the question off", () => {
  assert.equal(ask({ resuming: true }), false);
  assert.equal(ask({ askOff: true }), false);
});

test("a GitHub task never asks", () => {
  assert.equal(ask({ task: { key: "#12" } }), false);
  assert.equal(ask({ task: { key: "#12" }, home: "" }), false);
});

test("a key this mod can't read still asks: that's the safe side", () => {
  assert.equal(ask({ task: { key: "P-1" } }), true);
});

test("the question follows the key through a refresh that moves the rows", () => {
  assert.equal(stillAsked("XYZ-12", tasks("ABC-1", "XYZ-12")), "XYZ-12");
  assert.equal(stillAsked("XYZ-12", tasks("XYZ-12", "ABC-1")), "XYZ-12");
});

test("the question goes with its task, and doesn't come back later", () => {
  assert.equal(stillAsked("XYZ-12", tasks("ABC-1")), null);
  assert.equal(stillAsked(null, tasks("ABC-1")), null);
});

const filters = { assignee: "anyone", state: "open", text: "x" };

test("the picked project comes from the repo's context, and Anyone stays with it", () => {
  assert.deepEqual(filtersFor(filters, { site: {}, filter: "PAY" }), { ...filters, project: "PAY" });
});

test("back on All, Anyone goes back to me", () => {
  assert.deepEqual(filtersFor({ ...filters, project: "PAY" }, { site: {}, filter: "" }), { ...filters, project: "", assignee: "me" });
});

test("GitHub has no project and keeps Anyone", () => {
  assert.deepEqual(filtersFor({ ...filters, project: "PAY" }, { github: {} }), { ...filters, project: "" });
});
