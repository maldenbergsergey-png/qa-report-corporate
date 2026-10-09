(function () {
  "use strict";
  const Bugs = window.QaReportBugs;
  const PROMPT_KEY = "qa-report-bug-prompt-v1", MAPPING_KEY = "qa-report-bug-mappings-v1", TARGET_KEY = "qa-report-bug-target-v1";
  const LAYOUT_KEY = "qa-report-bug-layout-v1";
  const TYPE_CHOICES_KEY = "qa-report-bug-types-v1", TYPE_SETTINGS_KEY = "qa-report-bug-type-settings-v1";
  const $ = id => document.getElementById(id);
  function uiIcon(name) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.classList.add("ui-icon"); icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", `#icon-${name}`); icon.append(use); return icon;
  }
  let api, state = null, contextDockFrame = 0;
  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  const assetKey = asset => JSON.stringify([asset.attachmentId, asset.source.issueUrl, asset.source.id]);
  const ATTACHMENT_DRAG = "application/x-qa-bug-attachment";
  const descriptionControl = () => $("bugEditor").querySelector('[data-bug-field="description"] textarea');
  function removeInlineAsset(asset) {
    const key = assetKey(asset), placeholder = state.inlineAssets[key], control = descriptionControl();
    if (placeholder && control) { control.value = control.value.split(placeholder).join(""); control.dataset.bugTouched = "true"; control.dispatchEvent(new Event("input", { bubbles: true })); }
    delete state.inlineAssets[key];
  }
  function insertAssets(assets, offset = descriptionControl()?.selectionStart) {
    const control = descriptionControl();
    if (!control || !state || !state.inlineReady || state.busy || state.pending || state.created) return;
    const tokens = inlineTokens(assets);
    if (!tokens.length) return;
    const rich = window.QaReportBugRich.get(control);
    if (control.hidden && rich) { rich.insertTokens(tokens, offset instanceof Range ? offset : undefined); return; }
    const start = Math.max(0, Math.min(control.value.length, (typeof offset === "object" ? offset.start : offset) ?? control.value.length)), text = tokens.join("\n");
    const end = typeof offset === "object" ? Math.max(start, Math.min(control.value.length, offset.end ?? start)) : start;
    control.focus(); control.setRangeText(text, start, end, "end"); control.dataset.touched = "true";
    control.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function inlineTokens(assets) {
    const added = assets.filter(asset => !state.assets.some(current => assetKey(current) === assetKey(asset)));
    if (added.length) { state.assets.push(...added); state.extraAssets.push(...added.filter(asset => !state.extraAssets.some(current => assetKey(current) === assetKey(asset)))); $("bugAiAttachments").checked = true; refreshAssets(); }
    return assets.map(asset => {
      const key = assetKey(asset);
      if (!state.inlineAssets[key]) {
        const name = String(asset.name || "Файл").replace(/[\[\]|!\r\n\x00-\x1f]/g, " ").slice(0, 180).trim() || "Файл";
        const image = asset.type.startsWith("image/") || asset.source.kind === "image" || /\.(png|jpe?g|gif|webp|bmp)$/i.test(asset.name);
        const reference = name => image ? `!${name}|thumbnail!` : `[^${name}]`;
        let suffix = 1, token = reference(name);
        while (Object.values(state.inlineAssets).includes(token)) token = reference(`${name} (${++suffix})`);
        state.inlineAssets[key] = token;
      }
      const check = [...$("bugAttachmentList").querySelectorAll("input")].find(el => el.dataset.assetKey === key);
      if (check) check.checked = true;
      return state.inlineAssets[key];
    });
  }
  function dropOffset(control, event) {
    // Match the textarea's wrapping and scroll position so a drop inserts at the pointer.
    const rect = control.getBoundingClientRect(), style = getComputedStyle(control), mirror = document.createElement("div");
    for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "padding", "border", "boxSizing", "textIndent", "tabSize"]) mirror.style[name] = style[name];
    Object.assign(mirror.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden", opacity: "0", zIndex: "2147483647" });
    const text = document.createTextNode(control.value || " "); mirror.append(text); document.body.append(mirror); mirror.scrollTop = control.scrollTop; mirror.scrollLeft = control.scrollLeft;
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY), range = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
    const node = caret?.offsetNode || range?.startContainer, offset = caret?.offset ?? range?.startOffset;
    mirror.remove(); return node === text ? Math.min(control.value.length, offset) : control.selectionStart;
  }
  function prompt() { const value = read(PROMPT_KEY, Bugs.DEFAULT_PROMPT); return typeof value === "string" && ![Bugs.LEGACY_DEFAULT_PROMPT, Bugs.PREVIOUS_DEFAULT_PROMPT, Bugs.CHECKLIST_DEFAULT_PROMPT, Bugs.TRACKER_DEFAULT_PROMPT].includes(value) && value.trim() && value.length <= 16000 ? value : Bugs.DEFAULT_PROMPT; }
  function row() { return api.getDraft().sections.find(s => s.id === state.sectionId)?.rows.find(r => r.id === state.rowId); }
  // Keep unfinished standalone operations separate from checklist documents.
  async function standaloneRecord(action, value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("qa-report-standalone-bug-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("operations");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("operations", action === "get" ? "readonly" : "readwrite"), store = tx.objectStore("operations");
        const request = action === "get" ? store.getAll() : action === "save" ? store.put({ ...value, updatedAt: Date.now() }, value.pending?.id || value.created.operationId) : store.delete(value);
        tx.oncomplete = () => resolve(action === "get" ? request.result.sort((a, b) => a.updatedAt - b.updatedAt)[0] : request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("Не удалось сохранить создание бага в браузере."));
      });
    } finally { db.close(); }
  }
  async function persist() {
    if (!state.standalone) { api.changed(); return; }
    const created = state.created;
    if (created && !created.attachmentsPending && !created.evidencePending) await standaloneRecord("clear", created.operationId);
    else await standaloneRecord("save", { pending: created ? null : state.pending, created,
      contextText: $("bugContextText").value, extraAssets: state.pending?.extraAssets || created?.extraAssets || [] });
  }
  const needsContext = () => state.standalone && !$("bugContextText").value.trim();
  function message(text, error = false) { $("bugReportMessage").textContent = text; $("bugReportState").classList.toggle("error", error); $("bugReportState").hidden = !text; }
  function scheduleContextDock() {
    if (contextDockFrame) return;
    contextDockFrame = requestAnimationFrame(() => {
      contextDockFrame = 0;
      const input = $("bugContextText"), dock = $("bugReportModal").querySelector(".bug-context-dock");
      let covered = 0;
      if (state?.step === 2 && !state.busy) {
        const field = input.getBoundingClientRect(), panel = dock.getBoundingClientRect();
        covered = Math.min(field.height, Math.max(0, field.bottom - panel.top));
      }
      input.style.setProperty("--bug-context-occlusion", `${covered}px`);
      dock.dataset.pinned = String(covered > 0);
    });
  }
  function steps(step = 1) {
    state.step = typeof step === "boolean" ? step ? 3 : 1 : step;
    const modal = $("bugReportModal").querySelector("[role=dialog]");
    modal.dataset.step = state.step;
    modal.classList.toggle("bug-success-modal", state.step === 4);
    for (const [i, id] of ["bugStepTarget", "bugStepPrepare", "bugStepDraft"].entries()) {
      const item = $(id), number = i + 1;
      item.removeAttribute("aria-current");
      if (number === state.step) item.setAttribute("aria-current", "step");
      item.classList.toggle("complete", number < state.step);
      item.firstElementChild.replaceChildren(number < state.step ? uiIcon("check") : String(number));
    }
    $("bugTargetSection").hidden = state.step !== 1;
    $("bugPreparation").hidden = state.step !== 2;
    $("bugEditor").hidden = state.step !== 3;
    if (state.step === 3) window.QaReportBugRich.sync($("bugEditor"));
    $("bugCreatedResult").hidden = state.step !== 4;
    $("bugBack").hidden = state.step === 1 || state.step === 4;
    $("loadBugContext").hidden = state.step !== 1;
    $("bugPrepareDraft").hidden = state.step !== 2;
    $("bugManualDraft").hidden = state.step !== 2 || Boolean(state.draftReady) || !state.profiles.length;
    $("bugReviewDraft").hidden = state.step !== 2 || !state.draftReady;
    $("generateBugDraft").hidden = state.step !== 3;
    $("createBugIssue").hidden = state.step < 3 || Boolean(state.created && !state.uploadsPending && !state.evidencePending);
    $("cancelBugReport").textContent = state.step === 4 ? "Закрыть" : "Отмена";
    $("cancelBugReport").hidden = true;
    $("bugReportTitle").textContent = state.step === 4 ? "Баг-репорт создан" : "Завести баг-репорт";
    $("bugReportEyebrow").textContent = "Создание задачи";
    $("bugReportModal").querySelector(".bug-report-body").scrollTop = 0; scheduleContextDock();
  }
  function targetControls() {
    if (!state) return;
    if (state.inlineDevices) {
      const t = target(), device = state.inlineDevices.find(d => (t.provider === "eva" ? d.evaBaseUrls || [] : d.jiraBaseUrls?.length ? d.jiraBaseUrls : [d.jiraBaseUrl]).includes(t.baseUrl));
      const parts = String(device?.version || "0").split(".").map(Number);
      state.inlineReady = Boolean(api.bugStatus || parts[0] > 0 || parts[1] > 6 || parts[1] === 6 && parts[2] >= 16);
    }
    const locked = state.busy || Boolean(state.pending || state.created);
    $("loadBugContext").disabled = locked || !state.ready || !state.fields || !target().issueTypeId || state.loadedTarget !== JSON.stringify(target());
    $("bugConnectionStatus").hidden = !state.ready;
    $("bugBack").disabled = locked || voiceActive();
    $("bugManualDraft").disabled = locked || voiceActive() || state.filesLoading;
    $("bugReviewDraft").disabled = locked || voiceActive();
    $("bugPrepareDraft").disabled = locked || voiceActive() || state.filesLoading || Boolean(state.profiles.length && needsContext());
    $("bugPrepareDraft").textContent = state.busy && state.activity === "generating" ? "Формируется…" : state.profiles.length ? "Сформировать баг-репорт →" : "Заполнить баг-репорт →";
  }
  function busy(value, text, activity = "loading") {
    state.busy = value;
    state.activity = value ? activity : "";
    $("bugSpinner").hidden = !value;
    $("bugDraftResize").setAttribute("aria-disabled", String(value));
    $("bugReportState").classList.toggle("loading", value);
    const modal = $("bugReportModal").querySelector("[role=dialog]");
    modal.setAttribute("aria-busy", String(value));
    modal.dataset.generating = String(Boolean(value && activity === "generating"));
    for (const id of ["bugPreparation", "bugEditor"]) $(id).inert = value && activity === "generating";
    if (value && activity === "generating") $("bugVoiceInfo").open = false;
    for (const id of ["bugJiraConnection", "bugCreationMode", "bugProject", "bugParent", "loadBugContext", "bugIssueType", "loadBugFields"]) $(id).disabled = value || Boolean(state.created || state.pending);
    $("loadBugContext").disabled ||= !state.ready;
    $("createBugIssue").hidden = (!state.fields && !state.pending && !state.created) || Boolean(state.created && !state.uploadsPending && !state.evidencePending);
    $("createBugIssue").disabled = value || (!state.fields && !state.pending && !state.created);
    $("generateBugDraft").disabled = value || Boolean(state.created || state.pending) || voiceActive() || !state.profiles.length;
    $("generateBugDraft").textContent = value && activity === "generating" ? "Формируется…" : "Пересобрать с ИИ";
    if (!(value && activity === "generating")) $("generateBugDraft").prepend(uiIcon("link"));
    $("bugAiProfile").disabled = value || Boolean(state.created || state.pending);
    $("bugAiAttachments").disabled = value || Boolean(state.created || state.pending) || voiceActive() || !state.profiles.length;
    $("closeBugReport").disabled = $("cancelBugReport").disabled = value && state.creating;
    $("cancelBugReport").classList.toggle("button-primary", Boolean(state.created));
    $("cancelBugReport").classList.toggle("button-ghost", !state.created);
    $("createBugIssue").classList.toggle("button-primary", !state.created);
    $("createBugIssue").classList.toggle("button-secondary", Boolean(state.created));
    $("createBugIssue").textContent = value && state.creating ? state.created ? "Завершаем…" : "Создаём…" : state.created ? state.uploadsPending ? "Повторить загрузку" : "Добавить ссылки" : state.pending ? "Проверить результат" : target().provider === "eva" ? "Создать баг в EVA" : "Создать баг в Jira";
    if (!value && !state.created && !state.pending) $("createBugIssue").append(uiIcon("arrow-right"));
    $("bugEditor").querySelectorAll(".bug-jira-field input, .bug-jira-field textarea, .bug-jira-field select, .bug-jira-field button, [data-bug-attachment], [data-bug-mapping]").forEach(el => { el.disabled = Boolean(state.pending || state.created); });
    contextControls();
    steps(state.step || 1); targetControls();
    if (state.created) showCreated();
    if (text) message(text);
  }
  function target() {
    const selected = $("bugJiraConnection").value, provider = selected.startsWith("eva:") ? "eva" : "jira";
    return { provider, baseUrl: provider === "eva" ? selected.slice(4) : selected, mode: document.querySelector('[name="bugCreationMode"]:checked').value,
      projectKey: provider === "eva" ? $("bugProject").value.trim() : $("bugProject").value.trim().toUpperCase(), parent: $("bugParent").value.trim(), issueTypeId: $("bugIssueType").value };
  }
  const rememberTypes = () => read(TYPE_SETTINGS_KEY, {}).remember !== false;
  const typeChoiceKey = (value, projectKey = value.projectKey) => JSON.stringify([value.provider || "jira", value.baseUrl, projectKey, value.mode || "standalone"]);
  function rememberedType(projectKey) {
    if (!rememberTypes()) return "";
    const key = typeChoiceKey(target(), projectKey), choices = read(TYPE_CHOICES_KEY, {}), previous = read(TARGET_KEY, {});
    return typeof choices[key] === "string" ? choices[key] : typeChoiceKey(previous) === key ? previous.issueTypeId || "" : "";
  }
  function typeScore(type) {
    const words = String(type.name || "").normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const suitable = words.some(word => /^(?:bugs?|defects?|errors?|ошибк[а-я]*|дефект[а-я]*|баг(?:и|а|ов|у|ом|е)?)$/u.test(word));
    return suitable ? words.length === 1 ? 2 : 1 : 0;
  }
  function mappingKey() { const t = target(); return JSON.stringify([...(t.provider === "eva" ? ["eva"] : []), t.baseUrl, state.meta.projectKey, state.meta.issueTypeId]); }
  async function poll(jobId, current = state) {
    const deadline = Date.now() + 180000; let interval = 100;
    while (Date.now() < deadline) {
      const value = await api.reportApi(`/api/agent/jobs/${jobId}`);
      if (state !== current) throw new Error("Окно закрыто");
      if (value.job.status === "completed") return value.job.result;
      if (["failed", "expired"].includes(value.job.status)) {
        const error = new Error(value.job.error || "Connect не завершил действие");
        error.status = value.job.result?.status || 504; error.fieldErrors = value.job.result?.fieldErrors || {}; throw error;
      }
      await new Promise(resolve => setTimeout(resolve, interval)); interval = Math.min(800, interval * 2);
    }
    throw new Error("Действие ещё не завершено. Проверьте состояние Connect.");
  }
  async function job(path, payload) {
    if (path.startsWith("/api/jira/") && (payload.provider || state?.created?.provider || state?.pending?.payload.provider || target().provider) === "eva") path = path.replace("/api/jira/", "/api/eva/");
    const current = state;
    if (api.bugRequest && path.startsWith("/api/jira/")) return api.bugRequest(path, payload);
    const queued = await api.reportApi(path, { method: "POST", body: JSON.stringify(payload) });
    if (state !== current) throw new Error("Окно закрыто");
    return poll(queued.jobId, current);
  }
  function selectOptions(select, list, selected = "", emptyLabel = "Выберите…") {
    select.replaceChildren(new Option(emptyLabel, ""));
    list.forEach(item => select.add(new Option(item.label || item.name, item.value || item.id)));
    select.value = selected;
  }
  function invalidate() {
    if (!state || state.busy || state.pending || state.created) return;
    state.fields = null; state.meta = null; state.generated = null; state.draftReady = false;
    steps(false); $("bugIssueType").replaceChildren(); $("loadBugFields").hidden = true;
    $("bugTargetSection").open = true; $("bugTargetSummary").textContent = "Куда создать баг";
    $("bugEditor").hidden = $("bugTypeRow").hidden = $("bugParentSummary").hidden = true;
    $("bugParentField").hidden = target().mode !== "subtask"; $("bugProjectField").hidden = target().mode === "subtask";
    $("createBugIssue").disabled = true;
    $("createBugIssue").hidden = true;
    message(""); targetControls();
  }
  async function loadProjects() {
    const url = target().baseUrl;
    const result = await job("/api/jira/issue-projects", { baseUrl: url });
    if (target().baseUrl !== url) return;
    $("bugProjectOptions").replaceChildren(...result.projects.map(p => new Option(`${p.key} — ${p.name}`, p.key)));
  }
  function parentConnection(required = false) {
    if (!state || state.busy || state.pending || state.created || target().mode !== "subtask") return true;
    const link = window.QaReportTrackerLinks.parse($("bugParent").value.trim());
    if (!link) return true;
    const selected = (link.provider === "eva" ? "eva:" : "") + link.baseUrl;
    if (![...$("bugJiraConnection").options].some(option => option.value === selected)) {
      if (required) message(api.bugStatus ? "Подключите Jira родительской задачи в настройках приложения." : "Добавьте подключение сервера родительской задачи в QA Report Connect.", true);
      return false;
    }
    if ($("bugJiraConnection").value !== selected) { $("bugJiraConnection").value = selected; invalidate(); loadProjects().catch(() => {}); }
    return true;
  }
  async function loadContext() {
    if (!state || state.busy) return;
    if (!parentConnection(true)) return;
    const current = state; busy(true, "Получаем типы задач…");
    try {
      // The fields endpoint also validates the target and returns its issue types.
      // A remembered type avoids a separate Connect job and duplicate Jira lookup.
      const rememberedId = rememberedType(target().projectKey);
      if (rememberedId) {
        selectOptions($("bugIssueType"), [{ id: rememberedId, name: "Загружаем…" }], rememberedId);
        try {
          busy(true, "Загружаем тип задачи и поля формы…");
          const meta = await job("/api/jira/issue-fields", target());
          await loadFields(meta, true); return;
        } catch (error) { if (error.status !== 422) throw error; }
      }
      const result = await job("/api/jira/issue-context", target());
      if (state !== current) return;
      state.meta = result;
      const types = [...result.types].sort((a, b) => typeScore(b) - typeScore(a));
      const remembered = rememberedType(result.projectKey), unavailable = Boolean(remembered && !types.some(t => t.id === remembered));
      selectOptions($("bugIssueType"), types, unavailable ? "" : remembered);
      const bugs = types.filter(t => typeScore(t) > 0);
      if (!unavailable && !$("bugIssueType").value && (types.length === 1 || bugs.length === 1)) $("bugIssueType").value = (bugs[0] || types[0]).id;
      $("bugTypeRow").hidden = false;
      $("bugParentSummary").hidden = !result.parent;
      $("bugParentSummary").textContent = result.parent ? `${result.parent.key} · ${result.parent.summary} · Проект ${result.projectKey}` : "";
      message(unavailable ? "Сохранённый тип задачи больше недоступен. Выберите другой тип — он будет запомнен для этого проекта." : $("bugIssueType").value ? "Загружаем форму…" : "Выберите тип задачи — поля загрузятся автоматически.");
      if ($("bugIssueType").value) await loadFields(null, true);
    } catch (error) { if (state === current) message(error.message, true); }
    finally { if (state === current) busy(false); }
  }
  function mappingUI() {
    const saved = read(MAPPING_KEY, {})[mappingKey()], allowed = state.fields.filter(f => f.id !== "description" && ["text", "textarea"].includes(f.kind));
    state.mapping = { ...Bugs.suggestMapping(state.fields), ...(saved || {}) };
    for (const key of Object.keys(state.mapping)) if (!allowed.some(f => f.id === state.mapping[key])) state.mapping[key] = "";
    const container = $("bugMappingFields"); container.replaceChildren();
    for (const [key, title] of Object.entries({ preconditions: "Предусловия", steps: "Шаги воспроизведения", expected: "Ожидаемый результат", actual: "Фактический результат" })) {
      const label = document.createElement("label"); label.className = "field";
      const span = document.createElement("span"); span.textContent = title;
      const select = document.createElement("select"); select.dataset.bugMapping = key;
      selectOptions(select, allowed.map(f => ({ value: f.id, label: f.name })), state.mapping[key], "В описание");
      select.addEventListener("change", () => {
        const mapping = Object.fromEntries([...container.querySelectorAll("select")].map(s => [s.dataset.bugMapping, s.value]));
        const ids = Object.values(mapping).filter(Boolean);
        if (new Set(ids).size !== ids.length) { select.value = state.mapping[key]; message("Для каждого раздела выберите отдельное поле.", true); return; }
        state.mapping = mapping;
        arrangeFields(); virtualFields(); evidenceFieldUI();
        const all = read(MAPPING_KEY, {}); all[mappingKey()] = mapping; localStorage.setItem(MAPPING_KEY, JSON.stringify(all));
        if (state.generated) message("Соответствие сохранено. Для заполнения новых полей повторите генерацию.");
      });
      label.append(span, select); container.append(label);
    }
  }
  function catalogField(field) {
    return ["select", "multi"].includes(field.kind) && (["versions", "fixVersions", "components"].includes(field.id)
      || ["version", "component"].includes(field.schema.type) || ["version", "component"].includes(field.schema.items));
  }
  const versionField = field => ["versions", "fixVersions"].includes(field.id) || field.schema.type === "version" || field.schema.items === "version";
  function autocompletePicker(field, control, title) {
    const tags = Bugs.isLabelField(field);
    const local = catalogField(field);
    const catalog = local ? field.allowedValues.map(option => ({ ...option, searchText: `${option.label} ${option.value}`.toLocaleLowerCase() })) : [];
    const current = state, picker = document.createElement("div"); picker.className = "bug-user-picker";
    const chips = document.createElement("div"); chips.className = "bug-user-chips";
    const entry = document.createElement("div"); entry.className = "bug-user-entry";
    const search = document.createElement("input"); search.type = "search"; search.autocomplete = "off";
    search.placeholder = local ? "Поиск по названию" : tags ? /метк|labels?/i.test(field.name) || field.id === "labels" ? "Найти метку или добавить новую" : "Найти значение или добавить новое" : field.hasDefaultValue ? "По умолчанию · поиск по имени" : "Имя или логин";
    const searchPlaceholder = search.placeholder;
    search.setAttribute("role", "combobox"); search.setAttribute("aria-autocomplete", "list"); search.setAttribute("aria-expanded", "false");
    title.id = `bug-user-title-${field.id}`; search.setAttribute("aria-labelledby", title.id);
    search.setAttribute("aria-required", String(field.required && !field.hasDefaultValue));
    const clear = document.createElement("button"); clear.type = "button"; clear.className = "bug-user-clear"; clear.textContent = "×"; clear.setAttribute("aria-label", `Очистить поле «${field.name}»`);
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "bug-user-toggle"; toggle.append(uiIcon("chevron-down")); toggle.setAttribute("aria-label", `Показать варианты поля «${field.name}»`); toggle.setAttribute("aria-expanded", "false");
    const list = document.createElement("div"); list.className = "bug-user-results"; list.id = `bug-user-results-${field.id}`; list.setAttribute("role", "listbox"); list.hidden = true;
    if (control.multiple) list.setAttribute("aria-multiselectable", "true");
    search.setAttribute("aria-controls", list.id); toggle.setAttribute("aria-controls", list.id);
    const hint = document.createElement("small"); hint.className = "bug-user-hint"; hint.id = `bug-user-hint-${field.id}`; hint.setAttribute("role", "status"); search.setAttribute("aria-describedby", hint.id);
    let timer, revision = 0, options = [], active = -1;
    const selected = () => [...control.selectedOptions].filter(o => o.value);
    const newTag = () => { const value = search.value.trim(); return tags && value && value.length <= 255 && !/\s/.test(value) ? { value, label: value, create: true } : null; };
    function suggestions(values) {
      const fresh = newTag();
      return fresh && !values.some(o => o.value === fresh.value) && !selected().some(o => o.value === fresh.value) ? [...values, fresh] : values;
    }
    function dismiss() { list.hidden = true; search.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-expanded", "false"); search.removeAttribute("aria-activedescendant"); active = -1; }
    function changed() { control.dispatchEvent(new Event("change", { bubbles: true })); }
    function selection() {
      chips.replaceChildren();
      if (control.multiple) selected().forEach(option => {
        const chip = document.createElement("span"); chip.textContent = option.text;
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Убрать ${option.text}`);
        remove.addEventListener("click", () => { option.selected = false; changed(); selection(); search.focus(); }); chip.append(remove); chips.append(chip);
      });
      else search.value = selected()[0]?.text || "";
      clear.hidden = !search.value; chips.hidden = !chips.children.length;
      search.placeholder = control.multiple && chips.children.length ? "" : searchPlaceholder;
    }
    function pick(option) {
      if (state !== current || state.pending || state.created) return;
      let stored = [...control.options].find(o => o.value === option.value);
      if (!stored) { stored = new Option(option.label, option.value); control.add(stored); }
      if (control.multiple) stored.selected = tags || !stored.selected; else control.value = option.value;
      clearTimeout(timer); revision++; options = []; search.removeAttribute("aria-busy"); changed(); dismiss(); hint.textContent = ""; search.value = ""; selection(); search.focus();
    }
    function results(values) {
      options = values; list.replaceChildren(); active = -1;
      values.forEach((option, i) => {
        const button = document.createElement("button"); button.type = "button"; button.tabIndex = -1; button.setAttribute("role", "option"); button.id = `${list.id}-${i}`;
        button.setAttribute("aria-selected", String(selected().some(o => o.value === option.value))); button.textContent = option.create ? `Добавить «${option.value}»` : option.label;
        button.addEventListener("pointerdown", event => event.preventDefault()); button.addEventListener("click", () => pick(option)); list.append(button);
      });
      if (!values.length || document.activeElement !== search) { dismiss(); return; }
      const box = entry.getBoundingClientRect(), body = $("bugEditor").closest(".modal-body").getBoundingClientRect();
      const below = body.bottom - box.bottom - 12, above = box.top - body.top - 12;
      list.classList.toggle("above", below < 160 && above > below);
      list.style.maxHeight = `${Math.min(240, Math.max(80, list.classList.contains("above") ? above : below))}px`;
      list.hidden = false; search.setAttribute("aria-expanded", "true"); toggle.setAttribute("aria-expanded", "true");
    }
    function filterCatalog(all = false) {
      const words = all ? [] : search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const chosen = new Set(selected().map(o => o.value));
      const choices = catalog.filter(option => words.every(word => option.searchText.includes(word)) && (!control.multiple || !chosen.has(option.value)));
      hint.textContent = !choices.length ? "Совпадений не найдено" : choices.length > 50 ? "Показаны первые 50. Уточните поиск." : "";
      results(choices.slice(0, 50));
    }
    async function lookup(query, ticket) {
      if (state !== current || !search.isConnected || state.pending || state.created) return;
      hint.textContent = "Ищем…"; search.setAttribute("aria-busy", "true");
      try {
        const value = await job("/api/jira/issue-options", { ...target(), fieldId: field.id, query });
        if (state !== current || revision !== ticket || !search.isConnected) return;
        hint.textContent = value.options.length ? "" : tags ? "Новая метка — Enter" : "Пользователи не найдены"; results(suggestions(value.options));
      } catch (error) { if (state === current && revision === ticket && search.isConnected) { results(suggestions([])); hint.textContent = tags ? "Подсказки недоступны. Новая метка — Enter." : error.message; } }
      finally { if (revision === ticket) search.removeAttribute("aria-busy"); }
    }
    search.addEventListener("input", () => {
      clearTimeout(timer); const ticket = ++revision, query = search.value.trim(); dismiss(); options = []; list.replaceChildren(); search.removeAttribute("aria-busy");
      // Clear the stored choice without syncing its empty label back into the query.
      if (!control.multiple) { control.value = ""; control.dispatchEvent(new Event("input", { bubbles: true })); }
      clear.hidden = !search.value;
      if (local) { filterCatalog(); return; }
      hint.textContent = tags ? /\s/.test(query) ? "Метка должна быть без пробелов" : "Новая метка — Enter" : query.length && query.length < 2 ? "Введите хотя бы 2 символа" : "";
      if (query.length >= (tags ? 1 : 2) && (!tags || !/\s/.test(query))) timer = setTimeout(() => lookup(query, ticket), 350);
    });
    search.addEventListener("focus", () => { if (local) filterCatalog(); else if (options.length) results(options); else if (field.allowedValues.length) results(field.allowedValues); });
    search.addEventListener("click", () => { if (local && list.hidden) filterCatalog(); });
    search.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== search) dismiss(); }, 0));
    search.addEventListener("keydown", event => {
      if (event.key === "Escape" && !list.hidden) { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (tags && event.key === "Enter" && (list.hidden || active < 0)) { event.preventDefault(); if (newTag()) pick(newTag()); return; }
      if (local && list.hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) filterCatalog();
      if (list.hidden || !options.length) return;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); active = event.key === "ArrowDown" ? (active + 1) % options.length : (active < 0 ? options.length - 1 : (active - 1 + options.length) % options.length);
        [...list.children].forEach((button, i) => button.classList.toggle("active", i === active));
        search.setAttribute("aria-activedescendant", list.children[active].id); list.children[active].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") { event.preventDefault(); pick(options[active < 0 ? 0 : active]); }
    });
    clear.addEventListener("pointerdown", event => event.preventDefault());
    clear.addEventListener("click", () => {
      clearTimeout(timer); revision++; if (!control.multiple) { control.value = ""; changed(); }
      search.value = ""; options = []; search.removeAttribute("aria-busy"); clear.hidden = true; hint.textContent = ""; dismiss(); search.focus();
      if (local) filterCatalog();
    });
    toggle.addEventListener("pointerdown", event => event.preventDefault());
    toggle.addEventListener("click", () => {
      const expanded = !list.hidden;
      search.focus();
      if (expanded) { dismiss(); return; }
      if (local) filterCatalog(true);
      else if (field.allowedValues.length) results(field.allowedValues);
      else if (options.length) results(options);
      else if (search.value.trim().length >= (tags ? 1 : 2)) lookup(search.value.trim(), ++revision);
      else hint.textContent = tags ? "Введите метку для поиска или добавления" : "Введите хотя бы 2 символа";
    });
    control.addEventListener("change", selection);
    selection(); entry.append(chips, search, clear, toggle, list); picker.append(entry, hint); return picker;
  }
  function closePrompt() { $("bugPromptDialog").hidden = true; $("editBugPrompt").focus(); }
  function richField(control) {
    const description = control.dataset.bugValue === "description";
    window.QaReportBugRich.attach(control, {
      locked: () => !state || state.busy || Boolean(state.pending || state.created),
      inlineReady: () => Boolean(state?.inlineReady),
      asset: token => state?.assets.find(asset => state.inlineAssets[assetKey(asset)] === token),
      ...(description ? {
        attachments: () => [...new Map([...state.assets, ...state.availableAssets].map(asset => [assetKey(asset), asset])).values()],
        insertAsset: (asset, at) => insertAssets([asset], at),
        clipboardAssets: template => {
          if (!state.inlineReady) return;
          for (const node of template.content.querySelectorAll(".cell-image, .cell-file, img[data-attachment-id]")) {
            if (!node.isConnected && !template.content.contains(node)) continue;
            const assets = window.QaReportJiraReuse.collect({ intro: node.outerHTML });
            if (assets.length) {
              const reference = document.createElement("span"); reference.dataset.attachmentPlaceholder = inlineTokens(assets).join("\n"); reference.textContent = reference.dataset.attachmentPlaceholder; node.replaceWith(reference);
            }
          }
        },
        insertFiles: async (files, at) => { const current = state, assets = await addContextFiles(files); if (state === current) insertAssets(assets || [], at); }
      } : {})
    });
  }
  function virtualFields() {
    const previous = Object.fromEntries([...$("bugRequiredFields").querySelectorAll("[data-bug-section]")].map(el => [el.dataset.bugSection, el.value]));
    $("bugRequiredFields").querySelectorAll("[data-bug-virtual]").forEach(el => el.remove());
    if (!state.fields.some(field => field.id === "description")) return;
    for (const [key, title] of Object.entries({ steps: "Шаги воспроизведения", expected: "Ожидаемый результат", actual: "Фактический результат" })) {
      if (state.mapping[key]) { if (previous[key]) setField(state.mapping[key], previous[key]); continue; }
      const label = document.createElement("div"); label.className = "field bug-jira-field"; label.dataset.bugVirtual = key;
      const name = document.createElement("span"); name.className = "bug-field-title"; name.textContent = title;
      const control = document.createElement("textarea"); control.rows = 3; control.setAttribute("aria-label", title); control.dataset.bugSection = key; control.dataset.sectionTitle = title; control.value = previous[key] || "";
      label.append(name, control); $("bugRequiredFields").append(label); richField(control);
    }
  }
  function fieldControl(field) {
    const person = ["user", "users"].includes(field.kind);
    const picker = person || Bugs.isLabelField(field) || catalogField(field);
    const label = document.createElement(picker || field.kind === "textarea" || Object.values(state.mapping).includes(field.id) && field.kind === "text" ? "div" : "label"); label.className = "field bug-jira-field"; label.dataset.bugField = field.id;
    const title = document.createElement("span"); title.className = "bug-field-title"; title.textContent = field.name;
    if (field.required) { const badge = document.createElement("small"); badge.className = "bug-required-badge"; badge.textContent = "*"; title.append(badge); }
    label.append(title);
    let control;
    if (field.kind === "unsupported") {
      const hint = document.createElement("p"); hint.className = "settings-note";
      hint.textContent = field.required && !field.hasDefaultValue ? "Это обязательное поле пока нельзя заполнить здесь. Создайте задачу в выбранной системе и перенесите подготовленный текст." : "Это поле можно заполнить после создания задачи.";
      label.append(hint); return label;
    }
    if (["select", "multi", "user", "users", "cascade"].includes(field.kind) || picker) {
      control = document.createElement("select"); selectOptions(control, field.allowedValues, "", field.hasDefaultValue ? "По умолчанию" : "Выберите…");
      control.multiple = ["multi", "users", "tags"].includes(field.kind);
      if (control.multiple) { control.options[0].remove(); control.size = Math.min(5, Math.max(2, field.allowedValues.length)); }
      if (picker) {
        control.hidden = true;
        const defaults = Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue];
        defaults.filter(v => v && (typeof v === "object" || Bugs.isLabelField(field) && typeof v === "string")).forEach(v => {
          const value = String(typeof v === "string" ? v : v.accountId || v.name || v.id || "");
          if (value && ![...control.options].some(o => o.value === value)) control.add(new Option(v.displayName || v.name || value, value));
        });
      }
      if (field.kind === "cascade") {
        const child = document.createElement("select"); child.dataset.cascadeChild = field.id;
        selectOptions(child, []);
        control.addEventListener("change", () => selectOptions(child, field.allowedValues.find(v => v.value === control.value)?.children || []));
        label.append(control, child);
      }
    } else if (field.kind === "textarea" || field.id !== "summary" && Object.values(state.mapping).includes(field.id) && field.kind === "text") { control = document.createElement("textarea"); control.rows = field.id === "description" ? 10 : 4; }
    else { control = document.createElement("input"); control.type = field.kind === "number" ? "number" : field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : "text"; if (field.kind === "number") control.step = "any"; }
    control.setAttribute("aria-label", field.name);
    control.dataset.bugValue = field.id;
    control.setAttribute("aria-required", String(field.required && !field.hasDefaultValue));
    if (field.id === "summary") control.maxLength = 255;
    if (field.kind === "tags") control.placeholder = "Значения через запятую";
    if (field.defaultValue !== undefined) {
      const value = field.defaultValue;
      if (control.multiple && Array.isArray(value)) [...control.options].forEach(o => { o.selected = value.some(v => String(v.id || v.accountId || v.name || v) === o.value); });
      else if (typeof value === "string" || typeof value === "number") control.value = value;
      else if (value && typeof value === "object") control.value = value.id || value.accountId || value.name || "";
    }
    const edited = () => { control.dataset.bugTouched = "true"; label.classList.remove("bug-field-error"); label.querySelector(".bug-error-text")?.remove(); label.querySelectorAll("[aria-invalid]").forEach(el => el.removeAttribute("aria-invalid")); };
    control.addEventListener("input", edited); control.addEventListener("change", edited);
    if (field.kind !== "cascade") label.append(control);
    if (picker) label.append(autocompletePicker(field, control, title));
    if (control.tagName === "TEXTAREA" && field.id !== "environment") richField(control);
    return label;
  }
  function setField(id, value) { const control = $("bugEditor").querySelector(`[data-bug-value="${id}"]`); if (control) { control.value = value; window.QaReportBugRich.get(control)?.render(); } }
  function seed() {
    if (state.standalone) return;
    const source = state.source, find = (id, pattern) => (source.cells.find(c => c.id === id) || source.cells.find(c => pattern.test(c.name)))?.text || "";
    const check = find("check", /проверка|check|пункт/i);
    setField("summary", check.slice(0, 255));
    const value = { summary: check, preconditions: "", steps: [], expected: find("expected", /ожидаем|expected/i), actual: find("actual", /фактическ|actual/i) };
    try {
      const content = Bugs.contentValues(value, state.mapping, state.fields);
      if ($("bugEditor").querySelector("[data-bug-section]")) content.description = "";
      for (const [id, text] of Object.entries(content)) setField(id, text);
      $("bugEditor").querySelectorAll("[data-bug-section]").forEach(control => { control.value = typeof value[control.dataset.bugSection] === "string" ? value[control.dataset.bugSection] : ""; });
    } catch (error) { message(error.message, true); }
  }
  async function loadFields(metadata = null, continuing = false) {
    if (!state || state.busy && !continuing || !target().issueTypeId) return;
    const current = state; state.fields = null; $("bugEditor").hidden = true; $("loadBugFields").hidden = true; busy(true, "Получаем поля формы…");
    try {
      const meta = metadata || await job("/api/jira/issue-fields", target());
      if (state !== current) return;
      selectOptions($("bugIssueType"), [...meta.types].sort((a, b) => typeScore(b) - typeScore(a)), meta.issueTypeId);
      $("bugParentSummary").hidden = !meta.parent;
      $("bugParentSummary").textContent = meta.parent ? `${meta.parent.key} · ${meta.parent.summary} · Проект ${meta.projectKey}` : "";
      state.meta = meta; state.loadedTarget = JSON.stringify(target()); state.fields = meta.fields.map(field => ({ ...field, name: String(field.name || field.id), allowedValues: (Array.isArray(field.allowedValues) ? field.allowedValues : []).map(option => ({ ...option,
        value: String(option.value ?? option.id ?? option.name ?? option), label: String(option.label ?? option.name ?? option.value ?? option.id ?? option) })) })); mappingUI();
      for (const id of ["bugRequiredFields", "bugOptionalFields", "bugPeopleFields", "bugCommonFields", "bugVersionFields"]) $(id).replaceChildren();
      for (const field of state.fields) (field.required || ["summary", "description", ...Object.values(state.mapping)].includes(field.id) ? $("bugRequiredFields") : $("bugOptionalFields")).append(fieldControl(field));
      arrangeFields();
      $("bugOptionalSection").open = false;
      $("bugEditor").hidden = true; virtualFields(); seed(); attachmentsUI();
      $("bugTargetSummary").textContent = `${meta.parent ? `Под ${meta.parent.key}` : `Проект ${meta.projectKey}`} · ${meta.types.find(t => t.id === meta.issueTypeId)?.name || ""}`;
      $("bugTargetSection").open = true;
      steps(1); $("bugFooterHint").textContent = "Проверьте черновик и обязательные поля.";
      const selectedTarget = { ...target(), projectKey: meta.projectKey };
      if (rememberTypes()) {
        const choices = read(TYPE_CHOICES_KEY, {}), previous = read(TARGET_KEY, {}), previousKey = typeChoiceKey(previous);
        if (previous.baseUrl && previous.projectKey && typeof previous.issueTypeId === "string" && previous.issueTypeId && !choices[previousKey]) choices[previousKey] = previous.issueTypeId;
        choices[typeChoiceKey(target(), meta.projectKey)] = meta.issueTypeId;
        localStorage.setItem(TYPE_CHOICES_KEY, JSON.stringify(choices));
      } else delete selectedTarget.issueTypeId;
      localStorage.setItem(TARGET_KEY, JSON.stringify(selectedTarget));
      $("bugTypeRow").hidden = false; message("");
    } catch (error) { if (state === current) { $("loadBugFields").hidden = false; message(error.message, true); } }
    finally { if (state === current) busy(false); }
  }
  function arrangeFields() {
    const common = field => ["versions", "fixVersions", "components", "labels", "priority", "environment"].includes(field.id)
      || ["version", "component", "priority"].includes(field.schema.type) || ["version", "component"].includes(field.schema.items)
      || Bugs.isLabelField(field) && /метк|labels?/i.test(field.name);
    for (const field of state.fields) {
      const label = $("bugEditor").querySelector(`[data-bug-field="${field.id}"]`);
      if (!label) continue;
      const content = ["summary", "description", ...Object.values(state.mapping)].includes(field.id);
      label.dataset.bugTextSection = Object.keys(state.mapping).find(key => state.mapping[key] === field.id) || "";
      label.dataset.bugGroup = field.required ? "required" : content || common(field) || ["user", "users"].includes(field.kind) ? "common" : "optional";
      (["user", "users"].includes(field.kind) ? $("bugPeopleFields") : versionField(field) ? $("bugVersionFields") : content ? $("bugRequiredFields") : common(field) || field.required ? $("bugCommonFields") : $("bugOptionalFields")).append(label);
    }
    $("bugCommonSection").hidden = !$("bugCommonFields").children.length;
    $("bugVersionsSection").hidden = !$("bugVersionFields").children.length;
    const order = { summary: 0, description: 1, [state.mapping.preconditions]: 2, [state.mapping.steps]: 3, [state.mapping.expected]: 4, [state.mapping.actual]: 5 };
    const sort = (container, rank) => [...container.children].sort((a, b) => rank(a.dataset.bugField) - rank(b.dataset.bugField)).forEach(el => container.append(el));
    sort($("bugRequiredFields"), id => order[id] ?? 6);
    sort($("bugCommonFields"), id => ({ priority: 0, components: 1, labels: 2, environment: 3 })[id] ?? 4);
    sort($("bugVersionFields"), id => ({ versions: 0, fixVersions: 1 })[id] ?? 2);
    const rank = field => field.id === "assignee" || /исполнитель|assignee/i.test(field.name) ? 0 : /специалист|specialist/i.test(field.name) ? 1 : field.id === "reporter" ? 3 : 2;
    state.fields.filter(f => ["user", "users"].includes(f.kind)).sort((a, b) => rank(a) - rank(b)).forEach(f => $("bugPeopleFields").append($("bugPeopleFields").querySelector(`[data-bug-field="${f.id}"]`)));
    $("bugPeopleSection").hidden = !$("bugPeopleFields").children.length;
    const optionalCount = $("bugOptionalFields").children.length;
    $("bugOptionalSummary").textContent = `Дополнительные поля (${optionalCount})`;
    $("bugOptionalSection").hidden = !optionalCount;
  }
  function attachmentsUI() {
    const saved = new Map([...$("bugAttachmentList").querySelectorAll("input")].map(el => [el.dataset.assetKey, el.checked]));
    const list = $("bugAttachmentList"); list.replaceChildren();
    state.assets.forEach((asset, i) => {
      const line = document.createElement("div"), label = document.createElement("label"); line.className = "bug-draft-attachment"; label.className = "bug-attachment-option";
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = saved.get(assetKey(asset)) ?? true; input.dataset.assetKey = assetKey(asset); input.dataset.bugAttachment = i;
      const span = document.createElement("span"); span.textContent = asset.name; span.title = asset.name;
      input.addEventListener("change", () => { if (!input.checked) removeInlineAsset(asset); });
      label.append(input, span); line.append(label);
      const insert = document.createElement("button"); insert.type = "button"; insert.className = "button button-ghost bug-insert-attachment";
      insert.textContent = "В описание"; insert.setAttribute("aria-label", `Вставить ${asset.name} в описание`);
      insert.disabled = !state.inlineReady || !descriptionControl(); insert.addEventListener("click", () => insertAssets([asset])); line.append(insert);
      line.draggable = Boolean(state.inlineReady && descriptionControl());
      line.addEventListener("dragstart", event => { if (state.busy || state.pending || state.created) { event.preventDefault(); return; } event.dataTransfer.setData(ATTACHMENT_DRAG, assetKey(asset)); event.dataTransfer.effectAllowed = "copy"; });
      list.append(line);
    });
    $("bugAttachmentSection").hidden = !state.assets.length;
    $("bugAttachmentSummary").textContent = `Вложения (${state.assets.length})`;
    evidenceFieldUI();
  }
  function evidenceFieldUI() {
    const field = state.fields.find(f => f.id === "description" && f.kind === "textarea") || state.fields.find(f => f.id === state.mapping.actual && f.kind === "textarea") || state.fields.find(f => Object.values(state.mapping).includes(f.id) && f.kind === "textarea");
    state.evidenceField = field?.id || "";
    $("bugAttachmentHint").textContent = descriptionControl() && state.inlineReady ? "Перетащите файл в нужное место описания или нажмите «В описание». Остальные файлы появятся в конце описания." : field ? `Файлы загрузятся автоматически. Ссылки появятся в поле «${field.name}».` : "Файлы загрузятся автоматически после создания бага.";
    if (descriptionControl() && !state.inlineReady) $("bugAttachmentHint").textContent += " Для вставки в нужное место обновите Connect.";
    descriptionControl()?.classList.add("bug-description-drop");
  }
  function reviewInformation(items) {
    const box = $("bugMissingInformation"); box.replaceChildren(); box.hidden = !items.length;
    if (!items.length) return;
    const title = document.createElement("h3"); title.id = "bugMissingTitle"; title.textContent = "Что стоит уточнить";
    const hint = document.createElement("p"); hint.textContent = `ИИ отметил недостающие сведения. Проверьте их и при необходимости дополните поля бага. Этот список не добавляется в задачу.`;
    const list = values => {
      const ul = document.createElement("ul");
      values.forEach(value => { const li = document.createElement("li"); li.textContent = value; ul.append(li); }); return ul;
    };
    box.append(title, hint, list(items.slice(0, 4)));
    if (items.length > 4) {
      const more = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = `Показать остальные (${items.length - 4})`;
      more.append(summary, list(items.slice(4))); box.append(more);
    }
  }
  function analysisOptions(reset = true) {
    const saved = new Map([...$("bugAiAttachmentList").querySelectorAll("input")].map(el => [el.dataset.assetKey, el.checked]));
    const list = $("bugAiAttachmentList"); list.replaceChildren();
    state.assets.forEach((asset, index) => {
      const label = document.createElement("label"), check = document.createElement("input"), span = document.createElement("span");
      check.type = "checkbox"; check.dataset.bugAiAttachment = index; check.dataset.assetKey = assetKey(asset);
      check.disabled = !window.QaReportAttachmentAnalysis.format(asset); check.checked = !check.disabled && (reset ? true : saved.get(assetKey(asset)) ?? true);
      span.textContent = `${asset.name}${check.disabled ? " — формат пока не поддерживается" : ""}`;
      label.append(check, span); list.append(label);
    });
    if (reset || !state.assets.some(asset => window.QaReportAttachmentAnalysis.format(asset))) $("bugAiAttachments").checked = state.assets.some(asset => window.QaReportAttachmentAnalysis.format(asset));
    $("bugAiAttachmentsOption").hidden = !state.assets.length;
    $("bugAiAttachmentSelection").hidden = !$("bugAiAttachments").checked;
    if (reset) $("bugAiAttachmentSelection").open = false;
    $("bugAiAttachmentCount").textContent = `Выбрать вложения (${state.assets.length})`;
    $("bugAnalysisReceipt").hidden = true;
    $("bugRuleReceipt").hidden = true;
  }
  function controlState(control) {
    return JSON.stringify({ value: control.multiple ? [...control.selectedOptions].map(option => option.value) : control.value, search: control.closest(".bug-jira-field")?.querySelector('[role="combobox"]')?.value || "" });
  }
  function voiceActive() { return state && ["starting", "recording", "stopping", "transcribing", "processing"].includes(state.voicePhase); }
  function contextControls() {
    if (!state) return;
    $("bugVoicePrivacy").textContent = state.speech.mode === "browser" ? "Диктовка браузера: его сервис может отправлять голос для распознавания. Локальный Whisper можно выбрать в Connect → ИИ → Распознавание речи." : state.speech.mode === "local" ? state.speech.available ? "Локальная диктовка: голос распознаётся на компьютере через Connect и не отправляется ИИ-провайдеру." : state.speech.reason : "После остановки запись отправится выбранному серверу распознавания. Используются его лимиты.";
    const locked = state.busy || Boolean(state.created || state.pending) || state.filesLoading;
    const active = voiceActive(), recording = state.voicePhase === "recording";
    $("bugVoice").disabled = locked || active;
    $("bugVoicePanel").hidden = !active; $("bugVoicePanel").dataset.phase = state.voicePhase;
    $("bugContextText").parentElement.dataset.voiceActive = String(Boolean(active));
    $("bugVoiceStop").disabled = !recording;
    $("bugVoiceHint").hidden = Boolean(active);
    $("bugVoiceStatus").textContent = recording ? "Запись" : state.voicePhase === "starting" ? "Подключаем микрофон…" : state.voicePhase === "processing" ? "Приводим текст в порядок…" : "Распознаём запись…";
    $("bugVoice").setAttribute("aria-pressed", String(state.voicePhase === "recording"));
    $("bugVoice").setAttribute("aria-label", state.voicePhase === "recording" ? "Завершить диктовку" : "Надиктовать контекст");
    $("bugAddContextFiles").disabled = locked || voiceActive();
    $("bugContextText").disabled = Boolean(state.created || state.pending);
    $("bugExtraFiles").querySelectorAll("button").forEach(button => { button.disabled = locked || voiceActive(); });
    $("bugAttachmentList").querySelectorAll(".bug-insert-attachment").forEach(button => { button.disabled = locked || !state.inlineReady || !descriptionControl(); });
    if (voiceActive() || state.filesLoading) { $("generateBugDraft").disabled = true; $("createBugIssue").disabled = true; }
    else { $("generateBugDraft").disabled = locked || !state.profiles.length || needsContext(); $("createBugIssue").disabled = state.busy || (!state.fields && !state.pending && !state.created); }
    targetControls();
  }
  function voiceMeter({ levels, elapsed }) {
    if (!state || state.voicePhase !== "recording") return;
    $("bugVoiceWave").querySelectorAll("rect").forEach((bar, i) => { const height = 2 + levels[i] * 28; bar.setAttribute("height", height); bar.setAttribute("y", (32 - height) / 2); });
    const seconds = Math.min(180, Math.floor(elapsed)); $("bugVoiceTime").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 3:00`;
  }
  function resetVoiceMeter() {
    $("bugVoiceWave").replaceChildren(...Array.from({ length: 64 }, (_, i) => { const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      for (const [key, value] of Object.entries({ x: i * 8 + 2, y: 15, width: 4, height: 2, rx: 2, fill: "currentColor" })) bar.setAttribute(key, value); return bar; }));
    $("bugVoiceTime").textContent = "0:00 / 3:00";
  }
  function cancelDictation() {
    if (!voiceActive()) return;
    const processing = state.voicePhase === "transcribing" || state.voicePhase === "stopping" || state.voicePhase === "processing";
    state.voiceAttempt++; state.voice.cancel(); state.voicePhase = "idle";
    $("bugVoiceHint").textContent = processing ? "Распознавание отменено. Текст не изменён." : "Запись отменена. Текст не изменён.";
    $("bugVoiceHint").dataset.state = "idle"; contextControls(); $("bugVoice").focus();
  }
  async function dictate() {
    if (!state || state.busy || voiceActive()) return;
    const current = state, attempt = ++state.voiceAttempt;
    state.voicePhase = "starting"; resetVoiceMeter(); contextControls(); $("bugVoiceCancel").focus();
    try {
      // Reuse the snapshot fetched when opening the form; preserve the pinned speech selection.
      if (!state.speechReady) await state.speechRequest;
      if (state !== current || current.voiceAttempt !== attempt) return;
      if (!state.speechReady) throw new Error("Не удалось получить настройки диктовки. Откройте форму снова и проверьте Connect.");
      await state.voice.start(state.speech);
    } catch (error) { if (state === current && current.voiceAttempt === attempt) { state.voicePhase = "error"; $("bugVoiceHint").textContent = error.message; $("bugVoiceHint").dataset.state = "error"; contextControls(); $("bugVoice").focus(); } }
  }
  function extraFilesUI() {
    $("bugExtraFiles").replaceChildren(...state.extraAssets.map(asset => {
      const line = document.createElement("div"), title = document.createElement("span"), remove = document.createElement("button");
      line.className = "bug-extra-file"; title.textContent = asset.name;
      remove.type = "button"; remove.className = "icon-button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Убрать вложение ${asset.name}`);
      remove.addEventListener("click", () => { removeInlineAsset(asset); state.assets = state.assets.filter(a => a !== asset); state.extraAssets = state.extraAssets.filter(a => a !== asset); refreshAssets(); });
      line.append(title, remove); return line;
    })); contextControls();
  }
  function refreshAssets() {
    state.source.attachments = state.assets.map(a => ({ name: a.name, type: a.type }));
    analysisOptions(false); attachmentsUI(); extraFilesUI();
  }
  async function addContextFiles(files = [...$("bugContextFiles").files]) {
    if (!state || state.busy || state.created || state.pending || state.filesLoading) return [];
    if (!files.length) return [];
    const current = state; $("bugContextFiles").value = ""; $("bugVoiceInfo").open = false;
    state.filesLoading = true; contextControls();
    try {
      if (state.extraAssets.length + files.length > 20) throw new Error("К контексту можно добавить до 20 файлов.");
      const size = state.extraAssets.reduce((sum, a) => sum + window.QaReportAttachmentLimits.base64Bytes(a.dataUrl), 0) + files.reduce((sum, f) => sum + f.size, 0);
      if (size > 75 * 1024 * 1024) throw new Error("Дополнительные вложения занимают больше 75 МБ. Добавьте часть файлов напрямую в задачу.");
      const assets = [];
      for (const file of files) {
        const problem = window.QaReportAttachmentLimits.fileError(file); if (problem) throw new Error(problem);
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(`Не удалось прочитать ${file.name}`)); reader.readAsDataURL(file); });
        if (state !== current) return;
        assets.push({ attachmentId: crypto.randomUUID(), name: file.name, type: file.type || "application/octet-stream", dataUrl, source: { issueUrl: "", id: "", name: file.name, hash: "", kind: file.type.startsWith("image/") ? "image" : "file" } });
      }
      state.extraAssets.push(...assets); state.assets.push(...assets); if (assets.some(asset => window.QaReportAttachmentAnalysis.format(asset))) $("bugAiAttachments").checked = true; refreshAssets(); return assets;
    } catch (error) { if (state === current) message(error.message, true); }
    finally { if (state === current) { state.filesLoading = false; contextControls(); } }
  }
  function pasteContextFiles(event) {
    const clipboard = event.clipboardData;
    let files = [...(clipboard?.files || [])];
    if (!files.length) files = [...(clipboard?.items || [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    addContextFiles(files);
  }
  async function descriptionFiles(event) {
    const transfer = event.dataTransfer || event.clipboardData, types = [...(transfer?.types || [])], key = transfer?.getData(ATTACHMENT_DRAG);
    let files = [...(transfer?.files || [])];
    if (!files.length) files = [...(transfer?.items || [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
    if (!files.length && !types.includes(ATTACHMENT_DRAG)) return;
    event.preventDefault(); event.stopPropagation();
    const control = descriptionControl();
    const rich = control && window.QaReportBugRich.get(control), visual = control?.hidden ? rich?.visual : null;
    if (!(event.target === control || visual?.contains(event.target)) || !state.inlineReady || state.busy || state.pending || state.created) return;
    (visual || control).classList.remove("bug-file-drop");
    const offset = visual ? event.type === "drop" ? rich.dropRange(event) : rich.captureRange() : event.type === "drop" ? dropOffset(control, event) : control.selectionStart, current = state;
    const assets = key ? state.assets.filter(asset => assetKey(asset) === key) : await addContextFiles(files);
    if (state === current) insertAssets(assets || [], offset);
  }
  function generationFields(systemPrompt) {
    const content = new Set(["summary", "description", ...Object.values(state.mapping)]);
    const tokens = [...new Set(systemPrompt.toLocaleLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(word => word.length > 1))];
    let budget = 80000;
    return Bugs.aiFields(state.fields.filter(field => !content.has(field.id) && !["unsupported", "context", "cascade"].includes(field.kind)).slice(0, 40).map(field => {
      const score = option => tokens.reduce((sum, token) => sum + (option.label.toLocaleLowerCase().includes(token) || option.value.toLocaleLowerCase() === token ? 1 : 0), 0);
      const options = field.allowedValues.map(option => ({ value: option.value, label: option.label.slice(0, 200), score: score(option) })).sort((a, b) => b.score - a.score).slice(0, 300).map(({ value, label }) => ({ value, label }));
      const allowedValues = options.filter(option => { const size = JSON.stringify(option).length; if (size > budget) return false; budget -= size; return true; });
      return { id: field.id, name: field.name.slice(0, 200), kind: field.kind, required: field.required, allowedValues };
    }));
  }
  async function applyRuleFields(suggestions, before, current) {
    const applied = [], missing = [];
    for (const suggestion of suggestions || []) {
      if (state !== current) throw new Error("Окно закрыто");
      const field = state.fields.find(item => item.id === suggestion.fieldId), control = field && $("bugEditor").querySelector(`[data-bug-value="${field.id}"]`);
      if (!control || controlState(control) !== before[field.id] || control.dataset.bugTouched && control.dataset.bugAiState !== before[field.id]) continue;
      let choices = [];
      if (["select", "multi", "user", "users", "tags"].includes(field.kind)) {
        for (const value of suggestion.values) {
          let options = [...control.options].filter(option => option.value && (option.value === value || option.text.toLocaleLowerCase() === value.toLocaleLowerCase())).map(option => ({ value: option.value, label: option.text }));
          if (field.kind === "tags") options = [{ value, label: value }];
          else if (["user", "users"].includes(field.kind) && options.length !== 1) {
            try { const result = await job("/api/jira/issue-options", { ...target(), fieldId: field.id, query: value }); options = result.options.filter(option => option.value === value || option.label.toLocaleLowerCase() === value.toLocaleLowerCase()); }
            catch { options = []; }
          }
          if (options.length !== 1) { choices = []; break; }
          choices.push(options[0]);
        }
        if (!choices.length) { missing.push(`Выберите «${field.name}»: значение из правила не удалось однозначно сопоставить с доступными значениями.`); continue; }
      }
      if (state !== current || controlState(control) !== before[field.id]) continue;
      if (control.tagName === "SELECT") {
        choices.forEach(choice => { if (![...control.options].some(option => option.value === choice.value)) control.add(new Option(choice.label, choice.value)); });
        if (control.multiple) [...control.options].forEach(option => { option.selected = choices.some(choice => choice.value === option.value); });
        else control.value = choices[0].value;
      } else control.value = suggestion.values[0];
      if (!control.value) { missing.push(`Проверьте «${field.name}»: предложенное значение не удалось применить к полю.`); continue; }
      control.dispatchEvent(new Event("change", { bubbles: true })); control.dataset.bugTouched = "true"; control.dataset.bugAiState = controlState(control);
      applied.push(`${field.name}: ${choices.length ? choices.map(choice => choice.label).join(", ") : control.value}`);
    }
    return { applied, missing };
  }
  async function generate() {
    if (!state || state.busy || voiceActive() || state.filesLoading || !state.fields) return;
    if (needsContext()) { $("bugExtraContext").open = true; $("bugContextText").focus(); message("Опишите проблему текстом или голосом, чтобы ИИ подготовил баг-репорт.", true); return; }
    const current = state; busy(true, "ИИ готовит заголовок, шаги и результаты…", "generating");
    // Preserve edits made while the model is responding.
    const before = Object.fromEntries([...$("bugEditor").querySelectorAll("[data-bug-value]")].map(el => [el.dataset.bugValue, controlState(el)]));
    const inlineBefore = Object.values(current.inlineAssets).flatMap(token => Array.from({ length: (descriptionControl()?.value || "").split(token).length - 1 }, () => token));
    const virtualBefore = Object.fromEntries([...$("bugEditor").querySelectorAll("[data-bug-section]")].map(el => [el.dataset.bugSection, el.value]));
    try {
      const systemPrompt = prompt(), additionalContext = $("bugContextText").value.trim(), jiraFields = generationFields(systemPrompt + "\n" + additionalContext);
      let analysis = { images: [], textAttachments: [], summary: [] };
      if ($("bugAiAttachments").checked) {
        const assets = [...$("bugAiAttachmentList").querySelectorAll("input:checked")].map(el => current.assets[Number(el.dataset.bugAiAttachment)]);
        if (!assets.length) throw new Error("Выберите вложения для анализа или выключите «Анализировать вложения».");
        analysis = await window.QaReportAttachmentAnalysis.prepare(assets, { active: () => state === current, progress: text => { if (state === current) message(text); },
          loadSource: async source => {
            if (!source.issueUrl || !source.id) throw new Error("Импортируйте вложение из исходной системы заново.");
            const origin = window.QaReportTrackerLinks.parse(source.issueUrl);
            if (!origin) throw new Error("Не удалось определить подключение исходного вложения.");
            const settings = { ...api.jiraSettings(), baseUrl: origin.baseUrl, provider: origin.provider, ...(origin.provider === "eva" ? { transport: "agent" } : {}) };
            const result = await api.jiraRequest("/api/jira/import-attachment", { ...settings, commentUrl: source.issueUrl, attachmentId: source.id });
            return `data:${result.file.type};base64,${result.file.dataBase64}`;
          } });
        if (state !== current) return;
        message("ИИ анализирует текст и вложения, готовит баг-репорт…");
      }
      const result = await job("/api/ai/bug-draft", { profileId: $("bugAiProfile").value, prompt: systemPrompt, additionalContext, context: state.source, jiraFields,
        ...(analysis.images.length ? { images: analysis.images } : {}), ...(analysis.textAttachments.length ? { textAttachments: analysis.textAttachments } : {}) });
      $("bugAnalysisReceipt").hidden = !analysis.summary.length;
      $("bugAnalysisSummary").textContent = `Учтённые вложения (${analysis.summary.length})`;
      $("bugAnalysisFiles").replaceChildren(...analysis.summary.map(file => { const li = document.createElement("li"); li.textContent = `${file.name}: ${file.notes}`; return li; }));
      const values = Bugs.contentValues(result.draft, state.mapping, state.fields);
      if ($("bugEditor").querySelector("[data-bug-section]")) values.description = !state.mapping.preconditions && result.draft.preconditions ? `Предусловия\n${result.draft.preconditions}` : ""; let preserved = false;
      for (const [id, value] of Object.entries(values)) {
        const control = $("bugEditor").querySelector(`[data-bug-value="${id}"]`);
        if (control && controlState(control) === before[id]) control.value = id === "description" ? [value, ...inlineBefore.filter(token => !value.includes(token))].filter(Boolean).join("\n") : value; else if (control) preserved = true;
      }
      for (const control of $("bugEditor").querySelectorAll("[data-bug-section]")) {
        if (control.value === virtualBefore[control.dataset.bugSection]) control.value = control.dataset.bugSection === "steps" ? result.draft.steps.map((text, i) => `${i + 1}. ${text}`).join("\n") : result.draft[control.dataset.bugSection] || "";
        else preserved = true;
      }
      state.generated = result.draft; state.draftReady = true;
      const rules = await applyRuleFields(result.draft.fieldValues, before, current);
      if (state !== current) return;
      $("bugRuleReceipt").hidden = !rules.applied.length;
      $("bugRuleSummary").textContent = `Предзаполнено по вашему промпту (${rules.applied.length})`;
      $("bugRuleFields").replaceChildren(...rules.applied.map(text => { const li = document.createElement("li"); li.textContent = text; return li; }));
      reviewInformation([...result.draft.missingInformation, ...rules.missing]);
      steps(3);
      message(preserved ? "Черновик готов. Правки, сделанные во время генерации, сохранены." : "");
    } catch (error) { if (state === current) message(error.message, true); }
    finally { if (state === current) busy(false); }
  }
  function values() {
    const result = {};
    const content = new Set(["summary", "description", ...Object.values(state.mapping)]);
    for (const field of state.fields) {
      const control = $("bugEditor").querySelector(`[data-bug-value="${field.id}"]`);
      if (!control) continue;
      if (!field.required && !content.has(field.id) && !control.dataset.bugTouched) continue;
      const value = control.multiple ? [...control.selectedOptions].map(o => o.value) : field.kind === "cascade" ? (control.value ? { id: control.value, child: $("bugEditor").querySelector(`[data-cascade-child="${field.id}"]`).value } : "") : control.value.trim();
      if (!Bugs.empty(value)) result[field.id] = value;
    }
    const sections = [...$("bugEditor").querySelectorAll("[data-bug-section]")].filter(el => el.value.trim()).map(el => `${el.dataset.sectionTitle}\n${el.value.trim()}`);
    if (sections.length) result.description = [result.description, ...sections].filter(Boolean).join("\n\n");
    const errors = state.fields.filter(f => f.required && !f.hasDefaultValue && Bugs.empty(result[f.id]));
    if (errors.length) { errors.forEach(f => markError(f.id, `Заполните «${f.name}»`)); const label = $("bugEditor").querySelector(`[data-bug-field="${errors[0].id}"]`); (label?.querySelector('[role="combobox"]') || label?.querySelector(".bug-rich-visual:not([hidden])") || label?.querySelector("[data-bug-value]"))?.focus(); throw new Error("Заполните все обязательные поля."); }
    return result;
  }
  function markError(id, text) {
    const label = $("bugEditor").querySelector(`[data-bug-field="${id}"]`); if (!label) return;
    label.classList.add("bug-field-error");
    label.querySelector("[data-bug-value]")?.setAttribute("aria-invalid", "true");
    label.querySelector('[role="combobox"]')?.setAttribute("aria-invalid", "true");
    let hint = label.querySelector(".bug-error-text"); if (!hint) { hint = document.createElement("small"); hint.className = "bug-error-text"; label.append(hint); }
    hint.textContent = text;
    label.closest("details")?.setAttribute("open", "");
  }
  function link(result) {
    state.createdSummary = state.pending?.payload.fields.summary || "";
    const expected = new URL(state.pending?.payload.baseUrl || target().baseUrl), url = new URL(result.issueUrl);
    const identity = window.QaReportTrackerLinks.parse(result.issueUrl, state.pending?.payload.provider || target().provider);
    if (!identity || identity.baseUrl !== expected.href.replace(/\/$/, "") || identity.key !== result.key) throw new Error("Connect вернул некорректную ссылку задачи");
    state.created = { provider: identity.provider, baseUrl: identity.baseUrl, key: result.key, issueUrl: result.issueUrl, createdAt: new Date().toISOString(), operationId: result.operationId, summary: state.createdSummary, uploads: [], extraAssets: state.pending?.extraAssets || [], inlineAttachments: state.pending?.inlineAttachments || [], attachmentRefs: {}, evidenceField: state.evidenceField || "", attachmentKeys: state.selectedAssets.map(assetKey), attachmentsPending: state.selectedAssets.length > 0, evidencePending: Boolean(state.selectedAssets.length && state.evidenceField) };
    const currentRow = row();
    if (!state.standalone) {
      if (!currentRow) throw new Error(`Задача ${result.key} создана, но исходный пункт удалён. Ссылка: ${identity.issueUrl}`);
      currentRow.bugs ||= []; const previous = currentRow.bugs.find(b => b.operationId === result.operationId);
      if (previous) state.created = previous; else currentRow.bugs.push(state.created);
      addBugComment(currentRow, result);
      delete currentRow.pendingBug;
    }
    showCreated();
    $("bugEditor").querySelectorAll("input, textarea, select, button").forEach(el => { el.disabled = true; });
  }
  function addBugComment(currentRow, result) {
    let url;
    try { url = new URL(result.issueUrl); } catch { return false; }
    const identity = window.QaReportTrackerLinks.parse(result.issueUrl, result.provider || "");
    if (!identity || identity.key !== result.key) return false;
    const section = api.getDraft().sections.find(s => s.id === state.sectionId);
    let column = section.columns.find(c => c.id === "comment" || /^(?:комментарий|комментарии|comments?)$/i.test(String(c.title || "").trim()));
    if (!column) {
      column = { id: "comment", title: "Комментарий" }; section.columns.push(column);
      section.rows.forEach(r => { r.cells[column.id] ||= ""; });
    }
    const content = document.createElement("div"); content.innerHTML = currentRow.cells[column.id] || "";
    if ([...content.querySelectorAll("a[href]")].some(a => window.QaReportTrackerLinks.identity(a.href) === identity.issueUrl) || content.textContent.includes(url.href)) return false;
    const paragraph = document.createElement("p"), anchor = document.createElement("a");
    anchor.href = identity.issueUrl; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.textContent = result.key;
    paragraph.append("Заведена задача: ", anchor); content.append(paragraph); currentRow.cells[column.id] = content.innerHTML; return true;
  }
  function showCreated() {
    steps(4);
    const success = document.createElement("div"); success.className = "bug-success-check";
    success.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#icon-check"></use></svg>';
    const title = document.createElement("h3"); title.textContent = "Баг-репорт создан";
    const status = document.createElement("p");
    const count = state.created.attachmentKeys?.length || 0, uploaded = state.created.uploads?.length || 0;
    status.textContent = state.created.attachmentsPending ? `Вложения: ${uploaded} из ${count} загружено` : state.created.evidencePending ? "Осталось добавить ссылки на вложения" : `Задача успешно создана в ${state.created.provider === "eva" ? "EVA" : "Jira"}`;
    const card = document.createElement("a"); card.className = "bug-success-issue";
    card.href = window.QaReportTrackerLinks.identity(state.created.issueUrl) || state.created.issueUrl; card.target = "_blank"; card.rel = "noopener noreferrer";
    const key = document.createElement("strong"); key.textContent = state.created.key; key.append(uiIcon("external"));
    const summary = document.createElement("span"); summary.textContent = state.created.summary || state.createdSummary || ""; card.append(uiIcon(state.created.provider === "eva" ? "bug" : "jira"), key, summary);
    const actions = document.createElement("div"); actions.className = "bug-success-actions";
    const open = document.createElement("a"); open.href = card.href; open.target = "_blank"; open.rel = "noopener noreferrer"; open.className = "button button-primary"; open.textContent = state.created.provider === "eva" ? "Открыть в EVA" : "Открыть в Jira"; open.append(uiIcon("external"));
    const again = document.createElement("button"); again.type = "button"; again.className = "button button-secondary"; again.textContent = "Создать ещё один";
    again.disabled = state.busy || state.created.attachmentsPending || state.created.evidencePending;
    again.addEventListener("click", () => { const previous = state; close(); openBugAgain(previous); });
    const done = document.createElement("button"); done.type = "button"; done.className = "button button-secondary"; done.textContent = "Закрыть"; done.disabled = state.busy && state.creating; done.addEventListener("click", close);
    actions.append(open, again, done); $("bugCreatedResult").replaceChildren(success, title, status, card, actions);
  }
  function openBugAgain(previous) { open(previous.sectionId, previous.rowId, previous.anchor); }
  async function persistCreated() {
    state.created.extraAssets = (state.created.extraAssets || []).filter(a => !(state.created.uploads || []).includes(assetKey(a)));
    const stored = row()?.bugs?.find(b => b.operationId === state.created.operationId);
    if (stored) Object.assign(stored, state.created);
    await persist(); showCreated();
  }
  async function retry(operation) {
    const current = state;
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (state !== current || attempt >= 2 || !([404, 408, 429].includes(error.status) || error.status >= 500 || error instanceof TypeError)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  async function upload() {
    const completed = new Set(state.created.uploads || []);
    const assets = state.selectedAssets.filter(asset => !completed.has(assetKey(asset)));
    const originalKeys = new Map(assets.map(asset => [JSON.stringify([asset.attachmentId, asset.dataUrl, asset.source.issueUrl, asset.source.id]), assetKey(asset)]));
    const missing = (state.created.attachmentKeys || []).filter(key => !completed.has(key) && !assets.some(asset => assetKey(asset) === key));
    if (missing.length) throw new Error(`Исходное вложение удалено из пункта. Добавьте его вручную в созданную задачу.`);
    if (!assets.length) { state.uploadsPending = false; state.created.attachmentsPending = false; await persistCreated(); return; }
    const settings = { ...api.jiraSettings(), provider: state.created.provider || "jira", transport: "agent", baseUrl: state.created.baseUrl || new URL(state.created.issueUrl).href.split("/browse/")[0] };
    const issue = { issueUrl: state.created.issueUrl };
    const manifest = await retry(() => api.jiraRequest("/api/jira/attachment-manifest", { ...settings, ...issue }));
    const plan = await window.QaReportJiraReuse.plan(assets, { issueUrl: state.created.issueUrl, attachments: manifest.attachments,
      loadSource: async source => {
        const result = await retry(() => api.jiraRequest("/api/jira/import-attachment", { ...settings, commentUrl: source.issueUrl, attachmentId: source.id }));
        return `data:${result.file.type};base64,${result.file.dataBase64}`;
      } });
    state.created.attachmentRefs ||= {};
    const remember = (file, originals) => originals.forEach(original => {
      const key = originalKeys.get(original.key); completed.add(key);
      state.created.attachmentRefs[key] = { id: String(file.id), filename: file.filename || file.name, content: file.content || "" };
    });
    for (const reused of plan.reused) remember(reused, reused.originals);
    for (let i = 0; i < plan.uploads.length; i++) {
      const file = plan.uploads[i]; message(`Задача создана. Загружаем вложение ${i + 1} из ${plan.uploads.length}: ${file.name}`);
      const problem = window.QaReportAttachmentLimits?.fileError(file, manifest.attachmentLimits);
      if (problem) throw new Error(problem);
      state.created.uploadOperations ||= {};
      const uploadKey = file.originals.map(original => originalKeys.get(original.key)).sort().join("|");
      state.created.uploadOperations[uploadKey] ||= crypto.randomUUID();
      state.created.uploadNames ||= {}; state.created.uploadNames[uploadKey] ||= file.name;
      const storedBefore = row()?.bugs?.find(b => b.operationId === state.created.operationId); if (storedBefore) { storedBefore.uploadOperations = state.created.uploadOperations; storedBefore.uploadNames = state.created.uploadNames; }
      await persist();
      const payload = { ...settings, ...issue, operationId: state.created.uploadOperations[uploadKey], files: [{ attachmentId: state.created.uploadOperations[uploadKey], name: state.created.uploadNames[uploadKey], type: file.type, dataBase64: file.dataBase64 }] };
      // Retry the same UUID: Connect replays confirmed uploads and blocks an uncertain POST.
      const result = await retry(() => api.jiraRequest("/api/jira/attachments", payload, { retries: 0 }));
      if (!result.attachments?.[0]?.id) throw new Error("Сервер не подтвердил загрузку вложения");
      remember(result.attachments[0], file.originals);
      state.created.uploads = [...completed];
      await persistCreated();
    }
    state.created.uploads = [...completed]; state.uploadsPending = false; state.created.attachmentsPending = false; await persistCreated();
  }
  async function evidence() {
    state.evidencePending = Boolean(state.created.evidencePending);
    if (!state.evidencePending) return;
    message("Вложения загружены. Добавляем ссылки в текст бага…");
    await retry(() => job("/api/jira/issue-evidence", { provider: state.created.provider || "jira", baseUrl: state.created.baseUrl || new URL(state.created.issueUrl).href.split("/browse/")[0], operationId: state.created.operationId,
      issueKey: state.created.key, fieldId: state.created.evidenceField, attachmentIds: [...new Set(Object.values(state.created.attachmentRefs || {}).map(ref => ref.id))],
      placements: (state.created.inlineAttachments || []).filter(item => state.created.attachmentRefs?.[item.assetKey]).map(item => ({ placeholder: item.placeholder, attachmentId: state.created.attachmentRefs[item.assetKey].id })) }));
    state.created.evidencePending = state.evidencePending = false; await persistCreated();
  }
  async function create() {
    if (!state || state.busy || voiceActive() || state.filesLoading) return;
    const current = state; state.creating = true;
    let savingNewOperation = false;
    try {
      if (!state.created) {
        if (!state.pending) {
          const fields = values();
          state.selectedAssets = [...$("bugAttachmentList").querySelectorAll("input:checked")].map(el => state.assets[Number(el.dataset.bugAttachment)]);
          // Keep the established Connect wire format; the editor shows Jira references.
          const inlineAttachments = state.selectedAssets.filter(asset => state.inlineAssets[assetKey(asset)] && String(fields.description || "").includes(state.inlineAssets[assetKey(asset)])).map(asset => {
            const token = state.inlineAssets[assetKey(asset)], placeholder = token.startsWith("[Вложение: ") ? token : `[Вложение: ${token.startsWith("!") ? token.slice(1, -11) : token.slice(2, -1)}]`;
            fields.description = fields.description.split(token).join(placeholder);
            return { assetKey: assetKey(asset), placeholder };
          });
          state.pending = { id: crypto.randomUUID(), payload: { ...target(), fields }, assets: state.selectedAssets.map(a => assetKey(a)), evidenceField: state.evidenceField, extraAssets: state.extraAssets.filter(a => state.selectedAssets.includes(a)),
            inlineAttachments };
          state.pending.payload.operationId = state.pending.id;
          busy(true, "Создаём задачу…");
          if (!state.standalone) row().pendingBug = state.pending;
          savingNewOperation = state.standalone;
          await persist();
          savingNewOperation = false;
          const result = await job("/api/jira/create-issue", state.pending.payload); link(result);
        } else {
          busy(true, "Проверяем результат создания…");
          // Reposting the same operation safely recovers an interrupted enqueue response.
          const result = await job("/api/jira/create-issue", state.pending.payload); link(result);
        }
        state.pending = null;
        await persist();
      }
      state.uploadsPending = Boolean(state.created.attachmentsPending); state.evidencePending = Boolean(state.created.evidencePending); busy(true, state.uploadsPending ? "Баг создан. Загружаем вложения…" : "Завершаем создание…");
      await upload();
      await evidence();
      message("");
    } catch (error) {
      if (state !== current) return;
      if (state.created) { state.uploadsPending = Boolean(state.created.attachmentsPending); state.evidencePending = Boolean(state.created.evidencePending); message(`${state.uploadsPending ? "Баг создан, но не все вложения загружены. Можно повторить загрузку или добавить файлы вручную в задачу." : "Вложения загружены, но ссылки не добавлены в текст. Можно повторить или добавить их в задачу."} ${error.message}`, true); }
      else {
        if (savingNewOperation) state.pending = null;
        if (error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) {
          const operationId = state.pending?.id;
          delete row()?.pendingBug; state.pending = null;
          if (state.standalone && operationId) await standaloneRecord("clear", operationId); else if (!state.standalone) api.changed();
        }
        Object.entries(error.fieldErrors || {}).forEach(([id, text]) => markError(id, text));
        message(error.message, true);
      }
    } finally { if (state === current) { state.creating = false; busy(false); } }
  }
  async function open(sectionId, rowId, anchor) {
    if (state) return;
    api.flush();
    const report = api.getDraft(), section = report.sections.find(s => s.id === sectionId), sourceRow = section?.rows.find(r => r.id === rowId);
    const standalone = sectionId === null && rowId === null;
    if (!sourceRow && !standalone) return;
    const htmlText = html => { const div = document.createElement("div"); div.innerHTML = html || ""; div.querySelectorAll("[data-editor-ui], .cell-file, img").forEach(n => n.remove()); return div.innerText || div.textContent || ""; };
    const assets = sourceRow ? window.QaReportJiraReuse.collect({ sections: [{ rows: [sourceRow] }] }) : [];
    state = { sectionId, rowId, anchor, standalone, profiles: [], assets, availableAssets: window.QaReportJiraReuse.collect(report), fields: null, meta: null, pending: sourceRow?.pendingBug || null, selectedAssets: [], ready: false,
      extraAssets: [], inlineAssets: {}, inlineReady: false, speech: { mode: "browser", available: true, label: "Диктовка браузера" }, voicePhase: "idle", voiceAttempt: 0, speechReady: false,
      source: standalone ? { attachments: [] } : { report: { issueUrl: report.issueUrl, environment: report.environment, context: htmlText(report.intro).slice(0, 16000) }, section: section.title, status: sourceRow.status,
        cells: section.columns.map(c => ({ id: c.id, name: c.title, text: htmlText(sourceRow.cells[c.id]).slice(0, 12000) })), attachments: assets.map(a => ({ name: a.name, type: a.type })) } };
    const current = state;
    state.created = sourceRow?.bugs?.find(b => b.attachmentsPending || b.evidencePending) || null;
    state.extraAssets = state.pending?.extraAssets || state.created?.extraAssets || [];
    state.assets.push(...state.extraAssets); state.source.attachments = state.assets.map(a => ({ name: a.name, type: a.type }));
    $("bugAttachmentList").replaceChildren(); $("bugContextText").value = ""; $("bugExtraContext").open = false; $("bugExtraFiles").replaceChildren(); $("bugVoiceHint").textContent = ""; $("bugContextFiles").value = "";
    $("bugExtraContext").open = standalone;
    $("bugContextSummary").textContent = standalone ? "Описание проблемы" : "Добавить контекст";
    $("bugContextHint").textContent = standalone ? "" : "Контекст пункта чек-листа уже передан. Дополнительные уточнения необязательны.";
    $("bugContextHint").hidden = standalone;
    $("bugContextTitle").textContent = standalone ? "Контекст для ИИ" : "Уточнения для ИИ";
    $("bugContextRequired").hidden = !standalone;
    $("bugContextText").setAttribute("aria-required", String(standalone));
    $("bugExtraContext").open = true;
    $("bugContextSummary").textContent = standalone ? "Опишите проблему для ИИ" : "Уточнения для ИИ";
    $("bugAiHint").textContent = "Проверяем подключение ИИ…";
    analysisOptions(); resetVoiceMeter();
    state.voice = new window.QaReportVoiceInput.VoiceInput({ onText: text => {
      if (state !== current) return;
      const entry = $("bugContextText"), next = [entry.value.trim(), text].filter(Boolean).join("\n\n");
      if (next.length > 16000) throw new Error("Контекст слишком длинный. Сократите текст и повторите диктовку.");
      entry.value = next;
    }, onMeter: value => { if (state === current) voiceMeter(value); }, onState: value => { if (state === current) { const focused = $("bugVoicePanel").contains(document.activeElement); state.voicePhase = value.phase; $("bugVoiceHint").textContent = value.text; $("bugVoiceHint").dataset.state = value.phase; contextControls(); if (focused && !voiceActive()) $("bugVoice").focus(); } }, transcribe: (audio, selection) => job("/api/ai/transcribe", { audio, selection }), transform: async (text, selection) => (await job("/api/ai/refine", { text, selection })).text });
    let commentsChanged = false;
    (sourceRow?.bugs || []).forEach(bug => { commentsChanged = addBugComment(sourceRow, bug) || commentsChanged; });
    if (commentsChanged) api.changed();
    state.uploadsPending = Boolean(state.created?.attachmentsPending); state.evidencePending = Boolean(state.created?.evidencePending);
    state.evidenceField = state.pending?.evidenceField || state.created?.evidenceField || "";
    state.selectedAssets = assets.filter(a => (state.pending?.assets || state.created?.attachmentKeys || []).includes(assetKey(a)));
    for (const id of ["bugTypeRow", "bugEditor", "bugCreatedResult", "bugParentSummary", "bugMissingInformation"]) $(id).hidden = true;
    $("bugTargetSection").hidden = false;
    $("loadBugFields").hidden = true; $("bugIssueType").replaceChildren(); $("bugProjectOptions").replaceChildren();
    steps(false); $("bugFooterHint").textContent = "Выберите место создания и нажмите «Продолжить»."; $("cancelBugReport").textContent = "Отмена";
    $("bugTargetSection").open = true; $("bugTargetSummary").textContent = "Куда создать баг";
    state.obscured = [...document.querySelectorAll(".topbar, .workspace, #feedbackButton, #focusExitButton")].map(node => [node, node.inert]);
    state.obscured.forEach(([node]) => { node.inert = true; });
    $("bugReportModal").hidden = false; api.modalOverflow(); busy(true, "Подключаемся к QA Report Connect…", "initializing");
    try {
      const statusRequest = api.bugStatus ? api.bugStatus() : api.reportApi("/api/agent/status");
      // Observe both independent reads immediately, including a failure of either.
      const [savedStandalone, status] = await Promise.all([standalone ? standaloneRecord("get") : null, statusRequest]);
      if (state !== current) return;
      if (standalone) {
        const saved = savedStandalone;
        state.pending = saved?.pending || null; state.created = saved?.created || null;
        state.extraAssets = saved?.extraAssets || []; state.assets.push(...state.extraAssets);
        state.source.attachments = state.assets.map(a => ({ name: a.name, type: a.type }));
        $("bugContextText").value = saved?.contextText || ""; extraFilesUI(); analysisOptions();
        state.evidenceField = state.pending?.evidenceField || state.created?.evidenceField || "";
        state.selectedAssets = state.assets.filter(a => (state.pending?.assets || state.created?.attachmentKeys || []).includes(assetKey(a)));
        state.uploadsPending = Boolean(state.created?.attachmentsPending); state.evidencePending = Boolean(state.created?.evidencePending);
      }
      const device = status.devices.filter(d => d.online).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
      if (!status.connected || !device) throw new Error(api.bugStatus ? "Подключите Jira в настройках приложения." : "Откройте QA Report Connect и подключите систему задач.");
      const parts = String(device.version).split(".").map(Number);
      state.inlineReady = Boolean(api.bugStatus || parts[0] > 0 || parts[1] > 6 || parts[1] === 6 && parts[2] >= 16);
      if (!api.bugStatus && !(parts[0] > 0 || parts[1] > 6 || parts[1] === 6 && parts[2] >= 3)) throw new Error("Обновите QA Report Connect до версии 0.6.3: Настройки → Проверить сейчас.");
      const devices = status.devices.filter(d => d.online).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
      state.inlineDevices = devices;
      const jiraUrls = [...new Set(devices.flatMap(d => d.jiraBaseUrls?.length ? d.jiraBaseUrls : d.jiraBaseUrl ? [d.jiraBaseUrl] : []))];
      const evaUrls = [...new Set(devices.flatMap(d => d.evaBaseUrls || []))];
      const urls = [...jiraUrls, ...evaUrls.map(url => "eva:" + url)];
      if (!urls.length) throw new Error(api.bugStatus ? "Подключите Jira в настройках приложения." : "Добавьте подключение системы задач в QA Report Connect.");
      const saved = { ...(state.pending?.payload || read(TARGET_KEY, {})) }, settings = api.jiraSettings();
      const reportTarget = window.QaReportTrackerLinks.parse(report.issueUrl);
      if (state.created) Object.assign(saved, window.QaReportTrackerLinks.parse(state.created.issueUrl), { provider: state.created.provider || "jira" });
      const selected = (saved.provider === "eva" ? "eva:" : "") + (saved.baseUrl || "");
      const reportSelected = (reportTarget?.provider === "eva" ? "eva:" : "") + (reportTarget?.baseUrl || settings.baseUrl);
      const locked = state.pending || state.created;
      selectOptions($("bugJiraConnection"), urls.map(url => { const eva = url.startsWith("eva:"), address = new URL(eva ? url.slice(4) : url); return { value: url, label: `${eva ? "EVA" : "Jira"} · ${address.host}${address.pathname.replace(/\/$/, "")}` }; }), !locked && urls.includes(reportSelected) ? reportSelected : urls.includes(selected) ? selected : urls[0]);
      $("bugJiraConnection").options[0].remove();
      document.querySelector(`[name="bugCreationMode"][value="${saved.mode === "subtask" ? "subtask" : "standalone"}"]`).checked = true;
      $("bugProject").value = ($("bugJiraConnection").value === selected && saved.projectKey) || (!standalone && String(report.issueUrl || "").match(/\/browse\/([A-Z][A-Z0-9_]*)-\d+/i)?.[1]) || "";
      $("bugParent").value = !locked && !standalone && reportTarget ? reportTarget.issueUrl : saved.parent || (!standalone && report.issueUrl) || "";
      $("bugParentField").hidden = target().mode !== "subtask"; $("bugProjectField").hidden = target().mode === "subtask";
      state.ready = true; busy(false);
      selectOptions($("bugAiProfile"), [], "", "Проверяем подключение ИИ…");
      state.speechRequest = job("/api/ai/profiles", {}).then(result => {
        if (state !== current) return;
        state.speech = result.speech || state.speech; state.speechReady = true; state.profiles = result.profiles; contextControls();
        selectOptions($("bugAiProfile"), result.profiles.map(p => ({ value: p.id, label: `${p.label} · ${p.model}` })), result.profiles.find(p => p.isDefault)?.id || result.profiles[0]?.id || "", "ИИ не подключён");
        if (result.profiles.length) $("bugAiProfile").options[0].remove();
        $("bugAiHint").textContent = result.profiles.length ? "Проверьте черновик перед созданием задачи." : "Подключите ИИ в Connect или заполните баг вручную.";
        contextControls();
      }).catch(() => { if (state === current) { selectOptions($("bugAiProfile"), [], "", "ИИ недоступен"); $("bugAiHint").textContent = "Можно заполнить баг вручную. Проверьте подключение ИИ в Connect."; } });
      loadProjects().catch(() => {});
      if (!state.created && !state.pending && (target().mode === "subtask" ? target().parent : target().projectKey)) loadContext();
      if (state.pending) steps(3);
      if (state.created) {
        steps(true); showCreated();
      }
      if (!state.busy) message(state.created ? state.uploadsPending ? "Баг создан. Повторите загрузку вложений или добавьте файлы вручную в задачу." : "Файлы загружены. Осталось добавить ссылки в текст бага." : state.pending ? "Проверим результат предыдущего создания." : "");
      document.querySelector('[name="bugCreationMode"]:checked').focus();
    } catch (error) { if (state === current) message(error.message, true); }
    finally { if (state === current && state.activity === "initializing") busy(false); }
  }
  function close() {
    if (state?.creating && state.busy) return;
    state?.voice?.cancel();
    state?.obscured?.forEach(([node, inert]) => { node.inert = inert; });
    const anchor = state?.anchor; state = null; $("bugPromptDialog").hidden = true; $("bugReportModal").hidden = true; api.modalOverflow(); if (anchor?.isConnected) anchor.focus();
  }
  function fillSettings() { $("bugSystemPrompt").value = prompt(); $("bugRememberIssueType").checked = rememberTypes(); }
  function saveSettings() {
    const text = $("bugSystemPrompt").value.trim(); if (!text) throw new Error("Системный промпт не должен быть пустым");
    localStorage.setItem(PROMPT_KEY, JSON.stringify(text));
    localStorage.setItem(TYPE_SETTINGS_KEY, JSON.stringify({ remember: $("bugRememberIssueType").checked }));
  }
  function init(adapter) {
    api = adapter;
    const columns = $("bugEditor").querySelector(".bug-draft-columns"), divider = $("bugDraftResize");
    let draftRatio = read(LAYOUT_KEY, 65), drag = null;
    if (typeof draftRatio !== "number" || !Number.isFinite(draftRatio)) draftRatio = 65;
    function splitBounds() {
      const width = Math.max(1, columns.getBoundingClientRect().width - 28);
      return { width, min: Math.max(40, Math.min(60, 320 / width * 100)), max: Math.max(60, Math.min(78, (width - 240) / width * 100)) };
    }
    function split(value = draftRatio, save = false) {
      if (!columns.getClientRects().length || window.matchMedia("(max-width: 720px)").matches) return;
      const bounds = splitBounds(), ratio = Math.max(bounds.min, Math.min(bounds.max, value));
      columns.style.setProperty("--bug-draft-left", `${ratio}fr`); columns.style.setProperty("--bug-draft-right", `${100 - ratio}fr`);
      divider.setAttribute("aria-valuenow", String(Math.round(ratio))); divider.setAttribute("aria-valuemin", String(Math.round(bounds.min))); divider.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
      divider.setAttribute("aria-valuetext", `Левая колонка: ${Math.round(ratio)}%`);
      if (save) { draftRatio = ratio; try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(ratio)); } catch {} }
    }
    divider.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !state || state.busy || window.matchMedia("(max-width: 720px)").matches) return;
      event.preventDefault(); divider.focus(); drag = { pointer: event.pointerId, current: state }; divider.setPointerCapture(event.pointerId); columns.classList.add("resizing");
    });
    divider.addEventListener("pointermove", event => {
      if (!drag || drag.pointer !== event.pointerId || state !== drag.current) return;
      const bounds = splitBounds(), box = columns.getBoundingClientRect(); split((event.clientX - box.left - 14) / bounds.width * 100, true);
    });
    const stopSplit = () => { drag = null; columns.classList.remove("resizing"); };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) divider.addEventListener(type, stopSplit);
    divider.addEventListener("dblclick", () => { if (!state?.busy) split(65, true); });
    divider.addEventListener("keydown", event => {
      if (state?.busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const bounds = splitBounds(), ratio = Number(divider.getAttribute("aria-valuenow"));
      split(event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max : ratio + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : 2), true);
    });
    new ResizeObserver(() => split()).observe(columns);
    const dockObserver = new ResizeObserver(scheduleContextDock);
    for (const node of [$("bugContextText"), $("bugReportModal").querySelector(".bug-context-dock"), $("bugReportModal").querySelector(".bug-report-body")]) dockObserver.observe(node);
    $("bugReportModal").querySelector(".bug-report-body").addEventListener("scroll", scheduleContextDock, { passive: true });
    window.addEventListener("resize", scheduleContextDock);
    $("resetBugPrompt")?.addEventListener("click", () => { $("bugSystemPrompt").value = Bugs.DEFAULT_PROMPT; api.settingsDirty(); });
    $("bugSystemPrompt")?.addEventListener("input", api.settingsDirty);
    $("bugRememberIssueType")?.addEventListener("change", api.settingsDirty);
    $("closeBugReport").setAttribute("aria-label", "Закрыть баг-репорт");
    $("closeBugReport").addEventListener("click", close); $("cancelBugReport").addEventListener("click", close);
    $("bugReportModal").addEventListener("click", event => { if (!$("bugVoiceInfo").contains(event.target)) $("bugVoiceInfo").open = false; });
    // Editing history belongs to the focused field, not the checklist below the modal.
    $("bugReportModal").addEventListener("keydown", event => {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (!["z", "y"].includes(key)) return;
      event.stopPropagation(); event.preventDefault();
      const active = document.activeElement;
      if (active?.matches("input, textarea, [contenteditable=true]") && !active.disabled && !active.readOnly) document.execCommand(key === "y" || event.shiftKey ? "redo" : "undo");
    });
    // Keep outside interactions from reaching page-level dismissal handlers.
    $("bugReportModal").addEventListener("pointerdown", event => { if (event.target === $("bugReportModal")) event.preventDefault(); event.stopPropagation(); });
    $("bugReportModal").addEventListener("click", event => { if (event.target === $("bugReportModal")) event.preventDefault(); event.stopPropagation(); });
    document.addEventListener("keydown", event => {
      if ($("bugReportModal").hidden) return;
      if (!$("bugPromptDialog").hidden) {
        if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closePrompt(); }
        if (event.key === "Tab") {
          const controls = [...$("bugPromptDialog").querySelectorAll("textarea, button")];
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
        }
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if ($("bugVoiceInfo").open) { $("bugVoiceInfo").open = false; $("bugVoiceInfo").querySelector("summary").focus(); } else close(); }
      if (event.key === "Tab") {
        const controls = [...$("bugReportModal").querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [contenteditable], [role=separator]")].filter(el => el.tabIndex >= 0 && el.getClientRects().length);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    });
    for (const id of ["bugJiraConnection", "bugCreationMode", "bugProject", "bugParent"]) $(id).addEventListener("change", invalidate);
    $("bugJiraConnection").addEventListener("change", () => { loadProjects().catch(error => message(error.message, true)); });
    $("bugParent").addEventListener("input", () => parentConnection());
    for (const id of ["bugJiraConnection", "bugCreationMode", "bugProject", "bugParent"]) $(id).addEventListener("change", () => {
      if (!state || state.busy || state.created || state.pending) return;
      if (target().baseUrl && (target().mode === "subtask" ? target().parent : target().projectKey)) loadContext();
    });
    for (const id of ["bugProject", "bugParent"]) {
      $(id).addEventListener("input", targetControls);
      $(id).addEventListener("blur", () => {
        if (!state || state.busy || state.created || state.pending || state.loadedTarget === JSON.stringify(target())) return;
        if (target().mode === "subtask" ? target().parent : target().projectKey) { invalidate(); loadContext(); }
      });
    }
    $("bugIssueType").addEventListener("change", () => { state.fields = null; $("bugEditor").hidden = true; $("createBugIssue").hidden = true; loadFields(); });
    $("loadBugContext").addEventListener("click", () => { if (state?.fields) { steps(2); contextControls(); $("bugContextText").focus(); } }); $("loadBugFields").addEventListener("click", () => loadFields());
    $("bugAiAttachments").addEventListener("change", () => { $("bugAiAttachmentSelection").hidden = !$("bugAiAttachments").checked; });
    $("bugVoice").addEventListener("click", dictate);
    $("bugVoiceStop").addEventListener("click", () => state?.voice?.stop());
    $("bugVoiceCancel").addEventListener("click", cancelDictation);
    $("bugAddContextFiles").addEventListener("click", () => $("bugContextFiles").click());
    $("bugContextFiles").addEventListener("change", () => addContextFiles());
    $("bugContextText").addEventListener("paste", pasteContextFiles);
    $("bugContextText").addEventListener("input", contextControls);
    $("bugBack").addEventListener("click", () => { if (state && !state.busy && !voiceActive()) { steps(Math.max(1, state.step - 1)); contextControls(); } });
    $("bugManualDraft").addEventListener("click", () => { if (!state.draftReady && !state.generated) setField("description", $("bugContextText").value.trim()); state.draftReady = true; steps(3); contextControls(); });
    $("bugReviewDraft").addEventListener("click", () => { steps(3); contextControls(); });
    $("bugPrepareDraft").addEventListener("click", () => {
      if (state.profiles.length) generate();
      else { if (!state.draftReady) { setField("description", $("bugContextText").value.trim()); } state.draftReady = true; steps(3); contextControls(); }
    });
    $("editBugPrompt").addEventListener("click", () => { $("bugWizardPrompt").value = prompt(); $("bugPromptDialog").hidden = false; $("bugWizardPrompt").focus(); });
    $("cancelBugPrompt").addEventListener("click", closePrompt);
    $("saveBugPrompt").addEventListener("click", () => { const value = $("bugWizardPrompt").value.trim(); if (!value) { $("bugWizardPrompt").focus(); return; } localStorage.setItem(PROMPT_KEY, JSON.stringify(value)); closePrompt(); });
    const drop = $("bugExtraContext");
    drop.addEventListener("dragover", event => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); event.stopPropagation(); drop.classList.add("bug-file-drop"); } });
    drop.addEventListener("dragleave", event => { if (!drop.contains(event.relatedTarget)) drop.classList.remove("bug-file-drop"); });
    drop.addEventListener("drop", event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); drop.classList.remove("bug-file-drop"); addContextFiles([...event.dataTransfer.files]); } });
    $("bugEditor").addEventListener("dragover", event => {
      if (![...(event.dataTransfer?.types || [])].some(type => type === "Files" || type === ATTACHMENT_DRAG)) return;
      event.preventDefault(); event.stopPropagation(); const control = descriptionControl();
      const visual = control?.hidden ? window.QaReportBugRich.get(control)?.visual : null;
      const allowed = (event.target === control || visual?.contains(event.target)) && state.inlineReady && !state.busy && !state.pending && !state.created;
      event.dataTransfer.dropEffect = allowed ? "copy" : "none"; (visual || control)?.classList.toggle("bug-file-drop", allowed);
    });
    $("bugEditor").addEventListener("dragleave", event => { event.target.closest?.(".bug-file-drop")?.classList.remove("bug-file-drop"); });
    $("bugEditor").addEventListener("drop", descriptionFiles);
    $("bugEditor").addEventListener("paste", descriptionFiles);
    $("generateBugDraft").addEventListener("click", generate); $("createBugIssue").addEventListener("click", create);
  }
  window.QaReportBugUI = { init, open, openStandalone: anchor => open(null, null, anchor), fillSettings, saveSettings };
})();
