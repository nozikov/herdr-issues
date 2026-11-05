import test from "node:test";
import assert from "node:assert/strict";
import { branchName, safeKey, worktreeRoot, worktreeFolder, matchesTask } from "../lib/names.js";
import { nodeExec } from "./_util.js";

test("examples from the spec", () => {
  assert.equal(branchName("PAY-431", "Double charge"), "PAY-431-double-charge");
  assert.equal(branchName("#412", "Fix login"), "412-fix-login");
});
test("a title with no ASCII gives the key alone", () => {
  assert.equal(branchName("PAY-431", "Двойное списание"), "PAY-431");
});
test("at most 50 characters, never ending in punctuation", () => {
  const b = branchName("PAY-431", "a".repeat(44) + " b c");
  assert.ok(b.length <= 50);
  assert.match(b, /[A-Za-z0-9]$/);
});
test("every name passes git check-ref-format", async () => {
  for (const title of ["a..b", "x.lock", "-lead", "end.", "a/b", "$(rm -rf ~)", "`x`", "a b;c|d", "@{", "~^:?*["]) {
    const r = await nodeExec("git", ["check-ref-format", "--branch", branchName("#7", title)], {});
    assert.equal(r.code, 0, title);
  }
});
test("matchesTask needs the key as a whole word", () => {
  assert.ok(matchesTask("412-fix-login", "#412"));
  assert.ok(matchesTask("PAY-431", "PAY-431"));
  assert.ok(!matchesTask("4120-other", "#412"));
  assert.ok(!matchesTask("PAY-4310-x", "PAY-431"));
  assert.ok(!matchesTask("413-regression-from-412", "#412"));
  assert.ok(!matchesTask("fix-412", "#412"));
  assert.ok(!matchesTask("413-regression-from-412", "#412"));
  assert.ok(!matchesTask("fix-412", "#412"));
});
test("safeKey drops the hash", () => {
  assert.equal(safeKey("#412"), "412");
});
test("worktreeRoot and worktreeFolder", () => {
  assert.equal(worktreeRoot("/h"), "/h/.herdr/worktrees");
  assert.equal(worktreeFolder("/h", "api", "412-x"), "/h/.herdr/worktrees/api/412-x");
});
