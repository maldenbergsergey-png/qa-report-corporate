const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../jira-publication");

function fixture(type = "data-center") {
  let current = { id: "123", body: type === "cloud" ? { type: "doc", version: 1, content: [] } : "Original", author: { key: "qa" }, visibility: { type: "role", value: "Developers" } };
  const calls = [];
  const fetch = async (connection, path, options = {}) => {
    calls.push({ path, ...options });
    if (path.endsWith("/myself")) return { key: "qa" };
    if (options.method === "PUT") { current = { ...current, ...JSON.parse(options.body) }; return structuredClone(current); }
    return structuredClone(current);
  };
  const payload = { commentId: "123", expectedBodyHash: api.fingerprint(current.body), comment: { body: type === "cloud" ? { type: "doc", version: 1, content: [{ type: "text", text: "Changed " }] } : "Changed" } };
  return { connection: { type }, issue: { issueKey: "QA-1", issueUrl: "https://jira.example/browse/QA-1" }, payload, fetch, calls,
    set(value) { current = { ...current, ...value }; } };
}

for (const type of ["data-center", "cloud"]) test(`${type}: update preserves ID, owner and visibility; retry never creates a comment`, async () => {
  const f = fixture(type);
  const result = await api.updateComment(f.connection, f.issue, f.payload, f.fetch);
  assert.equal(result.commentId, "123"); assert.equal(result.bodyHash, api.fingerprint(f.payload.comment.body));
  assert.match(result.commentUrl, /focusedCommentId=123/); assert.ok(Date.parse(result.publishedAt));
  const put = f.calls.find(call => call.method === "PUT");
  assert.match(put.path, new RegExp(`/rest/api/${type === "cloud" ? 3 : 2}/issue/QA-1/comment/123$`));
  assert.deepEqual(JSON.parse(put.body).visibility, { type: "role", value: "Developers" });
  await api.updateComment(f.connection, f.issue, f.payload, f.fetch);
  assert.equal(f.calls.filter(call => call.method === "PUT").length, 1);
  assert.equal(f.calls.some(call => call.method === "POST"), false);
});

test("preflight is read-only; changes in Jira and a different author stop all mutation", async () => {
  const f = fixture();
  await api.updateComment(f.connection, f.issue, { ...f.payload, checkOnly: true }, f.fetch);
  assert.equal(f.calls.some(call => call.method), false);
  f.set({ body: "Edited in Jira" });
  await assert.rejects(api.updateComment(f.connection, f.issue, f.payload, f.fetch), error => error.status === 409);
  f.set({ body: "Original", author: { key: "other" } });
  await assert.rejects(api.updateComment(f.connection, f.issue, f.payload, f.fetch), error => error.status === 403);
  assert.equal(f.calls.some(call => call.method), false);
});

test("invalid binding, missing comment and unconfirmed PUT fail without creating a replacement", async () => {
  const f = fixture();
  await assert.rejects(api.updateComment(f.connection, f.issue, { ...f.payload, commentId: "../2" }, f.fetch), error => error.status === 422);
  await assert.rejects(api.updateComment(f.connection, f.issue, f.payload, async () => { throw Object.assign(Error("404"), { status: 404 }); }), /удалён или недоступен/);
  await assert.rejects(api.updateComment(f.connection, f.issue, f.payload, async (connection, path) => path.endsWith("/myself") ? { key: "qa" } : { id: "123", body: "Original", author: { key: "qa" } }), error => error.status === 502);
});

test("binding survives JSON storage, excludes credentials, matches Jira context and drops on copy", () => {
  const value = { reportId: "report", issueUrl: "https://jira.example/jira/browse/qa-1?token=secret", format: "wiki", token: "secret", firstPublishedAt: "2026-10-08T09:00:00Z", lastPublishedAt: "2026-10-08T10:00:00Z", parts: [{ commentId: "123", bodyHash: api.fingerprint("body"), commentUrl: "javascript:alert(1)" }, null], sectionIds: ["section"], statuses: ["OK"], split: true };
  const saved = api.normalize(JSON.parse(JSON.stringify(value)), "report");
  assert.ok(saved); assert.equal(saved.parts[1], null); assert.equal(saved.parts[0].commentUrl, undefined);
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  assert.ok(api.matching(saved, "report", "https://jira.example/jira/browse/QA-1#comment-123"));
  assert.equal(api.matching(saved, "report", "https://jira.example/browse/QA-1"), null);
  assert.equal(api.matching(saved, "report", "https://jira.example/jira/browse/QA-2"), null);
  assert.equal(api.normalize(saved, "copy"), null);
});

test("ADF key order is ignored but text spaces remain significant", () => {
  assert.equal(api.fingerprint({ version: 1, type: "doc" }), api.fingerprint({ type: "doc", version: 1 }));
  assert.notEqual(api.fingerprint({ text: "word " }), api.fingerprint({ text: "word" }));
});


test("only a dedicated missing-comment response clears a binding; other failures preserve it", () => {
  const message = "Связанный комментарий удалён или недоступен. Можно опубликовать отчёт заново.";
  assert.equal(api.missingComment({ status: 404, message }), true);
  for (const status of [0, 401, 403, 409, 429, 502, 504]) assert.equal(api.missingComment({ status, message }), false);
  assert.equal(api.missingComment({ status: 404, message: "Task or route not found" }), false);
  assert.equal(api.missingComment(null), false);
});

test("a stale missing-comment response cannot clear a new publication or a different report", () => {
  const link = { reportId: "report", issueUrl: "https://jira.example/browse/QA-1", format: "wiki", parts: [{ commentId: "123", bodyHash: api.fingerprint("body") }, null], split: true };
  assert.equal(api.sameComments(link, link), true);
  assert.equal(api.sameComments({ ...link, lastPublishedAt: new Date().toISOString(), parts: [{ ...link.parts[0], bodyHash: api.fingerprint("updated") }, { commentId: "124" }] }, link), true);
  assert.equal(api.sameComments({ ...link, parts: [{ commentId: "456" }, null] }, link), false);
  assert.equal(api.sameComments({ ...link, reportId: "another" }, link), false);
  assert.equal(api.sameComments({ ...link, issueUrl: "https://jira.example/browse/QA-2" }, link), false);
  assert.equal(api.sameComments(null, link), false);
});
