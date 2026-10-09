/* Visual Jira wiki editor. The textarea remains the submission value. */
(function () {
  "use strict";
  const instances = new WeakMap(), visualInstances = new WeakMap();
  function windowCommand(name, value) {
    const previous = document.queryCommandState("styleWithCSS");
    document.execCommand("styleWithCSS", false, false);
    try { return document.execCommand(name, false, value); }
    finally { document.execCommand("styleWithCSS", false, previous); }
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("ui-icon"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", `#icon-${name}`); svg.append(use); return svg;
  }
  const imageData = value => /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value || "");
  const safeUrl = value => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } };
  function attachment(token, asset) {
    const card = document.createElement("span"); card.className = "bug-rich-asset"; card.dataset.attachmentPlaceholder = token; card.contentEditable = "false"; card.title = asset?.name || token;
    if (asset && imageData(asset.dataUrl)) { const image = document.createElement("img"); image.src = asset.dataUrl; image.alt = asset.name; image.draggable = false; card.append(image); }
    const caption = document.createElement("span"); caption.textContent = asset?.name || (token.startsWith("!") ? token.slice(1, -11) : token.startsWith("[^") ? token.slice(2, -1) : token.slice(11, -1)); card.append(icon("paperclip"), caption); return card;
  }
  function wikiFragment(value, resolve) {
    function render(node) {
      if (node.type === "text") {
        const fragment = document.createDocumentFragment(), pattern = /\[Вложение: [^\]\r\n]{1,220}\]|\[\^[^\]\r\n]{1,220}\]|![^!|\r\n]{1,220}\|thumbnail!/g;
        let offset = 0;
        for (const match of node.text.matchAll(pattern)) { fragment.append(document.createTextNode(node.text.slice(offset, match.index)), attachment(match[0], resolve(match[0]))); offset = match.index + match[0].length; }
        fragment.append(document.createTextNode(node.text.slice(offset))); let result = fragment;
        for (const mark of [...(node.marks || [])].reverse()) {
          const tag = { strong: "strong", em: "em", underline: "u", strike: "s", textColor: "span", code: "code", link: "a" }[mark.type];
          if (!tag) continue;
          const el = document.createElement(tag); if (tag === "a") { el.href = safeUrl(mark.attrs.href); el.rel = "noopener noreferrer"; } if (mark.type === "textColor") el.style.color = mark.attrs.color; el.append(result); result = el;
        }
        return result;
      }
      const tag = { paragraph: "div", bulletList: "ul", orderedList: "ol", listItem: "li", codeBlock: "pre", blockquote: "blockquote" }[node.type] || (node.type === "heading" ? `h${node.attrs.level}` : "");
      const el = tag ? document.createElement(tag) : document.createDocumentFragment();
      if (node.type === "codeBlock") { el.textContent = (node.content || []).map(item => item.text || "").join(""); if (node.attrs?.language) el.dataset.language = node.attrs.language; }
      else { el.append(...(node.content || []).map(render)); if (tag === "div" && !el.childNodes.length) el.append(document.createElement("br")); }
      return el;
    }
    return render(window.QaReportBugs.textDocument(value));
  }
  function wiki(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data.replace(/\u00a0/g, " ").replace(/[\\*_+\[\]{}#]/g, "\\$&");
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
    if (node.dataset?.attachmentPlaceholder) return node.dataset.attachmentPlaceholder;
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "IMG"].includes(node.tagName)) return "";
    if (node.tagName === "PRE") return `{code${node.dataset.language ? ":" + node.dataset.language : ""}}\n${node.innerText || node.textContent || ""}\n{code}\n`;
    if (node.tagName === "CODE") return `{{${node.textContent}}}`;
    const contents = () => {
      let result = "";
      for (const child of node.childNodes) {
        if (["DIV", "P", "UL", "OL", "PRE", "BLOCKQUOTE"].includes(child.nodeName) && result && !result.endsWith("\n")) result += "\n";
        result += wiki(child);
      }
      return result;
    };
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "A") { const text = contents(), url = safeUrl(node.getAttribute("href")); return url ? `[${text.replace(/[\[\]|]/g, " ")}|${url.replace(/[\[\]|]/g, encodeURIComponent)}]` : text; }
    if (["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "CODE"].includes(node.tagName)) {
      const text = contents(), marks = { B: "*", STRONG: "*", I: "_", EM: "_", U: "+", S: "-", STRIKE: "-", DEL: "-", CODE: "{{" }, mark = marks[node.tagName];
      return text ? `${mark}${text}${node.tagName === "CODE" ? "}}" : mark}` : "";
    }
    // Chromium can express underline as a span after execCommand.
    if (node.tagName === "SPAN" || node.tagName === "FONT") {
      let value = contents();
      if (node.style.textDecorationLine.includes("underline")) value = `+${value}+`;
      if (node.style.fontStyle === "italic") value = `_${value}_`;
      if (node.style.fontWeight === "bold" || Number(node.style.fontWeight) >= 600) value = `*${value}*`;
      if (node.style.textDecorationLine.includes("line-through")) value = `-${value}-`;
      const color = node.getAttribute("color") || node.style.color;
      if (color) {
        const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/), hex = rgb ? "#" + rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("") : color;
        if (/^#[a-f\d]{6}$/i.test(hex)) value = `{color:${hex}}${value}{color}`;
      }
      return value;
    }
    if (["UL", "OL"].includes(node.tagName)) return [...node.children].map(li => `${node.tagName === "UL" ? "*" : "#"} ${wiki(li).replace(/\n+$/, "")}`).join("\n") + "\n";
    if (["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"].includes(node.tagName)) {
      const text = contents().replace(/\n$/, ""); return (/^H[1-6]$/.test(node.tagName) ? `h${node.tagName[1]}. ${text}` : node.tagName === "BLOCKQUOTE" ? `bq. ${text}` : text) + "\n";
    }
    return contents();
  }
  function attach(control, options) {
    const shell = document.createElement("div"); shell.className = "bug-rich-field"; shell.dataset.mode = "visual"; control.replaceWith(shell);
    const toolbar = document.createElement("div"); toolbar.className = "bug-rich-toolbar"; toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "Форматирование текста");
    const visual = document.createElement("div"); visual.className = "bug-rich-visual"; visual.contentEditable = "true"; visual.setAttribute("role", "textbox"); visual.setAttribute("aria-multiline", "true"); visual.setAttribute("aria-label", control.getAttribute("aria-label")); visual.setAttribute("aria-required", control.getAttribute("aria-required") || "false"); visual.spellcheck = true;
    const resolve = token => options.asset?.(token), buttons = new Map(); let range = null, rendered = null, writing = false;
    const undoStack = [], redoStack = []; let current = null, lastTyping = null, restoring = false;
    const locked = () => control.disabled || options.locked();
    function position() {
      const selection = window.getSelection(), selected = selection.rangeCount && selection.getRangeAt(0);
      let visualSelection = null;
      if (selected && visual.contains(selected.startContainer) && visual.contains(selected.endContainer)) {
        const prefix = document.createRange(); prefix.selectNodeContents(visual); prefix.setEnd(selected.startContainer, selected.startOffset);
        const start = prefix.toString().length; prefix.setEnd(selected.endContainer, selected.endOffset);
        visualSelection = { start, end: prefix.toString().length };
      }
      return { source: { start: control.selectionStart, end: control.selectionEnd }, visual: visualSelection };
    }
    function checkpoint() { if (current) current.position = position(); }
    function record(type = "action") {
      if (restoring) return;
      const next = { value: control.value, position: position() };
      if (!current) { current = next; return; }
      if (next.value === current.value) return;
      const typing = ["insertText", "insertCompositionText", "deleteContentBackward", "deleteContentForward"].includes(type);
      const now = performance.now(), group = typing && lastTyping?.type === type && lastTyping.mode === shell.dataset.mode && now - lastTyping.time < 700;
      if (!group) undoStack.push(current);
      if (undoStack.length > 100) undoStack.shift();
      current = next; redoStack.length = 0; lastTyping = typing ? { type, time: now, mode: shell.dataset.mode } : null;
    }
    function restorePosition(saved) {
      if (shell.dataset.mode === "source") { control.focus(); control.setSelectionRange(saved?.source.start || 0, saved?.source.end || 0); return; }
      visual.focus(); const selection = window.getSelection(), selected = document.createRange(), points = [];
      if (saved?.visual) {
        const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT); let node, offset = 0;
        while ((node = walker.nextNode())) {
          for (const key of ["start", "end"]) if (!points[key] && saved.visual[key] <= offset + node.length) points[key] = { node, offset: Math.max(0, saved.visual[key] - offset) };
          offset += node.length;
        }
      }
      if (points.start && points.end) {
        for (const [key, point] of Object.entries(points)) {
          const asset = point.node.parentElement?.closest(".bug-rich-asset");
          if (asset) selected[key === "start" ? "setStartAfter" : "setEndAfter"](asset);
          else selected[key === "start" ? "setStart" : "setEnd"](point.node, point.offset);
        }
      } else { selected.selectNodeContents(visual); selected.collapse(false); }
      selection.removeAllRanges(); selection.addRange(selected); remember();
    }
    function history(redo = false) {
      if (locked()) return;
      if (shell.dataset.mode === "visual") sync();
      const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack, saved = from.pop();
      if (!saved) return;
      to.push(current); current = saved; lastTyping = null; restoring = true; writing = true;
      control.value = saved.value; rendered = null; render(false, false);
      control.dispatchEvent(new Event("input", { bubbles: true })); writing = false;
      restorePosition(saved.position); update(); restoring = false;
    }
    function remember() { const selection = window.getSelection(); if (selection.rangeCount && visual.contains(selection.anchorNode) && visual.contains(selection.focusNode)) range = selection.getRangeAt(0).cloneRange(); }
    function focus(at) {
      if (!at) remember();
      const saved = (at || range)?.cloneRange();
      visual.focus(); const selection = window.getSelection(); selection.removeAllRanges();
      if (saved && visual.contains(saved.startContainer) && visual.contains(saved.endContainer)) selection.addRange(saved);
      else { const end = document.createRange(); end.selectNodeContents(visual); end.collapse(false); selection.addRange(end); }
    }
    function sync(type = "action") { if (writing) return; writing = true; control.value = wiki(visual).replace(/\n$/, ""); rendered = control.value; control.dispatchEvent(new Event("input", { bubbles: true })); writing = false; remember(); record(type); }
    function render(force = false, resetHistory = true) {
      if (!force && rendered === control.value) return;
      visual.replaceChildren(wikiFragment(control.value, resolve)); rendered = control.value; range = null;
      if (resetHistory) { undoStack.length = redoStack.length = 0; current = null; lastTyping = null; record(); }
    }
    function update() {
      const disabled = locked(); if (visual.contentEditable !== String(!disabled)) visual.contentEditable = String(!disabled); visual.setAttribute("aria-readonly", String(disabled));
      toolbar.querySelectorAll("button").forEach(button => { button.disabled = disabled; });
      for (const [name, button] of buttons) { try { button.setAttribute("aria-pressed", String(shell.dataset.mode === "visual" && Boolean(document.queryCommandState(name)))); } catch {} }
    }
    function insert(fragment, at) {
      if (locked()) return;
      if (!visual.textContent && !visual.querySelector(".bug-rich-asset")) { visual.replaceChildren(); range = null; at = null; }
      focus(at); const div = document.createElement("div"); div.append(fragment);
      const selection = window.getSelection(), selectionRange = selection.getRangeAt(0), content = document.createDocumentFragment();
      const ancestor = selectionRange.commonAncestorContainer, element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement, code = element?.closest("pre");
      if (code && visual.contains(code) && div.querySelector(".bug-rich-asset")) { selectionRange.deleteContents(); selectionRange.setStartAfter(code); selectionRange.collapse(true); }
      while (div.firstChild) content.append(div.firstChild);
      const last = content.lastChild; selectionRange.deleteContents(); selectionRange.insertNode(content);
      if (last) { selectionRange.setStartAfter(last); selectionRange.collapse(true); selection.removeAllRanges(); selection.addRange(selectionRange); }
      sync(); update();
    }
    const linkRow = document.createElement("div"); linkRow.className = "bug-rich-link-row"; linkRow.hidden = true;
    const url = document.createElement("input"); url.type = "url"; url.placeholder = "https://"; url.setAttribute("aria-label", "Адрес ссылки");
    function button(title, content, callback) {
      const el = document.createElement("button"); el.type = "button"; el.title = title; el.setAttribute("aria-label", title);
      if (typeof content === "string") el.textContent = content; else el.append(content);
      el.addEventListener("pointerdown", event => { remember(); checkpoint(); lastTyping = null; event.preventDefault(); }); el.addEventListener("click", () => { if (!locked()) { remember(); checkpoint(); lastTyping = null; callback(); } }); return el;
    }
    const applyLink = () => {
      if (!safeUrl(url.value)) { url.setCustomValidity("Введите адрес, начинающийся с https:// или http://"); url.reportValidity(); return; }
      url.setCustomValidity(""); focus(); const anchor = document.createElement("a"), selection = window.getSelection(); anchor.href = safeUrl(url.value); anchor.rel = "noopener noreferrer";
      if (selection.isCollapsed) anchor.textContent = url.value; else anchor.append(selection.getRangeAt(0).cloneContents());
      const fragment = document.createDocumentFragment(); fragment.append(anchor); insert(fragment); linkRow.hidden = true;
    };
    linkRow.append(url, button("Добавить ссылку", "Добавить", applyLink), button("Отменить ссылку", icon("close"), () => { linkRow.hidden = true; focus(); }));
    url.addEventListener("input", () => url.setCustomValidity("")); url.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); linkRow.hidden = true; focus(); } });
    function insertCode(snippet) {
      // Deleting all text can leave an empty PRE in a contenteditable element.
      // A fresh paste replaces that empty shell instead of nesting another block.
      if (!visual.textContent && !visual.querySelector(".bug-rich-asset")) { visual.replaceChildren(); range = null; }
      const ancestor = range?.commonAncestorContainer, element = ancestor?.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor?.parentElement;
      const existing = element?.closest("pre");
      if (existing && visual.contains(existing)) {
        const fragment = document.createDocumentFragment(); fragment.append(document.createTextNode(String(snippet.code || "").replace(/\r\n?/g, "\n"))); insert(fragment); return;
      }
      const code = document.createElement("pre"); code.textContent = window.formatCode(snippet.code);
      const language = snippet.language || window.detectCodeLanguage(code.textContent);
      if (language && language !== "text") code.dataset.language = language;
      if (!code.textContent) code.append(document.createElement("br"));
      const fragment = document.createDocumentFragment(); fragment.append(code, document.createElement("div")); insert(fragment);
    }
    for (const [name, command, title, symbol] of [["bold", "bold", "Полужирный", "B"], ["italic", "italic", "Курсив", "I"], ["underline", "underline", "Подчёркнутый", "U"], ["strike", "strikeThrough", "Зачёркнутый", "S"], ["bullet", "insertUnorderedList", "Маркированный список", "list"], ["ordered", "insertOrderedList", "Нумерованный список", "list-ordered"], ["link", "createLink", "Ссылка", "link"], ["codeblock", "codeblock", "Блок кода", "code"]]) {
      const el = button(title, symbol.length === 1 || symbol === "{}" ? symbol : icon(symbol), () => {
        if (shell.dataset.mode === "source") {
          const start = control.selectionStart, end = control.selectionEnd, text = control.value.slice(start, end) || (name === "codeblock" ? "" : "текст"), marks = { bold: "*", italic: "_", underline: "+", strike: "-" };
          const value = name === "codeblock" ? `${start && control.value[start - 1] !== "\n" ? "\n" : ""}{code}\n${text}\n{code}${end < control.value.length && control.value[end] !== "\n" ? "\n" : ""}` : ["bullet", "ordered"].includes(name) ? text.split("\n").map(line => `${name === "bullet" ? "*" : "#"} ${line}`).join("\n") : name === "link" ? `[${text}|https://]` : `${marks[name]}${text}${marks[name]}`;
          control.focus(); control.setRangeText(value, start, end, "select"); control.dispatchEvent(new Event("input", { bubbles: true })); return;
        }
        focus();
        if (name === "link") { remember(); linkRow.hidden = false; url.value = ""; url.focus(); return; }
        if (name === "codeblock") insertCode({ code: window.getSelection().toString() });
        else {
          const selection = window.getSelection(), original = selection.getRangeAt(0).cloneRange(), fragment = original.cloneContents(), before = document.queryCommandState(command);
          windowCommand(command);
          if (["bold", "italic", "underline", "strikeThrough"].includes(command) && !original.collapsed && before === document.queryCommandState(command) && !before) {
            const mark = document.createElement({ bold: "strong", italic: "em", underline: "u", strikeThrough: "s" }[command]); mark.append(fragment);
            const replacement = document.createDocumentFragment(); replacement.append(mark); insert(replacement, original);
          }
          sync();
        }
        update();
      });
      el.dataset.format = name; toolbar.append(el); buttons.set(command, el);
    }
    const extraMenu = document.createElement("div"); extraMenu.className = "bug-rich-extra-menu"; extraMenu.hidden = true;
    function sourceFormat(prefix, suffix = prefix) {
      const start = control.selectionStart, end = control.selectionEnd, text = control.value.slice(start, end) || "текст";
      control.focus(); control.setRangeText(prefix + text + suffix, start, end, "select"); control.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const styleButton = button("Стиль текста", "Стиль", () => {
      extraMenu.replaceChildren(); extraMenu.setAttribute("aria-label", "Стиль текста");
      for (const [tag, title] of [["p", "Обычный текст"], ["h2", "Заголовок 2"], ["h3", "Заголовок 3"]]) extraMenu.append(button(title, title, () => {
        if (shell.dataset.mode === "source") {
          const start = control.value.lastIndexOf("\n", control.selectionStart - 1) + 1, found = control.value.indexOf("\n", control.selectionEnd), end = found < 0 ? control.value.length : found;
          const text = control.value.slice(start, end).split("\n").map(line => (tag === "p" ? "" : `${tag}. `) + line.replace(/^h[1-6]\.\s*/, "")).join("\n");
          control.focus(); control.setRangeText(text, start, end, "select"); control.dispatchEvent(new Event("input", { bubbles: true }));
        } else { focus(); windowCommand("formatBlock", tag); sync(); }
        extraMenu.hidden = true;
      }));
      extraMenu.hidden = false;
    }); styleButton.className = "bug-rich-style-button"; toolbar.prepend(styleButton);
    const colorButton = button("Цвет текста", "A", () => {
      extraMenu.replaceChildren(); extraMenu.setAttribute("aria-label", "Цвет текста");
      // Use the checklist's palette rather than a second set of formatting colors.
      document.querySelectorAll("#textColorMenu [data-color]").forEach(swatch => {
        const color = swatch.dataset.color, title = swatch.getAttribute("aria-label");
        const choice = button(title, "A", () => {
          if (shell.dataset.mode === "source") sourceFormat(`{color:${color}}`, "{color}");
          else { focus(); windowCommand("foreColor", color); sync(); }
          extraMenu.hidden = true;
        }); choice.style.color = color; extraMenu.append(choice);
      }); extraMenu.hidden = false;
    }); colorButton.dataset.format = "color"; toolbar.append(colorButton);
    const picker = document.createElement("div"); picker.className = "bug-rich-attachment-picker"; picker.hidden = true; picker.setAttribute("role", "group"); picker.setAttribute("aria-label", "Вложения для описания");
    const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true; fileInput.setAttribute("aria-label", "Загрузить вложение в описание");
    function chooseFiles() { if (fileInput.showPicker) { try { fileInput.showPicker(); return; } catch {} } fileInput.click(); }
    let attachButton, insertion;
    const captureInsertion = () => shell.dataset.mode === "source" ? { start: control.selectionStart, end: control.selectionEnd } : instance.captureRange();
    if (options.attachments) {
      const closePicker = () => { picker.hidden = true; attachButton.setAttribute("aria-expanded", "false"); };
      attachButton = button("Вставить вложение в описание", icon("paperclip"), () => {
        if (!picker.hidden) { closePicker(); return; }
        insertion = captureInsertion(); const assets = options.attachments();
        picker.replaceChildren();
        if (!options.inlineReady()) {
          const hint = document.createElement("p"); hint.textContent = "Для вставки файлов в описание нужен Connect 0.6.16 или новее. Обновите его в настройках Connect."; picker.append(hint);
          picker.hidden = false; attachButton.setAttribute("aria-expanded", "true"); return;
        }
        for (const asset of assets) {
          const choice = button(`Вставить ${asset.name}`, asset.name, () => { closePicker(); options.insertAsset(asset, insertion); }); choice.className = "bug-rich-attachment-choice"; picker.append(choice);
        }
        picker.append(button("Загрузить новый файл", "Загрузить новый файл…", () => { closePicker(); chooseFiles(); })); picker.hidden = false; attachButton.setAttribute("aria-expanded", "true");
      });
      attachButton.dataset.attachments = "true"; attachButton.setAttribute("aria-expanded", "false"); toolbar.append(attachButton);
      fileInput.addEventListener("change", async () => { const files = [...fileInput.files]; fileInput.value = ""; if (files.length && !locked()) await options.insertFiles(files, insertion); });
      shell.addEventListener("keydown", event => { if (event.key === "Escape" && !picker.hidden) { event.preventDefault(); event.stopPropagation(); closePicker(); attachButton.focus(); } });
    }
    const modes = document.createElement("div"); modes.className = "bug-rich-modes"; modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Режим редактирования");
    for (const [mode, title] of [["visual", "Визуально"], ["source", "Разметка"]]) {
      const el = button(title, title, () => {
        if (mode === shell.dataset.mode) return;
        linkRow.hidden = picker.hidden = extraMenu.hidden = true;
        if (mode === "source") { remember(); sync(); } else render();
        shell.dataset.mode = mode; visual.hidden = mode !== "visual"; control.hidden = mode !== "source";
        modes.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item === el))); (mode === "visual" ? visual : control).focus();
      }); el.dataset.editorMode = mode; el.setAttribute("aria-pressed", String(mode === "visual")); modes.append(el);
    }
    toolbar.append(modes); control.hidden = true; shell.append(toolbar, linkRow, extraMenu, picker, fileInput, visual, control);
    visual.addEventListener("input", event => { queueMicrotask(() => { sync(event.inputType); update(); }); });
    shell.addEventListener("beforeinput", event => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") { event.preventDefault(); event.stopPropagation(); history(event.inputType === "historyRedo"); return; }
      checkpoint();
    });
    shell.addEventListener("keydown", event => {
      if (event.isComposing || event.altKey) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(key)) { event.preventDefault(); event.stopPropagation(); history(key === "y" || event.shiftKey); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) lastTyping = null;
    });
    shell.addEventListener("pointerdown", event => { if (event.target === control || visual.contains(event.target)) lastTyping = null; });
    for (const event of ["keyup", "mouseup", "focusout"]) visual.addEventListener(event, () => { remember(); update(); });
    visual.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) { event.preventDefault(); shell.querySelector(`[data-format="${{ b: "bold", i: "italic", u: "underline" }[event.key.toLowerCase()]}"]`).click(); }
    });
    visual.addEventListener("paste", event => {
      if (event.clipboardData?.files.length) return; event.preventDefault(); if (locked()) return;
      const html = event.clipboardData?.getData("text/html"), text = event.clipboardData?.getData("text/plain") || "";
      remember();
      // Reuse the checklist's code recognition, including fenced code and IDE text.
      const snippet = window.parseCodeFromClipboard(html, text);
      if (snippet || window.looksLikeCode(text)) { insertCode(snippet || { code: text }); return; }
      if (html) { const template = document.createElement("template"); template.innerHTML = html; options.clipboardAssets?.(template); insert(wikiFragment(wiki(template.content).replace(/\n$/, ""), resolve)); }
      else { focus(); document.execCommand("insertText", false, text); sync(); }
    });
    visual.addEventListener("click", event => { if (event.target.closest("a")) event.preventDefault(); });
    control.addEventListener("input", event => { if (!writing) { render(false, false); record(event.inputType); } });
    const instance = { visual, render, update, remember, captureRange() { remember(); return range?.cloneRange(); }, insertTokens(tokens, at) { const fragment = document.createDocumentFragment(); tokens.forEach((token, i) => { if (i) fragment.append(document.createElement("br")); fragment.append(attachment(token, resolve(token))); }); insert(fragment, at); }, dropRange(event) {
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY), found = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (caret && visual.contains(caret.offsetNode)) { const value = document.createRange(); value.setStart(caret.offsetNode, caret.offset); value.collapse(true); return value; }
      return found && visual.contains(found.startContainer) ? found : range;
    } };
    instances.set(control, instance); visualInstances.set(visual, instance); render(); update(); return shell;
  }
  document.addEventListener("selectionchange", () => {
    const node = window.getSelection()?.anchorNode, visual = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(".bug-rich-visual");
    visualInstances.get(visual)?.remember();
  });
  document.addEventListener("pointerdown", event => {
    document.querySelectorAll(".bug-rich-attachment-picker:not([hidden])").forEach(picker => {
      const shell = picker.closest(".bug-rich-field"); if (shell.contains(event.target)) return;
      picker.hidden = true; shell.querySelector("[data-attachments]").setAttribute("aria-expanded", "false");
    });
  }, { capture: true });
  window.QaReportBugRich = { attach, get: control => instances.get(control), sync(root) { root.querySelectorAll("textarea").forEach(control => { const editor = instances.get(control); editor?.render(); editor?.update(); }); } };
})();
