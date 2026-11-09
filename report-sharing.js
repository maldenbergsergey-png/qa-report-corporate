const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { loadReportStorage } = require("./report-storage");
const trackerLinks = require("./tracker-links");

const api = "/api/shared-reports";
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const answerStatuses = new Set(["fixed", "not_fixed", "needs_clarification", "unreviewed"]);
const normalizeAnswerStatus = status => status === "in_progress" ? "unreviewed" : status;
const contentFragmentTypes = new Set(["text", "code", "inline-code", "link", "attachment"]);
const commentTags = new Set(["p", "div", "h2", "h3", "b", "i", "u", "s", "ul", "ol", "li", "pre", "code", "br", "a", "span", "blockquote"]);
const maxCommentLength = 10_000;
const maxCommentNodes = 2048;
const maxCommentDepth = 20;
const maxCommentDocumentBytes = 64 * 1024;
const maxContentLength = 100_000;
const mib = 1024 * 1024;
const maxAnswerFileBytes = 10 * mib;
const maxAnswerFilesPerPoint = 10;
const maxAnswerFiles = 250;
const maxAnswerFileTotal = 100 * mib;
const maxAnswerUploads = 4;
const maxFileConfirmationBatch = 6;
const parallelFileConfirmations = 3;
const maxActiveUploadBatches = 4;
const maxReuseSources = 32;
const revokedFileRetentionMs = 7 * 24 * 60 * 60 * 1000;
const authorSessionSeconds = 90 * 24 * 60 * 60;
const authorCookie = "__Host-qa-report-author";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function array(value, max) {
  if (!Array.isArray(value) || value.length > max) fail(400, "Неверный состав отчёта или превышен лимит публикации");
  return value;
}

function str(value, max) {
  if (typeof value !== "string" || value.length > max) fail(400, "Некорректное или слишком длинное поле отчёта");
  return value;
}

function identifier(value) {
  if (typeof value !== "string" || !idPattern.test(value)) fail(400, "Некорректный идентификатор в отчёте");
  return value;
}

function unique(items) {
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(400, "Повторяются идентификаторы в отчёте");
  return items;
}

function link(value) {
  const url = str(value ?? "", 4000);
  if (!url) return "";
  if (!URL.canParse(url)) return "";
  const parsed = new URL(url);
  return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : "";
}

function commentDocumentJson(value, resolveAttachment) {
  if (value == null) return null;
  let remainingNodes = maxCommentNodes;
  let remainingText = maxCommentLength;
  const usedAttachments = new Set();

  function normalize(nodes, depth) {
    if (!Array.isArray(nodes) || nodes.length > remainingNodes || (nodes.length && depth > maxCommentDepth)) {
      fail(400, "Форматирование комментария слишком сложное или некорректное");
    }
    return nodes.map((node) => {
      if (--remainingNodes < 0) fail(400, "Слишком много элементов форматирования в комментарии");
      if (typeof node === "string") {
        remainingText -= node.length;
        if (remainingText < 0) fail(400, "Текст комментария слишком длинный");
        return node;
      }
      const tag = node?.tag;
      if (tag === "attachment") {
        const id = identifier(node.id);
        const file = resolveAttachment(id);
        if (!file || usedAttachments.has(id) || usedAttachments.size >= maxAnswerFilesPerPoint) {
          fail(400, "Некорректное вложение в комментарии");
        }
        usedAttachments.add(id);
        const attachment = { tag, id };
        if (node.align !== undefined || node.width !== undefined) {
          if (!["left", "center", "right"].includes(node.align ?? "left") ||
              !Number.isInteger(node.width ?? 100) || (node.width ?? 100) < 25 || (node.width ?? 100) > 100) {
            fail(400, "Некорректное положение вложения");
          }
          if (node.align && node.align !== "left") attachment.align = node.align;
          if (node.width && node.width !== 100) attachment.width = node.width;
        }
        return attachment;
      }
      if (!commentTags.has(tag)) fail(400, "Недопустимый элемент форматирования в комментарии");
      const normalized = { tag };
      if (tag === "a") {
        const href = str(node.href, 4000).trim();
        if (!/^https?:\/\//i.test(href) || !(normalized.href = link(href))) {
          fail(400, "Некорректная ссылка в комментарии");
        }
      }
      if (tag === "span" && node.color !== undefined) {
        if (typeof node.color !== "string" || !/^#[0-9a-f]{6}$/i.test(node.color)) {
          fail(400, "Некорректный цвет текста комментария");
        }
        normalized.color = node.color.toLowerCase();
      }
      if (node.children !== undefined) {
        normalized.children = normalize(node.children, depth + 1);
        if (tag === "br" && normalized.children.length) fail(400, "Перенос строки не может содержать текст");
      }
      return normalized;
    });
  }

  const nodes = normalize(value, 1);
  if (!nodes.length) return null;
  const json = JSON.stringify(nodes);
  if (Buffer.byteLength(json) > maxCommentDocumentBytes) fail(413, "Форматирование комментария превышает допустимый размер");
  return json;
}

function contentFragments(value, attachments) {
  let remaining = maxContentLength;
  return array(value, 2048).map((item) => {
    const type = item?.type;
    if (!contentFragmentTypes.has(type)) fail(400, "Некорректный фрагмент отчёта");
    if (type === "attachment") {
      const id = identifier(item.id);
      if (!attachments.includes(id)) fail(400, "Вложение отсутствует в содержимом отчёта");
      return { type, id };
    }
    const text = str(item.text, remaining);
    remaining -= text.length;
    const fragment = { type, text };
    if (type === "code" && item.language !== undefined) fragment.language = str(item.language, 80);
    if (type === "link") {
      fragment.href = link(item.href);
      if (!fragment.href) fail(400, "Некорректная ссылка в отчёте");
    }
    return fragment;
  });
}

function snapshotFrom(raw, usedFiles) {
  function content(value) {
    const attachments = array(value?.attachments ?? [], 250).map(identifier);
    for (const fileId of attachments) usedFiles.add(fileId);
    const result = { text: str(value?.text ?? "", maxContentLength), attachments };
    if (value?.fragments !== undefined) {
      const fragments = contentFragments(value.fragments, attachments);
      if (fragments.length) result.fragments = fragments;
    }
    return result;
  }

  const sections = unique(array(raw?.sections, 100).map((section) => {
    const columns = unique(array(section?.columns, 40).map((column) => ({
      id: identifier(column?.id),
      label: str(column?.label ?? "", 500),
    })));
    return {
      id: identifier(section?.id),
      title: str(section?.title ?? "", 500),
      columns,
      rows: unique(array(section?.rows, 2000).map((row) => ({
        id: identifier(row?.id),
        number: str(row?.number ?? "", 80),
        status: str(row?.status ?? "", 120),
        cells: Object.fromEntries(columns.map(({ id }) => [id, content(Object.hasOwn(row?.cells ?? {}, id) ? row.cells[id] : undefined)])),
        bugs: array(row?.bugs ?? [], 100).map((bug) => ({ key: str(bug?.key ?? "", 160), issueUrl: link(bug?.issueUrl) })),
      }))),
    };
  }));
  const defaultStatuses = [...new Set(array(raw.defaultStatuses ?? [], 40)
    .map(status => str(status, 120).trim().toUpperCase()).filter(Boolean))];
  return {
    title: str(raw.title ?? "", 500).trim() || "Отчёт QA Report",
    issueUrl: link(raw.issueUrl),
    environment: str(raw.environment ?? "", 500),
    overallStatus: str(raw.overallStatus ?? "", 120),
    intro: content(raw.intro),
    sections,
    ...(defaultStatuses.length && { defaultStatuses }),
  };
}

