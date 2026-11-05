import test from "node:test";
import assert from "node:assert/strict";
import { safeMarkdown, wikiToMarkdown, adfToMarkdown } from "../lib/markup.js";

// The reader sees the words without the invisible breaks that keep them inert.
const seen = (text) => safeMarkdown(text).replace(/​/g, "");

// What a Markdown reader must not find in the result.
function assertInert(text) {
  const out = safeMarkdown(text);
  assert.doesNotMatch(out, /!\[/, out);
  assert.doesNotMatch(out, /<[a-z/!?]/i, out);
  assert.doesNotMatch(out, /\]\((?!https?:\/\/)/i, out);
  assert.doesNotMatch(out, /\]:/, out);
}

test("safeMarkdown leaves plain formatting alone", () => {
  const text = "# Title\n\n**bold** and `a < b`\n\n- one\n- two";
  assert.equal(safeMarkdown(text), text);
});

test("images go, their alt text stays", () => {
  assert.equal(safeMarkdown("see ![a chart](https://x.test/p.png) here"), "see a chart here");
  assert.equal(safeMarkdown('![a](https://x.test/p.png "title")'), "a");
  assert.equal(safeMarkdown("![](https://x.test/p.png)"), "");
  assert.equal(safeMarkdown("[![badge](https://x.test/b.svg)](https://x.test/)"), "[badge](https://x.test/)");
  assert.equal(safeMarkdown("![![x](https://x.test/a.png)](https://x.test/b.png)"), "x");
});

test("every other way to write an image is inert", () => {
  for (const text of [
    "![a][r]\n\n[r]: https://x.test/p.png",
    "![a][]\n\n[a]: https://x.test/p.png",
    "![a]\n\n[a]: https://x.test/p.png",
    "  [r]: https://x.test/p.png\n![a][r]",
    "> [r]: https://x.test/p.png\n\n![a][r]",
    "![a](<https://x.test/p q.png>)",
    "![a](https://x.test/p(1).png)",
    "![a\nb](https://x.test/p.png)",
    "![[a]](https://x.test/p.png)",
    "!\x00[a](https://x.test/p.png)",
    "<img src=https://x.test/p.png>",
    "<IMG SRC='https://x.test/p.png'/>",
    "<img\nsrc=https://x.test/p.png>",
    "<svg onload=x>",
    "<!-- c --><picture><source srcset=https://x.test/p.png>",
    "`a\nb` <img src=https://x.test/p.png> `c`",
    "\\` <img src=https://x.test/p.png> `",
    "- `a\n- <img src=https://x.test/p.png> `",
  ]) assertInert(text);
});

test("links keep a target only for http(s)", () => {
  assert.equal(safeMarkdown("[docs](https://x.test/a?b=1)"), "[docs](https://x.test/a?b=1)");
  assert.equal(safeMarkdown('[docs](http://x.test/ "t")'), "[docs](http://x.test/)");
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:x", "file:///etc/passwd", "data:text/html,x", "vbscript:x", "ssh://x.test", "//x.test/a", "/relative", "x-app://open"])
    assert.equal(seen(`[docs](${url})`), "docs", url);
  assert.equal(seen("[docs](<javascript:x>)"), "docs");
  assert.equal(safeMarkdown("[docs](java\nscript:x)").includes("]("), false);
  assertInert("[<img src=x>](https://x.test/)");
});

test("autolinks, reference links and raw HTML are text", () => {
  for (const text of ["<file:///etc/passwd>", "<javascript:x>", "<https://x.test>", '<a href="javascript:x">y</a>', "[a][b]\n\n[b]: file:///etc/passwd", "[b]: javascript:x"]) assertInert(text);
  assert.ok(seen("<file:///etc/passwd>").includes("file:///etc/passwd"));
  assert.ok(seen("<b>bold</b>").includes("<b>bold</b>"), "the words stay readable");
});

test("code fences read as they came", () => {
  const out = safeMarkdown("```js\nconst a = <b>![x](https://x.test/p.png)</b>;\n```\nafter");
  assert.ok(out.replace(/\u200b/g, "").includes("const a = <b>![x](https://x.test/p.png)</b>;"));
  assert.ok(out.startsWith("```js\n"));
  assert.ok(out.endsWith("after"));
});

