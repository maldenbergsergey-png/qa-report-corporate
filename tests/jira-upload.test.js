"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const { createUploadStore } = require("../jira-upload-store");
const Runtime = require("../jira-upload-runtime");
const owner = { source: "test", id: "first" }, other = { source: "test", id: "second" };
const connection = { baseUrl: "https://jira.example", token: "never-log-this-token" };
test("a pending or completed upload is scoped to its owner and never repeats a POST", async () => {
  const db = new DatabaseSync(":memory:"), store = createUploadStore(() => db), id = crypto.randomUUID();
  let release, posts = 0;
  const gate = new Promise(resolve => release = resolve);
  const execute = async posted => { Runtime.stage("inventory"); await gate; posted(); posts++; return { attachments: [{ id: "42" }] }; };
  assert.equal(store.start(owner, id, "hash", execute).state, "running");
  assert.throws(() => store.view(other, id), error => error.status === 404);
  assert.equal(store.start(owner, id, "hash", execute).state, "running");
  assert.throws(() => store.start(owner, id, "different", execute), error => error.status === 409);
  release(); assert.equal((await store.wait(owner, id)).state, "completed");
  assert.equal(store.start(owner, id, "hash", execute).result.attachments[0].id, "42"); assert.equal(posts, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('jira_upload_operations') WHERE name LIKE '%token%' OR name LIKE '%payload%'").get().n, 0);
  db.close();
});
test("an uncertain external result remains blocked, including after a process restart", async () => {
  const db = new DatabaseSync(":memory:"), store = createUploadStore(() => db), id = crypto.randomUUID(); let posts = 0;
  const execute = async posted => { posted(); posts++; throw Object.assign(new Error("gateway failed"), { status: 504, code: "JIRA_UPSTREAM_ERROR", upstreamStatus: 504 }); };
  store.start(owner, id, "hash", execute); const result = await store.wait(owner, id);
  assert.equal(result.state, "unknown"); assert.equal(result.status, 504); assert.equal(result.upstreamStatus, 504);
  assert.equal(store.start(owner, id, "hash", execute).state, "unknown"); assert.equal(posts, 1);
  const restarted = createUploadStore(() => db); assert.equal(restarted.view(owner, id).state, "unknown");
  const pending = crypto.randomUUID(); db.prepare("INSERT INTO jira_upload_operations VALUES (?, ?, ?, 'h', 'running', 'upload', 1, '{}', '', '')").run(owner.source, owner.id, pending);
  const notPosted = crypto.randomUUID(); db.prepare("INSERT INTO jira_upload_operations VALUES (?, ?, ?, 'h', 'running', 'inventory', 0, '{}', '', '')").run(owner.source, owner.id, notPosted);
  const again = createUploadStore(() => db); assert.equal(again.view(owner, pending).errorCode, "UPLOAD_RESULT_UNKNOWN");
  assert.equal(again.view(owner, notPosted).retrySafe, true);
  again.start(owner, notPosted, "h", async () => ({ ok: true })); assert.equal((await again.wait(owner, notPosted)).state, "completed"); db.close();
});
test("a failure before POST can be retried and tokens never partition sessions across users", async () => {
  const db = new DatabaseSync(":memory:"), store = createUploadStore(() => db), id = crypto.randomUUID(); let attempts = 0;
  const execute = async () => { if (++attempts === 1) throw Object.assign(new Error("not allowed"), { status: 403 }); return { ok: true }; };
  store.start(owner, id, "hash", execute); assert.equal((await store.wait(owner, id)).state, "failed");
  store.start(owner, id, "hash", execute); assert.equal((await store.wait(owner, id)).state, "completed");
  const session = Runtime.createSession(connection, "QA-1", { jiraUploadLimit: 10 }, [{ id: "1" }]);
  assert.equal(Runtime.session(connection, "QA-1", session).files.length, 1);
  assert.equal(Runtime.session({ ...connection, token: "other-user" }, "QA-1", session), null);
  assert.equal(Runtime.session(connection, "QA-2", session), null); db.close();
});
test("HTML gateway errors preserve upstream status; local network timeouts have a separate code", async () => {
  const error = Runtime.httpError(new Response("<html>504</html>", { status: 504 }), "/rest/api/2/issue/QA-1/attachments");
  assert.equal(error.status, 504); assert.equal(error.code, "JIRA_UPSTREAM_ERROR"); assert.doesNotMatch(error.message, /SSO|WAF|PAT/);
  await assert.rejects(Runtime.request(async () => { throw new DOMException("timeout", "TimeoutError"); }, "https://jira.example", {}), e => e.status === 502 && e.code === "JIRA_TRANSPORT_TIMEOUT");
});
