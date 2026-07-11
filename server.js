const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { parseJiraMarkup } = require("./jira-markup-import");

const ROOT = __dirname;

function loadLocalEnv() {
  const envPath = path.join(ROOT, ".env");
  try {
    const source = fs.readFileSync(envPath, "utf8");
    source.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) return;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Не удалось прочитать .env: ${error.message}`);
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_ORIGIN =
  process.env.QA_REPORT_PUBLIC_URL || process.env.APP_PUBLIC_URL || process.env.PUBLIC_URL || "";
function readSizeMb(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) * 1024 * 1024 : fallback * 1024 * 1024;
}

const MAX_BODY = readSizeMb("QA_REPORT_MAX_BODY_MB", 150);
const MAX_ATTACHMENT_FILE = readSizeMb("QA_REPORT_MAX_ATTACHMENT_MB", 50);
const STORE_REPORT_ATTACHMENTS = process.env.QA_REPORT_STORE_ATTACHMENTS === "true";
const APP_VERSION = "0.2.2";
const API_REVISION = 5;
const REPORTS_DB_PATH = process.env.REPORTS_DB_PATH || path.join(ROOT, "reports-data", "qa-report.sqlite");
const OBJECT_STORAGE_ENDPOINT = String(process.env.QA_STORAGE_ENDPOINT || "https://minio-buckets.adv.ru").replace(/\/+$/, "");
const OBJECT_STORAGE_BUCKET = String(process.env.QA_STORAGE_BUCKET || "qa-tools").trim();
const OBJECT_STORAGE_REGION = String(process.env.QA_STORAGE_REGION || "us-east-1").trim();
const CHECKLIST_IMPORT_TTL_MS = 15 * 60 * 1000;
const checklistImports = new Map();
const apiRateLimit = new Map();
let reportsDb;

function readSecret(name) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try { return fs.readFileSync(filePath, "utf8").trim(); }
    catch (error) { if (error.code !== "ENOENT") console.warn(`Не удалось прочитать ${name}_FILE: ${error.message}`); }
  }
  return String(process.env[name] || "").trim();
}

function objectStorageCredentials() {
  return {
    accessKey: readSecret("QA_STORAGE_ACCESS_KEY"),
    secretKey: readSecret("QA_STORAGE_SECRET_KEY"),
  };
}

function objectStorageConfigured() {
  const credentials = objectStorageCredentials();
  return Boolean(OBJECT_STORAGE_ENDPOINT && OBJECT_STORAGE_BUCKET && credentials.accessKey && credentials.secretKey);
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function s3ObjectPath(key) {
  return `/${encodeURIComponent(OBJECT_STORAGE_BUCKET)}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

async function s3Request(method, key, { body, contentType = "application/octet-stream" } = {}) {
  const { accessKey, secretKey } = objectStorageCredentials();
  if (!accessKey || !secretKey) {
    const error = new Error("Корпоративное файловое хранилище не настроено");
    error.status = 503;
    throw error;
  }
  const endpoint = new URL(OBJECT_STORAGE_ENDPOINT);
  const pathname = s3ObjectPath(key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payload = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const headers = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (body != null) headers["content-type"] = contentType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = [method, pathname, "", canonicalHeaders, signedHeaderNames.join(";"), payloadHash].join("\n");
  const scope = `${date}/${OBJECT_STORAGE_REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, OBJECT_STORAGE_REGION);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const response = await fetch(new URL(pathname, endpoint), {
    method,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
    },
    ...(body == null ? {} : { body: payload }),
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    const error = new Error(`Хранилище вернуло HTTP ${response.status}${details ? `: ${details}` : ""}`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response;
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; media-src 'self' data: https:",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ ...payload, appVersion: APP_VERSION, apiRevision: API_REVISION }));
}

function applySecurityHeaders(response) {
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => response.setHeader(name, value));
}

function enforceSameOrigin(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const fetchSite = firstHeaderValue(request, "sec-fetch-site");
  if (fetchSite === "cross-site") {
    const error = new Error("Запрос с другого сайта запрещён");
    error.status = 403;
    throw error;
  }
  const origin = normalizeOrigin(firstHeaderValue(request, "origin"));
  if (origin && origin !== normalizeOrigin(requestOrigin(request))) {
    const error = new Error("Источник запроса не разрешён");
    error.status = 403;
    throw error;
  }
}

function enforceApiRateLimit(request, requestPath) {
  if (!requestPath.startsWith("/api/") || requestPath === "/api/health") return;
  const now = Date.now();
  const key = request.socket.remoteAddress || "unknown";
  const recent = (apiRateLimit.get(key) || []).filter((timestamp) => now - timestamp < 60_000);
  const limit = request.method === "GET" ? 180 : 60;
  if (recent.length >= limit) {
    const error = new Error("Слишком много запросов. Повторите позже");
    error.status = 429;
    throw error;
  }
  recent.push(now);
  apiRateLimit.set(key, recent);
  if (apiRateLimit.size > 1000) {
    for (const [address, timestamps] of apiRateLimit) {
      if (!timestamps.some((timestamp) => now - timestamp < 60_000)) apiRateLimit.delete(address);
    }
  }
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return "";
  }
}

function firstHeaderValue(request, name) {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function forwardedHeaderParts(request) {
  const forwarded = firstHeaderValue(request, "forwarded").split(",")[0];
  if (!forwarded) return {};
  return Object.fromEntries(
    forwarded
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key.toLowerCase(), value.replace(/^"|"$/g, "")]),
  );
}

function requestOrigin(request) {
  const configuredOrigin = normalizeOrigin(PUBLIC_ORIGIN);
  if (configuredOrigin) return configuredOrigin;

  const forwarded = forwardedHeaderParts(request);
  const proto = firstHeaderValue(request, "x-forwarded-proto") || forwarded.proto || "http";
  let host = firstHeaderValue(request, "x-forwarded-host") || forwarded.host || firstHeaderValue(request, "host");
  const port = firstHeaderValue(request, "x-forwarded-port");
  if (host && port && !host.includes(":")) host = `${host}:${port}`;
  host ||= `${HOST}:${PORT}`;
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Запрос слишком большой");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cleanupChecklistImports() {
  const now = Date.now();
  for (const [id, item] of checklistImports) {
    if (item.expiresAt <= now) checklistImports.delete(id);
  }
}

function getReportsDb() {
  if (reportsDb) return reportsDb;
  fs.mkdirSync(path.dirname(REPORTS_DB_PATH), { recursive: true });
  reportsDb = new DatabaseSync(REPORTS_DB_PATH);
  reportsDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT NOT NULL,
      owner_source TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_label TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      issue_url TEXT NOT NULL DEFAULT '',
      issue_key TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL DEFAULT '',
      overall_status TEXT NOT NULL DEFAULT '',
      schema_version INTEGER NOT NULL DEFAULT 3,
      public_id TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      history_comment TEXT NOT NULL DEFAULT '',
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (owner_source, owner_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_reports_owner_updated
      ON reports(owner_source, owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_workspace_updated
      ON reports(workspace_id, updated_at DESC);
  `);
  const columns = reportsDb.prepare("PRAGMA table_info(reports)").all().map((column) => column.name);
  if (!columns.includes("content_hash")) {
    reportsDb.exec("ALTER TABLE reports ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("history_comment")) {
    reportsDb.exec("ALTER TABLE reports ADD COLUMN history_comment TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.includes("public_id")) {
    reportsDb.exec("ALTER TABLE reports ADD COLUMN public_id TEXT NOT NULL DEFAULT ''");
  }
  reportsDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_owner_public_id
      ON reports(owner_source, owner_id, public_id)
      WHERE public_id <> '';
  `);
  return reportsDb;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function generatePublicId() {
  return crypto.randomBytes(4).toString("hex");
}

function normalizePublicId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 8);
}

function ensurePublicId(owner, preferred = "", currentId = "") {
  const db = getReportsDb();
  let publicId = normalizePublicId(preferred);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!publicId || publicId.length < 7) publicId = generatePublicId();
    const row = db
      .prepare(
        "SELECT id FROM reports WHERE owner_source = ? AND owner_id = ? AND public_id = ? LIMIT 1",
      )
      .get(owner.source, owner.id, publicId);
    if (!row || row.id === currentId) return publicId;
    publicId = "";
  }
  return crypto.randomBytes(5).toString("hex").slice(0, 8);
}

function normalizedReportContent(document) {
  const copy = JSON.parse(JSON.stringify(document || {}));
  delete copy.revision;
  delete copy.updatedAt;
  delete copy.lastSavedBy;
  delete copy.lastSavedClientId;
  delete copy.tabId;
  delete copy.clientId;
  delete copy.browserId;
  delete copy.selectedCell;
  delete copy.focus;
  delete copy.scroll;
  delete copy.syncTimestamps;
  return copy;
}

function reportContentHash(document) {
  return stableHash(JSON.stringify(normalizedReportContent(document)));
}

function stripReportAttachmentsFromHtml(value) {
  return String(value || "")
    .replace(/<figure\b[^>]*class=(["'])[^"']*\bcell-image\b[^"']*\1[^>]*>[\s\S]*?<img\b[^>]*src=(["'])data:[\s\S]*?\2[^>]*>[\s\S]*?<\/figure>/gi, "")
    .replace(/<figure\b[^>]*class=(["'])[^"']*\bcell-file\b[^"']*\1[^>]*data-data-url=(["'])data:[\s\S]*?\2[^>]*>[\s\S]*?<\/figure>/gi, "")
    .replace(/<img\b[^>]*src=(["'])data:[\s\S]*?\1[^>]*>/gi, "")
    .replace(/\s(?:src|href)=("|')data:[\s\S]*?\1/gi, "");
}

function stripDangerousReportHtml(value) {
  return String(value || "")
    .replace(/<(script|style|iframe|object|embed|meta|link|base)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript):[\s\S]*?\2/gi, "")
    .replace(/\s+(href|src)\s*=\s*([^\s>]*(?:javascript|vbscript):[^\s>]*)/gi, "");
}

function sanitizeReportDocumentForServer(document) {
  const copy = JSON.parse(JSON.stringify(document || {}));
  if (typeof copy.intro === "string") {
    copy.intro = stripDangerousReportHtml(copy.intro);
    if (!STORE_REPORT_ATTACHMENTS) copy.intro = stripReportAttachmentsFromHtml(copy.intro);
  }
  for (const section of copy.sections || []) {
    for (const row of section.rows || []) {
      for (const [columnId, value] of Object.entries(row.cells || {})) {
        row.cells[columnId] = stripDangerousReportHtml(value);
        if (!STORE_REPORT_ATTACHMENTS) row.cells[columnId] = stripReportAttachmentsFromHtml(row.cells[columnId]);
      }
    }
  }
  return copy;
}

function firstHeader(request, names) {
  for (const name of names) {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value) && value[0]) return String(value[0]).trim();
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeIdentityPart(value, fallback = "") {
  return String(value || fallback)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 300);
}

function resolveReportOwner(request) {
  const ssoValue = normalizeIdentityPart(
    firstHeader(request, [
      "x-forwarded-email",
      "x-auth-request-email",
      "x-forwarded-user",
      "x-auth-request-user",
      "remote-user",
    ]),
  );
  if (ssoValue) {
    return {
      source: "sso",
      id: ssoValue.toLowerCase(),
      label: ssoValue,
      workspaceId: "sso",
    };
  }

  const workspaceKey = normalizeIdentityPart(firstHeader(request, ["x-qa-report-workspace-key"]));
  if (workspaceKey) {
    const workspaceHash = stableHash(workspaceKey).slice(0, 32);
    return {
      source: "workspace-key",
      id: workspaceHash,
      label: "Ключ пространства",
      workspaceId: `workspace:${workspaceHash}`,
    };
  }

  const clientId = normalizeIdentityPart(firstHeader(request, ["x-qa-report-client-id"]));
  if (clientId) {
    return {
      source: "browser",
      id: clientId.slice(0, 120),
      label: "Этот браузер",
      workspaceId: `browser:${clientId.slice(0, 120)}`,
    };
  }

  const anonymousId = stableHash(request.socket.remoteAddress || "anonymous").slice(0, 32);
  return {
    source: "anonymous",
    id: anonymousId,
    label: "Анонимный доступ",
    workspaceId: `anonymous:${anonymousId}`,
  };
}

function issueKeyFromUrl(value) {
  try {
    return new URL(String(value || "")).pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i)?.[1]?.toUpperCase() || "";
  } catch {
    return "";
  }
}

function reportRecordFromRow(row, includeDocument = false) {
  const record = {
    id: row.id,
    publicId: row.public_id || "",
    ownerSource: row.owner_source,
    ownerLabel: row.owner_label,
    workspaceId: row.workspace_id,
    title: row.title,
    issueUrl: row.issue_url,
    issueKey: row.issue_key,
    environment: row.environment,
    overallStatus: row.overall_status,
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
    historyComment: row.history_comment || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    reason: row.reason,
    source: "server",
  };
  if (includeDocument) {
    record.document = sanitizeReportDocumentForServer(JSON.parse(row.document_json));
    if (record.publicId) record.document.publicId = record.publicId;
  }
  return record;
}

function assertReportDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    const error = new Error("Поле document должно быть JSON-объектом отчёта");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(document.sections)) {
    const error = new Error("В document.sections должен быть список разделов");
    error.status = 400;
    throw error;
  }
}

function normalizeConnection(input) {
  const type = input.type === "cloud" ? "cloud" : "data-center";
  const baseUrl = new URL(input.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("Поддерживаются только http:// и https:// адреса Jira");
  }
  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.hash = "";
  baseUrl.search = "";
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  const token = String(input.token || "");
  const user = String(input.user || "");
  const authMethod =
    type === "cloud" ? "api-token" : input.authMethod === "basic" || input.authMethod === "cookie" ? input.authMethod : "pat";
  if (!token) throw new Error(authMethod === "basic" ? "Пароль не указан" : authMethod === "cookie" ? "Cookie не указан" : "Токен не указан");
  if ((type === "cloud" || authMethod === "basic") && !user) {
    throw new Error(type === "cloud" ? "Email Atlassian не указан" : "Логин Jira не указан");
  }
  return { type, authMethod, baseUrl: baseUrl.toString().replace(/\/$/, ""), token, user };
}

function authHeaders(connection) {
  if (connection.authMethod === "cookie") {
    return { Cookie: connection.token };
  }
  if (connection.type === "cloud" || connection.authMethod === "basic") {
    const credentials = Buffer.from(`${connection.user}:${connection.token}`).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }
  return { Authorization: `Bearer ${connection.token}` };
}

async function jiraFetch(connection, pathname, options = {}) {
  const { returnMeta = false, ...fetchOptions } = options;
  const isFormData = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;
  const targetUrl = `${connection.baseUrl}${pathname}`;
  let response;
  try {
    response = await fetch(targetUrl, {
      ...fetchOptions,
      headers: {
        Accept: "application/json",
        ...authHeaders(connection),
        ...(fetchOptions.body && !isFormData ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.headers || {}),
      },
    });
  } catch (fetchError) {
    const reason = fetchError.cause?.message || fetchError.message || "неизвестная ошибка сети";
    const error = new Error(
      `Не удалось подключиться к Jira ${connection.baseUrl}: ${reason}. ` +
        "Проверьте, что Node-сервер приложения видит Jira: VPN, DNS, корпоративный proxy и TLS-сертификаты.",
    );
    error.status = 502;
    error.code = fetchError.cause?.code || fetchError.code || "JIRA_FETCH_FAILED";
    error.pathname = pathname;
    error.targetUrl = targetUrl;
    throw error;
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const looksLikeHtml =
    /text\/html/i.test(contentType) ||
    /^\s*(?:<!doctype\s+html|<html|<head|<noscript)\b/i.test(text);
  if (looksLikeHtml) {
    const challengePath =
      text.match(/url\s*=\s*([^"'<>\s]+)/i)?.[1] ||
      text.match(/location(?:\.href)?\s*=\s*["']([^"']+)/i)?.[1] ||
      "";
    const error = new Error(
      "Корпоративный шлюз безопасности вернул HTML-проверку вместо Jira REST API" +
        `${challengePath ? ` (переход ${challengePath})` : ""}. ` +
        "Запрос с PAT не дошёл до Jira. Администратору необходимо разрешить IP сервера приложения " +
        "или отключить browser challenge для /rest/api/* при авторизации через Authorization header.",
    );
    error.status = 502;
    error.code = "JIRA_SECURITY_CHALLENGE";
    error.pathname = pathname;
    throw error;
  }
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    const details =
      payload.errorMessages?.join("; ") ||
      Object.values(payload.errors || {}).join("; ") ||
      payload.message ||
      response.statusText;
    const error = new Error(`Jira вернула ${response.status}: ${details}`);
    error.status = response.status;
    throw error;
  }
  if (returnMeta) {
    return {
      payload,
      status: response.status,
      location: response.headers.get("location") || "",
      contentType: response.headers.get("content-type") || "",
      rawText: text,
    };
  }
  return payload;
}

function commentIdFromReference(value) {
  const text = String(value || "");
  return text.match(/\/comment\/(\d+)(?:[/?#]|$)/i)?.[1] || "";
}

async function readRecentComments(connection, commentPath) {
  const first = await jiraFetch(connection, `${commentPath}?maxResults=100`);
  const firstComments = Array.isArray(first.comments) ? first.comments : [];
  const total = Number(first.total);
  if (Number.isFinite(total) && total > firstComments.length) {
    const startAt = Math.max(0, total - 100);
    const last = await jiraFetch(
      connection,
      `${commentPath}?startAt=${startAt}&maxResults=100`,
    );
    return {
      total: Number.isFinite(Number(last.total)) ? Number(last.total) : total,
      comments: Array.isArray(last.comments) ? last.comments : firstComments,
    };
  }
  return {
    total: Number.isFinite(total) ? total : firstComments.length,
    comments: firstComments,
  };
}

function parseIssueReference(connection, rawUrl) {
  let issueUrl;
  try {
    issueUrl = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Некорректная ссылка Jira");
  }
  const jiraBase = new URL(connection.baseUrl);
  if (issueUrl.origin !== jiraBase.origin) {
    throw new Error("Ссылка относится к другому адресу Jira");
  }
  const issueMatch = issueUrl.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/i);
  const issueKey = issueMatch?.[1]?.toUpperCase() || "";
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
    throw new Error("В ссылке не найден ключ задачи Jira");
  }
  return { issueUrl, issueKey };
}

function parseCommentId(commentUrl) {
  const candidates = [
    commentUrl.searchParams.get("focusedCommentId"),
    commentUrl.searchParams.get("commentId"),
    commentUrl.searchParams.get("selectedItem")?.match(/comment-(\d+)/i)?.[1],
    commentUrl.hash.match(/comment-(\d+)/i)?.[1],
    commentUrl.hash.match(/comment-(\d+)/i)?.[1],
  ];
  const commentId = candidates.find((value) => /^\d+$/.test(String(value || "")));
  if (!commentId) throw new Error("В ссылке не найден идентификатор комментария");
  return String(commentId);
}

function sanitizeAttachmentName(name, mimeType, index) {
  const extensionByType = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const expectedExtension = extensionByType[mimeType] || ".bin";
  const raw = path.basename(String(name || `image-${index + 1}${expectedExtension}`));
  const safeBase = raw
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const currentExtension = path.extname(safeBase).toLowerCase();
  const baseWithoutExtension = currentExtension ? safeBase.slice(0, -currentExtension.length) : safeBase;
  return `${baseWithoutExtension || `image-${index + 1}`}${expectedExtension}`;
}

function sanitizeGenericAttachmentName(name, index) {
  const raw = path.basename(String(name || `file-${index + 1}.bin`));
  const safe = raw
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return safe || `file-${index + 1}.bin`;
}

function detectImageMime(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

function formatLimitMb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

function decodeImageFile(file, index) {
  const base64 = String(file.dataBase64 || "")
    .replace(/^data:[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error(`Файл «${file.name || index + 1}» содержит некорректные base64-данные`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error(`Файл «${file.name || index + 1}» пустой`);
  if (bytes.length > MAX_ATTACHMENT_FILE) {
    throw new Error(`Файл «${file.name || index + 1}» больше ${formatLimitMb(MAX_ATTACHMENT_FILE)}`);
  }
  const detectedType = detectImageMime(bytes);
  if (!detectedType) {
    throw new Error(`Файл «${file.name || index + 1}» не распознан как PNG, JPEG, GIF или WebP`);
  }
  return {
    attachmentId: file.attachmentId,
    bytes,
    type: detectedType,
    name: sanitizeAttachmentName(file.name, detectedType, index),
  };
}

function decodeAttachmentFile(file, index) {
  const declaredType = String(file.type || "").toLowerCase();
  if (declaredType.startsWith("image/")) return { ...decodeImageFile(file, index), kind: "image" };
  const base64 = String(file.dataBase64 || "")
    .replace(/^data:[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error(`Файл «${file.name || index + 1}» содержит некорректные base64-данные`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error(`Файл «${file.name || index + 1}» пустой`);
  if (bytes.length > MAX_ATTACHMENT_FILE) {
    throw new Error(`Файл «${file.name || index + 1}» больше ${formatLimitMb(MAX_ATTACHMENT_FILE)}`);
  }
  return {
    attachmentId: file.attachmentId,
    bytes,
    type: declaredType || "application/octet-stream",
    name: sanitizeGenericAttachmentName(file.name, index),
    kind: "file",
  };
}

async function handleJiraTest(request, response) {
  const body = await readJson(request);
  const connection = normalizeConnection(body);
  const version = connection.type === "cloud" ? "3" : "2";
  const user = await jiraFetch(connection, `/rest/api/${version}/myself`);
  sendJson(response, 200, {
    ok: true,
    displayName: user.displayName,
    name: user.emailAddress || user.name || user.accountId,
  });
}

async function handleJiraComment(request, response) {
  const body = await readJson(request);
  const connection = normalizeConnection(body);
  const { issueUrl, issueKey } = parseIssueReference(connection, body.issueUrl);
  const cloud = connection.type === "cloud";
  const expectedFormat = cloud ? "adf" : "wiki";
  if (body.comment?.format !== expectedFormat || !body.comment?.body) {
    throw new Error(`Для выбранной Jira требуется формат комментария ${expectedFormat}`);
  }
  const version = cloud ? "3" : "2";
  const commentPath = `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}/comment`;
  let beforeSnapshot = { total: null, comments: [] };
  let beforeError = "";
  try {
    beforeSnapshot = await readRecentComments(connection, commentPath);
  } catch (error) {
    if (error.code === "JIRA_SECURITY_CHALLENGE") throw error;
    beforeError = error.message;
  }

  const creation = await jiraFetch(
    connection,
    commentPath,
    {
      method: "POST",
      body: JSON.stringify({ body: body.comment.body }),
      returnMeta: true,
    },
  );
  const result = creation.payload || {};
  let commentId =
    (result.id ? String(result.id) : "") ||
    commentIdFromReference(result.self) ||
    commentIdFromReference(creation.location);
  let verificationSource = "create-response";
  let afterSnapshot = { total: null, comments: [] };
  let afterError = "";

  if (!commentId) {
    try {
      afterSnapshot = await readRecentComments(connection, commentPath);
    } catch (error) {
      if (error.code === "JIRA_SECURITY_CHALLENGE") throw error;
      afterError = error.message;
    }
    const comments = afterSnapshot.comments;
    const previousIds = new Set(beforeSnapshot.comments.map((comment) => String(comment.id || "")));
    const newlyCreated = comments.filter(
      (comment) => comment.id && !previousIds.has(String(comment.id)),
    );
    const normalizeCommentBody = (value) =>
      typeof value === "string"
        ? value.replace(/\r\n/g, "\n").trim()
        : JSON.stringify(value);
    const expectedBody = normalizeCommentBody(body.comment.body);
    const candidates =
      beforeSnapshot.total === null && beforeSnapshot.comments.length === 0
        ? comments
        : newlyCreated;
    const matchingComment = [...candidates].reverse().find((comment) => {
      const actualBody = normalizeCommentBody(comment.body);
      return actualBody === expectedBody && comment.id;
    });
    const onlyNewComment = newlyCreated.length === 1 ? newlyCreated[0] : null;
    commentId = matchingComment?.id
      ? String(matchingComment.id)
      : onlyNewComment?.id
        ? String(onlyNewComment.id)
        : "";
    verificationSource = matchingComment ? "comments-body-match" : "comments-id-diff";
  }

  if (!commentId) {
    const responsePreview = creation.rawText
      ? creation.rawText.replace(/\s+/g, " ").slice(0, 300)
      : "<пустой ответ>";
    const diagnostics = [
      `POST ${commentPath}: HTTP ${creation.status}`,
      `ответ: ${responsePreview}`,
      `Location: ${creation.location || "<нет>"}`,
      `комментариев до: ${beforeSnapshot.total ?? "неизвестно"}`,
      `после: ${afterSnapshot.total ?? "неизвестно"}`,
      beforeError ? `ошибка чтения до POST: ${beforeError}` : "",
      afterError ? `ошибка чтения после POST: ${afterError}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Jira не подтвердила создание комментария. ${diagnostics}`,
    );
  }

  let verifiedComment;
  try {
    verifiedComment = await jiraFetch(
      connection,
      `${commentPath}/${encodeURIComponent(commentId)}`,
    );
  } catch (error) {
    throw new Error(
      `Комментарий получил ID ${commentId}, но контрольное чтение не удалось: ${error.message}`,
    );
  }
  if (!verifiedComment?.id || String(verifiedComment.id) !== commentId) {
    throw new Error(`Jira не подтвердила чтение созданного комментария ${commentId}`);
  }

  sendJson(response, 201, {
    ok: true,
    verified: true,
    verificationSource,
    commentId,
    issueUrl: issueUrl.toString(),
    commentUrl: `${connection.baseUrl}/browse/${encodeURIComponent(issueKey)}?focusedCommentId=${encodeURIComponent(commentId)}#comment-${encodeURIComponent(commentId)}`,
  });
}

