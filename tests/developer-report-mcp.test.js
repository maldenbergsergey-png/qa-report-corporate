const test = require("node:test");
const assert = require("node:assert/strict");
const { createQaReportMcp } = require("../scripts/qa-report-mcp.cjs");
const { fixture } = require("./helpers/shared-report-server.cjs");


function data(reply) {
  assert.equal(reply.error, undefined); assert.notEqual(reply.result?.isError, true, JSON.stringify(reply.result));
  return JSON.parse(reply.result.content[0].text);
}
function failed(reply) { assert.ok(reply.error || reply.result?.isError, JSON.stringify(reply)); }
const point = { sectionId: "section", rowId: "row" };

test("developer discovers only published-report tools and can update status or comment independently", async t => {
  const f = await fixture(t), client = await f.connect();
  const tools = (await client.request("tools/list", {})).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ["qa_report_capabilities", "qa_report_read", "qa_report_read_text_attachment", "qa_report_save_answer"]);
  assert.equal(data(await client.call("qa_report_capabilities")).role, "developer");
  assert.equal(data(await client.call("qa_report_read")).canReply, true);
  const first = data(await client.call("qa_report_save_answer", { ...point, revision: 0, status: "fixed" }));
  assert.equal(first.status, "fixed"); assert.equal(first.comment, ""); assert.equal(first.revision, 1);
  const second = data(await client.call("qa_report_save_answer", { ...point, revision: 1, comment: "Исправлено в коммите abc1234; проверена загрузка формы." }));
  assert.equal(second.status, "fixed"); assert.match(second.comment, /abc1234/);
  const report = (await f.read()).data.report;
  assert.equal(report.sections[0].rows[0].status, "NOT_OK");
  assert.equal(report.answers[0].revision, 2);
  failed(await client.call("qa_report_save_answer", { ...point, revision: 2 }));
  failed(await client.call("qa_report_save_answer", { ...point, revision: 2, status: "in_progress" }));
  assert.equal(JSON.stringify(client.messages).includes(f.publication.replyToken), false);
});

test("status-only update preserves the existing rich comment; comment-only update preserves status", async t => {
  const f = await fixture(t), client = await f.connect();
  const rich = [{ tag: "p", children: [{ tag: "b", children: ["Неясно"] }] }];
  await f.json(`/${f.publication.id}/answers`, { method: "POST", token: f.publication.replyToken,
    body: { ...point, revision: 0, status: "needs_clarification", comment: "Неясно", commentDocument: rich } });
  const answer = data(await client.call("qa_report_save_answer", { ...point, revision: 1, status: "not_fixed" }));
  assert.deepEqual(answer.commentDocument, rich); assert.equal(answer.comment, "Неясно");
  const cleared = data(await client.call("qa_report_save_answer", { ...point, revision: 2, comment: "" }));
  assert.equal(cleared.status, "not_fixed"); assert.equal(cleared.comment, "");
});

test("stale revision and a write racing after the read cannot overwrite another developer", async t => {
  const f = await fixture(t), client = await f.connect();
  data(await client.call("qa_report_read"));
  data(await client.call("qa_report_save_answer", { ...point, revision: 0, comment: "Первый ответ" }));
  failed(await client.call("qa_report_save_answer", { ...point, revision: 0, status: "fixed" }));
  f.race(() => f.db.prepare("UPDATE shared_report_answers SET comment='Другой разработчик',revision=revision+1 WHERE publication_id=?").run(f.publication.id));
  failed(await client.call("qa_report_save_answer", { ...point, revision: 1, status: "fixed" }));
  const answer = (await f.read()).data.report.answers[0];
  assert.equal(answer.comment, "Другой разработчик"); assert.equal(answer.status, "unreviewed");
});

