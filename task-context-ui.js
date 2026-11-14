(function () {
  "use strict";
  const Context = window.QaReportTaskContext, Links = window.QaReportTrackerLinks;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
  function link(task) { const a = node("a", Context.label(task)); a.title = Context.label(task); a.href = task.issueUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }
  let api, busy = false, inventory = null, historyReports = [], historyProject = "", lastReport = "";
  const field = document.getElementById("issueUrl");
  const button = node("button", "Получить данные", "task-context-fetch"); button.type = "button";
  const inputWrap = node("div", "", "task-context-input"); field.before(inputWrap); inputWrap.append(field, button);
  const metadata = node("div", "", "task-context-metadata"); inputWrap.after(metadata);
  const feedback = node("p", "", "task-context-feedback"); feedback.setAttribute("role", "status"); feedback.hidden = true; metadata.after(feedback);
  const parentFilter = document.getElementById("historyParentFilter"), loadChildren = document.getElementById("historyLoadTasks");
  function message(text = "") { feedback.textContent = text; feedback.hidden = !text; }
  function render() {
    if (!api) return;
    if (lastReport !== api.getDraft().reportId) { message(); lastReport = api.getDraft().reportId; }
    const saved = Context.forReport(api.getDraft()), info = saved || Context.normalize({ issueUrl: field.value }, field.value);
    button.disabled = busy || !field.value.trim(); button.textContent = busy ? "Загружаем…" : saved ? "Обновить данные" : "Получить данные";
    metadata.replaceChildren(); metadata.hidden = !info;
    if (!info) return;
    if (info.summary) { const title = node("span", info.summary, "task-context-title"); title.title = info.summary; metadata.append(title); }
    const details = node("details", "", "task-context-details");
    details.append(node("summary", info.parent ? `${info.parent.typeName || "Родитель"} · ${info.parent.key}` : "Указать родителя", "task-parent-label"));
    details.querySelector("summary").title = info.parent ? Context.label(info.parent) : "Указать родительскую задачу";
    const panel = node("div", "", "task-context-panel");
    for (const [index, task] of [info.parent, ...info.ancestors].filter(Boolean).entries()) {
      panel.append(node("small", index === 0 ? "Родительская задача" : task.typeName || "Выше по иерархии"), link(task));
    }
    const edit = node("button", "Указать родителя вручную"); edit.type = "button";
    edit.addEventListener("click", () => { details.open = false; manualParent().catch(error => message(error.message)); }); panel.append(edit);
    if (info.parent) {
      const clear = node("button", "Убрать связь"); clear.type = "button";
      clear.addEventListener("click", () => { api.apply({ ...info, parent: null, ancestors: [], parentSource: "manual" }, info.issueUrl); message(); }); panel.append(clear);
    }
    if (info.parentSource === "manual") {
      const restore = node("button", "Получить связь из трекера"); restore.type = "button";
      restore.addEventListener("click", () => { const next = { ...info }; delete next.parentSource; api.apply(next, info.issueUrl); fetchDetails(); }); panel.append(restore);
    }
    details.append(panel); metadata.append(details);
  }
  document.addEventListener("pointerdown", event => { for (const details of metadata.querySelectorAll("details[open]")) if (!details.contains(event.target)) details.open = false; });
  metadata.addEventListener("keydown", event => { if (event.key === "Escape") { const details = metadata.querySelector("details[open]"); if (details) { details.open = false; details.querySelector("summary").focus(); } } });
  function promptForm(title, controls) {
    return new Promise(resolve => {
      const dialog = node("dialog", "", "task-context-dialog"), form = node("form"); form.method = "dialog";
      form.append(node("h2", title));
      for (const [caption, control] of controls) { const label = node("label", caption); label.append(control); form.append(label); }
      const actions = node("div", "", "task-context-actions"), cancel = node("button", "Отмена"), accept = node("button", "Применить");
      cancel.type = "button"; cancel.addEventListener("click", () => dialog.close()); accept.value = "apply"; actions.append(cancel, accept); form.append(actions); dialog.append(form); document.body.append(dialog);
      dialog.addEventListener("close", () => { resolve(dialog.returnValue === "apply"); dialog.remove(); }, { once: true }); dialog.showModal();
    });
  }
  async function target(value) {
    const reference = Links.parse(value), all = await api.connections();
    const matches = all.filter(item => !reference || item.baseUrl === reference.baseUrl && item.provider === reference.provider);
    if (!matches.length) throw new Error("Подключите эту систему задач в настройках приложения.");
    let chosen = matches[0];
    if (matches.length > 1) {
      const select = node("select"); select.setAttribute("aria-label", "Подключение системы задач");
      matches.forEach((item, i) => select.add(new Option(`${item.provider === "eva" ? "EVA" : "Jira"} · ${item.baseUrl}`, String(i))));
      if (!await promptForm("Откуда получить задачу", [["Подключение", select]])) return null;
      chosen = matches[Number(select.value)];
    }
    const key = reference?.key || value.trim();
    if (!key || /[\s/?#]/.test(key)) throw new Error("Укажите ключ задачи или ссылку из подключённого трекера.");
    return { ...chosen, issueKey: key };
  }
  async function fetchDetails() {
    if (busy || !api) return;
    const reportId = api.getDraft().reportId, value = field.value.trim(); busy = true; message(); render();
    try {
      const selected = await target(value); if (!selected) return;
      const result = await api.request("issue-details", selected);
      if (api.getDraft().reportId !== reportId || field.value.trim() !== value) return;
      let info = Context.normalize(result.task, result.task?.issueUrl);
      if (!info || !Links.parse(info.issueUrl) || Links.parse(info.issueUrl).baseUrl !== selected.baseUrl || info.key.toLowerCase() !== selected.issueKey.toLowerCase()) throw new Error("Трекер не вернул данные выбранной задачи.");
      const old = Context.forReport(api.getDraft());
      if (old?.issueUrl === info.issueUrl && old.parentSource === "manual") info = { ...info, parent: old.parent, ancestors: old.ancestors, parentSource: "manual" };
      api.apply(info, info.issueUrl);
      message(result.warnings?.join(" ") || "");
      if (!result.warnings?.length) api.toast("Данные задачи получены");
    } catch (error) { if (api.getDraft().reportId === reportId && field.value.trim() === value) message(error.message); }
    finally { busy = false; render(); }
  }
  async function manualParent() {
    const before = api.getDraft(), info = Context.forReport(before) || Context.normalize({ issueUrl: field.value }, field.value); if (!info) return;
    const reportId = before.reportId, input = node("input"), title = node("input");
    input.placeholder = "Ключ или ссылка задачи"; input.value = info.parent?.issueUrl || ""; input.required = true; title.placeholder = "Необязательно"; title.value = info.parent?.summary || "";
    if (!await promptForm("Родительская задача", [["Ключ или ссылка", input], ["Название", title]])) return;
    if (api.getDraft().reportId !== reportId || Links.identity(api.getDraft().issueUrl) !== info.issueUrl) return;
    const current = Links.parse(info.issueUrl), parsed = Links.parse(input.value) || Links.parse(current.baseUrl + (current.provider === "eva" ? "/desk/Task/" : "/browse/") + encodeURIComponent(input.value.trim()));
    if (!parsed || parsed.baseUrl !== current.baseUrl || parsed.provider !== current.provider || parsed.issueUrl === info.issueUrl) throw new Error("Выберите другую задачу в том же подключении.");
    const parent = Context.task({ ...parsed, summary: title.value });
    api.apply({ ...info, parent, ancestors: [], parentSource: "manual" }, info.issueUrl); message();
  }
  function historyParents(reports, project) {
    historyReports = reports; historyProject = project;
    const parents = new Map();
    for (const report of reports) {
      const info = Context.forReport(report), projectKey = Links.projectKey(Links.parse(report.document?.issueUrl ?? report.issueUrl)?.key || report.issueKey);
      if (project && !(project === "none" ? !projectKey : projectKey === project)) continue;
      if (info?.parent) parents.set(info.parent.issueUrl, info.parent);
    }
    const selected = parentFilter.value;
    parentFilter.replaceChildren(new Option("Все родительские задачи", ""), new Option("Без родительской задачи", "none"), ...[...parents.values()].sort((a, b) => Context.label(a).localeCompare(Context.label(b))).map(item => {
      const option = new Option(Context.label(item), item.issueUrl); option.title = Context.label(item) + " · " + item.issueUrl; return option;
    }));
    parentFilter.value = selected === "none" || parents.has(selected) ? selected : "";
    parentFilter.title = Context.label(parents.get(parentFilter.value)) || "Фильтр по родительской задаче";
    loadChildren.hidden = !parentFilter.value || parentFilter.value === "none";
    loadChildren.disabled = busy;
    if (inventory?.parent.issueUrl !== parentFilter.value) inventory = null;
  }
  function historyMatches(report) {
    const value = parentFilter.value, info = Context.forReport(report);
    return !value || (value === "none" ? !info?.parent : info?.parent?.issueUrl === value || inventory?.tasks.some(item => item.issueUrl === Links.identity(report.document?.issueUrl ?? report.issueUrl)));
  }
  function decorateHistory(heading, report) {
    const info = Context.forReport(report); if (!info) return;
    if (info.summary) { const title = node("span", info.summary, "history-task-title"); title.title = info.summary; heading.querySelector("h3").after(title); }
    if (info.parent) {
      const parent = link(info.parent); parent.className = "task-parent-label history-task-parent"; parent.textContent = `${info.parent.typeName || "Родитель"} · ${info.parent.key}`; parent.title = Context.label(info.parent); heading.after(parent);
    }
  }
  async function fetchChildren() {
    const value = parentFilter.value; if (!value || value === "none" || busy) return;
    busy = true; loadChildren.disabled = true; loadChildren.textContent = "Загружаем…";
    try {
      const selected = await target(value); if (!selected) return;
      const result = await api.request("issue-children", selected);
      if (parentFilter.value !== value) return;
      const parent = Context.task(result.parent);
      if (!parent || parent.issueUrl !== value || !Array.isArray(result.tasks)) throw new Error("Не удалось проверить состав родителя.");
      const source = Links.parse(value);
      inventory = { parent, tasks: result.tasks.map(Context.task).filter(item => item && Links.parse(item.issueUrl).baseUrl === source.baseUrl && Links.parse(item.issueUrl).provider === source.provider) };
      await api.historyRender();
    } catch (error) { api.toast(error.message); }
    finally { busy = false; loadChildren.disabled = false; loadChildren.textContent = "Загрузить задачи родителя"; }
  }
  function renderInventory(container) {
    if (!inventory || parentFilter.value !== inventory.parent.issueUrl) return;
    const known = new Set(historyReports.map(report => Links.identity(report.document?.issueUrl ?? report.issueUrl)));
    const tasks = inventory.tasks.filter(task => !historyProject || (historyProject === "none" ? !task.projectKey : task.projectKey === historyProject));
    const missing = tasks.filter(task => !known.has(task.issueUrl)), section = node("section", "", "history-task-inventory");
    section.append(node("h3", `Задачи родителя · ${tasks.length} · Без чек-листов в этом браузере: ${missing.length}`));
    if (!missing.length) section.append(node("p", tasks.length ? "Для всех загруженных задач есть локальные чек-листы." : "В выбранном проекте нет доступных дочерних задач."));
    for (const task of missing) {
      const row = node("div", "", "history-task-missing"), create = node("button", "Создать чек-лист"); create.type = "button";
      create.addEventListener("click", () => api.start({ ...task, parent: inventory.parent, ancestors: [] })); row.append(link(task), create); section.append(row);
    }
    container.append(section);
  }
  button.addEventListener("click", fetchDetails);
  field.addEventListener("input", () => { message(); render(); });
  parentFilter.addEventListener("change", () => { inventory = null; api.historyRender().catch(error => api.toast(error.message)); });
  loadChildren.addEventListener("click", fetchChildren);
  window.QaReportTaskUI = { init(value) { api = value; render(); }, render, historyParents, historyMatches, decorateHistory, renderInventory, releaseHistory() { historyReports = []; } };
})();
