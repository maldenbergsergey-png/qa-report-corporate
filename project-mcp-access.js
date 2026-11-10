"use strict";
const { createHash, randomBytes } = require("node:crypto");
const { initializeSharing } = require("./report-sharing");
const TrackerLinks = require("./tracker-links");
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const lifetime = 30 * 24 * 60 * 60 * 1000;
const browserApi = "/api/mcp/project-keys";
const machineApi = "/api/mcp/projects/";

function projectOf(issueUrl) {
  const issue = TrackerLinks.parse(issueUrl);
  const projectKey = issue?.key.match(/^([\p{L}\p{N}_][\p{L}\p{N}_-]{0,99})-\d+$/u)?.[1]?.toUpperCase();
  if (!projectKey) return null;
  const scope = { provider: issue.provider, trackerUrl: issue.baseUrl, projectKey };
  return { ...scope, id: digest(JSON.stringify(scope)) };
}
function createProjectMcpAccess({ getDb, readJson, sendJson, requestOrigin, authenticateOwner, validateWrite, reportSharing, audit = () => {}, now = Date.now }) {
  const delegated = Symbol("project-mcp-access"), rates = new Map();
  let initialized;
  function db() {
    const value = getDb();
    if (initialized !== value) {
      initializeSharing(value);
      value.exec(`CREATE TABLE IF NOT EXISTS shared_report_project_keys (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, project_id TEXT NOT NULL,
        provider TEXT NOT NULL, tracker_url TEXT NOT NULL, project_key TEXT NOT NULL,
        label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, can_reply INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER
      ); CREATE INDEX IF NOT EXISTS project_keys_author ON shared_report_project_keys(author_id, created_at);`);
      initialized = value;
    }
    return value;
  }
  const safeKey = row => ({ id: row.id, projectId: row.project_id, provider: row.provider, trackerUrl: row.tracker_url,
    projectKey: row.project_key, label: row.label, canReply: Boolean(row.can_reply), createdAt: row.created_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at });
  function metadata(author) {
    return db().prepare(`SELECT id, created_at, json_extract(snapshot_json, '$.title') AS title,
      json_extract(snapshot_json, '$.issueUrl') AS issue_url,
      json_extract(snapshot_json, '$.environment') AS environment,
      json_extract(snapshot_json, '$.overallStatus') AS overall_status
      FROM shared_publications WHERE author_id = ? AND update_of IS NULL
      AND COALESCE(published_at, ready_at) IS NOT NULL AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`).iterate(author);
  }
  function projects(author) {
    const result = new Map();
    for (const row of metadata(author)) {
      const project = projectOf(row.issue_url);
      if (!project) continue;
      const entry = result.get(project.id) || { ...project, reportCount: 0 };
      entry.reportCount++; result.set(project.id, entry);
    }
    return [...result.values()].sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.trackerUrl.localeCompare(b.trackerUrl));
  }
  async function browser(request, response, pathname) {
    if (pathname !== browserApi && !new RegExp("^" + browserApi + "/[a-f0-9]{32}$").test(pathname)) return false;
    if (request.headers.origin && request.headers.origin !== requestOrigin(request)) fail(403, "Запрос с другого сайта отклонён");
    const owner = await authenticateOwner(request);
    if (!owner) fail(401, "Войдите в профиль автора опубликованных отчётов.");
    if (!["GET", "POST", "DELETE"].includes(request.method)) fail(405, "Метод не поддерживается");
    if (request.method !== "GET") validateWrite(request);
    if (request.method === "GET" && pathname === browserApi) {
      sendJson(response, 200, { ok: true, projects: projects(owner), keys: db().prepare(
        "SELECT * FROM shared_report_project_keys WHERE author_id = ? ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC LIMIT 100").all(owner, now()).map(safeKey) });
      return true;
    }
    if (request.method === "POST" && pathname === browserApi) {
      const body = await readJson(request, 4096);
      if (!body || Object.keys(body).some(key => !["projectId", "label", "readOnly"].includes(key))
        || !/^[a-f0-9]{64}$/.test(body.projectId) || typeof body.label !== "string"
        || !body.label.trim() || body.label.length > 100 || /[\x00-\x1f\x7f]/.test(body.label)
        || (body.readOnly !== undefined && typeof body.readOnly !== "boolean")) fail(400, "Выберите проект и укажите название ключа.");
      const project = projects(owner).find(item => item.id === body.projectId);
      if (!project) fail(404, "В этом проекте нет ваших доступных опубликованных отчётов с полной ссылкой на задачу.");
      if (db().prepare("SELECT count(*) AS count FROM shared_report_project_keys WHERE author_id = ? AND revoked_at IS NULL AND expires_at > ?").get(owner, now()).count >= 20) fail(429, "Отзовите неиспользуемые ключи: разрешено до 20 активных ключей.");
      const id = randomBytes(16).toString("hex"), token = randomBytes(32).toString("base64url"), createdAt = now();
      db().prepare(`INSERT INTO shared_report_project_keys
        (id,author_id,project_id,provider,tracker_url,project_key,label,token_hash,can_reply,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, owner, project.id, project.provider, project.trackerUrl, project.projectKey,
          body.label.trim(), digest(token), body.readOnly ? 0 : 1, createdAt, createdAt + lifetime);
      const key = safeKey(db().prepare("SELECT * FROM shared_report_project_keys WHERE id = ?").get(id));
      audit(request, response, "project_mcp_key_created", { email: owner });
      sendJson(response, 201, { ok: true, key, connection: { url: `${requestOrigin(request)}${machineApi}${id}/reports`, token } });
      return true;
    }
    if (request.method === "DELETE" && pathname !== browserApi) {
      const id = pathname.split("/").pop();
      const changed = db().prepare("UPDATE shared_report_project_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND author_id = ?").run(now(), id, owner);
      if (!changed.changes) fail(404, "Ключ недоступен.");
      audit(request, response, "project_mcp_key_revoked", { email: owner });
      sendJson(response, 200, { ok: true }); return true;
    }
    fail(405, "Метод не поддерживается");
  }
  function validKey(id, hash) {
    const key = db().prepare("SELECT * FROM shared_report_project_keys WHERE id = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > ?").get(id, hash, now());
    if (!key) fail(401, "Проектный ключ недействителен, отозван или истёк.");
    return key;
  }
  function authorize(request, row) {
    const grant = request[delegated];
    if (!grant) return null;
    const key = validKey(grant.id, grant.hash);
    if (!row || row.revoked_at || row.author_id !== key.author_id || projectOf(JSON.parse(row.snapshot_json).issueUrl)?.id !== key.project_id) fail(404, "Отчёт недоступен проектному ключу.");
    return { canReply: Boolean(key.can_reply) };
  }
  function rate(request) {
    const address = request.socket?.remoteAddress || "unknown", time = now();
    let entry = rates.get(address);
    if (!entry || time - entry.start >= 60000) entry = { start: time, read: 0, write: 0 };
    const type = request.method === "GET" ? "read" : "write";
    if (++entry[type] > (type === "read" ? 240 : 60)) fail(429, "Слишком много запросов. Повторите позже.");
    if (rates.size > 1000) for (const [ip, item] of rates) if (time - item.start >= 60000) rates.delete(ip);
    if (rates.size > 2000) fail(429, "Слишком много запросов. Повторите позже.");
    rates.set(address, entry);
  }
  async function machine(request, response, pathname) {
    if (!pathname.startsWith(machineApi)) return false;
    rate(request);
    if (request.headers.origin && request.headers.origin !== requestOrigin(request)) fail(403, "Запрос с другого сайта отклонён");
    const match = pathname.match(/^\/api\/mcp\/projects\/([a-f0-9]{32})\/reports(?:\/([a-f0-9]{32})(\/answers|\/files\/[A-Za-z0-9_-]{1,80})?)?$/);
    const token = String(request.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!match || !token) fail(401, "Нужен действующий проектный ключ.");
    const key = validKey(match[1], digest(token));
    const url = new URL(request.url, requestOrigin(request));
    if (!match[2]) {
      if (request.method !== "GET") fail(405, "Метод не поддерживается");
      if ([...url.searchParams.keys()].some(name => !["offset", "limit", "query"].includes(name))) fail(400, "Неизвестный параметр списка отчётов.");
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 25), query = (url.searchParams.get("query") || "").trim().toLowerCase();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || query.length > 200) fail(400, "Некорректные параметры списка отчётов.");
      const reports = []; let skipped = 0;
      for (const row of metadata(key.author_id)) {
        if (projectOf(row.issue_url)?.id !== key.project_id || (query && !`${row.title || ""} ${row.issue_url}`.toLowerCase().includes(query))) continue;
        if (skipped++ < offset) continue;
        reports.push({ id: row.id, title: row.title || "Отчёт", issueUrl: row.issue_url, environment: row.environment || "", overallStatus: row.overall_status || "", createdAt: row.created_at });
        if (reports.length > limit) break;
      }
      const nextOffset = reports.length > limit ? offset + limit : null;
      sendJson(response, 200, { ok: true, project: { projectKey: key.project_key, trackerUrl: key.tracker_url, provider: key.provider },
        canReply: Boolean(key.can_reply), expiresAt: key.expires_at, reports: reports.slice(0, limit), nextOffset });
    } else {
      if (url.search || !((request.method === "GET" && match[3] !== "/answers") || (request.method === "POST" && match[3] === "/answers" && key.can_reply))) fail(403, "Проектный ключ не разрешает это действие.");
      const proxy = Object.create(request);
      proxy[delegated] = { id: key.id, hash: digest(token) };
      proxy.url = `/api/shared-reports/${match[2]}${match[3] || ""}`;
      proxy[Symbol.asyncIterator] = request[Symbol.asyncIterator].bind(request);
      await reportSharing(proxy, response, proxy.url);
      if (request.method === "POST") audit(request, response, "project_mcp_answer", { email: key.author_id });
    }
    db().prepare("UPDATE shared_report_project_keys SET last_used_at = ? WHERE id = ?").run(now(), key.id);
    return true;
  }
  return { browser, machine, authorize, projects };
}
module.exports = { createProjectMcpAccess, projectOf };
