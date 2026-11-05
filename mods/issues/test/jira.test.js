import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiraSource, validateSite } from "../sources/jira.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const filters = { assignee: "me", state: "open", text: "" };
const TOKEN_ARGS = ["security", ["find-generic-password", "-s", "herdr-issues-jira", "-w"]];

const cloudSite = { url: "https://jira.example.com", type: "cloud", email: "me@x.io", tokenCommand: ["security", "find-generic-password", "-s", "herdr-issues-jira", "-w"] };
const serverSite = { url: "https://jira.example.com", type: "server", tokenCommand: cloudSite.tokenCommand };

function reply(body, extra = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status: 200, ok: true, url: extra.url,
    text: async () => text,
    json: async () => JSON.parse(text),
    ...extra,
  };
}

// `routes` is a function (url, opts) -> reply | Promise<reply> | throws.
function setup({ site = cloudSite, routes, token = "tok\n", exitCode = 0, stderr = "" } = {}) {
  const requests = [];
  const execCalls = [];
  const exec = async (cmd, args) => {
    execCalls.push([cmd, args]);
    return { code: exitCode, stdout: token, stderr };
  };
  const fetch = async (url, opts) => {
    requests.push({ url, opts });
    return routes(url, opts);
  };
  const source = createJiraSource({ site, exec, fetch });
  return { source, requests, execCalls };
}

const standard = (searchBody) => async (url) => {
  if (/\/myself/.test(url)) return reply({ displayName: "Me" });
  return reply(await searchBody);
};

