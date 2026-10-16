/* Each opt-in connection stays bound to its report, including in the background. */
(function (root) {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  async function cellHash(html, status) {
    const bytes = new TextEncoder().encode(JSON.stringify([html || "", status || ""]));
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2,"0")).join("");
  }
  async function applyCells(value, updates, files) {
    const next = JSON.parse(JSON.stringify(value));
    for (const update of updates) {
      const section = next.sections.find(item => item.id === update.sectionId);
      const row = section?.rows.find(item => item.id === update.rowId);
      if (!row || !section.columns.some(item => item.id === update.columnId)) throw new Error("Строка или столбец больше не существует");
      // Hashes are checked against the original report, including row status.
      const original = value.sections.find(item => item.id === update.sectionId).rows.find(item => item.id === update.rowId);
      if (update.expectedHash !== await cellHash(original.cells[update.columnId], original.status)) throw new Error("Ячейка изменилась после получения контекста. Получите новый контекст и повторите пакет");
      if (update.text !== undefined) {
        const text = `<p>${escape(update.text).replace(/\r?\n/g,"<br>") || "<br>"}</p>`;
        row.cells[update.columnId] = update.mode === "append" ? row.cells[update.columnId] + text : text;
      }
      for (const id of update.attachmentIds || []) {
        const file = files.get(id); if (!file) throw new Error("Вложение не загружено");
        row.cells[update.columnId] += root.QaReportAttachments.render(file);
      }
      if (update.status !== undefined) row.status = update.status;
    }
    return next;
  }
  const metadataFields = ["issueUrl", "environment", "overallStatus", "intro"];
  async function applyMetadata(original, candidate, updates) {
    const next = JSON.parse(JSON.stringify(candidate));
    for (const [field, update] of Object.entries(updates || {})) {
      if (!metadataFields.includes(field)) throw new Error("Неизвестное поле metadata");
      if (update.expectedHash !== await cellHash(original[field])) throw new Error(`Поле «${field}» изменилось. Получите новый контекст и повторите пакет`);
      next[field] = field === "intro"
        ? (update.value ? `<p>${escape(update.value).replace(/\r?\n/g, "<br>")}</p>` : "")
        : field === "environment" ? update.value.trim() || "Не указано" : update.value.trim();
    }
    return next;
  }
  root.QaLocalImport = { cellHash, applyCells, applyMetadata };
  if (typeof document === "undefined") return;
  const panel = document.getElementById("localImportModal");
  if (!panel) return;
  const start = document.getElementById("startLocalImport");
  const stop = document.getElementById("stopLocalImport");
  const copy = document.getElementById("copyLocalImport");
  const status = document.getElementById("localImportStatus");
  const trigger = document.getElementById("localImportButton");
  const indicator = document.getElementById("localImportIndicator");
  const countdown = document.getElementById("localImportCountdown");
  const remaining = document.getElementById("localImportRemaining");
  const deadline = document.getElementById("localImportDeadline");
  const otherReports = document.getElementById("localImportOtherReports");
  const key = "qa-report-local-import-session-v1";
  const sessions = new Map();
  let starting = false; let busy = false; let timer; let clockTimer; let displayedReportId;
  const currentSession = () => sessions.get(draft.reportId);
  function message(value, current = currentSession()) {
    if (current) current.note = value;
    if (!current || current.reportId === draft.reportId) { displayedReportId = draft.reportId; status.textContent = value; }
  }
  function storeSessions() { sessionStorage.setItem(key, JSON.stringify([...sessions.values()])); }
  function timeLeft(current) {
    const seconds = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
  }
  function timeOf(current) { return new Date(current.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function assertActive(current) {
    if (sessions.get(current.reportId) !== current || Date.now() >= current.expiresAt) throw new Error("Приём остановлен или срок подключения истёк");
  }
  function updateControls() {
    const session = currentSession();
    const active = Boolean(session);
    start.disabled = active || starting; stop.disabled = !active; copy.disabled = !active;
    start.textContent = starting ? "Включаем…" : active ? "Приём включён" : "Включить приём";
    panel.dataset.state = active ? "on" : "off";
    trigger.classList.toggle("local-import-active", sessions.size > 0);
    indicator.dataset.state = sessions.size ? "on" : "off";
    const label = sessions.size ? `Приём результатов от ИИ: активных отчётов — ${sessions.size}` : "Приём результатов от ИИ выключен";
    trigger.title = label; trigger.setAttribute("aria-label", label);
    countdown.hidden = !active;
    if (session) {
      remaining.textContent = timeLeft(session);
      deadline.textContent = `до ${timeOf(session)}`;
    }
    if (displayedReportId !== draft.reportId) {
      displayedReportId = draft.reportId;
      status.textContent = session?.note || "Приём в этом отчёте выключен. Включите его, чтобы агент мог отправить результаты.";
    }
    const others = [...sessions.values()].filter(item => item !== session);
    otherReports.hidden = !others.length;
    // Rebuild only when connections change, preserving focus while the clock ticks.
    const signature = others.map(item => item.id).join(":");
    if (otherReports.dataset.sessions !== signature) {
      otherReports.dataset.sessions = signature;
      otherReports.innerHTML = others.length ? `<h3>Приём в других отчётах</h3>${others.map(item => `<div class="local-import-report"><div><strong>${escape(item.title || "Отчёт")}</strong><div class="local-import-report-time">Осталось <span role="timer" aria-live="off" data-import-time="${escape(item.id)}"></span> · до ${timeOf(item)}</div></div><div class="local-import-report-actions"><button class="button button-secondary" type="button" data-import-copy="${escape(item.reportId)}">Промпт</button><button class="button button-secondary" type="button" data-import-stop="${escape(item.reportId)}">Остановить</button></div></div>`).join("")}` : "";
    }
    for (const item of others) otherReports.querySelector(`[data-import-time="${item.id}"]`).textContent = timeLeft(item);
  }
  async function reportSource(current) {
    const saved = await getReportRecord(current.reportId);
    assertActive(current);
    if (!saved?.document) throw Object.assign(new Error("Отчёт удалён. Приём прекращён"), { status: 410 });
    if (draft.reportId === current.reportId) flushDraftFromDom();
    return { value: clone(draft.reportId === current.reportId ? draft : saved.document), saved: saved.document };
  }
  async function context(value) {
    if (!value) { flushDraftFromDom(); value = clone(draft); }
    const text = html => { const template = document.createElement("template"); template.innerHTML = html || ""; return template.content.textContent || ""; };
    const metadata = Object.fromEntries(await Promise.all(metadataFields.map(async field => [field, {
      text: field === "intro" ? text(value[field]) : value[field] || "", hash: await cellHash(value[field]),
    }])));
    return { reportId: value.reportId, metadata, title: value.sections[0]?.title || "Отчёт", sections: await Promise.all(value.sections.map(async section => ({
      id: section.id, title: section.title, columns: section.columns.map(column => ({ id: column.id, title: column.title })),
      rows: await Promise.all(section.rows.map(async row => ({ id: row.id, status: row.status, cells: Object.fromEntries(await Promise.all(section.columns.map(async column => [column.id, { text: text(row.cells[column.id]), hash: await cellHash(row.cells[column.id], row.status) }])))}))),
    }))) };
  }
  async function browserRequest(suffix, options = {}, current = currentSession()) {
    const response = await fetch(`/api/local-import/sessions${suffix}`, {
      ...options, cache: "no-store", headers: { ...reportIdentityHeaders(), "X-QA-Import-Request": "1", ...(current ? { "X-QA-Import-Reader": current.consumerToken } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    if (options.binary && response.ok) return response.blob();
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
    return payload;
  }
  async function endSession(current = currentSession(), note = "Приём выключен. Чтобы продолжить, включите его снова.") {
    if (!current || sessions.get(current.reportId) !== current) return;
    sessions.delete(current.reportId);
    storeSessions(); updateControls(); message(note, current);
    await browserRequest(`/${current.id}`, { method: "DELETE" }, current).catch(() => {});
  }
  async function acceptBatch(batch, current) {
    const receiptId = `${current.id}:${batch.id}`;
    const saved = await getReportRecord(current.reportId);
    if (saved?.document?.localImportReceipts?.includes(receiptId)) return;
    const files = new Map();
    message("Получаем результаты и вложения…", current);
    for (const file of batch.files) {
      const blob = await browserRequest(`/${current.id}/files/${file.id}`, { binary: true }, current);
      if (blob.size !== file.size) throw new Error(`Файл «${file.name}» получен не полностью`);
      files.set(file.id, { ...file, blob, id: crypto.randomUUID(), type: blob.type || "application/octet-stream", dataUrl: await root.QaReportAttachments.dataUrl(blob) });
    }
    assertActive(current);
    let imported;
    if (batch.kind === "checklist") {
      // Enabling reception authorizes replacement within this report-bound session.
      const attachments = batch.files.map(file => ({ id: file.id, filename: file.name }));
      const parsed = parseJiraMarkup(batch.content, attachments);
      const localized = await root.QaReportAttachments.localize(parsed, { attachments,
        load: async attachment => files.get(attachment.id).blob,
      });
      if (localized.errors.length) throw new Error(localized.errors.join("; "));
      imported = localized.document;
      if (batch.title && imported.sections[0]) imported.sections[0].title = stripSectionNumber(String(batch.title));
    }
    assertActive(current);
    // Verify again with editing frozen; no keystroke can be lost during the IndexedDB transaction.
    const shell = document.querySelector(".app-shell"); const wasInert = shell.inert; shell.inert = true;
    try {
      const { value, saved } = await reportSource(current);
      let candidate = imported ? importedDraftInCurrentReport(imported, value)
        : batch.kind === "cells" ? await applyCells(value, batch.updates, files) : clone(value);
      candidate = await applyMetadata(value, candidate, batch.metadata);
      candidate.localImportReceipts = [...(value.localImportReceipts || []), receiptId].slice(-128);
      candidate.revision = (Number(value.revision) || 0) + 1;
      candidate.updatedAt = new Date().toISOString(); candidate.lastSavedBy = tabId; candidate.lastSavedClientId = reportClientId;
      candidate = normalizeDraft(candidate);
      if (draft.reportId === current.reportId) { clearTimeout(saveTimer); clearTimeout(historyTimer); }
      try { await saveReportSnapshot("local-agent-import", candidate, { expectedDocument: saved, validate: () => assertActive(current) }); }
      catch (error) { error.localImportRetryable = true; throw error; }
      if (draft.reportId === current.reportId) applyDraftLocally(candidate);
      broadcastDraftUpdate(candidate);
    } finally { shell.inert = wasInert; }
  }
  async function pollSession(current) {
    if (Date.now() >= current.expiresAt) { await endSession(current, "Срок подключения истёк. Уже полученные файлы сохранены в браузере"); return; }
    if (publishInProgress || pwaPendingOperations || document.activeElement?.isContentEditable || document.activeElement?.matches?.("#issueUrl, #environment, #overallStatus") || document.querySelector('.modal-backdrop:not([hidden]):not(#localImportModal)')) return;
    try {
      const result = await browserRequest(`/${current.id}/next`, {}, current);
      if (sessions.get(current.reportId) !== current) return;
      if (result.batch) {
        pwaPendingOperations++;
        let ack = { id: result.batch.id, status: "saved" };
        try { await acceptBatch(result.batch, current); }
        catch (error) {
          // A storage/network failure is retryable; do not discard the server's files.
          if (error.localImportRetryable || ["QuotaExceededError", "AbortError", "UnknownError"].includes(error.name) || error instanceof TypeError || (error.status && (error.status >= 500 || error.status === 429 || error.status === 408))) throw error;
          ack = { id: result.batch.id, status: "rejected", error: error.message };
        } finally { pwaPendingOperations--; }
        const updatedContext = await context((await reportSource(current)).value);
        if (new TextEncoder().encode(JSON.stringify(updatedContext)).length < 900_000) ack.context = updatedContext;
        await browserRequest(`/${current.id}/ack`, { method: "POST", body: JSON.stringify(ack) }, current);
        if (sessions.get(current.reportId) !== current) return;
        message(ack.status === "saved" ? "Результаты и вложения сохранены в этом браузере. Ожидаем следующий пакет" : `Пакет не применён: ${ack.error}`, current);
        showToast(ack.status === "saved" ? `Результаты агента сохранены: ${current.title || "Отчёт"}` : `Пакет агента не применён: ${ack.error}`, 7000);
      }
      current.lastError = "";
    } catch (error) {
      if (sessions.get(current.reportId) !== current) return;
      if ([401,403,404,410].includes(error.status)) { await endSession(current, "Отчёт или подключение недоступны. Проверьте вход и включите приём снова"); }
      else { message(`Ожидаем повторной попытки: ${error.message}`, current); if (current.lastError !== error.message) showToast(current.note, 7000); current.lastError = error.message; }
    }
  }
  async function poll() {
    if (busy) return;
    busy = true;
    try { for (const current of [...sessions.values()]) if (sessions.get(current.reportId) === current) await pollSession(current); }
    finally { busy = false; if (sessions.size) { clearTimeout(timer); timer = setTimeout(poll, 2500); } updateControls(); }
  }
  function tick() {
    for (const current of sessions.values()) if (Date.now() >= current.expiresAt) void endSession(current, "Срок подключения истёк. Уже полученные файлы сохранены в браузере");
    updateControls();
    clockTimer = setTimeout(tick, 1000);
  }
  trigger.addEventListener("click", () => { panel.hidden = false; updateControls(); syncBodyModalOverflow(); (currentSession() ? copy : starting ? document.getElementById("closeLocalImport") : start).focus(); });
  document.getElementById("closeLocalImport").addEventListener("click", () => { panel.hidden = true; syncBodyModalOverflow(); trigger.focus(); });
  panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); panel.hidden = true; syncBodyModalOverflow(); trigger.focus(); } });
  start.addEventListener("click", async () => {
    if (currentSession() || starting) return;
    const reportId = draft.reportId;
    starting = true; updateControls(); message("Включаем приём результатов…");
    try {
      const checkReport = () => { if (draft.reportId !== reportId) throw new Error("Открыт другой отчёт. Включите приём в нужном отчёте"); };
      await checkBackendCompatibility();
      checkReport();
      await saveReportSnapshot("before-local-agent");
      checkReport();
      const body = { reportId, context: await context() };
      if (typeof authCsrfToken === "function") body.csrfToken = await authCsrfToken();
      const session = await browserRequest("", { method: "POST", body: JSON.stringify(body) }, null);
      session.title = body.context.metadata.issueUrl.text || body.context.title;
      sessions.set(session.reportId, session);
      storeSessions();
      message("Скопируйте промпт для агента и оставьте вкладку открытой. Можно переключаться между отчётами", session);
      clearTimeout(timer); timer = setTimeout(poll, 500);
    } catch (error) { message(`Не удалось включить приём: ${error.message}`); }
    finally { starting = false; updateControls(); }
  });
  stop.addEventListener("click", () => { void endSession(); start.focus(); });
  async function copyPrompt(session = currentSession()) {
    if (!session) return;
    const instruction = `Заполни указанный отчёт QA Report через временный API. Не используй это подключение для других отчётов. Подключение:\n${JSON.stringify({ reportId: session.reportId, title: session.title, ...session.connection }, null, 2)}\n\nИспользуй заголовок X-QA-Import-Token: token.\nGET url/context возвращает строки, столбцы, hash каждой ячейки и context.metadata: issueUrl (ссылка или ключ задачи), environment (окружение или адрес стенда), overallStatus (общий Итог), intro (вводный текст); у каждого поля text и hash.\nPUT url/files/<уникальный-id> принимает байты файла; X-QA-File-Name — имя в encodeURIComponent, Content-Type — MIME-тип.\nPOST url/batches принимает JSON {id, kind:"cells", updates:[{sectionId,rowId,columnId,expectedHash,text,attachmentIds:["id-файла"]}]}. expectedHash берётся из контекста. text заменяет содержимое ячейки; mode:"append" дописывает. attachmentIds без text добавляет файлы к существующему тексту. status необязателен.\nДля полного чек-листа: {id,kind:"checklist",format:"jira",content:"разметка",attachmentIds:["id-файла"]}; ссылки на вложения: !имя.png! и [^имя.pdf]. Полный чек-лист заменяет указанный отчёт целиком без дополнительного подтверждения, пока приём включён. Для дозагрузки результатов и файлов в существующие ячейки используй kind:"cells" с актуальными expectedHash; если меняешь весь чек-лист, отправляй его целиком, включая ранее принятые данные.\nДля изменения полей отчёта: {id,kind:"metadata",metadata:{issueUrl:{value:"https://tasks.example.test/browse/QA-123",expectedHash:"hash поля issueUrl из context.metadata"},overallStatus:{value:"НЕ ОК",expectedHash:"hash поля overallStatus"}}}. Таким же способом передавай environment и intro. intro — обычный текст с переносами строк, без HTML. Итог: OK, НЕ ОК, ПОЧТИ ОК, НЕ ПРОВЕРЕНО, ЧАСТИЧНО ПРОВЕРЕНО, ТРЕБУЕТ УТОЧНЕНИЯ. Передавай только изменяемые поля; metadata можно добавить и в пакет cells или checklist — всё сохранится вместе. При конфликте весь пакет отклоняется.\nGET url/batches/<id> возвращает pending, saved или rejected. Успех — только saved: браузер подтвердил сохранение. Повтор POST с тем же id и содержимым безопасен. При изменении содержимого используй новый id.\nЗагружай реальные файлы бинарными запросами; не генерируй Base64. Сессия временная, предназначена только для этого отчёта.`;
    try { await navigator.clipboard.writeText(instruction); showToast("Подключение и инструкции для агента скопированы"); }
    catch { message("Не удалось скопировать подключение. Разрешите доступ к буферу обмена", session); }
  }
  copy.addEventListener("click", () => copyPrompt());
  otherReports.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button?.dataset.importCopy) void copyPrompt(sessions.get(button.dataset.importCopy));
    if (button?.dataset.importStop) { void endSession(sessions.get(button.dataset.importStop)); document.getElementById("closeLocalImport").focus(); }
  });
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "[]");
    // Migrate the single-report connection without changing its expiry or tokens.
    for (const item of Array.isArray(stored) ? stored : [stored]) if (item?.expiresAt > Date.now()) sessions.set(item.reportId, item);
    storeSessions();
  } catch { sessionStorage.removeItem(key); }
  tick();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { clearTimeout(clockTimer); tick(); clearTimeout(timer); void poll(); } });
  if (sessions.size) timer = setTimeout(poll, 1500);
})(typeof window === "undefined" ? globalThis : window);
