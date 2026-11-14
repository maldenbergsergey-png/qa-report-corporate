(function () {
  "use strict";
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function filter(select) {
    const trigger = node("button", "", `${select.className} history-filter-trigger`);
    trigger.type = "button";
    trigger.id = `${select.id}Button`;
    trigger.setAttribute("aria-haspopup", "dialog");
    select.hidden = true;
    select.after(trigger);
    const content = node("div", "", "history-filter-content");
    const heading = node("strong", select.getAttribute("aria-label"));
    const search = node("input");
    search.type = "search"; search.placeholder = "Найти…";
    search.setAttribute("aria-label", `Поиск: ${select.getAttribute("aria-label").toLowerCase()}`);
    const options = node("div", "", "history-filter-options");
    options.setAttribute("role", "group");
    options.setAttribute("aria-label", "Варианты фильтра");
    content.append(heading, search, options);
    const panel = createHistoryPopover(trigger, content);
    panel.classList.add("history-filter-popover");
    trigger.after(panel);
    function renderOptions() {
      const query = search.value.trim().toLocaleLowerCase();
      options.replaceChildren();
      for (const option of select.options) {
        if (query && !`${option.textContent} ${option.value}`.toLocaleLowerCase().includes(query)) continue;
        const button = node("button", "", "history-filter-option");
        button.type = "button";
        button.dataset.value = option.value;
        button.setAttribute("aria-pressed", String(option.selected));
        const text = node("span", option.textContent);
        text.title = option.title || option.textContent;
        button.append(text, node("span", option.selected ? "✓" : "", "history-filter-check"));
        button.addEventListener("click", () => {
          if (select.disabled) return;
          select.value = option.value;
          sync();
          closeHistoryActionMenus({ restoreFocus: true });
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        options.append(button);
      }
      if (!options.children.length) options.append(node("p", "Ничего не найдено", "history-filter-empty"));
    }
    function sync() {
      const label = select.selectedOptions[0]?.textContent || select.options[0]?.textContent || "";
      trigger.textContent = label;
      trigger.title = label;
      trigger.disabled = select.disabled;
      trigger.setAttribute("aria-label", `${select.getAttribute("aria-label")}: ${label}`);
      trigger.dataset.filtered = String(Boolean(select.value));
      if (panel.matches(":popover-open")) renderOptions();
    }
    trigger.addEventListener("click", () => { search.value = ""; renderOptions(); search.focus(); });
    select.addEventListener("change", sync);
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });
    panel.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target === search && !event.key.startsWith("Arrow")) return;
      const items = [...options.querySelectorAll("button")];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    });
    search.addEventListener("input", renderOptions);
    sync();
  }
  function ai(report, trigger) {
    trigger.classList.add("history-ai-button");
    const indicator = node("span", "", "history-ai-indicator");
    indicator.setAttribute("aria-hidden", "true");
    trigger.append(indicator);
    const content = node("div", "", "history-ai-content");
    const heading = node("div", "", "history-ai-heading");
    heading.append(node("strong", "Приём от ИИ"));
    const close = node("button", "×", "icon-button");
    close.type = "button"; close.setAttribute("aria-label", "Закрыть приём результатов");
    close.addEventListener("click", () => closeHistoryActionMenus({ restoreFocus: true }));
    heading.append(close);
    const reportLabel = node("p", `${reportIssueLabel(report)} · ${reportPublicId(report)}`, "history-ai-report");
    const status = node("p", "", "history-ai-status");
    status.setAttribute("role", "status");
    const hint = node("p", "", "history-ai-hint");
    const actions = node("div", "", "history-ai-actions");
    const start = node("button", "Включить приём", "button button-primary");
    const copy = node("button", "Скопировать промпт", "button button-secondary");
    const stop = node("button", "Остановить", "button button-ghost");
    for (const button of [start, copy, stop]) button.type = "button";
    actions.append(start, copy, stop);
    const intro = node("div", "", "history-ai-intro");
    const body = node("div", "", "history-ai-body");
    intro.append(heading, reportLabel);
    body.append(status, hint);
    content.append(intro, body, actions);
    const panel = createHistoryPopover(trigger, content);
    panel.classList.add("history-ai-popover");
    panel.dataset.historyAiPanel = report.id;
    let busy = false, error = "";
    panel.__update = () => {
      const state = window.QaLocalImport.historyState(report.id);
      const active = state.active;
      status.textContent = error || (state.starting ? "Включаем приём…" : state.stopping ? "Останавливаем…" : active
        ? `Приём включён · до ${new Date(state.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Приём выключен");
      status.dataset.state = error ? "error" : active ? "on" : "off";
      start.hidden = active && !state.remote;
      start.textContent = state.remote ? "Возобновить приём" : "Включить приём";
      start.disabled = busy || state.starting || state.stopping;
      copy.hidden = !active || state.personal;
      copy.disabled = busy || state.stopping;
      stop.hidden = !active;
      stop.disabled = busy || state.stopping;
      hint.textContent = state.personal ? "Подключено через MCP. Промпт доступен в настройках MCP-сервера."
        : state.remote ? "Возобновите приём, чтобы получать результаты в этой вкладке."
        : active ? "Передайте промпт ИИ и оставьте вкладку открытой."
        : "Включите приём, чтобы получить промпт для ИИ.";
      if (panel.matches(":popover-open")) positionHistoryPopover(panel, trigger);
    };
    async function run(action) {
      if (busy) return;
      busy = true; error = ""; panel.__update();
      try { await flushVisibleHistoryComments(); await action(); }
      catch (cause) { error = cause.message; }
      finally {
        busy = false; panel.__update();
        if (panel.matches(":popover-open") && (document.activeElement.hidden || document.activeElement.disabled)) {
          actions.querySelector("button:not([hidden]):not(:disabled)")?.focus();
        }
      }
    }
    start.addEventListener("click", () => run(() => window.QaLocalImport.start(report.id)));
    copy.addEventListener("click", () => run(() => window.QaLocalImport.copy(report.id)));
    stop.addEventListener("click", () => run(() => window.QaLocalImport.stop(report.id)));
    trigger.addEventListener("click", () => {
      panel.__update();
      window.QaLocalImport.syncSessions().then(() => panel.__update());
    });
    return panel;
  }
  window.QaHistoryControls = { ai };
  for (const id of ["historyProjectFilter", "historyParentFilter"]) filter(document.getElementById(id));
})();
