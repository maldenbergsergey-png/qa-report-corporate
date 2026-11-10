"use strict";
const { randomBytes, createHash } = require("node:crypto");
const TrackerLinks = require("./tracker-links");
const { initializeSharing } = require("./report-sharing");
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const api = "/api/mcp/personal", management = api + "-tokens", workspaceApi = api + "-workspaces";
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const maxTokens = 3, workspaceTtl = 30000;
function createPersonalMcpAccess({ getDb, readJson, sendJson, requestOrigin, authenticateOwner, validateWrite, localImportService, audit = () => {}, now = Date.now }) {
  let initialized;
  const workspaces = new Map(), rates = new Map();
  function db() {
    const value = getDb();
    if (initialized !== value) {
      initializeSharing(value);
      value.exec(`CREATE TABLE IF NOT EXISTS personal_mcp_tokens (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        can_write INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER
      ); CREATE INDEX IF NOT EXISTS personal_mcp_owner ON personal_mcp_tokens(owner_id, created_at);`);
      initialized = value;
    }
    return value;
  }
  const safe = row => ({ id: row.id, label: row.label, canWrite: Boolean(row.can_write), createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at });
  const activeSql = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
  const keys = owner => db().prepare(`SELECT * FROM personal_mcp_tokens WHERE owner_id=? ORDER BY (${activeSql}) DESC, created_at DESC LIMIT 100`).all(owner, now()).map(safe);
  function removeWorkspace(workspace) {
    for (const id of workspace.sessions.values()) localImportService.closeForAccount(workspace.owner, id);
    workspaces.delete(workspace.id);
  }
  function cleanup() { for (const value of workspaces.values()) if (value.expiresAt <= now()) removeWorkspace(value); }
  function catalog(input) {
    if (!Array.isArray(input) || input.length > 1000) fail(400, "Список браузера содержит до 1000 чек-листов.");
    const ids = new Set();
    return input.map(item => {
      if (!item || !idPattern.test(item.id) || !/^[a-f0-9]{7,8}$/.test(item.publicId) || ids.has(item.id)) fail(400, "Некорректный чек-лист браузера.");
      ids.add(item.id);
      const text = (name, max) => typeof item[name] === "string" && item[name].length <= max ? item[name] : "";
      const aliases = Array.isArray(item.aliases) && item.aliases.length <= 30 ? item.aliases.filter(value => typeof value === "string" && /^\/(?:shared-report\/[a-f0-9]{32}|cloud-report\/[a-f0-9-]{36})$/.test(value)) : [];
      return { id: item.id, publicId: item.publicId, title: text("title", 500), issueUrl: text("issueUrl", 4096), issueKey: text("issueKey", 200) || TrackerLinks.parse(text("issueUrl", 4096))?.key || "", environment: text("environment", 500), updatedAt: text("updatedAt", 80), aliases };
    });
  }
  function workspaceView(workspace) {
    const pendingReports = [];
    for (const [reportId, id] of workspace.sessions) {
      const session = localImportService.forAccount(workspace.owner, id);
      if (session && [...session.batches.values()].some(item => item.status === "pending")) pendingReports.push(reportId);
    }
    return { commands: [...workspace.commands.values()].filter(item => !item.sessionId && !item.error).map(item => ({ id: item.id, reportId: item.reportId })), pendingReports, expiresAt: workspace.expiresAt };
  }
  async function browser(request, response, pathname) {
    if (pathname !== management && !new RegExp("^" + management + "/[a-f0-9]{32}$").test(pathname) && pathname !== workspaceApi && !new RegExp("^" + workspaceApi + "/[a-f0-9]{32}(?:/ack)?$").test(pathname)) return false;
    if (request.headers.origin && request.headers.origin !== requestOrigin(request)) fail(403, "Запрос с другого сайта отклонён.");
    const owner = await authenticateOwner(request);
    if (!owner) fail(401, "Войдите в свой профиль QA Report.");
    if (request.method !== "GET") validateWrite(request);
    if (pathname === management && request.method === "GET") { sendJson(response, 200, { ownerId: owner, keys: keys(owner), maxTokens }); return true; }
    if (pathname === management && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!body || Object.keys(body).some(name => !["label", "lifetimeDays", "readOnly"].includes(name)) || typeof body.label !== "string" || !body.label.trim() || body.label.length > 100 || /[\x00-\x1f\x7f]/.test(body.label) || ![30, 90, 365, null].includes(body.lifetimeDays) || typeof body.readOnly !== "boolean") fail(400, "Укажите название, срок и разрешения токена.");
      if (db().prepare(`SELECT count(*) AS n FROM personal_mcp_tokens WHERE owner_id=? AND ${activeSql}`).get(owner, now()).n >= maxTokens) fail(429, "Можно иметь до трёх активных личных токенов. Отзовите неиспользуемый.");
      const id = randomBytes(16).toString("hex"), token = randomBytes(32).toString("base64url"), created = now();
      db().prepare("INSERT INTO personal_mcp_tokens (id,owner_id,label,token_hash,can_write,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(id, owner, body.label.trim(), digest(token), body.readOnly ? 0 : 1, created, body.lifetimeDays === null ? null : created + body.lifetimeDays * 86400000);
      audit(request, response, "personal_mcp_token_created", { email: owner });
      sendJson(response, 201, { key: safe(db().prepare("SELECT * FROM personal_mcp_tokens WHERE id=?").get(id)), connection: { url: requestOrigin(request) + api, token } }); return true;
    }
    if (pathname.startsWith(management + "/") && request.method === "DELETE") {
      if (!db().prepare("UPDATE personal_mcp_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND owner_id=?").run(now(), pathname.split("/").pop(), owner).changes) fail(404, "Токен недоступен.");
      audit(request, response, "personal_mcp_token_revoked", { email: owner }); sendJson(response, 200, { ok: true }); return true;
    }
    if (pathname.startsWith(workspaceApi + "/") && !pathname.endsWith("/ack") && request.method === "GET") {
      cleanup(); const workspace = workspaces.get(pathname.split("/").pop());
      if (!workspace || workspace.owner !== owner) fail(404, "Вкладка отключена. Подключите её заново.");
      workspace.expiresAt = now() + workspaceTtl;
      for (const [id, command] of workspace.commands) if (command.expiresAt <= now()) workspace.commands.delete(id);
      sendJson(response, 200, workspaceView(workspace)); return true;
    }
    if (pathname.startsWith(workspaceApi) && request.method === "POST") {
      cleanup(); const body = await readJson(request, 2 * 1024 * 1024);
      if (pathname === workspaceApi) {
        if (workspaces.size >= 128 || [...workspaces.values()].filter(item => item.owner === owner).length >= 5) fail(429, "Отключите другую вкладку MCP: доступно до пяти вкладок.");
        const id = randomBytes(16).toString("hex");
        workspaces.set(id, { id, owner, catalog: catalog(body.catalog), expiresAt: now() + workspaceTtl, commands: new Map(), sessions: new Map() });
        sendJson(response, 201, { id, expiresAt: now() + workspaceTtl }); return true;
      }
      const id = pathname.slice(workspaceApi.length + 1).split("/")[0], workspace = workspaces.get(id);
      if (!workspace || workspace.owner !== owner) fail(404, "Вкладка отключена. Подключите её заново.");
      if (pathname.endsWith("/ack")) {
        const command = workspace.commands.get(body.commandId);
        if (!command) fail(404, "Запрос уже завершён.");
        const session = localImportService.forAccount(owner, body.sessionId);
        if (body.error) command.error = "Не удалось открыть чек-лист в браузере. Проверьте вкладку и повторите запрос.";
        else if (!session || session.reportId !== command.reportId) fail(403, "Сессия не относится к этому чек-листу и аккаунту.");
        else { command.sessionId = session.id; workspace.sessions.set(command.reportId, session.id); }
        sendJson(response, 200, { ok: true }); return true;
      }
      workspace.catalog = catalog(body.catalog); workspace.expiresAt = now() + workspaceTtl;
      for (const [id, command] of workspace.commands) if (command.expiresAt <= now()) workspace.commands.delete(id);
      sendJson(response, 200, workspaceView(workspace)); return true;
    }
    if (pathname.startsWith(workspaceApi + "/") && request.method === "DELETE") {
      const workspace = workspaces.get(pathname.split("/").pop());
      if (workspace && workspace.owner === owner) removeWorkspace(workspace);
      sendJson(response, 200, { ok: true }); return true;
    }
    fail(405, "Метод не поддерживается.");
  }
  function token(request) {
    const legacy = request.headers.authorization;
    const secret = request.headers["x-qa-personal-token"] ?? legacy?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret) || (legacy && legacy !== "Bearer " + secret)) fail(401, "Нужен личный токен MCP.");
    const row = db().prepare(`SELECT * FROM personal_mcp_tokens WHERE token_hash=? AND ${activeSql}`).get(digest(secret), now());
    if (!row) fail(401, "Личный токен отозван или истёк.");
    return row;
  }
  function targetPath(value, origin) {
    let url; try { url = new URL(value, origin); } catch { fail(400, "Укажите ссылку на чек-лист QA Report."); }
    if (url.origin !== origin || url.username || url.password || url.search || !/^\/(?:report\/[a-f0-9]{7,8}|shared-report\/[a-f0-9]{32}|cloud-report\/[a-f0-9-]{36})$/.test(url.pathname)) fail(400, "Укажите ссылку на чек-лист этого QA Report.");
    return url.pathname;
  }
  function saved(owner, path) {
    if (path.startsWith("/shared-report/")) {
      const row = db().prepare("SELECT * FROM shared_publications WHERE id=? AND author_id=? AND update_of IS NULL AND COALESCE(published_at,ready_at) IS NOT NULL AND revoked_at IS NULL").get(path.split("/").pop(), owner);
      if (row) return { reportId: row.id, source: "published", context: JSON.parse(row.snapshot_json), writable: false };
    }
    if (path.startsWith("/cloud-report/") && db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_cloud_reports'").get()) {
      const row = db().prepare("SELECT * FROM personal_cloud_reports WHERE id=? AND owner_id=? AND revision>0").get(path.split("/").pop(), owner);
      if (row) return { reportId: row.id, source: "cloud", context: JSON.parse(row.document_json), writable: false };
    }
    return null;
  }
  function* reports(owner, origin) {
    cleanup();
    for (const workspace of workspaces.values()) if (workspace.owner === owner) for (const item of workspace.catalog) yield { ...item, aliases: undefined, source: "browser", browserId: workspace.id, url: origin + "/report/" + item.publicId, available: true };
    for (const item of db().prepare(`SELECT id, json_extract(snapshot_json,'$.title') AS title,
      json_extract(snapshot_json,'$.issueUrl') AS issueUrl, json_extract(snapshot_json,'$.environment') AS environment,
      COALESCE(published_update_at,published_at,ready_at,created_at) AS updatedAt FROM shared_publications
      WHERE author_id=? AND update_of IS NULL AND COALESCE(published_at,ready_at) IS NOT NULL AND revoked_at IS NULL
      ORDER BY updatedAt DESC,id DESC`).iterate(owner)) yield { ...item, issueKey: TrackerLinks.parse(item.issueUrl)?.key || "", source: "published", url: origin + "/shared-report/" + item.id, available: true };
    if (db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_cloud_reports'").get()) for (const item of db().prepare(`SELECT id,title,
      json_extract(document_json,'$.issueUrl') AS issueUrl,json_extract(document_json,'$.environment') AS environment,
      updated_at AS updatedAt FROM personal_cloud_reports WHERE owner_id=? AND revision>0 ORDER BY updated_at DESC,id DESC`).iterate(owner)) yield { ...item, issueKey: TrackerLinks.parse(item.issueUrl)?.key || "", source: "cloud", url: origin + "/cloud-report/" + item.id, available: true };
  }
  async function resolve(owner, path, browserId) {
    cleanup(); const matches = [];
    for (const workspace of workspaces.values()) if (workspace.owner === owner && (!browserId || workspace.id === browserId)) for (const item of workspace.catalog) if (path === "/report/" + item.publicId || item.aliases.includes(path)) matches.push({ workspace, item });
    if (matches.length > 1) fail(409, "Чек-лист открыт в нескольких браузерах. Выберите browserId из списка MCP.");
    if (!matches.length) return null;
    const { workspace, item } = matches[0];
    let session = localImportService.forAccount(owner, workspace.sessions.get(item.id));
    if (session) return { session, workspace };
    if (workspace.commands.size >= 8) fail(429, "Дождитесь открытия предыдущих чек-листов.");
    const command = { id: randomBytes(16).toString("hex"), reportId: item.id, expiresAt: now() + 15000 };
    workspace.commands.set(command.id, command);
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (workspace.expiresAt <= now() || !workspaces.has(workspace.id)) fail(409, "Подключённая вкладка недоступна.");
        if (command.error) fail(409, command.error);
        if (command.sessionId) { session = localImportService.forAccount(owner, command.sessionId); if (session) return { session, workspace }; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      fail(409, "Вкладка не ответила. Откройте QA Report и повторите запрос.");
    } finally { workspace.commands.delete(command.id); }
  }
  async function machine(request, response, pathname) {
    if (!pathname.startsWith(api + "/")) return false;
    if (request.headers.origin && request.headers.origin !== requestOrigin(request)) fail(403, "Запрос с другого сайта отклонён.");
    const time = now(), ip = request.socket?.remoteAddress || "unknown";
    if (rates.size > 1000) for (const [id, value] of rates) if (time - value.start >= 60000) rates.delete(id);
    const rate = rates.get(ip) || { start: time, count: 0 };
    if (time - rate.start >= 60000) { rate.start = time; rate.count = 0; }
    if (++rate.count > 240 || rates.size > 2000) fail(429, "Слишком много запросов MCP."); rates.set(ip, rate);
    const key = token(request), origin = requestOrigin(request), url = new URL(request.url, origin);
    const verify = () => { const current = db().prepare(`SELECT * FROM personal_mcp_tokens WHERE id=? AND token_hash=? AND ${activeSql}`).get(key.id, key.token_hash, now()); if (!current) fail(401, "Токен недоступен."); return current; };
    if (pathname === api + "/reports" && request.method === "GET") {
      if ([...url.searchParams.keys()].some(name => !["query", "offset", "limit"].includes(name))) fail(400, "Неизвестный параметр поиска.");
      const query = (url.searchParams.get("query") || "").trim().toLowerCase(), offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 25);
      if (query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, "Некорректный поиск.");
      const list = []; let skipped = 0;
      for (const item of reports(key.owner_id, origin)) {
        if (query && !`${item.title || ""} ${item.issueUrl || ""} ${item.issueKey || ""}`.toLowerCase().includes(query)) continue;
        if (skipped++ < offset) continue;
        list.push(item); if (list.length > limit) break;
      }
      sendJson(response, 200, { reports: list.slice(0, limit), nextOffset: list.length > limit ? offset + limit : null });
    } else {
      const match = pathname.match(/^\/api\/mcp\/personal\/report\/(context|files\/[a-zA-Z0-9_-]{1,80}|batches(?:\/[a-zA-Z0-9_-]{1,80})?)$/);
      if (!match || url.search) fail(404, "Операция MCP недоступна.");
      if (!(request.method === "GET" && (match[1] === "context" || match[1].startsWith("batches/")) || request.method === "POST" && match[1] === "batches" || request.method === "PUT" && match[1].startsWith("files/"))) fail(405, "Метод не поддерживается.");
      if (request.method !== "GET" && !key.can_write) fail(403, "Личный токен разрешает только чтение.");
      const path = targetPath(String(request.headers["x-qa-report-url"] || ""), origin);
      const serverReport = saved(key.owner_id, path);
      // A publication/cloud alias must belong to this account even when a browser advertises it.
      if (!path.startsWith("/report/") && !serverReport) fail(404, "Чек-лист не принадлежит этому аккаунту.");
      const resolved = await resolve(key.owner_id, path, String(request.headers["x-qa-browser-id"] || "")); verify();
      if (!resolved) {
        if (serverReport && match[1] === "context" && request.method === "GET") sendJson(response, 200, { ...serverReport, expiresAt: key.expires_at || 8640000000000000, note: "Сохранённая версия доступна для чтения. Для заполнения откройте исходный чек-лист в подключённом браузере." });
        else fail(409, "Для заполнения подключите браузер в разделе MCP-сервер и откройте нужный чек-лист.");
      } else {
        const { session, workspace } = resolved;
        const proxy = Object.create(request); proxy.url = `/api/local-import/agent/${session.id}/${match[1]}`;
        proxy.headers = { ...request.headers, "x-qa-import-token": session.producerToken };
        proxy[Symbol.asyncIterator] = request[Symbol.asyncIterator].bind(request);
        const writing = request.method !== "GET";
        const guard = () => { const current = verify(); if (!workspaces.has(workspace.id) || workspace.expiresAt <= now() || (writing && !current.can_write)) fail(403, "Доступ к вкладке или запись отключены."); };
        guard(); await localImportService.producer(proxy, response, origin, guard);
        if (request.method !== "GET") audit(request, response, "personal_mcp_write", { email: key.owner_id });
      }
    }
    db().prepare("UPDATE personal_mcp_tokens SET last_used_at=? WHERE id=?").run(now(), key.id); return true;
  }
  return { browser, machine };
}
module.exports = { createPersonalMcpAccess };