test("read links, explicit read-only mode, revocation and session pinning preserve access boundaries", async t => {
  const f = await fixture(t);
  const viewer = await f.connect({ QA_REPORT_SHARE_URL: f.url(f.publication.readToken) });
  assert.equal(data(await viewer.call("qa_report_read")).canReply, false);
  failed(await viewer.call("qa_report_save_answer", { ...point, revision: 0, status: "fixed" }));
  const readonly = await f.connect({ QA_REPORT_MCP_READ_ONLY: "1" });
  assert.equal((await readonly.request("tools/list", {})).result.tools.some(t => t.name === "qa_report_save_answer"), false);
  const writer = await f.connect();
  failed(await writer.call("qa_report_read", { url: f.url(f.publication.readToken) }));
  data(await writer.call("qa_report_read"));
  await f.json("/" + f.publication.id, { method: "DELETE", token: f.publication.ownerToken });
  failed(await writer.call("qa_report_save_answer", { ...point, revision: 0, status: "fixed" }));
  failed(await writer.call("qa_report_read"));
});

test("origin-only connection pins the first user-supplied report; standalone adapter remains compatible", async t => {
  const f = await fixture(t);
  const client = await f.connect({ QA_REPORT_SHARE_URL: "", QA_REPORT_SHARE_ORIGIN: f.origin });
  failed(await client.call("qa_report_read"));
  failed(await client.call("qa_report_read", { url: `https://another.example/shared-report/${f.publication.id}#${f.publication.replyToken}` }));
  data(await client.call("qa_report_read", { url: f.url(f.publication.replyToken) }));
  data(await client.call("qa_report_save_answer", { ...point, revision: 0, status: "needs_clarification" }));
  const legacy = await f.connect({}, "shared-report-mcp.cjs");
  assert.equal(data(await legacy.call("qa_report_read")).answers[0].status, "needs_clarification");
  assert.equal(data(await legacy.call("qa_report_save_answer", { ...point, revision: 1, comment: "Нужно уточнение" })).status, "needs_clarification");
});

test("mixed roles and malformed published links are rejected during setup", () => {
  const env = { QA_REPORT_SHARE_URL: "https://reports.example/shared-report/" + "a".repeat(32) + "#" + "b".repeat(43) };
  assert.throws(() => createQaReportMcp({ ...env, QA_REPORT_IMPORT_URL: "http://127.0.0.1/api/local-import/agent/session" }));
  assert.throws(() => createQaReportMcp({ ...env, QA_REPORT_SHARE_ORIGIN: "https://other.example" }));
  assert.throws(() => createQaReportMcp({ ...env, QA_REPORT_SHARE_URL: "https://reports.example/shared-report/id" }));
});

test("concurrent first reads cannot bind one session to two published reports", async t => {
  const f = await fixture(t);
  const second = await f.json("", { method: "POST", body: { publishKey: "c".repeat(43), snapshot: { title: "Другой отчёт", sections: [{ id: "second", title: "Другой раздел",
    columns: [{ id: "check", label: "Проверка" }], rows: [{ id: "another", status: "NOT_OK", cells: { check: { text: "Другой пункт" } } }] }] }, files: [] } });
  assert.equal(second.status, 201);
  const other = second.data.publication;
  const client = await f.connect({ QA_REPORT_SHARE_URL: "", QA_REPORT_SHARE_ORIGIN: f.origin });
  const [first, blocked] = await Promise.all([
    client.call("qa_report_read", { url: f.url(f.publication.replyToken) }),
    client.call("qa_report_read", { url: `${f.origin}/shared-report/${other.id}#${other.replyToken}` }),
  ]);
  assert.equal(data(first).id, f.publication.id); failed(blocked);
  assert.equal(data(await client.call("qa_report_read")).id, f.publication.id);
});

