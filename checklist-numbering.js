(function (root) {
  function normalizeMode(mode) {
    return ["section", "continuous", "hierarchical"].includes(mode) ? mode : "section";
  }

  // Number the whole document before filtering for preview or partial publication.
  // Stable row IDs keep the same labels everywhere, including around empty rows.
  function rowNumbers(document) {
    const mode = normalizeMode(document.numberingMode);
    const numbers = new Map();
    let offset = 0;
    document.sections.forEach((section, sectionIndex) => {
      section.rows.forEach((row, rowIndex) => {
        numbers.set(row.id, mode === "hierarchical"
          ? `${sectionIndex + 1}.${rowIndex + 1}`
          : `${(mode === "continuous" ? offset : 0) + rowIndex + 1}.`);
      });
      offset += section.rows.length;
    });
    return numbers;
  }

  function columnWidth(document) {
    const mode = normalizeMode(document.numberingMode);
    let offset = 0;
    let length = 0;
    document.sections.forEach((section, index) => {
      offset += section.rows.length;
      const label = mode === "hierarchical" ? `${index + 1}.${section.rows.length}`
        : `${mode === "continuous" ? offset : section.rows.length}.`;
      length = Math.max(length, label.length);
    });
    return Math.max(52, length * 8 + 28);
  }

  function sectionTitle(document, section) {
    const index = document.sections.findIndex((item) => item.id === section.id);
    return `${index + 1}. ${section.title || "Раздел"}`;
  }

  const api = { normalizeMode, rowNumbers, columnWidth, sectionTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChecklistNumbering = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
