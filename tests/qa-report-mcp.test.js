const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createLocalImportService } = require("../local-import-server");
const { createQaReportMcp } = require("../scripts/qa-report-mcp.cjs");
const { connectMcp } = require("./helpers/qa-report-mcp-client.cjs");
const hash = "0".repeat(64);

async function fixture(t, options = {}) {
  const service = createLocalImportService(options);
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      if (await service.producer(req, res, origin)) return;
      if (await service.browser(req, res, { owner: "synthetic-owner", origin })) return;
      res.writeHead(404); res.end();
    } catch (error) { res.writeHead(error.status || 500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const context = { sections: [{ id: "section", columns: [{ id: "actual", title: "Результат" }],
    rows: [{ id: "row", status: "НЕ ПРОВЕРЕНО", cells: { actual: { text: "Исходный текст", hash } } }] }],
    metadata: { environment: { text: "STAGE", hash }, overallStatus: { text: "НЕ ПРОВЕРЕНО", hash } } };
  const session = await (await fetch(origin + "/api/local-import/sessions", {
    method: "POST", headers: { "X-QA-Import-Request": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ reportId: "synthetic-report", context }),
  })).json();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-report-mcp-"));
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const env = { QA_REPORT_IMPORT_URL: session.connection.url, QA_REPORT_IMPORT_TOKEN: session.connection.token };
  async function connect(overrides = {}, protocol) {
    const client = await connectMcp({ ...env, ...overrides }, protocol);
    t.after(() => client.close());
    return client;
  }
  const browser = (suffix, body, method = "POST") => fetch(`${origin}/api/local-import/sessions/${session.id}${suffix}`, {
    method: body ? method : "GET", headers: { "X-QA-Import-Request": "1", "X-QA-Import-Reader": session.consumerToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { env, connect, browser, directory, session, context };
}
function data(reply) {
  assert.equal(reply.error, undefined);
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply.result));
  const value = JSON.parse(reply.result.content[0].text);
  assert.deepEqual(reply.result.structuredContent, value);
  return value;
}
function failed(reply) { assert.ok(reply.error || reply.result?.isError, JSON.stringify(reply)); }

test("stdio discovery, UTF-8 context, and legacy protocol compatibility", async t => {
  const f = await fixture(t);
  for (const version of ["2025-11-25", "2024-11-05"]) {
    const client = await f.connect({}, version);
    assert.equal(client.initialized.result.protocolVersion, version);
    const list = (await client.request("tools/list", {})).result.tools;
    assert.equal(list.length, 6);
    assert.ok(list.every(tool => tool.inputSchema.additionalProperties === false));
    assert.equal(list.find(tool => tool.name === "qa_report_replace_checklist").annotations.destructiveHint, true);
    const context = data(await client.call("qa_report_get_context"));
    assert.equal(context.reportId, "synthetic-report");
    assert.equal(context.context.sections[0].rows[0].cells.actual.text, "Исходный текст");
    assert.equal(JSON.stringify(client.messages).includes(f.session.connection.token), false);
    assert.equal(client.stderr, "");
  }
});

test("cell and metadata writes remain pending until browser acknowledgement; identical retry is safe", async t => {
  const f = await fixture(t), client = await f.connect();
  const args = { operationId: "result-1", updates: [{ sectionId: "section", rowId: "row", columnId: "actual", expectedHash: hash,
    text: "Форма открылась", mode: "append", status: "OK" }], metadata: { environment: { value: "TEST", expectedHash: hash } } };
  assert.equal(data(await client.call("qa_report_update_cells", args)).saved, false);
  assert.equal(data(await client.call("qa_report_update_cells", args)).status, "pending");
  const next = await (await f.browser("/next")).json();
  assert.equal(next.batch.updates[0].text, "Форма открылась");
  assert.equal(next.batch.metadata.environment.value, "TEST");
  assert.equal(data(await client.call("qa_report_get_operation", { operationId: args.operationId })).status, "pending");
  failed(await client.call("qa_report_update_cells", { ...args, updates: [{ ...args.updates[0], text: "Другое содержимое" }] }));
  await f.browser("/ack", { id: args.operationId, status: "saved", context: f.context });
  assert.equal(data(await client.call("qa_report_get_operation", { operationId: args.operationId })).saved, true);
  assert.equal(data(await client.call("qa_report_update_cells", args)).status, "saved");
  const meta = { operationId: "meta", metadata: { overallStatus: { value: "НЕ ОК", expectedHash: hash } } };
  data(await client.call("qa_report_update_metadata", meta));
  await f.browser("/ack", { id: "meta", status: "rejected", error: "Поле изменилось" });
  const rejected = data(await client.call("qa_report_get_operation", { operationId: "meta" }));
  assert.equal(rejected.saved, false); assert.equal(rejected.status, "rejected");
  assert.equal(rejected.error, "Поле изменилось");
});

test("replacement needs explicit flag; unknown fields, invalid hashes and empty edits never reach API", async t => {
  const f = await fixture(t), client = await f.connect();
  failed(await client.call("qa_report_replace_checklist", { operationId: "replace", content: "||Проверка||\n|Вход|" }));
  failed(await client.call("qa_report_update_metadata", { operationId: "empty", metadata: {} }));
  failed(await client.call("qa_report_update_metadata", { operationId: "secret", metadata: { token: { value: "value", expectedHash: hash } } }));
  failed(await client.call("qa_report_update_cells", { operationId: "bad-hash", updates: [{ sectionId: "section", rowId: "row", columnId: "actual", expectedHash: "bad", text: "text" }] }));
  failed(await client.call("qa_report_get_context", { url: "https://other.example" }));
  assert.equal((await (await f.browser("/next")).json()).batch, null);
  const result = data(await client.call("qa_report_replace_checklist", { operationId: "replace", content: "||Проверка||\n|Вход|", confirmReplace: true }));
  assert.equal(result.status, "pending");
  const batch = (await (await f.browser("/next")).json()).batch;
  assert.equal(batch.kind, "checklist"); assert.equal(batch.confirmReplace, undefined);
});

test("uploads are confined to explicit root, preserve binary bytes and do not attach until submitted", async t => {
  const f = await fixture(t);
  const allowed = path.join(f.directory, "allowed"); await fs.mkdir(allowed);
  const bytes = Buffer.from([0, 255, 128, 10, 13]);
  await fs.writeFile(path.join(allowed, "лог.bin"), bytes);
  await fs.writeFile(path.join(f.directory, "outside.txt"), "private");
  await fs.symlink(path.join(f.directory, "outside.txt"), path.join(allowed, "link.txt"));
  const large = await fs.open(path.join(allowed, "large.bin"), "w");
  await large.truncate(50 * 1024 * 1024 + 1); await large.close();
  const client = await f.connect({ QA_REPORT_FILE_ROOT: allowed });
  for (const file of ["../outside.txt", "link.txt", allowed, "large.bin"]) failed(await client.call("qa_report_upload_attachment", { fileId: "blocked", path: file }));
  const uploaded = data(await client.call("qa_report_upload_attachment", { fileId: "file-1", path: "лог.bin" }));
  assert.equal(uploaded.attached, false); assert.equal(uploaded.name, "лог.bin"); assert.equal(uploaded.size, bytes.length);
  assert.equal((await (await f.browser("/next")).json()).batch, null);
  data(await client.call("qa_report_update_cells", { operationId: "files", updates: [{ sectionId: "section", rowId: "row", columnId: "actual", expectedHash: hash, attachmentIds: [uploaded.fileId] }] }));
  assert.deepEqual(Buffer.from(await (await f.browser("/files/file-1")).arrayBuffer()), bytes);
});

test("uploads allow one in-flight file, keep the 50 MiB limit and recover after failures", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-mcp-upload-"));
  const file = await fs.open(path.join(directory, "boundary.bin"), "w");
  await file.truncate(50 * 1024 * 1024); await file.close();
  const received = [];
  const firstReady = Promise.withResolvers(), firstRelease = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    let size = 0;
    for await (const chunk of req) size += chunk.length;
    received.push({ url: req.url, size });
    if (received.length === 1) {
      firstReady.resolve(); await firstRelease.promise;
      res.writeHead(500); res.end('{}'); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: req.url.split('/').pop(), size, name: "boundary.bin", type: "application/octet-stream" }));
  });
  let client;
  t.after(async () => {
    firstRelease.resolve(); await client?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  client = await connectMcp({ QA_REPORT_IMPORT_URL: `http://127.0.0.1:${server.address().port}/api/local-import/agent/session`,
    QA_REPORT_IMPORT_TOKEN: "a".repeat(64), QA_REPORT_FILE_ROOT: directory });
  const first = client.call("qa_report_upload_attachment", { fileId: "first", path: "boundary.bin" });
  await Promise.race([firstReady.promise, first.then(() => assert.fail("First upload ended before reaching the service"))]);
  const blocked = await client.call("qa_report_upload_attachment", { fileId: "second", path: "boundary.bin" });
  failed(blocked);
  assert.match(blocked.result.content[0].text, /Дождитесь завершения/);
  assert.equal(received.length, 1);
  assert.equal(data(await client.call("qa_report_capabilities")).limits.fileBytes, 50 * 1024 * 1024);
  firstRelease.resolve(); failed(await first);
  failed(await client.call("qa_report_upload_attachment", { fileId: "missing", path: "missing.bin" }));
  const uploaded = data(await client.call("qa_report_upload_attachment", { fileId: "second", path: "boundary.bin" }));
  assert.equal(uploaded.size, 50 * 1024 * 1024);
  assert.deepEqual(received, [
    { url: "/api/local-import/agent/session/files/first", size: uploaded.size },
    { url: "/api/local-import/agent/session/files/second", size: uploaded.size },
  ]);
});

