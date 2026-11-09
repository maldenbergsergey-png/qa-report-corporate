const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { documentFields } = require('./report-file');

const API = '/api/cloud-reports';
const CHUNK_BYTES = 384 * 1024;
const FILE_BYTES = 50 * 1024 * 1024;
const TOTAL_BYTES = 250 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;

// This policy is separate from publication links and their author permissions.
function createCloudSettings({ getDb, configured }) {
  function db() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS personal_cloud_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
      CREATE TABLE IF NOT EXISTS personal_cloud_user_settings (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))`);
    return db;
  }
  return {
    get: () => ({ configured: Boolean(configured()), cloudEnabled: Boolean(configured()) && db().prepare('SELECT enabled FROM personal_cloud_settings WHERE id=1').get()?.enabled === 1 }),
    set(enabled) { db().prepare('INSERT INTO personal_cloud_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(Number(enabled)); },
    getUser: id => db().prepare('SELECT enabled FROM personal_cloud_user_settings WHERE user_id=?').get(id)?.enabled !== 0,
    setUser(id, enabled) { db().prepare('INSERT INTO personal_cloud_user_settings VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(id, Number(enabled)); },
  };
}

function createPersonalCloud({ getDb, readJson, sendJson, authenticate, validateWrite, settings, storage, uploadsAllowed = () => true }) {
  let initialized;
  const uploads = new Map();
  const active = new Set();
  let cleaning = false;
  function db() {
    const db = getDb();
    if (initialized !== db) {
      db.exec(`CREATE TABLE IF NOT EXISTS personal_cloud_reports (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        document_json TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS personal_cloud_owner ON personal_cloud_reports(owner_id, updated_at);
        CREATE TABLE IF NOT EXISTS personal_cloud_files (
          report_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, bucket_id TEXT NOT NULL,
          object_key TEXT NOT NULL, PRIMARY KEY(report_id, hash));
        CREATE TABLE IF NOT EXISTS personal_cloud_cleanup (bucket_id TEXT NOT NULL, object_key TEXT PRIMARY KEY)`);
      initialized = db;
    }
    return db;
  }
  function owned(id, owner) {
    const row = db().prepare('SELECT * FROM personal_cloud_reports WHERE id=? AND owner_id=?').get(id, owner);
    if (!row) fail(403, 'Нет доступа к облачному отчёту.');
    return row;
  }
  function writable(owner) {
    if (!settings.get().cloudEnabled || !settings.getUser(owner)) fail(403, 'Сохранение личных отчётов в облаке отключено администратором.');
  }
  function view(row, document = false) {
    return { id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(document && { document: JSON.parse(row.document_json), files: db().prepare('SELECT hash, size FROM personal_cloud_files WHERE report_id=?').all(row.id).filter(file => row.document_json.includes(`report-asset:${file.hash}`)) }) };
  }
  async function cleanStorage() {
    if (cleaning || !settings.get().configured) return;
    cleaning = true;
    try { for (const item of db().prepare('SELECT * FROM personal_cloud_cleanup LIMIT 30').all()) {
      if ([...active].some(key => item.object_key.endsWith('/' + key.replace(':', '/')))) continue;
      const parts = item.object_key.split('/');
      const lock = `${parts[2]}:${parts[3]}`;
      active.add(lock);
      try {
        await storage().remove({ bucketId: item.bucket_id, key: item.object_key });
        db().prepare('DELETE FROM personal_cloud_cleanup WHERE object_key=?').run(item.object_key);
      } catch { /* Retry on the next cleanup tick, including after a restart. */ }
      finally { active.delete(lock); }
    } } finally { cleaning = false; }
  }
  async function discardUpload(key) {
    const upload = uploads.get(key);
    uploads.delete(key);
    if (upload) await fs.rm(upload.directory, { recursive: true, force: true });
  }
  const timer = setInterval(() => {
    for (const [key, upload] of uploads) if (!active.has(key) && upload.expires < Date.now()) discardUpload(key).catch(() => {});
    cleanStorage().catch(() => {});
  }, 60_000);
  timer.unref?.();

  async function handle(request, response, pathname) {
    if (pathname !== API && !pathname.startsWith(API + '/')) return false;
    const method = request.method;
    // Authentication is supplied by each version's existing session mechanism.
    const owner = await authenticate(request);
    if (pathname === API + '/availability' && method === 'GET') {
      sendJson(response, 200, { ...settings.get(), signedIn: Boolean(owner), ownerId: owner || '',
        canSave: Boolean(owner) && settings.get().cloudEnabled && settings.getUser(owner), chunkBytes: CHUNK_BYTES, fileBytes: FILE_BYTES });
      return true;
    }
    if (!owner) fail(401, 'Войдите в профиль QA Report.');
    if (!['GET', 'HEAD'].includes(method)) await validateWrite(request);
    if (pathname === API && method === 'GET') {
      const rows = db().prepare('SELECT * FROM personal_cloud_reports WHERE owner_id=? AND revision>0 ORDER BY updated_at DESC LIMIT 1000').all(owner);
      sendJson(response, 200, { reports: rows.map(row => view(row)) });
      return true;
    }
    if (pathname === API && method === 'POST') {
      writable(owner);
      if (db().prepare('SELECT count(*) AS total FROM personal_cloud_reports WHERE owner_id=?').get(owner).total >= 1000) fail(409, 'В облаке можно хранить до 1000 отчётов.');
      const id = randomUUID(), now = new Date().toISOString();
      db().prepare('INSERT INTO personal_cloud_reports (id,owner_id,created_at,updated_at) VALUES (?,?,?,?)').run(id, owner, now, now);
      sendJson(response, 201, { report: { id, revision: 0 } });
      return true;
    }
    const match = /^\/api\/cloud-reports\/([^/]+)(?:\/files(?:\/([a-f0-9]{64}))?)?$/.exec(pathname);
    if (!match || !uuid.test(match[1])) fail(404, 'Облачный отчёт не найден.');
    const [, id, fileHash] = match;
    const row = owned(id, owner);
    const filesRoute = pathname.includes('/files');
    if (method === 'GET' && !filesRoute) {
      if (!row.revision) fail(404, 'Отчёт ещё не сохранён в облаке.');
      sendJson(response, 200, { report: view(row, true) });
      return true;
    }
    if (method === 'GET' && fileHash) {
      // Pending files cannot be read before their report is committed.
      const used = row.revision && row.document_json.includes(`report-asset:${fileHash}`);
      const file = used && db().prepare('SELECT * FROM personal_cloud_files WHERE report_id=? AND hash=?').get(id, fileHash);
      if (!file) fail(403, 'Нет доступа к вложению отчёта.');
      const result = await storage().get({ bucketId: file.bucket_id, key: file.object_key });
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
        'Content-Disposition': 'attachment', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox" });
      try { await pipeline(Readable.fromWeb(result.body), response); }
      catch { response.destroy(); }
      return true;
    }
    if (method === 'DELETE' && !filesRoute) {
      if ([...active].some(key => key.startsWith(id + ':'))) fail(409, 'Дождитесь завершения загрузки отчёта.');
      db().exec('BEGIN IMMEDIATE');
      try {
        db().prepare('INSERT OR IGNORE INTO personal_cloud_cleanup SELECT bucket_id,object_key FROM personal_cloud_files WHERE report_id=?').run(id);
        db().prepare('DELETE FROM personal_cloud_files WHERE report_id=?').run(id);
        db().prepare('DELETE FROM personal_cloud_reports WHERE id=? AND owner_id=?').run(id, owner);
        db().exec('COMMIT');
      } catch (error) { db().exec('ROLLBACK'); throw error; }
      for (const key of uploads.keys()) if (key.startsWith(id + ':')) await discardUpload(key);
      sendJson(response, 200, { ok: true });
      return true;
    }
    writable(owner);
    if (method === 'POST' && fileHash) {
      const key = `${id}:${fileHash}`;
      if (active.size >= 4 || [...active].some(item => item.startsWith(id + ':'))) fail(429, 'Дождитесь завершения текущей загрузки.');
      active.add(key);
      try {
        const body = await readJson(request, 600 * 1024);
        const { size, offset, data } = body;
        if (!Number.isSafeInteger(size) || size < 0 || size > FILE_BYTES || !Number.isSafeInteger(offset) || offset < 0 ||
            typeof data !== 'string' || data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail(400, 'Некорректная часть вложения.');
        const bytes = Buffer.from(data, 'base64');
        if (offset + bytes.length > size || (!bytes.length && size !== 0)) fail(400, 'Некорректный размер вложения.');
        const exists = db().prepare('SELECT size FROM personal_cloud_files WHERE report_id=? AND hash=?').get(id, fileHash);
        if (exists) {
          if (exists.size !== size) fail(400, 'Размер вложения изменился.');
          sendJson(response, 200, { complete: true }); return true;
        }
        if (!uploadsAllowed(owner)) fail(403, 'Загрузка новых вложений в S3 отключена администратором.');
        if (offset === 0) {
          await discardUpload(key);
          if (uploads.size >= 4) fail(429, 'Дождитесь завершения других загрузок.');
          const quota = db().prepare('SELECT count(*) AS count, COALESCE(sum(size),0) AS total FROM personal_cloud_files WHERE report_id=?').get(id);
          const pending = [...uploads.values()].filter(item => item.reportId === id);
          if (quota.count + pending.length >= 1000 || quota.total + pending.reduce((sum, item) => sum + item.size, 0) + size > TOTAL_BYTES) fail(413, 'Превышен лимит 250 МиБ или 1000 вложений отчёта.');
          const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-personal-cloud-'));
          uploads.set(key, { reportId: id, directory, file: path.join(directory, 'attachment'), offset: 0, size, digest: createHash('sha256') });
        }
        const upload = uploads.get(key);
        if (!upload || upload.offset !== offset || upload.size !== size) fail(409, 'Начните загрузку файла заново.');
        upload.expires = Date.now() + 10 * 60_000;
        await fs.appendFile(upload.file, bytes, { mode: 0o600 });
        upload.digest.update(bytes); upload.offset += bytes.length;
        if (upload.offset === size) {
          if (upload.digest.digest('hex') !== fileHash) { await discardUpload(key); fail(400, 'Вложение повреждено при загрузке.'); }
          // Recheck policy and ownership after the upload; no user-supplied S3 keys.
          owned(id, owner); writable(owner);
          if (!uploadsAllowed(owner)) fail(403, 'Загрузка новых вложений в S3 отключена администратором.');
          const objectKey = `cloud-reports/${hash(owner)}/${id}/${fileHash}`;
          const bucket = storage();
          db().prepare('INSERT OR IGNORE INTO personal_cloud_cleanup VALUES (?,?)').run(bucket.activeBucketId, objectKey);
          const reference = await bucket.put(objectKey, await fs.readFile(upload.file));
          owned(id, owner);
          db().prepare('INSERT INTO personal_cloud_files VALUES (?,?,?,?,?)').run(id, fileHash, size, reference.bucketId, reference.key);
          db().prepare('DELETE FROM personal_cloud_cleanup WHERE object_key=?').run(objectKey);
          await discardUpload(key);
        }
        sendJson(response, 200, { complete: !uploads.has(key) });
      } catch (error) { await discardUpload(key); throw error; }
      finally { active.delete(key); }
      return true;
    }
    if (method === 'PUT' && !filesRoute) {
      const body = await readJson(request, 16 * 1024 * 1024);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.title !== 'string' || body.title.length > 500) fail(400, 'Некорректные данные отчёта.');
      const document = documentFields(body.document);
      const json = JSON.stringify(document);
      // Only content-addressed assets are allowed; embedded binaries stay out of SQLite.
      const parts = [document.intro, ...document.sections.flatMap(section => section.rows.flatMap(row => Object.values(row.cells)))];
      for (const html of parts) for (const tag of html.matchAll(/<[^>]*>/g)) {
        if (/\b(?:src|data-data-url)\s*=\s*(?:["'](?!report-asset:[a-f0-9]{64}["'])|[^\s"'>])/i.test(tag[0])) fail(400, 'Вложения нужно загрузить отдельно от текста отчёта.');
      }
      if (row.revision !== body.revision) fail(409, 'Облачный отчёт изменён на другом устройстве. Откройте свежую версию или сохраните текущую отдельной копией.');
      const used = new Set([...json.matchAll(/report-asset:([a-f0-9]{64})/g)].map(match => match[1]));
      for (const file of used) if (!db().prepare('SELECT 1 FROM personal_cloud_files WHERE report_id=? AND hash=?').get(id, file)) fail(400, 'Не все вложения загружены.');
      const updatedAt = new Date().toISOString();
      const result = db().prepare('UPDATE personal_cloud_reports SET title=?,document_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?')
        .run(body.title, json, updatedAt, id, owner, body.revision);
      if (!result.changes) fail(409, 'Облачный отчёт изменён на другом устройстве. Откройте свежую версию или сохраните текущую отдельной копией.');
      for (const file of db().prepare('SELECT hash, bucket_id, object_key FROM personal_cloud_files WHERE report_id=?').all(id)) {
        if (used.has(file.hash) || active.has(`${id}:${file.hash}`)) continue;
        db().prepare('INSERT OR IGNORE INTO personal_cloud_cleanup VALUES (?,?)').run(file.bucket_id, file.object_key);
        db().prepare('DELETE FROM personal_cloud_files WHERE report_id=? AND hash=?').run(id, file.hash);
      }
      sendJson(response, 200, { report: view(owned(id, owner)) });
      return true;
    }
    if (method === 'POST' && filesRoute && !fileHash) {
      const body = await readJson(request);
      if (!Array.isArray(body.files) || body.files.length > 1000) fail(400, 'Некорректный список вложений.');
      let total = 0;
      const seen = new Set();
      const missing = body.files.filter(file => {
        if (!digest.test(file?.hash || '') || seen.has(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_BYTES || (total += file.size) > TOTAL_BYTES) fail(413, 'Проверьте размер и состав вложений.');
        seen.add(file.hash);
        return !db().prepare('SELECT 1 FROM personal_cloud_files WHERE report_id=? AND hash=? AND size=?').get(id, file.hash, file.size);
      }).map(file => file.hash);
      sendJson(response, 200, { missing });
      return true;
    }
    fail(405, 'Метод не поддерживается.');
  }
  return { handle, async close() { clearInterval(timer); for (const key of [...uploads.keys()]) await discardUpload(key); } };
}

module.exports = { createCloudSettings, createPersonalCloud };
