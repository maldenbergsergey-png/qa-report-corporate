(function (root) {
  function normalizeMode(mode) {
    return ["section", "continuous", "hierarchical", "manual"].includes(mode) ? mode : "section";
  }

  function normalizeSectionMode(mode) { return mode === "manual" ? "manual" : "automatic"; }

  function normalizeSectionNumber(value) { return normalizeNumber(value).replace(/[.)]$/, "").trim(); }

  function sectionNumbers(document) {
    const manual = normalizeSectionMode(document.sectionNumberingMode) === "manual";
    return new Map(document.sections.map((section, index) => [section.id,
      manual ? normalizeSectionNumber(section.manualNumber) : String(index + 1)]));
  }

  function setSectionMode(document, nextMode) {
    const mode = normalizeSectionMode(nextMode);
    if (mode === "manual" && normalizeSectionMode(document.sectionNumberingMode) !== "manual") {
      const numbers = sectionNumbers(document);
      document.sections.forEach(section => { section.manualNumber = numbers.get(section.id); });
    }
    document.sectionNumberingMode = mode;
  }

  function hasSourceSectionNumbers(document) {
    return document.sections.some(section => Object.hasOwn(section, "manualNumber"));
  }

  function configureSectionImport(document, preserve) {
    document.sectionNumberingMode = preserve && hasSourceSectionNumbers(document) ? "manual" : "automatic";
    document.sections.forEach((section, index) => {
      if (!preserve) delete section.manualNumber;
      else if (document.sectionNumberingMode === "manual") section.manualNumber = normalizeSectionNumber(section.manualNumber ?? String(index + 1));
    });
    return document;
  }

  // Number the whole document before filtering for preview or partial publication.
  // Stable row IDs keep the same labels everywhere, including around empty rows.
  function rowNumbers(document) {
    const mode = normalizeMode(document.numberingMode);
    const numbers = new Map();
    let offset = 0;
    const labels = sectionNumbers(document);
    document.sections.forEach((section) => {
      section.rows.forEach((row, rowIndex) => {
        numbers.set(row.id, mode === "manual" ? normalizeNumber(row.manualNumber) : mode === "hierarchical"
          ? `${labels.get(section.id) ? labels.get(section.id) + "." : ""}${rowIndex + 1}`
          : `${(mode === "continuous" ? offset : 0) + rowIndex + 1}.`);
      });
      offset += section.rows.length;
    });
    return numbers;
  }

  function normalizeNumber(value) {
    return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  }

  function setMode(document, nextMode) {
    const mode = normalizeMode(nextMode);
    if (mode === "manual" && normalizeMode(document.numberingMode) !== "manual") {
      const numbers = rowNumbers(document);
      document.sections.forEach(section => section.rows.forEach(row => {
        row.manualNumber = numbers.get(row.id);
      }));
    }
    document.numberingMode = mode;
  }

  function hasSourceNumbers(document) {
    return document.sections.some(section => section.rows.some(row => Object.hasOwn(row, "manualNumber")));
  }

  function configureImport(document, preserve, currentMode = "section", preserveSections = preserve) {
    const hasNumbers = hasSourceNumbers(document);
    const mode = normalizeMode(currentMode);
    document.numberingMode = preserve && hasNumbers ? "manual"
      : mode === "manual" && hasNumbers ? "section" : mode;
    if (!preserve) document.sections.forEach(section => section.rows.forEach(row => delete row.manualNumber));
    return configureSectionImport(document, preserveSections);
  }

  function columnWidth(document) {
    if (normalizeMode(document.numberingMode) === "manual") {
      let length = 0;
      for (const number of rowNumbers(document).values()) length = Math.max(length, number.length);
      return Math.min(240, Math.max(80, length * 8 + 40));
    }
    const mode = normalizeMode(document.numberingMode);
    const sections = sectionNumbers(document);
    let offset = 0;
    let length = 0;
    document.sections.forEach((section, index) => {
      offset += section.rows.length;
      const label = mode === "hierarchical" ? `${sections.get(section.id) ? sections.get(section.id) + "." : ""}${section.rows.length}`
        : `${mode === "continuous" ? offset : section.rows.length}.`;
      length = Math.max(length, label.length);
    });
    return Math.max(52, length * 8 + 28);
  }

  function sectionTitle(document, section) {
    const number = sectionNumbers(document).get(section.id);
    return `${number ? number + ". " : ""}${section.title || "Раздел"}`;
  }

  const api = { normalizeSectionMode, normalizeSectionNumber, sectionNumbers, setSectionMode, hasSourceSectionNumbers, configureSectionImport, normalizeMode, normalizeNumber, setMode, hasSourceNumbers, configureImport, rowNumbers, columnWidth, sectionTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChecklistNumbering = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
