/* Visual Jira wiki editor. The textarea remains the submission value. */
(function () {
  "use strict";
  const instances = new WeakMap();
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
    const caption = document.createElement("span"); caption.textContent = asset?.name || token.slice(11, -1); card.append(icon("paperclip"), caption); return card;
  }
  function wikiFragment(value, resolve) {
    function render(node) {
      if (node.type === "text") {
        const fragment = document.createDocumentFragment(), pattern = /\[Вложение: [^\]\r\n]{1,220}\]/g;
        let offset = 0;
        for (const match of node.text.matchAll(pattern)) { fragment.append(document.createTextNode(node.text.slice(offset, match.index)), attachment(match[0], resolve(match[0]))); offset = match.index + match[0].length; }
        fragment.append(document.createTextNode(node.text.slice(offset))); let result = fragment;
        for (const mark of [...(node.marks || [])].reverse()) {
          const tag = { strong: "strong", em: "em", underline: "u", code: "code", link: "a" }[mark.type];
          if (!tag) continue;
          const el = document.createElement(tag); if (tag === "a") { el.href = safeUrl(mark.attrs.href); el.rel = "noopener noreferrer"; } el.append(result); result = el;
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
    if (["B", "STRONG", "I", "EM", "U", "CODE"].includes(node.tagName)) {
      const text = contents(), marks = { B: "*", STRONG: "*", I: "_", EM: "_", U: "+", CODE: "{{" }, mark = marks[node.tagName];
      return text ? `${mark}${text}${node.tagName === "CODE" ? "}}" : mark}` : "";
    }
    // Chromium can express underline as a span after execCommand.
    if (node.tagName === "SPAN") {
      let value = contents();
      if (node.style.textDecorationLine.includes("underline")) value = `+${value}+`;
      if (node.style.fontStyle === "italic") value = `_${value}_`;
      if (node.style.fontWeight === "bold" || Number(node.style.fontWeight) >= 600) value = `*${value}*`;
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
    const locked = () => control.disabled || options.locked();
    function remember() { const selection = window.getSelection(); if (selection.rangeCount && visual.contains(selection.anchorNode) && visual.contains(selection.focusNode)) range = selection.getRangeAt(0).cloneRange(); }
    function focus(at) {
      visual.focus(); const selection = window.getSelection(); selection.removeAllRanges();
      if (at && visual.contains(at.startContainer) && visual.contains(at.endContainer)) selection.addRange(at);
      else if (range && visual.contains(range.startContainer) && visual.contains(range.endContainer)) selection.addRange(range);
      else { const end = document.createRange(); end.selectNodeContents(visual); end.collapse(false); selection.addRange(end); }
    }
    function sync() { if (writing) return; writing = true; control.value = wiki(visual).replace(/\n$/, ""); rendered = control.value; control.dispatchEvent(new Event("input", { bubbles: true })); writing = false; remember(); }
    function render(force = false) {
      if (!force && rendered === control.value) return;
      visual.replaceChildren(wikiFragment(control.value, resolve)); rendered = control.value; range = null;
    }
    function update() {
      const disabled = locked(); if (visual.contentEditable !== String(!disabled)) visual.contentEditable = String(!disabled); visual.setAttribute("aria-readonly", String(disabled));
      toolbar.querySelectorAll("button").forEach(button => { button.disabled = disabled || Boolean(button.dataset.attachments && !options.inlineReady()); });
      for (const [name, button] of buttons) { try { button.setAttribute("aria-pressed", String(shell.dataset.mode === "visual" && Boolean(document.queryCommandState(name)))); } catch {} }
    }
    function insert(fragment, at) {
      if (locked()) return;
      focus(at); const div = document.createElement("div"); div.append(fragment);
      const selection = window.getSelection(), selectionRange = selection.getRangeAt(0), content = document.createDocumentFragment();
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
      el.addEventListener("pointerdown", event => event.preventDefault()); el.addEventListener("click", () => { if (!locked()) callback(); }); return el;
    }
    const applyLink = () => {
      if (!safeUrl(url.value)) { url.setCustomValidity("Введите адрес, начинающийся с https:// или http://"); url.reportValidity(); return; }
      url.setCustomValidity(""); focus(); const anchor = document.createElement("a"), selection = window.getSelection(); anchor.href = safeUrl(url.value); anchor.rel = "noopener noreferrer";
      if (selection.isCollapsed) anchor.textContent = url.value; else anchor.append(selection.getRangeAt(0).cloneContents());
      const fragment = document.createDocumentFragment(); fragment.append(anchor); insert(fragment); linkRow.hidden = true;
    };
    linkRow.append(url, button("Добавить ссылку", "Добавить", applyLink), button("Отменить ссылку", icon("close"), () => { linkRow.hidden = true; focus(); }));
    url.addEventListener("input", () => url.setCustomValidity("")); url.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); linkRow.hidden = true; focus(); } });
    for (const [name, command, title, symbol] of [["bold", "bold", "Полужирный", "B"], ["italic", "italic", "Курсив", "I"], ["underline", "underline", "Подчёркнутый", "U"], ["bullet", "insertUnorderedList", "Маркированный список", "list"], ["ordered", "insertOrderedList", "Нумерованный список", "list-ordered"], ["link", "createLink", "Ссылка", "link"], ["code", "code", "Код в строке", "code"], ["codeblock", "codeblock", "Блок кода", "{}"]]) {
      const el = button(title, symbol.length === 1 || symbol === "{}" ? symbol : icon(symbol), () => {
        if (shell.dataset.mode === "source") {
          const start = control.selectionStart, end = control.selectionEnd, text = control.value.slice(start, end) || "текст", marks = { bold: "*", italic: "_", underline: "+", code: "{{" };
          const value = (name === "codeblock" || name === "code" && text.includes("\n")) ? `${start && control.value[start - 1] !== "\n" ? "\n" : ""}{code}\n${text}\n{code}${end < control.value.length && control.value[end] !== "\n" ? "\n" : ""}` : ["bullet", "ordered"].includes(name) ? text.split("\n").map(line => `${name === "bullet" ? "*" : "#"} ${line}`).join("\n") : name === "link" ? `[${text}|https://]` : `${marks[name]}${text}${name === "code" ? "}}" : marks[name]}`;
          control.focus(); control.setRangeText(value, start, end, "select"); control.dispatchEvent(new Event("input", { bubbles: true })); return;
        }
        focus();
        if (name === "link") { remember(); linkRow.hidden = false; url.value = ""; url.focus(); return; }
        if (name === "code" || name === "codeblock") { const value = window.getSelection().toString() || "код", code = document.createElement(name === "codeblock" || value.includes("\n") ? "pre" : "code"); code.textContent = value; const fragment = document.createDocumentFragment(); fragment.append(code); insert(fragment); }
        else {
          const selection = window.getSelection(), original = selection.getRangeAt(0).cloneRange(), fragment = original.cloneContents(), before = document.queryCommandState(command);
          windowCommand(command);
          if (["bold", "italic", "underline"].includes(command) && !original.collapsed && before === document.queryCommandState(command) && !before) {
            const mark = document.createElement({ bold: "strong", italic: "em", underline: "u" }[command]); mark.append(fragment);
            const replacement = document.createDocumentFragment(); replacement.append(mark); insert(replacement, original);
          }
          sync();
        }
        update();
      });
      el.dataset.format = name; toolbar.append(el); buttons.set(command, el);
    }
    const picker = document.createElement("div"); picker.className = "bug-rich-attachment-picker"; picker.hidden = true; picker.setAttribute("role", "group"); picker.setAttribute("aria-label", "Вложения для описания");
    const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true; fileInput.setAttribute("aria-label", "Загрузить вложение в описание");
    let attachButton, insertion;
    const captureInsertion = () => shell.dataset.mode === "source" ? { start: control.selectionStart, end: control.selectionEnd } : instance.captureRange();
    if (options.attachments) {
      const closePicker = () => { picker.hidden = true; attachButton.setAttribute("aria-expanded", "false"); };
      attachButton = button("Вставить вложение в описание", icon("paperclip"), () => {
        if (!picker.hidden) { closePicker(); return; }
        insertion = captureInsertion(); const assets = options.attachments();
        if (!assets.length) { fileInput.click(); return; }
        picker.replaceChildren();
        for (const asset of assets) {
          const choice = button(`Вставить ${asset.name}`, asset.name, () => { closePicker(); options.insertAsset(asset, insertion); }); choice.className = "bug-rich-attachment-choice"; picker.append(choice);
        }
        picker.append(button("Загрузить новый файл", "Загрузить новый файл…", () => { closePicker(); fileInput.click(); })); picker.hidden = false; attachButton.setAttribute("aria-expanded", "true");
      });
      attachButton.dataset.attachments = "true"; attachButton.setAttribute("aria-expanded", "false"); toolbar.append(attachButton);
      fileInput.addEventListener("change", async () => { const files = [...fileInput.files]; fileInput.value = ""; if (files.length && !locked()) await options.insertFiles(files, insertion); });
      shell.addEventListener("keydown", event => { if (event.key === "Escape" && !picker.hidden) { event.preventDefault(); event.stopPropagation(); closePicker(); attachButton.focus(); } });
    }
    const modes = document.createElement("div"); modes.className = "bug-rich-modes"; modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Режим редактирования");
    for (const [mode, title] of [["visual", "Визуально"], ["source", "Разметка"]]) {
      const el = button(title, title, () => {
        if (mode === shell.dataset.mode) return;
        linkRow.hidden = picker.hidden = true;
        if (mode === "source") { remember(); sync(); } else render();
        shell.dataset.mode = mode; visual.hidden = mode !== "visual"; control.hidden = mode !== "source";
        modes.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item === el))); (mode === "visual" ? visual : control).focus();
      }); el.dataset.editorMode = mode; el.setAttribute("aria-pressed", String(mode === "visual")); modes.append(el);
    }
    toolbar.append(modes); control.hidden = true; shell.append(toolbar, linkRow, picker, fileInput, visual, control);
    visual.addEventListener("input", () => { queueMicrotask(() => { sync(); update(); }); });
    for (const event of ["keyup", "mouseup", "focusout"]) visual.addEventListener(event, () => { remember(); update(); });
    visual.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) { event.preventDefault(); shell.querySelector(`[data-format="${{ b: "bold", i: "italic", u: "underline" }[event.key.toLowerCase()]}"]`).click(); }
    });
    visual.addEventListener("paste", event => {
      if (event.clipboardData?.files.length) return; event.preventDefault(); if (locked()) return;
      const html = event.clipboardData?.getData("text/html"), text = event.clipboardData?.getData("text/plain") || "";
      if (html) { const template = document.createElement("template"); template.innerHTML = html; insert(wikiFragment(wiki(template.content).replace(/\n$/, ""), resolve)); }
      else { focus(); document.execCommand("insertText", false, text); sync(); }
    });
    visual.addEventListener("click", event => { if (event.target.closest("a")) event.preventDefault(); });
    control.addEventListener("input", () => { if (!writing) render(); });
    const instance = { visual, render, update, captureRange() { remember(); return range?.cloneRange(); }, insertTokens(tokens, at) { const fragment = document.createDocumentFragment(); tokens.forEach((token, i) => { if (i) fragment.append(document.createElement("br")); fragment.append(attachment(token, resolve(token))); }); insert(fragment, at); }, dropRange(event) {
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY), found = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (caret && visual.contains(caret.offsetNode)) { const value = document.createRange(); value.setStart(caret.offsetNode, caret.offset); value.collapse(true); return value; }
      return found && visual.contains(found.startContainer) ? found : range;
    } };
    instances.set(control, instance); render(); update(); return shell;
  }
  document.addEventListener("pointerdown", event => {
    document.querySelectorAll(".bug-rich-attachment-picker:not([hidden])").forEach(picker => {
      const shell = picker.closest(".bug-rich-field"); if (shell.contains(event.target)) return;
      picker.hidden = true; shell.querySelector("[data-attachments]").setAttribute("aria-expanded", "false");
    });
  }, { capture: true });
  window.QaReportBugRich = { attach, get: control => instances.get(control), sync(root) { root.querySelectorAll("textarea").forEach(control => { const editor = instances.get(control); editor?.render(); editor?.update(); }); } };
})();