function attachmentMetadata(file) {
  const id = identifier(file?.id);
  const name = str(file?.name, 500).replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim() || "attachment";
  const type = str(file?.type ?? "", 120).toLowerCase();
  return { id, name, type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream" };
}

function attachmentPayload(file, maxBytes, limitMessage) {
  const metadata = attachmentMetadata(file);
  if (typeof file?.data !== "string" || file.data.length > Math.ceil(maxBytes / 3) * 4) fail(413, limitMessage);
  const bytes = Buffer.from(file.data, "base64");
  if (bytes.length > maxBytes) fail(413, limitMessage);
  if (bytes.toString("base64") !== file.data) fail(400, "Некорректные данные вложения");
  return { ...metadata, size: bytes.length, sha256: digest(bytes), bytes };
}

function storageIssueKey(issueUrl) {
  const text = typeof issueUrl === "string" ? issueUrl.trim() : "";
  const key = trackerLinks.parse(text)?.key || (/^[A-Z][A-Z0-9_]*-\d+$/i.test(text) ? text.toUpperCase() : "");
  return key && /^[a-zA-ZА-Яа-яЁё0-9_.:-]{1,120}$/.test(key) && key !== "." && key !== ".." ? key : null;
}

function storagePrefix(publicationId, reportId, issueKey) {
  return ["shared-reports", issueKey, reportId, publicationId].filter(Boolean).join("/");
}

function publicationPayload(body, direct = false) {
  const usedFiles = new Set();
  const snapshot = snapshotFrom(body?.snapshot, usedFiles);
  const document = JSON.stringify(snapshot);
  const value = body.snapshot.updatedAt;
  const timestamp = typeof value === "string" && value.length === 24 ? Date.parse(value) : NaN;
  const updatedAt = Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : undefined;
  const snapshotJson = updatedAt ? JSON.stringify({ ...snapshot, updatedAt }) : document;
  if (Buffer.byteLength(snapshotJson) > 8 * mib) fail(413, "Текст отчёта превышает лимит 8 МиБ");

  let total = 0;
  const files = unique(array(body.files, 250).map((entry) => {
    const file = direct ? {
      ...attachmentMetadata(entry), size: entry.size, sha256: entry.sha256,
    } : attachmentPayload(entry, 50 * mib, "Размер одного вложения превышает 50 МиБ");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 50 * mib) {
      fail(413, "Размер одного вложения превышает 50 МиБ");
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail(400, "Некорректная контрольная сумма вложения");
    total += file.size;
    if (total > 90 * mib) fail(413, "Общий размер вложений превышает 90 МиБ");
    return file;
  }));
  if (files.length !== usedFiles.size || files.some(({ id }) => !usedFiles.has(id))) {
    fail(400, "Отчёт содержит отсутствующее или лишнее вложение");
  }
  const reportId = typeof body.reportId === "string" && /^[a-f0-9]{7,8}$/.test(body.reportId) ? body.reportId : null;
  return { document, snapshotJson, files, reportId, issueKey: storageIssueKey(body.snapshot.issueUrl) };
}

function secretsFor(publishKey) {
  const secret = (purpose) => createHmac("sha256", publishKey).update("qa-report-share:" + purpose).digest("base64url");
  return {
    id: digest(secret("id")).slice(0, 32),
    readToken: secret("read"),
    replyToken: secret("reply"),
    ownerToken: secret("owner"),
  };
}

function bearer(request) {
  return /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";
}

function tokenMatches(token, expectedHash) {
  return timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(expectedHash, "hex"));
}

function answerFromRow(row) {
  return {
    sectionId: row.section_id, rowId: row.row_id, status: normalizeAnswerStatus(row.status), comment: row.comment,
    revision: row.revision, updatedAt: row.updated_at,
    ...(row.comment_document == null ? {} : { commentDocument: JSON.parse(row.comment_document) }),
  };
}

function answerFileFromRow(row) {
  return { id: row.id, sectionId: row.section_id, rowId: row.row_id, name: row.name, type: row.type, size: row.size };
}

