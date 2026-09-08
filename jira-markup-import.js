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

    const closingMarkerIndex = (marker, startIndex, openMarker = "") => {
      let depth = 1;
      for (let index = startIndex; index < source.length; index += 1) {
        let slashCount = 0;
        for (let previous = index - 1; previous >= 0 && source[previous] === "\\"; previous -= 1) {
          slashCount += 1;
        }
        if (slashCount % 2 !== 0) continue;
        if (openMarker && source[index] === openMarker) {
          depth += 1;
        } else if (source[index] === marker) {
          depth -= 1;
          if (depth === 0) return index;
        }
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
        const closingIndex = closingMarkerIndex("]", index + 1, "[");
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
          // Jira uses the next identical marker as the closing delimiter; these macros are not nestable.
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
      .replace(/&amp;#(?:92|x5c);/gi, "&#92;")
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

    const jiraNamedColors = new Set([
      "aqua", "black", "blue", "fuchsia", "gray", "green", "lime", "maroon", "navy",
      "olive", "orange", "purple", "red", "silver", "teal", "white", "yellow",
    ]);
    output = output.replace(/\{color:([^}]+)\}([\s\S]*?)\{color\}/gi, (match, rawColor, content) => {
      const color = rawColor.trim().toLowerCase();
      return /^#[0-9a-f]{3,8}$/i.test(color) || jiraNamedColors.has(color)
        ? `<span style="color:${color}">${content}</span>`
        : match;
    });
    return output;
  }

  function wikiInlineToHtml(value, attachments = []) {
    const protectedBlocks = [];
    const escapedTokenIndexes = new Set();
    const tokenPattern = /@@JIRATOKEN(\d+)@@/g;
    const protect = (html) => {
      const token = `@@JIRATOKEN${protectedBlocks.length}@@`;
      protectedBlocks.push(html);
      return token;
    };
    const restoreProtectedBlocks = (value) => {
      let restored = String(value || "");
      for (let depth = 0; depth <= protectedBlocks.length; depth += 1) {
        let replaced = false;
        const next = restored.replace(tokenPattern, (_, index) => {
          const block = protectedBlocks[Number(index)];
          if (block === undefined) return "";
          replaced = true;
          return block;
        });
        restored = next;
        if (!replaced) break;
      }
      return restored;
    };
    const restoreEscapedUrlTokens = (value) => {
      let valid = true;
      const restored = String(value || "").replace(tokenPattern, (_, index) => {
        const tokenIndex = Number(index);
        if (!escapedTokenIndexes.has(tokenIndex)) {
          valid = false;
          return "";
        }
        return protectedBlocks[tokenIndex];
      });
      return valid ? restored : "";
    };
    const attachmentByName = new Map(attachments.map((item) => [item.filename, item]));
    let source = String(value || "").replace(
      /\\([!{}\[\]|*_+\-^~])/g,
      (_, character) => {
        const tokenIndex = protectedBlocks.length;
        const token = protect(escapeHtml(character));
        escapedTokenIndexes.add(tokenIndex);
        return token;
      },
    );
    source = source.replace(
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
      const attachment = attachments.filter(item => item.filename === filename).length === 1 ? attachmentByName.get(filename) : null;
      const attachmentUrl = safeHttpUrl(attachment?.content);
      const thumbnailUrl = safeHttpUrl(attachment?.thumbnail);
      const externalUrl = safeHttpUrl(filename);
      const src = thumbnailUrl || attachmentUrl || externalUrl;
      if (!src) {
        return protect(
          `<span class="jira-image-placeholder" contenteditable="false" title="Ссылка на вложение Jira. Файл не скачан в браузер." data-jira-name="${escapeHtml(filename)}" data-jira-options="${escapeHtml(options)}">${escapeHtml(filename)}</span>`,
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
    source = source.replace(/\[\^([^\]\r\n]+)\]/g, (_, rawName) => {
      const name = rawName.trim();
      const matches = attachments.filter(item => item.filename === name);
      const attachment = matches.length === 1 ? matches[0] : null;
      return protect(`<span class="jira-file-placeholder" contenteditable="false" title="Ссылка на вложение Jira. Файл не скачан в браузер." data-jira-name="${escapeHtml(name)}"${attachment?.id ? ` data-jira-id="${escapeHtml(attachment.id)}"` : ""}>${escapeHtml(name)}</span>`);
    });
    const replaceWikiLinks = (input) => {
      let output = "";
      let cursor = 0;
      while (cursor < input.length) {
        const startIndex = input.indexOf("[", cursor);
        if (startIndex < 0) {
          output += input.slice(cursor);
          break;
        }
        output += input.slice(cursor, startIndex);
        let depth = 1;
        let separatorIndex = -1;
        let closingIndex = -1;
        for (let index = startIndex + 1; index < input.length; index += 1) {
          if (input[index] === "[") depth += 1;
          else if (input[index] === "]") {
            depth -= 1;
            if (depth === 0) {
              closingIndex = index;
              break;
            }
          } else if (input[index] === "|" && depth === 1 && separatorIndex < 0) {
            separatorIndex = index;
          }
        }
        if (closingIndex < 0) {
          output += input.slice(startIndex);
          break;
        }
        if (separatorIndex < 0) {
          output += input.slice(startIndex, closingIndex + 1);
          cursor = closingIndex + 1;
          continue;
        }
        const text = input.slice(startIndex + 1, separatorIndex);
        const href = restoreEscapedUrlTokens(input.slice(separatorIndex + 1, closingIndex));
        const safeHref = safeHttpUrl(href);
        const formattedText = restoreProtectedBlocks(formatWikiText(text));
        output += protect(
          safeHref
            ? `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${formattedText}</a>`
            : formattedText,
        );
        cursor = closingIndex + 1;
      }
      return output;
    };
    source = replaceWikiLinks(source);
    return restoreProtectedBlocks(formatWikiText(source));
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
          title: stripSectionNumber(pendingTitle) || `Раздел ${tableNumber}`,
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

  // Only explicit ordinal prefixes; years, versions and 2FA remain titles.
  function stripSectionNumber(title) {
    return String(title || "").replace(/^\s*\d{1,3}[.)]\s+(?=\S)/, "").trim();
  }

  return { parseJiraMarkup, normalizeStatus, stripSectionNumber };
});
