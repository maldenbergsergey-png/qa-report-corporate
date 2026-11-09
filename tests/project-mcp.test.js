const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), { randomBytes } = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const { createReportSharing } = require("../report-sharing");
const { createProjectMcpAccess, projectOf } = require("../project-mcp-access");
const { createQaReportMcp } = require("../scripts/qa-report-mcp.cjs");
const { buildSetup } = require("../shared-mcp-setup");
const { connectMcp } = require("./helpers/qa-report-mcp-client.cjs");
const owner = "author@example.test", point = { sectionId: "section", rowId: "row" };
const data = value => { assert.equal(value.error, undefined); assert.notEqual(value.result?.isError, true, JSON.stringify(value)); return JSON.parse(value.result.content[0].text); };
const failed = value => assert.ok(value.error || value.result?.isError, JSON.stringify(value));
async function fixture(t) {
  const db = new DatabaseSync(":memory:"), objects = new Map(); let origin, project, time = Date.now(), onBody;
  const sendJson = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  const readJson = async (req, limit = 1024 * 1024) => {
    const parts = []; let size = 0; for await (const part of req) { size += part.length; if (size > limit) throw Object.assign(new Error("Too large"), { status: 413 }); parts.push(part); }
    if (req.url.endsWith("/answers") && onBody) { const callback = onBody; onBody = undefined; callback(); }
    return JSON.parse(Buffer.concat(parts).toString() || "{}");
  };
  const sharing = createReportSharing({ getDb: () => db, readJson, sendJson, requestOrigin: () => origin,
    configPath: "fixture", publisherIdentity: req => ({ id: req.headers["x-fixture-owner"] }),
    projectAccess: (req, row) => project?.authorize(req, row),
    storageLoader: () => ({ activeBucketId: "primary", hasBucket: id => id === "primary", put: async (key, bytes) => objects.set(key, bytes), get: async ref => new Response(objects.get(ref.key)), remove: async ref => objects.delete(ref.key) }),
  });
  const restart = () => { project = createProjectMcpAccess({ getDb: () => db, readJson, sendJson, requestOrigin: () => origin, reportSharing: sharing, now: () => time,
    authenticateOwner: async req => req.headers["x-fixture-owner"], validateWrite: req => {
      if (req.headers.origin !== origin || req.headers["x-qa-project-request"] !== "1") throw Object.assign(new Error("CSRF"), { status: 403 });
    } }); };
  restart();
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, origin).pathname;
      if (await project.machine(req, res, path) || await project.browser(req, res, path) || await sharing(req, res, path)) return;
      sendJson(res, 404, { error: "Not found" });
    } catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  async function call(path, { method = "GET", body, author = owner, token, protectedWrite = true, headers = {} } = {}) {
    const res = await fetch(origin + path, { method, headers: { "Content-Type": "application/json", ...(author ? { "X-Fixture-Owner": author } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method !== "GET" && protectedWrite ? { Origin: origin, "X-QA-Project-Request": "1" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function publish(issueUrl, author = owner, file = false) {
    const response = await call("/api/shared-reports", { method: "POST", author, body: { publishKey: randomBytes(32).toString("base64url"),
      files: file ? [{ id: "log", name: "log.txt", type: "text/plain", data: Buffer.from("fixture log").toString("base64") }] : [],
      snapshot: { title: issueUrl, issueUrl, intro: { text: "", attachments: file ? ["log"] : [] }, sections: [{ id: "section", title: "Checks", columns: [{ id: "check", label: "Проверка" }], rows: [{ id: "row", number: "1", status: "NOT_OK", cells: { check: { text: "Проверить форму" } } }] }] } } });
    assert.equal(response.status, 201, JSON.stringify(response)); return response.body.publication;
  }
  async function issue(issueUrl, options = {}) {
    const result = await call("/api/mcp/project-keys", { method: "POST", body: { projectId: projectOf(issueUrl).id, label: "Developer", ...options } });
    assert.equal(result.status, 201, JSON.stringify(result)); return result.body;
  }
  async function connect(key, extra = {}) {
    const client = await connectMcp({ QA_REPORT_PROJECT_URL: key.connection.url, QA_REPORT_PROJECT_TOKEN: key.connection.token, ...extra }); t.after(() => client.close()); return client;
  }
  return { db, origin, call, publish, issue, connect, restart, expire: () => { time += 30 * 86400000 + 1; }, race: fn => { onBody = fn; } };
}

test("project key lists only this author's project and tracker, includes future reports and survives a service restart", async t => {
  const f = await fixture(t), a = await f.publish("https://tasks.example.test/browse/QA-1");
  await f.publish("https://tasks.example.test/browse/QA-2", "other@example.test");
  await f.publish("https://tasks.example.test/browse/OTHER-1");
  await f.publish("https://other.example.test/browse/QA-3");
  await f.publish("https://tasks.example.test/desk/Task/QA-4");
  const key = await f.issue("https://tasks.example.test/browse/QA-1"), client = await f.connect(key);
  assert.equal(key.key.expiresAt - key.key.createdAt, 30 * 86400000);
  assert.deepEqual(data(await client.call("qa_report_list_reports")).reports.map(r => r.id), [a.id]);
  const b = await f.publish("https://tasks.example.test/browse/QA-5");
  assert.equal(data(await client.call("qa_report_list_reports")).reports.length, 2);
  assert.equal(data(await client.call("qa_report_list_reports", { query: "QA-5" })).reports[0].id, b.id);
  assert.equal(data(await client.call("qa_report_list_reports", { limit: 1 })).nextOffset, 1);
  assert.equal(data(await client.call("qa_report_list_reports", { offset: 1, limit: 1 })).nextOffset, null);
  f.restart(); assert.equal(data(await client.call("qa_report_read", { reportId: a.id })).id, a.id);
  assert.equal(JSON.stringify((await f.call("/api/mcp/project-keys")).body).includes(key.connection.token), false);
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM shared_report_project_keys").all()).includes(key.connection.token), false);
});

test("one MCP connection can read and answer two reports without mixing IDs, preserves QA and refuses stale revisions", async t => {
  const f = await fixture(t), a = await f.publish("https://tasks.example.test/browse/QA-1", owner, true), b = await f.publish("https://tasks.example.test/browse/QA-2");
  const key = await f.issue("https://tasks.example.test/browse/QA-1"), client = await f.connect(key);
  const tools = (await client.request("tools/list", {})).result.tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ["qa_report_capabilities", "qa_report_list_reports", "qa_report_read", "qa_report_read_text_attachment", "qa_report_save_answer"].sort());
  assert.equal(data(await client.call("qa_report_capabilities")).scope, "project");
  const reads = await Promise.all([client.call("qa_report_read", { reportId: a.id }), client.call("qa_report_read", { reportId: b.id })]);
  assert.deepEqual(reads.map(value => data(value).id), [a.id, b.id]);
  assert.equal(data(await client.call("qa_report_read_text_attachment", { reportId: a.id, fileId: "log" })).content, "fixture log");
  failed(await client.call("qa_report_read_text_attachment", { reportId: b.id, fileId: "log" }));
  const first = data(await client.call("qa_report_save_answer", { reportId: a.id, ...point, revision: 0, status: "fixed", comment: "Исправлена форма" }));
  assert.equal(first.revision, 1);
  data(await client.call("qa_report_save_answer", { reportId: b.id, ...point, revision: 0, status: "not_fixed" }));
  const updated = data(await client.call("qa_report_save_answer", { reportId: a.id, ...point, revision: 1, status: "needs_clarification" }));
  assert.equal(updated.comment, "Исправлена форма");
  failed(await client.call("qa_report_save_answer", { reportId: a.id, ...point, revision: 0, status: "not_fixed" }));
  failed(await client.call("qa_report_save_answer", { reportId: a.id, ...point, revision: 2, comment: key.connection.token }));
  const report = data(await client.call("qa_report_read", { reportId: a.id }));
  assert.equal(report.sections[0].rows[0].status, "NOT_OK"); assert.equal(report.answers[0].revision, 2);
  failed(await client.call("qa_report_read"));
  failed(await client.call("qa_report_read", { reportId: a.id, url: "https://attacker.example.test" }));
  assert.equal(JSON.stringify(client.messages).includes(key.connection.token), false);
});

test("project keys cannot acquire owner, QA or other-author access and management requires login plus write protection", async t => {
  const f = await fixture(t), a = await f.publish("https://tasks.example.test/browse/QA-1"), other = await f.publish("https://tasks.example.test/browse/QA-2", "other@example.test"), different = await f.publish("https://tasks.example.test/browse/OTHER-1");
  assert.equal((await f.call("/api/mcp/project-keys", { author: null })).status, 401);
  const input = { projectId: projectOf("https://tasks.example.test/browse/QA-1").id, label: "Developer" };
  assert.equal((await f.call("/api/mcp/project-keys", { method: "POST", body: input, protectedWrite: false })).status, 403);
  assert.equal((await f.call("/api/mcp/project-keys", { method: "POST", body: { ...input, projectId: "c".repeat(64) } })).status, 404);
  const key = await f.issue("https://tasks.example.test/browse/QA-1"), client = await f.connect(key), root = `/api/mcp/projects/${key.key.id}/reports`;
  for (const reportId of [other.id, different.id]) failed(await client.call("qa_report_read", { reportId }));
  assert.equal((await f.call(root + "/" + a.id, { method: "DELETE", token: key.connection.token })).status, 403);
  assert.equal((await f.call(root + "/" + a.id + "/author", { token: key.connection.token })).status, 401);
  assert.equal((await f.call("/api/shared-reports/" + a.id, { token: key.connection.token })).status, 404);
  assert.equal((await f.call(root + "/" + a.id, { token: key.connection.token, headers: { Origin: "https://attacker.example.test" } })).status, 403);
  assert.equal((await f.call("/api/mcp/project-keys/" + key.key.id, { method: "DELETE", author: "other@example.test" })).status, 404);
  assert.throws(() => createQaReportMcp({ QA_REPORT_PROJECT_URL: key.connection.url, QA_REPORT_PROJECT_TOKEN: key.connection.token, QA_REPORT_SHARE_URL: f.origin + "/shared-report/" + a.id + "#" + a.replyToken }));
});

test("read-only, expiry, key revocation, report revocation and project changes are enforced on every request", async t => {
  const f = await fixture(t), a = await f.publish("https://tasks.example.test/browse/QA-1"), read = await f.issue("https://tasks.example.test/browse/QA-1", { readOnly: true }), reader = await f.connect(read, { QA_REPORT_MCP_READ_ONLY: "1" });
  assert.equal((await reader.request("tools/list", {})).result.tools.some(tool => tool.name === "qa_report_save_answer"), false);
  assert.equal((await f.call(`/api/mcp/projects/${read.key.id}/reports/${a.id}/answers`, { method: "POST", author: null, token: read.connection.token, body: { ...point, revision: 0, status: "fixed", comment: "" } })).status, 403);
  const key = await f.issue("https://tasks.example.test/browse/QA-1"), client = await f.connect(key);
  await f.call("/api/mcp/project-keys/" + key.key.id, { method: "DELETE" }); failed(await client.call("qa_report_list_reports"));
  const active = await f.issue("https://tasks.example.test/browse/QA-1"), writer = await f.connect(active);
  const snapshot = JSON.parse(f.db.prepare("SELECT snapshot_json FROM shared_publications WHERE id = ?").get(a.id).snapshot_json);
  f.race(() => f.db.prepare("UPDATE shared_publications SET snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...snapshot, issueUrl: "https://tasks.example.test/browse/OTHER-1" }), a.id));
  failed(await writer.call("qa_report_save_answer", { reportId: a.id, ...point, revision: 0, status: "fixed" }));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM shared_report_answers").get().n, 0);
  failed(await writer.call("qa_report_read", { reportId: a.id }));
  f.db.prepare("UPDATE shared_publications SET snapshot_json = ?, revoked_at = 'revoked' WHERE id = ?").run(JSON.stringify(snapshot), a.id);
  assert.equal(data(await writer.call("qa_report_list_reports")).reports.length, 0);
  failed(await writer.call("qa_report_read", { reportId: a.id }));
  f.expire(); failed(await reader.call("qa_report_list_reports"));
});

test("setup has a stable package address, keeps keys private and rejects ambiguous project scope", () => {
  const project = { url: "https://reports.example.test/api/mcp/projects/" + "a".repeat(32) + "/reports", token: "b".repeat(43) };
  const setup = JSON.parse(buildSetup({ project, packageUrl: "/downloads/qa-report-mcp.tgz?v=" + "c".repeat(64), client: "json" }).code);
  const server = Object.values(setup.mcpServers)[0];
  assert.equal(server.env.QA_REPORT_PROJECT_TOKEN, project.token);
  assert.equal(server.env.QA_REPORT_IMPORT_TOKEN, undefined);
  assert.ok(server.args.includes("https://reports.example.test/downloads/qa-report-mcp.tgz"));
  assert.throws(() => buildSetup({ project, connection: { url: "unused" } }));
  assert.throws(() => createQaReportMcp({ QA_REPORT_PROJECT_URL: project.url.replace("https:", "http:"), QA_REPORT_PROJECT_TOKEN: project.token }));
  assert.equal(projectOf("QA-1"), null);
  assert.notEqual(projectOf("https://tasks.example.test/browse/QA-1").id, projectOf("https://other.example.test/browse/QA-1").id);
});