test("one downloaded offline launcher reads multiple sites and isolates links, write handles and approvals", async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const { promisify } = require("node:util"), execFile = promisify(require("node:child_process").execFile);
  const { createHash } = require("node:crypto");
  const { connectMcp } = require("./helpers/qa-report-mcp-client.cjs");
  const { buildDeveloperInstall } = require("../shared-mcp-setup");
  let redirectTo, leaked = false;
  const a = await fixture(t, { intercept(req, res, pathname) {
    if (redirectTo && pathname.startsWith("/api/shared-reports/")) { res.writeHead(307, { Location: redirectTo }); res.end(); return true; }
  } });
  const b = await fixture(t, { legacy: true, intercept(req, res, pathname) {
    if (pathname === "/sink" || req.headers["x-qa-developer-device"]) leaked = true;
  } });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-report-links-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const meta = await (await fetch(a.origin + "/api/mcp/package")).json();
  const source = Buffer.from(await (await fetch(a.origin + meta.developerUrl)).arrayBuffer());
  assert.equal(createHash("sha256").update(source).digest("hex"), new URL(meta.developerUrl, a.origin).searchParams.get("v"));
  const setup = buildDeveloperInstall({ origin: a.origin, developerUrl: meta.developerUrl, client: "claude-chat" });
  assert.match(setup.code, /qa-report-developer/); assert.match(setup.code, /--links/);
  assert.ok(!setup.code.includes(a.publication.replyToken));
  assert.throws(() => buildDeveloperInstall({ origin: a.origin, developerUrl: b.origin + meta.developerUrl }));
  const script = path.join(directory, "installed.cjs");
  await fs.writeFile(script, source);
  const env = { QA_REPORT_MCP_STATE_DIR: directory };
  const trust = origin => execFile(process.execPath, [script, "--trust", origin], { env: { ...process.env, ...env } });
  const launch = () => connectMcp(env, undefined, undefined, { command: process.execPath, args: [script, "--links"] });
  const client = await launch(); t.after(() => client.close());
  assert.equal(data(await client.call("qa_report_capabilities")).scope, "developer-links");
  const unknown = await client.call("qa_report_read", { url: a.url(a.publication.replyToken) });
  assert.match(unknown.result.content[0].text, /--trust/);
  await Promise.all([trust(a.origin), trust(a.origin), trust(b.origin)]);
  const first = data(await client.call("qa_report_read", { url: a.url(a.publication.replyToken) }));
  const second = data(await client.call("qa_report_read", { url: b.url(b.publication.replyToken) }));
  const readOnly = data(await client.call("qa_report_read", { url: a.url(a.publication.readToken) }));
  assert.notEqual(first.reportRef, second.reportRef); assert.notEqual(first.reportRef, readOnly.reportRef);
  assert.equal(readOnly.canReply, false);
  const update = { ...point, revision: 0, status: "fixed" };
  failed(await client.call("qa_report_save_answer", { ...update, reportRef: readOnly.reportRef }));
  failed(await client.call("qa_report_save_answer", { ...update }));
  failed(await client.call("qa_report_save_answer", { ...update, reportRef: second.reportRef, comment: a.publication.replyToken }));
  data(await client.call("qa_report_save_answer", { ...update, reportRef: second.reportRef }));
  assert.equal((await a.read()).data.report.answers.length, 0);
  assert.equal((await b.read()).data.report.answers[0].status, "fixed");
  assert.equal((await b.read()).data.report.sections[0].rows[0].status, "NOT_OK");
  failed(await client.call("qa_report_read", { url: b.origin + "/shared-report/" + b.publication.id }));
  a.db.prepare("UPDATE shared_publications SET revoked_at=? WHERE id=?").run(new Date().toISOString(), first.id);
  failed(await client.call("qa_report_save_answer", { ...update, reportRef: first.reportRef }));
  redirectTo = b.origin + "/sink";
  failed(await client.call("qa_report_read", { url: a.url(a.publication.readToken) }));
  assert.equal(leaked, false);
  const restart = await launch(); t.after(() => restart.close());
  assert.equal(data(await restart.call("qa_report_read", { url: b.url(b.publication.readToken) })).id, second.id);
  failed(await restart.call("qa_report_save_answer", { ...update, reportRef: second.reportRef }));
  for (const secret of [a.publication.replyToken,b.publication.replyToken]) assert.ok(!JSON.stringify(client.messages).includes(secret));
});