test("a fence can't leave hostile text open to the reader", () => {
  // The closing fence ends the code, so what follows is cleaned.
  const after = safeMarkdown("```\na\n```\n![x](https://x.test/p.png)").split("```").at(-1);
  assert.doesNotMatch(after, /!\[/);
  // An unclosed fence is closed, and one nested in a list is redrawn at the line start: the reader
  // then agrees with this code about where the code is.
  assert.equal(safeMarkdown("```\nopen").endsWith("```"), true);
  assert.match(safeMarkdown("- ```\n  x\n  ```\n![x](https://x.test/p.png)\n"), /^`{3,}$/m);
  // Backticks inside can't close ours.
  assert.ok(safeMarkdown("~~~\n````\n~~~").startsWith("`````"));
  // An info string is a word, not a place for text.
  assert.equal(safeMarkdown("```<img src=x>\na\n```").split("\n")[0], "```");
  // A backtick in the info string means it was no fence at all.
  assertInert("``` a`b\n<img src=x>");
});

test("control bytes go, and the text is cut to a size that draws", () => {
  assert.equal(safeMarkdown("a\x1b[31mb\x07\r\nc"), "a[31mb\nc");
  const long = safeMarkdown("x".repeat(100000));
  assert.ok(long.length < 45000);
  assert.ok(long.endsWith("Open in browser to read the rest."));
  assert.equal(safeMarkdown(undefined), "");
  assert.equal(safeMarkdown(12), "");
});

test("hostile repetition finishes quickly", () => {
  const start = Date.now();
  for (const piece of ["[", "![", "](", "<", "[a](", "`", "![a](", "\n```"]) safeMarkdown(piece.repeat(20000));
  assert.ok(Date.now() - start < 1000);
});

test("wiki markup becomes markdown", () => {
  assert.equal(wikiToMarkdown("h1. Title\nh3. Sub"), "# Title\n### Sub");
  assert.equal(wikiToMarkdown("*bold* and _it_ and {{mono}} and -gone- and +under+"), "**bold** and *it* and `mono` and ~~gone~~ and under");
  assert.equal(wikiToMarkdown("* one\n** two\n# first\n## second"), "- one\n  - two\n1. first\n   1. second");
  assert.equal(wikiToMarkdown("bq. said"), "> said");
  assert.equal(wikiToMarkdown("{quote}a\nb{quote}"), "> a\n> b");
  assert.equal(wikiToMarkdown("[docs|https://x.test/a] and [https://x.test/b]"), "[docs](https://x.test/a) and [https://x.test/b](https://x.test/b)");
  assert.equal(wikiToMarkdown("[~ann.example] said"), "@ann.example said");
  assert.equal(wikiToMarkdown("{color:red}hot{color}"), "hot");
  assert.equal(wikiToMarkdown("----"), "---");
  assert.equal(wikiToMarkdown("||a||b||\n|1|2|"), "| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(wikiToMarkdown("{code:java}\nint a = *b*;\n{code}\nnext"), "```java\nint a = *b*;\n```\nnext");
  assert.equal(wikiToMarkdown("{noformat}*x*{noformat}"), "```\n*x*\n```");
  assert.equal(wikiToMarkdown(undefined), "");
});

test("wiki images leave their name, and sentences keep their marks", () => {
  assert.equal(wikiToMarkdown("!shot.png!"), "shot.png");
  assert.equal(wikiToMarkdown("!shot.png|thumbnail!"), "shot.png");
  assert.equal(wikiToMarkdown("!shot.png|alt=the error!"), "the error");
  assert.equal(wikiToMarkdown("!https://x.test/a/p.png!"), "p.png");
  assert.equal(wikiToMarkdown("Wow! It works!"), "Wow! It works!");
  assert.equal(wikiToMarkdown("a - b - c and 2*3*4"), "a - b - c and 2*3*4");
});

test("wiki links with a bad target end up as text after cleaning", () => {
  assert.equal(seen(wikiToMarkdown("[x|javascript:alert(1)]")), "x");
  assert.equal(seen(wikiToMarkdown("[x|file:///etc/passwd]")), "x");
  assertInert(wikiToMarkdown("!javascript:x.png! [a|<img src=x>]"));
  assert.doesNotMatch(safeMarkdown(wikiToMarkdown("{code}\n```\n{code}\n<img src=x>")).split("\n").at(-1), /<i/);
});

const doc = (...content) => ({ type: "doc", version: 1, content });
const p = (...content) => ({ type: "paragraph", content });
const text = (value, ...marks) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });

test("ADF becomes markdown", () => {
  assert.equal(adfToMarkdown(doc(
    { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
    p(text("a "), text("b", { type: "strong" }), text(" "), text("c", { type: "em" }), text(" "), text("d", { type: "code" }), text(" "), text("e", { type: "strike" })),
    { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }, { type: "listItem", content: [p(text("two"))] }] },
    { type: "orderedList", content: [{ type: "listItem", content: [p(text("first"))] }] },
    { type: "codeBlock", attrs: { language: "js" }, content: [text("a()")] },
    { type: "blockquote", content: [p(text("said"))] },
    { type: "rule" },
  )), "## Title\n\na **b** *c* `d` ~~e~~\n\n- one\n- two\n\n1. first\n\n```js\na()\n```\n\n> said\n\n---");
});

