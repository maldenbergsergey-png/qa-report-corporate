(function (root) {
  "use strict";

  const statuses = new Map([
    ["OK", { tone: "positive", rank: 6 }],
    ["НЕ ОК", { tone: "negative", rank: 1 }],
    ["ПОЧТИ ОК", { tone: "informative", rank: 4 }],
    ["НЕ ПРОВЕРЕНО", { tone: "unchecked", rank: 5 }],
    ["ЗАБЛОКИРОВАНО", { tone: "muted", rank: 2 }],
    ["ЧАСТИЧНО ПРОВЕРЕНО", { tone: "warning", rank: 3 }],
    ["ТРЕБУЕТ УТОЧНЕНИЯ", { tone: "clarification", rank: 0 }],
  ]);
  const neutral = { tone: "neutral", rank: 5 };
  const aliases = new Map([["ОК", "OK"], ["НЕ OK", "НЕ ОК"], ["ПОЧТИ OK", "ПОЧТИ ОК"]]);
  const statusKey = status => {
    const key = status?.trim().toUpperCase();
    return aliases.get(key) || key;
  };
  const statusMeta = status => statuses.get(statusKey(status)) || neutral;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeLink(value) {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch {}
    return "";
  }

  function externalLink(value, label = value) {
    const href = safeLink(value);
    if (!href) return null;
    const link = element("a", "", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function statusTag(status) {
    const tag = element("span", "report-tag", status || "Статус не указан");
    tag.dataset.tone = statusMeta(status).tone;
    return tag;
  }

  function renderOverview(overview, { issueUrl, environment, overallStatus, published, updated }, renderIntro) {
    const meta = overview.querySelector(".metadata");
    const intro = overview.querySelector(".intro");
    const introContent = intro.querySelector(".intro-content");
    const issueKey = root.QaReportTrackerLinks.parse(issueUrl)?.key;
    const fields = [
      ["Задача", externalLink(issueUrl, issueKey || "Открыть задачу")],
      ["Окружение", environment?.trim() && element("span", "report-tag", environment.trim())],
      ["Итог проверки", overallStatus && statusTag(overallStatus)],
      ["Опубликовано", published],
      ["Обновлено", updated],
    ];
    meta.replaceChildren();
    for (const [label, content] of fields) {
      if (!content) continue;
      const group = element("div");
      const value = element("dd");
      value.append(content);
      group.append(element("dt", "", label), value);
      meta.append(group);
    }
    meta.hidden = !meta.children.length;
    intro.open = false;
    introContent.replaceChildren();
    intro.hidden = !renderIntro(introContent);
    overview.hidden = meta.hidden && intro.hidden;
  }

  function createSection(title, columns, extraColumns = []) {
    const section = element("section", "report-section");
    const frame = element("div", "table-frame");
    const table = element("table", "report-table");
    table.setAttribute("aria-label", title);
    const headers = table.createTHead().insertRow();
    for (const [label, className] of [
      ["№", "point-index"], ...columns.map(label => [label, "report-cell"]),
      ["Статус", "qa-status"], ...extraColumns,
    ]) {
      const header = element("th", className, label);
      header.scope = "col";
      headers.append(header);
    }
    const body = table.createTBody();
    frame.append(table);
    section.append(element("h2", "", title), frame);
    return { section, body };
  }

  const linePlural = new Intl.PluralRules("ru-RU");
  function lineCountLabel(count) {
    const unit = { one: "строка", few: "строки", many: "строк" }[linePlural.select(count)];
    return `${count} ${unit}`;
  }

  function formatXml(text) {
    if (!/^\s*</.test(text) || /<!DOCTYPE/i.test(text) || text.length > 256_000) return text;
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.querySelector("parsererror")) return text;
    let changed = false;
    function indent(node, depth) {
      if (!node.children.length || depth >= 48 || node.hasAttributeNS("http://www.w3.org/XML/1998/namespace", "space")) return;
      const children = [...node.childNodes];
      // Leave mixed content and significant whitespace alone.
      if (children.some(child => child.nodeType === Node.CDATA_SECTION_NODE ||
        (child.nodeType === Node.TEXT_NODE && child.data.trim()))) return;
      for (const child of children) {
        if (child.nodeType === Node.TEXT_NODE) child.remove();
        else {
          child.before(xml.createTextNode("\n" + "  ".repeat(depth + 1)));
          if (child.nodeType === Node.ELEMENT_NODE) indent(child, depth + 1);
        }
      }
      node.append(xml.createTextNode("\n" + "  ".repeat(depth)));
      changed = true;
    }
    indent(xml.documentElement, 0);
    if (!changed) return text;
    const declarationPattern = /^\s*(<\?xml\s[\s\S]*?\?>)/;
    const declaration = declarationPattern.exec(text)?.[1];
    const serialized = new XMLSerializer().serializeToString(xml);
    return declaration ? declaration + "\n" + serialized.replace(declarationPattern, "").trimStart() : serialized;
  }

  function formatReportCode(text) {
    const tools = root.QaReportFilePreview;
    const readable = tools.readableCode(text);
    if (/^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+\S+|HTTP\/\d(?:\.\d)?\s+\d{3})/.test(readable)) {
      const separator = /\r?\n\r?\n/.exec(readable);
      if (separator) {
        const body = separator.index + separator[0].length;
        return readable.slice(0, body) + formatXml(tools.formatJson(readable.slice(body)));
      }
    }
    return formatXml(readable);
  }

  function createCodePreview(text, openCode) {
    const readable = text.length <= 256_000 ? formatReportCode(text) : null;
    const display = readable ?? text;
    const detail = lineCountLabel(display.split(/\r\n|\r|\n/).length);
    const block = element("div", "report-code-block");
    const trigger = element("button", "report-code-open");
    trigger.type = "button";
    trigger.setAttribute("aria-label", `Код, ${detail}. Открыть код`);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.addEventListener("click", () => openCode({ text, readable, detail, trigger }));
    const viewport = element("span", "report-code-viewport");
    viewport.append(element("code", "", display.slice(0, 2400)));
    trigger.append(element("span", "report-code-label", `Код · ${detail}`), viewport);
    block.append(trigger);
    return block;
  }

  function createCodeViewer(dialog) {
    const content = dialog.querySelector("pre");
    const readable = dialog.querySelector("input");
    const copy = dialog.querySelector("[data-copy-code]");
    const message = dialog.querySelector("[role=status]");
    let code;
    function render() {
      content.textContent = readable.checked ? code.readable : code.text;
      content.scrollTo(0, 0);
      message.textContent = "";
    }
    readable.addEventListener("change", render);
    dialog.querySelector("[data-close-code]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      code = null;
      content.textContent = "";
    });
    copy.addEventListener("click", async () => {
      const current = code;
      const text = content.textContent;
      try {
        await navigator.clipboard.writeText(text);
        if (code === current && content.textContent === text) message.textContent = "Код скопирован.";
      } catch {
        if (code === current && content.textContent === text) message.textContent = "Не удалось скопировать код.";
      }
    });
    return ({ text, readable: formatted }) => {
      code = { text, readable: formatted ?? formatReportCode(text) };
      readable.checked = true;
      render();
      dialog.showModal();
    };
  }

  const richTags = new Set("A B BR CODE DIV EM FIGCAPTION FIGURE H1 H2 H3 HR I IMG LI OL P S SPAN STRONG SUB SUP U UL".split(" "));
  const raster = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif);base64,[a-z0-9+/=]+$/i;
  const localFile = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i;
  const textStyles = ["color", "background-color", "text-align", "font-weight", "font-style", "text-decoration"];

  function readContent(target, html, openImage, openFile, openCode, extractCode) {
    const template = element("template");
    template.innerHTML = html || "";
    template.content.querySelectorAll("script,style,iframe,object,embed,svg,math,template,[data-editor-ui]").forEach(node => node.remove());
    for (const node of template.content.querySelectorAll("*")) {
      if (!template.content.contains(node)) continue;
      if (node.tagName === "PRE") {
        const text = extractCode(node);
        if (text) node.replaceWith(createCodePreview(text, openCode));
        else node.remove();
        continue;
      }
      if (node.matches(".cell-file,.jira-file-placeholder,.jira-image-placeholder")) {
        const name = node.dataset.fileName || node.dataset.jiraName || node.textContent.trim() || "Вложение";
        const data = node.dataset.dataUrl;
        const url = node.dataset.jiraUrl || node.dataset.jiraExactUrl;
        if (localFile.test(data || "")) {
          const button = element("button", "report-attachment", name);
          button.type = "button";
          for (const key of ["dataUrl", "fileName", "mimeType", "fileSize"]) button.dataset[key] = key === "fileName" ? name : node.dataset[key] || "";
          button.addEventListener("click", () => openFile(button));
          node.replaceWith(button);
        } else {
          const link = externalLink(url, name);
          node.replaceWith(link || name);
        }
        continue;
      }
      if (node.tagName === "IMG") {
        const name = node.dataset.fileName || node.getAttribute("alt") || "Изображение";
        const source = node.getAttribute("src") || "";
        if (raster.test(source) || source.startsWith(`blob:${root.location.origin}/`)) {
          const button = element("button", "report-image");
          button.type = "button";
          button.setAttribute("aria-label", `Открыть изображение: ${name}`);
          const image = element("img");
          image.src = source;
          image.alt = name;
          image.loading = "lazy";
          button.append(image);
          button.addEventListener("click", () => openImage(source, name));
          node.replaceWith(button);
        } else {
          node.replaceWith(externalLink(source || node.dataset.jiraUrl, name) || name);
        }
        continue;
      }
      if (!richTags.has(node.tagName)) {
        node.replaceWith(...node.childNodes);
        continue;
      }
      const href = node.tagName === "A" && safeLink(node.getAttribute("href"));
      const style = textStyles.map(prop => [prop, node.style.getPropertyValue(prop)])
        .filter(([, value]) => value && !/url|expression|var\(|[<>\\]/i.test(value));
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      if (node.tagName === "CODE") node.className = "report-inline-code";
      if (href) {
        node.href = href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
      }
      for (const [prop, value] of style) node.style.setProperty(prop, value);
    }
    const present = Boolean(template.content.textContent.trim() || template.content.querySelector("img"));
    if (present) target.append(template.content);
    return present;
  }

  function appendStatusOptions(filter, groups) {
    const available = new Set(groups.flatMap(group => group.rows.map(row => row.status)));
    for (const status of statuses.keys()) {
      const option = new Option(status, status);
      option.disabled = !available.has(status);
      filter.add(option);
    }
  }

  function createEmptyState(container, filter) {
    const message = element("p");
    const reset = element("button", "report-view-reset", "Показать все пункты");
    reset.type = "button";
    reset.addEventListener("click", () => {
      filter.value = "all";
      filter.dispatchEvent(new Event("change"));
      filter.focus();
    });
    container.append(message, reset);
    return (visible, total) => {
      container.hidden = visible > 0;
      message.textContent = total ? "Пунктов с таким статусом нет" : "В чек-листе пока нет заполненных пунктов";
      reset.hidden = filter.value === "all";
    };
  }

  function createPreview(dialog, openFile, extractCode) {
    const filter = dialog.querySelector(".report-view-filter");
    const order = dialog.querySelector(".report-view-order");
    const counts = dialog.querySelector(".counts");
    const overview = dialog.querySelector(".report-overview");
    const sections = dialog.querySelector(".report-view-sections");
    const updateEmptyState = createEmptyState(dialog.querySelector(".report-view-empty"), filter);
    const imageDialog = dialog.querySelector(".report-image-dialog");
    const openCode = createCodeViewer(dialog.querySelector(".report-code-dialog"));
    const image = imageDialog.querySelector("img");
    const imageTitle = imageDialog.querySelector("h2");
    let groups = [];
    let initialStatuses;
    const scrollport = dialog.querySelector(".report-content");

    const openImage = (source, name) => {
      image.src = source;
      image.alt = name;
      imageTitle.textContent = name;
      imageDialog.showModal();
    };
    imageDialog.addEventListener("close", () => image.removeAttribute("src"));
    imageDialog.querySelector("button").addEventListener("click", () => imageDialog.close());
    dialog.querySelector(".report-home").addEventListener("click", () => dialog.close());
    // The editor's undo, save and object editing shortcuts do not apply in the viewer.
    dialog.addEventListener("keydown", event => event.stopPropagation());
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      sections.replaceChildren();
      overview.querySelector(".intro-content").replaceChildren();
      groups = [];
    });

    function update() {
      const mode = filter.value;
      let visible = 0;
      let total = 0;
      for (const group of groups) {
        const rows = order.value === "priority"
          ? [...group.rows].sort((a, b) => statusMeta(a.status).rank - statusMeta(b.status).rank)
          : group.rows;
        let matching = 0;
        rows.forEach(({ status, node }, index) => {
          node.hidden = !(mode === "all" || (mode === "editor" ? initialStatuses.has(status) : mode === status));
          if (!node.hidden) matching++;
          if (group.body.rows[index] !== node) group.body.insertBefore(node, group.body.rows[index] || null);
        });
        total += rows.length;
        visible += matching;
        group.section.hidden = !matching;
      }
      counts.textContent = `Показано ${visible} из ${total}`;
      updateEmptyState(visible, total);
    }
    filter.addEventListener("change", update);
    order.addEventListener("change", update);

    return function open(report, selectedStatuses) {
      if (dialog.open) return;
      initialStatuses = selectedStatuses ? new Set([...selectedStatuses].map(statusKey)) : null;
      filter.replaceChildren(new Option("Все пункты", "all"));
      if (initialStatuses) filter.add(new Option("Как в чек-листе", "editor"));
      filter.value = initialStatuses ? "editor" : "all";
      order.value = "original";
      dialog.querySelector("h1").textContent = report.title;
      const append = (target, html) => readContent(target, html, openImage, openFile, openCode, extractCode);
      renderOverview(overview, report, target => append(target, report.intro));
      groups = report.sections.map(({ title, columns, rows }) => {
        const group = createSection(title, columns.map(column => column.title || "Без названия"));
        const entries = rows.map(row => {
          const tr = group.body.insertRow();
          const index = element("th", "point-index", row.number);
          index.scope = "row";
          tr.append(index);
          for (const column of columns) {
            const cell = element("td", "report-cell");
            append(cell, row.cells[column.id]);
            tr.append(cell);
          }
          const status = element("td", "qa-status");
          status.append(statusTag(row.status));
          const bugs = element("div", "bug-links");
          for (const bug of row.bugs || []) {
            const link = externalLink(bug.issueUrl, bug.key);
            if (link) bugs.append(link);
          }
          if (bugs.childElementCount) (tr.cells[1] || status).append(bugs);
          tr.append(status);
          return { node: tr, status: statusKey(row.status) };
        });
        return { ...group, rows: entries };
      });
      appendStatusOptions(filter, groups);
      sections.replaceChildren(...groups.map(group => group.section));
      update();
      dialog.showModal();
      scrollport.scrollTo(0, 0);
    };
  }

  root.QaReportView = { statuses, statusKey, statusMeta, statusTag, externalLink, renderOverview, createSection, appendStatusOptions, createEmptyState,
    lineCountLabel, formatReportCode, createCodePreview, createPreview };
})(window);
