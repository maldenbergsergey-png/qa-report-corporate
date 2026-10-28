(function (root) {
  "use strict";
  const labels = { queued: "Файл ожидает QA Report Connect", delivering: "Передаём файл в QA Report Connect", running: "Загрузка выполняется", prepare: "Подготовка файла", limits: "Проверяем ограничения Jira", inventory: "Проверяем вложения задачи", upload: "Отправляем файл и ожидаем подтверждения Jira" };
  function problem(payload, status, path) { return Object.assign(new Error(`${payload.error || `Ошибка загрузки: HTTP ${status}`}${payload.operationId ? ` · Код загрузки: ${payload.operationId}` : ""}`), { status, code: payload.errorCode || "", path, payload }); }
  function delay(ms, signal) { return new Promise((resolve, reject) => { signal?.throwIfAborted(); const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); }; const abort = () => { clearTimeout(timer); reject(new DOMException("Публикация отменена", "AbortError")); }; const timer = setTimeout(done, ms); signal?.addEventListener("abort", abort, { once: true }); }); }
  async function send(path, body, { signal, headers = {}, limits, onStage = () => {} } = {}) {
    body = { ...body, operationId: body.operationId || crypto.randomUUID() };
    const serialized = JSON.stringify({ ...body, async: true });
    const limitError = limits && root.QaReportAttachmentLimits.requestError(serialized, limits);
    if (limitError) throw problem({ error: limitError, errorCode: "APP_REQUEST_TOO_LARGE" }, 413, path);
    let response, payload;
    try { response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: serialized, signal }); payload = await response.json(); }
    catch (error) {
      if (error.name === "AbortError") throw error;
      // Submission may already be accepted; never blindly repeat a file POST.
      response = { ok: true }; payload = { statusUrl: path.includes("/agent/") ? `/api/agent/jobs/${body.operationId}` : `/api/jira/uploads/${body.operationId}` };
    }
    if (!response.ok) throw problem(payload, response.status, path);
    if (!payload.statusUrl) return payload; // Compatible with an older server.
    const expected = path.includes("/agent/") ? /^\/api\/agent\/jobs\/[a-f0-9-]{36}$/i : /^\/api\/jira\/uploads\/[a-f0-9-]{36}$/i;
    if (!expected.test(payload.statusUrl)) throw problem({ error: "Сервер вернул неверный адрес состояния загрузки" }, 502, path);
    let failures = 0;
    while (true) {
      signal?.throwIfAborted();
      try {
        const pollSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
        const status = await fetch(payload.statusUrl + "?wait=1", { headers, signal: pollSignal, cache: "no-store" });
        const value = await status.json();
        if (!status.ok) { if (status.status >= 500 || status.status === 429) throw new TypeError("Статус временно недоступен"); throw problem(value, status.status, path); }
        failures = 0;
        const job = value.job || value, state = job.state || job.status;
        onStage(labels[job.phase || state] || labels.running);
        if (state === "completed") return job.result;
        if (state === "expired") throw problem({ error: "QA Report Connect не завершил задание за отведённое время. Проверьте соединение с Connect и вложения в Jira: результат отправки не подтверждён.", errorCode: "CONNECT_JOB_EXPIRED", operationId: body.operationId || job.id }, 502, path);
        if (["failed", "unknown", "expired"].includes(state)) throw problem({ ...(job.result || {}), ...job, operationId: body.operationId || job.id }, Number(job.result?.status || job.status || 502) || 502, path);
      } catch (error) {
        if (error.name === "AbortError" || error.status) throw error;
        if (++failures >= 20) throw problem({ error: "Связь с QA Report прервалась. Загрузка может продолжаться; её повтор не начат.", errorCode: "UPLOAD_STATUS_UNAVAILABLE", operationId: body.operationId }, 502, path);
      }
      await delay(failures ? 3000 : 100, signal);
    }
  }
  root.QaReportJiraUploads = { send };
})(typeof window === "undefined" ? globalThis : window);