test("ADF links, mentions and media", () => {
  assert.equal(adfToMarkdown(doc(p(text("docs", { type: "link", attrs: { href: "https://x.test/" } })))), "[docs](https://x.test/)");
  assert.equal(adfToMarkdown(doc(p({ type: "mention", attrs: { text: "@Ann" } }, text(" "), { type: "emoji", attrs: { text: "ok" } }, { type: "hardBreak" }, { type: "inlineCard", attrs: { url: "https://x.test/c" } }))), "@Ann ok\nhttps://x.test/c");
  assert.equal(adfToMarkdown(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { alt: "the error", url: "https://x.test/p.png" } }] })), "the error");
  assert.equal(adfToMarkdown(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { id: "1" } }] })), "");
  assert.equal(adfToMarkdown(null), "");
  assert.equal(adfToMarkdown("text"), "");
});

test("ADF tables and unknown containers keep their text", () => {
  const cell = (type, value) => ({ type, content: [p(text(value))] });
  assert.equal(adfToMarkdown(doc({ type: "table", content: [
    { type: "tableRow", content: [cell("tableHeader", "a"), cell("tableHeader", "b")] },
    { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
  ] })), "| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(adfToMarkdown(doc({ type: "panel", content: [p(text("note"))] })), "note");
});

test("ADF text can't smuggle anything past cleaning", () => {
  assertInert(adfToMarkdown(doc(p(text("![x](https://x.test/p.png) <img src=x>"), text("y", { type: "link", attrs: { href: "javascript:x" } })))));
  assert.equal(seen(adfToMarkdown(doc(p(text("y", { type: "link", attrs: { href: "javascript:x" } }))))), "y");
});

// The guarantee, whatever the path through the code: nothing is left that draws an image.
function assertNoImage(text, name = text.slice(0, 60)) {
  const out = safeMarkdown(text);
  assert.equal(out.includes("!["), false, name);
  assert.doesNotMatch(out, /<img/i, name);
}

const nest = (depth, url) => `${"![".repeat(depth)}a${`](${url})`.repeat(depth)}`;

test("no input leaves an image: nesting", () => {
  assertNoImage("![![![![![a](u)](u)](u)](u)](u)");
  assertNoImage(nest(5, "http://x.test/p.png"));
  for (const depth of [1, 2, 3, 4, 5, 6, 7, 8, 16, 50, 500, 5000]) {
    assertNoImage(nest(depth, "u"), `u ${depth}`);
    assertNoImage(nest(depth, "http://x.test/p.png"), `http ${depth}`);
  }
});

test("no input leaves an image: long targets", () => {
  for (const size of [1990, 1999, 2000, 2001, 2100, 10000, 39000]) {
    const url = `http://x.test/p?${"a".repeat(size)}`;
    assertNoImage(`![a](${url})`, `plain ${size}`);
    assertNoImage(`before ![a](${url}) after`, `inside ${size}`);
    assertNoImage(`![a](${url} "t")`, `title ${size}`);
    assertNoImage(wikiToMarkdown(`![a|${url}]`), `wiki ${size}`);
    assertNoImage(`![a](http://x.test/p?${")".repeat(size)})`, `parens ${size}`);
  }
});

test("no input leaves an image: a link parked next to a bang, and the other shapes", () => {
  for (const text of [
    "![a](http://x.test/p(1)(2).png)",
    "!!![a](http://x.test/p.png)",
    "!0[a](http://x.test/p.png)",
    "!\x7f[a](http://x.test/p.png)",
    "![a](http://x.test/p.png)![b](http://x.test/q.png)",
    "[![a](http://x.test/" + "b".repeat(3000) + ")](http://x.test/)",
    "![[a](http://x.test/1)](http://x.test/2)",
    "```\n![a](http://x.test/p.png)\n<img src=x>\n```",
    "~~~\n<IMG src=x>",
    "`![a](http://x.test/p.png)`",
    "<<img src=x>",
    "<i\x00mg src=x>",
    "<img src=x",
  ]) assertNoImage(text);
  assertNoImage(safeMarkdown(`${"x".repeat(39995)}![a](http://x.test/p.png)`));
  assertNoImage(adfToMarkdown({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "![a](http://x.test/p.png) <img src=x>" }] }] }));
});

test("the guarantee stays linear-ish on long input", () => {
  const start = Date.now();
  for (const text of [nest(6000, "u"), nest(3000, "http://x.test/"), `![a](http://x.test/${"a".repeat(39000)})`, "![a](http://x.test/) ".repeat(2000), "<img ".repeat(8000), "!".repeat(40000)]) safeMarkdown(text);
  assert.ok(Date.now() - start < 1000);
});
