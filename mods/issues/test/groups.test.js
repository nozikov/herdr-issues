import test from "node:test";
import assert from "node:assert/strict";
import { groupByStatus, isHighPriority, timeAgo } from "../lib/groups.js";

test("groups keep the order their status was first met in", () => {
  const t = (key, state) => ({ key, state });
  const groups = groupByStatus([t("A-1", "Doing"), t("A-2", "Ready"), t("A-3", "Doing"), t("A-4", "")]);
  assert.deepEqual(groups.map((g) => g.state), ["Doing", "Ready", ""]);
  assert.deepEqual(groups[0].tasks.map((x) => x.key), ["A-1", "A-3"]);
  assert.deepEqual(groupByStatus([]), []);
});

test("a state named like an object's own property is only a name", () => {
  assert.deepEqual(groupByStatus([{ key: "A-1", state: "constructor" }]).map((g) => g.state), ["constructor"]);
});

test("high priority names, any case", () => {
  for (const name of ["High", "highest", "CRITICAL", "Blocker", " high "]) assert.equal(isHighPriority(name), true, name);
  for (const name of ["Medium", "Low", "", undefined, null, "Higher than most"]) assert.equal(isHighPriority(name), false, String(name));
});

test("timeAgo is short", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(timeAgo(at(10000), now), "just now");
  assert.equal(timeAgo(at(5 * MIN), now), "5m ago");
  assert.equal(timeAgo(at(3 * HOUR), now), "3h ago");
  assert.equal(timeAgo(at(2 * DAY), now), "2d ago");
  assert.equal(timeAgo(at(15 * DAY), now), "2w ago");
  assert.equal(timeAgo(at(70 * DAY), now), "2mo ago");
  assert.equal(timeAgo(at(800 * DAY), now), "2y ago");
});

test("timeAgo takes Jira's offset without a colon, and refuses what isn't a date", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  assert.equal(timeAgo("2026-11-05T14:00:00.000+0300", now), "1h ago");
  assert.equal(timeAgo("2026-11-05T11:00:00.000-0000", now), "1h ago");
  assert.equal(timeAgo("2026-11-06T00:00:00Z", now), "just now");
  for (const bad of ["", "soon", undefined, null]) assert.equal(timeAgo(bad, now), "");
});
