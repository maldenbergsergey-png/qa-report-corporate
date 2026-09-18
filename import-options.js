(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./jira-markup-import"));
  else root.QaReportImportOptions = factory(root.QaReportJiraImport);
})(typeof globalThis !== "undefined" ? globalThis : this, function (jira) {
  "use strict";
  const statuses = ["НЕ ОК", "ТРЕБУЕТ УТОЧНЕНИЯ", "ПОЧТИ ОК", "ЧАСТИЧНО ПРОВЕРЕНО", "OK", "НЕ ПРОВЕРЕНО"];
  const itemWord = count => count % 100 >= 11 && count % 100 <= 14 ? "пунктов" : count % 10 === 1 ? "пункт" : count % 10 >= 2 && count % 10 <= 4 ? "пункта" : "пунктов";
  const key = (...parts) => JSON.stringify(parts);
  const sourceStatus = row => jira.statusText(row.sourceStatus ?? row.status);
  function create(source) {
    const mapping = new Map(), selectedRows = new Set(), columns = new Map();
    for (const section of source.sections) {
      for (const column of section.columns) columns.set(key(section.id, column.id), "keep");
      for (const row of section.rows) {
        const raw = sourceStatus(row);
        if (!mapping.has(raw)) mapping.set(raw, jira.matchStatus(raw).certain ? jira.matchStatus(raw).status : "");
        selectedRows.add(row.id);
      }
    }
    return { mapping, selectedRows, columns, cells: new Map(), statuses: new Set(statuses), resetStatuses: false, keepIntro: true, preset: "source" };
  }
  function preset(source, state, name) {
    state.preset = name;
    state.resetStatuses = name === "retest";
    state.cells.clear();
    for (const section of source.sections) for (const column of section.columns) {
      const actual = /^(фр|факт|фактический результат|фактические результаты|actual|actual results?)$/i.test(column.title.trim());
      state.columns.set(key(section.id, column.id), name === "retest" && actual ? "clear" : "keep");
    }
  }
  const mapped = (row, state) => state.mapping.get(sourceStatus(row)) || "";
  const eligible = (row, state) => !mapped(row, state) || state.statuses.has(mapped(row, state));
  function build(source, state) {
    const result = JSON.parse(JSON.stringify(source));
    result.intro = state.keepIntro ? result.intro : "";
    if (state.resetStatuses) result.overallStatus = "НЕ ПРОВЕРЕНО";
    result.sections = result.sections.map(section => {
      delete section.headerlessRows;
      section.columns = section.columns.filter(column => state.columns.get(key(section.id, column.id)) !== "omit");
      section.rows = section.rows.filter(row => state.selectedRows.has(row.id) && eligible(row, state)).map(row => {
        row.status = state.resetStatuses ? "НЕ ПРОВЕРЕНО" : mapped(row, state);
        delete row.sourceStatus;
        row.cells = Object.fromEntries(section.columns.map(column => {
          const action = state.cells.get(key(row.id, column.id)) || state.columns.get(key(section.id, column.id));
          return [column.id, action === "clear" ? "" : row.cells[column.id] || ""];
        }));
        return row;
      });
      return section;
    }).filter(section => section.rows.length);
    return result;
  }
  function summary(source, state) {
    const result = build(source, state);
    return { result, total: source.sections.reduce((n, s) => n + s.rows.length, 0),
      count: result.sections.reduce((n, s) => n + s.rows.length, 0),
      unresolved: [...state.mapping.values()].filter(value => !value).length,
      emptyColumns: result.sections.some(section => !section.columns.length) };
  }
  const titleKey = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

  // Build the complete candidate without mutating either document. Preview and
  // commit use the same plan, including column mapping and final row order.
  function planAddition(current, source, placement, createId) {
    const document = JSON.parse(JSON.stringify(current));
    const incoming = JSON.parse(JSON.stringify(source.sections));
    const rowIds = [], sectionIds = [], mappings = [], newColumns = [];
    const usedIds = new Set(document.sections.flatMap(s => [s.id, ...s.columns.map(c => c.id), ...s.rows.map(r => r.id)]));
    let serial = 0;
    const freshId = () => {
      let id;
      do { id = createId ? createId() : `import-preview-${++serial}`; } while (usedIds.has(id));
      usedIds.add(id); return id;
    };
    const prepareRow = row => {
      row.id = freshId(); rowIds.push(row.id); delete row.sourceStatus;
      if (document.numberingMode !== "manual" || !placement.preserveNumbers) delete row.manualNumber;
      return row;
    };
    const duplicateTitles = incoming.filter(s => document.sections.some(existing => titleKey(existing.title) === titleKey(s.title)))
      .map(s => s.title || "Раздел");
    if (placement.mode === "sections") {
      let index = document.sections.length;
      if (placement.afterId === "start") index = 0;
      else if (placement.afterId) {
        index = document.sections.findIndex(s => s.id === placement.afterId);
        if (index < 0) throw new Error("Раздел для вставки больше не существует. Выберите место заново.");
        index++;
      }
      for (const section of incoming) {
        section.id = freshId(); sectionIds.push(section.id); section.collapsed = false;
        const columns = new Map(section.columns.map(c => [c.id, freshId()]));
        section.columns.forEach(c => { c.id = columns.get(c.id); });
        section.rows.forEach(row => {
          prepareRow(row);
          row.cells = Object.fromEntries([...columns].map(([from, to]) => [to, row.cells[from] || ""]));
        });
      }
      document.sections.splice(index, 0, ...incoming);
    } else if (placement.mode === "rows") {
      const target = document.sections.find(s => s.id === placement.targetId);
      if (!target) throw new Error("Выберите раздел, в который нужно добавить пункты.");
      sectionIds.push(target.id);
      const originalColumns = [...target.columns];
      for (const sourceSection of incoming) {
        const used = new Set();
        // Reserve explicit choices before matching the remaining columns by name.
        const reserved = new Set(sourceSection.columns.map(c => placement.columns?.get(key(sourceSection.id, c.id)))
          .filter(id => id && id !== "new"));
        const pairs = sourceSection.columns.map(column => {
          const choice = placement.columns?.get(key(sourceSection.id, column.id));
          let destination;
          if (choice && choice !== "new") {
            destination = target.columns.find(c => c.id === choice);
            if (!destination) throw new Error("Столбец назначения больше не существует. Настройте соответствие заново.");
            if (used.has(destination.id)) throw new Error(`В разделе «${sourceSection.title || "Раздел"}» несколько столбцов направлены в «${destination.title}». Выберите разные столбцы.`);
          } else if (choice !== "new") {
            destination = sourceSection.headerless ? originalColumns[column.sourcePosition]
              : target.columns.find(c => titleKey(c.title) === titleKey(column.title) && !used.has(c.id) && !reserved.has(c.id));
            if (destination && (used.has(destination.id) || reserved.has(destination.id))) destination = null;
          }
          if (!destination) {
            destination = { ...column, id: freshId() };
            target.columns.push(destination); newColumns.push(destination);
            target.rows.forEach(row => { row.cells[destination.id] = ""; });
          }
          used.add(destination.id);
          mappings.push({ sectionId: sourceSection.id, columnId: column.id, targetId: destination.id, title: destination.title });
          return [column.id, destination.id];
        });
        for (const row of sourceSection.rows) {
          prepareRow(row);
          const cells = Object.fromEntries(target.columns.map(c => [c.id, ""]));
          pairs.forEach(([from, to]) => { cells[to] = row.cells[from] || ""; });
          target.rows.push({ ...row, cells });
        }
      }
      target.collapsed = false;
    } else throw new Error("Выберите способ добавления пунктов.");
    return { document, rowIds, sectionIds, mappings, newColumns, duplicateTitles };
  }
  return { statuses, itemWord, key, sourceStatus, create, preset, mapped, eligible, build, summary, planAddition };
});
