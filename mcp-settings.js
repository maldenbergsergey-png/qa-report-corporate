(function () {
  "use strict";
  const dialog = document.createElement("dialog");
  dialog.className = "modal mcp-settings"; dialog.id = "mcpSettingsDialog";
  dialog.setAttribute("aria-labelledby", "mcpSettingsTitle");
  dialog.innerHTML = `<header class="modal-header"><div><div class="eyebrow">Интеграции</div><h2 id="mcpSettingsTitle">MCP-сервер</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть настройки MCP">×</button></header>
    <div class="import-body mcp-settings-body">
      <p class="mcp-settings-intro">MCP подключает вашего ИИ-ассистента к QA Report. Для QA доступ выдаётся к выбранному чек-листу, для разработчика — к отчёту или проекту.</p>
      <div class="mcp-settings-scenarios">
        <section><h3>Для QA</h3><p>ИИ читает чек-лист, заполняет результаты и статусы, добавляет вложения.</p><ol><li>Откройте нужный чек-лист и включите «Приём результатов от ИИ» кнопкой AI.</li><li>Вернитесь в этот раздел профиля и выберите отчёт ниже, чтобы получить команду подключения.</li></ol></section>
        <section><h3>Для разработчика</h3><p>ИИ читает замечания, меняет статус исправления и комментарии. Результаты проверки QA сохраняются.</p><p>Откройте опубликованный отчёт по ссылке и нажмите <strong>AI</strong> в его шапке. Команда подключения будет доступна там. Для доступа сразу к проекту автор может выдать ключ ниже.</p></section>
      </div>
      <section class="mcp-settings-connection"><h3>Подключение к чек-листу QA</h3>
        <p data-inactive>В этой вкладке пока нет отчётов с включённым приёмом. Включите приём в нужном чек-листе — он появится в списке при следующем открытии этого окна.</p>
        <label class="field" data-report-field hidden><span>Отчёт с включённым приёмом</span><select data-report-select><option value="">Выберите отчёт</option></select></label>
        <div data-setup hidden>
          <p data-report></p><p>Для подключения нужен <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22 или новее</a>. Выберите клиент и систему, затем скопируйте команду.</p>
          <div class="mcp-settings-choices"><label class="field"><span>Клиент</span><select data-client><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="json">Другой клиент (JSON)</option><option value="codex-config">Codex (настройки вручную)</option></select></label><label class="field"><span>Система</span><select data-platform><option value="posix">macOS / Linux</option><option value="windows">Windows (PowerShell)</option></select></label></div>
          <details><summary>Доступ к вложениям — необязательно</summary><label class="field mcp-settings-files"><span>Папка вложений</span><input data-files type="text" placeholder="Полный путь к папке" autocomplete="off" spellcheck="false"></label><p>Ассистент сможет загружать файлы только из этой папки. Без пути доступны текст и статусы.</p></details>
          <p data-help></p><textarea class="import-textarea mcp-settings-code" data-code readonly spellcheck="false" aria-label="Команда подключения MCP"></textarea>
          <p>Оставьте вкладку отчёта открытой. Подключение действует до остановки приёма или истечения 5 часов. Команда содержит ключ выбранного отчёта — храните настройки вне репозитория.</p>
        </div><p data-state role="status" aria-live="polite"></p>
      </section>
    </div><footer class="modal-footer" data-actions hidden><span>Скопируйте подключение только для выбранного отчёта.</span><button class="button button-primary" type="button" data-copy disabled>Скопировать подключение</button></footer>`;
  document.body.append(dialog);
  const find = name => dialog.querySelector(`[data-${name}]`);
  const client = find("client"), platform = find("platform"), files = find("files"), code = find("code"), state = find("state"), copy = find("copy"), reportSelect = find("report-select");
  const activeSessions = () => window.QaReportMcpEditor?.sessions() || [];
  platform.value = /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
  let packageUrl, activeSession, opener, generation = 0;
  function update() {
    code.value = ""; copy.disabled = true; state.textContent = "";
    if (!activeSession) return;
    const current = activeSessions().find(item => item.id === activeSession.id);
    if (!current || current !== activeSession) {
      state.textContent = "Приём для выбранного отчёта остановлен или истёк. Откройте этот раздел заново, чтобы обновить список."; return;
    }
    if (!packageUrl) { state.textContent = "Готовим подключение…"; return; }
    try {
      const setup = window.QaReportMcpSetup.buildSetup({ connection: current.connection, packageUrl, client: client.value,
        windows: platform.value === "windows", fileRoot: files.value.trim() });
      code.value = setup.code; find("help").textContent = setup.help; copy.disabled = false;
    } catch (error) { state.textContent = error.message; }
  }
  function selectReport() {
    activeSession = activeSessions().find(item => item.id === reportSelect.value);
    files.value = ""; find("help").textContent = "";
    find("setup").hidden = !activeSession; find("actions").hidden = !activeSession;
    find("report").textContent = activeSession ? `Доступ к этому отчёту до ${new Date(activeSession.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : "";
    update();
  }
  async function open(button) {
    opener = button; activeSession = undefined; packageUrl = undefined;
    const requestGeneration = ++generation, sessions = activeSessions();
    reportSelect.replaceChildren(new Option("Выберите отчёт", ""));
    for (const session of sessions) {
      const label = `${session.title || "Отчёт"}${session.publicId ? " · " + session.publicId : ""} · до ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      reportSelect.add(new Option(label, session.id));
    }
    find("inactive").hidden = sessions.length > 0; find("report-field").hidden = sessions.length === 0;
    selectReport();
    document.getElementById("corporateProfileDialog")?.close();
    dialog.showModal();
    dialog.dispatchEvent(new Event("mcp-settings-open"));
    if (!sessions.length) return;
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
  dialog.addEventListener("close", () => {
    ++generation; code.value = ""; files.value = ""; activeSession = undefined; packageUrl = undefined;
    const target = opener?.getClientRects().length ? opener : document.getElementById("corporateProfileButton");
    target?.focus();
  });
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
  reportSelect.addEventListener("change", selectReport);
  client.addEventListener("change", update); platform.addEventListener("change", update); files.addEventListener("input", update);
  copy.addEventListener("click", async () => {
    update(); if (copy.disabled) return;
    try { await navigator.clipboard.writeText(code.value); state.textContent = "Скопировано. Добавьте подключение в выбранный клиент."; }
    catch { code.focus(); code.select(); state.textContent = "Скопируйте выделенный текст вручную."; }
  });
})();
