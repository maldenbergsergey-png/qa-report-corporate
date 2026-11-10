(function () {
  "use strict";
  const dialog = document.getElementById("mcpSettingsDialog");
  if (!dialog) return;
  const section = document.createElement("section"); section.className = "mcp-settings-connection mcp-developer";
  section.innerHTML = `<h3>Доступ к отчётам</h3><p class="mcp-note">Подключите MCP один раз, затем отправляйте ассистенту ссылки на отчёты.</p>
    <div class="mcp-inline-actions"><button type="button" class="button button-secondary" data-project-install>Скопировать запрос подключения</button></div>
    <textarea data-project-install-text class="import-textarea mcp-settings-code" hidden readonly aria-label="Запрос установки MCP"></textarea><p data-project-install-state role="status"></p>
    <p data-project-state role="status" aria-live="polite"></p>
    <form data-project-grant-form hidden><h4>Доступ сотрудника к проекту</h4>
      <div class="mcp-settings-choices"><label class="field"><span>Корпоративный email</span><input type="email" maxlength="254" required data-project-recipient></label><label class="field"><span>Проект</span><select data-project-grant-project></select></label></div>
      <label class="field"><span>Ссылка на задачу в Jira или Eva</span><input type="url" data-project-grant-url required></label>
      <label class="mcp-project-readonly"><input type="checkbox" data-project-grant-readonly> Только чтение</label>
      <div class="mcp-inline-actions"><button type="submit" class="button button-primary" data-project-grant-create>Выдать доступ</button><span class="mcp-note">Ваши публикации проекта · 30 дней</span></div>
    </form><div data-project-grants></div>
    <form data-project-form hidden><h4>Проектный ключ по приглашению</h4><div class="mcp-settings-choices"><label class="field"><span>Проект</span><select data-project-select required><option value="">Выберите проект</option></select></label><label class="field"><span>Название ключа</span><input data-project-label maxlength="100" value="Разработчик" required autocomplete="off"></label></div>
      <label class="mcp-project-readonly"><input type="checkbox" data-project-readonly> Только чтение</label><div class="mcp-inline-actions"><button class="button button-primary" type="submit" data-project-create>Создать ключ</button><span class="mcp-note">На 30 дней · результаты QA сохраняются</span></div>
    </form>
    <div data-project-issued hidden><div class="mcp-settings-choices"><label class="field"><span>Ассистент разработчика</span><select data-project-client></select></label></div>
      <div class="mcp-inline-actions"><button class="button button-primary" type="button" data-project-copy>Скопировать запрос</button><button class="button button-ghost" type="button" data-project-done>Готово</button><span class="mcp-note" data-project-expiry></span></div><p class="mcp-note" data-project-help></p><p class="mcp-note">Ключ показывается только сейчас. Передайте запрос разработчику лично.</p>
      <details data-project-options><summary>Настройки подключения</summary><label class="field"><span>Система</span><select data-project-platform><option value="posix">macOS / Linux</option><option value="windows">Windows (PowerShell)</option></select></label><p class="mcp-note">Нужен <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22+</a>.</p><textarea class="import-textarea mcp-settings-code" data-project-code readonly spellcheck="false" aria-label="Подключение к проекту"></textarea></details>
    </div><div data-project-keys></div><button class="button button-ghost" type="button" data-project-refresh>Обновить список</button>`;
  dialog.querySelector('[data-mcp-panel="developer"]').append(section);
  const find = key => section.querySelector(`[data-project-${key}]`);
  const select = find("select"), client = find("client"), platform = find("platform"), code = find("code"), state = find("state");
  client.replaceChildren(...[...dialog.querySelector("[data-client]").options].map(item => new Option(item.text, item.value)));
  platform.value = /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
  let issued, packageUrl, generation = 0, busy = false;
  function clearIssued() { issued = undefined; packageUrl = undefined; code.value = ""; find("issued").hidden = true; }
  function message(text) { state.textContent = text; }
  find("install").addEventListener("click", async () => {
    const ticket = generation, output = find("install-text"), status = find("install-state"), button = find("install");
    button.disabled = true; output.hidden = true; status.textContent = "";
    try {
      const response = await fetch("/api/mcp/package", { cache: "no-store", credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error();
      const metadata = await response.json();
      if (ticket !== generation) return;
      const setup = window.QaReportMcpSetup.buildDeveloperInstall({ origin: location.origin, developerUrl: metadata.developerUrl });
      try { await navigator.clipboard.writeText(setup.code); status.textContent = "Вставьте запрос в чат своего ассистента."; }
      catch { output.value = setup.code; output.hidden = false; output.focus(); output.select(); status.textContent = "Скопируйте выделенный запрос."; }
    } catch { if (ticket === generation) status.textContent = "Не удалось загрузить настройки подключения."; }
    finally { button.disabled = false; }
  });
  dialog.addEventListener("close", () => { find("install-text").hidden = true; find("install-state").textContent = ""; });
  async function headers(method) {
    if (typeof authCsrfToken === "function") return method === "GET" ? {} : { "X-QA-CSRF-Token": await authCsrfToken() };
    if (typeof loadReportAccountClient !== "function") return {};
    const { account, publishableKey } = await loadReportAccountClient();
    const token = await account?.sessionToken(publishableKey);
    return token ? { "X-QA-Report-Session": token } : {};
  }
  async function request(path = "", method = "GET", body, ticket = generation, api = "/api/mcp/project-keys") {
    const auth = await headers(method);
    if (ticket !== generation) throw new Error("Операция отменена: окно или аккаунт изменились.");
    const response = await fetch(api + path, { method, credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
      headers: { ...auth, "X-QA-Project-Request": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (ticket !== generation) throw new Error("Операция отменена: окно или аккаунт изменились.");
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить проекты и ключи.");
    return data;
  }
  const grantForm = find("grant-form"), grantProject = find("grant-project"), grantUrl = find("grant-url");
  function grantSource() {
    grantUrl.closest("label").hidden = Boolean(grantProject.value);
    grantUrl.required = !grantProject.value;
  }
  grantProject.addEventListener("change", grantSource);
  function renderGrants(grants) {
    const list = find("grants");
    list.replaceChildren();
    for (const grant of grants) {
      const row = document.createElement("div"); row.className = "mcp-project-key";
      const label = document.createElement("span");
      label.textContent = `${grant.recipient} · ${grant.projectKey} · ${grant.trackerUrl} · ${grant.canReply ? "чтение и ответы" : "только чтение"} · до ${new Date(grant.expiresAt).toLocaleDateString()}`;
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "button button-ghost"; revoke.textContent = "Отозвать доступ";
      revoke.addEventListener("click", async () => {
        if (busy) return;
        const ticket = generation;
        busy = true; revoke.disabled = true;
        try { const result = await grantRequest("/" + grant.id, "DELETE", undefined, ticket); renderGrants(result.grants); message("Доступ к проекту отозван."); }
        catch (error) { if (ticket === generation) message(error.message); }
        finally { busy = false; revoke.disabled = false; }
      });
      row.append(label, revoke); list.append(row);
    }
  }
  function grantRequest(path, method, body, ticket) {
    return request(path, method, body, ticket, "/api/mcp/developer/grants");
  }
  async function grantProjects(published) {
    const options = published.map(project => ({ label: project.projectKey + " · " + project.trackerUrl, value: project.id,
      key: JSON.stringify([project.provider, project.trackerUrl, project.projectKey]) }));
    const known = new Set(options.map(option => option.key));
    const local = typeof getAllReports === "function" ? await getAllReports().catch(() => []) : [];
    if (typeof draft !== "undefined" && draft?.issueUrl) local.push(draft);
    for (const record of local) {
      const issue = window.QaReportTrackerLinks.parse(record.document?.issueUrl || record.issueUrl);
      const projectKey = issue?.key.match(/^([\p{L}\p{N}_][\p{L}\p{N}_-]{0,99})-\d+$/u)?.[1]?.toUpperCase();
      if (!projectKey) continue;
      const key = JSON.stringify([issue.provider, issue.baseUrl, projectKey]);
      if (known.has(key)) continue;
      known.add(key); options.push({ label: projectKey + " · " + issue.baseUrl, value: issue.issueUrl });
    }
    return options;
  }
  grantForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const ticket = generation, selection = grantProject.value;
    const source = /^[a-f0-9]{64}$/.test(selection) ? { projectId: selection } : { issueUrl: selection || grantUrl.value.trim() };
    busy = true; find("grant-create").disabled = true;
    try {
      const result = await grantRequest("", "POST", { recipient: find("recipient").value.trim(), readOnly: find("grant-readonly").checked, ...source }, ticket);
      renderGrants(result.grants); message("Доступ сотрудника сохранён.");
    } catch (error) { if (ticket === generation) message(error.message); }
    finally { busy = false; find("grant-create").disabled = false; }
  });
  function clearGrants() { renderGrants([]); grantForm.reset(); grantSource(); grantForm.hidden = true; }
  dialog.addEventListener("close", clearGrants);
  window.addEventListener("qa-report-account-change", clearGrants);
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
      const [data, access] = await Promise.all([request("", "GET", undefined, ticket), grantRequest("", "GET", undefined, ticket)]);
      const available = await grantProjects(data.projects);
      if (ticket !== generation) return;
      const selected = grantProject.value;
      grantProject.replaceChildren(new Option("По ссылке на задачу", ""), ...available.map(item => new Option(item.label, item.value)));
      grantProject.value = selected; grantSource(); grantForm.hidden = false;
      renderGrants(access.grants);
      select.replaceChildren(new Option("Выберите проект", ""));
      for (const project of data.projects) select.add(new Option(`${project.projectKey} · ${project.trackerUrl} · отчётов: ${project.reportCount}`, project.id));
      if (data.projects.some(project => project.id === selectedProject)) select.value = selectedProject;
      find("form").hidden = !data.projects.length || Boolean(issued);
      renderKeys(data.keys);
      message("");
    } catch (error) { if (ticket === generation && dialog.open) { find("keys").replaceChildren(); clearGrants(); message(error.message); } }
  }
  function updateCode() {
    code.value = ""; if (!issued || !packageUrl) return;
    const setup = window.QaReportMcpSetup.buildSetup({ project: issued.connection, packageUrl, client: client.value, windows: platform.value === "windows", readOnly: !issued.key.canReply });
    code.value = setup.code; find("help").textContent = setup.help; find("copy").textContent = client.value.endsWith("-chat") ? "Скопировать запрос" : "Скопировать настройки"; if (!client.value.endsWith("-chat")) find("options").open = true;
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
      find("expiry").textContent = `До ${new Date(value.key.expiresAt).toLocaleDateString()}`;
      await load(ticket);
    } catch (error) { if (ticket === generation) message(error.message); }
    finally { busy = false; find("create").disabled = false; }
  });
  client.addEventListener("change", updateCode); platform.addEventListener("change", updateCode);
  find("done").addEventListener("click", () => { clearIssued(); void load(); });
  find("copy").addEventListener("click", async () => {
    if (!issued || issued.key.expiresAt <= Date.now()) { clearIssued(); message("Срок ключа истёк. Создайте новое подключение."); return; }
    try { await navigator.clipboard.writeText(code.value); message("Скопировано."); }
    catch { code.focus(); code.select(); message("Скопируйте выделенный текст вручную."); }
  });
  find("refresh").addEventListener("click", () => { if (!busy) void load(); });
  dialog.addEventListener("mcp-settings-open", () => { ++generation; clearIssued(); select.value = ""; find("keys").replaceChildren(); void load(); });
  dialog.addEventListener("close", () => { ++generation; clearIssued(); });
  window.addEventListener("qa-report-account-change", () => { ++generation; clearIssued(); select.value = ""; find("keys").replaceChildren(); find("form").hidden = true; if (dialog.open) void load(); });
})();
