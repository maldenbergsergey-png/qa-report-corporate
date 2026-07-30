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

  function safeHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || /[\s"'<>\\]/.test(raw)) return "";
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function splitWikiRow(line) {
    const delimiter = line.startsWith("||") ? "||" : "|";
    const source = line.slice(delimiter.length, line.endsWith(delimiter) ? -delimiter.length : undefined);
    const cells = [];
    let current = "";
    let escaped = false;

    const closingMarkerIndex = (marker, startIndex) => {
      for (let index = startIndex; index < source.length; index += 1) {
        if (source[index] !== marker) continue;
        let slashCount = 0;
        for (let previous = index - 1; previous >= 0 && source[previous] === "\\"; previous -= 1) {
          slashCount += 1;
        }
        if (slashCount % 2 === 0) return index;
      }
      return -1;
    };

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        current += character === "|" ? "|" : `\\${character}`;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "[") {
        const closingIndex = closingMarkerIndex("]", index + 1);
        if (closingIndex >= 0) {
          current += source.slice(index, closingIndex + 1);
          index = closingIndex;
        } else current += character;
      } else if (
        character === "!" &&
        (index === 0 || /[\s|([{:]/.test(source[index - 1]))
      ) {
        const closingIndex = closingMarkerIndex("!", index + 1);
        if (closingIndex >= 0) {
          current += source.slice(index, closingIndex + 1);
          index = closingIndex;
        } else current += character;
      } else if (character === "{") {
        const macro = source.slice(index).match(/^\{(code|noformat)(?::[^}]*)?\}/i);
        if (macro) {
          const closing = `{${macro[1].toLowerCase()}}`;
          const closingIndex = source.toLowerCase().indexOf(closing, index + macro[0].length);
          if (closingIndex >= 0) {
            const endIndex = closingIndex + closing.length;
            current += source.slice(index, endIndex);
            index = endIndex - 1;
          } else current += character;
        } else current += character;
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

  function formatWikiText(value) {
    let output = escapeHtml(value)
      .replace(/\\\\/g, "<br>")
      .replace(/\n/g, "<br>")
      .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>")
      .replace(/\+([^+\n]+)\+/g, "<u>$1</u>")
      .replace(
        /(^|[\s([{])-((?:\S|<br>)(?:[^-\n]*?(?:\S|>))?)-(?=$|[\s)\]},.!?:;])/g,
        "$1<s>$2</s>",
      )
      .replace(
        /(^|[\s([{])\^((?:\S|<br>)(?:[^^\n]*?(?:\S|>))?)\^(?=$|[\s)\]},.!?:;])/g,
        "$1<sup>$2</sup>",
      )
      .replace(
        /(^|[\s([{])~((?:\S|<br>)(?:[^~\n]*?(?:\S|>))?)~(?=$|[\s)\]},.!?:;])/g,
        "$1<sub>$2</sub>",
      );

    output = output.replace(
      /\{color:(#[0-9a-f]{3,8})\}([\s\S]*?)\{color\}/gi,
      '<span style="color:$1">$2</span>',
    );
    return output;
  }

  function wikiInlineToHtml(value, attachments = []) {
    const protectedBlocks = [];
    const protect = (html) => {
      const token = `@@JIRATOKEN${protectedBlocks.length}@@`;
      protectedBlocks.push(html);
      return token;
    };
    const attachmentByName = new Map(attachments.map((item) => [item.filename, item]));
    let source = String(value || "").replace(
      /\{code(?::(?:language=)?([^}]+))?\}([\s\S]*?)\{code\}/gi,
      (_, language, code) => {
        return protect(
          `<pre class="cell-code-block" data-language="${escapeHtml(language || "text")}"><code>${escapeHtml(code.trim())}</code></pre>`,
        );
      },
    );
    source = source.replace(/\{noformat\}([\s\S]*?)\{noformat\}/gi, (_, content) =>
      protect(
        `<pre class="cell-code-block" data-language="text"><code>${escapeHtml(content.trim())}</code></pre>`,
      ),
    );
    source = source.replace(/\{\{([^{}\n]+)\}\}/g, (_, content) =>
      protect(`<code>${escapeHtml(content)}</code>`),
    );
    source = source.replace(/!([^|!\n]+)(?:\|([^!\n]*))?!/g, (_, rawFilename, options = "") => {
      const filename = rawFilename.trim();
      const attachment = attachmentByName.get(filename);
      const attachmentUrl = safeHttpUrl(attachment?.content);
      const thumbnailUrl = safeHttpUrl(attachment?.thumbnail);
      const externalUrl = safeHttpUrl(filename);
      const src = thumbnailUrl || attachmentUrl || externalUrl;
      if (!src) {
        return protect(
          `<span class="jira-image-placeholder" data-jira-name="${escapeHtml(filename)}" data-jira-options="${escapeHtml(options)}">${escapeHtml(filename)}</span>`,
        );
      }
      const attachmentId = attachment?.id ? ` data-attachment-id="${escapeHtml(attachment.id)}"` : "";
      const jiraId = attachment?.id ? ` data-jira-id="${escapeHtml(attachment.id)}"` : "";
      const jiraThumbnail = thumbnailUrl
        ? ` data-jira-thumbnail="${escapeHtml(thumbnailUrl)}"`
        : "";
      const jiraOptions = options
        ? ` data-jira-options="${escapeHtml(options)}"`
        : "";
      return protect(
        `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${escapeHtml(src)}" alt="${escapeHtml(filename)}"${attachmentId} data-file-name="${escapeHtml(filename)}" data-jira-name="${escapeHtml(filename)}"${jiraId} data-jira-url="${escapeHtml(attachmentUrl || externalUrl)}"${jiraThumbnail}${jiraOptions}></figure>`,
      );
    });
    source = source.replace(/\[([^\]|]+)\|([^\]]+)\]/g, (_, text, href) => {
      const safeHref = safeHttpUrl(href);
      return protect(
        safeHref
          ? `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${formatWikiText(text)}</a>`
          : formatWikiText(text),
      );
    });
    return formatWikiText(source).replace(
      /@@JIRATOKEN(\d+)@@/g,
      (_, index) => protectedBlocks[Number(index)] || "",
    );
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