test("Cloud: GET search/jql with fields and Basic auth", async () => {
  const { source, requests } = setup({ routes: standard(fixture("jira-cloud-search.json")) });
  const tasks = await source.list(filters);
  const search = requests.find((r) => r.url.includes("/rest/api/3/search/jql"));
  assert.equal(search.opts.method ?? "GET", "GET");
  assert.match(search.url, /^https:\/\/jira\.example\.com\/rest\/api\/3\/search\/jql\?/);
  assert.match(search.url, /[?&]maxResults=100(&|$)/);
  assert.match(search.url, /[?&]fields=summary%2Cdescription%2Cstatus%2Cassignee%2Clabels%2Cupdated%2Cpriority/);
  assert.match(search.url, /[?&]jql=assignee%20%3D%20currentUser/);
  assert.equal(search.opts.headers.Authorization, "Basic " + Buffer.from("me@x.io:tok").toString("base64"));
  assert.deepEqual(tasks[0], {
    key: "EXAMPLE-1", title: "Login form rejects valid emails", url: "https://jira.example.com/browse/EXAMPLE-1",
    state: "In Progress", assignee: "Ann Example", labels: ["bug", "login"],
    updatedAt: "2026-10-30T09:15:00.000+0000", body: "Plus signs are refused.", markdown: "Plus signs are refused.", priority: "",
  });
  assert.equal(tasks[1].assignee, "");
  assert.equal(tasks[1].body, "");
});
test("Cloud: non-ASCII credentials are UTF-8 encoded", async () => {
  const { source, requests } = setup({ site: { ...cloudSite, email: "ян@x.io" }, token: "tök", routes: standard(fixture("jira-cloud-search.json")) });
  await source.list(filters);
  assert.equal(requests[0].opts.headers.Authorization, "Basic " + Buffer.from("ян@x.io:tök", "utf8").toString("base64"));
});
test("Cloud follows nextPageToken up to 100 tasks", async () => {
  const base = await fixture("jira-cloud-search.json");
  const page = (n) => Array.from({ length: 60 }, (_, i) => ({ ...base.issues[0], key: `EXAMPLE-${n * 100 + i}` }));
  const { source, requests } = setup({
    routes: async (url) => {
      if (/\/myself/.test(url)) return reply({});
      return reply(/nextPageToken=p2/.test(url) ? { issues: page(2), nextPageToken: "p3" } : { issues: page(1), nextPageToken: "p2" });
    },
  });
  const tasks = await source.list(filters);
  const searches = requests.filter((r) => r.url.includes("/search/jql"));
  assert.equal(searches.length, 2);
  assert.match(searches[1].url, /nextPageToken=p2/);
  assert.equal(tasks.length, 100);
});
test("Server: GET /rest/api/2/search with Bearer, wiki text as is", async () => {
  const body = await fixture("jira-server-search.json");
  const { source, requests } = setup({ site: serverSite, routes: standard(body) });
  const tasks = await source.list(filters);
  const search = requests.find((r) => r.url.includes("/rest/api/2/search?"));
  assert.ok(search);
  assert.equal(search.opts.headers.Authorization, "Bearer tok");
  assert.match(search.url, /maxResults=100/);
  assert.equal(tasks[0].body, body.issues[0].fields.description);
  assert.equal(tasks[0].url, "https://jira.example.com/browse/EXAMPLE-1");
});
test("a site with a context path keeps it", async () => {
  const { source, requests } = setup({
    site: { ...serverSite, url: "https://x.example.com/jira/" },
    routes: standard(fixture("jira-server-search.json")),
  });
  const tasks = await source.list(filters);
  assert.ok(requests.every((r) => r.url.startsWith("https://x.example.com/jira/rest/api/2/")));
  assert.equal(tasks[0].url, "https://x.example.com/jira/browse/EXAMPLE-1");
});
test("get fetches one issue", async () => {
  const body = await fixture("jira-cloud-search.json");
  const { source, requests } = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : body.issues[0]) });
  const task = await source.get("EXAMPLE-1");
  assert.equal(task.key, "EXAMPLE-1");
  assert.ok(requests.some((r) => r.url.startsWith("https://jira.example.com/rest/api/3/issue/EXAMPLE-1?")));
});
test("every request is a GET", async () => {
  const body = await fixture("jira-cloud-search.json");
  const { source, requests } = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : /\/issue\//.test(url) ? body.issues[0] : body) });
  await source.list(filters);
  await source.get("EXAMPLE-1");
  assert.ok(requests.length >= 3);
  assert.ok(requests.every((r) => (r.opts.method ?? "GET") === "GET"));
});
test("401 from /myself is auth and forgets the token", async () => {
  let myself = 0;
  const { source, execCalls } = setup({
    routes: async (url) => {
      if (/\/myself/.test(url)) { myself++; return reply({}, { status: 401, ok: false }); }
      return reply({ issues: [] });
    },
  });
  await assert.rejects(source.list(filters), { kind: "auth" });
  await assert.rejects(source.list(filters), { kind: "auth" });
  assert.equal(execCalls.length, 2);
  assert.equal(myself, 2);
});
test("403 from search is auth", async () => {
  const { source } = setup({ routes: async (url) => /\/myself/.test(url) ? reply({}) : reply({}, { status: 403, ok: false }) });
  await assert.rejects(source.list(filters), { kind: "auth" });
});
test("/myself is called once per token", async () => {
  let myself = 0;
  const { source, execCalls } = setup({
    routes: async (url) => {
      if (/\/myself/.test(url)) { myself++; return reply({}); }
      return reply({ issues: [] });
    },
  });
  await source.list(filters);
  await source.list(filters);
  assert.equal(myself, 1);
  assert.equal(execCalls.length, 1);
});
test("token command failure is auth and hides stderr", async () => {
  const { source, requests } = setup({ exitCode: 1, token: "", stderr: "tok-secret", routes: standard({}) });
  await assert.rejects(source.list(filters), (e) => e.kind === "auth" && !e.message.includes("tok-secret"));
  assert.equal(requests.length, 0);
});
test("token command that cannot run is auth", async () => {
  const source = createJiraSource({
    site: cloudSite, fetch: async () => reply({}),
    exec: async () => { throw new Error("spawn security ENOENT"); },
  });
  await assert.rejects(source.list(filters), { kind: "auth" });
});
test("empty token output is auth", async () => {
  const { source } = setup({ token: " \n", routes: standard({}) });
  await assert.rejects(source.list(filters), { kind: "auth" });
});
test("the token command runs without a shell", async () => {
  const { source, execCalls } = setup({ routes: standard(fixture("jira-cloud-search.json")) });
  await source.list(filters);
  assert.deepEqual(execCalls[0], TOKEN_ARGS);
});
test("the token isn't in any error message", async () => {
  for (const site of [cloudSite, serverSite]) {
    // The fetch error echoes the real Authorization header, as a proxy or a runtime might.
    const leaky = setup({ site, token: "tok-secret", routes: async (url, opts) => {
      throw new Error(`connect failed with ${opts.headers.Authorization}`);
    } });
    await assert.rejects(leaky.source.list(filters), (e) => e.kind === "network" && !/tok-secret/.test(e.message)
      && !e.message.includes(Buffer.from("me@x.io:tok-secret").toString("base64")));
  }
  const echo = setup({ token: "tok-secret", routes: async (url) =>
    /\/myself/.test(url) ? reply({}) : reply("oops tok-secret", { status: 500, ok: false }) });
  await assert.rejects(echo.source.list(filters), (e) => e.kind === "other" && !e.message.includes("tok-secret"));
  const html = setup({ token: "tok-secret", routes: async (url) =>
    /\/myself/.test(url) ? reply({}) : reply("x", { json: async () => { throw new SyntaxError("Unexpected token tok-secret"); } }) });
  await assert.rejects(html.source.list(filters), (e) => !e.message.includes("tok-secret"));
});
test("a bad project key is an other error, and no search goes out", async () => {
  const { source, requests } = setup({ routes: standard({ issues: [] }) });
  await assert.rejects(source.list({ ...filters, project: 'PAY" OR 1=1' }), (e) => e.kind === "other" && typeof e.message === "string");
  assert.equal(requests.length, 0);
});
test("list asks for all my tasks, or for the picked project", async () => {
  const { source, requests } = setup({ site: serverSite, routes: standard({ issues: [] }) });
  await source.list(filters);
  await source.list({ ...filters, project: "PAY" });
  const [all, picked] = requests.filter((r) => r.url.includes("/search")).map((r) => decodeURIComponent(r.url));
  assert.ok(!all.includes("project ="));
  assert.match(all, /assignee = currentUser\(\)/);
  assert.match(picked, /project = "PAY"/);
});
test("Anyone without a project still asks only for my tasks", async () => {
  const { source, requests } = setup({ site: serverSite, routes: standard({ issues: [] }) });
  await source.list({ ...filters, assignee: "anyone" });
  assert.match(decodeURIComponent(requests.find((r) => r.url.includes("/search")).url), /assignee = currentUser\(\)/);
});
test("null JSON and a missing issues array are other", async () => {
  const nul = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : "null") });
  await assert.rejects(nul.source.list(filters), { kind: "other" });
  const noIssues = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : { issues: "nope" }) });
  await assert.rejects(noIssues.source.list(filters), { kind: "other" });
  const noKey = setup({ routes: async () => reply({}) });
  await assert.rejects(noKey.source.get("EXAMPLE-1"), { kind: "other" });
});
test("Cloud paging stops on an empty page or a repeated token", async () => {
  const base = await fixture("jira-cloud-search.json");
  const empty = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : { issues: [], nextPageToken: "same" }) });
  assert.deepEqual(await empty.source.list(filters), []);
  assert.equal(empty.requests.filter((r) => r.url.includes("/search/jql")).length, 1);
  const loop = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : { issues: [base.issues[0]], nextPageToken: "same" }) });
  assert.equal((await loop.source.list(filters)).length, 2);
  let n = 0;
  const endless = setup({ routes: async (url) => reply(/\/myself/.test(url) ? {} : { issues: [base.issues[0]], nextPageToken: `t${n++}` }) });
  await endless.source.list(filters);
  assert.ok(endless.requests.filter((r) => r.url.includes("/search/jql")).length <= 5);
});
test("an invalid site is refused before the token command and any request", async () => {
  const { source, requests, execCalls } = setup({ site: { ...serverSite, url: "http://jira.example.com" }, routes: standard({}) });
  await assert.rejects(source.list(filters), (e) => e.kind === "other" && /insecure/i.test(e.message));
  await assert.rejects(source.get("EXAMPLE-1"), { kind: "other" });
  assert.equal(execCalls.length, 0);
  assert.equal(requests.length, 0);
});
test("projectExists: 200 true, 404 false, 401 auth", async () => {
  const byKey = async (url) => {
    if (/\/myself/.test(url)) return reply({});
    return /\/project\/ABC$/.test(url) ? reply({ key: "ABC" }) : reply({}, { status: 404, ok: false });
  };
  const { source, requests } = setup({ site: serverSite, routes: byKey });
  assert.equal(await source.projectExists("ABC"), true);
  assert.equal(await source.projectExists("UTF"), false);
  assert.ok(requests.some((r) => r.url === "https://jira.example.com/rest/api/2/project/ABC"));
  const cloud = setup({ routes: byKey });
  await cloud.source.projectExists("ABC");
  assert.ok(cloud.requests.some((r) => r.url === "https://jira.example.com/rest/api/3/project/ABC"));
  const denied = setup({ routes: async () => reply({}, { status: 401, ok: false }) });
  await assert.rejects(denied.source.projectExists("ABC"), { kind: "auth" });
});
test("projectExists refuses a key that fails isProjectKey without a request", async () => {
  const { source, requests, execCalls } = setup({ routes: standard({}) });
  for (const key of ["../myself", "abc", "A", "ABC/../x", ""]) assert.equal(await source.projectExists(key), false);
  assert.equal(requests.length, 0);
  assert.equal(execCalls.length, 0);
});
test("projectExists: a site that lacks the API altogether is not a missing project", async () => {
  const { source } = setup({ routes: async () => reply({}, { status: 404, ok: false }) });
  await assert.rejects(source.projectExists("ABC"), { kind: "notFound" });
});
test("projectExists on an invalid site runs no token command and sends no request", async () => {
  const { source, requests, execCalls } = setup({ site: { ...serverSite, url: "http://jira.example.com" }, routes: standard({}) });
  await assert.rejects(source.projectExists("ABC"), { kind: "other" });
  assert.equal(execCalls.length, 0);
  assert.equal(requests.length, 0);
});
test("a token that isn't there is marked as missing", async () => {
  const failing = setup({ exitCode: 44, routes: standard({}) });
  await assert.rejects(failing.source.list(filters), (e) => e.kind === "auth" && e.missing === true);
  const empty = setup({ token: "\n", routes: standard({}) });
  await assert.rejects(empty.source.list(filters), (e) => e.kind === "auth" && e.missing === true);
  const refused = setup({ routes: async () => reply({}, { status: 401, ok: false }) });
  await assert.rejects(refused.source.list(filters), (e) => e.kind === "auth" && !e.missing);
});
test("fetch rejecting is network; 404 is notFound; 500 is other", async () => {
  const down = setup({ routes: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  await assert.rejects(down.source.list(filters), { kind: "network" });
  const missing = setup({ routes: async (url) => /\/myself/.test(url) ? reply({}) : reply({}, { status: 404, ok: false }) });
  await assert.rejects(missing.source.get("EXAMPLE-9"), { kind: "notFound" });
  const broken = setup({ routes: async (url) => /\/myself/.test(url) ? reply({}) : reply({}, { status: 500, ok: false }) });
  await assert.rejects(broken.source.list(filters), { kind: "other" });
});
test("a cross-origin redirect is other with a readable message", async () => {
  const { source } = setup({ routes: async () => { throw new Error("blocked: cross-origin redirect to evil.example"); } });
  await assert.rejects(source.list(filters), (e) => e.kind === "other" && /redirected to another host/.test(e.message));
});
test("an HTML login page is other, with a readable message", async () => {
  const { source } = setup({
    routes: async (url) => /\/myself/.test(url) ? reply({}) : reply("<html>login</html>", { json: async () => { throw new SyntaxError("bad json"); } }),
  });
  await assert.rejects(source.list(filters), (e) => e.kind === "other" && /isn't JSON/.test(e.message));
});
test("a reply from another origin is refused", async () => {
  let parsed = false;
  const { source } = setup({
    routes: async () => reply({}, { url: "https://evil.example/rest/api/3/myself", json: async () => { parsed = true; return {}; } }),
  });
  await assert.rejects(source.list(filters), { kind: "other" });
  assert.equal(parsed, false);
});
test("a reply from the same origin is accepted", async () => {
  const { source } = setup({
    routes: async (url) => reply(/\/myself/.test(url) ? {} : { issues: [] }, { url }),
  });
  assert.deepEqual(await source.list(filters), []);
});
test("get refuses a key that doesn't look like one", async () => {
  const { source, requests } = setup({ routes: standard({}) });
  await assert.rejects(source.get("../../myself"), { kind: "notFound" });
  await assert.rejects(source.get("#12"), { kind: "notFound" });
  assert.equal(requests.length, 0);
});
test("validateSite refuses user info, a query and a fragment in the address", () => {
  const site = (url) => ({ url, type: "server", tokenCommand: ["t"] });
  assert.match(validateSite(site("https://u:p@jira.test")), /name or password/);
  assert.match(validateSite(site("https://u@jira.test/jira")), /name or password/);
  assert.match(validateSite(site("https://jira.test/?x=1")), /\? or #/);
  assert.match(validateSite(site("https://jira.test#a")), /\? or #/);
  assert.equal(validateSite(site("https://jira.test:8443/jira")), null);
  assert.equal(validateSite(site("https://jira.test/a@b")), null);
});
test("a site with a password in its address gets no token command and no request", async () => {
  const { source, requests, execCalls } = setup({ site: { ...serverSite, url: "https://u:p@jira.example.com" }, routes: standard({}) });
  await assert.rejects(source.list(filters), { kind: "other" });
  assert.equal(execCalls.length, 0);
  assert.equal(requests.length, 0);
});
test("validateSite", () => {
  assert.equal(validateSite({ url: "https://x.atlassian.net", type: "cloud", email: "a@b", tokenCommand: ["t"] }), null);
  assert.match(validateSite({ url: "http://x", type: "server", tokenCommand: ["t"] }), /insecure/i);
  assert.equal(validateSite({ url: "http://x", type: "server", tokenCommand: ["t"], allowInsecure: true }), null);
  assert.ok(validateSite({ url: "ftp://x", type: "server", tokenCommand: ["t"], allowInsecure: true }));
  assert.ok(validateSite({ url: "https://x", type: "cloud", tokenCommand: ["t"] }), "cloud needs an email");
  assert.ok(validateSite({ url: "https://x", type: "other", tokenCommand: ["t"] }));
  assert.ok(validateSite({ url: "https://x", type: "server", tokenCommand: [] }));
  assert.ok(validateSite(null));
});

const issue = (fields) => ({ key: "DEMO-1", fields: { summary: "t", status: { name: "Doing" }, labels: [], ...fields } });

test("priority comes with the task", async () => {
  const { source } = setup({ site: serverSite, routes: standard({ issues: [issue({ priority: { name: "Highest" } }), issue({})] }) });
  const tasks = await source.list(filters);
  assert.equal(tasks[0].priority, "Highest");
  assert.equal(tasks[1].priority, "");
});

test("Server: wiki markup is shown as markdown, the agent keeps the text as it came", async () => {
  const description = "h2. Steps\n*bold* !shot.png!";
  const { source } = setup({ site: serverSite, routes: standard({ issues: [issue({ description })] }) });
  const [task] = await source.list(filters);
  assert.equal(task.body, description);
  assert.equal(task.markdown, "## Steps\n**bold** shot.png");
});

test("Cloud: ADF is shown as markdown, the agent keeps the plain text", async () => {
  const description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "strong" }] }] }] };
  const { source } = setup({ routes: standard({ issues: [issue({ description })] }) });
  const [task] = await source.list(filters);
  assert.equal(task.body, "bold");
  assert.equal(task.markdown, "**bold**");
});

