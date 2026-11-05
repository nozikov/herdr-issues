// Tracker text for reading: Jira wiki markup and ADF to Markdown, and Markdown made safe to draw.
// Pure: no Node APIs, the Herdr runtime has none. The agent's prompt never comes from here.

const MAX = 40000;
const MORE = "\n\nOpen in browser to read the rest.";
// An invisible break. It works in any context, so nothing depends on agreeing with the Markdown
// reader about where a code span starts: `<` and `![` are harmless next to it, in code or not.
const BREAK = "\u200b";
// Control bytes, and the two characters the links below are parked behind.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ue000\ue001]/g;

const IMAGE = /!\[([^\[\]]*)\]\([^)]{0,2000}\)/g;
const LINK = /\[([^\[\]]*)\]\(\s*([^\s()]*(?:\([^\s()]*\)[^\s()]*)?)(?:\s+"[^"\n]*")?\s*\)/g;
const WEB = /^https?:\/\/[^\s<>"'\\]+$/i;

function inert(text) {
  return text
    .replace(/!\[/g, `!${BREAK}[`) // any image left, with a reference or a broken target
    .replace(/\]\(/g, `]${BREAK}(`) // any link left
    .replace(/\]:/g, `]${BREAK}:`) // a reference definition, so `[a][b]` has nowhere to go
    .replace(/<(?=[a-z/!?])/gi, `<${BREAK}`); // raw HTML and autolinks
}

function cleanText(text) {
  let out = text;
  for (let i = 0; i < 4; i++) { // tidies alt text inside alt text; `finish` is what guarantees
    const next = out.replace(IMAGE, "$1");
    if (next === out) break;
    out = next;
  }
  const links = [];
  out = out.replace(LINK, (_m, label, url) => {
    if (!WEB.test(url)) return label;
    links.push(`[${inert(label)}](${url})`);
    return `\ue000${links.length - 1}\ue001`;
  });
  return inert(out).replace(/\ue000(\d+)\ue001/g, (_m, i) => links[i]);
}

// The guarantee, last and over everything, code included, so it rests on no parsing above: the
// output holds no `![` and no `<img`. Nothing after this may change the text.
function finish(text) {
  return text.replace(/!\[/g, `!${BREAK}[`).replace(/<(?=img)/gi, `<${BREAK}`);
}

// A fence as this code sees it. It's drawn again at the line start, longer than anything inside:
// a Markdown reader then ends any list or quote around it, and closes it where this code does.
function fence(lang, lines) {
  const longest = Math.max(2, ...lines.join("\n").match(/`+/g)?.map((run) => run.length) ?? []);
  const mark = "`".repeat(longest + 1);
  return [`${mark}${/^[\w+#.-]+$/.test(lang) ? lang : ""}`, ...lines, mark].join("\n");
}

function opener(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m || (m[1][0] === "`" && m[2].includes("`"))) return null;
  return { mark: m[1], lang: m[2].trim().split(/\s+/)[0] };
}

const closes = (line, mark) => {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(m) && m[1][0] === mark[0] && m[1].length >= mark.length;
};

export function safeMarkdown(text) {
  if (typeof text !== "string") return "";
  const clean = text.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  const lines = clean.slice(0, MAX).split("\n");
  const out = [];
  let plain = [];
  const flush = () => {
    if (plain.length) out.push(cleanText(plain.join("\n")));
    plain = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = opener(lines[i]);
    if (!open) {
      plain.push(lines[i]);
      continue;
    }
    flush();
    const code = [];
    for (i++; i < lines.length && !closes(lines[i], open.mark); i++) code.push(lines[i]);
    out.push(fence(open.lang, code));
  }
  flush();
  return finish(out.join("\n")) + (clean.length > MAX ? MORE : "");
}

// ---------- Jira wiki markup ----------

const PICTURE = /(^|[^\w!])!([^\s!|][^!|\n]*\.(?:png|jpe?g|gif|svg|webp|bmp|tiff?))(?:\|([^!\n]*))?!/gim;
const AROUND = "(^|[\\s(])";
const AFTER = "(?=$|[\\s.,;:!?)])";
const span = (mark) => new RegExp(`${AROUND}${mark}(\\S(?:[^\\n]*?\\S)?)${mark}${AFTER}`, "gm");
const BOLD = span("\\*");
const ITALIC = span("_");
const STRIKE = span("-");
const UNDER = span("\\+");
const RULE = /^-{4,}\s*$/;

const pictureName = (src, params) => /(?:^|,)\s*alt=([^,]+)/.exec(params ?? "")?.[1].trim().replace(/^"|"$/g, "") || src.split("/").pop();

function wikiInline(text) {
  return text
    .replace(PICTURE, (_m, before, src, params) => before + pictureName(src, params))
    .replace(/\[~([^\]\n]+)\]/g, "@$1")
    .replace(/\[([^\[\]|\n]+)\|([^\[\]\s]+)\]/g, "[$1]($2)")
    .replace(/\[(https?:\/\/[^\[\]\s|]+)\]/g, "[$1]($1)")
    .replace(BOLD, "$1**$2**")
    .replace(ITALIC, "$1*$2*")
    .replace(STRIKE, "$1~~$2~~")
    .replace(UNDER, "$1$2");
}

const cells = (line, mark) => line.trim().replace(new RegExp(`^${mark}|${mark}$`, "g"), "").split(new RegExp(mark)).map((c) => c.trim());
const row = (values) => `| ${values.join(" | ")} |`;

function wikiLine(line) {
  const heading = /^h([1-6])\.\s+(.*)$/.exec(line);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${heading[2]}`;
  const item = /^(\*+|#+)\s+(.*)$/.exec(line);
  if (item) {
    const depth = item[1].length - 1;
    return item[1][0] === "*" ? `${"  ".repeat(depth)}- ${item[2]}` : `${"   ".repeat(depth)}1. ${item[2]}`;
  }
  if (/^bq\.\s/.test(line)) return `> ${line.replace(/^bq\.\s+/, "")}`;
  if (/^\|\|.*\|\|\s*$/.test(line)) {
    const head = cells(line, "\\|\\|");
    return `${row(head)}\n${row(head.map(() => "---"))}`;
  }
  if (/^\|.*\|\s*$/.test(line)) return row(cells(line, "\\|"));
  return line;
}

export function wikiToMarkdown(text) {
  if (typeof text !== "string") return "";
  const kept = []; // code keeps its stars and brackets
  const keep = (value) => `\ue000${kept.push(value) - 1}\ue001`;
  const source = text.replace(/\r\n?/g, "\n").replace(/[\ue000\ue001]/g, "");
  const parked = source
    .replace(/\{code(?::([^}\n]*))?\}\n?([\s\S]*?)\n?\{code\}/g, (_m, params, code) => keep(fence(params ?? "", code.split("\n"))))
    .replace(/\{noformat[^}\n]*\}\n?([\s\S]*?)\n?\{noformat\}/g, (_m, code) => keep(fence("", code.split("\n"))))
    .replace(/\{\{([^}\n]+)\}\}/g, (_m, code) => keep(`\`${code}\``))
    .replace(/\{quote\}\n?([\s\S]*?)\n?\{quote\}/g, (_m, quoted) => quoted.split("\n").map((l) => `> ${l}`).join("\n"))
    .replace(/\{(?:color|panel)[^}\n]*\}/g, "");
  const lines = parked.split("\n").map((line) => (RULE.test(line) ? "---" : wikiLine(wikiInline(line))));
  return lines.join("\n").replace(/\ue000(\d+)\ue001/g, (_m, i) => kept[i]);
}