test("read-only discovery excludes mutations; expired and stopped sessions lose access", async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now, ttlMs: 1000 });
  const client = await f.connect({ QA_REPORT_MCP_READ_ONLY: "1", QA_REPORT_FILE_ROOT: f.directory });
  assert.equal((await client.request("tools/list", {})).result.tools.length, 3);
  assert.equal(data(await client.call("qa_report_capabilities")).attachmentsEnabled, false);
  failed(await client.call("qa_report_update_metadata", { operationId: "x", metadata: {} }));
  now += 1001;
  failed(await client.call("qa_report_get_context"));
  const stopped = await fixture(t), writer = await stopped.connect();
  await fetch(stopped.env.QA_REPORT_IMPORT_URL.replace("/agent/", "/sessions/"), { method: "DELETE",
    headers: { "X-QA-Import-Request": "1", "X-QA-Import-Reader": stopped.session.consumerToken } });
  failed(await writer.call("qa_report_get_context"));
});

test("secret values cannot be written or echoed; request limits and wrong tokens fail safely", async t => {
  const f = await fixture(t), client = await f.connect();
  failed(await client.call("qa_report_update_metadata", { operationId: "leak", metadata: { environment: { value: f.env.QA_REPORT_IMPORT_TOKEN, expectedHash: hash } } }));
  failed(await client.call("qa_report_replace_checklist", { operationId: "large", content: "я".repeat(600000), confirmReplace: true }));
  const wrong = await f.connect({ QA_REPORT_IMPORT_TOKEN: "f".repeat(64) });
  failed(await wrong.call("qa_report_get_context"));
  data(await client.call("qa_report_update_metadata", { operationId: "redact", metadata: { environment: { value: "STAGE", expectedHash: hash } } }));
  await f.browser("/ack", { id: "redact", status: "rejected", error: f.env.QA_REPORT_IMPORT_TOKEN });
  assert.equal(data(await client.call("qa_report_get_operation", { operationId: "redact" })).error, "[ключ подключения скрыт]");
  assert.equal(JSON.stringify(client.messages).includes(f.env.QA_REPORT_IMPORT_TOKEN), false);
  assert.equal((await (await f.browser("/next")).json()).batch, null);
});