function initializeSharing(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_publications (
      id TEXT PRIMARY KEY,
      payload_digest TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      read_hash TEXT NOT NULL,
      reply_hash TEXT NOT NULL,
      owner_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      ready_at TEXT,
      revoked_at TEXT,
      reuse_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS shared_report_answers (
      publication_id TEXT NOT NULL REFERENCES shared_publications(id),
      section_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      status TEXT NOT NULL,
      comment TEXT NOT NULL,
      comment_document TEXT,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (publication_id, section_id, row_id)
    );
    CREATE TABLE IF NOT EXISTS shared_report_verified_files (
      publication_id TEXT NOT NULL REFERENCES shared_publications(id),
      file_id TEXT NOT NULL,
      PRIMARY KEY (publication_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS shared_report_storage_cleanup (
      bucket_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      retry_after INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_id, object_key)
    );
    CREATE TABLE IF NOT EXISTS shared_report_answer_files (
      publication_id TEXT NOT NULL REFERENCES shared_publications(id),
      id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      bucket_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (publication_id, id)
    );
  `);
  for (const [table, column, type = "TEXT"] of [
    ["shared_report_answers", "comment_document"], ["shared_report_answer_files", "deleted_at"],
    ["shared_publications", "published_at"], ["shared_publications", "reuse_until", "INTEGER"],
    ["shared_publications", "author_id"], ["shared_publications", "published_update_at"],
    ["shared_publications", "update_of"], ["shared_publications", "update_base"],
    ["shared_publications", "storage_prefix"],
  ]) {
    const exists = () => db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
    if (!exists()) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (error) {
        // Another server process may have added the column after the schema check.
        if (!exists()) throw error;
      }
    }
  }
}

function initializeAuthors(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_report_authors (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    invite_hash TEXT UNIQUE,
    invite_expires INTEGER NOT NULL,
    session_hash TEXT UNIQUE,
    session_expires INTEGER
  )`);
}

function createAuthorInvite(db, label) {
  initializeAuthors(db);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  db.prepare("DELETE FROM shared_report_authors WHERE COALESCE(session_expires, invite_expires) <= ?").run(Date.now());
  db.prepare("INSERT INTO shared_report_authors (id, label, invite_hash, invite_expires) VALUES (?, ?, ?, ?)")
    .run(id, label, digest(token), Date.now() + 24 * 60 * 60 * 1000);
  return { id, token };
}

function revokeAuthorAccess(db, id) {
  initializeAuthors(db);
  return Boolean(db.prepare("DELETE FROM shared_report_authors WHERE id = ?").run(id).changes);
}

function createPublicationSettings({ getDb, configPath }) {
  let initializedDb;
  function settingsDb() {
    const connection = getDb();
    if (initializedDb !== connection) {
      connection.exec(`CREATE TABLE IF NOT EXISTS shared_report_storage_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        publish_enabled INTEGER NOT NULL DEFAULT 1 CHECK(publish_enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS shared_report_user_settings (
        user_id TEXT PRIMARY KEY NOT NULL, publish TEXT NOT NULL CHECK(publish IN ('role', 'allow', 'deny')),
        uploads_enabled INTEGER NOT NULL CHECK(uploads_enabled IN (0, 1))
      )`);
      const hasPublish = () => connection.prepare("PRAGMA table_info(shared_report_storage_settings)").all().some(column => column.name === "publish_enabled");
      if (!hasPublish()) {
        try { connection.exec("ALTER TABLE shared_report_storage_settings ADD COLUMN publish_enabled INTEGER NOT NULL DEFAULT 1 CHECK(publish_enabled IN (0, 1))"); }
        catch (error) { if (!hasPublish()) throw error; }
      }
      initializedDb = connection;
    }
    return connection;
  }
  function get() {
    if (!configPath) return { configured: false, enabled: false, publishEnabled: false };
    const state = settingsDb().prepare("SELECT enabled, publish_enabled FROM shared_report_storage_settings WHERE id = 1").get();
    return { configured: true, enabled: state?.enabled !== 0, publishEnabled: state?.publish_enabled !== 0 };
  }
  function getUser(userId) {
    const state = userId && settingsDb().prepare("SELECT publish, uploads_enabled FROM shared_report_user_settings WHERE user_id = ?").get(userId);
    return { publish: state?.publish || "role", uploadsEnabled: state?.uploads_enabled !== 0 };
  }
  return {
    get, getUser,
    set(update) {
      if (!configPath) fail(409, "Хранилище S3 не настроено");
      const { enabled, publishEnabled } = update;
      const flag = value => value === undefined ? null : Number(value);
      settingsDb().prepare(`INSERT INTO shared_report_storage_settings (id, enabled, publish_enabled)
        VALUES (1, COALESCE(?, 1), COALESCE(?, 1))
        ON CONFLICT(id) DO UPDATE SET enabled = COALESCE(?, enabled), publish_enabled = COALESCE(?, publish_enabled)`)
        .run(flag(enabled), flag(publishEnabled), flag(enabled), flag(publishEnabled));
      return get();
    },
    setUser(userId, { publish, uploadsEnabled }) {
      settingsDb().prepare(`INSERT INTO shared_report_user_settings VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET publish = excluded.publish, uploads_enabled = excluded.uploads_enabled`)
        .run(userId, publish, Number(uploadsEnabled));
      return getUser(userId);
    },
  };
}

function createReportSharing({ getDb, readJson, sendJson, requestOrigin, allowLocal, publisherToken = "", configPath, storageLoader = loadReportStorage, uploadLimits = {},
  showPage, cleanupIntervalMs = 0, reportAccount, publisherIdentity, authorEmail, projectAccess, publicationSettings = createPublicationSettings({ getDb, configPath }) }) {
  const maxProxiedFileBytes = uploadLimits.fileBytes ?? 512 * 1024;
  const maxProxiedBatchBytes = uploadLimits.batchBytes ?? 720 * 1024;
  const maxProxiedRequestBytes = uploadLimits.requestBytes ?? mib - 8192;
  const activePublications = new Set();
  const activeFileVerifications = new Set();
  let activeUploadBatches = 0;
  const activeCleanup = new Map();
  let drainingCleanup = false;
  let activeAnswerUploads = 0;
  let initializedDb;
  const referencedPublicationObjects = `
    SELECT json_extract(file.value, '$.bucketId'), json_extract(file.value, '$.key')
    FROM shared_publications AS report, json_each(report.manifest_json) AS file
    WHERE report.revoked_at IS NULL AND (report.update_of IS NULL OR report.ready_at IS NULL)`;

  function db() {
    const connection = getDb();
    if (initializedDb !== connection) {
      initializeSharing(connection);
      initializeAuthors(connection);
      initializedDb = connection;
    }
    return connection;
  }

  function storage() {
    if (!configPath) fail(503, "Хранилище для публикаций по ссылке не настроено");
    try {
      return storageLoader(configPath);
    } catch {
      fail(503, "Хранилище для публикаций по ссылке недоступно");
    }
  }

  function requireStorageWrites(authorId, state = publicationSettings.get()) {
    if (state.configured && !state.enabled) {
      fail(503, "Загрузка новых вложений приостановлена. Отчёт можно опубликовать без новых файлов.", "REPORT_STORAGE_PAUSED");
    }
    if (!publicationSettings.getUser(authorId).uploadsEnabled) {
      fail(403, "Для вашего аккаунта отключена загрузка новых вложений.", "REPORT_USER_STORAGE_DENIED");
    }
  }

  function requirePublishingAllowed(authorId) {
    const state = publicationSettings.get();
    if (state.configured && !state.publishEnabled) {
      fail(503, "Администратор приостановил публикацию и обновление отчётов по ссылке.", "REPORT_PUBLICATION_PAUSED");
    }
    if (publicationSettings.getUser(authorId).publish === "deny") {
      fail(403, "Для вашего аккаунта отключена публикация и обновление отчётов по ссылке.", "REPORT_USER_PUBLICATION_DENIED");
    }
  }

  function withWriteTransaction(action) {
    const connection = db();
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = action(connection);
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  async function removeQueuedObject(bucket, reference) {
    const { bucketId, key } = reference;
    const identity = JSON.stringify([bucketId, key]);
    if (activeCleanup.has(identity)) return activeCleanup.get(identity);
    const job = (async () => {
      try {
        await bucket.remove(reference);
      } catch (error) {
        if (error.storageStatus !== 404) {
          db().prepare("UPDATE shared_report_storage_cleanup SET retry_after = ? WHERE bucket_id = ? AND object_key = ?")
            .run(Date.now() + 60_000, bucketId, key);
          return false;
        }
      }
      db().prepare("DELETE FROM shared_report_storage_cleanup WHERE bucket_id = ? AND object_key = ?").run(bucketId, key);
      return true;
    })();
    activeCleanup.set(identity, job);
    try {
      return await job;
    } finally {
      activeCleanup.delete(identity);
    }
  }

  async function drainStorageCleanup() {
    if (drainingCleanup) return;
    drainingCleanup = true;
    try {
      const due = db().prepare(`SELECT bucket_id AS bucketId, object_key AS key
        FROM shared_report_storage_cleanup WHERE retry_after <= ? ORDER BY retry_after LIMIT 4`);
      const claim = db().prepare(`UPDATE shared_report_storage_cleanup SET retry_after = ?
        WHERE bucket_id = ? AND object_key = ? AND retry_after <= ?`);
      let bucket;
      for (let batch = due.all(Date.now()); batch.length; batch = due.all(Date.now())) {
        bucket ??= storage();
        const now = Date.now();
        await Promise.all(batch.filter(({ bucketId, key }) => claim.run(now + 60_000, bucketId, key, now).changes)
          .map(reference => removeQueuedObject(bucket, reference)));
      }
    } catch {
      // The queue stays in SQLite so a later sweep can retry.
    } finally {
      drainingCleanup = false;
    }
  }

  function revokePublication(id) {
    withWriteTransaction(connection => {
      const now = Date.now();
      const until = now + revokedFileRetentionMs;
      const revoked = connection.prepare(`UPDATE shared_publications SET revoked_at = ?, reuse_until = ?
        WHERE revoked_at IS NULL AND (id = ? OR (update_of = ? AND ready_at IS NULL))`)
        .run(new Date(now).toISOString(), until, id, id);
      if (!revoked.changes) return;
      connection.prepare(`WITH candidates AS (
        SELECT json_extract(file.value, '$.bucketId') AS bucket_id, json_extract(file.value, '$.key') AS object_key,
          CASE WHEN report.ready_at IS NOT NULL OR json_extract(file.value, '$.reused') OR EXISTS (
            SELECT 1 FROM shared_report_verified_files
            WHERE publication_id = report.id AND file_id = json_extract(file.value, '$.id')
          ) THEN ? ELSE ? END AS retry_after
          FROM shared_publications AS report, json_each(report.manifest_json) AS file
          WHERE report.id = ? OR (report.update_of = ? AND report.ready_at IS NULL)
        UNION SELECT bucket_id, object_key, 0 FROM shared_report_answer_files WHERE publication_id = ?
      ), unreferenced AS (
        SELECT bucket_id, object_key FROM candidates EXCEPT ${referencedPublicationObjects}
      )
      INSERT OR IGNORE INTO shared_report_storage_cleanup (bucket_id, object_key, retry_after)
        SELECT bucket_id, object_key, max(retry_after) FROM candidates
        JOIN unreferenced USING (bucket_id, object_key) GROUP BY bucket_id, object_key`).run(until, now + 120_000, id, id, id);
    });
  }

  function localRequest(request) {
    return allowLocal &&
      /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? "") &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) &&
      !request.headers.forwarded && !request.headers["x-forwarded-for"] && !request.headers["x-forwarded-host"] &&
      !request.headers["x-forwarded-proto"];
  }

  function requireJson(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) fail(415, "Ожидается JSON");
  }

  function publication(id) {
    return db().prepare("SELECT * FROM shared_publications WHERE id = ?").get(id);
  }

  function authorize(request, id) {
    const token = bearer(request);
    if (!tokenPattern.test(token)) fail(404, "Публикация недоступна");
    const row = publication(id);
    if (!row || row.update_of || !(row.published_at || row.ready_at)) fail(404, "Публикация недоступна");
    const delegated = projectAccess?.(request, row);
    if (delegated) return { row, owner: false, canReply: delegated.canReply };
    const owner = tokenMatches(token, row.owner_hash);
    const canReply = owner || tokenMatches(token, row.reply_hash);
    if (!canReply && !tokenMatches(token, row.read_hash)) fail(404, "Публикация недоступна");
    return { row, owner, canReply };
  }

  function hasPublisherToken(request) {
    return Boolean(publisherToken && tokenMatches(bearer(request), digest(publisherToken)));
  }

  function authorSession(request) {
    const cookie = request.headers.cookie?.match(/(?:^|;\s*)__Host-qa-report-author=([A-Za-z0-9_-]{43})(?=;|$)/)?.[1];
    return Boolean(cookie && db().prepare("SELECT 1 FROM shared_report_authors WHERE session_hash = ? AND session_expires > ?")
      .get(digest(cookie), Date.now()));
  }

  function trustedPublisher(request) {
    return hasPublisherToken(request) || (!publisherIdentity && !reportAccount && !publisherToken && localRequest(request));
  }

  async function requireReportAccount(request) {
    if (request.headers.origin !== reportAccount.origin) fail(403, "Откройте приложение на адресе QA Report.");
    const account = await reportAccount.session(request);
    if (!account) fail(401, "Войдите в QA Report по коду из письма.", "REPORT_SIGN_IN_REQUIRED");
    return account;
  }

  async function requirePublisher(request, { write = true } = {}) {
    let authorId = null;
    if (publisherIdentity) {
      const account = await publisherIdentity(request);
      if (!account?.id) fail(401, "Войдите в QA Report.");
      authorId = account.id;
    } else if (!trustedPublisher(request)) {
      if (reportAccount) {
        const account = await requireReportAccount(request);
        authorId = account.id;
        const { publish } = publicationSettings.getUser(authorId);
        if (write && publish === "deny") requirePublishingAllowed(authorId);
        if (!account.canPublish && publish !== "allow") {
          fail(403, "Попросите администратора открыть вам доступ к публикации.", "REPORT_PUBLISH_ACCESS_REQUIRED");
        }
      } else if (!(request.headers.origin === requestOrigin(request) && authorSession(request))) {
        fail(403, "Для публикации нужен доступ автора QA Report. Откройте приглашение в этом браузере.");
      }
    }
    requireJson(request);
    if (write) requirePublishingAllowed(authorId);
    return authorId;
  }

  async function redeemInvite(request, response) {
    if (publisherIdentity) fail(410, "Для публикации используйте корпоративный вход в QA Report.");
    if (reportAccount) fail(410, "Войдите в QA Report по коду из письма. Доступ к публикации выдаёт администратор.");
    if (!configPath || !requestOrigin(request).startsWith("https://") || request.headers.origin !== requestOrigin(request)) {
      fail(403, "Откройте приглашение по HTTPS на адресе QA Report.");
    }
    requireJson(request);
    const { token } = await readJson(request, 4096);
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(400, "Некорректное приглашение");
    const session = randomBytes(32).toString("base64url");
    const now = Date.now();
    const activated = db().prepare(`UPDATE shared_report_authors SET invite_hash = NULL, session_hash = ?, session_expires = ?
      WHERE invite_hash = ? AND invite_expires > ? RETURNING id`)
      .get(digest(session), now + authorSessionSeconds * 1000, digest(token), now);
    if (!activated) fail(410, "Приглашение уже использовано или срок его действия истёк.");
    response.setHeader("Set-Cookie", `${authorCookie}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${authorSessionSeconds}`);
  }

  function publicationAccess(body) {
    if (typeof body?.publishKey !== "string" || !tokenPattern.test(body.publishKey)) fail(400, "Некорректный ключ операции публикации");
    return secretsFor(body.publishKey);
  }

  function checkPublicationAuthor(row, authorId, ownerToken) {
    if ((reportAccount || publisherIdentity) && row?.author_id && row.author_id !== authorId) {
      if (ownerToken && tokenMatches(ownerToken, row.owner_hash)) {
        fail(403, "Эту ссылку опубликовали из другого аккаунта. Войдите в аккаунт автора, чтобы обновить отчёт.", "SHARE_PUBLICATION_ACCOUNT_MISMATCH");
      }
      fail(404, "Публикация не найдена");
    }
  }

  async function recover(request) {
    const authorId = await requirePublisher(request, { write: false });
    const body = await readJson(request, 4096);
    const access = publicationAccess(body);
    const row = publication(access.id);
    checkPublicationAuthor(row, authorId);
    if ((reportAccount || publisherIdentity) && row?.update_of) checkPublicationAuthor(publication(row.update_of), authorId);
    if (row?.revoked_at) fail(410, "Публикация отозвана");
    if (!row?.ready_at && !(body.allowPending === true && row?.published_at)) fail(404, "Публикация не была завершена");
    return publicationLink(access, row);
  }

  const fileContentKey = ({ sha256, size }) => `${sha256}:${size}`;

  function reusablePublicationFiles(sources, bucket) {
    const reusable = new Map();
    if (!Array.isArray(sources)) return reusable;
    const sourceRow = db().prepare(`SELECT owner_hash, ready_at, manifest_json FROM shared_publications
      WHERE id = ? AND update_of IS NULL AND (revoked_at IS NULL OR reuse_until > ?)`);
    for (const { id, ownerToken } of sources.slice(0, maxReuseSources).filter(item => item && typeof item === "object")) {
      if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) ||
          typeof ownerToken !== "string" || !tokenPattern.test(ownerToken)) continue;
      const source = sourceRow.get(id, Date.now());
      if (!source || !tokenMatches(ownerToken, source.owner_hash)) continue;
      const manifest = JSON.parse(source.manifest_json);
      const verified = source.ready_at ? null : verifiedFiles(id, manifest);
      for (const file of manifest) {
        const key = fileContentKey(file);
        if ((!verified || verified.has(file.id)) && bucket.hasBucket(file.bucketId) && !reusable.has(key)) {
          reusable.set(key, { bucketId: file.bucketId, key: file.key });
        }
      }
    }
    return reusable;
  }

  function reservePublication(access, { document, snapshotJson, files, reportId, issueKey }, bucket, authorId, reuseFrom, batchUploads = false, update) {
    requirePublishingAllowed(authorId);
    const metadata = files.map(({ bytes, ...file }) => file);
    const uploadState = publicationSettings.get();
    // A retry may recapture the edit time; keep the metadata from the first attempt.
    const payloadDigest = digest(JSON.stringify([document, metadata]));
    return withWriteTransaction(connection => {
      let target;
      if (update !== undefined) {
        if (typeof update?.id !== "string" || !/^[a-f0-9]{32}$/.test(update.id) ||
            typeof update.ownerToken !== "string" || !tokenPattern.test(update.ownerToken)) {
          fail(400, "Некорректные данные для обновления отчёта");
        }
        target = publication(update.id);
        if (!target || target.update_of || !target.ready_at || !tokenMatches(update.ownerToken, target.owner_hash)) {
          fail(404, "Публикация не найдена");
        }
        checkPublicationAuthor(target, authorId, update.ownerToken);
        if (target.revoked_at) fail(410, "Публикация отозвана");
      }
      const previous = publication(access.id);
      if (previous) {
        checkPublicationAuthor(previous, authorId, access.ownerToken);
        if (previous.revoked_at) fail(410, "Публикация отозвана");
        if (previous.payload_digest !== payloadDigest || previous.update_of !== (target?.id ?? null)) {
          fail(409, target ? "Черновик изменился. Начните обновление заново."
            : "Содержимое изменилось. Опубликуйте текущую версию по новой ссылке.", "SHARE_SNAPSHOT_CHANGED");
        }
        return previous;
      }
      const reusable = reusablePublicationFiles(reuseFrom, bucket);
      const publicationId = target?.id ?? access.id;
      const prefix = storagePrefix(publicationId, reportId, issueKey);
      const revisionPrefix = target ? `${prefix}/updates/${access.id}` : prefix;
      const manifest = metadata.map(file => {
        const saved = reusable.get(fileContentKey(file));
        return saved ? { ...file, ...saved, reused: true }
          : { ...file, bucketId: bucket.activeBucketId, key: `${revisionPrefix}/files/${file.id}`,
            ...(batchUploads && file.size <= maxProxiedFileBytes && { batchUpload: true }) };
      });
      if (manifest.some(file => !file.reused)) requireStorageWrites(authorId, uploadState);
      const cancelCleanup = connection.prepare("DELETE FROM shared_report_storage_cleanup WHERE bucket_id = ? AND object_key = ?");
      for (const file of manifest) if (file.reused) cancelCleanup.run(file.bucketId, file.key);
      connection.prepare(`INSERT INTO shared_publications
        (id,payload_digest,snapshot_json,manifest_json,read_hash,reply_hash,owner_hash,created_at,author_id,update_of,update_base,storage_prefix)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(access.id, payloadDigest, snapshotJson, JSON.stringify(manifest), digest(access.readToken),
          digest(access.replyToken), digest(access.ownerToken), new Date().toISOString(), authorId,
          target?.id ?? null, target?.published_update_at ?? null, prefix);
      return publication(access.id);
    });
  }

  function finishPublication(access) {
    const ready = db().prepare(`UPDATE shared_publications SET ready_at = COALESCE(ready_at, ?)
      WHERE id = ? AND revoked_at IS NULL RETURNING *`).get(new Date().toISOString(), access.id);
    if (!ready) fail(410, "Публикация отозвана");
    return publicationLink(access, ready);
  }

  function publicationLink(access, row) {
    const target = row.update_of ? publication(row.update_of) : row;
    if (target.revoked_at) fail(410, "Публикация отозвана");
    return {
      ...(row.update_of ? { id: target.id } : access),
      createdAt: target.published_at || target.ready_at,
      ...(target.published_update_at && { updatedAt: target.published_update_at }),
      ...(!target.ready_at && { attachmentsPending: true }),
    };
  }

  function finishUpdate(access) {
    // Keep the published ID and its replies while switching the snapshot and files together.
    const completed = withWriteTransaction(connection => {
      const stage = publication(access.id);
      const target = publication(stage.update_of);
      if (stage.revoked_at || target.revoked_at) fail(410, "Публикация отозвана");
      if (stage.ready_at) return stage;
      if (target.published_update_at !== stage.update_base) return null;
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(target.published_update_at) || 0) + 1)).toISOString();
      connection.prepare(`UPDATE shared_publications SET snapshot_json = ?, manifest_json = ?, published_update_at = ?, storage_prefix = ?
        WHERE id = ?`).run(stage.snapshot_json, stage.manifest_json, updatedAt, stage.storage_prefix, target.id);
      connection.prepare("UPDATE shared_publications SET ready_at = ?, snapshot_json = '{}' WHERE id = ?").run(updatedAt, stage.id);
      connection.prepare(`WITH candidates AS (
          SELECT json_extract(value, '$.bucketId'), json_extract(value, '$.key') FROM json_each(?)
          EXCEPT ${referencedPublicationObjects}
        )
        INSERT OR IGNORE INTO shared_report_storage_cleanup (bucket_id, object_key, retry_after)
          SELECT *, ? FROM candidates`).run(target.manifest_json, Date.now() + revokedFileRetentionMs);
      return publication(stage.id);
    });
    if (!completed) {
      revokePublication(access.id);
      fail(409, "Отчёт уже обновили. Начните обновление заново.", "SHARE_UPDATE_SUPERSEDED");
    }
    return publicationLink(access, completed);
  }

  function markVerified(publicationId, fileId) {
    const record = db().prepare(`INSERT OR IGNORE INTO shared_report_verified_files (publication_id, file_id)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM shared_publications WHERE id = ? AND revoked_at IS NULL)`)
      .run(publicationId, fileId, publicationId);
    if (!record.changes && publication(publicationId)?.revoked_at) fail(410, "Публикация отозвана");
  }

  async function publish(request) {
    const authorId = await requirePublisher(request);
    const body = await readJson(request);
    const access = publicationAccess(body);
    const payload = publicationPayload(body);
    if (activePublications.has(access.id)) fail(409, "Публикация уже выполняется. Повторите позже.");
    if (activePublications.size >= 2) fail(503, "Сервер уже готовит публикации. Повторите позже.");
    const bucket = storage();
    const pinned = reservePublication(access, payload, bucket, authorId);
    if (pinned.ready_at) return publicationLink(access, pinned);
    const objects = JSON.parse(pinned.manifest_json);
    const verified = verifiedFiles(access.id, objects);
    activePublications.add(access.id);
    try {
      for (const [index, file] of objects.entries()) {
        if (verified.has(file.id)) continue;
        if (publication(access.id).revoked_at) fail(410, "Публикация отозвана");
        requirePublishingAllowed(authorId);
        requireStorageWrites(authorId);
        try {
          await bucket.put(file.key, payload.files[index].bytes, { bucketId: file.bucketId });
        } catch {
          fail(502, `Не удалось сохранить вложение «${file.name}». Повторите публикацию.`);
        }
        markVerified(access.id, file.id);
      }
      requirePublishingAllowed(authorId);
      return finishPublication(access);
    } finally {
      activePublications.delete(access.id);
    }
  }

  const stagingObject = (publicationId, file) => ({
    bucketId: file.bucketId, key: `shared-report-uploads/${publicationId}/${file.id}`,
  });

  function verifiedFiles(id, manifest) {
    const verified = new Set(db().prepare("SELECT file_id FROM shared_report_verified_files WHERE publication_id = ?").all(id)
      .map(({ file_id }) => file_id));
    for (const file of manifest) if (file.reused) verified.add(file.id);
    return verified;
  }

  async function preparePublication(request) {
    const authorId = await requirePublisher(request);
    const body = await readJson(request, 16 * mib);
    const access = publicationAccess(body);
    const payload = publicationPayload(body, true);
    const bucket = storage();
    const batchUploads = body.batchUploads === true;
    const row = reservePublication(access, payload, bucket, authorId, body.reuseFrom, batchUploads, body.update);
    if (row.ready_at) return { publication: publicationLink(access, row) };
    const manifest = JSON.parse(row.manifest_json);
    const verified = verifiedFiles(access.id, manifest);
    const pending = manifest.filter(file => !verified.has(file.id));
    if (pending.length) requireStorageWrites(authorId);
    const uploads = pending.map(file =>
      batchUploads && file.batchUpload ? { id: file.id, viaServer: true }
        : { id: file.id, url: bucket.uploadUrl(stagingObject(access.id, file), file.size) });
    if (row.update_of && !uploads.length) return { publication: finishUpdate(access) };
    if (body.earlyLink === true && !uploads.length) return { publication: finishPublication(access) };
    let visible = row;
    if (!row.update_of && body.earlyLink === true && !row.published_at) {
      visible = db().prepare(`UPDATE shared_publications SET published_at = COALESCE(published_at, ?)
        WHERE id = ? AND revoked_at IS NULL RETURNING published_at, ready_at`).get(new Date().toISOString(), access.id);
      if (!visible) fail(410, "Публикация отозвана");
    }
    return { uploads,
      ...(uploads.some(file => file.viaServer) && { batchUploadBytes: maxProxiedBatchBytes }),
      ...(visible.published_at && { publication: publicationLink(access, visible) }) };
  }

  async function verifyFile(publicationId, file, verified, action) {
    if (!file) fail(404, "Вложение не найдено в этой публикации");
    if (publication(publicationId).revoked_at) fail(410, "Публикация отозвана");
    if (verified || db().prepare("SELECT 1 FROM shared_report_verified_files WHERE publication_id = ? AND file_id = ?")
      .get(publicationId, file.id)) return;
    if (activeFileVerifications.has(file.key)) fail(409, "Вложение уже проверяется. Повторите попытку.");
    if (activeFileVerifications.size >= 6) fail(503, "Сервер проверяет другие вложения. Повторите попытку.");
    activeFileVerifications.add(file.key);
    try {
      await action();
    } finally {
      activeFileVerifications.delete(file.key);
    }
  }

  async function saveVerifiedFile(publicationId, file, bytes, bucket, authorId) {
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail(422, "Контрольная сумма вложения не совпала");
    if (publication(publicationId).revoked_at) fail(410, "Публикация отозвана");
    requirePublishingAllowed(authorId);
    requireStorageWrites(authorId);
    try {
      await bucket.put(file.key, bytes, { bucketId: file.bucketId });
    } catch {
      fail(502, `Не удалось сохранить вложение «${file.name}»`);
    }
    markVerified(publicationId, file.id);
  }

  function confirmFile(publicationId, file, verified, bucket, authorId) {
    return verifyFile(publicationId, file, verified, async () => {
      requireStorageWrites(authorId);
      const staging = stagingObject(publicationId, file);
      let remote;
      try {
        remote = await bucket.get(staging);
      } catch (error) {
        if (error.storageStatus === 404) fail(404, "Файл ещё не загружен");
        fail(502, `Не удалось прочитать вложение «${file.name}» из хранилища`);
      }
      const bytes = Buffer.allocUnsafe(file.size);
      let size = 0;
      try {
        for await (const chunk of remote.body ?? []) {
          if (size + chunk.length > file.size) fail(422, "Размер загруженного файла отличается");
          bytes.set(chunk, size);
          size += chunk.length;
        }
      } catch (error) {
        if (error.status === 422) throw error;
        fail(502, `Не удалось проверить вложение «${file.name}»`);
      }
      if (size !== file.size) fail(422, "Размер загруженного файла отличается");
      await saveVerifiedFile(publicationId, file, bytes, bucket, authorId);
      await bucket.remove(staging).catch(() => {});
    });
  }

  async function fileResult(id, action) {
    try {
      await action();
      return { id, status: 200 };
    } catch (error) {
      if (!error.status) throw error;
      return { id, status: error.status, error: error.message };
    }
  }

  async function confirmFiles(row, body, authorId) {
    const single = body.fileIds === undefined;
    const ids = single ? [identifier(body.fileId)] : array(body.fileIds, maxFileConfirmationBatch).map(identifier);
    if (!ids.length || new Set(ids).size !== ids.length) fail(400, "Укажите разные вложения для проверки");
    const manifest = JSON.parse(row.manifest_json);
    const files = new Map(manifest.map(file => [file.id, file]));
    const verified = verifiedFiles(row.id, manifest);
    const pending = ids.some(id => files.has(id) && !row.ready_at && !verified.has(id));
    const bucket = pending ? storage() : null;
    const confirm = id => confirmFile(row.id, files.get(id), Boolean(row.ready_at) || verified.has(id), bucket, authorId);
    if (single) {
      await confirm(ids[0]);
      return {};
    }
    const results = [];
    for (let index = 0; index < ids.length; index += parallelFileConfirmations) {
      const group = ids.slice(index, index + parallelFileConfirmations);
      const checked = await Promise.all(group.map(id => fileResult(id, () => confirm(id))));
      results.push(...checked);
    }
    return { results };
  }

  async function uploadFileBatch(request) {
    const authorId = await requirePublisher(request);
    if (activeUploadBatches >= maxActiveUploadBatches) fail(503, "Сервер загружает другие вложения. Повторите попытку.");
    activeUploadBatches++;
    try {
      const body = await readJson(request, maxProxiedRequestBytes);
      const row = publication(publicationAccess(body).id);
      checkPublicationAuthor(row, authorId);
      if (!row) fail(404, "Публикация не найдена");
      if (row.revoked_at) fail(410, "Публикация отозвана");
      const entries = unique(array(body.files, parallelFileConfirmations).map(entry => ({
        id: identifier(entry?.id), data: entry.data,
      })));
      if (!entries.length) fail(400, "Укажите вложения для загрузки");
      const manifest = JSON.parse(row.manifest_json);
      const files = new Map(manifest.map(file => [file.id, file]));
      const total = entries.reduce((size, entry) => size + (files.get(entry.id)?.size ?? 0), 0);
      if (total > maxProxiedBatchBytes) fail(413, "Пакет вложений превышает допустимый размер");
      const verified = verifiedFiles(row.id, manifest);
      const bucket = entries.some(({ id }) => files.get(id)?.batchUpload && !row.ready_at && !verified.has(id)) ? storage() : null;
      const results = await Promise.all(entries.map(({ id, data }) => fileResult(id, async () => {
        const file = files.get(id);
        if (!file) fail(404, "Вложение не найдено в этой публикации");
        if (!file.batchUpload) fail(400, "Для этого вложения нужна прямая загрузка");
        await verifyFile(row.id, file, Boolean(row.ready_at) || verified.has(id), () => {
          const encoded = str(data, Math.ceil(file.size / 3) * 4);
          const bytes = Buffer.from(encoded, "base64");
          if (bytes.toString("base64") !== encoded) fail(400, "Некорректные данные вложения");
          return saveVerifiedFile(row.id, file, bytes, bucket, authorId);
        });
      })));
      return { results };
    } finally {
      activeUploadBatches--;
    }
  }

  async function completePublication(request, confirmingFile) {
    const authorId = await requirePublisher(request);
    const body = await readJson(request, 4096);
    const access = publicationAccess(body);
    const row = publication(access.id);
    checkPublicationAuthor(row, authorId);
    if (!row) fail(404, "Публикация не найдена");
    if (row.revoked_at) fail(410, "Публикация отозвана");
    requirePublishingAllowed(authorId);
    if (confirmingFile) return confirmFiles(row, body, authorId);
    if (row.ready_at) return { publication: publicationLink(access, row) };
    const manifest = JSON.parse(row.manifest_json);
    if (manifest.length !== verifiedFiles(access.id, manifest).size) fail(409, "Дождитесь загрузки всех вложений");
    return { publication: row.update_of ? finishUpdate(access) : finishPublication(access) };
  }

  function authorizeAnswer(request, id) {
    requireJson(request);
    const { row, canReply } = authorize(request, id);
    if (row.revoked_at) fail(404, "Публикация недоступна");
    if (!canReply) fail(403, "Эта ссылка даёт доступ только на просмотр");
    return row;
  }

  function requirePoint(row, sectionId, rowId) {
    const section = JSON.parse(row.snapshot_json).sections.find((item) => item.id === sectionId);
    if (!section?.rows.some((item) => item.id === rowId)) fail(404, "Пункт не найден");
  }

  async function answer(request, id) {
    const row = authorizeAnswer(request, id);
    const body = await readJson(request, 128 * 1024);
    projectAccess?.(request, publication(id));
    const sectionId = identifier(body?.sectionId);
    const rowId = identifier(body?.rowId);
    const { revision } = body;
    const status = normalizeAnswerStatus(body.status);
    const comment = str(body.comment, maxCommentLength);
    if (!answerStatuses.has(status) || !Number.isSafeInteger(revision) || revision < 0) fail(400, "Некорректный статус или версия ответа");
    requirePoint(row, sectionId, rowId);
    const commentDocument = commentDocumentJson(body.commentDocument, fileId => {
      const file = answerFile(id, fileId);
      return file?.section_id === sectionId && file.row_id === rowId ? file : null;
    });
    const preserveDocument = body.commentDocument === undefined ? 1 : 0;
    const now = new Date().toISOString();
    const changed = revision === 0
      ? db().prepare(`INSERT INTO shared_report_answers
          (publication_id,section_id,row_id,status,comment,comment_document,revision,updated_at)
          SELECT ?,?,?,?,?,?,1,? WHERE EXISTS (SELECT 1 FROM shared_publications WHERE id=? AND revoked_at IS NULL)
          ON CONFLICT DO NOTHING RETURNING *`).get(id, sectionId, rowId, status, comment, commentDocument, now, id)
      : db().prepare(`UPDATE shared_report_answers SET status=?,comment=?,
          comment_document=CASE WHEN ? AND comment=? THEN comment_document ELSE ? END,
          revision=revision+1,updated_at=?
          WHERE publication_id=? AND section_id=? AND row_id=? AND revision=?
          AND EXISTS (SELECT 1 FROM shared_publications WHERE id=? AND revoked_at IS NULL) RETURNING *`)
        .get(status, comment, preserveDocument, comment, commentDocument, now, id, sectionId, rowId, revision, id);
    if (!changed) fail(409, "Ответ уже изменился. Загрузите актуальную версию пункта.");
    return answerFromRow(changed);
  }

  function answerFile(id, fileId) {
    return db().prepare("SELECT * FROM shared_report_answer_files WHERE publication_id = ? AND id = ?").get(id, fileId);
  }

  function repeatAnswerFile(existing, file, sectionId, rowId) {
    if (existing.deleted_at) fail(410, "Вложение уже удалено");
    if (existing.section_id !== sectionId || existing.row_id !== rowId || existing.sha256 !== file.sha256 ||
        existing.name !== file.name || existing.type !== file.type) fail(409, "Это вложение уже загружено с другими данными");
    return answerFileFromRow(existing);
  }

  function checkAnswerFileQuota(id, sectionId, rowId, size) {
    const quota = db().prepare(`SELECT COUNT(*) FILTER (WHERE section_id = ? AND row_id = ?) AS point_count,
      COUNT(*) AS report_count, COALESCE(SUM(size), 0) AS total
      FROM shared_report_answer_files WHERE publication_id = ? AND deleted_at IS NULL`).get(sectionId, rowId, id);
    if (quota.point_count >= maxAnswerFilesPerPoint) fail(413, "К одному пункту можно прикрепить до 10 файлов");
    if (quota.report_count >= maxAnswerFiles) fail(413, "К ответам в отчёте можно прикрепить до 250 файлов");
    if (quota.total + size > maxAnswerFileTotal) fail(413, "Вложения к ответам превышают 100 МиБ");
  }

  async function uploadAnswerFile(request, id) {
    const row = authorizeAnswer(request, id);
    const account = publisherIdentity ? await publisherIdentity(request) : reportAccount && await requireReportAccount(request);
    if (activeAnswerUploads >= maxAnswerUploads) fail(503, "Сервер уже загружает вложения. Повторите позже.");
    activeAnswerUploads++;
    try {
      const body = await readJson(request, Math.ceil(maxAnswerFileBytes / 3) * 4 + 16 * 1024);
      const sectionId = identifier(body?.sectionId);
      const rowId = identifier(body?.rowId);
      requirePoint(row, sectionId, rowId);
      const file = attachmentPayload(body, maxAnswerFileBytes, "Размер вложения к ответу превышает 10 МиБ");
      if (!file.size) fail(400, "Нельзя прикрепить пустой файл");
      if (publication(id)?.revoked_at) fail(404, "Публикация недоступна");
      const existing = answerFile(id, file.id);
      if (existing) return repeatAnswerFile(existing, file, sectionId, rowId);
      checkAnswerFileQuota(id, sectionId, rowId, file.size);

      requireStorageWrites(account?.id);
      const bucket = storage();
      // Each attempt owns its object. Cleaning up a failed race cannot delete the winner's object.
      const prefix = row.storage_prefix || storagePrefix(id, null, storageIssueKey(JSON.parse(row.snapshot_json).issueUrl));
      const reference = { bucketId: bucket.activeBucketId, key: `${prefix}/answers/${randomUUID()}` };
      let saved;
      try {
        try {
          await bucket.put(reference.key, file.bytes, { bucketId: reference.bucketId });
        } catch {
          fail(502, "Не удалось сохранить вложение. Повторите загрузку.");
        }
        saved = db().prepare(`INSERT INTO shared_report_answer_files
          (publication_id,id,section_id,row_id,name,type,size,sha256,bucket_id,object_key)
          SELECT ?,?,?,?,?,?,?,?,?,?
          WHERE EXISTS (SELECT 1 FROM shared_publications WHERE id = ? AND COALESCE(published_at, ready_at) IS NOT NULL AND revoked_at IS NULL)
            AND (SELECT COUNT(*) FROM shared_report_answer_files WHERE publication_id = ? AND section_id = ? AND row_id = ? AND deleted_at IS NULL) < ?
            AND (SELECT COUNT(*) < ? AND COALESCE(SUM(size), 0) + ? <= ?
              FROM shared_report_answer_files WHERE publication_id = ? AND deleted_at IS NULL)
          ON CONFLICT DO NOTHING RETURNING *`).get(id, file.id, sectionId, rowId, file.name, file.type, file.size,
          file.sha256, reference.bucketId, reference.key, id, id, sectionId, rowId, maxAnswerFilesPerPoint,
          maxAnswerFiles, file.size, maxAnswerFileTotal, id);
        if (saved) return answerFileFromRow(saved);

        const current = publication(id);
        if (!(current?.published_at || current?.ready_at) || current.revoked_at) fail(404, "Публикация недоступна");
        const concurrent = answerFile(id, file.id);
        if (concurrent) return repeatAnswerFile(concurrent, file, sectionId, rowId);
        checkAnswerFileQuota(id, sectionId, rowId, file.size);
        fail(409, "Не удалось сохранить вложение. Повторите загрузку.");
      } finally {
        if (!saved) {
          try { await bucket.remove(reference); } catch { /* The attempt was never linked to the report. */ }
        }
      }
    } finally {
      activeAnswerUploads--;
    }
  }

  async function deleteAnswerFile(id, fileId) {
    const file = answerFile(id, fileId);
    if (!file) fail(404, "Вложение не найдено");
    const bucket = storage();
    withWriteTransaction(connection => {
      connection.prepare(`UPDATE shared_report_answer_files SET deleted_at = COALESCE(deleted_at, ?)
        WHERE publication_id = ? AND id = ?`).run(new Date().toISOString(), id, fileId);
      connection.prepare(`INSERT OR IGNORE INTO shared_report_storage_cleanup (bucket_id, object_key)
        VALUES (?, ?)`).run(file.bucket_id, file.object_key);
    });
    if (!await removeQueuedObject(bucket, { bucketId: file.bucket_id, key: file.object_key })) {
      fail(502, "Не удалось удалить файл из хранилища. Повторите удаление.");
    }
  }

  async function fileResponse(response, file) {
    if (!file) fail(404, "Вложение не найдено");
    let remote;
    try {
      remote = await storage().get({ bucketId: file.bucketId, key: file.key });
    } catch {
      fail(502, "Вложение временно недоступно");
    }
    const name = encodeURIComponent(file.name.toWellFormed()).replace(/[!'()*]/g, (character) =>
      "%" + character.charCodeAt(0).toString(16).toUpperCase());
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
      "Content-Length": file.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (!remote.body) return response.end();
    await pipeline(Readable.fromWeb(remote.body), response).catch(() => response.destroy());
  }

  if (configPath && cleanupIntervalMs) setInterval(drainStorageCleanup, cleanupIntervalMs).unref();

  return async function handle(request, response, pathname) {
    const method = request.method;
    if (/^\/shared-report\/[a-f0-9]{32}$/.test(pathname) && (method === "GET" || method === "HEAD")) {
      await showPage(request, response);
      return true;
    }
    if (pathname !== api && !pathname.startsWith(api + "/")) return false;
    if (request.headers.origin && request.headers.origin !== requestOrigin(request)) fail(403, "Запрос с другого сайта отклонён");
    if (pathname === api + "/account" && method === "GET") {
      sendJson(response, 200, { ok: true, publishableKey: reportAccount?.publishableKey || "" });
      return true;
    }
    if (pathname === api + "/availability" && method === "GET") {
      const trusted = trustedPublisher(request);
      const account = publisherIdentity ? await publisherIdentity(request) : configPath && !trusted && await reportAccount?.session(request);
      const { configured, enabled, publishEnabled } = publicationSettings.get();
      const personal = publicationSettings.getUser(account?.id);
      sendJson(response, 200, {
        ok: true,
        enabled: configured,
        ...(configured && !publishEnabled && { publicationPaused: true }),
        ...(personal.publish === "deny" && { publicationDenied: true }),
        ...(configured && (!enabled || !personal.uploadsEnabled) && { uploadsPaused: true }),
        requiresPublishToken: publisherIdentity ? !account?.id : !trusted && (reportAccount ? !(account?.canPublish || personal.publish === "allow") : !authorSession(request)),
        ...(configPath && reportAccount && { publishableKey: reportAccount.publishableKey, signedIn: Boolean(account) }),
      });
      return true;
    }
    if (pathname === api + "/author-invite" && method === "POST") {
      await redeemInvite(request, response);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (pathname === api + "/prepare" && method === "POST") {
      sendJson(response, 200, { ok: true, ...await preparePublication(request) });
      return true;
    }
    if (pathname === api + "/upload-batch" && method === "POST") {
      const start = performance.now();
      const result = await uploadFileBatch(request);
      response.setHeader("Server-Timing", `attachment-upload;dur=${(performance.now() - start).toFixed(1)}`);
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }
    if (method === "POST" && (pathname === api + "/confirm-file" || pathname === api + "/complete")) {
      const confirmingFile = pathname.endsWith("/confirm-file");
      const start = performance.now();
      const result = await completePublication(request, confirmingFile);
      if (confirmingFile) response.setHeader("Server-Timing", `attachment-confirmation;dur=${(performance.now() - start).toFixed(1)}`);
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }
    if (pathname === api && method === "POST") {
      sendJson(response, 201, { ok: true, publication: await publish(request) });
      return true;
    }
    if (pathname === api + "/recover" && method === "POST") {
      sendJson(response, 200, { ok: true, publication: await recover(request) });
      return true;
    }

    const match = /^\/api\/shared-reports\/([a-f0-9]{32})(?:\/(answers|answer-files|attachment-status|author)|\/(files|answer-files)\/([a-zA-Z0-9_-]{1,80}))?$/.exec(pathname);
    if (!match) fail(404, "Публикация недоступна");
    const [, id, action, fileKind, fileId] = match;
    if (action === "answers" && method === "POST") {
      sendJson(response, 200, { ok: true, answer: await answer(request, id) });
      return true;
    }
    if (action === "answer-files" && method === "POST") {
      sendJson(response, 200, { ok: true, file: await uploadAnswerFile(request, id) });
      return true;
    }

    const { row, owner, canReply } = authorize(request, id);
    if (method === "DELETE" && !action && !fileKind && owner) {
      if (publisherIdentity) checkPublicationAuthor(row, (await publisherIdentity(request))?.id, bearer(request));
      revokePublication(id);
      sendJson(response, 200, { ok: true });
      await drainStorageCleanup();
      return true;
    }
    if (row.revoked_at) fail(404, "Публикация недоступна");
    if (method === "GET" && action === "author") {
      if (!owner) fail(404, "Публикация недоступна");
      let email = "";
      if (authorEmail && row.author_id) {
        try {
          email = await authorEmail(row.author_id);
        } catch {
          fail(503, "Не удалось определить аккаунт публикации.");
        }
      }
      sendJson(response, 200, { ok: true, email });
      return true;
    }
    if (method === "GET" && action === "attachment-status") {
      const manifest = JSON.parse(row.manifest_json);
      const verified = row.ready_at ? null : verifiedFiles(id, manifest);
      const pending = manifest.filter(file => verified && !verified.has(file.id)).map(file => file.id);
      sendJson(response, 200, { ok: true, pending });
      return true;
    }
    if (method === "DELETE" && fileKind === "answer-files" && fileId && canReply) {
      await deleteAnswerFile(id, fileId);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (method === "GET" && fileId) {
      const attachment = fileKind === "answer-files" ? answerFile(id, fileId) : undefined;
      const file = fileKind === "answer-files"
        ? attachment && !attachment.deleted_at && { name: attachment.name, size: attachment.size, bucketId: attachment.bucket_id, key: attachment.object_key }
        : JSON.parse(row.manifest_json).find((item) => item.id === fileId);
      if (fileKind === "files" && file && !row.ready_at && !verifiedFiles(id, [file]).has(fileId)) fail(404, "Вложение ещё не опубликовано");
      await fileResponse(response, file);
      return true;
    }
    if (method === "GET" && !action) {
      const manifest = JSON.parse(row.manifest_json);
      const verified = row.ready_at ? null : verifiedFiles(id, manifest);
      const files = manifest.map(({ id, name, type, size }) => ({ id, name, type, size, ...(verified && !verified.has(id) && { pending: true }) }));
      const answers = db().prepare("SELECT * FROM shared_report_answers WHERE publication_id = ?").all(id).map(answerFromRow);
      const answerFiles = db().prepare("SELECT * FROM shared_report_answer_files WHERE publication_id = ? AND deleted_at IS NULL ORDER BY rowid").all(id).map(answerFileFromRow);
      const { configured, enabled } = publicationSettings.get();
      sendJson(response, 200, { ok: true, report: { ...JSON.parse(row.snapshot_json), id, createdAt: row.published_at || row.ready_at,
        files, canReply, answers, answerFiles, ...(configured && !enabled && { uploadsPaused: true }) } });
      return true;
    }
    fail(403, "Ссылка не разрешает это действие");
  };
}

module.exports = { initializeSharing, createReportSharing, createPublicationSettings, createAuthorInvite, revokeAuthorAccess };
