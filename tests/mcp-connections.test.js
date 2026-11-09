const test = require("node:test");
const assert = require("node:assert/strict");
const { createMcpConnections } = require("../mcp-connections");
const reportId = "a".repeat(32), reportToken = "b".repeat(43);
function fixture() {
  let time = 100000, revoked = false;
  const calls = [], events = [];
  const user = { email: "qa@example.test", iat: 50, exp: 500 };
  const service = createMcpConnections({ now: () => time, readJson: async req => req.body,
    sendJson: (res, status, data) => { res.status = status; res.data = data; },
    verifyCsrf: req => req.headers["x-qa-csrf-token"] === "valid",
    audit: (req, res, event) => events.push(event),
    reportSharing: async (req, res, path) => {
      calls.push({ user: req.user, path, method: req.method });
      if (revoked || req.headers.authorization !== `Bearer ${reportToken}`) throw Object.assign(new Error("Unavailable"), { status: 404 });
      res.writeHead?.(200); res.end?.(JSON.stringify({ report: { canReply: true } }));
    },
  });
  const issue = async (overrides = {}) => {
    const req = { method: "POST", user, headers: { "x-qa-csrf-token": "valid" }, body: { reportId, reportToken }, ...overrides };
    const res = {}; await service.browser(req, res, "/api/mcp/connections"); return res.data;
  };
  const machine = (connection, path = reportId, method = "GET", token = reportToken) => service.machine({ method,
    headers: { "x-qa-mcp-token": connection.token, authorization: `Bearer ${token}` },
    async *[Symbol.asyncIterator]() {} }, {}, "/api/mcp/shared/" + path);
  return { service, issue, machine, user, calls, events, expire: () => { time = 500000; }, revoke: () => { revoked = true; } };
}
const status = expected => error => error.status === expected;

test("corporate MCP issuance needs login, CSRF and existing report access; lifetime cannot exceed login", async () => {
  const f = fixture();
  await assert.rejects(f.issue({ user: null }), status(401));
  await assert.rejects(f.issue({ headers: {} }), status(403));
  await assert.rejects(f.issue({ body: { reportId, reportToken: "wrong" } }), status(400));
  await assert.rejects(f.issue({ body: { reportId, reportToken: "c".repeat(43) } }), status(404));
  const connection = await f.issue();
  assert.equal(connection.expiresAt, f.user.exp * 1000);
  assert.equal(connection.token.length, 64);
  await f.machine(connection);
  assert.equal(f.calls.at(-1).user.email, f.user.email);
  assert.equal(f.calls.at(-1).path, "/api/shared-reports/" + reportId);
  await f.machine(connection, reportId + "/answers", "POST");
  for (const path of ["c".repeat(32), reportId + "/author", reportId + "/answer-files", reportId + "/files/../other", reportId + "/answers/extra"]) await assert.rejects(f.machine(connection, path), status(403));
  for (const method of ["PUT", "DELETE", "PATCH"]) await assert.rejects(f.machine(connection, reportId, method), status(403));
  await assert.rejects(f.machine(connection, reportId, "GET", "c".repeat(43)), status(403));
  f.expire(); await assert.rejects(f.machine(connection), status(401));
});

test("reconnection, explicit stop, logout and publication revocation invalidate corporate MCP access", async () => {
  const f = fixture(), first = await f.issue(), second = await f.issue();
  await assert.rejects(f.machine(first), status(401));
  await f.machine(second);
  const request = { user: f.user, headers: { "x-qa-csrf-token": "valid" }, method: "DELETE" };
  await f.service.browser({ ...request, user: { ...f.user, email: "other@example.test" } }, {}, "/api/mcp/connections/" + second.id);
  await f.machine(second);
  await f.service.browser(request, {}, "/api/mcp/connections/" + second.id);
  await assert.rejects(f.machine(second), status(401));
  const third = await f.issue(); f.service.revokeSession(f.user);
  await assert.rejects(f.machine(third), status(401));
  const fourth = await f.issue(); f.revoke();
  await assert.rejects(f.machine(fourth), status(404));
});

test("read links cannot acquire answer permissions through a corporate connection", async () => {
  const service = createMcpConnections({ readJson: async () => ({ reportId, reportToken }), verifyCsrf: () => true,
    audit() {}, sendJson: (res, status, data) => { res.data = data; },
    reportSharing: async (req, res) => { res.writeHead(200); res.end(JSON.stringify({ report: { canReply: false } })); },
  });
  const response = {};
  await service.browser({ method: "POST", user: { email: "reader@example.test", exp: Date.now() / 1000 + 60 }, headers: {} }, response, "/api/mcp/connections");
  await assert.rejects(service.machine({ method: "POST", headers: { authorization: `Bearer ${reportToken}`, "x-qa-mcp-token": response.data.token } }, {}, `/api/mcp/shared/${reportId}/answers`), status(403));
});
