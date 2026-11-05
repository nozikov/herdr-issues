import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adfToText } from "../lib/adf.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("readable text from the fixture", async () => {
  const out = adfToText(await fixture("jira-adf.json"));
  assert.match(out, /^Heading\n\nHello @Ann /);
  assert.match(out, /the docs \(https:\/\/docs\.example\.com\/page\)/);
  assert.match(out, /\n- first\n- second\n/);
  assert.match(out, /const x = 1/);
});
test("null and unknown nodes", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText({ type: "doc", content: [{ type: "mystery", content: [{ type: "text", text: "kept" }] }] }), "kept");
});
test("nested lists are indented", () => {
  const item = (text, ...rest) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...rest] });
  const doc = { type: "doc", content: [{ type: "orderedList", content: [
    item("a", { type: "bulletList", content: [item("b")] }),
  ] }] };
  assert.equal(adfToText(doc), "1. a\n   - b");
});
