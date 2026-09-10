/* Receiving an agent's results is opt-in and bound to one open report. */
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
  root.QaLocalImport = { cellHash, applyCells };
  if (typeof document === "undefined") return;
  const panel = document.getElementById("localImportModal");
  if (!panel) return;
  const start = document.getElementById("startLocalImport");
  const stop = document.getElementById("stopLocalImport");
  const copy = document.getElementById("copyLocalImport");
  const status = document.getElementById("localImportStatus");
  const trigger = document.getElementById("localImportButton");
  const indicator = document.getElementById("localImportIndicator");
  const key = "qa-report-local-import-session-v1";
  let session = null; let starting = false; let busy = false; let timer; let lastError = "";
  function message(value) { status.textContent = value; }
  function updateControls() {
    const active = Boolean(session);
    start.disabled = active || starting; stop.disabled = !active; copy.disabled = !active;
    start.textContent = starting ? "Включаем…" : active ? "Приём включён" : "Включить приём";
    panel.dataset.state = active ? "on" : "off";
    trigger.classList.toggle("local-import-active", active);
    indicator.textContent = active ? "ON" : "OFF";
    const label = `Приём результатов от ИИ ${active ? "включён" : "выключен"}`;
    trigger.title = label; trigger.setAttribute("aria-label", label);
  }
  async function context() {
    flushDraftFromDom();
    const value = clone(draft);
    const text = html => { const template = document.createElement("template"); template.innerHTML = html || ""; return template.content.textContent || ""; };
    return { reportId: value.reportId, title: value.sections[0]?.title || "Отчёт", sections: await Promise.all(value.sections.map(async section => ({
      id: section.id, title: section.title, columns: section.columns.map(column => ({ id: column.id, title: column.title })),
      rows: await Promise.all(section.rows.map(async row => ({ id: row.id, status: row.status, cells: Object.fromEntries(await Promise.all(section.columns.map(async column => [column.id, { text: text(row.cells[column.id]), hash: await cellHash(row.cells[column.id], row.status) }])))}))),
    }))) };
  }
  async function browserRequest(suffix, options = {}, current = session) {
    const response = await fetch(`/api/local-import/sessions${suffix}`, {
      ...options, cache: "no-store", headers: { ...reportIdentityHeaders(), "X-QA-Import-Request": "1", ...(current ? { "X-QA-Import-Reader": current.consumerToken } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    if (options.binary && response.ok) return response.blob();
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
    return payload;
  }
  async function endSession(note = "Приём выключен. Чтобы продолжить, включите его снова.") {
    const previous = session; session = null; clearTimeout(timer);
    sessionStorage.removeItem(key); updateControls(); message(note);
    if (previous) await browserRequest(`/${previous.id}`, { method: "DELETE" }, previous).catch(() => {});
  }
  async function acceptBatch(batch, current) {
    const receiptId = `${current.id}:${batch.id}`;
    const saved = await getReportRecord(current.reportId);
    if (saved?.document?.localImportReceipts?.includes(receiptId)) return;
    const files = new Map();
    message("Получаем результаты и вложения…");
    for (const file of batch.files) {
      const blob = await browserRequest(`/${current.id}/files/${file.id}`, { binary: true }, current);
      if (blob.size !== file.size) throw new Error(`Файл «${file.name}» получен не полностью`);
      files.set(file.id, { ...file, blob, id: crypto.randomUUID(), type: blob.type || "application/octet-stream", dataUrl: await root.QaReportAttachments.dataUrl(blob) });
    }
    if (session !== current || draft.reportId !== current.reportId) throw new Error("Открыт другой отчёт или приём остановлен");
    flushDraftFromDom();
    let candidate;
    if (batch.kind === "checklist") {
      if (!await confirmImportReplacement()) throw new Error("Пользователь отменил замену чек-листа");
      const attachments = batch.files.map(file => ({ id: file.id, filename: file.name }));
      const parsed = parseJiraMarkup(batch.content, attachments);
      const localized = await root.QaReportAttachments.localize(parsed, { attachments,
        load: async attachment => files.get(attachment.id).blob,
      });
      if (localized.errors.length) throw new Error(localized.errors.join("; "));
      candidate = importedDraftInCurrentReport(localized.document);
      if (batch.title && candidate.sections[0]) candidate.sections[0].title = stripSectionNumber(String(batch.title));
    } else candidate = await applyCells(draft, batch.updates, files);
    if (session !== current || draft.reportId !== current.reportId) throw new Error("Сессия отчёта изменилась");
    // Verify again with editing frozen; no keystroke can be lost during the IndexedDB transaction.
    const shell = document.querySelector(".app-shell"); const wasInert = shell.inert; shell.inert = true;
    try {
      flushDraftFromDom();
      if (batch.kind === "cells") candidate = await applyCells(draft, batch.updates, files);
      candidate.localImportReceipts = [...(draft.localImportReceipts || []), receiptId].slice(-128);
      candidate.revision = (Number(draft.revision) || 0) + 1;
      candidate.updatedAt = new Date().toISOString(); candidate.lastSavedBy = tabId; candidate.lastSavedClientId = reportClientId;
      candidate = normalizeDraft(candidate);
      clearTimeout(saveTimer); clearTimeout(historyTimer);
      try { await saveReportSnapshot("local-agent-import", candidate); }
      catch (error) { error.localImportRetryable = true; throw error; }
      applyDraftLocally(candidate);
      broadcastDraftUpdate();
    } finally { shell.inert = wasInert; }
  }
  async function poll() {
    if (!session) return;
    if (busy) { timer = setTimeout(poll, 2500); return; }
    const current = session;
    if (draft.reportId !== current.reportId) { await endSession("Открыт другой отчёт. Создайте новую сессию приёма"); return; }
    if (Date.now() >= current.expiresAt) { await endSession("Срок сессии истёк. Уже полученные файлы сохранены в браузере"); return; }
    if (publishInProgress || pwaPendingOperations || document.activeElement?.isContentEditable || document.querySelector('.modal-backdrop:not([hidden]):not(#localImportModal)')) { timer = setTimeout(poll, 2500); return; }
    busy = true;
    try {
      const result = await browserRequest(`/${current.id}/next`, {}, current);
      if (session !== current) return;
      if (result.batch) {
        pwaPendingOperations++;
        let ack = { id: result.batch.id, status: "saved" };
        try { await acceptBatch(result.batch, current); }
        catch (error) {
          // A storage/network failure is retryable; do not discard the server's files.
          if (error.localImportRetryable || ["QuotaExceededError", "AbortError", "UnknownError"].includes(error.name) || error instanceof TypeError || (error.status && (error.status >= 500 || error.status === 429 || error.status === 408))) throw error;
          ack = { id: result.batch.id, status: "rejected", error: error.message };
        } finally { pwaPendingOperations--; }
        const updatedContext = await context();
        if (new TextEncoder().encode(JSON.stringify(updatedContext)).length < 900_000) ack.context = updatedContext;
        await browserRequest(`/${current.id}/ack`, { method: "POST", body: JSON.stringify(ack) }, current);
        if (session !== current) return;
        message(ack.status === "saved" ? "Результаты и вложения сохранены в этом браузере. Ожидаем следующий пакет" : `Пакет не применён: ${ack.error}`);
        showToast(ack.status === "saved" ? "Результаты агента сохранены" : `Пакет агента не применён: ${ack.error}`, 7000);
      }
      lastError = "";
    } catch (error) {
      if (session !== current) return;
      if ([401,403,404,410].includes(error.status)) { await endSession("Сессия недоступна. Проверьте вход и включите приём снова"); }
      else { message(`Ожидаем повторной попытки: ${error.message}`); if (lastError !== error.message) showToast(status.textContent, 7000); lastError = error.message; }
    } finally { busy = false; if (session === current) timer = setTimeout(poll, 2500); }
  }
  trigger.addEventListener("click", () => { panel.hidden = false; updateControls(); syncBodyModalOverflow(); (session ? copy : starting ? document.getElementById("closeLocalImport") : start).focus(); });
  document.getElementById("closeLocalImport").addEventListener("click", () => { panel.hidden = true; syncBodyModalOverflow(); trigger.focus(); });
  panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); panel.hidden = true; syncBodyModalOverflow(); trigger.focus(); } });
  start.addEventListener("click", async () => {
    if (session || starting) return;
    starting = true; updateControls(); message("Включаем приём результатов…");
    try {
      await checkBackendCompatibility();
      await saveReportSnapshot("before-local-agent");
      const body = { reportId: draft.reportId, context: await context() };
      if (typeof authCsrfToken === "function") body.csrfToken = await authCsrfToken();
      session = await browserRequest("", { method: "POST", body: JSON.stringify(body) }, null);
      sessionStorage.setItem(key, JSON.stringify(session));
      message(`Приём включён до ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Скопируйте промпт для агента и оставьте отчёт открытым`);
      timer = setTimeout(poll, 500);
    } catch (error) { message(`Не удалось включить приём: ${error.message}`); }
    finally { starting = false; updateControls(); }
  });
  stop.addEventListener("click", () => { endSession(); start.focus(); });
  copy.addEventListener("click", async () => {
    if (!session) return;
    const instruction = `Заполни открытый отчёт QA Report через временный API. Подключение:\n${JSON.stringify(session.connection, null, 2)}\n\nИспользуй заголовок X-QA-Import-Token: token.\nGET url/context возвращает строки, столбцы и hash каждой ячейки.\nPUT url/files/<уникальный-id> принимает байты файла; X-QA-File-Name — имя в encodeURIComponent, Content-Type — MIME-тип.\nPOST url/batches принимает JSON {id, kind:"cells", updates:[{sectionId,rowId,columnId,expectedHash,text,attachmentIds:["id-файла"]}]}. expectedHash берётся из контекста. text заменяет содержимое ячейки; mode:"append" дописывает. attachmentIds без text добавляет файлы к существующему тексту. status необязателен.\nДля полного чек-листа: {id,kind:"checklist",format:"jira",content:"разметка",attachmentIds:["id-файла"]}; ссылки на вложения: !имя.png! и [^имя.pdf].\nGET url/batches/<id> возвращает pending, saved или rejected. Успех — только saved: браузер подтвердил сохранение. Повтор POST с тем же id и содержимым безопасен. При изменении содержимого используй новый id.\nЗагружай реальные файлы бинарными запросами; не генерируй Base64. Сессия временная, предназначена только для этого отчёта.`;
    try { await navigator.clipboard.writeText(instruction); showToast("Подключение и инструкции для агента скопированы"); }
    catch { message("Не удалось скопировать подключение. Разрешите доступ к буферу обмена"); }
  });
  try { const stored = JSON.parse(sessionStorage.getItem(key) || "null"); if (stored?.expiresAt > Date.now()) session = stored; else sessionStorage.removeItem(key); } catch { sessionStorage.removeItem(key); }
  updateControls();
  if (session) { message("Возобновляем приём результатов для открытого отчёта…"); timer = setTimeout(poll, 1500); }
})(typeof window === "undefined" ? globalThis : window);
