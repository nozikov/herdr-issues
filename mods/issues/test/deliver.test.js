import test from "node:test";
import assert from "node:assert/strict";
import { deliver } from "../lib/deliver.js";

test("tab.new gets the space, name, folder, argv and task, once", () => {
  const calls = [];
  const argv = ["claude"];
  const out = deliver({ run: (name, args) => calls.push({ name, args }), space: "S", name: "PAY-1", folder: "/w/f", argv, task: "Work on this." });
  assert.equal(out, undefined);
  assert.deepEqual(calls, [{ name: "tab.new", args: { space: "S", name: "PAY-1", folder: "/w/f", argv: ["claude"], task: "Work on this." } }]);
});

test("argv is passed on unchanged, with no added flag", () => {
  const calls = [];
  const argv = ["codex", "--model", "x"];
  deliver({ run: (name, args) => calls.push(args), space: "S", name: "k", folder: "/f", argv, task: "t" });
  assert.equal(calls[0].argv, argv);
  assert.deepEqual(argv, ["codex", "--model", "x"]);
});

test("the task is one value, whatever it holds", () => {
  const calls = [];
  const task = "$(rm -rf ~)`x`;|\n--flag";
  deliver({ run: (name, args) => calls.push(args), space: "S", name: "k", folder: "/f", argv: ["claude"], task });
  assert.equal(calls[0].task, task);
  assert.deepEqual(calls[0].argv, ["claude"]);
});
