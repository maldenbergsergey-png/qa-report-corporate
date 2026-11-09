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

  function createColumnPins(view, changed) {
    const state = { qa: true, point: false };
    function render(scope = view) {
      view.dataset.pinQa = String(state.qa);
      view.dataset.pinPoint = String(state.point);
      for (const button of scope.querySelectorAll("[data-pin-column]")) {
        const pinned = state[button.dataset.pinColumn];
        const name = button.dataset.pinColumn === "qa" ? "Статус" : "№";
        button.setAttribute("aria-pressed", String(pinned));
        button.title = `${pinned ? "Открепить" : "Закрепить"} столбец «${name}»`;
        button.setAttribute("aria-label", button.title);
      }
    }
    view.addEventListener("click", event => {
      const button = event.target.closest("button[data-pin-column]");
      if (!button || !view.contains(button)) return;
      event.stopPropagation();
      state[button.dataset.pinColumn] = !state[button.dataset.pinColumn];
      render();
      changed();
      button.focus({ preventScroll: true });
    });
    function attach(table) {
      for (const [key, selector] of [["point", ".point-index"], ["qa", ".qa-status"]]) {
        const header = table.tHead.querySelector(selector);
        const heading = element("span", "report-column-heading");
        const button = element("button", "column-pin");
        button.type = "button";
        button.dataset.pinColumn = key;
        // Lucide pin, ISC license in LICENSE-icons.txt.
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        for (const d of ["M12 17v5", "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"]) {
          const path = document.createElementNS(svg.namespaceURI, "path");
          path.setAttribute("d", d);
          svg.append(path);
        }
        button.append(svg);
        heading.append(button, element("span", "", header.textContent));
        header.replaceChildren(heading);
      }
      render(table);
    }
    render();
    return { state, attach, reset() { state.qa = true; state.point = false; render(); } };
  }

  function arrangeTableColumns(table, settings) {
    const columns = root.QaReportSharedTableLayout.columns(settings);
    const lastQa = columns.order.at(-1) === "qa";
    for (const row of [table.tHead.rows[0], ...table.tBodies[0].rows]) {
      const qa = row.querySelector(".qa-status");
      const spacer = row.querySelector(".report-scroll-spacer");
      const answer = row.querySelector(".correction-status");
      if (lastQa) {
        if (row.lastElementChild !== qa || qa.previousElementSibling !== spacer) row.append(spacer, qa);
      } else if (settings.qaPinned) {
        if (qa.nextElementSibling !== answer) row.insertBefore(qa, answer);
        if (spacer.nextElementSibling !== qa) row.insertBefore(spacer, qa);
      } else {
        if (spacer.nextElementSibling !== answer) row.insertBefore(spacer, answer);
        if (qa.nextElementSibling !== spacer) row.insertBefore(qa, spacer);
      }
    }
    let group = table.querySelector("colgroup");
    if (!group) { group = element("colgroup"); table.prepend(group); }
    group.replaceChildren(...columns.widths.map(width => {
      const column = element("col"); column.style.width = `${width}px`; return column;
    }));
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

  function statusFilterLabel(selected) {
    if (!selected?.size) return "Все";
    return selected.size === 1 ? [...selected][0] : `Выбрано ${selected.size}`;
  }

  function createOverviewControl({ view, overview, toggle, pin, scrollport, onLayout }) {
    view.addEventListener("keydown", event => {
      if (event.key === "Tab" || event.key.startsWith("Arrow")) view.classList.add("keyboard-navigation");
    }, true);
    view.addEventListener("pointerdown", () => view.classList.remove("keyboard-navigation"), true);
    let hasOverview = false;
    let pinned = false;
    let lastOverviewScroll = 0;
    let collapseOverviewAfter = 0;
    let manuallyCollapsedOverview = false;

    function deferOverviewCollapse() {
      collapseOverviewAfter = Math.max(scrollport.scrollTop, overview.offsetHeight + 16) + 48;
    }

    function setOverviewExpanded(expanded, preservePosition = true) {
      if (!hasOverview) return;
      const before = scrollport.getBoundingClientRect().top;
      const scrollTop = scrollport.scrollTop;
      if (!expanded && overview.contains(document.activeElement)) toggle.focus({ preventScroll: true });
      overview.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.title = expanded ? "Свернуть сведения об отчёте" : "Показать сведения об отчёте";
      if (preservePosition) {
        // Compensate for the changed viewport so the current checklist point stays in place.
        scrollport.scrollTop = scrollTop + scrollport.getBoundingClientRect().top - before;
      }
      lastOverviewScroll = scrollport.scrollTop;
      if (expanded) deferOverviewCollapse();
      onLayout();
    }

    toggle.addEventListener("click", () => {
      const expanded = overview.hidden;
      manuallyCollapsedOverview = !expanded;
      if (!expanded && pinned) setOverviewPinned(false);
      setOverviewExpanded(expanded);
    });

    function setOverviewPinned(next) {
      pinned = next;
      pin.setAttribute("aria-pressed", String(pinned));
      pin.title = pinned ? "Открепить сведения" : "Закрепить сведения";
      pin.setAttribute("aria-label", pin.title);
      toggle.classList.toggle("is-pinned", pinned);
      if (pinned) {
        manuallyCollapsedOverview = false;
        setOverviewExpanded(true);
      } else deferOverviewCollapse();
    }
    pin.addEventListener("click", () => setOverviewPinned(!pinned));

    scrollport.addEventListener("scroll", () => {
      const top = scrollport.scrollTop;
      if (!hasOverview || pinned) { lastOverviewScroll = top; return; }
      if (overview.hidden) {
        if (top > lastOverviewScroll + 1) manuallyCollapsedOverview = false;
        if (!manuallyCollapsedOverview && top <= 1 && lastOverviewScroll > top) setOverviewExpanded(true);
      } else if (top > lastOverviewScroll && top > collapseOverviewAfter &&
        !(view.classList.contains("keyboard-navigation") && overview.contains(document.activeElement))) {
        // Only collapse after enough travel to preserve the point's on-screen position.
        setOverviewExpanded(false);
      }
      lastOverviewScroll = scrollport.scrollTop;
    }, { passive: true });

    const sizeObserver = new ResizeObserver(() => {
      if (hasOverview && !overview.hidden && scrollport.scrollTop <= 1) deferOverviewCollapse();
      onLayout();
    });
    sizeObserver.observe(overview);
    return {
      reset(available) {
        hasOverview = available;
        manuallyCollapsedOverview = false;
        lastOverviewScroll = scrollport.scrollTop;
        toggle.hidden = !available;
        toggle.setAttribute("aria-expanded", String(available));
        setOverviewPinned(false);
        if (available) setOverviewExpanded(true, false);
      },
    };
  }

  function createPreview(dialog, openFile, extractCode) {
    const filter = dialog.querySelector(".report-status-filter");
    const filterValue = filter.querySelector("#previewFilterValue");
    const filterOptions = filter.querySelector("fieldset");
    const filterReset = filter.querySelector("button");
    const order = dialog.querySelector(".report-view-order");
    const counts = dialog.querySelector(".counts");
    const overview = dialog.querySelector(".report-overview");
    const sections = dialog.querySelector(".report-view-sections");
    const empty = dialog.querySelector(".report-view-empty");
    const emptyMessage = element("p");
    const emptyReset = element("button", "report-view-reset", "Показать все пункты");
    emptyReset.type = "button";
    empty.append(emptyMessage, emptyReset);
    const imageDialog = dialog.querySelector(".report-image-dialog");
    const openCode = createCodeViewer(dialog.querySelector(".report-code-dialog"));
    const image = imageDialog.querySelector("img");
    const imageTitle = imageDialog.querySelector("h2");
    let groups = [];
    let selectedStatuses = null;
    const scrollport = dialog.querySelector(".report-content");
    const intro = overview.querySelector(".intro");
    const introContent = intro.querySelector(".intro-content");
    const introToggle = intro.querySelector("button");
    let layoutKey;
    let layouts = [];
    let layoutFrame;
    const pins = createColumnPins(dialog, syncLayout);
    const overviewControl = createOverviewControl({ view: dialog, overview,
      toggle: dialog.querySelector(".overview-toggle"), pin: overview.querySelector(".overview-pin"),
      scrollport, onLayout: scheduleLayout });

    function syncLayout() {
      if (!dialog.open) return;
      if (!intro.hidden) introToggle.hidden = introContent.scrollHeight <= parseFloat(getComputedStyle(introContent).lineHeight) * 6 + 1;
      const viewportWidth = scrollport.clientWidth;
      if (!viewportWidth || !groups.length) return;
      const pinColumns = pins.state.qa;
      const key = JSON.stringify([viewportWidth, pinColumns, [...(selectedStatuses || [])].sort(), groups.map(group => group.section.hidden)]);
      if (key !== layoutKey) {
        const styles = getComputedStyle(dialog);
        const width = name => parseFloat(styles.getPropertyValue(name));
        const indices = [...sections.querySelectorAll("tbody tr:not([hidden]) .point-index")];
        const longest = indices.reduce((before, cell) => !before || cell.textContent.length > before.textContent.length ? cell : before, null);
        const range = document.createRange();
        if (longest) range.selectNodeContents(longest);
        const pointWidth = Math.max(64, longest ? Math.ceil(range.getBoundingClientRect().width) + 20 : 0);
        dialog.style.setProperty("--point-index-width", `${pointWidth}px`);
        const pinnedWidths = [width("--qa-status-width")];
        const plan = root.QaReportSharedTableLayout.plan({ viewportWidth, pointWidth,
          dataMinWidth: width("--report-data-min-width"), pinnedWidths, pinColumns,
          sections: groups.map(group => ({ columnCount: group.columnCount, hidden: group.section.hidden })),
        });
        sections.style.width = `${plan.canvasWidth}px`;
        sections.style.setProperty("--report-viewport-width", `${viewportWidth}px`);
        layouts = plan.sections;
        groups.forEach((group, index) => {
          const layout = layouts[index];
          group.table.style.width = `${layout.width}px`;
          arrangeTableColumns(group.table, { pointWidth, columnCount: group.columnCount,
            columnWidth: layout.columnWidth, spacerWidth: layout.spacerWidth, qaWidth: pinnedWidths[0],
            answerWidths: [], qaPinned: pinColumns, pinAnswers: false });
        });
        layoutKey = key;
      }
      const scrollLeft = scrollport.scrollLeft;
      sections.style.setProperty("--report-scroll-left", `${scrollLeft}px`);
      groups.forEach((group, index) => {
        const state = root.QaReportSharedTableLayout.scrollState(layouts[index], scrollLeft);
        group.section.style.setProperty("--data-shift", `${pinColumns ? state.offset : 0}px`);
        group.section.style.setProperty("--table-shift", `${pinColumns ? 0 : state.offset}px`);
        group.table.parentElement.classList.toggle("has-hidden-left", state.hiddenLeft);
        group.table.classList.toggle("has-pinned-overlap", state.hiddenRight);
      });
    }
    function scheduleLayout() {
      if (layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => { layoutFrame = undefined; syncLayout(); });
    }
    const layoutObserver = new ResizeObserver(scheduleLayout);
    layoutObserver.observe(scrollport);
    layoutObserver.observe(introContent);
    scrollport.addEventListener("scroll", scheduleLayout, { passive: true });
    introToggle.addEventListener("click", () => {
      const expanded = intro.dataset.expanded !== "true";
      intro.dataset.expanded = String(expanded);
      introToggle.setAttribute("aria-expanded", String(expanded));
      introToggle.textContent = expanded ? "Свернуть" : "Развернуть";
    });

    function resetFilter() {
      selectedStatuses = null;
      update();
      filter.open = false;
      filter.querySelector("summary").focus();
    }
    filterReset.addEventListener("click", resetFilter);
    emptyReset.addEventListener("click", resetFilter);
    dialog.addEventListener("click", event => { if (!filter.contains(event.target)) filter.open = false; });
    filter.addEventListener("keydown", event => {
      // A label click briefly moves focus outside before activating its checkbox.
      // Closing <details> during that native activation can crash Chromium.
      if (event.key === "Tab") {
        requestAnimationFrame(() => { if (!filter.contains(document.activeElement)) filter.open = false; });
        return;
      }
      if (event.key !== "Escape" || !filter.open) return;
      event.preventDefault();
      filter.open = false;
      filter.querySelector("summary").focus();
    });

    function configureFilter(defaults) {
      selectedStatuses = defaults == null ? null : new Set([...defaults].map(statusKey));
      const statusCounts = new Map();
      for (const row of groups.flatMap(group => group.rows)) statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);
      const choices = new Set([...statuses.keys(), ...statusCounts.keys(), ...(selectedStatuses || [])]);
      const available = element("div");
      const unavailable = element("div", "preview-filter-unavailable");
      unavailable.append(element("p", "preview-filter-heading", "Нет в отчёте"));
      for (const status of choices) {
        const label = element("label");
        const input = element("input");
        input.type = "checkbox";
        input.value = status;
        input.disabled = !statusCounts.has(status) && !selectedStatuses?.has(status);
        input.addEventListener("change", () => {
          selectedStatuses ||= new Set();
          if (input.checked) selectedStatuses.add(status);
          else selectedStatuses.delete(status);
          if (!selectedStatuses.size) selectedStatuses = null;
          update();
        });
        label.append(input, element("span", "", status || "Статус не указан"), element("span", "preview-filter-count", String(statusCounts.get(status) || 0)));
        (input.disabled ? unavailable : available).append(label);
      }
      filterOptions.replaceChildren(available, ...(unavailable.children.length > 1 ? [unavailable] : []));
    }

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
      filter.open = false;
      for (const group of groups) layoutObserver.unobserve(group.table);
      sections.replaceChildren();
      sections.removeAttribute("style");
      introContent.replaceChildren();
      groups = [];
      layouts = [];
      layoutKey = undefined;
    });

    function update() {
      let visible = 0;
      let total = 0;
      for (const group of groups) {
        const rows = order.value === "priority"
          ? [...group.rows].sort((a, b) => statusMeta(a.status).rank - statusMeta(b.status).rank)
          : group.rows;
        let matching = 0;
        rows.forEach(({ status, node }, index) => {
          node.hidden = selectedStatuses !== null && !selectedStatuses.has(status);
          if (!node.hidden) matching++;
          if (group.body.rows[index] !== node) group.body.insertBefore(node, group.body.rows[index] || null);
        });
        total += rows.length;
        visible += matching;
        group.section.hidden = !matching;
      }
      counts.textContent = `${visible} из ${total}`;
      counts.setAttribute("aria-label", `Показано ${visible} из ${total}`);
      filterValue.textContent = statusFilterLabel(selectedStatuses);
      filter.dataset.multiple = String((selectedStatuses?.size || 0) > 1);
      filterValue.title = [...(selectedStatuses || [])].join(", ");
      filterReset.disabled = selectedStatuses === null;
      for (const input of filterOptions.querySelectorAll("input")) input.checked = Boolean(selectedStatuses?.has(input.value));
      empty.hidden = visible > 0;
      emptyMessage.textContent = total ? "Пунктов с выбранными статусами нет" : "В чек-листе пока нет заполненных пунктов";
      emptyReset.hidden = selectedStatuses === null;
      scheduleLayout();
    }
    order.addEventListener("change", update);

    return function open(report, selectedStatuses) {
      if (dialog.open) return;
      pins.reset();
      order.value = "original";
      intro.dataset.expanded = "false";
      introToggle.setAttribute("aria-expanded", "false");
      introToggle.textContent = "Развернуть";
      introToggle.hidden = true;
      const title = report.title?.trim() || root.QaReportTrackerLinks.parse(report.issueUrl)?.key || "Отчёт о тестировании";
      dialog.querySelector("h1").textContent = title;
      dialog.querySelector("h1").title = title;
      const append = (target, html) => readContent(target, html, openImage, openFile, openCode, extractCode);
      renderOverview(overview, report, target => append(target, report.intro));
      groups = report.sections.map(({ title, columns, rows }) => {
        const group = createSection(title, columns.map(column => column.title || "Без названия"));
        const table = group.section.querySelector("table");
        pins.attach(table);
        const spacer = element("th", "report-scroll-spacer");
        spacer.setAttribute("aria-hidden", "true");
        table.tHead.rows[0].querySelector(".qa-status").before(spacer);
        layoutObserver.observe(table);
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
          const spacer = element("td", "report-scroll-spacer");
          spacer.setAttribute("aria-hidden", "true");
          tr.append(spacer, status);
          return { node: tr, status: statusKey(row.status) };
        });
        return { ...group, table, columnCount: columns.length, rows: entries };
      });
      configureFilter(selectedStatuses);
      sections.replaceChildren(...groups.map(group => group.section));
      update();
      dialog.showModal();
      scrollport.scrollTo(0, 0);
      overviewControl.reset(!overview.hidden);
      syncLayout();
    };
  }

  root.QaReportView = { statuses, statusKey, statusMeta, statusTag, externalLink, renderOverview, createSection, appendStatusOptions, createEmptyState,
    lineCountLabel, formatReportCode, createCodePreview, createPreview, createColumnPins, arrangeTableColumns, createOverviewControl, statusFilterLabel };
})(window);
