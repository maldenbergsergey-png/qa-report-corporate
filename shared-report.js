(() => {
  "use strict";

  function initThemePicker() {
    const toggle = document.getElementById("shared-theme-toggle");
    const menu = document.getElementById("shared-theme-menu");
    const choices = [...menu.querySelectorAll("[data-report-theme]")];
    const storageKey = "qa-report-shared-theme";
    const applyTheme = theme => {
      document.documentElement.dataset.theme = theme;
      const themeColor = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
      if (themeColor) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
      for (const choice of choices) choice.setAttribute("aria-pressed", String(choice.dataset.reportTheme === theme));
    };
    const setMenuOpen = open => {
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector('[aria-pressed="true"]')?.focus();
    };
    let theme = "graphite";
    try {
      const available = choices.map(choice => choice.dataset.reportTheme);
      theme = [localStorage.getItem(storageKey), localStorage.getItem("qa-report-theme")]
        .find(value => available.includes(value)) || theme;
    } catch {}
    applyTheme(theme);
    toggle.addEventListener("click", () => setMenuOpen(menu.hidden));
    for (const choice of choices) choice.addEventListener("click", () => {
      applyTheme(choice.dataset.reportTheme);
      try { localStorage.setItem(storageKey, choice.dataset.reportTheme); } catch {}
      setMenuOpen(false);
      toggle.focus();
    });
    const picker = toggle.parentElement;
    document.addEventListener("click", event => {
      if (!menu.hidden && !picker.contains(event.target)) setMenuOpen(false);
    });
    picker.addEventListener("focusout", event => {
      if (!menu.hidden && !picker.contains(event.relatedTarget)) setMenuOpen(false);
    });
    picker.addEventListener("keydown", event => {
      if (event.key !== "Escape" || menu.hidden) return;
      event.preventDefault();
      setMenuOpen(false);
      toggle.focus();
    });
  }

  initThemePicker();
  const reportId = /^\/shared-report\/([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1];
  const token = /^#([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1];
  const api = `/api/shared-reports/${reportId}`;
  window.addEventListener("hashchange", () => location.reload());
  const pageState = document.getElementById("page-state");
  const filter = document.getElementById("report-filter");
  const filterValue = document.getElementById("report-filter-value");
  const filterOptions = document.getElementById("report-filter-options");
  const filterReset = document.getElementById("report-filter-reset");
  const noMatches = document.getElementById("no-matches");
  const noMatchesMessage = document.getElementById("no-matches-message");
  const noMatchesReset = document.getElementById("no-matches-reset");
  const selectedStatuses = new Set();
  const order = document.getElementById("report-order");
  const counts = document.getElementById("report-count");
  const view = document.getElementById("report");
  const {
    statuses, statusKey, statusMeta, statusTag, externalLink, renderOverview, createSection,
    lineCountLabel, formatReportCode, createCodePreview, createColumnPins, arrangeTableColumns, createOverviewControl, statusFilterLabel,
  } = window.QaReportView;
  const saveIndicator = document.getElementById("saveState");
  const saveLabel = saveIndicator.querySelector(".save-state-label");
  const commentTools = window.QaReportSharedComment;
  const commentToolbar = document.getElementById("reply-comment-toolbar");
  const activateCommentTools = commentTools.bind(commentToolbar);
  let activeComment;
  function hideCommentToolsOutside(event) {
    if (!activeComment || activeComment.contains(event.target) || commentToolbar.contains(event.target)) return;
    activeComment = undefined;
    activateCommentTools(null);
  }
  document.addEventListener("focusin", hideCommentToolsOutside);
  document.addEventListener("pointerdown", hideCommentToolsOutside);
  const pendingAnswers = new Map();
  const saveLabels = {
    saved: "Сохранено",
    dirty: "Есть несохранённые изменения",
    saving: "Сохраняем изменения…",
    error: "Ошибка сохранения",
  };
  const dateFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });
  const answers = new Map();
  const answerFiles = new Map();
  let draggedAnswerAttachment;
  const maxAnswerFileSize = 10 * 1024 * 1024;
  const maxAnswerFilesPerPoint = 10;
  const files = new Map();
  const pendingAttachmentCards = new Map();
  const sections = [];
  const rasterTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const imagePreviews = new Map();
  const imagePreviewUrls = new Set();
  const thumbnailQueue = [];
  const thumbnailLoads = new WeakMap();
  let activeThumbnailLoads = 0;
  const thumbnailObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) continue;
        thumbnailObserver.unobserve(target);
        const load = thumbnailLoads.get(target);
        if (load) queueThumbnail(load);
        thumbnailLoads.delete(target);
      }
    }, { rootMargin: "160px" })
    : null;
  window.addEventListener("pagehide", event => {
    if (!event.persisted) imagePreviewUrls.forEach(url => URL.revokeObjectURL(url));
  });
  const answerStatuses = new Map([
    ["unreviewed", { label: "Не рассмотрено", tone: "neutral" }],
    ["fixed", { label: "Исправлено", tone: "positive" }],
    ["not_fixed", { label: "Не исправлено", tone: "negative" }],
    ["needs_clarification", { label: "Требует уточнения", tone: "clarification" }],
    ["clarified", { label: "Уточнено", tone: "informative" }],
    ["no_changes_needed", { label: "Изменения не требуются", tone: "positive" }],
    ["deferred", { label: "Отложено", tone: "muted" }],
  ]);
  const emptyAnswer = { status: "unreviewed", comment: "", revision: 0 };
  const answerRows = new Map();
  const answerPanel = document.getElementById("answer-panel");
  const panelStatus = document.getElementById("answer-panel-status");
  const panelComment = document.getElementById("answer-panel-comment");
  const answerViewButtons = [...document.querySelectorAll("[data-answer-view]")];
  const contentViewport = document.querySelector(".report-content");
  let selectedAnswerKey;
  let hostedAnswer;
  let modeFocus;
  // Every newly opened report starts with the reply panel.
  let answerView = "side";

  function rememberEditorFocus() {
    const active = document.activeElement;
    if (!active?.matches(".answer-comment-input, .correction-status select, .answer-status-slot select")) return null;
    const selection = window.getSelection();
    return { active, ...(selection?.rangeCount && active.contains(selection.anchorNode) && active.contains(selection.focusNode)
      ? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset } : {}) };
  }

  function restoreEditorFocus(focus) {
    if (!focus?.active.isConnected) return;
    focus.active.focus({ preventScroll: true });
    if (focus.anchor?.isConnected && focus.focus?.isConnected) {
      window.getSelection().setBaseAndExtent(focus.anchor, focus.anchorOffset, focus.focus, focus.focusOffset);
    }
  }

  function returnPanelEditor() {
    if (!hostedAnswer) return;
    hostedAnswer.statusCell.append(...hostedAnswer.statusNodes);
    hostedAnswer.commentCell.append(...hostedAnswer.commentNodes);
    hostedAnswer = undefined;
  }

  function showSelectedAnswer() {
    const record = answerRows.get(selectedAnswerKey);
    for (const candidate of answerRows.values()) {
      candidate.row.classList.toggle("answer-selected", candidate === record);
      candidate.row.tabIndex = answerView === "side" ? 0 : -1;
      if (answerView === "side") candidate.row.setAttribute("aria-selected", String(candidate === record));
      else candidate.row.removeAttribute("aria-selected");
    }
    const show = answerView === "side" && record && !record.row.hidden;
    answerPanel.hidden = !show;
    if (!show) {
      returnPanelEditor();
      return;
    }
    if (hostedAnswer !== record) {
      returnPanelEditor();
      panelStatus.replaceChildren(...record.statusNodes);
      panelComment.replaceChildren(...record.commentNodes);
      hostedAnswer = record;
    }
    document.getElementById("answer-panel-title").textContent = `Раздел ${record.sectionNumber} · Пункт ${record.number.replace(/[.\s]+$/u, "")}`;
    document.getElementById("answer-panel-check").textContent = record.title;
    document.getElementById("answer-panel-qa-status").replaceChildren(statusTag(record.qaStatus));
    document.getElementById("answer-panel-fields").dataset.tone = record.statusCell.dataset.tone;
    panelStatus.dataset.tone = record.statusCell.dataset.tone;
    document.getElementById("answer-panel-help").textContent = record.canReply
      ? "Изменения сохраняются автоматически" : "Только просмотр";
    document.getElementById("answer-panel-status-label").htmlFor = panelStatus.querySelector("select")?.id || "";
  }

  function ensureSelectedAnswer() {
    if (!answerRows.get(selectedAnswerKey) || answerRows.get(selectedAnswerKey).row.hidden) {
      selectedAnswerKey = sections.flatMap(section => [...section.points.children])
        .find(row => !row.hidden)?.dataset.answerKey;
    }
    showSelectedAnswer();
  }

  function setAnswerView(next, focus) {
    const scroll = { top: contentViewport.scrollTop, left: contentViewport.scrollLeft };
    const selectedRow = answerRows.get(selectedAnswerKey)?.row;
    const rowOffset = selectedRow?.getBoundingClientRect().top - contentViewport.getBoundingClientRect().top;
    activeComment = undefined;
    activateCommentTools(null);
    answerView = next;
    view.dataset.answerView = next;
    for (const control of answerViewButtons) control.setAttribute("aria-pressed", String(control.dataset.answerView === next));
    ensureSelectedAnswer();
    syncReportLayout();
    contentViewport.scrollTop = scroll.top;
    contentViewport.scrollLeft = scroll.left;
    if (selectedRow && Number.isFinite(rowOffset)) {
      contentViewport.scrollTop += selectedRow.getBoundingClientRect().top - contentViewport.getBoundingClientRect().top - rowOffset;
    }
    restoreEditorFocus(focus);
    syncReportLayout();
  }

  for (const control of answerViewButtons) {
    control.addEventListener("pointerdown", () => { modeFocus = rememberEditorFocus(); });
    control.addEventListener("click", () => {
      setAnswerView(control.dataset.answerView, modeFocus);
      modeFocus = undefined;
    });
  }

  function registerAnswer(row, key, number, canReply, statusCell, commentCell) {
    const record = { row, key, number, canReply, statusCell, commentCell,
      statusNodes: [...statusCell.childNodes], commentNodes: [...commentCell.childNodes],
      title: row.dataset.pointCaption || row.querySelector(".report-cell")?.innerText.trim() || `Пункт ${number}`,
      sectionNumber: row.dataset.sectionNumber,
      qaStatus: row.querySelector(".qa-status .report-tag")?.textContent || "" };
    row.dataset.answerKey = key;
    const select = statusCell.querySelector("select");
    if (select) select.id = `shared-answer-status-${answerRows.size}`;
    answerRows.set(key, record);
    const choose = () => { selectedAnswerKey = key; if (answerView === "side") showSelectedAnswer(); };
    row.addEventListener("focusin", choose);
    row.addEventListener("click", event => {
      if (answerView !== "side" || event.target.closest("a, button, input, select, textarea, [contenteditable], [role=button]")) return;
      choose();
    });
    row.addEventListener("keydown", event => {
      if (answerView !== "side" || event.target !== row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      choose();
      (panelStatus.querySelector("select") || panelComment.querySelector("[contenteditable]"))?.focus();
    });
  }

  const overview = document.getElementById("report-overview");
  const overviewControl = createOverviewControl({ view, overview,
    toggle: document.getElementById("report-overview-toggle"), pin: document.getElementById("report-overview-pin"),
    scrollport: contentViewport, onLayout: syncReportLayout });

  const intro = document.getElementById("report-intro");
  const introContent = document.getElementById("report-intro-content");
  const introToggle = document.getElementById("report-intro-toggle");
  introToggle.addEventListener("click", () => {
    const expanded = intro.dataset.expanded !== "true";
    intro.dataset.expanded = String(expanded);
    introToggle.setAttribute("aria-expanded", String(expanded));
    introToggle.textContent = expanded ? "Свернуть" : "Развернуть";
  });
  let reportLayoutKey;
  let sectionLayouts = [];
  const pins = createColumnPins(view, syncReportLayout, {
    replyStatus: [".response-status", "Статус ответа"],
    replyComment: [".response-comment", "Комментарий к ответу"],
  });
  function prepareRetestRow(row, columns) {
    const cells = Array.from(row.cells);
    const answerColumns = cells.filter(cell => cell.matches('.report-cell')).slice(-2);
    answerColumns[0].classList.add('response-status');
    answerColumns[1].classList.add('response-comment');
    const expected = columns.findIndex(column => column.id === 'expected' || /^ожидаемый результат$/i.test(column.label.trim()));
    if (cells[0].tagName === 'TH' && row.parentElement?.tagName === 'THEAD') row.querySelector('.qa-status').title = 'Статус при публикации';
    const status = row.querySelector('.qa-status');
    if (expected >= 0) cells[expected + 1].after(status);
    else answerColumns[0].before(status);
    row.querySelector('.report-scroll-spacer')?.remove();
  }

  function layoutRetestTables(viewportWidth) {
    const key = JSON.stringify([viewportWidth, answerView, pins.state, sections.map(section => section.element.hidden)]);
    if (key === reportLayoutKey) return;
    reportLayoutKey = key;
    const compact = viewportWidth < 620;
    const defaults = { point: compact ? 46 : 56, qa: compact ? 90 : 132, replyStatus: compact ? 96 : 158,
      replyComment: compact ? 140 : 218, result: compact ? 144 : 162, note: compact ? 170 : 225, field: compact ? 172 : 182 };
    const pinSize = Object.keys(pins.state).reduce((total, id) => total + (pins.state[id] ? defaults[id] : 0), 0);
    const scale = Math.min(1, viewportWidth * (compact ? .60 : .70) / (pinSize || 1));
    const size = id => Math.round(pins.state[id] ? defaults[id] * scale : defaults[id]);
    const remaining = viewportWidth - Object.keys(pins.state).reduce((total, id) => total + (pins.state[id] ? size(id) : 0), 0);
    function columnId(cell) {
      if (cell.matches('.response-status')) return 'replyStatus';
      if (cell.matches('.response-comment')) return 'replyComment';
      if (cell.matches('.point-index')) return 'point';
      if (cell.matches('.qa-status')) return 'qa';
      if (cell.matches('.correction-status')) return 'result';
      if (cell.matches('.correction-comment')) return 'note';
      return 'field';
    }
    const plans = sections.map(section => {
      const headers = Array.from(section.table.tHead.rows[0].cells);
      const columns = headers.map((header, index) => {
        const id = columnId(header);
        const qaInput = id === 'result' || id === 'note';
        const width = compact && qaInput ? Math.min(size(id), remaining) : size(id);
        return {id, index, width, visible: !qaInput || answerView === 'table'};
      }).filter(column => column.visible);
      return {section, columns, min: columns.reduce((n, col) => n + col.width, 0)};
    });
    const canvasWidth = Math.max(viewportWidth, ...plans.filter(plan => !plan.section.element.hidden).map(plan => plan.min));
    const root = document.getElementById('report-sections');
    root.style.width = canvasWidth + 'px';
    root.style.setProperty('--report-viewport-width', viewportWidth + 'px');
    for (const {section, columns, min} of plans) {
      const fields = columns.filter(col => col.id === 'field');
      const stretch = fields.length ? fields : columns.filter(col => col.id === 'note' || col.id === 'replyComment');
      const extra = (canvasWidth - min) / (stretch.length || 1);
      for (const column of stretch) column.width += Math.max(0, extra);
      const table = section.table;
      table.style.width = Math.max(min, canvasWidth) + 'px';
      let group = table.querySelector('colgroup');
      if (!group) { group = element('colgroup'); table.prepend(group); }
      group.replaceChildren(...columns.map(column => {
        const col = element('col'); col.style.width = column.width + 'px'; return col;
      }));
      // An active pin stays on screen from either scroll direction, in document order.
      let before = 0;
      const total = columns.reduce((n, col) => n + (pins.state[col.id] ? col.width : 0), 0);
      for (const col of columns) {
        const pinned = Boolean(pins.state[col.id]);
        for (const row of table.rows) {
          const cell = row.cells[col.index];
          cell.toggleAttribute('data-retest-pinned', pinned);
          if (pinned) {
            cell.style.setProperty('--pin-left', before + 'px');
            cell.style.setProperty('--pin-right', (total - before - col.width) + 'px');
          }
        }
        if (pinned) before += col.width;
      }
    }
  }

  function syncReportLayout() {
    const viewportWidth = contentViewport.clientWidth;
    if (!viewportWidth || !sections.length) return;
    if (view.hasAttribute("data-retest-table")) {
      layoutRetestTables(viewportWidth);
      return;
    }
    const pinAnswers = answerView === "table" && matchMedia("(min-width: 761px)").matches;
    const pinColumns = pins.state.qa || pinAnswers;
    view.dataset.pinAnswers = String(pinAnswers);
    const key = JSON.stringify([viewportWidth, answerView, pins.state.qa, pinAnswers, [...selectedStatuses].sort(), sections.map(section => section.element.hidden)]);
    if (key !== reportLayoutKey) {
      const styles = getComputedStyle(view);
      const width = name => parseFloat(styles.getPropertyValue(name));
      const pinnedWidths = [width("--qa-status-width"), ...(answerView === "table"
        ? [width("--answer-status-width"), width("--answer-comment-width")] : [])];
      const indices = [...document.querySelectorAll("#report-sections tbody tr:not([hidden]) .point-index")];
      const longest = indices.reduce((before, cell) => !before || cell.textContent.length > before.textContent.length ? cell : before, null);
      const range = document.createRange();
      if (longest) range.selectNodeContents(longest);
      const pointWidth = Math.max(64, longest ? Math.ceil(range.getBoundingClientRect().width) + 20 : 0);
      view.style.setProperty("--point-index-width", `${pointWidth}px`);
      view.style.setProperty("--pinned-answers-width", `${pinAnswers ? pinnedWidths[1] + pinnedWidths[2] : 0}px`);
      const plan = window.QaReportSharedTableLayout.plan({ viewportWidth, pointWidth,
        dataMinWidth: width("--report-data-min-width"), pinnedWidths, pinColumns,
        sections: sections.map(section => ({ columnCount: section.columnCount, hidden: section.element.hidden })),
      });
      const root = document.getElementById("report-sections");
      root.style.width = `${plan.canvasWidth}px`;
      root.style.setProperty("--report-viewport-width", `${viewportWidth}px`);
      sectionLayouts = plan.sections;
      sections.forEach((section, index) => {
        const layout = sectionLayouts[index];
        section.table.style.width = `${layout.width}px`;
        arrangeTableColumns(section.table, { pointWidth, columnCount: section.columnCount,
          columnWidth: layout.columnWidth, spacerWidth: layout.spacerWidth, qaWidth: pinnedWidths[0],
          answerWidths: pinnedWidths.slice(1), qaPinned: pins.state.qa, pinAnswers });
      });
      reportLayoutKey = key;
    }
    const scrollLeft = contentViewport.scrollLeft;
    document.getElementById("report-sections").style.setProperty("--report-scroll-left", `${scrollLeft}px`);
    sections.forEach((section, index) => {
      const layout = sectionLayouts[index];
      // Shorter sections stop at their own last column while sharing the report scrollbar.
      const state = window.QaReportSharedTableLayout.scrollState(layout, scrollLeft);
      section.element.style.setProperty("--data-shift", `${layout.pinColumns ? state.offset : 0}px`);
      section.element.style.setProperty("--table-shift", `${layout.pinColumns ? 0 : state.offset}px`);
      section.table.parentElement.classList.toggle("has-hidden-left", state.hiddenLeft);
      section.table.classList.toggle("has-pinned-overlap", state.hiddenRight);
    });
    if (!intro.hidden) introToggle.hidden = introContent.scrollHeight <= parseFloat(getComputedStyle(introContent).lineHeight) * 6 + 1;
  }
  const layoutObserver = new ResizeObserver(syncReportLayout);
  let layoutFrame;
  contentViewport.addEventListener("scroll", () => {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = undefined; syncReportLayout(); });
  }, { passive: true });
  layoutObserver.observe(contentViewport);
  layoutObserver.observe(introContent);
  layoutObserver.observe(overview);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className) {
    const node = element("button", className, label);
    node.type = "button";
    return node;
  }

  function objectAction(icon, title, action) {
    const control = button(undefined, "object-action-button");
    control.title = title;
    control.setAttribute("aria-label", title);
    control.append(objectIcon(icon));
    control.addEventListener("click", action);
    return control;
  }

  function objectIcon(icon) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", `#shared-icon-${icon}`);
    svg.setAttribute("aria-hidden", "true");
    svg.append(use);
    return svg;
  }

  async function copyText(text, container, trigger) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = element("textarea", "clipboard-fallback");
      input.value = text;
      input.readOnly = true;
      container.append(input);
      input.select();
      try {
        if (!document.execCommand("copy")) throw new Error("Не удалось скопировать текст.");
      } finally {
        input.remove();
        trigger.focus({ preventScroll: true });
      }
    }
  }

  const sharedViewer = document.getElementById("shared-viewer");
  const viewerPart = name => document.getElementById(`shared-viewer-${name}`);
  const viewerKind = viewerPart("kind");
  const viewerTitle = viewerPart("title");
  const viewerDetail = viewerPart("detail");
  const viewerMessage = viewerPart("message");
  const viewerOptions = viewerPart("options");
  const viewerSource = viewerPart("source");
  const viewerText = viewerPart("text");
  const viewerLines = viewerPart("lines");
  const viewerImage = viewerPart("image");
  const viewerMedia = viewerPart("media");
  const viewerCopy = viewerPart("copy");
  const viewerWrap = viewerPart("wrap");
  const viewerReadable = viewerPart("readable");
  const viewerEncoding = viewerPart("encoding");
  const viewerFooter = viewerPart("footer");
  const viewerActionState = viewerPart("action-state");
  let viewerState;

  function setViewerMessage(text = "") {
    viewerMessage.textContent = text;
    viewerMessage.hidden = !text;
  }

  function updateViewerText() {
    const text = viewerReadable.checked ? viewerState.readable : viewerState.source;
    viewerText.textContent = text;
    viewerText.classList.toggle("wrap-lines", viewerState.kind === "file" && viewerWrap.checked);
    const count = text.split(/\r\n|\r|\n/).length;
    if (viewerState.kind === "code") {
      viewerLines.textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
      viewerLines.scrollTop = viewerText.scrollTop;
      viewerDetail.textContent = lineCountLabel(count);
    } else {
      viewerActionState.textContent = text ? `${lineCountLabel(count)} · Только просмотр` : "Пустой файл";
      viewerCopy.textContent = "Копировать текст";
      viewerCopy.disabled = !text;
    }
  }

  function showViewerText({ text = "", readable, encoding, error }) {
    const tools = window.QaReportFilePreview;
    const code = viewerState.kind === "code";
    viewerState.source = text;
    viewerState.readable = code ? readable ?? formatReportCode(text) : tools.formatJson(tools.readableText(text));
    viewerDetail.textContent = [viewerState.detail, encoding?.toUpperCase()].filter(Boolean).join(" · ");
    viewerDetail.hidden = !viewerDetail.textContent;
    viewerOptions.hidden = false;
    viewerPart("encoding-control").hidden = !viewerState.decode;
    viewerPart("wrap-control").hidden = code || Boolean(error);
    viewerPart("readable-control").hidden = Boolean(error);
    viewerReadable.disabled = !code && viewerState.source === viewerState.readable;
    viewerSource.hidden = Boolean(error);
    viewerLines.hidden = !code;
    viewerFooter.hidden = code || Boolean(error);
    setViewerMessage(error);
    updateViewerText();
    viewerText.scrollTo(0, 0);
  }

  function openSharedViewer({ title, kind, detail = "", trigger, content }) {
    viewerState = { detail, trigger, kind, decode: content.decode };
    viewerKind.textContent = { image: "Вложение", code: "Фрагмент кода", file: "Просмотр файла" }[kind];
    viewerTitle.textContent = title;
    viewerTitle.title = title;
    viewerDetail.textContent = detail;
    viewerDetail.hidden = !detail;
    viewerText.textContent = "";
    viewerLines.textContent = "";
    viewerSource.hidden = viewerMedia.hidden = viewerOptions.hidden = viewerFooter.hidden = true;
    viewerImage.removeAttribute("src");
    viewerWrap.checked = viewerReadable.checked = true;
    viewerEncoding.value = "auto";
    setViewerMessage();
    if (kind === "image") {
      viewerImage.alt = content.alt;
      viewerImage.src = content.url;
      viewerMedia.hidden = false;
    } else {
      showViewerText(content);
    }
    if (!sharedViewer.open) sharedViewer.showModal();
  }

  viewerPart("close").addEventListener("click", () => sharedViewer.close());
  sharedViewer.addEventListener("close", () => {
    if (sharedViewer.open) return;
    viewerState?.trigger?.focus({ preventScroll: true });
    viewerState = undefined;
    viewerText.textContent = "";
    viewerLines.textContent = "";
    viewerImage.removeAttribute("src");
  });
  viewerText.addEventListener("scroll", () => { viewerLines.scrollTop = viewerText.scrollTop; });
  viewerWrap.addEventListener("change", () => viewerText.classList.toggle("wrap-lines", viewerWrap.checked));
  viewerReadable.addEventListener("change", updateViewerText);
  viewerEncoding.addEventListener("change", () => {
    if (!viewerState?.decode) return;
    try {
      showViewerText(viewerState.decode(viewerEncoding.value));
    } catch (error) {
      showViewerText({ error: error.message });
    }
  });
  viewerCopy.addEventListener("click", async () => {
    const current = viewerState;
    const text = viewerText.textContent;
    try {
      await copyText(text, sharedViewer, viewerCopy);
      if (sharedViewer.open && viewerState === current && viewerText.textContent === text) viewerCopy.textContent = "Скопировано";
    } catch {
      if (sharedViewer.open && viewerState === current) viewerActionState.textContent = "Не удалось скопировать текст.";
    }
  });

  function appendText(node, text) {
    let end = 0;
    for (const link of window.QaReportTrackerLinks.wikiLinks(text)) {
      appendBareLinks(node, text.slice(end, link.index));
      node.append(externalLink(link.href, link.label) || link.label);
      end = link.end;
    }
    appendBareLinks(node, text.slice(end));
  }

  function appendBareLinks(node, text) {
    let end = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      let url = match[0].replace(/[.,;!?:]+$/, "");
      let excessClosing = (url.match(/\)/g)?.length || 0) - (url.match(/\(/g)?.length || 0);
      while (excessClosing > 0 && url.endsWith(")")) {
        url = url.slice(0, -1);
        excessClosing--;
      }
      const link = externalLink(url);
      if (!link) continue;
      node.append(text.slice(end, match.index), link);
      end = match.index + url.length;
    }
    node.append(text.slice(end));
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "";
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  }

  async function request(path = "", options = {}) {
    const corporateSession = document.documentElement.dataset.corporateSession === "required";
    let csrf;
    if (corporateSession && options.method && options.method !== "GET") {
      const response = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Не удалось подтвердить вход. Откройте отчёт заново.");
      csrf = (await response.json()).csrfToken;
    }
    const round = workflow?.round || requestedRound;
    const pinned = round && (!path || /^\/(?:files|answer-files)\//.test(path)) && (!options.method || options.method === "GET");
    const response = await fetch(`${api}${path}${pinned ? "?round=" + round : ""}`, {
      method: options.method || "GET",
      headers: { "X-QA-Report-Token": token, Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(round && { "X-QA-Report-Round": String(round) }),
        ...(options.accountToken ? { "X-QA-Report-Session": options.accountToken } : {}),
        ...(csrf ? { "X-QA-CSRF-Token": csrf } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      credentials: corporateSession ? "same-origin" : "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(/^\/(?:files|answer-files)(?:\/|$)/.test(path) ? 60000 : 30000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message = response.status === 404 || (response.status === 401 && payload?.errorCode !== "REPORT_SIGN_IN_REQUIRED")
        ? "Отчёт или файл недоступен по этой ссылке."
        : payload?.error || `Ошибка сервера (${response.status}).`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return response;
  }

  let accountConfig;
  async function answerAttachmentSession() {
    accountConfig ||= fetch("/api/shared-reports/account", { credentials: document.documentElement.dataset.corporateSession === "required" ? "same-origin" : "omit", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(15_000) }).then(async response => {
      if (!response.ok) throw new Error("Не удалось проверить вход. Повторите загрузку.");
      return (await response.json()).publishableKey;
    }).catch(error => { accountConfig = undefined; throw error; });
    const publishableKey = await accountConfig;
    if (!publishableKey) return null;
    const account = await import("/report-account-dialog.js?v=4");
    if (!await account.sessionToken(publishableKey, true)) {
      if (!await account.signIn(publishableKey, "Войти, чтобы прикрепить файл")) throw new Error("Войдите, чтобы прикрепить файл.");
      if (!await account.sessionToken(publishableKey, true)) throw new Error("Не удалось проверить вход. Повторите загрузку.");
    }
    return () => account.sessionToken(publishableKey);
  }

  async function getReport() {
    const { report } = await (await request()).json();
    for (const answer of report.answers || []) {
      if (answer.status === "in_progress") answer.status = "unreviewed";
    }
    return report;
  }

  async function rasterPreview(blob, type) {
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const marker = String.fromCharCode(...bytes);
    const signatures = {
      "image/png": marker.startsWith("\x89PNG\r\n\x1a\n"),
      "image/jpeg": marker.startsWith("\xff\xd8\xff"),
      "image/gif": marker.startsWith("GIF87a") || marker.startsWith("GIF89a"),
      "image/webp": marker.startsWith("RIFF") && marker.slice(8) === "WEBP",
    };
    if (!signatures[type]) throw new Error("Предпросмотр недоступен. Можно скачать файл.");
    return new Blob([blob], { type });
  }

  function queueThumbnail(load) {
    thumbnailQueue.push(load);
    loadThumbnails();
  }

  function loadThumbnails() {
    const maxActive = 3;
    while (activeThumbnailLoads < maxActive && thumbnailQueue.length) {
      activeThumbnailLoads++;
      thumbnailQueue.shift()().finally(() => {
        activeThumbnailLoads--;
        loadThumbnails();
      });
    }
  }

  function loadImagePreview(file, path) {
    if (!imagePreviews.has(path)) {
      const pending = (async () => {
        const blob = await (await request(path)).blob();
        const url = URL.createObjectURL(await rasterPreview(blob, file.type));
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          imagePreviewUrls.add(url);
          return url;
        } catch {
          URL.revokeObjectURL(url);
          throw new Error("Не удалось открыть изображение.");
        }
      })().catch(error => {
        imagePreviews.delete(path);
        throw error;
      });
      imagePreviews.set(path, pending);
    }
    return imagePreviews.get(path);
  }

  async function downloadAttachment(file, path) {
    const blob = await (await request(path)).blob();
    const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
    const link = element("a");
    link.href = url;
    link.download = file.name.replace(/[\\/\u0000-\u001f\u007f-\u009f]/g, "_").trim() || "вложение";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function fileItem(file, path = `/files/${encodeURIComponent(file.id)}`, attachment, editor) {
    const item = element(attachment ? "span" : "li", "file");
    const object = element("span", "file-object");
    const actions = element("span", "object-action-panel");
    const message = element("span", "file-error");
    const detail = formatSize(file.size);
    const imageFile = rasterTypes.has(file.type);
    const filePreview = window.QaReportFilePreview;
    const textFile = filePreview.isText(file.name, file.type) && file.size <= filePreview.MAX_BYTES;
    message.setAttribute("role", "status");
    const unavailable = element("span", "file-unavailable");
    const unavailableName = element("span", "file-name", file.name);
    unavailableName.title = file.name;
    const unavailableMessage = element("span", "file-error");
    unavailableMessage.setAttribute("role", "status");
    const retry = button("Повторить", "file-retry");
    unavailable.append(unavailableName, unavailableMessage, retry);
    unavailable.hidden = true;
    let card;
    let retryLoad;
    let loading = false;
    retry.addEventListener("click", () => retryLoad?.());

    function setUnavailable(failed) {
      item.toggleAttribute("data-load-failed", failed);
      unavailable.hidden = !failed;
      card.hidden = failed;
      actions.hidden = failed && !editor;
      unavailableMessage.textContent = failed
        ? (imageFile ? "Не удалось загрузить изображение." : "Не удалось загрузить файл.") : "";
    }

    async function loadAttachment(action, control, onReady) {
      if (loading) return;
      loading = true;
      retryLoad = () => loadAttachment(action, control, onReady);
      const busyControl = unavailable.hidden ? control : retry;
      busyControl.setAttribute("aria-busy", "true");
      if (busyControl === retry) retry.textContent = "Загружаем…";
      message.textContent = "";
      let content;
      try {
        content = await action();
      } catch {
        const focused = document.activeElement === control;
        setUnavailable(true);
        if (focused) retry.focus({ preventScroll: true });
        return;
      } finally {
        loading = false;
        busyControl.removeAttribute("aria-busy");
        if (busyControl === retry) retry.textContent = "Повторить";
      }
      const focused = document.activeElement === retry;
      setUnavailable(false);
      if (focused) control.focus({ preventScroll: true });
      if (item.isConnected) onReady?.(content);
    }

    const downloadButton = objectAction("download", `Скачать ${file.name}`,
      () => loadAttachment(() => downloadAttachment(file, path), downloadButton));
    downloadButton.classList.add("attachment-content-action");

    if (imageFile) {
      const preview = card = button(undefined, "file-preview");
      const spinner = element("span", "shared-spinner");
      spinner.setAttribute("aria-hidden", "true");
      preview.append(spinner);
      object.classList.add("image-object");
      preview.setAttribute("aria-label", `Открыть ${file.name}`);
      preview.setAttribute("aria-haspopup", "dialog");
      preview.title = file.name;
      const showImage = url => {
        if (!preview.querySelector("img")) {
          const image = element("img");
          image.src = url;
          image.alt = "";
          preview.replaceChildren(image);
        }
      };
      const load = () => loadImagePreview(file, path);
      let openWhenReady = false;
      const loadThumbnail = () => loadAttachment(load, preview, url => {
        showImage(url);
        if (!openWhenReady) return;
        openWhenReady = false;
        if (sharedViewer.open) return;
        openSharedViewer({
          title: "Просмотр изображения", kind: "image", trigger: preview, content: { url, alt: file.name },
        });
      });
      preview.addEventListener("click", () => { openWhenReady = true; loadThumbnail(); });
      const loadVisibleThumbnail = async () => {
        if (unavailable.hidden && !preview.querySelector("img")) await loadThumbnail();
      };
      if (thumbnailObserver) {
        thumbnailLoads.set(preview, loadVisibleThumbnail);
        thumbnailObserver.observe(preview);
      } else {
        queueThumbnail(loadVisibleThumbnail);
      }
    } else {
      card = textFile ? button(undefined, "file-card") : element("span", "file-card");
      const extension = /\.([a-z0-9]{1,6})$/i.exec(file.name)?.[1].toUpperCase() || "ФАЙЛ";
      const body = element("span", "file-card-body");
      const name = element("span", "file-name", file.name);
      name.title = file.name;
      body.append(name, element("span", "file-size", textFile ? detail : `${detail} · Доступно для скачивания`));
      card.append(element("span", "file-type-badge", extension), body);
      if (textFile) {
        card.setAttribute("aria-label", `Открыть ${file.name}`);
        card.setAttribute("aria-haspopup", "dialog");
        const load = async () => {
          const bytes = new Uint8Array(await (await request(path)).arrayBuffer());
          const decode = encoding => filePreview.decodeBytes(file, bytes, encoding);
          try {
            return { ...decode("auto"), decode };
          } catch (error) {
            return { error: error.message, decode };
          }
        };
        card.addEventListener("click", () => loadAttachment(load, card, content => {
          if (!sharedViewer.open) openSharedViewer({
            title: file.name, kind: "file", detail: `${extension} · ${detail}`, trigger: card, content,
          });
        }));
      }
    }
    actions.append(downloadButton);
    if (attachment) {
      item.classList.add("answer-attachment");
      item.dataset.answerAttachment = file.id;
      item.contentEditable = "false";
      if (imageFile) applyAnswerImageLayout(item, attachment);
      if (editor) addAnswerAttachmentActions({ item, object, file, path, editor, actions, message, imageFile });
    }
    object.append(card, unavailable, actions);
    item.append(object, message);
    return item;
  }

  function applyAnswerImageLayout(item, { align = "left", width = 100 }) {
    item.dataset.align = align;
    item.dataset.width = width;
    item.style.setProperty("--answer-image-width", `${width}%`);
  }

  function addAnswerImageResize(item, object, options, changed) {
    const handle = element("span", "answer-image-resize");
    handle.tabIndex = 0;
    handle.title = "Потяните угол, чтобы изменить размер";
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", "Ширина изображения");
    handle.setAttribute("aria-valuemin", "25");
    handle.setAttribute("aria-valuemax", "100");
    handle.setAttribute("aria-valuenow", item.dataset.width);
    handle.append(objectIcon("resize"));
    object.append(handle);
    let drag;

    function resize(value) {
      const width = Math.min(100, Math.max(25, Math.round(value)));
      applyAnswerImageLayout(item, { align: item.dataset.align, width });
      handle.setAttribute("aria-valuenow", String(width));
    }

    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      options.open = false;
      const width = Number(item.dataset.width);
      const containerWidth = item.getBoundingClientRect().width * 100 / width;
      if (!containerWidth) return;
      const direction = item.dataset.align === "right" ? -1 : item.dataset.align === "center" ? 2 : 1;
      drag = { id: event.pointerId, start: event.clientX, width, scale: direction * 100 / containerWidth };
      item.draggable = false;
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (drag?.id === event.pointerId) resize(drag.width + (event.clientX - drag.start) * drag.scale);
    });
    function stop(event) {
      if (drag?.id !== event.pointerId) return;
      const { width } = drag;
      drag = null;
      item.draggable = true;
      if (event.type !== "pointerup") resize(width);
      else if (Number(item.dataset.width) !== width) changed();
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(type, stop);
    handle.addEventListener("keydown", event => {
      const width = Number(item.dataset.width);
      const next = { ArrowLeft: width - 5, ArrowDown: width - 5, ArrowRight: width + 5, ArrowUp: width + 5,
        Home: 25, End: 100 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      resize(next);
      changed();
    });
    return () => resize(100);
  }

  async function copyAnswerImage(path) {
    const bytes = await (await request(path)).blob();
    const bitmap = await createImageBitmap(bytes);
    const canvas = element("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!image) throw new Error("Не удалось скопировать изображение.");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
  }

  function addAnswerAttachmentActions({ item, object, file, path, editor, actions, message, imageFile }) {
    const changed = () => editor.dispatchEvent(new Event("input", { bubbles: true }));
    const remove = objectAction("trash", `Удалить ${file.name}`, async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      remove.setAttribute("aria-busy", "true");
      const stateKey = `delete:${file.id}`;
      setAnswerSaveState(stateKey, "saving");
      message.textContent = "";
      try {
        await request(path, { method: "DELETE" });
        const key = answerKey(file.sectionId, file.rowId);
        answerFiles.set(key, (answerFiles.get(key) || []).filter(entry => entry.id !== file.id));
        // The answer may have rerendered while the request was in flight.
        for (const card of editor.querySelectorAll("[data-answer-attachment]")) {
          if (card.dataset.answerAttachment === file.id) card.remove();
        }
        changed();
        setAnswerSaveState(stateKey, "saved");
        if (!document.activeElement || document.activeElement === document.body) editor.focus({ preventScroll: true });
      } catch (error) {
        message.textContent = error.message || "Не удалось удалить вложение.";
        setAnswerSaveState(stateKey, "error");
        remove.disabled = false;
        remove.removeAttribute("aria-busy");
      }
    });
    remove.classList.add("object-action-danger");
    actions.prepend(remove);
    item.addEventListener("keydown", event => {
      if (["Backspace", "Delete"].includes(event.key) && !event.target.matches("input, select")) {
        event.preventDefault();
        remove.click();
      }
    });
    item.draggable = true;
    item.addEventListener("dragstart", event => {
      if (actions.contains(event.target)) { event.preventDefault(); return; }
      draggedAnswerAttachment = item;
      event.dataTransfer.setData("application/x-qa-report-answer-attachment", file.id);
      event.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => { draggedAnswerAttachment = undefined; });

    const copy = objectAction("copy", `Копировать ${file.name}`, async () => {
      message.textContent = "";
      try {
        if (imageFile) {
          await copyAnswerImage(path);
          message.textContent = "Изображение скопировано.";
        } else {
          message.textContent = await copyAnswerFile(file, path, copy);
        }
      } catch {
        message.textContent = "Не удалось скопировать вложение.";
      }
    });
    copy.classList.add("attachment-content-action");
    actions.prepend(copy);
    if (!imageFile) return;
    const options = element("details", "answer-image-options");
    const toggle = element("summary", "object-action-button");
    toggle.setAttribute("aria-label", "Ещё действия с изображением");
    toggle.title = "Ещё действия с изображением";
    toggle.textContent = "⋯";
    const menu = element("span", "answer-image-menu");
    const align = element("select");
    align.setAttribute("aria-label", "Выравнивание изображения");
    for (const [value, label] of [["left", "Слева"], ["center", "По центру"], ["right", "Справа"]]) {
      const option = element("option", "", label);
      option.value = value;
      align.append(option);
    }
    align.value = item.dataset.align;
    align.addEventListener("change", () => {
      applyAnswerImageLayout(item, { align: align.value, width: Number(item.dataset.width) });
      changed();
    });
    const fullWidth = addAnswerImageResize(item, object, options, changed);
    const stretch = button("По ширине ячейки");
    stretch.addEventListener("click", () => { fullWidth(); changed(); options.open = false; });
    menu.append(align, stretch);
    options.append(toggle, menu);
    actions.append(options);
  }

  async function copyCode(text, language, trigger) {
    const jiraCode = `{code}\n${text}\n{code}`;
    const snippet = element("pre", "cell-code-block");
    snippet.dataset.qaCodeSnippet = "true";
    snippet.dataset.language = language;
    snippet.append(element("code", "", text));
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([jiraCode], { type: "text/plain" }),
        "text/html": new Blob([snippet.outerHTML], { type: "text/html" }),
      })]);
    } catch {
      await copyText(jiraCode, document.body, trigger);
    }
  }

  function codeBlock(text, language = "text") {
    const block = createCodePreview(text, ({ text, readable, detail, trigger }) => openSharedViewer({
      title: "Просмотр кода", kind: "code", detail, trigger, content: { text, readable },
    }));
    const actions = element("div", "object-action-panel");
    const message = element("span", "object-action-feedback");
    message.setAttribute("role", "status");
    const copy = objectAction("copy", "Копировать код", async () => {
      message.textContent = "";
      try {
        await copyCode(text, language, copy);
        message.textContent = "Код скопирован.";
      } catch {
        message.textContent = "Не удалось скопировать код.";
      }
    });
    actions.append(copy);
    block.append(actions, message);
    return block;
  }

  function appendFormattedContent(node, fragments, appendAttachment) {
    let prose;
    for (const [index, fragment] of fragments.entries()) {
      let { type, text } = fragment;
      if (type === "attachment") {
        appendAttachment(fragment.id);
        prose = undefined;
        continue;
      }
      if (type === "code") {
        node.append(codeBlock(text, fragment.language));
        prose = undefined;
        continue;
      }
      if (type === "text") {
        if (["code", "attachment"].includes(fragments[index - 1]?.type)) text = text.replace(/^\n+/, "");
        if (["code", "attachment"].includes(fragments[index + 1]?.type)) text = text.replace(/\n+$/, "");
        if (!text) continue;
      }
      if (!prose) {
        prose = element("p", "prose");
        node.append(prose);
      }
      if (type === "inline-code") prose.append(element("code", "report-inline-code", text));
      else if (type === "link") prose.append(externalLink(fragment.href, text) || text);
      else appendText(prose, text);
    }
  }

  function appendContent(node, content) {
    const attached = (content?.attachments || []).map(id => files.get(id)).filter(Boolean);
    const placed = new Set();
    if (content?.fragments?.length) appendFormattedContent(node, content.fragments, id => {
      const file = attached.find(file => file.id === id);
      if (!file) return;
      appendFiles(node, [file]);
      placed.add(id);
    });
    else if (content?.text) {
      const prose = element("p", "prose");
      appendText(prose, content.text);
      node.append(prose);
    }
    // Snapshots published before attachment positions were saved keep their files.
    appendFiles(node, attached.filter(file => !placed.has(file.id)));
  }

  function appendFiles(node, attached) {
    if (attached.length) {
      const list = element("ul", "files");
      for (const file of attached) {
        if (!file.pending) {
          list.append(fileItem(file));
          continue;
        }
        const card = element("li", "file file-pending");
        card.append(element("span", "file-name", file.name), element("span", "file-size", "Вложение ещё не опубликовано"));
        if (!pendingAttachmentCards.has(file.id)) pendingAttachmentCards.set(file.id, []);
        pendingAttachmentCards.get(file.id).push(card);
        list.append(card);
      }
      node.append(list);
    }
  }

  function watchPendingAttachments() {
    if (!pendingAttachmentCards.size) return;
    setTimeout(async () => {
      if (!document.hidden) {
        try {
          const { pending } = await (await request("/attachment-status")).json();
          const stillPending = new Set(pending);
          for (const [id, cards] of pendingAttachmentCards) {
            if (stillPending.has(id)) continue;
            const file = files.get(id);
            file.pending = false;
            for (const card of cards) card.replaceWith(fileItem(file));
            pendingAttachmentCards.delete(id);
          }
        } catch (error) {
          if (error.status === 404) return;
        }
      }
      watchPendingAttachments();
    }, 5_000);
  }

  const answerKey = (sectionId, rowId) => JSON.stringify([sectionId, rowId]);

  function rememberAnswerFile(file) {
    const key = answerKey(file.sectionId, file.rowId);
    const items = answerFiles.get(key) || [];
    if (items.some(item => item.id === file.id)) return;
    items.push(file);
    answerFiles.set(key, items);
  }

  function answerAttachment(file, attachment, editor) {
    return fileItem(file, `/answer-files/${encodeURIComponent(file.id)}`, attachment || {}, editor);
  }

  function renderAnswerComment(target, value, key, editor) {
    const unplaced = new Map((answerFiles.get(key) || []).map(file => [file.id, file]));
    const uploading = [...target.querySelectorAll("[data-answer-upload]")];
    if (!editor && !value?.commentDocument) appendContent(target, { text: value?.comment });
    else {
      commentTools.render(target, value?.comment, value?.commentDocument, attachment => {
        const file = unplaced.get(attachment.id);
        if (!file) return null;
        unplaced.delete(file.id);
        return answerAttachment(file, attachment, editor);
      });
    }
    for (const file of unplaced.values()) target.append(answerAttachment(file, null, editor));
    target.append(...uploading);
  }

  function readFileData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result.slice(reader.result.indexOf(",") + 1)));
      reader.addEventListener("error", () => reject(new Error("Не удалось прочитать файл.")));
      reader.readAsDataURL(file);
    });
  }

  async function copyAnswerFile(file, path, trigger) {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      const bytes = await (await request(path)).blob();
      const card = element("figure", "cell-file", file.name);
      card.dataset.fileName = file.name;
      card.dataset.fileSize = file.size;
      card.dataset.mimeType = file.type;
      card.dataset.dataUrl = `data:${file.type};base64,${await readFileData(bytes)}`;
      try {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([file.name], { type: "text/plain" }),
          "text/html": new Blob([card.outerHTML], { type: "text/html" }),
        })]);
        return "Файл скопирован.";
      } catch { /* Fall back to the file name in browsers that restrict rich clipboard data. */ }
    }
    await copyText(file.name, document.body, trigger);
    return "Имя файла скопировано.";
  }

  function uploadErrorMessage(error) {
    if (!navigator.onLine) return "Нет подключения к сети. Подключитесь к интернету и нажмите «Повторить».";
    if (["TimeoutError", "AbortError"].includes(error?.name)) return "Загрузка заняла слишком много времени. Нажмите «Повторить».";
    if (error?.name === "TypeError") return "Не удалось загрузить файл. Проверьте подключение и нажмите «Повторить».";
    if (error?.status >= 500) return "Сервер временно не принимает файлы. Повторите загрузку позже.";
    if (error?.status === 413) return "Файл превышает допустимый размер. Выберите файл до 10 МБ.";
    if (error?.status === 401 || error?.status === 403) return "Не удалось подтвердить доступ к загрузке. Откройте отчёт заново и повторите попытку.";
    if (error?.name !== "SyntaxError" && /[А-Яа-яЁё]/.test(error?.message || "") && error.message.length <= 300) return error.message;
    return "Не удалось загрузить файл. Нажмите «Повторить». Текст комментария сохранён.";
  }

  function addAnswerFilePicker(comment, editor, sectionId, rowId) {
    const picker = element("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    editor.append(picker);

    const notice = element("p", "file-error answer-upload-notice");
    notice.setAttribute("role", "status");
    editor.append(notice);
    const pending = new Map();
    const key = answerKey(sectionId, rowId);
    let uploading = false;
    let pickerRange;

    async function uploadPending() {
      if (uploading) return;
      uploading = true;
      let access;
      try {
        for (;;) {
          const entry = [...pending.values()].find(item => item.queued);
          if (!entry) break;
          entry.queued = false;
          entry.retry.hidden = entry.remove.hidden = true;
          entry.item.setAttribute("aria-busy", "true");
          entry.spinner.hidden = false;
          entry.message.textContent = "";
          setAnswerSaveState(entry.stateKey, "saving");
          try {
            access ||= answerAttachmentSession();
            const sessionToken = await access;
            const accountToken = await sessionToken?.();
            const data = await readFileData(entry.file);
            const response = await request("/answer-files", {
              method: "POST",
              accountToken,
              body: { id: entry.id, sectionId, rowId, name: entry.file.name, type: entry.file.type, data },
            });
            const { file } = await response.json();
            if (!file || file.id !== entry.id || file.sectionId !== sectionId || file.rowId !== rowId ||
                typeof file.name !== "string" || typeof file.type !== "string" || !Number.isSafeInteger(file.size) || file.size !== entry.file.size) {
              throw new Error("Сервер не подтвердил загрузку файла. Нажмите «Повторить». Текст комментария сохранён.");
            }
            rememberAnswerFile(file);
            if (![...comment.querySelectorAll("[data-answer-attachment]")].some(card => card.dataset.answerAttachment === file.id)) {
              const card = answerAttachment(file, null, comment);
              if (comment.contains(entry.item)) entry.item.replaceWith(card);
              else comment.append(card);
            }
            pending.delete(entry.id);
            entry.item.remove();
            comment.dispatchEvent(new Event("input", { bubbles: true }));
            setAnswerSaveState(entry.stateKey, "saved");
          } catch (error) {
            if (!comment.contains(entry.item)) comment.append(entry.item);
            entry.message.textContent = uploadErrorMessage(error);
            entry.retry.hidden = entry.remove.hidden = false;
            setAnswerSaveState(entry.stateKey, "error");
          } finally {
            entry.item.removeAttribute("aria-busy");
            entry.spinner.hidden = true;
          }
        }
      } finally {
        uploading = false;
      }
    }

    function queueFiles(selected, position) {
      const rejected = [];
      for (const file of selected) {
        if ((answerFiles.get(key)?.length || 0) + pending.size >= maxAnswerFilesPerPoint) {
          rejected.push("К одному пункту можно прикрепить до 10 файлов.");
          break;
        }
        if (!file.size || file.size > maxAnswerFileSize) {
          rejected.push(file.size ? `«${file.name}» превышает 10 МБ.` : `Файл «${file.name}» пуст.`);
          continue;
        }
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        const item = element("span", "answer-upload");
        item.dataset.answerUpload = "";
        item.contentEditable = "false";
        const name = element("span", "file-name", file.name);
        const spinner = element("span", "shared-spinner");
        spinner.setAttribute("role", "status");
        spinner.setAttribute("aria-label", "Загружаем файл");
        spinner.hidden = true;
        const retry = button("Повторить");
        const remove = button("Убрать");
        remove.setAttribute("aria-label", `Убрать ${file.name} из очереди загрузки`);
        const message = element("span", "file-error");
        message.setAttribute("role", "status");
        retry.hidden = remove.hidden = true;
        item.append(name, spinner, message, retry, remove);
        const stateKey = `file:${id}`;
        position = commentTools.insertAttachment(comment, item, position);
        comment.dataset.empty = "false";
        const entry = { id, stateKey, file, item, spinner, retry, remove, message, queued: true };
        pending.set(id, entry);
        setAnswerSaveState(stateKey, "dirty");
        retry.addEventListener("click", () => {
          entry.queued = true;
          setAnswerSaveState(stateKey, "dirty");
          uploadPending();
        });
        remove.addEventListener("click", () => {
          pending.delete(id);
          item.remove();
          comment.dispatchEvent(new Event("input", { bubbles: true }));
          setAnswerSaveState(stateKey, "saved");
        });
      }
      if (position && document.activeElement === comment) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(position);
      }
      notice.textContent = rejected.join(" ");
      uploadPending();
    }

    picker.addEventListener("change", () => {
      if (picker.files.length) {
        comment.focus({ preventScroll: true });
        queueFiles([...picker.files], pickerRange);
      }
      picker.value = "";
      pickerRange = null;
    });
    comment.addEventListener("paste", event => {
      let pasted = [...(event.clipboardData?.files || [])];
      if (!pasted.length) {
        const html = event.clipboardData?.getData("text/html") || "";
        if (html.length && html.length <= Math.ceil(maxAnswerFileSize / 3) * 4 + 4096) {
          const template = element("template");
          template.innerHTML = html;
          const card = template.content.querySelector(".cell-file[data-data-url]");
          const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(card?.dataset.dataUrl || "");
          if (match) {
            try {
              const bytes = Uint8Array.from(atob(match[2]), value => value.charCodeAt(0));
              pasted = [new File([bytes], card.dataset.fileName || "Вложение", { type: match[1] })];
            } catch { /* An invalid clipboard card can still be pasted as text. */ }
          }
        }
      }
      if (!pasted.length) {
        commentTools.paste(comment, event);
        return;
      }
      event.preventDefault();
      queueFiles(pasted, commentTools.selectionRange(comment));
    });
    function dropPosition(event) {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(event.clientX, event.clientY);
      const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
      if (!position) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      return range;
    }
    comment.addEventListener("dragover", event => {
      if (event.dataTransfer?.types.includes("Files") || (draggedAnswerAttachment && comment.contains(draggedAnswerAttachment))) event.preventDefault();
    });
    comment.addEventListener("drop", event => {
      event.preventDefault();
      if (event.dataTransfer?.files.length) queueFiles([...event.dataTransfer.files], dropPosition(event));
      else if (draggedAnswerAttachment && comment.contains(draggedAnswerAttachment)) {
        commentTools.insertAttachment(comment, draggedAnswerAttachment, dropPosition(event));
        comment.dispatchEvent(new Event("input", { bubbles: true }));
      }
      else if (event.dataTransfer?.types.includes("text/plain")) {
        comment.focus();
        document.execCommand("insertText", false, event.dataTransfer.getData("text/plain"));
      }
    });
    return range => {
      pickerRange = range || commentTools.selectionRange(comment);
      picker.click();
    };
  }

  function setAnswerSaveState(key, state) {
    if (state === "saved") pendingAnswers.delete(key);
    else pendingAnswers.set(key, state);
    const states = new Set(pendingAnswers.values());
    const next = ["error", "saving", "dirty"].find(value => states.has(value)) || "saved";
    if (saveIndicator.dataset.state === next) return;
    saveIndicator.dataset.state = next;
    saveLabel.textContent = saveLabels[next];
  }

  function answerDraft(key, next) {
    const storageKey = `qa-report:shared-answer:${reportId}${workflow?.round > 1 ? ":" + workflow.round : ""}:${key}`;
    try {
      if (next === undefined) return JSON.parse(sessionStorage.getItem(storageKey));
      if (next === null) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Editing and saving remain available if the browser restricts tab storage.
    }
    return null;
  }

  function appendAnswer(row, sectionId, rowId, number, canReply, uploadsPaused) {
    const key = answerKey(sectionId, rowId);
    let saved = answers.get(key);
    const statusCell = element("td", "correction-status");
    const commentCell = element("td", "correction-comment");
    const savedStatus = answerStatuses.get(saved?.status) || answerStatuses.get("unreviewed");
    statusCell.dataset.tone = savedStatus.tone;
    commentCell.dataset.tone = savedStatus.tone;
    row.append(statusCell, commentCell);
    if (!canReply) {
      statusCell.textContent = savedStatus.label;
      const formatted = element("div", "answer-comment-view");
      renderAnswerComment(formatted, saved, key);
      commentCell.append(formatted);
      registerAnswer(row, key, number, canReply, statusCell, commentCell);
      return;
    }
    statusCell.classList.add("is-editable");
    commentCell.classList.add("is-editable");
    const select = element("select");
    const commentEditor = element("div", "answer-comment-editor");
    const commentField = element("div", "answer-comment-field");
    const comment = element("div", "answer-comment-input");
    const retry = button("Повторить сохранение");
    const commentLimit = element("p", "file-error answer-upload-notice");
    commentLimit.setAttribute("role", "status");
    commentLimit.hidden = true;
    const conflict = element("div", "conflict");
    const latestText = element("p", "prose");
    const conflictActions = element("div", "conflict-actions");
    const keepLatest = button("Загрузить сохранённый ответ");
    const keepMine = button("Сохранить мой ответ");
    const refreshLatest = button("Обновить ответ");
    let latest;
    let busy = false;
    let timer;
    let composing = false;

    select.setAttribute("aria-label", `Статус ответа пункта ${number}`);
    comment.contentEditable = "true";
    comment.setAttribute("role", "textbox");
    comment.setAttribute("aria-multiline", "true");
    comment.setAttribute("aria-label", `Комментарий к пункту ${number}`);
    comment.setAttribute("aria-placeholder", "Добавить комментарий…");
    comment.setAttribute("aria-keyshortcuts", "Alt+F10");
    comment.dataset.placeholder = "Добавить комментарий…";
    for (const [value, { label }] of answerStatuses) {
      const option = element("option", "", label);
      option.value = value;
      select.append(option);
    }
    commentField.append(comment);
    retry.hidden = true;
    conflictActions.append(refreshLatest, keepLatest, keepMine);
    conflict.append(element("p", "", "Ответ изменился. Ваши правки остались в полях."), latestText, conflictActions);
    conflict.hidden = true;
    statusCell.append(select);
    commentEditor.append(commentField, commentLimit, retry, conflict);
    const chooseFiles = uploadsPaused ? undefined : addAnswerFilePicker(comment, commentEditor, sectionId, rowId);
    if (uploadsPaused) {
      comment.addEventListener("paste", event => {
        if (event.clipboardData?.files.length) event.preventDefault();
        else commentTools.paste(comment, event);
      });
      comment.addEventListener("drop", event => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      });
    }
    commentCell.append(commentEditor);

    const current = () => ({ status: select.value, ...commentTools.read(comment) });
    const sameComment = (a, b) => (a?.comment || "") === (b?.comment || "") &&
      JSON.stringify(a?.commentDocument ?? null) === JSON.stringify(b?.commentDocument ?? null);
    const sameAnswer = (a, b) => a.status === (b?.status || "unreviewed") && sameComment(a, b);
    const revision = () => saved?.revision || 0;
    const updatePlaceholder = () => { comment.dataset.empty = String(!commentTools.read(comment).comment &&
      !comment.querySelector("[data-answer-attachment], [data-answer-upload]")); };
    const syncStatusTone = () => {
      const tone = answerStatuses.get(select.value)?.tone ?? "neutral";
      statusCell.dataset.tone = commentCell.dataset.tone = tone;
      if (hostedAnswer?.key === key) {
        document.getElementById("answer-panel-fields").dataset.tone = tone;
        panelStatus.dataset.tone = tone;
      }
    };
    const writeFields = (value, force = false) => {
      select.value = value?.status || "unreviewed";
      if (force || !sameComment(commentTools.read(comment), value)) renderAnswerComment(comment, value, key, comment);
      updatePlaceholder();
      syncStatusTone();
    };
    const persist = (values = current()) => {
      if (busy || !sameAnswer(values, saved)) answerDraft(key, { ...values, revision: revision() });
      else answerDraft(key, null);
    };

    function showConflict(answer) {
      conflict.hidden = false;
      retry.hidden = true;
      latest = answer;
      keepLatest.disabled = !latest;
      keepMine.disabled = !latest;
      keepMine.removeAttribute("title");
      latestText.textContent = latest
        ? `${answerStatuses.get(latest.status)?.label || latest.status}\n${latest.comment || "Комментария нет."}`
        : "Не удалось получить сохранённый ответ. Попробуйте обновить его.";
      setAnswerSaveState(key, "error");
    }

    async function fetchLatest() {
      const report = await getReport();
      answerFiles.set(key, (report.answerFiles || []).filter(file => file.sectionId === sectionId && file.rowId === rowId));
      return report.answers.find(answer => answerKey(answer.sectionId, answer.rowId) === key) || emptyAnswer;
    }

    function checkComment(values) {
      const message = values.error || (values.comment.length > 10_000 ? "В комментарии может быть до 10 000 символов." : "");
      commentLimit.textContent = message;
      commentLimit.hidden = !message;
      if (message) setAnswerSaveState(key, "error");
      return !message;
    }

    function queue(delay = 500) {
      clearTimeout(timer);
      const values = current();
      persist(values);
      if (!checkComment(values)) return;
      if (busy || !conflict.hidden) return;
      retry.hidden = true;
      if (sameAnswer(values, saved)) {
        setAnswerSaveState(key, "saved");
        return;
      }
      setAnswerSaveState(key, "dirty");
      if (!composing) timer = setTimeout(() => save(revision()), delay);
    }

    async function save(baseRevision) {
      if (busy || composing) return;
      const submitted = current();
      if (!checkComment(submitted)) return;
      if (conflict.hidden && sameAnswer(submitted, saved)) return;
      const wasConflict = !conflict.hidden;
      let accepted;
      busy = true;
      retry.hidden = true;
      keepMine.disabled = true;
      setAnswerSaveState(key, "saving");
      persist();
      try {
        const response = await request("/answers", {
          method: "POST",
          body: { sectionId, rowId, ...submitted, revision: baseRevision },
        });
        ({ answer: accepted } = await response.json());
      } catch (error) {
        if (error.status === 409) {
          const fresh = await fetchLatest().catch(() => undefined);
          if (fresh && sameAnswer(submitted, fresh)) accepted = fresh;
          else showConflict(fresh);
        } else {
          const action = wasConflict ? keepMine : retry;
          action.title = error.message || "Не удалось сохранить ответ.";
          retry.hidden = wasConflict;
          keepMine.disabled = !latest;
          setAnswerSaveState(key, "error");
        }
      } finally {
        busy = false;
        if (accepted) {
          saved = accepted;
          answers.set(key, saved);
          conflict.hidden = true;
          latest = undefined;
          // An earlier request can finish while the user is still editing the row.
          if (sameAnswer(current(), submitted)) writeFields(saved);
          persist();
          if (sameAnswer(current(), saved)) setAnswerSaveState(key, "saved");
          else queue(0);
          updateVisibility();
        }
      }
    }

    select.addEventListener("change", () => { syncStatusTone(); queue(0); });
    statusCell.addEventListener("click", event => {
      if (event.target === select) return;
      select.focus();
      if (typeof select.showPicker === "function") {
        try { select.showPicker(); } catch {}
      }
    });
    commentCell.addEventListener("click", event => {
      if ([commentCell, commentEditor, commentField].includes(event.target)) comment.focus();
    });
    comment.addEventListener("focusin", () => {
      if (activeComment === comment) return;
      activeComment = comment;
      (answerView === "side" ? panelComment : view).append(commentToolbar);
      activateCommentTools(comment, chooseFiles);
    });
    comment.addEventListener("keydown", event => {
      if (event.altKey && event.key === "F10") {
        event.preventDefault();
        commentToolbar.querySelector("button, select")?.focus();
      }
    });
    comment.addEventListener("compositionstart", () => { composing = true; });
    comment.addEventListener("compositionend", () => { composing = false; queue(); });
    comment.addEventListener("input", () => { updatePlaceholder(); queue(); });
    comment.addEventListener("blur", () => { if (!retry.hidden) return; queue(0); });
    retry.addEventListener("click", () => save(revision()));
    refreshLatest.addEventListener("click", async () => {
      refreshLatest.disabled = true;
      showConflict(await fetchLatest().catch(() => undefined));
      refreshLatest.disabled = false;
    });
    keepLatest.addEventListener("click", () => {
      if (busy || !latest) return;
      saved = latest;
      answers.set(key, saved);
      conflict.hidden = true;
      latest = undefined;
      writeFields(saved, true);
      persist();
      setAnswerSaveState(key, "saved");
      updateVisibility();
    });
    keepMine.addEventListener("click", () => { if (latest) save(latest.revision); });

    writeFields(saved, true);
    const recovered = answerDraft(key);
    if (recovered?.status === "in_progress") recovered.status = "unreviewed";
    if (recovered && answerStatuses.has(recovered.status) && typeof recovered.comment === "string") {
      if (sameAnswer(recovered, saved)) answerDraft(key, null);
      else {
        writeFields(recovered);
        if (recovered.revision === revision()) queue();
        else showConflict(saved || emptyAnswer);
      }
    }
    registerAnswer(row, key, number, canReply, statusCell, commentCell);
  }

  const correctionLabel = round => "Доработка № " + round;
  const retestLabel = round => "Ретест № " + round;
  const workflowLabels = { corrections: "На доработке", ready: "Готов к ретесту", retest: "На ретесте", finished: "Ретест пройден" };
  let workflow;
  let requestedRound;
  try {
    requestedRound = Number(sessionStorage.getItem("qa-retest-view:" + reportId)) || null;
    sessionStorage.removeItem("qa-retest-view:" + reportId);
  } catch {}
  const retests = new Map();
  const returnedPoints = new Map();
  const previousPoints = new Map();
  const priorRowKeys = new Set();
  const workflowBar = document.getElementById("workflow");
  const workflowInfo = document.getElementById("workflow-info");
  const workflowAction = document.getElementById("workflow-action");
  const workflowNotice = document.getElementById("workflow-notice");
  const nextRequired = document.getElementById("workflow-next");
  const isRetest = () => Boolean(workflow?.closedAt);
  window.addEventListener("pageshow", event => {
    if (event.persisted && !pendingAnswers.size && workflow && !workflow.archived) location.reload();
  });
  const canRetest = () => workflow?.author && workflow.phase === "retest";
  let getSessionToken = async () => null;
  let signInForRetest;

  function progress() {
    const missing = workflow.required.filter(ids => {
      const result = retests.get(answerKey(...ids));
      return !result || result.status === "НЕ ПРОВЕРЕНО";
    });
    const requiredKeys = new Set(workflow.required.map(ids => answerKey(...ids)));
    const additional = [...retests.keys()].filter(key => !requiredKeys.has(key)).length;
    workflowInfo.textContent = workflow.returnedAt ? "Возвращён на доработку " + formatDate(workflow.returnedAt) :
      workflow.phase === "corrections" ? "Ответы по замечаниям открыты" :
      `Доработка завершена ${formatDate(workflow.closedAt)} · Проверено замечаний: ${workflow.required.length - missing.length} из ${workflow.required.length}` +
      (additional ? ` · Дополнительно: ${additional}` : "") +
      (workflow.finishedAt ? ` · Ретест завершён ${formatDate(workflow.finishedAt)}` : "");
    nextRequired.hidden = !canRetest() || !missing.length;
    nextRequired.onclick = () => {
      workflowBar.open = false;
      selectedStatuses.clear();
      selectedAnswerKey = answerKey(...missing[0]);
      updateVisibility();
      const row = answerRows.get(selectedAnswerKey)?.row;
      row?.scrollIntoView({ block: "nearest" });
      row?.focus();
    };

  }

  function openOriginal() {
    if (!workflow.editorPath) throw new Error("Откройте исходный чек-лист в браузере, где он был опубликован.");
    sessionStorage.setItem("qa-retest-transfer", JSON.stringify({ id: reportId, token, round: workflow.round, publicId: workflow.publicId }));
    location.assign(workflow.editorPath + "?retest=" + reportId);
  }

  function confirmStage(title, text, action) {
    const dialog = document.getElementById("workflow-dialog");
    dialog.querySelector("h2").textContent = title;
    dialog.querySelector("p").textContent = text;
    dialog.querySelector("[value=accept]").textContent = action;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), { once: true }));
  }

  async function chooseRetestOutcome(report) {
    const review = window.QaReportRetest.review({ ...workflow, results: [...retests.values()] });
    const dialog = document.getElementById("decision");
    const success = dialog.querySelector('[value="success"]');
    const rework = dialog.querySelector('[value="rework"]');
    const accept = dialog.querySelector('[value="accept"]');
    dialog.querySelector(".decision-head small").textContent = report.title + " · " + retestLabel(workflow.round);
    dialog.querySelector(".decision-stats").textContent = [
      review.passed + " без замечаний", review.issues.length + " с замечаниями", review.pending.length + " без результата",
    ].join(" · ");
    success.disabled = !review.canFinish;
    rework.disabled = !review.issues.length;
    success.checked = review.canFinish && !review.issues.length;
    rework.checked = Boolean(review.issues.length);
    success.parentElement.querySelector("strong").textContent = review.qualified ? "Принять с замечаниями" : "Завершить успешно";
    dialog.querySelector("#success-help").textContent = review.qualified
      ? "В чек-листе сохранятся «Почти ОК» и комментарии."
      : review.canFinish ? "После завершения можно обновить основной чек-лист."
      : "Доступно после проверки обязательных пунктов и закрытия замечаний.";
    dialog.querySelector("#return-help").textContent = review.issues.length
      ? `В доработку № ${workflow.round + 1} попадут пункты с замечаниями (${review.issues.length}). Ссылка останется прежней.` +
        (review.pending.length ? " Пункты без результата останутся для следующего ретеста." : "")
      : "Для возврата укажите замечание хотя бы по одному пункту.";
    const update = () => {
      accept.disabled = !rework.checked && !success.checked;
      accept.textContent = rework.checked ? "Открыть доработку" :
        success.checked ? (review.qualified ? "Принять результат" : "Завершить успешно") : "Подтвердить";
    };
    dialog.onchange = update;
    update();
    dialog.returnValue = "";
    dialog.showModal();
    await new Promise(resolve => dialog.addEventListener("close", resolve, { once: true }));
    if (dialog.returnValue !== "accept") return null;
    return rework.checked ? "rework" : review.qualified ? "qualified" : "passed";
  }

  function configureWorkflow(report) {
    workflow = report.workflow;
    if (!workflow) return;
    workflowBar.hidden = false;
    document.getElementById("workflow-controls").hidden = false;
    const selector = document.getElementById("workflow-round");
    const rounds = workflow.rounds || [];
    if (rounds.length > 1) {
      document.getElementById("workflow-round-label").hidden = false;
      for (const number of rounds) {
        const latest = number === (workflow.currentRound || rounds.at(-1));
        const title = latest && !workflow.archived
          ? (workflow.phase === "corrections" ? correctionLabel(number) : retestLabel(number)) + " · сейчас"
          : correctionLabel(number) + " и ретест № " + number + (latest ? " · сейчас" : " · архив");
        selector.add(new Option(title, number));
      }
      selector.value = workflow.round;
      selector.onchange = () => {
        if (pendingAnswers.size) { selector.value = workflow.round; workflowInfo.textContent = "Дождитесь сохранения правок."; return; }
        sessionStorage.setItem("qa-retest-view:" + reportId, selector.value);
        location.reload();
      };
    }
    const title = workflow.phase === "corrections" ? correctionLabel(workflow.round) : retestLabel(workflow.round);
    const phase = workflow.outcome === "qualified" ? "Принято с замечаниями" : workflowLabels[workflow.phase];
    document.getElementById("workflow-stage").textContent = workflow.archived ? title + " · архив" :
      workflow.phase === "corrections" ? title : phase;
    for (const item of workflow.handoff?.points || []) returnedPoints.set(answerKey(item.sectionId, item.rowId), item);
    for (const ids of workflow.previousRows || []) priorRowKeys.add(answerKey(...ids));
    for (const item of workflow.previous || []) previousPoints.set(answerKey(item.sectionId, item.rowId), item);
    for (const result of workflow.results) retests.set(answerKey(result.sectionId, result.rowId), result);
    if (isRetest()) {
      view.setAttribute("data-retest-table", "");
      pins.state.qa = false;
      document.getElementById("answer-panel-status-label").textContent = "Результат ретеста";
      document.getElementById("answer-panel-comment-label").textContent = "Комментарий ретеста";
      document.getElementById("answer-view-label").textContent = "Ретест:";
    }
    const transfer = workflow.phase === "finished" && workflow.author && !workflow.archived;
    const ready = workflow.author && workflow.phase === "ready";
    const primary = ready ? "Начать ретест" : workflow.canClose ? "Завершить доработку" : canRetest() ? "Завершить ретест" : transfer ? "Обновить основной чек-лист" : "";
    workflowAction.textContent = primary;
    workflowAction.hidden = !primary;
    document.getElementById("workflow-menu-title").textContent = title;
    workflowBar.querySelector("summary").setAttribute("aria-label", "Этап и история отчёта");
    workflowAction.setAttribute("aria-label", primary + (transfer || ready ? "" : " по всему отчёту"));
    const login = document.getElementById("workflow-login");
    login.hidden = !signInForRetest || workflow.author || workflow.archived;
    login.onclick = async () => {
      try { if (await signInForRetest()) location.reload(); }
      catch (error) { workflowNotice.textContent = error.message; }
    };
    progress();
    workflowAction.onclick = async () => {
      workflowNotice.textContent = "";
      if (pendingAnswers.size || view.querySelector("[data-answer-upload]")) {
        workflowNotice.textContent = "Дождитесь сохранения изменений и вложений. Проверьте сообщения у пунктов.";
        return;
      }
      if (transfer) {
        try { openOriginal(); } catch (error) { workflowNotice.textContent = error.message; }
        return;
      }
      const closing = workflow.phase === "corrections";
      const outcome = closing || ready ? null : await chooseRetestOutcome(report);
      if (closing && !await confirmStage("Завершить доработку № " + workflow.round + "?",
        "Ответы сохранятся в истории. Автор сможет начать ретест № " + workflow.round + ".", primary)) return;
      if (!closing && !ready && !outcome) return;
      workflowAction.disabled = true;
      try {
        const action = closing ? "close-corrections" : ready ? "start-retest" : outcome === "rework" ? "return-to-corrections" : "finish-retest";
        await request("/" + action, { method: "POST", accountToken: await getSessionToken(), body: {
          ...(outcome && { outcome, revision: [...retests.values()].reduce((sum, item) => sum + item.revision, 0) }) } });
        if (action === "finish-retest" && workflow.editorPath && await confirmStage("Обновить основной чек-лист?",
          "В редакторе вы увидите, сколько пунктов можно обновить. Результаты ретеста сохранятся по этой ссылке.", "Перейти к переносу")) openOriginal();
        else location.reload();
      } catch (error) { workflowNotice.textContent = error.message; workflowAction.disabled = false; }
    };
  }

  function appendRetest(tr, sectionId, rowId, number) {
    const key = answerKey(sectionId, rowId);
    let saved = retests.get(key);
    const statusCell = element("td", "correction-status");
    const commentCell = element("td", "correction-comment");
    tr.append(statusCell, commentCell);
    statusCell.dataset.tone = saved ? statusMeta(saved.status).tone : "neutral";
    if (!canRetest()) {
      statusCell.textContent = saved?.status || "Без результата";
      commentCell.append(element("div", "answer-comment-view prose", saved?.comment || "—"));
    } else {
      statusCell.classList.add("is-editable");
      const select = element("select");
      select.setAttribute("aria-label", "Результат ретеста пункта " + number);
      select.add(new Option("Выбрать…", ""));
      select.options[0].disabled = true;
      for (const status of window.QaReportRetest.outcomes) select.add(new Option(status, status));
      select.value = saved?.status || "";
      const comment = element("textarea", "retest-comment");
      comment.maxLength = 10000;
      comment.value = saved?.comment || "";
      comment.setAttribute("aria-label", "Комментарий ретеста пункта " + number);
      comment.placeholder = "Добавить комментарий…";
      const message = element("p", "file-error");
      message.setAttribute("role", "status");
      const retry = button("Повторить сохранение");
      retry.hidden = true;
      statusCell.append(select);
      commentCell.classList.add("is-editable");
      const measure = element("span", "retest-text-measure");
      measure.setAttribute("aria-hidden", "true");
      const measureText = () => { measure.textContent = comment.value + "\u200b"; };
      measureText();
      comment.addEventListener("input", measureText);
      commentCell.append(comment, measure, message, retry);
      let busy = false, timer;
      const dirty = () => select.value !== (saved?.status || "") || comment.value !== (saved?.comment || "");
      const queue = () => {
        clearTimeout(timer);
        message.textContent = !select.value && comment.value ? "Выберите результат, чтобы сохранить комментарий." : "";
        retry.hidden = true;
        setAnswerSaveState(key, busy ? "saving" : dirty() ? "dirty" : "saved");
        if (select.value && dirty() && !busy) timer = setTimeout(save, 350);
      };
      async function save() {
        if (busy || !select.value || !dirty()) return;
        busy = true;
        setAnswerSaveState(key, "saving");
        try {
          const response = await request("/retest-result", { method: "POST", accountToken: await getSessionToken(),
            body: { sectionId, rowId, status: select.value, comment: comment.value, revision: saved?.revision || 0 } });
          saved = (await response.json()).result;
          retests.set(key, saved);
          statusCell.dataset.tone = statusMeta(saved.status).tone;
          busy = false;
          progress();
          showSelectedAnswer();
          queue();
        } catch (error) {
          busy = false;
          message.textContent = error.message;
          retry.hidden = error.status === 409;
          setAnswerSaveState(key, "error");
        }
      }
      retry.onclick = save;
      select.addEventListener("change", queue);
      comment.addEventListener("input", queue);
    }
    registerAnswer(tr, key, number, canRetest(), statusCell, commentCell);
  }

  function renderPoint(section, row, number, canReply, uploadsPaused, sectionNumber) {
    const tr = element("tr");
    tr.dataset.sectionNumber = sectionNumber;
    const index = element("th", "point-index", number);
    index.scope = "row";
    tr.append(index);
    const bugs = element("div", "bug-links");
    for (const bug of row.bugs || []) {
      const link = externalLink(bug.issueUrl, bug.key || "Связанный дефект");
      if (link) bugs.append(link);
    }
    for (const [position, column] of section.columns.entries()) {
      const td = element("td", "report-cell");
      if (column.type === "tags") window.QaReportTags.view(td, (row.cells[column.id]?.text || "").split("\n"));
      else appendContent(td, row.cells[column.id]);
      if (position === 0 && bugs.children.length) td.append(bugs);
      tr.append(td);
    }
    tr.dataset.pointCaption = tr.querySelector(".report-cell")?.innerText.trim() || "";
    const key = answerKey(section.id, row.id);
    const previous = returnedPoints.get(key) || previousPoints.get(key);
    if (workflow?.round > 1 && workflow.phase === "corrections" && !workflow.archived) {
      const cell = tr.querySelector(".report-cell");
      if (cell && previous) {
        cell.append(element("small", "workflow-point-note", workflow.handoff?.corrections
          ? "Осталось замечание" : previous.status === "OK" && row.status !== "OK" ? "Замечание появилось повторно" : "Проверяли ранее"));
        const details = element("details", "point-history");
        details.addEventListener("click", event => event.stopPropagation());
        details.append(element("summary", "", "Предыдущий ответ и ретест"));
        if (previous.answer) details.append(element("p", "", [window.QaReportRetest.replies[previous.answer.status],
          previous.answer.comment, formatDate(previous.answer.updatedAt)].filter(Boolean).join(" · ")));
        details.append(element("p", "", [previous.status, previous.comment, formatDate(previous.updatedAt)].filter(Boolean).join(" · ")));
        cell.append(details);
      } else if (cell && workflow.previousRows && !priorRowKeys.has(key)) cell.append(element("small", "workflow-point-note", "Новый пункт"));
    }
    if (isRetest()) {
      const answer = answers.get(key);
      const status = element("td", "report-cell", answerStatuses.get(answer?.status)?.label || "—");
      if (answer?.updatedAt) status.append(element("small", "workflow-date", formatDate(answer.updatedAt)));
      const comment = element("td", "report-cell");
      renderAnswerComment(comment, answer, key);
      tr.append(status, comment);
    }
    const spacer = element("td", "report-scroll-spacer");
    spacer.setAttribute("aria-hidden", "true");
    tr.append(spacer);
    const statusCell = element("td", "qa-status");
    statusCell.append(statusTag(row.status));
    if (!section.columns.length && bugs.children.length) statusCell.append(bugs);
    tr.append(statusCell);
    if (isRetest()) {
      prepareRetestRow(tr, section.columns);
      appendRetest(tr, section.id, row.id, number);
    }
    else appendAnswer(tr, section.id, row.id, number, canReply, uploadsPaused);
    return tr;
  }

  function updateVisibility() {
    const priority = row => answers.get(row.key)?.status === "needs_clarification" ? 0 : row.rank;
    let visible = 0;
    let total = 0;
    for (const section of sections) {
      const rows = order.value === "priority"
        ? [...section.rows].sort((a, b) => priority(a) - priority(b))
        : section.rows;
      total += rows.length;
      let sectionVisible = 0;
      rows.forEach((row, index) => {
        const matches = !selectedStatuses.size || selectedStatuses.has(row.status);
        row.element.hidden = !matches;
        if (section.points.children[index] !== row.element) section.points.insertBefore(row.element, section.points.children[index] || null);
        if (matches) sectionVisible++;
      });
      section.element.hidden = !sectionVisible;
      visible += sectionVisible;
    }
    counts.textContent = `${visible} из ${total}`;
    counts.setAttribute("aria-label", `Показано ${visible} из ${total}`);
    filterValue.textContent = statusFilterLabel(selectedStatuses);
    filter.dataset.multiple = String(selectedStatuses.size > 1);
    filterValue.title = [...selectedStatuses].join(", ");
    filterReset.disabled = !selectedStatuses.size;
    for (const input of filterOptions.querySelectorAll("input")) input.checked = selectedStatuses.has(input.value);
    noMatches.hidden = visible > 0;
    noMatchesMessage.textContent = total ? "Пунктов с выбранными статусами нет" : "В чек-листе пока нет заполненных пунктов";
    noMatchesReset.hidden = !selectedStatuses.size;
    ensureSelectedAnswer();
    syncReportLayout();
  }

  function resetStatusFilter() {
    selectedStatuses.clear();
    updateVisibility();
    filter.open = false;
    filter.querySelector("summary").focus();
  }
  filterReset.addEventListener("click", resetStatusFilter);
  noMatchesReset.addEventListener("click", resetStatusFilter);
  document.addEventListener("click", event => {
    if (!filter.contains(event.target)) filter.open = false;
  });
  filter.addEventListener("keydown", event => {
    // Let native label activation finish; close on keyboard navigation instead.
    if (event.key === "Tab") {
      requestAnimationFrame(() => { if (!filter.contains(document.activeElement)) filter.open = false; });
      return;
    }
    if (event.key !== "Escape" || !filter.open) return;
    event.preventDefault();
    filter.open = false;
    filter.querySelector("summary").focus();
  });

  function configureStatusFilter(defaults = []) {
    for (const status of defaults) selectedStatuses.add(statusKey(status));
    const statusCounts = new Map();
    for (const row of sections.flatMap(section => section.rows)) statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);
    const available = new Set([...statusCounts.keys()].filter(Boolean));
    const choices = new Set([...statuses.keys(), ...available, ...selectedStatuses]);
    const active = element("div", "report-filter-available");
    const unavailable = element("div", "report-filter-unavailable");
    unavailable.append(element("p", "report-filter-heading", "Нет в отчёте"));
    for (const status of choices) {
      const label = element("label");
      const input = element("input");
      input.type = "checkbox";
      input.value = status;
      input.disabled = !available.has(status) && !selectedStatuses.has(status);
      input.addEventListener("change", () => {
        if (input.checked) selectedStatuses.add(status);
        else selectedStatuses.delete(status);
        updateVisibility();
      });
      label.append(input, element("span", "", status), element("span", "report-filter-count", String(statusCounts.get(status) || 0)));
      (input.disabled ? unavailable : active).append(label);
    }
    filterOptions.replaceChildren(active, ...(unavailable.children.length > 1 ? [unavailable] : []));
  }

  function renderReport(report) {
    configureWorkflow(report);
    window.QaReportMcpSetup.init({ shareUrl: `${location.origin}/shared-report/${reportId}#${token}`, canReply: report.canReply });
    const title = report.title?.trim() || window.QaReportTrackerLinks.parse(report.issueUrl)?.key || "Отчёт о тестировании";
    const titleNode = document.getElementById("report-title");
    titleNode.textContent = title;
    titleNode.title = title;
    document.getElementById("access-label").hidden = report.canReply || canRetest();
    saveIndicator.hidden = !(report.canReply || canRetest());
    if (report.canReply && report.uploadsPaused) {
      document.getElementById("report-sections").before(element("p", "prose", "Загрузка вложений приостановлена. Текстовые ответы доступны."));
    }
    for (const file of report.files || []) files.set(file.id, file);
    for (const answer of report.answers || []) answers.set(answerKey(answer.sectionId, answer.rowId), answer);
    for (const file of report.answerFiles || []) rememberAnswerFile(file);
    renderOverview(document.getElementById("report-overview"), {
      ...report, published: report.createdAt && formatDate(report.createdAt),
      updated: formatDate(report.updatedAt || "") || "—",
    }, target => {
      const content = report.intro;
      const hasText = content?.fragments?.length
        ? content.fragments.some(fragment => fragment.text?.trim() || fragment.type === "link")
        : content?.text?.trim();
      const hasFiles = content?.attachments?.some(id => files.has(id));
      if (hasText || hasFiles) appendContent(target, content);
      return Boolean(hasText || hasFiles);
    });

    overviewControl.reset(!overview.hidden);

    const root = document.getElementById("report-sections");
    for (const [sectionIndex, section] of report.sections.entries()) {
      const title = section.title || `Раздел ${sectionIndex + 1}`;
      const labels = section.columns.map(column => column.label);
      if (isRetest()) labels.push("Статус ответа", "Комментарий к ответу");
      const { section: node, body: points } = createSection(title, labels, [
        [isRetest() ? "Результат ретеста" : "Статус ответа", "correction-status"],
        [isRetest() ? "Комментарий ретеста" : "Комментарий", "correction-comment"],
      ]);
      const table = node.querySelector("table");
      const head = table.tHead.rows[0];
      if (isRetest()) {
        prepareRetestRow(head, section.columns);
      } else {
        const spacer = element("th", "report-scroll-spacer");
        spacer.setAttribute("aria-hidden", "true");
        head.querySelector(".qa-status").before(spacer);
      }
      pins.attach(table);
      root.append(node);
      layoutObserver.observe(table);
      const active = workflow?.phase === "corrections" && workflow.handoff?.corrections;
      const allowed = active && new Set(active.map(ids => answerKey(...ids)));
      const rows = section.rows.flatMap((row, rowIndex) => {
        if (allowed && !allowed.has(answerKey(section.id, row.id))) return [];
        const sectionNumber = /^\s*(\d+(?:\.\d+)*)\.\s/.exec(title)?.[1] || String(sectionIndex + 1);
        const point = renderPoint(section, row, row.number || `${sectionIndex + 1}.${rowIndex + 1}`, report.canReply, report.uploadsPaused, sectionNumber);
        points.append(point);
        const key = answerKey(section.id, row.id), status = row.status;
        return { element: point, status: statusKey(status), rank: statusMeta(status).rank, key };
      });
      sections.push({ element: node, points, rows, table, columnCount: labels.length });
    }
    configureStatusFilter(isRetest() || workflow?.handoff?.corrections ? [] : report.defaultStatuses);
    order.addEventListener("change", updateVisibility);
    updateVisibility();
    setAnswerView(answerView);
    view.hidden = false;
    pageState.hidden = true;
    watchPendingAttachments();
  }

  function showPageError(title, help) {
    document.getElementById("report-error-title").textContent = title;
    document.getElementById("report-error-help").textContent = help;
    document.getElementById("report-loading").hidden = true;
    document.getElementById("report-error").hidden = false;
  }

  if (!reportId || !token) {
    showPageError("Ссылка неполная", "Попросите автора отчёта прислать её целиком.");
    return;
  }
  getReport().then(renderReport).catch(error => {
    if (error.status === 401 || error.status === 404) {
      showPageError("Отчёт о тестировании недоступен по ссылке", "Попросите автора проверить доступность.");
      return;
    }
    showPageError("Не удалось открыть отчёт", "Обновите страницу и попробуйте ещё раз.");
  });
})();
