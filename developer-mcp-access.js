"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { normalizeEmail, developerSessionProof } = require("./auth");
const { initializeSharing } = require("./report-sharing");
const { projectOf } = require("./project-mcp-access");
const tracker = require("./tracker-links");

const base = "/api/mcp/developer";
const grantLifetime = 30 * 24 * 60 * 60 * 1000;
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const readGrant = `SELECT id, recipient, project_key AS projectKey, tracker_url AS trackerUrl,
  provider, can_reply AS canReply, expires_at AS expiresAt FROM developer_project_grants`;

function createDeveloperAccess({ getDb, readJson, sendJson, verifyCsrf, reportSharing, projects, audit, now = Date.now, sessionProof = developerSessionProof }) {
  const delegated = Symbol("developer device");
  const pending = new Map();
  let initialized;
  function db() {
    const store = getDb();
    if (store === initialized) return store;
    initializeSharing(store);
    store.function("mcp_project_id", { deterministic: true }, issueUrl => projectOf(issueUrl)?.id || null);
    store.exec(`CREATE TABLE IF NOT EXISTS developer_devices (
      device_hash TEXT PRIMARY KEY, recipient TEXT NOT NULL, session_iat INTEGER NOT NULL, expires_at INTEGER NOT NULL, session_proof TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS developer_project_grants (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL, recipient TEXT NOT NULL, project_id TEXT NOT NULL,
      project_key TEXT NOT NULL, tracker_url TEXT NOT NULL, provider TEXT NOT NULL, can_reply INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, UNIQUE(author_id, recipient, project_id)
    );
    CREATE INDEX IF NOT EXISTS developer_grant_recipient ON developer_project_grants(recipient, author_id, project_id);`);
    initialized = store;
    return store;
  }
  function device(hash) {
    const row = db().prepare("SELECT recipient, session_iat, expires_at, session_proof FROM developer_devices WHERE device_hash=? AND expires_at>?").get(hash, now());
    if (row && row.session_proof !== sessionProof(row.recipient, row.session_iat, row.expires_at)) {
      db().prepare("DELETE FROM developer_devices WHERE device_hash=?").run(hash);
      return null;
    }
    return row;
  }
  function revokeSession(user) {
    db().prepare("DELETE FROM developer_devices WHERE recipient=? AND session_iat=? AND expires_at=?").run(user.email, user.iat, user.exp * 1000);
  }
  function beginPairing(hash) {
    const current = device(hash);
    if (current) return { connected: true, expiresAt: current.expires_at };
    for (const [code, item] of pending) {
      if (item.expiresAt <= now()) pending.delete(code);
      else if (item.hash === hash) return { code, expiresAt: item.expiresAt };
    }
    if (pending.size >= 512) fail(429, "Попробуйте привязать устройство позже.");
    let code;
    do { code = randomBytes(6).toString("hex").toUpperCase(); } while (pending.has(code));
    const expiresAt = now() + 5 * 60 * 1000;
    pending.set(code, { hash, expiresAt });
    return { code, expiresAt };
  }
  function approve(code, user) {
    const item = pending.get(code);
    if (!item || item.expiresAt <= now()) fail(400, "Код уже использован или истёк. Запросите код в своём чате.");
    const expiresAt = user.exp * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) fail(401, "Войдите снова.");
    db().prepare("DELETE FROM developer_devices WHERE expires_at<=?").run(now());
    db().prepare("INSERT INTO developer_devices(device_hash,recipient,session_iat,expires_at,session_proof) VALUES(?,?,?,?,?)")
      .run(item.hash, user.email, user.iat, expiresAt, sessionProof(user.email, user.iat, expiresAt));
    pending.delete(code);
    return expiresAt;
  }
  function authorize(request, row) {
    const context = request[delegated];
    if (!context) return null;
    const current = device(context.hash);
    if (!current || current.recipient !== context.recipient || current.session_iat !== context.session_iat) fail(401, "Подтвердите корпоративный вход.");
    // For a supplied share link, reportSharing must check that exact link and its current permissions.
    if (context.kind === "links") return null;
    const project = row && !row.revoked_at && projectOf(JSON.parse(row.snapshot_json).issueUrl);
    const grant = project && db().prepare(`SELECT can_reply FROM developer_project_grants
      WHERE recipient=? AND author_id=? AND project_id=? AND expires_at>?`).get(current.recipient, row.author_id, project.id, now());
    if (!grant) fail(404, "Этот отчёт недоступен.");
    if (request.method === "POST" && !grant.can_reply) fail(403, "Для этого проекта доступно только чтение.");
    return { canReply: Boolean(grant.can_reply) };
  }
  function listReports(recipient, params) {
    const offset = Number(params.get("offset") || 0), limit = Number(params.get("limit") || 25);
    const query = (params.get("query") || "").trim().toLowerCase();
    if ([...params.keys()].some(key => !["offset", "limit", "query"].includes(key)) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || query.length > 200) fail(400, "Проверьте параметры поиска.");
    const rows = db().prepare(`SELECT r.id, r.created_at AS createdAt, g.can_reply AS canReply,
      json_extract(r.snapshot_json,'$.title') AS title, json_extract(r.snapshot_json,'$.issueUrl') AS issueUrl,
      json_extract(r.snapshot_json,'$.environment') AS environment
      FROM developer_project_grants g JOIN shared_publications r ON r.author_id=g.author_id
        AND mcp_project_id(json_extract(r.snapshot_json,'$.issueUrl'))=g.project_id
      WHERE g.recipient=? AND g.expires_at>? AND r.update_of IS NULL AND r.revoked_at IS NULL
        AND COALESCE(r.published_at,r.ready_at) IS NOT NULL ORDER BY r.created_at DESC,r.id DESC`).iterate(recipient, now());
    const reports = [];
    let skipped = 0;
    for (const row of rows) {
      if (query && ![row.title, row.issueUrl, tracker.parse(row.issueUrl)?.key].some(value => String(value || "").toLowerCase().includes(query))) continue;
      if (skipped++ < offset) continue;
      if (reports.length === limit) return { reports, nextOffset: offset + limit };
      reports.push({ ...row, canReply: Boolean(row.canReply) });
    }
    return { reports, nextOffset: null };
  }
  async function machine(request, response, pathname) {
    if (pathname === base + "/pair" && request.method === "POST") {
      const secret = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!secret) fail(401, "Нужен ключ устройства.");
      sendJson(response, 200, { ok: true, ...beginPairing(digest(secret)) });
      return true;
    }
    const match = pathname.match(/^\/api\/mcp\/developer\/(links|reports)(?:\/([a-f0-9]{32})(\/answers|\/files\/[A-Za-z0-9_-]{1,80})?)?$/);
    if (!match) return false;
    const secret = request.headers["x-qa-developer-device"];
    if (typeof secret !== "string" || !secretPattern.test(secret)) fail(401, "Нужна привязка устройства.");
    const hash = digest(secret), current = device(hash);
    if (!current) fail(401, "Подтвердите корпоративный вход.");
    const [, kind, id, suffix = ""] = match;
    if (kind === "reports" && request.headers.authorization !== "Bearer " + secret) fail(401, "Нужен ключ устройства.");
    const url = new URL(request.url, "http://localhost");
    if (!id) {
      if (request.method !== "GET" || kind !== "reports") fail(405, "Метод недоступен.");
      sendJson(response, 200, { ok: true, ...listReports(current.recipient, url.searchParams) });
      return true;
    }
    if (url.search || request.method !== (suffix === "/answers" ? "POST" : "GET")) fail(405, "Метод недоступен.");
    const proxy = Object.create(request);
    proxy[delegated] = { kind, hash, ...current };
    proxy.user = { email: current.recipient, iat: current.session_iat, exp: current.expires_at / 1000 };
    proxy.url = "/api/shared-reports/" + id + suffix;
    proxy[Symbol.asyncIterator] = request[Symbol.asyncIterator].bind(request);
    await reportSharing(proxy, response, proxy.url);
    if (request.method === "POST") audit(request, response, "developer_mcp_answer", { email: current.recipient, category: id });
    return true;
  }
  function currentGrants(author) {
    return db().prepare(readGrant + " WHERE author_id=? AND expires_at>? ORDER BY recipient,project_key,tracker_url").all(author, now());
  }
  async function browser(request, response, pathname) {
    const grants = base + "/grants";
    const grantId = pathname.match(/^\/api\/mcp\/developer\/grants\/([a-f0-9]{32})$/)?.[1];
    if (pathname !== base + "/approve" && pathname !== grants && !grantId) return false;
    const user = request.user;
    if (!user?.email) fail(401, "Войдите в корпоративную учётную запись.");
    if (request.method !== "GET" && (!verifyCsrf(request, request.headers["x-qa-csrf-token"]) ||
        !request.headers["content-type"]?.startsWith("application/json"))) fail(403, "Недействительный защитный токен.");
    if (pathname === base + "/approve" && request.method === "POST") {
      const body = await readJson(request, 1024);
      if (body?.account !== user.email) fail(409, "Учётная запись изменилась. Обновите страницу подключения.");
      const expiresAt = approve(body.code, user);
      audit(request, response, "developer_mcp_paired");
      sendJson(response, 200, { ok: true, expiresAt }); return true;
    }
    if (pathname === grants && request.method === "GET") {
      sendJson(response, 200, { ok: true, grants: currentGrants(user.email) }); return true;
    }
    if (pathname === grants && request.method === "POST") {
      const body = await readJson(request, 4096);
      const recipient = normalizeEmail(body?.recipient);
      if (!body || Object.keys(body).some(key => !["recipient", "projectId", "issueUrl", "readOnly"].includes(key)) ||
          typeof body.recipient !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || typeof body.readOnly !== "boolean" ||
          Boolean(body.projectId) === Boolean(body.issueUrl)) fail(400, "Укажите корпоративный email и проект.");
      const project = body.projectId ? projects(user.email).find(item => item.id === body.projectId) : projectOf(body.issueUrl);
      if (!project) fail(400, "Выберите проект или передайте ссылку на его задачу в Jira или Eva.");
      // An author can pre-authorize their own future publications on the specified tracker.
      const store = db(), expiresAt = now() + grantLifetime;
      store.prepare("DELETE FROM developer_project_grants WHERE expires_at<=?").run(now());
      const assigned = store.prepare(`INSERT INTO developer_project_grants(id,author_id,recipient,project_id,project_key,tracker_url,provider,can_reply,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(author_id,recipient,project_id) DO UPDATE SET can_reply=excluded.can_reply, expires_at=excluded.expires_at RETURNING id`)
        .get(randomBytes(16).toString("hex"), user.email, recipient, project.id, project.projectKey, project.trackerUrl, project.provider, body.readOnly ? 0 : 1, expiresAt);
      audit(request, response, "developer_project_granted", { category: assigned.id });
      sendJson(response, 200, { ok: true, expiresAt, grants: currentGrants(user.email) }); return true;
    }
    if (grantId && request.method === "DELETE") {
      if (!db().prepare("DELETE FROM developer_project_grants WHERE id=? AND author_id=?").run(grantId, user.email).changes) fail(404, "Назначение недоступно.");
      audit(request, response, "developer_project_revoked", { category: grantId });
      sendJson(response, 200, { ok: true, grants: currentGrants(user.email) }); return true;
    }
    fail(405, "Метод недоступен.");
  }
  return { machine, browser, authorize, revokeSession };
}

module.exports = { createDeveloperAccess };