async function handleJiraImportComment(request, response) {
  const body = await readJson(request);
  const connection = normalizeConnection(body);
  const { issueUrl, issueKey } = parseIssueReference(connection, body.commentUrl);
  const commentId = parseCommentId(issueUrl);
  const cloud = connection.type === "cloud";
  const version = cloud ? "3" : "2";
  const comment = await jiraFetch(
    connection,
    `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
  );
  let attachments = [];
  try {
    const issue = await jiraFetch(
      connection,
      `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    );
    attachments = (issue.fields?.attachment || []).map((item) => ({
      id: String(item.id),
      filename: item.filename,
      content: item.content,
      thumbnail: item.thumbnail,
      mimeType: item.mimeType,
    }));
  } catch {
    // Комментарий можно импортировать и без доступа к списку вложений.
  }
  sendJson(response, 200, {
    ok: true,
    format: cloud ? "adf" : "wiki",
    body: comment.body,
    issueUrl: `${connection.baseUrl}/browse/${encodeURIComponent(issueKey)}`,
    commentId,
    attachments,
  });
}

async function handleChecklistImport(request, response) {
  const body = await readJson(request);
  if (body.format !== "jira") {
    const error = new Error('Поддерживается только format: "jira"');
    error.status = 400;
    throw error;
  }
  if (typeof body.content !== "string" || !body.content.trim()) {
    const error = new Error("Поле content должно быть непустой строкой с Jira-разметкой");
    error.status = 400;
    throw error;
  }

  let parsed;
  try {
    parsed = parseJiraMarkup(body.content);
  } catch (parseError) {
    const error = new Error(parseError.message || "Не удалось распарсить Jira-разметку");
    error.status = 422;
    throw error;
  }

  const checklistId = crypto.randomUUID();
  const publicId = generatePublicId();
  const now = new Date().toISOString();
  checklistImports.set(checklistId, {
    id: checklistId,
    publicId,
    source: String(body.source || "").slice(0, 120),
    format: "jira",
    title: String(body.title || "").trim().slice(0, 300),
    issueKey: String(body.issueKey || "").trim().slice(0, 2000),
    content: body.content,
    createdAt: now,
    expiresAt: Date.now() + CHECKLIST_IMPORT_TTL_MS,
  });
  cleanupChecklistImports();

  const url = new URL(`/report/${publicId}`, requestOrigin(request));
  url.searchParams.set("importToken", checklistId);
  sendJson(response, 201, {
    ok: true,
    checklistId,
    publicId,
    url: url.toString(),
    expiresAt: checklistImports.get(checklistId).expiresAt,
    parsed: {
      sections: parsed.sections.length,
      rows: parsed.sections.reduce((sum, section) => sum + section.rows.length, 0),
    },
  });
}

