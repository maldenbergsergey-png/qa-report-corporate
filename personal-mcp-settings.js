(function (root) {
  "use strict";
  const dialog = document.getElementById("mcpSettingsDialog");
  if (!dialog) return;
  const section = document.createElement("section"); section.className = "mcp-settings-connection personal-mcp";
  section.innerHTML = `<h3>Мой личный MCP</h3><p>Подключите своего ассистента один раз. Дальше передавайте ссылки на чек-листы или просите найти их по ключу задачи и названию. Это личный доступ к вашему аккаунту.</p>
    <p data-personal-state role="status" aria-live="polite"></p>
    <form data-personal-form hidden><div class="mcp-settings-choices">
      <label class="field"><span>Название токена</span><input data-personal-label required maxlength="100" value="Мой ассистент" autocomplete="off"></label>
      <label class="field"><span>Срок действия</span><select data-personal-lifetime><option value="30">30 дней</option><option value="90" selected>90 дней</option><option value="365">1 год</option><option value="">До отзыва</option></select></label>
    </div><label class="mcp-project-readonly"><input data-personal-readonly type="checkbox"> Только чтение</label><button class="button button-primary" type="submit" data-personal-create>Создать личный токен</button></form>
    <div data-personal-issued hidden><p data-personal-expiry></p><p>Для подключения нужен <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22 или новее</a>. Секрет показывается один раз. Сохраните подключение в личных настройках ассистента.</p>
      <div class="mcp-settings-choices"><label class="field"><span>Клиент</span><select data-personal-client></select></label><label class="field"><span>Система</span><select data-personal-platform><option value="posix">macOS / Linux</option><option value="windows">Windows (PowerShell)</option></select></label></div>
      <details><summary>Папка вложений — необязательно</summary><label class="field"><span>Полный путь к папке</span><input data-personal-files type="text" autocomplete="off" spellcheck="false" placeholder="Папка скриншотов и логов"></label></details>
      <p data-personal-help></p><textarea class="import-textarea mcp-settings-code" data-personal-code readonly spellcheck="false" aria-label="Личное подключение MCP"></textarea>
      <button class="button button-primary" type="button" data-personal-copy>Скопировать личное подключение</button><p>Храните токен вне репозитория. Для разработчика используйте отдельный доступ к опубликованным отчётам.</p>
    </div><div data-personal-keys></div>
    <div class="mcp-browser-access"><h4>Локальные чек-листы этого браузера</h4><p>Подключите эту вкладку: ассистент сможет искать и заполнять чек-листы из её локальной истории. Вкладка должна оставаться открытой. Опубликованные отчёты и личные облачные копии доступны для чтения без неё; для заполнения нужен исходный чек-лист в подключённом браузере.</p>
      <p data-personal-browser-state role="status"></p><button class="button button-secondary" type="button" data-personal-browser disabled>Подключить этот браузер</button></div>`;
  dialog.querySelector(".mcp-settings-scenarios").before(section);
  const find = name => section.querySelector(`[data-personal-${name}]`), state = find("state"), client = find("client"), platform = find("platform"), code = find("code");
  client.replaceChildren(...[...dialog.querySelector("[data-client]").options].map(item => new Option(item.text, item.value)));
  platform.value = /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
  let csrfCache, catalogSignature, catalogUpdatedAt = 0;
  let generation = 0, owner, issued, packageUrl, busy = false, workspace, bridgeOwner, polling = false, bridgeGeneration = 0, pollTimer;
  const storageKey = "qa-report-personal-mcp-browser-v1";
  async function authHeaders(method = "POST") {
    if (typeof authCsrfToken === "function") {
      if (method === "GET") return {};
      if (!csrfCache || csrfCache.expires <= Date.now()) csrfCache = { value: await authCsrfToken(), expires: Date.now() + 30000 };
      return { "X-QA-CSRF-Token": csrfCache.value };
    }
    const { account, publishableKey } = await loadReportAccountClient();
    const token = await account?.sessionToken(publishableKey);
    return token ? { "X-QA-Report-Session": token } : {};
  }
  async function request(path, method = "GET", body, ticket = generation) {
    const headers = await authHeaders(method);
    if (ticket !== generation) throw new Error("Аккаунт изменился. Откройте настройки заново.");
    const result = await fetch("/api/mcp/personal" + path, { method, credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000), headers: { ...headers, "X-QA-Personal-Request": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await result.json().catch(() => ({}));
    if (ticket !== generation) throw new Error("Аккаунт изменился.");
    if (!result.ok) throw Object.assign(new Error(data.error || "Не удалось выполнить запрос MCP."), { status: result.status }); return data;
  }
  function clearSecret() { issued = undefined; packageUrl = undefined; code.value = ""; find("issued").hidden = true; find("files").value = ""; }
  function updateCode() {
    code.value = ""; if (!issued || !packageUrl) return;
    try {
      const setup = root.QaReportMcpSetup.buildSetup({ personal: issued.connection, packageUrl, client: client.value, windows: platform.value === "windows", readOnly: !issued.key.canWrite, fileRoot: find("files").value.trim() });
      code.value = setup.code; find("help").textContent = setup.help; find("copy").disabled = false;
    } catch (error) { state.textContent = error.message; find("copy").disabled = true; }
  }
  function renderKeys(keys) {
    const list = find("keys"); list.replaceChildren();
    if (!keys.length) return;
    const heading = document.createElement("h4"); heading.textContent = "Мои токены"; list.append(heading);
    for (const key of keys) {
      const row = document.createElement("div"); row.className = "mcp-project-key";
      const label = document.createElement("span"), active = !key.revokedAt && (!key.expiresAt || key.expiresAt > Date.now());
      label.textContent = `${key.label} · ${key.canWrite ? "чтение и заполнение" : "только чтение"} · ${key.revokedAt ? "отозван" : key.expiresAt && key.expiresAt <= Date.now() ? "истёк" : key.expiresAt ? "до " + new Date(key.expiresAt).toLocaleDateString() : "до отзыва"}${key.lastUsedAt ? " · использован " + new Date(key.lastUsedAt).toLocaleString() : ""}`; row.append(label);
      if (active) {
        const button = document.createElement("button"); button.type = "button"; button.className = "button button-ghost"; button.textContent = "Отозвать";
        button.addEventListener("click", async () => {
          if (busy) return; busy = true; button.disabled = true; const ticket = generation;
          try { await request("-tokens/" + key.id, "DELETE", undefined, ticket); if (issued?.key.id === key.id) clearSecret(); await load(ticket); }
          catch (error) { if (ticket === generation) state.textContent = error.message; }
          finally { busy = false; button.disabled = false; }
        }); row.append(button);
      }
      list.append(row);
    }
  }
  async function load(ticket = generation) {
    state.textContent = "Загружаем личные токены…"; find("form").hidden = true;
    try {
      const data = await request("-tokens", "GET", undefined, ticket); owner = data.ownerId;
      renderKeys(data.keys); find("form").hidden = false; find("browser").disabled = false;
      const active = data.keys.filter(key => !key.revokedAt && (!key.expiresAt || key.expiresAt > Date.now())).length;
      find("create").disabled = active >= data.maxTokens;
      state.textContent = `Активных токенов: ${active} из ${data.maxTokens}. Каждый можно отозвать отдельно.`;
      if (!workspace && sessionStorage.getItem(storageKey) === owner) await connectBrowser(ticket);
    } catch (error) { if (ticket === generation) { owner = undefined; find("keys").replaceChildren(); find("browser").disabled = true; state.textContent = error.message; } }
  }
  find("form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return; busy = true; find("create").disabled = true; const ticket = generation;
    clearSecret(); state.textContent = "Создаём личное подключение…";
    try {
      const response = await fetch("/api/mcp/package", { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Не удалось получить пакет MCP."); const metadata = await response.json();
      const value = await request("-tokens", "POST", { label: find("label").value.trim(), lifetimeDays: find("lifetime").value ? Number(find("lifetime").value) : null, readOnly: find("readonly").checked }, ticket);
      issued = value; packageUrl = metadata.packageUrl; updateCode(); find("issued").hidden = false;
      find("expiry").textContent = value.key.expiresAt ? "Токен действует до " + new Date(value.key.expiresAt).toLocaleString() : "Токен действует до отзыва в этом разделе.";
      await load(ticket);
    } catch (error) { if (ticket === generation) { state.textContent = error.message; find("create").disabled = false; } }
    finally { busy = false; }
  });
  for (const control of [client, platform, find("files")]) control.addEventListener("input", updateCode);
  find("copy").addEventListener("click", async () => {
    if (!issued || !code.value) return;
    try { await navigator.clipboard.writeText(code.value); state.textContent = "Личное подключение скопировано. После установки попросите ассистента найти чек-лист по задаче."; }
    catch { code.focus(); code.select(); state.textContent = "Скопируйте выделенное подключение вручную."; }
  });
  async function browserCatalog() {
    const records = await getAllReports();
    if (draft?.reportId) {
      const index = records.findIndex(item => item.id === draft.reportId), item = { id: draft.reportId, document: draft };
      if (index >= 0) records[index] = item; else records.push(item);
    }
    return records.slice(0, 1000).map(record => {
      const value = record.document || record, id = record.id || value.reportId;
      const aliases = typeof sharedPublications === "function" ? sharedPublications(id).map(item => "/shared-report/" + item.id) : [];
      if (draft.reportId === id && root.QaReportCloud.routeId()) aliases.push("/cloud-report/" + root.QaReportCloud.routeId());
      return { id, publicId: value.publicId || record.publicId, title: record.title || value.sections?.[0]?.title || "Чек-лист", issueUrl: value.issueUrl || record.issueUrl || "", issueKey: root.QaReportTrackerLinks?.parse(value.issueUrl || record.issueUrl)?.key || issueKeyFromUrl(value.issueUrl || record.issueUrl), environment: value.environment || record.environment || "", updatedAt: value.updatedAt || record.updatedAt || "", aliases };
    }).filter(item => /^[a-f0-9]{7,8}$/.test(item.publicId));
  }
  function browserState(text) { find("browser-state").textContent = text; find("browser").textContent = workspace ? "Отключить этот браузер" : "Подключить этот браузер"; }
  async function connectBrowser(ticket = generation) {
    const selectedOwner = owner, stamp = ++bridgeGeneration;
    if (!selectedOwner) return;
    const catalog = await browserCatalog(), value = await request("-workspaces", "POST", { catalog }, ticket);
    if (stamp !== bridgeGeneration || selectedOwner !== owner) return;
    catalogSignature = JSON.stringify(catalog); catalogUpdatedAt = Date.now();
    workspace = value.id; bridgeOwner = owner; sessionStorage.setItem(storageKey, owner);
    browserState(`Браузер подключён. Доступных локальных чек-листов: ${catalog.length}.`); clearTimeout(pollTimer); pollTimer = setTimeout(pollBrowser, 500);
  }
  async function disconnectBrowser() {
    ++bridgeGeneration; clearTimeout(pollTimer); sessionStorage.removeItem(storageKey);
    const previous = workspace; workspace = undefined; bridgeOwner = undefined; browserState("Браузер отключён.");
    if (previous) await request("-workspaces/" + previous, "DELETE").catch(() => {});
    await root.QaReportMcpEditor.stopPersonal();
  }
  async function pollBrowser() {
    if (!workspace || polling || bridgeOwner !== owner) return; polling = true;
    const id = workspace, stamp = bridgeGeneration;
    try {
      const catalog = await browserCatalog(), signature = JSON.stringify(catalog);
      let value;
      if (signature !== catalogSignature && Date.now() - catalogUpdatedAt >= 10000) {
        value = await request("-workspaces/" + id, "POST", { catalog }); catalogSignature = signature; catalogUpdatedAt = Date.now();
      } else value = await request("-workspaces/" + id);
      if (stamp !== bridgeGeneration) return;
      for (const command of value.commands) {
        let answer;
        try { const headers = await authHeaders(); if (stamp !== bridgeGeneration) return; answer = { commandId: command.id, sessionId: await root.QaReportMcpEditor.startPersonal(command.reportId, headers, () => { if (stamp !== bridgeGeneration || bridgeOwner !== owner) throw new Error("Браузер отключён"); }) }; }
        catch { answer = { commandId: command.id, error: true }; }
        if (stamp !== bridgeGeneration) return;
        await request("-workspaces/" + id + "/ack", "POST", answer).catch(() => {});
      }
      if (value.pendingReports?.length) void root.QaReportMcpEditor.pollPersonal(value.pendingReports).catch(error => browserState(error.message));
      browserState(`Браузер подключён. Доступных локальных чек-листов: ${catalog.length}.`);
    } catch (error) {
      if (stamp === bridgeGeneration) {
        browserState(error.message);
        if ([401,403,404].includes(error.status)) { workspace = undefined; bridgeOwner = undefined; ++bridgeGeneration; browserState(error.message); await root.QaReportMcpEditor.stopPersonal(); }
      }
    } finally { polling = false; if (workspace) pollTimer = setTimeout(pollBrowser, 5000); }
  }
  find("browser").addEventListener("click", async () => {
    find("browser").disabled = true;
    try { if (workspace) await disconnectBrowser(); else await connectBrowser(); }
    catch (error) { browserState(error.message); }
    finally { find("browser").disabled = !owner; }
  });
  dialog.addEventListener("mcp-settings-open", () => { ++generation; clearSecret(); void load(); });
  dialog.addEventListener("close", () => { ++generation; clearSecret(); });
  root.addEventListener("qa-report-account-change", () => { ++generation; csrfCache = undefined; clearSecret(); owner = undefined; find("form").hidden = true; find("keys").replaceChildren(); find("browser").disabled = true; void disconnectBrowser(); if (dialog.open) void load(); });
  root.QaPersonalMcp = { authHeaders };
  browserState("Локальный доступ выключен.");
  if (sessionStorage.getItem(storageKey)) void load();
})(window);
