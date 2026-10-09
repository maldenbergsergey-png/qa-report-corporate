"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createBugReportService } = require("../bug-report-server");
test("corporate bug creation retains session, CSRF and OAuth boundaries and isolates idempotency by owner", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corporate-bugs-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let creates = 0; const used = [];
  const service = createBugReportService({
    directory, readJson: async req => req.body, sendJson: (res, status, value) => Object.assign(res, { status, value }), audit: () => {},
    requireUser: req => { if (!req.user) throw Object.assign(Error("Login required"), { status: 401 }); return req.user; },
    verifyCsrf: (_, token) => token === "fixture-csrf",
    jiraConnection: (req, body) => { if (body.instanceId !== "allowed") throw Object.assign(Error("Connection unavailable"), { status: 403 }); return { id: "allowed", baseUrl: "https://jira.example.test", type: "data-center", token: `oauth-${req.user}` }; },
    jiraFetch: async (connection, route, options) => {
      used.push(connection.token);
      if (/issuetypes\/1/.test(route)) return { values: [{ fieldId: "summary", name: "Тема", required: true, schema: { type: "string" } }], isLast: true };
      if (/issuetypes/.test(route)) return { values: [{ id: "1", name: "Ошибка", subtask: false }], isLast: true };
      if (route === "/rest/api/2/issue" && options?.method === "POST") { creates++; return { key: `APP-${creates}` }; }
      throw Error(`Unexpected route: ${route}`);
    },
  });
  const body = { instanceId: "allowed", csrfToken: "fixture-csrf", mode: "standalone", projectKey: "APP", issueTypeId: "1", fields: { summary: "Тестовый баг" }, operationId: crypto.randomUUID() };
  const call = async (user = "alice", change = {}) => { const response = {}; await service({ url: "/api/jira/create-issue", method: "POST", user, body: { ...body, ...change } }, response); return response; };
  await assert.rejects(call(null), { status: 401 }); await assert.rejects(call("alice", { csrfToken: "invalid" }), { status: 403 });
  await assert.rejects(call("alice", { instanceId: "foreign", baseUrl: "https://attacker.example.test" }), { status: 403 });
  const [a, b] = await Promise.all([call(), call()]); assert.equal(a.value.key, b.value.key); assert.equal(creates, 1);
  await assert.rejects(call("alice", { fields: { summary: "Изменённые поля" } }), { status: 409 });
  await call("bob"); assert.equal(creates, 2); assert.ok(used.includes("oauth-bob"));
  await assert.rejects(call("alice", { operationId: crypto.randomUUID(), fields: {} }), { status: 422, fieldErrors: { summary: "Укажите заголовок до 255 символов" } });
  assert.equal(await service({ url: "/api/reports", method: "POST" }, {}), false);
});