async function handleChecklistImportPayload(request, response, checklistId) {
  cleanupChecklistImports();
  const item = checklistImports.get(checklistId);
  if (!item) {
    const error = new Error("Импорт не найден или срок действия ссылки истёк");
    error.status = 404;
    throw error;
  }
  sendJson(response, 200, {
    ok: true,
    checklistId: item.id,
    publicId: item.publicId || "",
    source: item.source,
    format: item.format,
    title: item.title,
    issueKey: item.issueKey,
    content: item.content,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  });
}

async function handleReportSave(request, response) {
  const body = await readJson(request);
  const document = sanitizeReportDocumentForServer(body.document || {});
  assertReportDocument(document);
  const owner = resolveReportOwner(request);
  const now = new Date().toISOString();
  const id = normalizeIdentityPart(body.id || document.reportId || crypto.randomUUID()).slice(0, 120);
  if (!id) {
    const error = new Error("Не удалось определить идентификатор отчёта");
    error.status = 400;
    throw error;
  }
  const existing = getReportsDb()
    .prepare(`
      SELECT id, public_id, owner_source, owner_label, workspace_id, title, issue_url, issue_key,
        environment, overall_status, schema_version, content_hash, history_comment, created_at, updated_at,
        last_opened_at, reason, document_json
      FROM reports
      WHERE id = ? AND owner_source = ? AND owner_id = ? AND deleted_at = ''
    `)
    .get(id, owner.source, owner.id);
  const issueUrl = String(body.issueUrl ?? document.issueUrl ?? "").trim().slice(0, 2000);
  const issueKey = String(body.issueKey || issueKeyFromUrl(issueUrl)).trim().slice(0, 80);
  const environment = String(body.environment ?? document.environment ?? "").trim().slice(0, 120);
  const overallStatus = String(body.overallStatus ?? document.overallStatus ?? "").trim().slice(0, 80);
  const title = String(body.title || `${issueKey || "Без задачи"} — ${environment || "Окружение не указано"}`)
    .trim()
    .slice(0, 500);
  const schemaVersion = Number(body.schemaVersion || document.schemaVersion || 3) || 3;
  const reason = String(body.reason || "").trim().slice(0, 120);
  const historyComment = String(body.historyComment ?? existing?.history_comment ?? "").trim().slice(0, 1000);
  const publicId = ensurePublicId(owner, body.publicId || document.publicId || existing?.public_id || "", id);
  document.publicId = publicId;
  const documentJson = JSON.stringify(document);
  const contentHash = reportContentHash(document);
  const baseContentHash = String(body.baseContentHash || "").trim();
  let existingNormalizedHash = "";
  if (existing?.document_json) {
    try {
      existingNormalizedHash = reportContentHash(sanitizeReportDocumentForServer(JSON.parse(existing.document_json)));
    } catch {
      existingNormalizedHash = existing.content_hash || "";
    }
  }
  if (
    existing?.content_hash &&
    existing.content_hash !== contentHash &&
    existing.content_hash !== baseContentHash &&
    existingNormalizedHash !== contentHash &&
    !body.force
  ) {
    sendJson(response, 409, {
      error: "Серверная версия отчёта изменилась. Сохранение остановлено, чтобы не перезаписать чужие изменения.",
      conflict: true,
      report: reportRecordFromRow(existing, true),
    });
    return;
  }
  if (objectStorageConfigured()) {
    await s3Request("PUT", `reports/${id}/report.json`, {
      body: Buffer.from(documentJson),
      contentType: "application/json; charset=utf-8",
    });
  }
  const createdAt = existing?.created_at || body.createdAt || now;
  getReportsDb()
    .prepare(`
      INSERT INTO reports (
        id, public_id, owner_source, owner_id, owner_label, workspace_id, title, issue_url, issue_key,
        environment, overall_status, schema_version, content_hash, history_comment, document_json, created_at, updated_at,
        last_opened_at, reason, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
      ON CONFLICT(owner_source, owner_id, id) DO UPDATE SET
        public_id = excluded.public_id,
        owner_source = excluded.owner_source,
        owner_id = excluded.owner_id,
        owner_label = excluded.owner_label,
        workspace_id = excluded.workspace_id,
        title = excluded.title,
        issue_url = excluded.issue_url,
        issue_key = excluded.issue_key,
        environment = excluded.environment,
        overall_status = excluded.overall_status,
        schema_version = excluded.schema_version,
        content_hash = excluded.content_hash,
        history_comment = excluded.history_comment,
        document_json = excluded.document_json,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at,
        reason = excluded.reason,
        deleted_at = ''
    `)
    .run(
      id,
      publicId,
      owner.source,
      owner.id,
      owner.label,
      owner.workspaceId,
      title,
      issueUrl,
      issueKey,
      environment,
      overallStatus,
      schemaVersion,
      contentHash,
      historyComment,
      documentJson,
      createdAt,
      now,
      now,
      reason,
    );
  sendJson(response, 200, {
    ok: true,
    report: {
      id,
      publicId,
      ownerSource: owner.source,
      ownerLabel: owner.label,
      workspaceId: owner.workspaceId,
      title,
      issueUrl,
      issueKey,
      environment,
      overallStatus,
      schemaVersion,
      contentHash,
      historyComment,
      createdAt,
      updatedAt: now,
      lastOpenedAt: now,
      reason,
      source: "server",
    },
  });
}

