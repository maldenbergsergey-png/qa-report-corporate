(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportTags = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const decode = value => String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
    if (code[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[code.toLowerCase()] || match;
    const n = parseInt(code.slice(code[1].toLowerCase() === "x" ? 2 : 1), code[1].toLowerCase() === "x" ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
  const name = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").normalize("NFC").slice(0, 160);
  const key = value => name(value).toLowerCase();
  function unique(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(name).filter(value => value && !seen.has(key(value)) && seen.add(key(value))).slice(0, 100);
  }
  function tone(value) {
    let hash = 0;
    for (const char of key(value)) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
    return hash % 6;
  }
  function read(value) {
    const html = String(value || "");
    const encoded = [...html.matchAll(/\bdata-qa-tag="([^"]*)"/g)].map(match => decode(match[1]));
    if (encoded.length) return unique(encoded);
    return unique(decode(html.replace(/<(?:br\b[^>]*|\/p|\/div)>/gi, "\n").replace(/<[^>]*>/g, "")).split(/\r?\n/));
  }
  function wiki(value) {
    return name(value).replace(/\\/g, "&#92;").replace(/([!{}\[\]|*_+\-^~])/g, "\\$1");
  }
  function html(values, portable = false) {
    return unique(values).map(value => `<span class="qa-tag" data-qa-tag="${escape(value)}" data-tone="${tone(value)}"${portable ? ` style="display:inline-block;padding:2px 8px;border-radius:6px;background:#edf2fa;color:#253858;font-size:12px"` : ""}>${escape(value)}</span>`).join("<br>");
  }
  const isColumn = column => column?.type === "tags";
  const isTitle = title => /^(метки|теги|tags|labels)$/i.test(String(title || "").trim());
  function rowNames(row) {
    return unique(Object.values(row?.cells || {}).flatMap(value => /\bdata-qa-tag=|\bclass=["'][^"']*\bqa-tag\b/.test(String(value)) ? read(value) : []));
  }
  function allNames(source) {
    const sections = Array.isArray(source) ? source : source?.sections || [];
    return unique(sections.flatMap(section => section.rows.flatMap(rowNames))).sort((a, b) => a.localeCompare(b, "ru"));
  }
  function scope(value = {}) {
    return { include: unique(value?.include), exclude: unique(value?.exclude), untagged: value?.untagged !== false, showTags: value?.showTags !== false };
  }
  function active(value) {
    const v = scope(value);
    return Boolean(v.include.length || v.exclude.length || !v.untagged);
  }
  function matches(row, value) {
    const v = scope(value), tags = new Set(rowNames(row).map(key));
    if (!tags.size) return v.untagged;
    return !v.exclude.some(tag => tags.has(key(tag))) && (!v.include.length || v.include.some(tag => tags.has(key(tag))));
  }
  function filter(sections, value) {
    const v = scope(value);
    return sections.map(section => ({ ...section,
      columns: section.columns.filter(column => v.showTags || !isColumn(column)),
      rows: section.rows.filter(row => matches(row, v)),
    })).filter(section => section.rows.length);
  }
  function normalizeSections(sections) {
    for (const section of sections || []) for (const column of section.columns || []) {
      if (!isColumn(column)) continue;
      for (const row of section.rows || []) row.cells[column.id] = html(read(row.cells[column.id]));
    }
    return sections;
  }
  function view(target, values) {
    const container = document.createElement("div"); container.className = "qa-tags";
    for (const value of unique(values)) {
      const chip = document.createElement("span"); chip.className = "qa-tag"; chip.dataset.tone = tone(value);
      chip.textContent = value; container.append(chip);
    }
    target.append(container);
    return container;
  }
  const recentKey = "qa-report-recent-tags-v1";
  function recent() {
    try { return unique(JSON.parse(localStorage.getItem(recentKey) || "[]")).slice(0, 20); } catch { return []; }
  }
  function remember(values) {
    try { localStorage.setItem(recentKey, JSON.stringify(unique([...values, ...recent()]).slice(0, 20))); } catch {}
  }
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  function button(text, cls, action) {
    const el = node("button", cls, text); el.type = "button"; el.addEventListener("click", action); return el;
  }
  function picker(anchor, { values = [], source, change, bulk = false, close = () => {} }) {
    document.querySelectorAll(".qa-tags-picker").forEach(el => el.hidePopover());
    let selected = unique(values);
    const panel = node("div", "qa-tags-picker"); panel.popover = "auto"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", bulk ? "Метки выбранных пунктов" : "Метки пункта");
    const heading = node("div", "qa-tags-heading"); heading.append(node("strong", "", "Метки"), button("×", "qa-tags-close", () => panel.hidePopover()));
    heading.lastChild.setAttribute("aria-label", "Закрыть метки");
    const search = node("input", "qa-tags-search"); search.placeholder = "Найти или создать метку"; search.maxLength = 160; search.setAttribute("aria-label", "Название метки или поиск");
    const chosen = node("div", "qa-tags-chosen"), list = node("div", "qa-tags-options");
    const commit = () => { remember(selected); if (!bulk) change([...selected], "set"); };
    function paint() {
      chosen.replaceChildren();
      for (const value of selected) {
        const chip = button(value + " ×", "qa-tag qa-tag-remove", () => { selected = selected.filter(item => key(item) !== key(value)); commit(); paint(); search.focus(); });
        chip.dataset.tone = tone(value); chip.setAttribute("aria-label", `Снять метку «${value}»`); chosen.append(chip);
      }
      chosen.hidden = !selected.length; list.replaceChildren();
      const query = name(search.value), available = unique([...selected, ...allNames(source), ...recent()]);
      const add = value => { selected = unique([...selected, value]); search.value = ""; commit(); paint(); search.focus(); };
      if (query && !available.some(value => key(value) === key(query)) && !selected.some(value => key(value) === key(query))) {
        const create = button("", "qa-tag-option qa-tag-create", () => add(query));
        create.setAttribute("aria-label", `Создать метку «${query}»`);
        view(create, [query]); create.append(node("span", "qa-tag-create-action", "Создать"));
        list.append(create);
      }
      for (const value of available.filter(value => key(value).includes(key(query)))) {
        const alreadySelected = selected.some(item => key(item) === key(value));
        if (alreadySelected && !query) continue;
        if (alreadySelected) {
          const option = node("div", "qa-tag-option qa-tag-selected"); option.setAttribute("role", "status");
          view(option, [value]); option.append(node("span", "qa-tag-create-action", "Уже добавлена")); list.append(option);
        } else {
          const option = button("", "qa-tag-option", () => add(value)); view(option, [value]); list.append(option);
        }
      }
      const createOption = list.querySelector(".qa-tag-create"); if (createOption) list.append(createOption);
      list.hidden = !list.children.length;
    }
    search.addEventListener("input", paint);
    search.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing && name(search.value)) {
        event.preventDefault();
        const query = name(search.value), available = unique([...selected, ...allNames(source), ...recent()]);
        const exact = available.find(value => key(value) === key(query));
        const existing = exact || available.find(value => key(value).includes(key(query)) && !selected.some(item => key(item) === key(value))) || available.find(value => key(value).includes(key(query)));
        if (existing && selected.some(value => key(value) === key(existing))) { paint(); return; }
        selected = unique([...selected, existing || query]); search.value = ""; commit(); paint();
      }
    });
    panel.append(heading, search, chosen, list);
    if (bulk) {
      const actions = node("div", "qa-tags-actions");
      actions.append(button("Снять метки", "button button-secondary", () => { if (selected.length) { change(selected, "remove"); panel.hidePopover(); } }),
        button("Добавить метки", "button button-primary", () => { if (selected.length) { remember(selected); change(selected, "add"); panel.hidePopover(); } }));
      panel.append(actions);
    }
    document.body.append(panel); paint();
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - Math.min(320, innerWidth - 24) - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - Math.min(460, innerHeight - 24) - 12))}px`;
    panel.addEventListener("toggle", event => { if (event.newState === "closed") { panel.remove(); close(); if (anchor.isConnected) anchor.focus({ preventScroll: true }); } });
    panel.showPopover();
    const height = panel.getBoundingClientRect().height;
    panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - height - 12))}px`;
    search.focus();
    return panel;
  }
  function cell(value, source, change, closed) {
    let values = read(value);
    const control = button("", "qa-tags-cell", () => picker(control, { values, source, change(next) { values = next; paint(); change(next); }, close: closed }));
    control.setAttribute("aria-label", "Изменить метки пункта"); control.setAttribute("aria-haspopup", "dialog");
    function paint() {
      control.replaceChildren();
      if (values.length) view(control, values);
      else control.append(node("span", "qa-tags-placeholder", "+ Добавить метки"));
    }
    paint(); return control;
  }
  function createFilter(source, initial, changed, { display = true, title = "Метки" } = {}) {
    let current = scope(initial);
    const details = node("details", "qa-tags-filter"), summary = node("summary", ""), body = node("div", "qa-tags-filter-body");
    const choices = unique([...allNames(source), ...current.include, ...current.exclude]);
    details.append(summary, body);
    const refreshSummary = () => { const count = current.include.length + current.exclude.length; summary.textContent = title + (count ? ` · ${count}` : " · все"); details.classList.toggle("qa-tags-filter-active", active(current)); };
    const emit = () => { refreshSummary(); changed(scope(current)); };
    body.append(node("p", "qa-tags-hint", "Включить — любая выбранная метка. Исключить — убрать весь пункт; исключение важнее включения."));
    const list = node("div", "qa-tags-filter-list");
    for (const value of choices) {
      const row = node("div", "qa-tags-filter-row"); view(row, [value]);
      const modes = node("div", "qa-tags-modes"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", `Отбор по метке «${value}»`);
      const paintModes = () => { for (const control of modes.children) control.setAttribute("aria-pressed", String(control.dataset.mode === (current.exclude.some(x => key(x) === key(value)) ? "exclude" : current.include.some(x => key(x) === key(value)) ? "include" : "all"))); };
      for (const [mode, caption] of [["all", "Все"], ["include", "Включить"], ["exclude", "Исключить"]]) {
        const control = button(caption, "", () => {
          const hadIncludes = current.include.length > 0;
          current.include = current.include.filter(x => key(x) !== key(value)); current.exclude = current.exclude.filter(x => key(x) !== key(value));
          if (mode !== "all") current[mode].push(value);
          if (!hadIncludes && current.include.length) { current.untagged = false; untagged.checked = false; }
          paintModes(); emit();
        });
        control.dataset.mode = mode; control.dataset.focus = `tag-${key(value)}-${mode}`; control.setAttribute("aria-label", `${caption}: ${value}`); modes.append(control);
      }
      paintModes(); row.append(modes); list.append(row);
    }
    body.append(list);
    if (!choices.length) body.append(node("p", "qa-tags-hint", "В источнике пока нет меток. Их можно добавить в столбце «Метки»."));
    function check(caption, field) {
      const label = node("label", "qa-tags-check"), input = node("input"); input.type = "checkbox"; input.checked = current[field]; input.dataset.focus = `tags-${field}`;
      input.addEventListener("change", () => { current[field] = input.checked; emit(); }); label.append(input, node("span", "", caption)); body.append(label); return input;
    }
    const untagged = check("Включать пункты без меток", "untagged");
    if (display) check("Показывать столбец меток", "showTags");
    body.append(button("Сбросить отбор", "qa-tags-reset", () => {
      current = scope({ showTags: current.showTags });
      const replacement = createFilter(source, current, changed, { display, title }); replacement.open = true; details.replaceWith(replacement); changed(scope(current));
    }));
    refreshSummary(); return details;
  }
  // Publication controls expose both sets without making users cycle through states.
  function createPublicationFilter(source, initial, changed) {
    let current = scope(initial), mode = "include";
    const choices = unique([...allNames(source), ...current.include, ...current.exclude]);
    const root = node("section", "qa-tags-publication"); root.setAttribute("aria-label", "Отбор пунктов по меткам");
    const icon = id => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("ui-icon"); svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", `#icon-${id}`); svg.append(use); return svg;
    };
    const heading = node("div", "qa-tags-publication-heading"), title = node("h3", "", "Метки пунктов");
    const reset = button("Сбросить", "qa-tags-reset", () => { current = scope({ showTags: current.showTags }); emit(); });
    heading.append(icon("tag"), title, reset); root.append(heading);
    const modes = node("div", "qa-tags-publication-modes"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Действие с выбранными метками");
    const modeButtons = new Map();
    for (const [value, caption] of [["include", "Включить"], ["exclude", "Исключить"]]) {
      const control = button("", "", () => { mode = value; paint(); }); control.setAttribute("aria-label", `${caption} метки`);
      const count = node("span", "qa-tags-mode-count"); control.append(node("span", "", caption), count); modes.append(control); modeButtons.set(value, { control, count });
    }
    root.append(modes);
    const hint = node("p", "qa-tags-hint"); root.append(hint);
    const search = node("input", "qa-tags-search qa-tags-publication-search"); search.placeholder = "Найти метку"; search.setAttribute("aria-label", "Найти метку для публикации");
    search.hidden = choices.length <= 8; search.addEventListener("input", paint); root.append(search);
    const list = node("div", "qa-tags-publication-choices"); list.setAttribute("role", "group"); root.append(list);
    const controls = new Map();
    for (const value of choices) {
      const control = button("", "qa-tag qa-tag-choice", () => {
        const hadIncludes = current.include.length > 0, selected = current[mode].some(item => key(item) === key(value));
        current.include = current.include.filter(item => key(item) !== key(value));
        current.exclude = current.exclude.filter(item => key(item) !== key(value));
        if (!selected) current[mode].push(value);
        if (!hadIncludes && current.include.length) current.untagged = false;
        emit();
      });
      control.dataset.tone = tone(value);
      const marker = icon("check"); marker.classList.add("qa-tag-choice-mark");
      control.append(node("span", "", value), marker); list.append(control); controls.set(value, { control, marker });
    }
    const empty = node("p", "qa-tags-hint"); root.append(empty);
    const options = node("div", "qa-tags-publication-options"); root.append(options);
    function check(caption, field) {
      const label = node("label", "qa-tags-check"), input = node("input"); input.type = "checkbox";
      input.addEventListener("change", () => { current[field] = input.checked; emit(); }); label.append(input, node("span", "", caption)); options.append(label); return input;
    }
    const untagged = check("Включать пункты без меток", "untagged"), showTags = check("Показывать метки получателю", "showTags");
    function paint() {
      for (const [value, { control, count }] of modeButtons) {
        control.setAttribute("aria-pressed", String(mode === value)); count.textContent = current[value].length || ""; count.hidden = !current[value].length;
      }
      hint.textContent = mode === "include" ? "Выберите любые метки. Без выбора — все метки." : "Пункты с выбранными метками будут исключены целиком.";
      list.setAttribute("aria-label", mode === "include" ? "Метки для включения" : "Метки для исключения");
      let visible = 0;
      for (const [value, { control, marker }] of controls) {
        const selection = current.exclude.some(item => key(item) === key(value)) ? "exclude" : current.include.some(item => key(item) === key(value)) ? "include" : "none";
        control.dataset.selection = selection; control.setAttribute("aria-pressed", String(selection === mode));
        control.setAttribute("aria-label", `${mode === "include" ? "Включить" : "Исключить"}: ${value}`);
        control.title = selection === "exclude" ? "Исключена из публикации" : selection === "include" ? "Включена в публикацию" : "Без ограничения";
        marker.toggleAttribute("hidden", selection === "none"); marker.querySelector("use").setAttribute("href", `#icon-${selection === "exclude" ? "x" : "check"}`);
        control.hidden = !key(value).includes(key(search.value)); if (!control.hidden) visible++;
      }
      empty.hidden = visible > 0; empty.textContent = choices.length ? "Метки не найдены" : "В чек-листе пока нет меток.";
      untagged.checked = current.untagged; showTags.checked = current.showTags; reset.disabled = !active(current);
    }
    function emit() { paint(); changed(scope(current)); }
    const priority = node("p", "qa-tags-hint qa-tags-priority", "Исключение имеет приоритет, если у пункта несколько меток."); root.append(priority);
    paint(); return root;
  }
  return { name, key, unique, tone, read, wiki, html, isColumn, isTitle, rowNames, allNames, scope, active, matches, filter, normalizeSections, view, cell, picker, createFilter, createPublicationFilter, editorScope: scope() };
});