// ---------- ADF ----------

const kids = (node) => (Array.isArray(node?.content) ? node.content : []);

const MARKS = {
  code: (text) => `\`${text}\``,
  strike: (text) => `~~${text}~~`,
  em: (text) => `*${text}*`,
  strong: (text) => `**${text}**`,
};

function adfText(node) {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const styled = ["code", "strike", "em", "strong"].reduce((text, type) => (marks.some((m) => m?.type === type) ? MARKS[type](text) : text), String(node.text ?? ""));
  const href = marks.find((m) => m?.type === "link")?.attrs?.href;
  return href ? `[${styled}](${href})` : styled;
}

function adfInline(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "text": return adfText(node);
    case "hardBreak": return "\n";
    case "mention": return `@${String(node.attrs?.text ?? "").replace(/^@/, "")}`;
    case "emoji": return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
    case "inlineCard": return String(node.attrs?.url ?? "");
    case "media": return String(node.attrs?.alt ?? "");
    default: return kids(node).map(adfInline).join("");
  }
}

const adfBlocks = (nodes) => nodes.map(adfBlock).filter((s) => s !== "").join("\n\n");

function adfList(node) {
  const bullet = node.type === "bulletList";
  return kids(node).map((item, i) => {
    const prefix = bullet ? "- " : `${i + 1}. `;
    const pad = " ".repeat(prefix.length);
    const text = kids(item).map(adfBlock).filter((s) => s !== "").join("\n");
    return text.split("\n").map((line, n) => (n === 0 ? prefix : pad) + line).join("\n");
  }).join("\n");
}

function adfTable(node) {
  const rows = kids(node).map((r) => row(kids(r).map((c) => adfInline(c).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|"))));
  const width = kids(kids(node)[0]).length;
  return [rows[0], row(Array(width).fill("---")), ...rows.slice(1)].join("\n");
}

function adfBlock(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "heading": return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${kids(node).map(adfInline).join("")}`;
    case "paragraph": return kids(node).map(adfInline).join("");
    case "bulletList":
    case "orderedList": return adfList(node);
    case "codeBlock": return fence(String(node.attrs?.language ?? ""), kids(node).map((c) => String(c?.text ?? "")).join("").split("\n"));
    case "blockquote": return adfBlocks(kids(node)).split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    case "table": return adfTable(node);
    case "mediaSingle":
    case "mediaGroup": return kids(node).map(adfInline).filter(Boolean).join(" ");
    default: return kids(node).some((c) => c?.type !== "text") ? adfBlocks(kids(node)) : kids(node).map(adfInline).join("");
  }
}

export function adfToMarkdown(doc) {
  if (!doc || typeof doc !== "object") return "";
  return adfBlock(doc).trim();
}
