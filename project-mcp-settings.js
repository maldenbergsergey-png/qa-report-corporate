(function () {
  "use strict";
  const dialog = document.getElementById("mcpSettingsDialog");
  if (!dialog) return;
  const section = document.createElement("section"); section.className = "mcp-settings-connection";
  section.innerHTML = `<h3>Ключ проекта для разработчика</h3>
    <p>Одно подключение на 30 дней: разработчик сможет находить ваши опубликованные отчёты выбранного проекта, читать замечания и отвечать на них. Новые отчёты того же проекта и трекера появятся автоматически. Результаты QA не меняются.</p>
    <p>Ключ работает после закрытия вкладки и выхода из аккаунта. Отозвать его можно здесь в любой момент.</p>
    <p data-project-state role="status" aria-live="polite"></p>
    <button class="button button-secondary" type="button" data-project-refresh>Обновить список проектов и ключей</button>
    <form data-project-form hidden>
      <div class="mcp-settings-choices"><label class="field"><span>Проект и трекер</span><select data-project-select required><option value="">Выберите проект</option></select></label><label class="field"><span>Название ключа</span><input data-project-label maxlength="100" value="Разработчик" required autocomplete="off"></label></div>
      <label class="mcp-project-readonly"><input type="checkbox" data-project-readonly> Только чтение, без ответов</label>
      <button class="button button-secondary" type="submit" data-project-create>Создать ключ на 30 дней</button>
    </form>
    <div data-project-issued hidden><p data-project-expiry></p><p>Разработчику нужен <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22 или новее</a>.</p>
      <div class="mcp-settings-choices"><label class="field"><span>Клиент разработчика</span><select data-project-client></select></label><label class="field"><span>Система</span><select data-project-platform><option value="posix">macOS / Linux</option><option value="windows">Windows (PowerShell)</option></select></label></div>
      <p data-project-help></p><textarea class="import-textarea mcp-settings-code" data-project-code readonly spellcheck="false" aria-label="Подключение к проекту"></textarea>
      <button class="button button-primary" type="button" data-project-copy>Скопировать подключение к проекту</button>
      <p>Передайте команду разработчику лично. Ключ показывается только сейчас; храните его вне репозитория. После подключения разработчик сможет попросить ИИ найти отчёт по коду задачи.</p>
    </div><div data-project-keys></div>`;
  dialog.querySelector(".mcp-settings-connection").before(section);
  const find = key => section.querySelector(`[data-project-${key}]`);
  const select = find("select"), client = find("client"), platform = find("platform"), code = find("code"), state = find("state");
  client.replaceChildren(...[...dialog.querySelector("[data-client]").options].map(item => new Option(item.text, item.value)));
  platform.value = /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
  let issued, packageUrl, generation = 0, busy = false;
  function clearIssued() { issued = undefined; packageUrl = undefined; code.value = ""; find("issued").hidden = true; }
  function message(text) { state.textContent = text; }
  async function headers(method) {
    if (typeof authCsrfToken === "function") return method === "GET" ? {} : { "X-QA-CSRF-Token": await authCsrfToken() };
    if (typeof loadReportAccountClient !== "function") return {};
    const { account, publishableKey } = await loadReportAccountClient();
    const token = await account?.sessionToken(publishableKey);
    return token ? { "X-QA-Report-Session": token } : {};
  }
  async function request(path = "", method = "GET", body, ticket = generation) {
    const auth = await headers(method);
    if (ticket !== generation) throw new Error("Операция отменена: окно или аккаунт изменились.");
    const response = await fetch("/api/mcp/project-keys" + path, { method, credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
      headers: { ...auth, "X-QA-Project-Request": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (ticket !== generation) throw new Error("Операция отменена: окно или аккаунт изменились.");
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить проекты и ключи.");
    return data;
  }
  function renderKeys(keys) {
    const list = find("keys"); list.replaceChildren();
    if (!keys.length) return;
    const title = document.createElement("h4"); title.textContent = "Выданные ключи"; list.append(title);
    for (const key of keys) {
      const row = document.createElement("div"); row.className = "mcp-project-key";
      const label = document.createElement("span"), active = !key.revokedAt && key.expiresAt > Date.now();
      label.textContent = `${key.label} · ${key.projectKey} · ${key.trackerUrl} · ${key.canReply ? "чтение и ответы" : "только чтение"} — ${key.revokedAt ? "отозван" : key.expiresAt <= Date.now() ? "истёк" : "до " + new Date(key.expiresAt).toLocaleDateString()}`;
      row.append(label);
      if (active) {
        const button = document.createElement("button"); button.type = "button"; button.className = "button button-ghost"; button.textContent = "Отозвать";
        button.addEventListener("click", async () => {
          if (busy) return; busy = true; button.disabled = true; const ticket = generation;
          try { await request("/" + key.id, "DELETE", undefined, ticket); if (issued?.key.id === key.id) clearIssued(); await load(ticket); }
          catch (error) { if (ticket === generation) message(error.message); }
          finally { busy = false; button.disabled = false; }
        });
        row.append(button);
      }
      list.append(row);
    }
  }
  async function load(ticket = generation) {
    const selectedProject = select.value;
    message("Загружаем ваши проекты и ключи…"); find("form").hidden = true;
    try {
      const data = await request("", "GET", undefined, ticket);
      select.replaceChildren(new Option("Выберите проект", ""));
      for (const project of data.projects) select.add(new Option(`${project.projectKey} · ${project.trackerUrl} · отчётов: ${project.reportCount}`, project.id));
      if (data.projects.some(project => project.id === selectedProject)) select.value = selectedProject;
      find("form").hidden = !data.projects.length;
      renderKeys(data.keys);
      message(data.projects.length ? "Выберите проект своих публикаций и создайте отдельный ключ для разработчика." : "Пока нет доступных проектов. Опубликуйте отчёт с полной ссылкой на задачу в трекере: по ней определяется проект и трекер.");
    } catch (error) { if (ticket === generation && dialog.open) { find("keys").replaceChildren(); message(error.message); } }
  }
  function updateCode() {
    code.value = ""; if (!issued || !packageUrl) return;
    const setup = window.QaReportMcpSetup.buildSetup({ project: issued.connection, packageUrl, client: client.value, windows: platform.value === "windows", readOnly: !issued.key.canReply });
    code.value = setup.code; find("help").textContent = setup.help;
  }
  find("form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy || !select.value) return;
    busy = true; find("create").disabled = true; const ticket = generation;
    clearIssued(); message("Создаём ключ…");
    try {
      // Resolve the package before issuing a key, so a package failure cannot hide a newly created secret.
      const response = await fetch("/api/mcp/package", { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Не удалось подготовить MCP-пакет.");
      const metadata = await response.json();
      if (ticket !== generation) return;
      const value = await request("", "POST", { projectId: select.value, label: find("label").value.trim(), readOnly: find("readonly").checked }, ticket);
      issued = value; packageUrl = metadata.packageUrl; updateCode(); find("issued").hidden = false;
      find("expiry").textContent = `Проект ${value.key.projectKey}: ключ действует до ${new Date(value.key.expiresAt).toLocaleString()}.`;
      await load(ticket);
    } catch (error) { if (ticket === generation) message(error.message); }
    finally { busy = false; find("create").disabled = false; }
  });
  client.addEventListener("change", updateCode); platform.addEventListener("change", updateCode);
  find("copy").addEventListener("click", async () => {
    if (!issued || issued.key.expiresAt <= Date.now()) { clearIssued(); message("Срок ключа истёк. Создайте новое подключение."); return; }
    try { await navigator.clipboard.writeText(code.value); message("Подключение к проекту скопировано. Передайте его разработчику лично."); }
    catch { code.focus(); code.select(); message("Скопируйте выделенный текст вручную."); }
  });
  find("refresh").addEventListener("click", () => { if (!busy) void load(); });
  dialog.addEventListener("mcp-settings-open", () => { ++generation; clearIssued(); select.value = ""; find("keys").replaceChildren(); void load(); });
  dialog.addEventListener("close", () => { ++generation; clearIssued(); });
  window.addEventListener("qa-report-account-change", () => { ++generation; clearIssued(); select.value = ""; find("keys").replaceChildren(); find("form").hidden = true; if (dialog.open) void load(); });
})();