const comment = (body, name = "Ann Example", created = "2026-11-01T10:00:00.000+0000") => ({ author: { displayName: name }, created, body });

test("comments: GET, newest fifty, shown oldest first", async () => {
  const { source, requests } = setup({ site: serverSite, routes: standard({ comments: [comment("second", "B", "2026-11-02T10:00:00.000+0000"), comment("*first*")] }) });
  assert.deepEqual(await source.comments("DEMO-1"), [
    { author: "Ann Example", created: "2026-11-01T10:00:00.000+0000", body: "**first**" },
    { author: "B", created: "2026-11-02T10:00:00.000+0000", body: "second" },
  ]);
  const read = requests.find((r) => r.url.includes("/comment"));
  assert.match(read.url, /\/rest\/api\/2\/issue\/DEMO-1\/comment\?orderBy=-created&maxResults=50$/);
  assert.ok(requests.every((r) => (r.opts.method ?? "GET") === "GET"));
});

test("comments: Cloud reads ADF, and images stay out", async () => {
  const body = { type: "doc", content: [{ type: "mediaSingle", content: [{ type: "media", attrs: { alt: "shot", url: "https://x.test/p.png" } }] }] };
  const { source, requests } = setup({ routes: standard({ comments: [comment(body)] }) });
  assert.equal((await source.comments("DEMO-1"))[0].body, "shot");
  assert.ok(requests.some((r) => r.url.includes("/rest/api/3/issue/DEMO-1/comment")));
});

