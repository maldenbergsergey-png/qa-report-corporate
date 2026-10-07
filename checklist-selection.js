(function (root) {
  const titleKey = (title) => String(title || "").trim().replace(/\s+/g, " ").toLowerCase();

  function selectByStatus(sections, statuses) {
    return new Set(sections.flatMap((section) => section.rows)
      .filter((row) => statuses.has(row.status)).map((row) => row.id));
  }

  // Match each column only once. Preserve unmatched fields as additional columns,
  // including attachments and rich HTML, instead of mapping unrelated positions.
  function transferRows(sections, selectedIds, targetId, createId, createRow, copying) {
    const target = sections.find((section) => section.id === targetId);
    if (!target) return 0;
    const transferred = [];
    for (const source of sections) {
      if (source === target && !copying) continue;
      const rows = source.rows.filter((row) => selectedIds.has(row.id));
      if (!rows.length) continue;
      const used = new Set();
      const mapping = source.columns.map((column) => {
        let destination = target.columns.find((item) => item.id === column.id && titleKey(item.title) === titleKey(column.title) && !used.has(item.id))
          || target.columns.find((item) => titleKey(item.title) === titleKey(column.title) && !used.has(item.id));
        if (!destination) {
          destination = { ...column, id: target.columns.some((item) => item.id === column.id) ? createId() : column.id };
          target.columns.push(destination);
          [...target.rows, ...transferred].forEach((row) => { row.cells[destination.id] = ""; });
        }
        used.add(destination.id);
        return [column.id, destination.id];
      });
      for (const row of rows) {
        const cells = Object.fromEntries(target.columns.map((column) => [column.id, ""]));
        mapping.forEach(([from, to]) => { cells[to] = row.cells[from] || ""; });
        transferred.push(copying
          ? { ...JSON.parse(JSON.stringify(row)), id: createId(), cells }
          : { ...row, cells });
      }
      if (!copying) {
        source.rows = source.rows.filter((row) => !selectedIds.has(row.id));
        if (!source.rows.length) source.rows.push(createRow(source.columns));
      }
    }
    target.rows.push(...transferred);
    if (transferred.length) target.collapsed = false;
    return transferred.length;
  }

  function moveRows(sections, selectedIds, targetId, createId, createRow) {
    return transferRows(sections, selectedIds, targetId, createId, createRow, false);
  }

  // Copying also supports the source section as a destination and always assigns fresh row IDs.
  function copyRows(sections, selectedIds, targetId, createId) {
    return transferRows(sections, selectedIds, targetId, createId, null, true);
  }

  // Copy whole selected sections or just their selected rows without sharing objects.
  function copySections(sections, selectedIds, createId, rowNumbers = null, sectionNumbers = null) {
    return sections.flatMap((section) => {
      const rows = section.rows.filter((row) => selectedIds.has(row.id));
      if (!rows.length) return [];
      const copy = JSON.parse(JSON.stringify({ ...section, rows }));
      if (sectionNumbers) copy.manualNumber = sectionNumbers.get(section.id) ?? "";
      copy.id = createId();
      copy.collapsed = false;
      copy.rows.forEach((row) => {
        if (rowNumbers) row.manualNumber = rowNumbers.get(row.id) ?? "";
        row.id = createId();
      });
      return [copy];
    });
  }

  // A row-only copy keeps every distinct field while giving the new section its own identity.
  function copySelection(sections, selectedIds, createId, options = {}) {
    const copies = copySections(sections, selectedIds, createId, options.rowNumbers, options.sectionNumbers);
    if (options.grouping !== "rows" || !copies.length) return copies;
    const target = { id: createId(), title: options.title || "Выбранные пункты", collapsed: false, columns: [], rows: [] };
    const ids = new Set(copies.flatMap(section => section.rows.map(row => row.id)));
    moveRows([...copies, target], ids, target.id, createId, columns => ({
      id: createId(), status: "НЕ ПРОВЕРЕНО", cells: Object.fromEntries(columns.map(column => [column.id, ""])),
    }));
    return [target];
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

  const api = { selectByStatus, moveRows, copyRows, copySections, copySelection, deleteRows };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QaReportSelection = api;
})(typeof window !== "undefined" ? window : globalThis);
