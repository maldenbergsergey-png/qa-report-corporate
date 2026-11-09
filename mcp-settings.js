(function () {
  "use strict";
  const dialog = document.createElement("dialog");
  dialog.className = "mcp-settings"; dialog.id = "mcpSettingsDialog";
  dialog.setAttribute("aria-labelledby", "mcpSettingsTitle");
  dialog.innerHTML = `<header><h2 id="mcpSettingsTitle">MCP-сервер</h2><button type="button" data-close aria-label="Закрыть настройки MCP">×</button></header>
    <p>Подключите своего ИИ-ассистента к выбранному чек-листу. Он сможет читать проверки, записывать результаты и менять поля отчёта.</p>
    <p data-report></p><p data-inactive>Сначала включите «Приём результатов от ИИ» в нужном отчёте.</p>
    <button type="button" data-reception>Открыть приём результатов</button>
    <div data-setup hidden>
      <p>1. Установите <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22 или новее</a>, если его ещё нет.</p>
      <div class="mcp-settings-choices"><label>Клиент<select data-client><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="json">Другой клиент (JSON)</option><option value="codex-config">Codex (настройки вручную)</option></select></label><label>Система<select data-platform><option value="posix">macOS / Linux</option><option value="windows">Windows (PowerShell)</option></select></label></div>
      <details><summary>Доступ к вложениям — необязательно</summary><label class="mcp-settings-files">Папка вложений<input data-files type="text" placeholder="Полный путь к папке" autocomplete="off" spellcheck="false"></label><p>Ассистент сможет загружать файлы только из этой папки. Без пути доступны текст и статусы.</p></details>
      <p data-help></p><textarea data-code readonly spellcheck="false" aria-label="Команда подключения MCP"></textarea>
      <button type="button" data-copy disabled>Скопировать подключение</button>
      <p>Оставьте вкладку открытой. Подключение действует до остановки приёма или истечения 5 часов; после нового включения скопируйте команду заново.</p>
      <p>Команда содержит ключ отчёта. Храните настройки вне репозитория.</p>
    </div><p data-state role="status" aria-live="polite"></p>
    <details><summary>Подключение для получателя отчёта</summary><p>Нажмите «Подключить ИИ» в опубликованном отчёте. Ассистент сможет читать замечания и отвечать по пунктам, сохраняя результаты QA.</p></details>`;
  document.body.append(dialog);
  const find = name => dialog.querySelector(`[data-${name}]`);
  const client = find("client"), platform = find("platform"), files = find("files"), code = find("code"), state = find("state"), copy = find("copy");
  platform.value = /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
  let packageUrl, activeSession, opener, generation = 0;
  function update() {
    code.value = ""; copy.disabled = true;
    const current = window.QaReportMcpEditor?.session();
    if (!current || current !== activeSession || current.expiresAt <= Date.now()) {
      state.textContent = "Приём остановлен или выбран другой отчёт. Откройте подключение заново."; return;
    }
    if (!packageUrl) return;
    try {
      const setup = window.QaReportMcpSetup.buildSetup({ connection: current.connection, packageUrl, client: client.value,
        windows: platform.value === "windows", fileRoot: files.value.trim() });
      code.value = setup.code; find("help").textContent = setup.help; copy.disabled = false; state.textContent = "";
    } catch (error) { state.textContent = error.message; }
  }
  async function open(button) {
    opener = button; activeSession = window.QaReportMcpEditor?.session(); packageUrl = undefined;
    const requestGeneration = ++generation;
    find("inactive").hidden = Boolean(activeSession); find("setup").hidden = !activeSession;
    find("reception").hidden = Boolean(activeSession);
    find("report").textContent = activeSession ? `Отчёт: ${activeSession.title}. Доступ до ${new Date(activeSession.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : "";
    code.value = ""; copy.disabled = true; state.textContent = "";
    document.getElementById("corporateProfileDialog")?.close();
    if (!document.getElementById("localImportModal").hidden) document.getElementById("closeLocalImport").click();
    dialog.showModal();
    if (!activeSession) return;
    state.textContent = "Готовим подключение…";
    try {
      const response = await fetch("/api/mcp/package", { cache: "no-store", credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error();
      const metadata = await response.json();
      if (!dialog.open || generation !== requestGeneration) return;
      packageUrl = metadata.packageUrl; update();
    } catch { if (dialog.open && generation === requestGeneration) state.textContent = "Не удалось подготовить подключение. Закройте окно и попробуйте ещё раз."; }
  }
  document.querySelectorAll("[data-mcp-open]").forEach(button => button.addEventListener("click", () => open(button)));
  find("close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { ++generation; code.value = ""; activeSession = undefined; packageUrl = undefined; opener?.focus(); });
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
  find("reception").addEventListener("click", () => {
    dialog.close();
    if (document.getElementById("profilePage")?.hidden === false) document.getElementById("profileBack").click();
    document.getElementById("localImportButton").click();
  });
  client.addEventListener("change", update); platform.addEventListener("change", update); files.addEventListener("input", update);
  copy.addEventListener("click", async () => {
    update(); if (copy.disabled) return;
    try { await navigator.clipboard.writeText(code.value); state.textContent = "Скопировано. Добавьте подключение в выбранный клиент."; }
    catch { code.focus(); code.select(); state.textContent = "Скопируйте выделенный текст вручную."; }
  });
})();
