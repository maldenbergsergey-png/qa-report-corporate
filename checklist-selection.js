(function (root) {
  const titleKey = (title) => String(title || "").trim().replace(/\s+/g, " ").toLowerCase();

  function selectByStatus(sections, statuses) {
    return new Set(sections.flatMap((section) => section.rows)
      .filter((row) => statuses.has(row.status)).map((row) => row.id));
  }

  // Match each column only once. Preserve unmatched fields as additional columns,
  // including attachments and rich HTML, instead of mapping unrelated positions.
  function moveRows(sections, selectedIds, targetId, createId, createRow) {
    const target = sections.find((section) => section.id === targetId);
    if (!target) return 0;
    const moved = [];
    for (const source of sections) {
      if (source === target) continue;
      const rows = source.rows.filter((row) => selectedIds.has(row.id));
      if (!rows.length) continue;
      const used = new Set();
      const mapping = source.columns.map((column) => {
        let destination = target.columns.find((item) => item.id === column.id && titleKey(item.title) === titleKey(column.title) && !used.has(item.id))
          || target.columns.find((item) => titleKey(item.title) === titleKey(column.title) && !used.has(item.id));
        if (!destination) {
          destination = { ...column, id: target.columns.some((item) => item.id === column.id) ? createId() : column.id };
          target.columns.push(destination);
          [...target.rows, ...moved].forEach((row) => { row.cells[destination.id] = ""; });
        }
        used.add(destination.id);
        return [column.id, destination.id];
      });
      for (const row of rows) {
        const cells = Object.fromEntries(target.columns.map((column) => [column.id, ""]));
        mapping.forEach(([from, to]) => { cells[to] = row.cells[from] || ""; });
        moved.push({ ...row, cells });
      }
      source.rows = source.rows.filter((row) => !selectedIds.has(row.id));
      if (!source.rows.length) source.rows.push(createRow(source.columns));
    }
    target.rows.push(...moved);
    if (moved.length) target.collapsed = false;
    return moved.length;
  }

  function deleteRows(sections, selectedIds, createRow, createDefaultSection) {
    const count = sections.reduce((sum, section) => sum + section.rows.filter((row) => selectedIds.has(row.id)).length, 0);
    if (!count) return { sections, count };
    const remaining = sections.map((section) => ({ ...section, rows: section.rows.filter((row) => !selectedIds.has(row.id)) }));
    if (!remaining.some((section) => section.rows.length)) {
      return { sections: [createDefaultSection()], count };
    }
    remaining.forEach((section) => {
      if (!section.rows.length) section.rows.push(createRow(section.columns));
    });
    return { sections: remaining, count };
  }

  const api = { selectByStatus, moveRows, deleteRows };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportSelection = api;
})(typeof window !== "undefined" ? window : globalThis);
