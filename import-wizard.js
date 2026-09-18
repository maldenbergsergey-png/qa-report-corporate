/* The import dialog edits a selection plan; the parsed source remains untouched. */
(function (root) {
  "use strict";
  const O = root.QaReportImportOptions, A = root.QaReportAttachments;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  function plain(html) {
    const template = document.createElement("template"); template.innerHTML = html || "";
    template.content.querySelectorAll("img").forEach(img => img.replaceWith(document.createTextNode(img.dataset.fileName || img.alt || "Изображение")));
    template.content.querySelectorAll("br, p, li").forEach(node => node.append(document.createTextNode(" ")));
    return template.content.textContent.replace(/\s+/g, " ").trim();
  }
  function mount(container, source, { attachments = [], comment = false, download = true, currentMode = "section", currentDocument = { sections: [], numberingMode: currentMode }, defaultMode = "replace", onChange }) {
    let state = O.create(source);
    const hasHeaderless = source.sections.some(section => section.headerless);
    const policy = { mode: comment && download ? "download" : "reference", images: true, overrides: new Map() };
    const opened = new Set(), initialized = new Set();
    let targetDocument = JSON.parse(JSON.stringify(currentDocument));
    const destination = { mode: defaultMode, afterId: "", targetId: hasHeaderless && targetDocument.sections.length === 1 ? targetDocument.sections[0].id : "", columns: new Map() };
    const placement = () => ({ ...destination, columns: new Map(destination.columns), preserveNumbers: preserve });
    const selectedDocument = () => {
      const result = O.build(source, state);
      if (destination.mode !== "replace") result.intro = "";
      return result;
    };
    const sectionLabel = (section, index) => `${index + 1}. ${section.title || "Раздел"}`;
    const destinationText = () => {
      if (destination.mode === "replace") return "Содержимое текущего чек-листа будет заменено";
      if (destination.mode === "rows") {
        const index = targetDocument.sections.findIndex(s => s.id === destination.targetId);
        return index < 0 ? "Выберите раздел назначения" : `В раздел «${sectionLabel(targetDocument.sections[index], index)}» · в конец`;
      }
      if (destination.afterId === "start") return "Новые разделы · в начало чек-листа";
      const index = targetDocument.sections.findIndex(s => s.id === destination.afterId);
      return index < 0 ? "Новые разделы · в конец чек-листа" : `Новые разделы · после «${sectionLabel(targetDocument.sections[index], index)}»`;
    };
    let tab = "rows", preserve = root.ChecklistNumbering.hasSourceNumbers(source), busy = false;
    let numbers = new Map(source.sections.flatMap(section => section.rows.map((row, index) => [row.id, row.manualNumber ?? `${index + 1}.`])));
    const nameOf = (section, row) => plain(row.cells[section.columns[0]?.id]) || "Пустой пункт";
    const shortName = (section, row) => `${numbers.get(row.id)} ${nameOf(section, row)}`.trim();
    const options = [["keep", "Сохранить содержимое"], ["clear", "Оставить пустым"], ["omit", "Не импортировать"]];
    const fileOptions = [...(comment ? [["download", "Скачать в браузер"]] : []), ["reference", "Оставить ссылки на Jira"], ["omit", "Не переносить"]];
    function changed(custom = true) { if (custom) state.preset = "custom"; render(); }
    function button(text, id, action, className = "button button-ghost") {
      const node = el("button", className, text); node.type = "button"; node.dataset.focus = id;
      node.addEventListener("click", action); return node;
    }
    function check(text, id, value, action, className = "import-check") {
      const label = el("label", className), input = el("input"); input.type = "checkbox";
      input.checked = value; input.dataset.focus = id;
      input.addEventListener("change", () => action(input.checked)); label.append(input, el("span", "", text));
      return label;
    }
    function select(id, label, choices, value, action) {
      const node = el("select", "import-select"); node.dataset.focus = id; node.setAttribute("aria-label", label);
      for (const [key, text] of choices) { const option = el("option", "", text); option.value = key; node.append(option); }
      node.value = value;
      node.addEventListener("change", () => action(node.value)); return node;
    }
    function field(text, control, hint) {
      const label = el("label", "import-setting"), copy = el("span", "import-setting-copy");
      copy.append(el("strong", "", text)); if (hint) copy.append(el("small", "", hint));
      label.append(copy, control); return label;
    }
    function disclosure(id, title, fill, initial = false) {
      if (!initialized.has(id)) { initialized.add(id); if (initial) opened.add(id); }
      const node = el("details", "import-disclosure"); node.dataset.disclosure = id;
      const summary = el("summary", "", title); summary.dataset.focus = `details-${id}`;
      const content = el("div", "import-disclosure-body"); node.append(summary, content);
      let filled = false;
      const populate = () => { if (!filled) { fill(content); filled = true; } };
      node.open = opened.has(id); if (node.open) populate();
      node.addEventListener("toggle", () => {
        if (!node.isConnected) return;
        if (node.open) { opened.add(id); populate(); } else opened.delete(id);
      });
      return node;
    }
    function changeHeaderlessRoles(section, role, enabled) {
      const updated = root.QaReportJiraImport.configureHeaderlessSection(section, { ...section.headerless, [role]: enabled }, attachments);
      source = { ...source, sections: source.sections.map(item => item.id === section.id ? updated : item) };
      const next = O.create(source);
      next.mapping.forEach((value, key) => { if (state.mapping.has(key)) next.mapping.set(key, state.mapping.get(key)); });
      next.columns.forEach((value, key) => { if (state.columns.has(key)) next.columns.set(key, state.columns.get(key)); });
      state = { ...state, mapping: next.mapping, columns: next.columns };
      if ([...state.mapping.values()].some(value => !value)) opened.add("mapping");
      numbers = new Map(source.sections.flatMap(item => item.rows.map((row, index) => [row.id, row.manualNumber ?? `${index + 1}.`])));
      preserve = root.ChecklistNumbering.hasSourceNumbers(source);
      destination.columns.clear();
      changed(false);
    }
    function renderHeaderless(panel) {
      if (!hasHeaderless) return;
      panel.append(el("p", "import-help", "Заголовков нет. Проверьте, есть ли номер и статус; остальные столбцы сопоставляются с разделом по порядку. Соответствие можно изменить ниже."));
      for (const section of source.sections.filter(item => item.headerless)) {
        if (source.sections.length > 1) panel.append(el("strong", "import-preview-title", section.title));
        panel.append(check("Первый столбец — номер пункта", `source-number-${section.id}`, section.headerless.numberColumn,
          value => changeHeaderlessRoles(section, "numberColumn", value)));
        panel.append(check("Последний столбец — статус", `source-status-${section.id}`, section.headerless.statusColumn,
          value => changeHeaderlessRoles(section, "statusColumn", value)));
      }
    }
    function renderDestination(panel, result, plan) {
      const block = el("div", "import-destination");
      renderHeaderless(block);
      block.append(field("Куда импортировать", select("destination-mode", "Куда импортировать", [
        ["sections", "Добавить новые разделы"], ["rows", "Добавить в существующий раздел"], ["replace", "Заменить чек-лист"],
      ], destination.mode, value => { destination.mode = value; changed(false); })));
      if (destination.mode === "sections") {
        block.append(field("Место вставки", select("destination-after", "Место вставки", [
          ["", "В конец чек-листа"], ["start", "В начало чек-листа"],
          ...targetDocument.sections.map((s, index) => [s.id, `После «${sectionLabel(s, index)}»`]),
        ], destination.afterId, value => { destination.afterId = value; changed(false); })));
        if (plan?.duplicateTitles.length) block.append(el("p", "import-help", "Названия уже встречаются: " + [...new Set(plan.duplicateTitles)].join(", ") + ". Будут добавлены отдельные разделы."));
      } else if (destination.mode === "rows") {
        block.append(field("Раздел назначения", select("destination-section", "Раздел назначения", [
          ["", "Выберите раздел…"], ...targetDocument.sections.map((s, index) => [s.id, sectionLabel(s, index)]),
        ], destination.targetId, value => { destination.targetId = value; destination.columns.clear(); changed(false); })));
        const target = targetDocument.sections.find(s => s.id === destination.targetId);
        if (target) {
          block.append(el("p", "import-help", hasHeaderless ? "Пункты добавятся в конец раздела. Проверьте соответствие столбцов без заголовков по примерам содержимого." : "Пункты добавятся в конец раздела. Столбцы с одинаковыми названиями сопоставляются автоматически."));
          if (plan?.newColumns.length) block.append(el("p", "import-help", `Новые столбцы: ${plan.newColumns.map(c => c.title).join(", ")}. В существующих пунктах они останутся пустыми.`));
          if (target.statusSort) block.append(el("p", "import-help", "В этом разделе включена сортировка: пункты будут показаны по статусу."));
          block.append(disclosure("destination-columns", "Настроить соответствие столбцов", body => {
            body.append(el("p", "import-help", "Каждый столбец источника переносится целиком. Выберите существующий столбец или создайте новый."));
            for (const section of result.sections) {
              if (result.sections.length > 1) body.append(el("strong", "import-preview-title", section.title || "Раздел"));
              for (const column of section.columns) {
                const mapping = plan?.mappings.find(m => m.sectionId === section.id && m.columnId === column.id);
                const autoTitle = mapping && !destination.columns.has(O.key(section.id, column.id)) ? `${mapping.title}${plan.newColumns.some(c => c.id === mapping.targetId) ? " (новый)" : ""}` : section.headerless ? "по порядку" : "по названию";
                const id = O.key(section.id, column.id);
                body.append(field(column.title, select(`destination-column-${id}`, `Куда перенести «${column.title}», ${section.title}`, [
                  ["", `Автоматически → ${autoTitle}`], ["new", "Создать новый столбец"], ...target.columns.map(c => [c.id, c.title]),
                ], destination.columns.get(id) || "", value => {
                  if (value) destination.columns.set(id, value); else destination.columns.delete(id);
                  changed(false);
                }), section.headerless ? plain(section.rows[0]?.cells[column.id]).slice(0, 140) || "Пустая ячейка" : ""));
              }
            }
          }, hasHeaderless));
        }
      }
      block.append(el("p", destination.mode === "replace" ? "import-validation" : "import-help",
        destination.mode === "replace" ? "Разделы и данные текущего чек-листа будут заменены. Перед заменой запросим подтверждение."
          : "Текущие пункты, результаты и реквизиты отчёта сохранятся. Добавление можно отменить одним действием."));
      panel.append(block);
    }
    function mappingPanel(panel) {
      const counts = new Map();
      for (const section of source.sections) for (const row of section.rows) {
        const raw = O.sourceStatus(row); counts.set(raw, (counts.get(raw) || 0) + 1);
      }
      const unresolved = [...state.mapping.values()].filter(v => !v).length;
      const box = disclosure("mapping", unresolved ? `Сопоставьте статусы: ${unresolved}` : "Статусы сопоставлены · Изменить", body => {
        body.append(el("p", "import-help", "Сопоставление применяется ко всем пунктам с таким исходным статусом. Затем можно отобрать нужные статусы ниже."));
        for (const [raw, count] of counts) {
          const suggested = root.QaReportJiraImport.matchStatus(raw).status;
          const choices = [["", suggested ? `Выберите статус · возможно, ${suggested}` : "Выберите статус"], ...O.statuses.map(s => [s, s])];
          body.append(field(`${raw || "Без статуса"} · ${count}`, select(`mapping-${raw}`, `Статус для «${raw || "Без статуса"}»`, choices, state.mapping.get(raw), value => {
            state.mapping.set(raw, value); changed(false);
          })));
        }
      }, unresolved > 0);
      if (unresolved) box.classList.add("needs-mapping"); panel.append(box);
    }
    function renderRows(panel) {
      mappingPanel(panel);
      const heading = el("div", "import-inline-heading"); heading.append(el("strong", "", "Статусы в исходном отчёте"), button("Все статусы", "all-statuses", () => { state.statuses = new Set(O.statuses); changed(false); }));
      if (source.sections.some(section => section.rows.some(row => O.mapped(row, state) === "НЕ ОК"))) {
        const shortcuts = el("div", "import-filter-shortcuts");
        shortcuts.append(button("Только НЕ ОК", "only-failed", () => { state.statuses = new Set(["НЕ ОК"]); changed(false); }), heading.lastElementChild);
        heading.append(shortcuts);
      }
      panel.append(heading);
      const counts = new Map();
      for (const section of source.sections) for (const row of section.rows) {
        const status = O.mapped(row, state); if (status) counts.set(status, (counts.get(status) || 0) + 1);
      }
      const filters = el("div", "import-status-filters");
      for (const status of O.statuses.filter(s => counts.has(s))) filters.append(check(`${status} · ${counts.get(status)}`, `status-${status}`, state.statuses.has(status), value => {
        if (value) state.statuses.add(status); else state.statuses.delete(status); changed(false);
      }, "import-status-chip"));
      panel.append(filters);
      const eligible = source.sections.flatMap(s => s.rows).filter(row => O.eligible(row, state));
      const tools = el("div", "import-row-tools");
      tools.append(el("span", "import-help", `По фильтру: ${eligible.length}`));
      for (const [title, selected] of [["Выбрать показанные", true], ["Снять выбор", false]]) tools.append(button(title, `select-${selected}`, () => {
        for (const row of eligible) if (selected) state.selectedRows.add(row.id); else state.selectedRows.delete(row.id); changed(false);
      }));
      panel.append(tools);
      let groups = 0;
      for (const section of source.sections) {
        const rows = section.rows.filter(row => O.eligible(row, state)); if (!rows.length) continue;
        const count = rows.filter(row => state.selectedRows.has(row.id)).length;
        const card = el("section", "import-section-card"), header = el("div", "import-section-heading");
        const toggle = check(section.title || "Раздел", `section-${section.id}`, count === rows.length, value => {
          for (const row of rows) if (value) state.selectedRows.add(row.id); else state.selectedRows.delete(row.id); changed(false);
        });
        toggle.querySelector("input").indeterminate = count > 0 && count < rows.length;
        header.append(toggle, el("span", "import-count", `${count} из ${rows.length}`)); card.append(header);
        card.append(disclosure(`rows-${section.id}`, "Выбрать отдельные пункты", body => {
          for (const row of rows) {
            const label = check("", `row-${row.id}`, state.selectedRows.has(row.id), value => {
              if (value) state.selectedRows.add(row.id); else state.selectedRows.delete(row.id); changed(false);
            }, "import-row-choice");
            const copy = label.lastElementChild; copy.className = "import-row-copy";
            const text = el("span", "import-row-title", nameOf(section, row)); text.title = nameOf(section, row);
            copy.append(el("span", "import-row-number", numbers.get(row.id)), text,
              el("small", "import-row-status", O.mapped(row, state) || `${O.sourceStatus(row)} · выберите статус`));
            body.append(label);
          }
        }, groups++ === 0)); panel.append(card);
      }
      if (!groups) panel.append(el("p", "import-empty", "Нет пунктов с выбранными статусами. Измените фильтр."));
    }
    function renderData(panel, result) {
      const numbering = check("", "preserve-numbers", preserve, value => { preserve = value; changed(false); }, "local-import-option");
      numbering.id = "importNumberingChoice"; numbering.querySelector("input").id = "importPreserveNumbers";
      numbering.hidden = !root.ChecklistNumbering.hasSourceNumbers(source) || (destination.mode !== "replace" && targetDocument.numberingMode !== "manual");
      numbering.lastElementChild.className = "import-option-copy";
      numbering.lastElementChild.append(el("strong", "", "Сохранить исходные номера"), el("small", "", destination.mode === "replace" ? "Включится ручная нумерация. Например, пункты 3, 8 и 14 сохранят свои номера после отбора." : "Исходные номера сохранятся только у добавляемых пунктов. Снимите флажок, чтобы оставить их пустыми."));
      panel.append(numbering);
      if (destination.mode !== "replace") panel.append(el("p", "import-help", targetDocument.numberingMode === "manual"
        ? "Ручная нумерация текущего чек-листа сохранится. Пункты без исходного номера получат пустой номер."
        : "Номера добавляемых пунктов рассчитываются по правилам текущего чек-листа. Итоговые номера видны в предпросмотре."));
      panel.append(field("Статусы после импорта", select("reset-statuses", "Статусы после импорта", [["keep", "Сохранить исходные"], ["reset", "Установить НЕ ПРОВЕРЕНО"]], state.resetStatuses ? "reset" : "keep", value => { state.resetStatuses = value === "reset"; changed(); }), "Фильтр пунктов всегда использует статусы из источника."));
      if (destination.mode === "replace" && plain(source.intro)) panel.append(check("Переносить описание отчёта", "keep-intro", state.keepIntro, value => { state.keepIntro = value; changed(); }));
      panel.append(el("p", "import-help", "Для каждого столбца выберите действие. «Оставить пустым» сохранит столбец для нового заполнения и уберёт его старые вложения."));
      if (state.preset === "retest" && ![...state.columns.values()].includes("clear")) panel.append(el("p", "import-help", "Столбец фактического результата не распознан. Выберите нужный столбец и действие «Оставить пустым»."));
      for (const section of source.sections) {
        const rows = result.sections.find(s => s.id === section.id)?.rows || []; if (!rows.length) continue;
        panel.append(disclosure(`data-${section.id}`, section.title || "Раздел", body => {
          for (const column of section.columns) {
            const columnKey = O.key(section.id, column.id), action = state.columns.get(columnKey), block = el("div", "import-data-column");
            block.append(field(column.title, select(`column-${column.id}`, `Действие для «${column.title}», ${section.title}`, options, action, value => {
              state.columns.set(columnKey, value);
              for (const row of section.rows) state.cells.delete(O.key(row.id, column.id));
              changed();
            })));
            if (action !== "omit") block.append(disclosure(`cells-${column.id}`, "Настроить по строкам", cells => {
              for (const row of rows) cells.append(field(shortName(section, section.rows.find(r => r.id === row.id)), select(`cell-${row.id}-${column.id}`, `Содержимое «${column.title}», пункт ${numbers.get(row.id)}`, [["", "Как для столбца"], ...options.slice(0, 2)], state.cells.get(O.key(row.id, column.id)) || "", value => {
                if (value) state.cells.set(O.key(row.id, column.id), value); else state.cells.delete(O.key(row.id, column.id)); changed();
              })));
            }));
            body.append(block);
          }
        }, true));
      }
    }
    function scopeField(title, scope, part, index) {
      const key = A.scopeKey(scope, part, index);
      return field(title, select(`file-mode-${key}`, `Вложения: ${title}`, [["", "Наследовать настройку"], ...fileOptions], policy.overrides.get(key) || "", value => {
        if (value) policy.overrides.set(key, value); else policy.overrides.delete(key); changed(false);
      }));
    }
    function renderFiles(panel, entries) {
      panel.append(check("Переносить изображения", "keep-images", policy.images, value => { policy.images = value; changed(false); }, "local-import-option"));
      panel.append(el("p", "import-help", "Если выключить, изображения и ссылки на них будут исключены, в том числе из вставленной разметки. Текст ячеек останется."));
      panel.append(field("Перенос вложений", select("file-mode", "Действие для вложений", fileOptions, policy.mode, value => { policy.mode = value; policy.overrides.clear(); changed(false); }), comment ? "Скачивание сохранит файлы в браузере. Ссылки оставят их в Jira." : "При вставке разметки файлы не скачиваются. Ссылки будут работать в Jira, если файлы есть в целевой задаче."));
      if (policy.overrides.size) panel.append(button("Сбросить исключения для вложений", "reset-files", () => { policy.overrides.clear(); changed(false); }));
      panel.append(el("p", "import-help", "Ниже — вложения только из выбранных пунктов и сохранённых ячеек. Настройка строки важнее настройки столбца; настройка файла важнее обеих."));
      if (!entries.length) { panel.append(el("p", "import-empty", "В выбранных данных нет вложений.")); return; }
      const groups = new Map();
      for (const part of entries) { if (!groups.has(part.sectionId)) groups.set(part.sectionId, []); groups.get(part.sectionId).push(part); }
      for (const [sectionId, parts] of groups) panel.append(disclosure(`files-${sectionId}`, `${parts[0].sectionTitle || "Раздел"} · ${parts.reduce((n, p) => n + p.items.length, 0)} влож.`, body => {
        body.append(scopeField("Весь раздел", "section", parts[0]));
        const columns = new Map();
        for (const part of parts) { if (!columns.has(part.columnId)) columns.set(part.columnId, []); columns.get(part.columnId).push(part); }
        for (const [columnId, cells] of columns) {
          body.append(scopeField(cells[0].title, "column", cells[0]));
          body.append(disclosure(`file-column-${sectionId}-${columnId}`, "Выбрать по строкам и файлам", list => {
            for (const part of cells) {
              const section = source.sections.find(s => s.id === part.sectionId), row = section?.rows.find(r => r.id === part.rowId);
              list.append(scopeField(row ? shortName(section, row) : "Описание", "row", part));
              for (const item of part.items) {
                const field = scopeField(item.name, "file", part, item.index); field.classList.add("import-file-setting");
                if (item.kind === "image" && !policy.images) {
                  field.querySelector("select").disabled = true; field.querySelector("select").dataset.unavailable = "true";
                  field.querySelector(".import-setting-copy").append(el("small", "", "Изображения исключены"));
                } else field.querySelector(".import-setting-copy").append(el("small", "", fileOptions.find(([mode]) => mode === item.mode)?.[1] + (comment && item.missing ? " · файл недоступен" : "")));
                list.append(field);
              }
            }
          }));
        }
      }));
    }
    function renderPreview(panel, result) {
      const prepared = A.removeExcluded(result, attachments, policy);
      let resultDocument = prepared, addedIds;
      if (destination.mode === "replace") root.ChecklistNumbering.configureImport(prepared, preserve, targetDocument.numberingMode);
      else {
        try {
          const plan = O.planAddition(targetDocument, prepared, placement());
          resultDocument = plan.document; addedIds = new Set(plan.rowIds);
        } catch (error) { panel.append(el("p", "import-validation", error.message)); return; }
      }
      const labels = root.ChecklistNumbering.rowNumbers(resultDocument);
      panel.append(el("p", "import-help", destinationText()));
      if (destination.mode !== "replace") panel.append(el("p", "import-help", "Показаны только добавляемые пункты с итоговыми столбцами и номерами."));
      if (destination.mode === "replace" && plain(prepared.intro)) panel.append(el("p", "", plain(prepared.intro)));
      for (const section of resultDocument.sections) {
        const visibleRows = root.QaReportTable ? root.QaReportTable.visibleRows(section) : section.rows;
        const rows = addedIds ? visibleRows.filter(row => addedIds.has(row.id)) : visibleRows;
        if (!rows.length) continue;
        panel.append(el("strong", "import-preview-title", section.title || "Раздел"));
        const scroll = el("div", "import-preview-scroll"), table = el("table", "import-result-table");
        const head = el("thead"), header = el("tr");
        for (const name of ["№", ...section.columns.map(c => c.title), "Статус"]) header.append(el("th", "", name));
        head.append(header); table.append(head);
        const body = el("tbody");
        for (const row of rows) {
          const line = el("tr"); line.append(el("td", "", labels.get(row.id)));
          for (const column of section.columns) line.append(el("td", "", plain(row.cells[column.id]) || "—"));
          line.append(el("td", "", row.status || "Не сопоставлен")); body.append(line);
        }
        table.append(body); scroll.append(table); panel.append(scroll);
      }
      panel.append(el("p", "import-help", "Текстовый предпросмотр. Форматирование и выбранные вложения сохранятся при импорте."));
    }
    function render() {
      const active = document.activeElement?.dataset.focus, scroll = container.closest(".import-body").scrollTop;
      const summary = O.summary(source, state);
      summary.result = selectedDocument();
      let plan, placementIssue = "";
      if (destination.mode !== "replace") {
        try { plan = O.planAddition(targetDocument, summary.result, placement()); }
        catch (error) { placementIssue = error.message; }
      }
      const entries = A.entries(summary.result, attachments, policy);
      const downloads = new Set(entries.flatMap(p => p.items.filter(i => i.mode === "download").map(i => i.key))).size;
      const omitted = entries.reduce((n, p) => n + p.items.filter(i => i.mode === "omit").length, 0);
      container.replaceChildren();
      renderDestination(container, summary.result, plan);
      container.append(field("Содержимое", select("content-preset", "Содержимое после импорта", [
        ["source", "Как в источнике"], ["retest", "Для повторного тестирования"],
        ...(state.preset === "custom" ? [["custom", "Свои настройки"]] : []),
      ], state.preset, value => {
        if (value === "custom") return;
        O.preset(source, state, value); preserve = root.ChecklistNumbering.hasSourceNumbers(source); changed(false);
      }), state.preset === "retest" ? "Фактический результат будет очищен, статусы — НЕ ПРОВЕРЕНО." : "Выберите пункты ниже. Столбцы и вложения можно настроить отдельно."));
      const tabs = el("div", "import-config-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Параметры импорта");
      const panels = [];
      for (const [value, title] of [["rows", "Пункты"], ["data", "Столбцы и данные"], ["files", "Вложения"]]) {
        const node = button(title, `tab-${value}`, () => { tab = value; render(); }, "import-config-tab");
        node.id = `importTab-${value}`; node.setAttribute("role", "tab"); node.setAttribute("aria-selected", String(tab === value));
        node.setAttribute("aria-controls", `importPanel-${value}`); node.tabIndex = tab === value ? 0 : -1;
        node.addEventListener("keydown", event => {
          const values = ["rows", "data", "files"], index = values.indexOf(value);
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); tab = event.key === "Home" ? "rows" : event.key === "End" ? "files" : values[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
          render(); container.querySelector(`[data-focus="tab-${tab}"]`).focus();
        }); tabs.append(node);
        const panel = el("div", "import-config-panel"); panel.id = `importPanel-${value}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", node.id); panel.hidden = tab !== value;
        if (value === "rows") renderRows(panel); else if (value === "data") renderData(panel, summary.result); else renderFiles(panel, entries);
        panels.push(panel);
      }
      container.append(tabs, ...panels);
      const status = el("div", "import-plan-summary"); status.setAttribute("role", "status");
      const detail = [destinationText(), ...(plan?.newColumns.length ? [`новых столбцов: ${plan.newColumns.length}`] : []), `Разделов в источнике: ${summary.result.sections.length}`, ...(state.resetStatuses ? ["статусы → НЕ ПРОВЕРЕНО"] : []),
        ...([...state.columns.values()].includes("clear") ? ["выбранные столбцы будут очищены"] : []),
        ...(downloads ? [`к скачиванию: ${downloads}`] : []), ...(omitted ? [`вложений исключено: ${omitted}`] : [])];
      status.append(el("strong", "", `Выбрано ${summary.count} из ${summary.total} пунктов`), el("small", "", detail.join(" · ")));
      container.append(status);
      const issue = placementIssue || (summary.unresolved ? "Сопоставьте неизвестные статусы на вкладке «Пункты»." : !summary.count ? "Выберите хотя бы один пункт для импорта." : summary.emptyColumns ? "В каждом выбранном разделе нужен хотя бы один содержательный столбец." : "");
      if (issue) container.append(el("p", "import-validation", issue));
      container.append(disclosure("preview", "Предпросмотр результата", body => renderPreview(body, summary.result)));
      setBusy(busy);
      if (active) [...container.querySelectorAll("[data-focus]")].find(node => node.dataset.focus === active)?.focus({ preventScroll: true });
      container.closest(".import-body").scrollTop = scroll;
      onChange({ ...summary, valid: !issue, issue, preserve, downloads, mode: destination.mode, destinationText: destinationText() });
    }
    function setBusy(value) {
      busy = value;
      for (const node of container.querySelectorAll("input, select, button")) node.disabled = busy || node.dataset.unavailable === "true";
      container.inert = busy;
    }
    render();
    return { getDocument: selectedDocument, getPolicy: () => policy, preserveNumbers: () => preserve, getPlacement: placement,
      refreshCurrent(document) { targetDocument = JSON.parse(JSON.stringify(document)); render(); }, setBusy };
  }
  root.QaReportImportWizard = { mount };
})(window);