async function handleReportsList(request, response) {
  const owner = resolveReportOwner(request);
  const rows = getReportsDb()
    .prepare(`
      SELECT id, public_id, owner_source, owner_label, workspace_id, title, issue_url, issue_key,
        environment, overall_status, schema_version, content_hash, history_comment, created_at, updated_at,
        last_opened_at, reason, document_json
      FROM reports
      WHERE owner_source = ? AND owner_id = ? AND deleted_at = ''
      ORDER BY updated_at DESC
      LIMIT 200
    `)
    .all(owner.source, owner.id);
  for (const row of rows) {
    if (!row.public_id) {
      row.public_id = ensurePublicId(owner);
      getReportsDb()
        .prepare("UPDATE reports SET public_id = ? WHERE id = ? AND owner_source = ? AND owner_id = ?")
        .run(row.public_id, row.id, owner.source, owner.id);
    }
  }
  sendJson(response, 200, {
    ok: true,
    owner: { source: owner.source, label: owner.label, workspaceId: owner.workspaceId },
    reports: rows.map((row) => reportRecordFromRow(row, false)),
  });
}

async function handleReportGet(request, response, reportId) {
  const owner = resolveReportOwner(request);
  const row = getReportsDb()
    .prepare(`
      SELECT id, public_id, owner_source, owner_label, workspace_id, title, issue_url, issue_key,
        environment, overall_status, schema_version, content_hash, history_comment, created_at, updated_at,
        last_opened_at, reason, document_json
      FROM reports
      WHERE (id = ? OR public_id = ?) AND owner_source = ? AND owner_id = ? AND deleted_at = ''
    `)
    .get(reportId, reportId, owner.source, owner.id);
  if (!row) {
    const error = new Error("Отчёт не найден в серверной истории");
    error.status = 404;
    throw error;
  }
  const now = new Date().toISOString();
  if (!row.public_id) {
    row.public_id = ensurePublicId(owner);
    getReportsDb()
      .prepare("UPDATE reports SET public_id = ? WHERE id = ? AND owner_source = ? AND owner_id = ?")
      .run(row.public_id, row.id, owner.source, owner.id);
  }
  getReportsDb()
    .prepare("UPDATE reports SET last_opened_at = ? WHERE id = ? AND owner_source = ? AND owner_id = ?")
    .run(now, row.id, owner.source, owner.id);
  row.last_opened_at = now;
  sendJson(response, 200, { ok: true, report: reportRecordFromRow(row, true) });
}