test("comments: a key that isn't one reaches no URL", async () => {
  const { source, requests } = setup({ routes: standard({ comments: [] }) });
  for (const key of ["../../myself", "DEMO-1/../x", "DEMO-1?x=1", "#12", ""]) await assert.rejects(source.comments(key), (e) => e.kind === "notFound", key);
  assert.equal(requests.length, 0);
});

test("comments: a reply of another shape is refused, a bad site refuses too", async () => {
  const { source } = setup({ routes: standard({ nothing: true }) });
  await assert.rejects(source.comments("DEMO-1"), (e) => e.kind === "other");
  const bad = setup({ site: { ...serverSite, url: "ftp://x" }, routes: () => assert.fail("fetched") });
  await assert.rejects(bad.source.comments("DEMO-1"), (e) => e.kind === "other");
});

test("a token command's failure never carries the command or its output", async () => {
  const secret = "aB3dE6aB3dE6aB3dE6aB3dE6aB3dE6aB3dE6aB3dE6aB";
  for (const message of [`spawn ${secret} ENOENT`, `${secret} took longer than 30 s`]) {
    const source = createJiraSource({ site: { ...cloudSite, tokenCommand: [secret] }, fetch: async () => reply({}), exec: async () => { throw new Error(message); } });
    await assert.rejects(source.list(filters), (e) => e.message === "The token command could not run");
  }
  const failed = createJiraSource({ site: { ...cloudSite, tokenCommand: [secret] }, fetch: async () => reply({}), exec: async () => ({ code: 3, stdout: secret, stderr: secret }) });
  await assert.rejects(failed.list(filters), (e) => !e.message.includes(secret));
});

test("a token command that takes too long still counts as the network", async () => {
  const source = createJiraSource({ site: cloudSite, fetch: async () => reply({}), exec: async () => { throw new Error("took longer than 30 s"); } });
  await assert.rejects(source.list(filters), { kind: "network" });
});
