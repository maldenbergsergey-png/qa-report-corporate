(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportExclusions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const PAGE_SIZE = 30;
  const key = row => JSON.stringify([row.sectionId, row.rowId]);
  const searchKey = value => String(value || "").normalize("NFC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const selectedSet = rows => new Set((Array.isArray(rows) ? rows : []).filter(row => typeof row?.sectionId === "string" && typeof row.rowId === "string").map(key));
  function indexRows(sections) {
    return sections.flatMap(section => section.rows.map(row => ({ ...row, sectionId: section.id, sectionTitle: section.title,
      search: searchKey([section.title, row.number, row.title, row.content, ...(row.tags || [])].join(" ")),
    })));
  }
  function matchingRows(rows, selected, { query = "", sectionId = "", excludedOnly = false } = {}) {
    const terms = searchKey(query).split(" ").filter(Boolean);
    return rows.filter(row => (!sectionId || row.sectionId === sectionId) && (!excludedOnly || selected.has(key(row))) && terms.every(term => row.search.includes(term)));
  }
  function pageRows(rows, page = 0) {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), current = Math.max(0, Math.min(Math.floor(Number(page) || 0), pages - 1));
    return { rows: rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE), page: current, pages,
      start: rows.length ? current * PAGE_SIZE + 1 : 0, end: Math.min((current + 1) * PAGE_SIZE, rows.length), total: rows.length };
  }
  function setRows(selected, rows, excluded) {
    const next = new Set(selected);
    for (const row of rows) excluded ? next.add(key(row)) : next.delete(key(row));
    return next;
  }
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  function button(text, cls, action) {
    const el = node("button", cls, text); el.type = "button"; el.addEventListener("click", action); return el;
  }
  function create({ getSource, selected = [], onApply, notify = () => {}, returnFocus }) {
    let saved = selectedSet(selected), pending = new Set(saved), rows = [], sections = [], page = 0, excludedOnly = false, loading = false, generation = 0;
    const dialog = node("dialog", "exclusion-picker"); dialog.id = "shareExclusionPicker";
    dialog.setAttribute("aria-labelledby", "exclusionPickerTitle"); dialog.setAttribute("aria-describedby", "exclusionPickerHint");
    const heading = node("header", "exclusion-picker-heading"), title = node("h2", "", "Исключить пункты"); title.id = "exclusionPickerTitle";
    const close = button("×", "exclusion-picker-close", () => dismiss()); close.setAttribute("aria-label", "Закрыть выбор пунктов"); heading.append(title, close);
    const controls = node("div", "exclusion-picker-controls"), hint = node("p", "exclusion-picker-hint", "Отмеченные пункты не попадут в отчёт по ссылке. Исходный чек-лист сохранится."); hint.id = "exclusionPickerHint";
    const search = node("input", "exclusion-picker-search"); search.id = "shareReportExclusionSearch"; search.type = "search"; search.placeholder = "Поиск по названию, номеру, содержимому или метке"; search.setAttribute("aria-label", "Найти пункт или раздел");
    const filters = node("div", "exclusion-picker-filters"), section = node("select", "exclusion-picker-section"); section.setAttribute("aria-label", "Раздел чек-листа");
    const modes = node("div", "exclusion-picker-modes"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Показывать пункты");
    const all = button("Все пункты", "", () => { excludedOnly = false; page = 0; render(); });
    const only = button("Исключённые", "", () => { excludedOnly = true; page = 0; render(); }); modes.append(all, only); filters.append(section, modes);
    const bulk = node("div", "exclusion-picker-bulk"), found = node("span", "exclusion-picker-count"); found.setAttribute("role", "status");
    const excludeFound = button("Исключить найденные", "exclusion-picker-text-button", () => { pending = setRows(pending, matches(), true); render(); });
    const restoreFound = button("Вернуть найденные", "exclusion-picker-text-button", () => { pending = setRows(pending, matches(), false); render(); });
    bulk.append(found, excludeFound, restoreFound); controls.append(hint, search, filters, bulk);
    const list = node("div", "exclusion-picker-list"); list.id = "shareReportExclusionList"; list.setAttribute("role", "group"); list.setAttribute("aria-label", "Пункты для исключения");
    const footer = node("footer", "exclusion-picker-footer"), summary = node("span", "exclusion-picker-total"); summary.setAttribute("role", "status");
    const pager = node("div", "exclusion-picker-pager");
    const previous = button("←", "", () => { page--; render(); list.scrollTop = 0; }); previous.setAttribute("aria-label", "Предыдущая страница пунктов");
    const pageLabel = node("span", ""), next = button("→", "", () => { page++; render(); list.scrollTop = 0; }); next.setAttribute("aria-label", "Следующая страница пунктов"); pager.append(previous, pageLabel, next);
    const actions = node("div", "exclusion-picker-actions"), cancel = button("Отмена", "button button-secondary", () => dismiss());
    const apply = button("Применить", "button button-primary", () => {
      const result = rows.filter(row => pending.has(key(row))).map(({ sectionId, rowId }) => ({ sectionId, rowId }));
      if (onApply(result) === false) return;
      saved = selectedSet(result); dismiss();
    }); apply.id = "applyShareExclusions";
    actions.append(cancel, apply); footer.append(summary, pager, actions); dialog.append(heading, controls, list, footer); document.body.append(dialog);
    function matches() { return matchingRows(rows, pending, { query: search.value, sectionId: section.value, excludedOnly }); }
    function render() {
      const matching = matches(), result = pageRows(matching, page); page = result.page;
      all.setAttribute("aria-pressed", String(!excludedOnly)); only.setAttribute("aria-pressed", String(excludedOnly)); only.textContent = `Исключённые${pending.size ? ` · ${pending.size}` : ""}`;
      found.textContent = loading ? "Загружаем пункты…" : `Найдено: ${matching.length}`;
      excludeFound.disabled = loading || !matching.some(row => !pending.has(key(row)));
      restoreFound.disabled = loading || !matching.some(row => pending.has(key(row)));
      summary.textContent = loading ? "Подготавливаем список" : `Исключено: ${pending.size} из ${rows.length}`;
      previous.disabled = loading || page === 0; next.disabled = loading || page >= result.pages - 1;
      pageLabel.textContent = `${result.start}–${result.end} из ${result.total}`; pager.hidden = result.total <= PAGE_SIZE;
      apply.disabled = loading; search.disabled = loading; section.disabled = loading; all.disabled = loading; only.disabled = loading;
      list.replaceChildren();
      if (loading || !matching.length) {
        const empty = node("div", "exclusion-picker-empty"); empty.append(node("strong", "", loading ? "Загружаем пункты…" : excludedOnly && !search.value && !section.value ? "Исключённых пунктов пока нет" : "Пункты не найдены"));
        if (!loading) empty.append(node("p", "", "Измените поиск, раздел или режим просмотра.")); list.append(empty); return;
      }
      const grouped = new Map();
      for (const row of matching) { if (!grouped.has(row.sectionId)) grouped.set(row.sectionId, []); grouped.get(row.sectionId).push(row); }
      let currentGroup;
      for (const row of result.rows) {
        if (currentGroup?.dataset.sectionId !== row.sectionId) {
          currentGroup = node("section", "exclusion-picker-group"); currentGroup.dataset.sectionId = row.sectionId;
          const groupRows = grouped.get(row.sectionId), count = groupRows.filter(item => pending.has(key(item))).length;
          const header = node("div", "exclusion-picker-group-heading"), label = node("label", ""), toggle = node("input"); toggle.type = "checkbox";
          toggle.checked = count === groupRows.length; toggle.indeterminate = count > 0 && count < groupRows.length;
          toggle.setAttribute("aria-label", `${search.value || excludedOnly ? "Исключить найденные в разделе" : "Исключить весь раздел"} «${row.sectionTitle}», ${groupRows.length} пунктов`);
          toggle.addEventListener("change", () => { const focus = toggle.getAttribute("aria-label"); pending = setRows(pending, groupRows, toggle.checked); render();
            [...list.querySelectorAll(".exclusion-picker-group-heading input")].find(input => input.getAttribute("aria-label") === focus)?.focus({ preventScroll: true }); });
          label.append(toggle, node("span", "", row.sectionTitle)); header.append(label, node("span", "exclusion-picker-group-count", `${count} / ${groupRows.length}`)); currentGroup.append(header); list.append(currentGroup);
        }
        const label = node("label", "exclusion-picker-row"), checkbox = node("input"); checkbox.type = "checkbox";
        checkbox.dataset.sectionId = row.sectionId; checkbox.dataset.rowId = row.rowId; checkbox.checked = pending.has(key(row));
        checkbox.setAttribute("aria-label", `${row.sectionTitle} · пункт ${row.number}: ${row.title}`);
        checkbox.addEventListener("change", () => { const scroll = list.scrollTop; checkbox.checked ? pending.add(key(row)) : pending.delete(key(row)); render(); list.scrollTop = scroll;
          const next = [...list.querySelectorAll("input[data-row-id]")].find(input => input.dataset.rowId === row.rowId && input.dataset.sectionId === row.sectionId);
          (next || list.querySelector("input") || search).focus({ preventScroll: true }); });
        const copy = node("span", "exclusion-picker-row-copy"), primary = node("span", "exclusion-picker-row-title", row.title); primary.title = row.content || row.title;
        const meta = node("span", "exclusion-picker-row-meta"); meta.append(node("span", "exclusion-picker-number", row.number), node("span", "exclusion-picker-status", row.status));
        if (row.tags?.length) globalThis.QaReportTags?.view(meta, row.tags);
        copy.append(primary, meta);
        const query = searchKey(search.value);
        if (query && !searchKey(row.title).includes(query) && searchKey(row.content).includes(query)) {
          const offset = searchKey(row.content).indexOf(query), snippet = row.content.slice(Math.max(0, offset - 35), offset + query.length + 85);
          copy.append(node("span", "exclusion-picker-snippet", (offset > 35 ? "…" : "") + snippet));
        }
        label.append(checkbox, copy); label.classList.toggle("is-excluded", checkbox.checked); currentGroup.append(label);
      }
    }
    search.addEventListener("input", () => { page = 0; render(); list.scrollTop = 0; });
    section.addEventListener("change", () => { page = 0; render(); list.scrollTop = 0; });
    dialog.addEventListener("keydown", event => { event.stopPropagation(); });
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("click", event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss(); } });
    function dismiss() { generation++; if (dialog.open) dialog.close(); returnFocus?.focus({ preventScroll: true }); }
    async function open() {
      if (dialog.open) return;
      const current = ++generation; pending = new Set(saved); rows = []; sections = []; page = 0; excludedOnly = false; search.value = ""; section.replaceChildren(); loading = true;
      dialog.showModal(); render();
      try {
        const source = await getSource(() => current !== generation);
        if (current !== generation) return;
        sections = source; rows = indexRows(sections);
        const valid = new Set(rows.map(key)); pending = new Set([...pending].filter(value => valid.has(value)));
        const first = node("option", "", "Все разделы"); first.value = ""; section.append(first);
        for (const item of sections) { const option = node("option", "", `${item.title} · ${item.rows.length}`); option.value = item.id; section.append(option); }
        loading = false; render(); search.focus({ preventScroll: true });
      } catch (error) { if (current === generation) { dismiss(); notify(error.message || "Не удалось открыть выбор пунктов"); } }
    }
    return { open, selected: () => [...saved].map(value => { const [sectionId, rowId] = JSON.parse(value); return { sectionId, rowId }; }),
      clear() { saved.clear(); }, destroy() { generation++; if (dialog.open) dialog.close(); dialog.remove(); } };
  }
  return { PAGE_SIZE, key, searchKey, selectedSet, indexRows, matchingRows, pageRows, setRows, create };
});