async function handleReportCommentUpdate(request, response, reportId) {
  const body = await readJson(request);
  const owner = resolveReportOwner(request);
  const historyComment = String(body.historyComment || "").slice(0, 1000);
  const now = new Date().toISOString();
  const result = getReportsDb()
    .prepare(
      "UPDATE reports SET history_comment = ?, updated_at = ? WHERE id = ? AND owner_source = ? AND owner_id = ? AND deleted_at = ''",
    )
    .run(historyComment, now, reportId, owner.source, owner.id);
  if (!result.changes) {
    const error = new Error("Отчёт не найден в серверной истории");
    error.status = 404;
    throw error;
  }
  sendJson(response, 200, { ok: true, reportId, historyComment, updatedAt: now });
}

async function handleReportDelete(request, response, reportId) {
  const owner = resolveReportOwner(request);
  const now = new Date().toISOString();
  const result = getReportsDb()
    .prepare("UPDATE reports SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_source = ? AND owner_id = ? AND deleted_at = ''")
    .run(now, now, reportId, owner.source, owner.id);
  if (!result.changes) {
    const error = new Error("Отчёт не найден в серверной истории");
    error.status = 404;
    throw error;
  }
  sendJson(response, 200, { ok: true, deleted: true, reportId });
}

async function handleReportsClear(request, response) {
  const owner = resolveReportOwner(request);
  const now = new Date().toISOString();
  const result = getReportsDb()
    .prepare("UPDATE reports SET deleted_at = ?, updated_at = ? WHERE owner_source = ? AND owner_id = ? AND deleted_at = ''")
    .run(now, now, owner.source, owner.id);
  sendJson(response, 200, { ok: true, deleted: result.changes || 0 });
}

