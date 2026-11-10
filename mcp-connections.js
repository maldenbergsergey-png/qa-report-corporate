"use strict";
const { createHash, randomBytes } = require("node:crypto");
const { reportToken } = require("./report-sharing");
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// A separate, expiring capability for ONE shared report. It is never a browser
// session, publisher identity or credential for the rest of the application.
function createMcpConnections({ reportSharing, readJson, sendJson, verifyCsrf, audit, now = Date.now }) {
  const connections = new Map();
  const sessionKey = user => `${user.email}:${user.iat}:${user.exp}`;
  function cleanup() { for (const [key, item] of connections) if (item.expiresAt <= now()) connections.delete(key); }
  function revokeSession(user) {
    for (const [key, item] of connections) if (item.session === sessionKey(user)) connections.delete(key);
  }
  async function browser(request, response, pathname) {
    if (pathname !== "/api/mcp/connections" && !/^\/api\/mcp\/connections\/[a-f0-9]{32}$/.test(pathname)) return false;
    if (!request.user) fail(401, "Требуется корпоративный вход");
    if (!verifyCsrf(request, request.headers["x-qa-csrf-token"])) fail(403, "Недействительный защитный токен");
    cleanup();
    if (request.method === "DELETE" && pathname !== "/api/mcp/connections") {
      const id = pathname.split("/").pop();
      for (const [key, item] of connections) if (item.id === id && item.session === sessionKey(request.user)) connections.delete(key);
      audit(request, response, "mcp_connection_revoked");
      sendJson(response, 200, { ok: true }); return true;
    }
    if (request.method !== "POST" || pathname !== "/api/mcp/connections") fail(405, "Метод не поддерживается");
    const body = await readJson(request, 4096);
    if (!/^[a-f0-9]{32}$/.test(body.reportId) || !/^[A-Za-z0-9_-]{43}$/.test(body.reportToken)) fail(400, "Нужно подключение к одному опубликованному отчёту");
    // Use the existing report authorization, including live link revocation.
    const probe = Object.create(request);
    probe.method = "GET"; probe.url = `/api/shared-reports/${body.reportId}`;
    probe.headers = { ...request.headers, "x-qa-report-token": body.reportToken, authorization: `Bearer ${body.reportToken}` };
    let status, payload;
    const capture = { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } };
    await reportSharing(probe, capture, probe.url);
    if (status !== 200 || !payload?.report) fail(status || 403, "Отчёт недоступен");
    const expiresAt = Math.min(now() + 5 * 60 * 60 * 1000, request.user.exp * 1000);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) fail(401, "Сессия истекла");
    // Reconnecting the same report replaces its old capability for this session.
    for (const [key, item] of connections) if (item.session === sessionKey(request.user) && item.reportId === body.reportId) connections.delete(key);
    if (connections.size >= 1000 || [...connections.values()].filter(item => item.session === sessionKey(request.user)).length >= 10) fail(429, "Слишком много подключений");
    const token = randomBytes(32).toString("hex"), id = randomBytes(16).toString("hex");
    connections.set(digest(token), { id, expiresAt, session: sessionKey(request.user), user: { ...request.user },
      reportId: body.reportId, reportTokenHash: digest(body.reportToken), canReply: Boolean(payload.report.canReply) });
    audit(request, response, "mcp_connection_created", { expiresAt });
    sendJson(response, 200, { ok: true, id, token, expiresAt }); return true;
  }
  async function machine(request, response, pathname) {
    if (!pathname.startsWith("/api/mcp/shared/")) return false;
    cleanup();
    const token = request.headers["x-qa-mcp-token"];
    const item = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && connections.get(digest(token));
    if (!item) fail(401, "Подключение ИИ истекло или отключено. Откройте отчёт после корпоративного входа и подключите ИИ заново");
    const match = pathname.match(/^\/api\/mcp\/shared\/([a-f0-9]{32})(\/answers|\/files\/[A-Za-z0-9_-]{1,80})?$/);
    const linkToken = reportToken(request);
    if (!match || match[1] !== item.reportId || !linkToken || digest(linkToken) !== item.reportTokenHash) fail(403, "Подключение ограничено одним отчётом");
    if (!((request.method === "GET" && match[2] !== "/answers") || (request.method === "POST" && match[2] === "/answers" && item.canReply))) fail(403, "Действие недоступно этому подключению");
    const proxy = Object.create(request);
    proxy.user = { ...item.user }; proxy.url = `/api/shared-reports/${item.reportId}${match[2] || ""}`;
    proxy[Symbol.asyncIterator] = request[Symbol.asyncIterator].bind(request);
    await reportSharing(proxy, response, proxy.url);
    if (request.method === "POST") audit(request, response, "mcp_shared_report_write", { email: item.user.email });
    return true;
  }
  return { browser, machine, revokeSession };
}
module.exports = { createMcpConnections };