test("configuration pins the endpoint and rejects insecure or ambiguous addresses", () => {
  const env = { QA_REPORT_IMPORT_TOKEN: "a".repeat(64), QA_REPORT_IMPORT_URL: "https://reports.example/api/local-import/agent/session" };
  const server = createQaReportMcp(env); server.close();
  for (const url of ["http://reports.example/api/local-import/agent/session", "https://user:pass@reports.example/api/local-import/agent/session", "https://reports.example/api/local-import/agent/session?token=x", "https://reports.example/api/local-import/agent/session#token", "https://reports.example/api/reports"]) {
    assert.throws(() => createQaReportMcp({ ...env, QA_REPORT_IMPORT_URL: url }));
  }
  assert.throws(() => createQaReportMcp({ ...env, QA_REPORT_IMPORT_TOKEN: "bad" }));
  assert.throws(() => createQaReportMcp({ ...env, QA_REPORT_FILE_ROOT: "relative" }));
});

test("redirects never forward the capability; oversized or malformed service responses fail safely", async t => {
  let targetRequests = 0, mode = "redirect";
  const target = http.createServer((req, res) => { targetRequests++; res.end("{}"); });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  const source = http.createServer((req, res) => {
    if (mode === "redirect") { res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/stolen` }); res.end(); }
    else if (mode === "oversized") res.end("x".repeat(12 * 1024 * 1024 + 1));
    else res.end('{"context": {}}');
  });
  await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    source.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
  });
  const client = await connectMcp({ QA_REPORT_IMPORT_URL: `http://127.0.0.1:${source.address().port}/api/local-import/agent/session`, QA_REPORT_IMPORT_TOKEN: "a".repeat(64) });
  t.after(() => client.close());
  failed(await client.call("qa_report_get_context"));
  assert.equal(targetRequests, 0);
  mode = "oversized"; failed(await client.call("qa_report_get_context"));
  mode = "incomplete"; failed(await client.call("qa_report_get_context"));
  assert.equal(client.stderr, "");
});
