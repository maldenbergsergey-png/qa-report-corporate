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
  return { statuses, itemWord, key, sourceStatus, create, preset, mapped, eligible, build, summary };
});
