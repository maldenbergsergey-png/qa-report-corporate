"use strict";
const crypto = require("node:crypto");
const Runtime = require("./jira-upload-runtime");
const validId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || "");
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
function createUploadStore(getDb) {
  const active = new Map(); let initialized;
  function db() {
    const value = getDb();
    if (initialized !== value) {
      value.exec(`CREATE TABLE IF NOT EXISTS jira_upload_operations (
        owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, phase TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0, result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_source, owner_id, id))`);
      // A restarted process cannot establish whether its external POST committed.
      value.prepare("UPDATE jira_upload_operations SET state = 'failed', phase = 'interrupted', result_json = ? WHERE state = 'running' AND posted = 0")
        .run(JSON.stringify({ status: 502, error: "Сервер перезапущен до отправки файла. Повторите загрузку.", errorCode: "UPLOAD_NOT_STARTED", retrySafe: true }));
      value.prepare("UPDATE jira_upload_operations SET state = 'unknown', phase = 'interrupted' WHERE state = 'running' AND posted = 1").run(); initialized = value;
    }
    return value;
  }
  function row(owner, id) {
    if (!validId(id)) throw fail(422, "Некорректный идентификатор загрузки", "UPLOAD_ID_INVALID");
    return db().prepare("SELECT state, phase, posted, result_json, fingerprint FROM jira_upload_operations WHERE owner_source = ? AND owner_id = ? AND id = ?").get(owner.source, owner.id, id);
  }
  function view(owner, id) {
    const item = row(owner, id); if (!item) throw fail(404, "Загрузка не найдена", "UPLOAD_NOT_FOUND");
    return { operationId: id, state: item.state, phase: item.phase, ...JSON.parse(item.result_json), ...(item.state === "unknown" && item.result_json === "{}" ? { error: "Работа сервера прервалась. Результат загрузки не подтверждён. Проверьте вложения в Jira; повторная отправка не начата.", errorCode: "UPLOAD_RESULT_UNKNOWN", status: 409 } : {}) };
  }
  function start(owner, id, fingerprint, execute) {
    const old = row(owner, id), key = JSON.stringify([owner.source, owner.id, id]);
    const retrySafe = old?.state === "failed" && (!old.posted || JSON.parse(old.result_json).retrySafe === true);
    if (old && old.fingerprint !== fingerprint && !retrySafe) throw fail(409, "Эта операция относится к другому файлу или подключению", "UPLOAD_OPERATION_CONFLICT");
    if (old && !retrySafe) return view(owner, id);
    const stamp = new Date().toISOString();
    db().prepare("INSERT INTO jira_upload_operations VALUES (?, ?, ?, ?, 'running', 'prepare', 0, '{}', ?, ?) ON CONFLICT(owner_source, owner_id, id) DO UPDATE SET fingerprint = excluded.fingerprint, state = 'running', phase = 'prepare', posted = 0, result_json = '{}', updated_at = excluded.updated_at")
      .run(owner.source, owner.id, id, fingerprint, stamp, stamp);
    const update = (state, phase, result, posted = 0) => db().prepare("UPDATE jira_upload_operations SET state = ?, phase = ?, result_json = ?, posted = MAX(posted, ?), updated_at = ? WHERE owner_source = ? AND owner_id = ? AND id = ?")
      .run(state, phase, JSON.stringify(result), posted, new Date().toISOString(), owner.source, owner.id, id);
    let posted = false;
    const task = Runtime.run(id, async () => {
      try { const result = await execute(() => { posted = true; update("running", "upload", {}, 1); }); update("completed", "complete", { result }, posted ? 1 : 0); }
      catch (error) {
        const uncertain = posted && (!error.status || error.status >= 500 || [408, 429].includes(error.status));
        update(uncertain ? "unknown" : "failed", error.phase || "failed", { retrySafe: !uncertain, status: error.status || 502, error: error.message, errorCode: error.code || "UPLOAD_FAILED", ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }, posted ? 1 : 0);
      }
    }, phase => { update("running", phase, {}, posted ? 1 : 0); }).finally(() => active.delete(key));
    active.set(key, task); return view(owner, id);
  }
  async function wait(owner, id) { await active.get(JSON.stringify([owner.source, owner.id, id])); return view(owner, id); }
  async function poll(owner, id) {
    const current = view(owner, id), task = active.get(JSON.stringify([owner.source, owner.id, id]));
    if (!task) return current;
    let timer;
    try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]); }
    finally { clearTimeout(timer); }
    return view(owner, id);
  }
  function fingerprint(connection, issueKey, files) {
    const hash = crypto.createHash("sha256").update(JSON.stringify([connection, issueKey]));
    for (const file of files) hash.update(JSON.stringify([file.name, file.type, file.attachmentId])).update(file.bytes);
    return hash.digest("hex");
  }
  return { start, view, wait, poll, fingerprint };
}
module.exports = { createUploadStore, validId };