async function handleJiraAttachments(request, response) {
  const body = await readJson(request);
  const connection = normalizeConnection(body);
  const { issueKey } = parseIssueReference(connection, body.issueUrl);
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return sendJson(response, 200, { ok: true, attachments: [] });
  if (files.length > 20) throw new Error("За один раз можно загрузить не более 20 вложений");
  const version = connection.type === "cloud" ? "3" : "2";
  const normalizedFiles = files.map(decodeAttachmentFile);
  const usedNames = new Set();
  const usedScreenshotNumbers = [];
  let attachmentListAvailable = false;
  try {
    const issue = await jiraFetch(
      connection,
      `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    );
    for (const attachment of issue.fields?.attachment || []) {
      if (!attachment.filename) continue;
      const filename = String(attachment.filename).toLowerCase();
      usedNames.add(filename);
      const match = filename.match(/^screenshot-(\d+)\.[a-z0-9]+$/i);
      if (match) usedScreenshotNumbers.push(Number(match[1]));
    }
    attachmentListAvailable = true;
  } catch {
    // Если у пользователя нет права читать список вложений, загрузка всё равно
    // продолжится. Имена текущей пачки останутся уникальными между собой.
  }
  let screenshotNumber = Math.max(0, ...usedScreenshotNumbers) + 1;
  const fallbackPrefix = `screenshot-${Date.now()}`;
  normalizedFiles.forEach((file, index) => {
    const extension = path.extname(file.name) || ".png";
    if (!attachmentListAvailable) {
      file.name = file.kind === "image" ? `${fallbackPrefix}-${index + 1}${extension}` : file.name;
      usedNames.add(file.name.toLowerCase());
      return;
    }
    if (file.kind !== "image") {
      const requested = file.name;
      const parsed = path.parse(requested);
      let candidate = requested;
      let counter = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${parsed.name || "file"}-${counter}${parsed.ext || ""}`;
        counter += 1;
      }
      file.name = candidate;
      usedNames.add(candidate.toLowerCase());
      return;
    }
    const requestedName = file.name.toLowerCase();
    const requestedMatch = requestedName.match(/^screenshot-(\d+)\.[a-z0-9]+$/i);
    let candidate = "";
    if (requestedMatch && !usedNames.has(requestedName)) {
      candidate = file.name;
      screenshotNumber = Math.max(screenshotNumber, Number(requestedMatch[1]) + 1);
    } else {
      do {
        candidate = `screenshot-${screenshotNumber}${extension}`;
        screenshotNumber += 1;
      } while (usedNames.has(candidate.toLowerCase()));
    }
    file.name = candidate;
    usedNames.add(candidate.toLowerCase());
  });
  const results = [];
  for (const file of normalizedFiles) {
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
    let uploaded;
    try {
      uploaded = await jiraFetch(
        connection,
        `/rest/api/${version}/issue/${encodeURIComponent(issueKey)}/attachments`,
        {
          method: "POST",
          body: form,
          headers: { "X-Atlassian-Token": "no-check" },
        },
      );
    } catch (error) {
      throw new Error(
        `Не удалось загрузить «${file.name}» (${file.type}, ${file.bytes.length} байт): ${error.message}`,
      );
    }
    const item = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!item?.id) {
      throw new Error(`Jira не вернула данные вложения для файла «${file.name}»`);
    }
    results.push({
      attachmentId: file.attachmentId,
      id: item.id,
      filename: item.filename || file.name,
      content: item.content,
      thumbnail: item.thumbnail,
    });
  }
  sendJson(response, 200, { ok: true, attachments: results });
}

