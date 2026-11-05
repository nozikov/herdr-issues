// Atlassian Document Format to readable plain text.
const BLOCKS = new Set(["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote", "rule",
  "panel", "table", "mediaSingle", "mediaGroup", "expand", "listItem", "tableRow", "tableCell", "tableHeader"]);

const kids = (node) => (Array.isArray(node?.content) ? node.content : []);

function inline(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "text": {
      const href = node.marks?.find((m) => m.type === "link")?.attrs?.href;
      const text = node.text ?? "";
      return href && href !== text ? `${text} (${href})` : text;
    }
    case "hardBreak": return "\n";
    case "mention": return `@${String(node.attrs?.text ?? "").replace(/^@/, "")}`;
    case "emoji": return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "inlineCard": return node.attrs?.url ?? "";
    default: return kids(node).map(inline).join("");
  }
}

function prefixed(text, prefix) {
  const pad = " ".repeat(prefix.length);
  return text.split("\n").map((line, i) => (i === 0 ? prefix : pad) + line).join("\n");
}

function join(nodes) {
  return nodes.map(block).filter((s) => s !== "").join("\n\n");
}

// A list item holds paragraphs and nested lists, one per line.
function itemText(item) {
  return kids(item).map(block).filter((s) => s !== "").join("\n");
}

function block(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "bulletList":
    case "orderedList":
      return kids(node).map((item, i) =>
        prefixed(item.type === "listItem" ? itemText(item) : block(item), node.type === "bulletList" ? "- " : `${i + 1}. `),
      ).join("\n");
    case "codeBlock": return kids(node).map(inline).join("");
    case "blockquote": return join(kids(node)).split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    default: {
      const children = kids(node);
      // Unknown containers keep their text; block children get paragraph breaks.
      return children.some((c) => BLOCKS.has(c?.type)) ? join(children) : inline(node);
    }
  }
}

export function adfToText(doc) {
  if (!doc || typeof doc !== "object") return "";
  return block(doc).trim();
}
