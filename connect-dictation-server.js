"use strict";
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
const ttl = 5 * 60 * 1000;
// Speech and bug-draft AI jobs only. Device credentials never authorize reports or Jira.
function createDictationService({ database, readJson, sendJson, origin, owner, verifyCsrf, audit }) {
  function db() {
    const value = database();
    value.exec(`
      CREATE TABLE IF NOT EXISTS dictation_pairings (code_hash TEXT PRIMARY KEY, owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dictation_devices (id TEXT PRIMARY KEY, owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, token_hash TEXT NOT NULL, last_seen_at TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'system');
      CREATE TABLE IF NOT EXISTS dictation_jobs (id TEXT PRIMARY KEY, owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES dictation_devices(id), type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dictation_device_queue ON dictation_jobs(device_id, status, created_at);
    `);
    const now = new Date().toISOString();
    value.prepare("DELETE FROM dictation_pairings WHERE expires_at <= ?").run(now);
    value.prepare("DELETE FROM dictation_jobs WHERE expires_at <= ?").run(now);
    return value;
  }
  async function body(request) {
    const value = await readJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Проверьте запрос Connect");
    return value;
  }
  function device(request, store) {
    const match = String(request.headers.authorization || "").match(/^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/i);
    if (!match) fail("Не передан ключ Connect", 401);
    const value = store.prepare("SELECT * FROM dictation_devices WHERE id = ?").get(match[1]);
    if (!value || !crypto.timingSafeEqual(Buffer.from(value.token_hash), Buffer.from(hash(match[2])))) fail("Ключ Connect недействителен", 401);
    store.prepare("UPDATE dictation_devices SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), value.id);
    return value;
  }
  async function machine(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const resultRoute = pathname.match(/^\/api\/agent\/jobs\/([a-f0-9-]{36})\/result$/i);
    if (request.method !== "POST" || (!resultRoute && !["/api/agent/pair", "/api/agent/poll", "/api/agent/heartbeat"].includes(pathname))) return false;
    const store = db();
    if (pathname === "/api/agent/pair") {
      const value = await body(request), code = String(value.code || "");
      if (!/^\d{8}$/.test(code)) fail("Код подключения должен содержать 8 цифр");
      const pairing = store.prepare("SELECT * FROM dictation_pairings WHERE code_hash = ?").get(hash(code));
      if (!pairing) fail("Код подключения истёк или уже использован", 404);
      const id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString("base64url"), now = new Date().toISOString();
      store.exec("BEGIN IMMEDIATE");
      try {
        store.prepare("INSERT INTO dictation_devices(id, owner_source, owner_id, name, version, token_hash, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, pairing.owner_source, pairing.owner_id, String(value.name || "QA Report Connect").slice(0, 100), String(value.version || "").slice(0, 30), hash(secret), now);
        store.prepare("DELETE FROM dictation_pairings WHERE code_hash = ?").run(pairing.code_hash);
        store.exec("COMMIT");
      } catch (error) { store.exec("ROLLBACK"); throw error; }
      audit(request, response, "dictation_device_paired");
      sendJson(response, 201, { deviceId: id, secret }); return true;
    }
    const current = device(request, store), value = await body(request);
    if (pathname === "/api/agent/heartbeat") { sendJson(response, 200, { ok: true }); return true; }
    if (resultRoute) {
      const job = store.prepare("SELECT * FROM dictation_jobs WHERE id = ? AND device_id = ? AND status = 'running'").get(resultRoute[1], current.id);
      if (!job) fail("Задание Connect не найдено", 404);
      const result = value.ok ? value.result : {}, serialized = JSON.stringify(result || {});
      if (serialized.length > (job.type === "ai.bug-draft" ? 200000 : 25000)) fail("Ответ Connect слишком большой", 413);
      store.prepare("UPDATE dictation_jobs SET status = ?, result_json = ?, error = ?, payload_json = '{}' WHERE id = ?")
        .run(value.ok ? "completed" : "failed", serialized, String(value.error || "").slice(0, 1000), job.id);
      sendJson(response, 200, { ok: true }); return true;
    }
    store.prepare("UPDATE dictation_devices SET version = ? WHERE id = ?").run(String(value.version || current.version).slice(0, 30), current.id);
    const job = store.prepare("SELECT * FROM dictation_jobs WHERE device_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1").get(current.id);
    if (job) store.prepare("UPDATE dictation_jobs SET status = 'running' WHERE id = ?").run(job.id);
    sendJson(response, 200, { job: job ? { id: job.id, type: job.type, payload: JSON.parse(job.payload_json) } : null, preferences: { theme: current.theme }, pollAfterMs: 2500 });
    return true;
  }
  async function browser(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const jobRoute = pathname.match(/^\/api\/agent\/jobs\/([a-f0-9-]{36})$/i);
    const jobTypes = { "/api/ai/profiles": "ai.profiles", "/api/ai/bug-draft": "ai.bug-draft", "/api/ai/transcribe": "ai.transcribe", "/api/ai/refine": "ai.refine" };
    if (!((request.method === "GET" && (jobRoute || pathname === "/api/agent/status")) || (request.method === "POST" && (jobTypes[pathname] || ["/api/agent/pairings", "/api/agent/preferences"].includes(pathname))))) return false;
    const identity = owner(request), store = db();
    if (request.method === "GET") {
      if (jobRoute) {
        const job = store.prepare("SELECT * FROM dictation_jobs WHERE id = ? AND owner_source = ? AND owner_id = ?").get(jobRoute[1], identity.source, identity.id);
        if (!job) fail("Задание Connect не найдено или истекло", 404);
        sendJson(response, 200, { job: { id: job.id, type: job.type, status: job.status, result: JSON.parse(job.result_json), error: job.error } });
      } else {
        const devices = store.prepare("SELECT id, name, version, last_seen_at FROM dictation_devices WHERE owner_source = ? AND owner_id = ? ORDER BY last_seen_at DESC")
          .all(identity.source, identity.id).map(item => ({ id: item.id, name: item.name, version: item.version, online: Date.now() - Date.parse(item.last_seen_at) < 45000 }));
        sendJson(response, 200, { devices, connected: devices.some(item => item.online) });
      }
      return true;
    }
    const value = await body(request);
    if (!verifyCsrf(request, value.csrfToken)) fail("Недействительный защитный токен", 403);
    if (pathname === "/api/agent/pairings") {
      const code = String(crypto.randomInt(0, 100000000)).padStart(8, "0"), expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      store.prepare("INSERT INTO dictation_pairings(code_hash, owner_source, owner_id, expires_at) VALUES (?, ?, ?, ?)").run(hash(code), identity.source, identity.id, expiresAt);
      audit(request, response, "dictation_pairing_created");
      sendJson(response, 201, { code, serverUrl: origin(request), expiresAt }); return true;
    }
    if (pathname === "/api/agent/preferences") {
      if (!["light", "dark", "graphite"].includes(value.theme)) fail("Неизвестная тема");
      store.prepare("UPDATE dictation_devices SET theme = ? WHERE owner_source = ? AND owner_id = ?").run(value.theme, identity.source, identity.id);
      sendJson(response, 200, { ok: true }); return true;
    }
    const type = jobTypes[pathname], payload = {};
    if (type === "ai.bug-draft") {
      const Bugs = require("./bug-report");
      for (const key of ["profileId", "prompt", "context", "additionalContext"]) if (Object.hasOwn(value, key)) payload[key] = value[key];
      if (typeof payload.profileId !== "string" || !payload.profileId || payload.profileId.length > 200 || typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 16000 || (payload.additionalContext !== undefined && (typeof payload.additionalContext !== "string" || payload.additionalContext.length > 16000))) fail("Проверьте подключение ИИ и описание проблемы");
      if (JSON.stringify(payload).length > 200000) fail("Форма баг-репорта слишком большая", 413);
      try {
        if (Object.hasOwn(value, "images")) payload.images = Bugs.imageInputs(value.images);
        if (Object.hasOwn(value, "textAttachments")) payload.textAttachments = Bugs.textInputs(value.textAttachments);
        if (Object.hasOwn(value, "jiraFields")) payload.jiraFields = Bugs.aiFields(value.jiraFields);
      } catch (error) { fail(error.message); }
    } else if (type !== "ai.profiles") {
      if (typeof value.selection !== "string" || value.selection.length > 4096) fail("Обновите настройки диктовки");
      payload.selection = value.selection;
      if (type === "ai.transcribe") payload.audio = audioInput(value.audio);
      else { if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 16000) fail("Диктовка должна быть не длиннее 16 000 символов"); payload.text = value.text; }
    }
    const current = store.prepare("SELECT id FROM dictation_devices WHERE owner_source = ? AND owner_id = ? AND last_seen_at > ? ORDER BY last_seen_at DESC LIMIT 1")
      .get(identity.source, identity.id, new Date(Date.now() - 45000).toISOString());
    if (!current) fail("Подключите QA Report Connect в настройках приложения", 503);
    const queued = store.prepare("SELECT count(*) AS count FROM dictation_jobs WHERE owner_source = ? AND owner_id = ? AND status IN ('queued', 'running')").get(identity.source, identity.id);
    if (queued.count >= 5) fail("Connect уже обрабатывает диктовку. Дождитесь завершения", 429);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    store.prepare("INSERT INTO dictation_jobs(id, owner_source, owner_id, device_id, type, payload_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
      .run(id, identity.source, identity.id, current.id, type, JSON.stringify(payload), now, new Date(Date.now() + ttl).toISOString());
    audit(request, response, "dictation_job_created", { category: type });
    sendJson(response, 202, { jobId: id }); return true;
  }
  return { browser, machine };
}
function audioInput(audio) {
  if (!audio || audio.type !== "audio/wav" || typeof audio.dataBase64 !== "string" || audio.dataBase64.length > 7680060 || audio.dataBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.dataBase64)) fail("Повторите запись: нужен WAV до 3 минут");
  const raw = Buffer.from(audio.dataBase64, "base64");
  if (raw.length < 46 || raw.length > 5760044) fail("Запись пустая или слишком большая");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), tag = offset => raw.toString("ascii", offset, offset + 4);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data" || view.getUint32(4, true) !== raw.length - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== raw.length - 44 || (raw.length - 44) % 2) fail("Повторите запись: нужен WAV, 16 кГц, моно");
  return { type: "audio/wav", dataBase64: audio.dataBase64 };
}
module.exports = { createDictationService, audioInput };
