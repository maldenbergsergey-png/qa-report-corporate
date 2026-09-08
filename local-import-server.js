"use strict";
const crypto = require("node:crypto");
const MB = 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
function problem(status, message) { return Object.assign(new Error(message), { status }); }
async function readBytes(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw problem(413, "Превышен размер загрузки");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readSmallJson(request) {
  try { return JSON.parse((await readBytes(request, MB)).toString("utf8") || "{}"); }
  catch (error) { if (error.status) throw error; throw problem(400, "Некорректный JSON"); }
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP") return "image/webp";
  return "";
}
function fileType(bytes, declared = "") {
  return imageType(bytes) || (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(declared) && !declared.startsWith("image/") ? declared : "application/octet-stream");
}
function cleanName(value) {
  return String(value || "file").normalize("NFC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 180) || "file";
}
function secretMatches(expected, actual) {
  const hash = value => crypto.createHash("sha256").update(String(value || "")).digest();
  return crypto.timingSafeEqual(hash(expected), hash(actual));
}
function validateBatch(input, files) {
  if (!input || !ID.test(input.id || "")) throw problem(400, "Нужен уникальный id пакета");
  const ids = new Set();
  if (input.kind === "checklist") {
    if (input.format !== "jira" || typeof input.content !== "string" || !input.content.trim()) throw problem(400, "Нужна Jira-разметка чек-листа");
    if (!Array.isArray(input.attachmentIds || [])) throw problem(400, "attachmentIds должен быть массивом");
    for (const id of input.attachmentIds || []) ids.add(id);
  } else if (input.kind === "cells") {
    if (!Array.isArray(input.updates) || !input.updates.length || input.updates.length > 500) throw problem(400, "Нужно от 1 до 500 изменений ячеек");
    const targets = new Set();
    for (const cell of input.updates) {
      if (!cell || ![cell.sectionId, cell.rowId, cell.columnId].every(id => typeof id === "string" && ID.test(id))) throw problem(400, "Укажите sectionId, rowId и columnId");
      const target = [cell.sectionId, cell.rowId, cell.columnId].join("/");
      if (targets.has(target)) throw problem(400, "Одна ячейка указана несколько раз");
      targets.add(target);
      if (!/^[a-f0-9]{64}$/.test(cell.expectedHash || "")) throw problem(400, "expectedHash должен быть взят из контекста ячейки");
      if (cell.text !== undefined && typeof cell.text !== "string") throw problem(400, "text должен быть строкой");
      if (cell.mode !== undefined && !["append", "replace"].includes(cell.mode)) throw problem(400, "mode: append или replace");
      if (cell.status !== undefined && !["OK", "НЕ ОК", "ПОЧТИ ОК", "НЕ ПРОВЕРЕНО", "ЧАСТИЧНО ПРОВЕРЕНО", "ТРЕБУЕТ УТОЧНЕНИЯ"].includes(cell.status)) throw problem(400, "Неизвестный статус");
      if (!Array.isArray(cell.attachmentIds || [])) throw problem(400, "attachmentIds должен быть массивом");
      for (const id of cell.attachmentIds || []) ids.add(id);
    }
  } else throw problem(400, "kind: cells или checklist");
  for (const id of ids) if (!ID.test(id) || !files.has(id) || files.get(id).batchId) throw problem(409, "Вложение отсутствует или уже использовано");
  return [...ids];
}

// Bytes only live in this bounded, expiring process-local buffer. No disk or cloud writes.
function createLocalImportService({ maxFileBytes = 50 * MB, maxSessionBytes = 100 * MB, maxGlobalBytes = 256 * MB, ttlMs = 30 * 60_000, now = Date.now } = {}) {
  const sessions = new Map(); let allocated = 0;
  function drop(session) { if (sessions.delete(session.id)) { allocated -= session.bytes + session.metadataBytes; session.files.clear(); session.batches.clear(); } }
  function cleanup() { for (const session of sessions.values()) if (session.expiresAt <= now()) drop(session); }
  const timer = setInterval(cleanup, Math.min(ttlMs, 30_000)); timer.unref();
  function get(id, token, role, owner) {
    cleanup(); const session = sessions.get(id);
    if (!session || !secretMatches(session[role + "Token"], token) || (owner !== undefined && session.owner !== owner)) throw problem(404, "Сессия недоступна или истекла");
    return session;
  }
  function json(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }
  const manifest = file => ({ id: file.id, name: file.name, type: file.type, size: file.bytes.length });
  function receipt(batch) { return { id: batch.id, status: batch.status, error: batch.error || "" }; }
  function checkOrigin(request, origin) {
    if (request.headers["sec-fetch-site"] === "cross-site" || (request.headers.origin && request.headers.origin !== origin)) throw problem(403, "Запрос с другого сайта запрещён");
  }
  async function browser(request, response, { owner, origin, validateCreate = () => {} }) {
    const url = new URL(request.url, origin);
    if (!url.pathname.startsWith("/api/local-import/sessions")) return false;
    checkOrigin(request, origin);
    if (request.headers["x-qa-import-request"] !== "1") throw problem(403, "Отсутствует заголовок сессии импорта");
    if (url.pathname === "/api/local-import/sessions" && request.method === "POST") {
      const body = await readSmallJson(request); validateCreate(request, body); cleanup();
      if (!ID.test(body.reportId || "") || !body.context || !Array.isArray(body.context.sections)) throw problem(400, "Укажите открытый отчёт");
      if (sessions.size >= 64 || [...sessions.values()].filter(s => s.owner === owner).length >= 3) throw problem(429, "Закройте предыдущие сессии приёма");
      const contextBytes = Buffer.byteLength(JSON.stringify(body.context));
      if (allocated + contextBytes > maxGlobalBytes) throw problem(429, "Временный буфер занят. Повторите позже");
      const session = { contextBytes, metadataBytes: contextBytes, id: crypto.randomUUID(), owner, reportId: body.reportId, context: body.context, producerToken: crypto.randomBytes(32).toString("hex"), consumerToken: crypto.randomBytes(32).toString("hex"), expiresAt: now() + ttlMs, files: new Map(), batches: new Map(), bytes: 0 };
      sessions.set(session.id, session); allocated += contextBytes;
      json(response, 201, { id: session.id, reportId: session.reportId, consumerToken: session.consumerToken, expiresAt: session.expiresAt, connection: { url: `${origin}/api/local-import/agent/${session.id}`, token: session.producerToken, expiresAt: session.expiresAt }, limits: { maxFileBytes, maxSessionBytes } }); return true;
    }
    const match = url.pathname.match(/^\/api\/local-import\/sessions\/([a-zA-Z0-9_-]+)(?:\/(next|ack|files\/([a-zA-Z0-9_-]+)))?$/);
    if (!match) throw problem(404, "Маршрут импорта не найден");
    const session = get(match[1], request.headers["x-qa-import-reader"], "consumer", owner);
    if (!match[2] && request.method === "DELETE") { drop(session); json(response, 200, { ok: true }); return true; }
    if (match[2] === "next" && request.method === "GET") {
      const batch = [...session.batches.values()].find(b => b.status === "pending");
      json(response, 200, { reportId: session.reportId, expiresAt: session.expiresAt, batch: batch ? { ...batch.payload, files: batch.fileIds.map(id => manifest(session.files.get(id))) } : null }); return true;
    }
    if (match[3] && request.method === "GET") {
      const file = session.files.get(match[3]);
      if (!file) throw problem(404, "Файл не найден");
      response.writeHead(200, { "Content-Type": file.type, "Content-Length": file.bytes.length, "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }); response.end(file.bytes); return true;
    }
    if (match[2] === "ack" && request.method === "POST") {
      const body = await readSmallJson(request); const batch = session.batches.get(body.id);
      if (!batch || !["saved", "rejected"].includes(body.status)) throw problem(400, "Некорректное подтверждение");
      if (batch.status === "pending") {
        batch.status = body.status; batch.error = String(body.error || "").slice(0, 500);
        for (const id of batch.fileIds) { const file = session.files.get(id); if (file) { session.bytes -= file.bytes.length; allocated -= file.bytes.length; session.files.delete(id); } }
        allocated -= batch.metadataBytes; session.metadataBytes -= batch.metadataBytes; batch.metadataBytes = 0; batch.payload = null;
        if (body.context && Array.isArray(body.context.sections)) {
          const nextBytes = Buffer.byteLength(JSON.stringify(body.context));
          const difference = nextBytes - session.contextBytes;
          if (allocated + difference <= maxGlobalBytes) {
            session.context = body.context; session.contextBytes = nextBytes; session.metadataBytes += difference; allocated += difference;
          }
        }
      }
      json(response, 200, receipt(batch)); return true;
    }
    throw problem(405, "Метод не поддерживается");
  }
  async function producer(request, response, origin) {
    const url = new URL(request.url, origin);
    if (!url.pathname.startsWith("/api/local-import/agent/")) return false;
    checkOrigin(request, origin);
    const match = url.pathname.match(/^\/api\/local-import\/agent\/([a-zA-Z0-9_-]+)\/(context|files\/([a-zA-Z0-9_-]+)|batches(?:\/([a-zA-Z0-9_-]+))?)$/);
    if (!match) throw problem(404, "Маршрут импорта не найден");
    const token = String(request.headers["x-qa-import-token"] || "");
    const session = get(match[1], token, "producer");
    if (match[2] === "context" && request.method === "GET") { json(response, 200, { reportId: session.reportId, expiresAt: session.expiresAt, context: session.context }); return true; }
    if (match[3] && request.method === "PUT") {
      const id = match[3];
      if (!ID.test(id) || session.files.has(id) || session.files.size >= 64) throw problem(409, "ID файла занят или достигнут лимит файлов");
      let name;
      try { name = cleanName(decodeURIComponent(request.headers["x-qa-file-name"] || "file")); } catch { throw problem(400, "Некорректное имя файла"); }
      const declaredSize = Number(request.headers["content-length"]);
      const reserve = Number.isSafeInteger(declaredSize) && declaredSize >= 0 ? declaredSize : maxFileBytes;
      if (reserve > maxFileBytes || session.bytes + reserve > maxSessionBytes || allocated + reserve > maxGlobalBytes) throw problem(413, "Превышен лимит временных вложений");
      session.bytes += reserve; allocated += reserve;
      // Reserve the ID as well as bytes before awaiting a concurrent upload.
      session.files.set(id, { id, name, uploading: true, bytes: Buffer.alloc(0) });
      let complete = false;
      try {
        const bytes = await readBytes(request, Math.min(reserve, maxFileBytes));
        if (!sessions.has(session.id) || session.expiresAt <= now()) throw problem(410, "Сессия завершена");
        const file = { id, name, bytes, type: fileType(bytes, String(request.headers["content-type"] || "").split(";")[0]) };
        session.bytes += bytes.length - reserve; allocated += bytes.length - reserve;
        session.files.set(id, file); complete = true;
        json(response, 201, manifest(file)); return true;
      } finally {
        if (!complete && sessions.has(session.id)) { session.bytes -= reserve; allocated -= reserve; session.files.delete(id); }
      }
    }
    if (match[2] === "batches" && request.method === "POST") {
      const body = await readSmallJson(request);
      if (!sessions.has(session.id) || session.expiresAt <= now()) throw problem(410, "Сессия завершена");
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const existing = session.batches.get(body.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw problem(409, "Пакет с этим id уже имеет другое содержимое");
        json(response, 200, receipt(existing)); return true;
      }
      if (session.batches.size >= 128 || [...session.batches.values()].filter(b => b.status === "pending").length >= 8) throw problem(429, "Дождитесь сохранения предыдущих пакетов или откройте новую сессию");
      const fileIds = validateBatch(body, new Map([...session.files].filter(([, f]) => !f.uploading)));
      const metadataBytes = Buffer.byteLength(JSON.stringify(body));
      if (allocated + metadataBytes > maxGlobalBytes) throw problem(429, "Временный буфер занят. Повторите позже");
      const batch = { id: body.id, payload: body, fileIds, fingerprint, metadataBytes, status: "pending" };
      allocated += metadataBytes; session.metadataBytes += metadataBytes;
      for (const id of fileIds) session.files.get(id).batchId = body.id;
      session.batches.set(body.id, batch); json(response, 202, receipt(batch)); return true;
    }
    if (match[4] && request.method === "GET") {
      const batch = session.batches.get(match[4]); if (!batch) throw problem(404, "Пакет не найден");
      json(response, 200, receipt(batch)); return true;
    }
    throw problem(405, "Метод не поддерживается");
  }
  return { browser, producer, close() { clearInterval(timer); for (const session of sessions.values()) drop(session); }, cleanup };
}
module.exports = { createLocalImportService, readBytes, fileType, cleanName, problem, validateBatch };
