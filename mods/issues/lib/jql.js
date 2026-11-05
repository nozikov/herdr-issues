// Jira project keys: uppercase letters, digits and underscores, starting with a letter, two characters or more.
export function isProjectKey(s) {
  return typeof s === "string" && /^[A-Z][A-Z0-9_]+$/.test(s);
}

export function jqlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// filters: project is optional, assignee "me" | "anyone", state "open" | "all", text is free search
// text. Without a project the assignee is always me: nothing may ask for every task on the site.
export function buildJql({ project, assignee, state, text }) {
  const picked = project !== undefined && project !== null && project !== "";
  if (picked && !isProjectKey(project)) throw new Error(`Not a Jira project key: ${project}`);
  // Project keys are quoted because keys like AND are reserved words.
  const clauses = picked ? [`project = ${jqlString(project)}`] : [];
  if (assignee === "me" || !picked) clauses.push("assignee = currentUser()");
  if (state === "open") clauses.push("resolution = Unresolved");
  const words = String(text ?? "")
    .replace(/[+\-&|!(){}[\]^~*?:\\/"\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (words) clauses.push(`text ~ ${jqlString(words)}`);
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

// `#123` or `PAY-431`, any case. Anything else is not a lookup.
export function parseLookup(text) {
  const s = String(text).trim();
  if (/^#\d+$/.test(s)) return { key: s };
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(s)) return { key: s.toUpperCase() };
  return null;
}
