(function initJiraMarkupImport(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("node:crypto").randomUUID);
  } else {
    root.QaReportJiraImport = factory(() => root.crypto.randomUUID());
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function buildJiraMarkupImport(randomUUID) {
  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function splitWikiRow(line) {
    const delimiter = line.startsWith("||") ? "||" : "|";
    const source = line.slice(delimiter.length, line.endsWith(delimiter) ? -delimiter.length : undefined);
    const cells = [];
    let current = "";
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        current += character === "|" ? "|" : `\\${character}`;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (source.startsWith(delimiter, index)) {
        cells.push(current);
        current = "";
        index += delimiter.length - 1;
      } else current += character;
    }
    cells.push(current);
    return cells;
  }

  function collectWikiTableRow(lines, startIndex, expectedCells) {
    let row = lines[startIndex].trim();
    let index = startIndex;
    while (expectedCells && splitWikiRow(row).length < expectedCells && index + 1 < lines.length) {
      const next = lines[index + 1];
      const trimmed = next.trim();
      if (/^h[1-6]\.\s+/i.test(trimmed) || trimmed.startsWith("|")) break;
      row += `\n${next}`;
      index += 1;
    }
    return { row, index };
  }

  function wikiInlineToHtml(value, attachments = []) {
    const codeBlocks = [];
    let source = String(value || "").replace(
      /\{code(?::(?:language=)?([^}]+))?\}([\s\S]*?)\{code\}/gi,
      (_, language, code) => {
        const token = `@@CODE${codeBlocks.length}@@`;
        codeBlocks.push(
          `<pre class="cell-code-block" data-language="${escapeHtml(language || "text")}"><code>${escapeHtml(code.trim())}</code></pre>`,
        );
        return token;
      },
    );
    const attachmentByName = new Map(attachments.map((item) => [item.filename, item]));
    return escapeHtml(source)
      .replace(/\\\\/g, "<br>")
      .replace(/!([^|!\n]+)(?:\|[^!]*)?!/g, (_, filename) => {
        const attachment = attachmentByName.get(filename);
        if (!attachment?.content && !attachment?.thumbnail) return `<span>[Изображение: ${filename}]</span>`;
        const src = attachment.thumbnail || attachment.content;
        return `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${escapeHtml(src)}" alt="" data-attachment-id="${escapeHtml(attachment.id)}" data-file-name="${escapeHtml(filename)}" data-jira-name="${escapeHtml(filename)}" data-jira-id="${escapeHtml(attachment.id)}" data-jira-url="${escapeHtml(attachment.content || "")}"></figure>`;
      })
      .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '<a href="$2">$1</a>')
      .replace(/\{color:(#[0-9a-f]{3,8})\}([\s\S]*?)\{color\}/gi, '<span style="color:$1">$2</span>')
      .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>")
      .replace(/\+([^+\n]+)\+/g, "<u>$1</u>")
      .replace(/@@CODE(\d+)@@/g, (_, index) => codeBlocks[Number(index)] || "");
  }

  function normalizeStatus(value) {
    const status = String(value || "")
      .replace(/\{color:[^}]+\}|\{color\}|[*_+]/g, "")
      .trim()
      .toUpperCase();
    if (status === "OK" || status === "ОК") return "OK";
    if (["НЕ ОК", "НЕ OK", "НЕОК"].includes(status)) return "НЕ ОК";
    if (["НА ДОРАБОТКУ", "FAILED", "FAIL"].includes(status)) return "НЕ ОК";
    if (["ПОЧТИ ОК", "ПОЧТИ OK"].includes(status)) return "ПОЧТИ ОК";
    if (status === "ЧАСТИЧНО ПРОВЕРЕНО") return status;
    if (status === "ТРЕБУЕТ УТОЧНЕНИЯ") return status;
    return "НЕ ПРОВЕРЕНО";
  }

  function parseJiraMarkup(markup, attachments = []) {
    const lines = String(markup || "").replace(/\r/g, "").split("\n");
    const imported = {
      reportId: randomUUID(),
      schemaVersion: 3,
      issueUrl: "",
      environment: "STAGE",
      overallStatus: "OK",
      intro: "",
      sections: [],
    };
    const introLines = [];
    let pendingTitle = "";
    let currentSection = null;
    let headers = null;
    let tableNumber = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex];
      const line = rawLine.trim();
      if (!line) {
        if (!headers) introLines.push("");
        continue;
      }
      const issue = line.match(/^\*?Задача:\*?\s*(.+)$/i);
      if (issue) continue;
      const environment = line.match(/(?:Проверено\s+на|Окружение)\s*:?\s*([A-Za-zА-Яа-яЁё-]+)/i);
      if (environment) {
        const value = environment[1].toUpperCase();
        imported.environment = ["DEV", "STAGE", "PROD"].includes(value) ? value : "Локально";
        continue;
      }
      const overall = line.match(/(?:ТЕСТ\s*[-—]|Статус\s*:)\s*(.+?)\*?$/i);
      if (overall) {
        imported.overallStatus = normalizeStatus(overall[1]);
        continue;
      }
      if (/^h1\.\s+/i.test(line)) continue;
      if (/^h[23]\.\s+/i.test(line)) {
        pendingTitle = line.replace(/^h[23]\.\s+/i, "").trim();
        headers = null;
        currentSection = null;
        continue;
      }
      if (line.startsWith("||")) {
        tableNumber += 1;
        const rawHeaders = splitWikiRow(line).map((header) => header.trim());
        const numberIndex = rawHeaders.findIndex((header) => /^(номер|№)$/i.test(header));
        const statusIndex = rawHeaders.findIndex((header) => /статус/i.test(header));
        const columns = rawHeaders
          .map((title, index) => ({ title, index }))
          .filter(({ index }) => index !== numberIndex && index !== statusIndex)
          .map(({ title, index }) => ({
            id: `import-${tableNumber}-${index}-${randomUUID()}`,
            title: title || `Столбец ${index + 1}`,
            sourceIndex: index,
          }));
        currentSection = {
          id: randomUUID(),
          title: pendingTitle || `Раздел ${tableNumber}`,
          collapsed: false,
          columns,
          rows: [],
        };
        imported.sections.push(currentSection);
        headers = { statusIndex, columnCount: rawHeaders.length };
        pendingTitle = "";
        continue;
      }
      if (line.startsWith("|") && headers && currentSection) {
        const collected = collectWikiTableRow(lines, lineIndex, headers.columnCount);
        lineIndex = collected.index;
        const values = splitWikiRow(collected.row);
        currentSection.rows.push({
          id: randomUUID(),
          status: normalizeStatus(headers.statusIndex >= 0 ? values[headers.statusIndex] : ""),
          cells: Object.fromEntries(
            currentSection.columns.map((column) => [
              column.id,
              wikiInlineToHtml(values[column.sourceIndex] || "", attachments),
            ]),
          ),
        });
        continue;
      }
      headers = null;
      currentSection = null;
      introLines.push(line);
    }

    imported.sections.forEach((section) => {
      section.columns.forEach((column) => delete column.sourceIndex);
    });
    imported.sections = imported.sections.filter((section) => section.rows.length);
    if (!imported.sections.length) throw new Error("В разметке не найдена таблица чек-листа");
    imported.intro = introLines.map((line) => (line ? `<p>${wikiInlineToHtml(line, attachments)}</p>` : "")).join("");
    return imported;
  }

  return { parseJiraMarkup, normalizeStatus };
});