function normalizeStorageReportId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) throw new Error("Некорректный ID отчёта");
  return id;
}

async function handleObjectStorageUpload(request, response) {
  const body = await readJson(request);
  const reportId = normalizeStorageReportId(body.reportId);
  const file = decodeAttachmentFile(body.file || {}, 0);
  const kind = file.kind === "image" ? "images" : "files";
  const storedName = `${crypto.randomUUID()}-${sanitizeGenericAttachmentName(file.name, 0)}`;
  const key = `reports/${reportId}/${kind}/${storedName}`;
  await s3Request("PUT", key, { body: file.bytes, contentType: file.type });
  const url = `/api/storage/object/${encodeURIComponent(reportId)}/${kind}/${encodeURIComponent(storedName)}`;
  sendJson(response, 201, { ok: true, reportId, kind, name: file.name, key, url });
}

async function handleObjectStorageGet(request, response, reportId, kind, storedName) {
  const safeReportId = normalizeStorageReportId(decodeURIComponent(reportId));
  if (!['images', 'files'].includes(kind)) throw new Error("Некорректный тип объекта");
  const safeName = path.basename(decodeURIComponent(storedName));
  if (!safeName || safeName !== decodeURIComponent(storedName)) throw new Error("Некорректное имя объекта");
  const storageResponse = await s3Request("GET", `reports/${safeReportId}/${kind}/${safeName}`);
  const contentLength = storageResponse.headers.get("content-length");
  response.writeHead(200, {
    "Content-Type": storageResponse.headers.get("content-type") || "application/octet-stream",
    ...(contentLength ? { "Content-Length": contentLength } : {}),
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(safeName.replace(/^[0-9a-f-]{36}-/, ""))}`,
  });
  response.end(Buffer.from(await storageResponse.arrayBuffer()));
}

function serveStatic(request, response) {
  const requestPath = new URL(request.url, "http://localhost").pathname;
  const isReportRoute = /^\/report\/[a-f0-9]{7,8}$/i.test(requestPath);
  const relative = requestPath === "/" || isReportRoute ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const filePath = path.resolve(ROOT, relative);
  const pathFromRoot = path.relative(ROOT, filePath);
  if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  try {
    const requestPath = new URL(request.url, "http://localhost").pathname;
    enforceSameOrigin(request);
    enforceApiRateLimit(request, requestPath);
    if (request.method === "GET" && requestPath === "/api/health") {
      sendJson(response, 200, { ok: true, service: "qa-report", objectStorageConfigured: objectStorageConfigured() });
      return;
    }
    if (request.method === "GET" && requestPath === "/api/reports") {
      await handleReportsList(request, response);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/reports") {
      await handleReportSave(request, response);
      return;
    }
    if (request.method === "DELETE" && requestPath === "/api/reports") {
      await handleReportsClear(request, response);
      return;
    }
    const reportMatch = requestPath.match(/^\/api\/reports\/([A-Za-z0-9_.:-]+)$/);
    const reportCommentMatch = requestPath.match(/^\/api\/reports\/([A-Za-z0-9_.:-]+)\/comment$/);
    if (reportCommentMatch && request.method === "PATCH") {
      await handleReportCommentUpdate(request, response, reportCommentMatch[1]);
      return;
    }
    if (reportMatch && request.method === "GET") {
      await handleReportGet(request, response, reportMatch[1]);
      return;
    }
    if (reportMatch && request.method === "DELETE") {
      await handleReportDelete(request, response, reportMatch[1]);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/jira/test") {
      await handleJiraTest(request, response);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/jira/comment") {
      await handleJiraComment(request, response);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/jira/import-comment") {
      await handleJiraImportComment(request, response);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/checklists/import") {
      await handleChecklistImport(request, response);
      return;
    }
    const checklistImportMatch = requestPath.match(/^\/api\/checklists\/import\/([0-9a-f-]+)$/i);
    if (request.method === "GET" && checklistImportMatch) {
      await handleChecklistImportPayload(request, response, checklistImportMatch[1]);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/jira/attachments") {
      await handleJiraAttachments(request, response);
      return;
    }
    if (request.method === "POST" && requestPath === "/api/storage/upload") {
      await handleObjectStorageUpload(request, response);
      return;
    }
    const storedObjectMatch = requestPath.match(/^\/api\/storage\/object\/([^/]+)\/(images|files)\/([^/]+)$/);
    if (request.method === "GET" && storedObjectMatch) {
      await handleObjectStorageGet(request, response, storedObjectMatch[1], storedObjectMatch[2], storedObjectMatch[3]);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Метод не поддерживается" });
      return;
    }
    serveStatic(request, response);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 400;
    const hideDetails = process.env.NODE_ENV === "production" && status >= 500;
    if (hideDetails) console.error(`Ошибка запроса: ${error.stack || error.message}`);
    sendJson(response, status, {
      error: hideDetails ? "Внутренняя ошибка сервера" : error.message || "Неизвестная ошибка",
      ...(hideDetails ? {} : { errorCode: error.code || "", jiraPath: error.pathname || "" }),
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Порт ${PORT} уже занят. Вероятно, QA Report уже запущен: http://${HOST}:${PORT}`,
    );
    console.error(
      `Остановите предыдущий процесс или запустите приложение на другом порту: PORT=4174 node server.js`,
    );
    process.exit(1);
  }
  console.error(`Не удалось запустить QA Report: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`QA Report: http://${HOST}:${PORT}`);
});
