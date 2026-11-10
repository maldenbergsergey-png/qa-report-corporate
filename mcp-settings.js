(function () {
  "use strict";
  const dialog = document.createElement("dialog");
  dialog.className = "modal mcp-settings"; dialog.id = "mcpSettingsDialog";
  dialog.setAttribute("aria-labelledby", "mcpSettingsTitle");
  dialog.innerHTML = `<header class="modal-header"><div><div class="eyebrow">Интеграции</div><h2 id="mcpSettingsTitle">MCP-сервер</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть настройки MCP">×</button></header>
    <nav class="import-source-tabs mcp-settings-tabs" role="tablist" aria-label="Подключение MCP">
      <button class="import-source-tab active" id="mcp-personal-tab" type="button" role="tab" data-mcp-tab="personal" aria-controls="mcp-personal-panel" aria-selected="true">Личный MCP</button>
      <button class="import-source-tab" id="mcp-developer-tab" type="button" role="tab" data-mcp-tab="developer" aria-controls="mcp-developer-panel" aria-selected="false" tabindex="-1">Для разработчика</button>
    </nav>
    <div class="import-body mcp-settings-body">
      <div id="mcp-personal-panel" role="tabpanel" aria-labelledby="mcp-personal-tab" data-mcp-panel="personal">
        <details class="mcp-temporary" data-temporary><summary>Разовое подключение к чек-листу</summary>
          <p data-inactive>Включите приём кнопкой AI в нужном чек-листе.</p>
          <label class="field" data-report-field hidden><span>Чек-лист с включённым приёмом</span><select data-report-select><option value="">Выберите чек-лист</option></select></label>
          <div data-setup hidden>
            <p data-report></p><div class="mcp-settings-choices"><label class="field"><span>Ассистент</span><select data-client><option value="codex-chat">Codex — через чат</option><option value="claude-chat">Claude Code — через чат</option><optgroup label="Настроить вручную"><option value="codex">Codex — команда</option><option value="claude">Claude Code — команда</option><option value="json">Другой клиент — JSON</option><option value="codex-config">Codex — TOML</option></optgroup></select></label><label class="field"><span>Система</span><select data-platform><option value="posix">macOS / Linux</option><option value="windows">Windows (PowerShell)</option></select></label></div>
            <details><summary>Настройки подключения</summary><label class="field"><span>Папка вложений</span><input data-files type="text" placeholder="Полный путь, необязательно" autocomplete="off" spellcheck="false"></label><textarea class="import-textarea mcp-settings-code" data-code readonly spellcheck="false" aria-label="Подключение к чек-листу"></textarea></details>
            <p data-help></p><p class="mcp-note">Оставьте вкладку открытой. Доступ — до 5 часов.</p>
          </div><p data-state role="status" aria-live="polite"></p>
          <div class="mcp-inline-actions" data-actions hidden><button class="button button-primary" type="button" data-copy disabled>Скопировать запрос</button></div>
        </details>
      </div>
      <div id="mcp-developer-panel" role="tabpanel" aria-labelledby="mcp-developer-tab" data-mcp-panel="developer" hidden></div>
    </div>`;
  document.body.append(dialog);
  function selectTab(name, focus = false) {
    dialog.querySelectorAll("[data-mcp-tab]").forEach(button => {
      const selected = button.dataset.mcpTab === name;
      button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    dialog.querySelectorAll("[data-mcp-panel]").forEach(panel => { panel.hidden = panel.dataset.mcpPanel !== name; });
    dialog.querySelector(".mcp-settings-body").scrollTop = 0;
  }
  const tabs = [...dialog.querySelectorAll("[data-mcp-tab]")];
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => selectTab(button.dataset.mcpTab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.mcpTab, true);
    });
  });
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
      code.value = setup.code; find("help").textContent = setup.help; copy.textContent = client.value.endsWith("-chat") ? "Скопировать запрос" : "Скопировать настройки"; copy.disabled = false;
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
    selectTab("personal"); find("temporary").open = false;
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
    try { await navigator.clipboard.writeText(code.value); state.textContent = client.value.endsWith("-chat") ? "Запрос скопирован. Вставьте его в чат ассистента." : "Настройки скопированы."; }
    catch { code.focus(); code.select(); state.textContent = "Скопируйте выделенный текст вручную."; }
  });
})();
