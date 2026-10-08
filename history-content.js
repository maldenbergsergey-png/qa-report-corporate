// Shared by the editor, metadata worker and server. This fingerprint detects
// content changes only; it is not used for security or sync conflict checks.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QaReportHistory = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  function contentFingerprint(document) {
    const content = { ...document };
    for (const field of ["revision", "updatedAt", "lastSavedBy", "lastSavedClientId",
      "tabId", "clientId", "browserId", "selectedCell", "focus", "scroll", "syncTimestamps",
      "reportId", "draftId", "publicId", "schemaVersion"]) delete content[field];
    // Rendering supplies these defaults to older documents without a user edit.
    content.numberingMode = ["section", "continuous", "hierarchical", "manual"].includes(content.numberingMode) ? content.numberingMode : "section";
    content.sectionNumberingMode = content.sectionNumberingMode === "manual" ? "manual" : "automatic";
    content.issueUrl = content.issueUrl || "";
    if (Array.isArray(content.sections)) content.sections = content.sections.map((section, index) => ({
      ...section,
      title: String(section.title || "").trim() || `Раздел ${index + 1}`,
      collapsed: Boolean(section.collapsed),
      columns: section.columns?.map((column, index) => ({ ...column,
        title: String(column.title || column.name || "").trim() || `Столбец ${index + 1}`,
        width: Math.max(140, Number(column.width) || 240),
      })),
    }));
    const serialized = JSON.stringify(content, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
    let first = 2166136261, second = 5381;
    for (let index = 0; index < serialized.length; index++) {
      const code = serialized.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second, 33) ^ code;
    }
    return `1:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}:${serialized.length}`;
  }
  return { contentFingerprint };
});
