(function (root) {
  const statuses = ["НЕ ОК", "ТРЕБУЕТ УТОЧНЕНИЯ", "ПОЧТИ ОК", "ЧАСТИЧНО ПРОВЕРЕНО", "OK", "НЕ ПРОВЕРЕНО"];
  function visibleRows(section) {
    if (!section.statusSort) return section.rows;
    const rank = status => { const i = statuses.indexOf(status); return i < 0 ? statuses.length : i; };
    return section.rows.map((row, index) => ({ row, index }))
      .sort((a, b) => rank(a.row.status) - rank(b.row.status) || a.index - b.index).map(item => item.row);
  }
  function canMove(sections, ids, targetId) {
    return !sections.some(section => section.statusSort &&
      (section.id === targetId || section.rows.some(row => ids.has(row.id))));
  }
  const api = { visibleRows, canMove, statuses };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QaReportTable = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
