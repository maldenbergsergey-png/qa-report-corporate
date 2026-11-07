(() => {
  "use strict";

  const maxLength = 10000;
  const maxNodes = 2048;
  const maxDepth = 20;
  const tags = new Set("p div h2 h3 b i u s ul ol li pre code br a span blockquote".split(" "));
  const blockTags = new Set("p div h2 h3 ul ol li pre blockquote".split(" "));
  const aliases = { strong: "b", em: "i", strike: "s", del: "s", font: "span" };
  const droppedTags = new Set("script style iframe object embed svg math template img audio video".split(" "));
  const plainTags = new Set(["p", "div", "br"]);

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4000 ? url.href : "";
    } catch {
      return "";
    }
  }

  function safeColor(value) {
    if (/^#[0-9a-f]{6}$/i.test(value || "")) return value.toLowerCase();
    const rgb = /^rgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)$/i.exec(value || "");
    const channels = rgb?.slice(1).map(Number);
    return channels?.every(channel => channel <= 255)
      ? `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}` : "";
  }

  function domDocument(root, includeAttachments = false) {
    let nodes = 0;
    let length = 0;
    function readNode(node, depth) {
      if (depth > maxDepth || ++nodes > maxNodes) throw new RangeError();
      if (node.nodeType === Node.TEXT_NODE) {
        length += node.data.length;
        if (length > maxLength) throw new RangeError();
        return node.data ? [node.data] : [];
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return [];
      if (node.hasAttribute("data-answer-upload")) return [];
      if (includeAttachments && node.dataset?.answerAttachment) {
        const { answerAttachment: id, align, width } = node.dataset;
        return [{ tag: "attachment", id, ...(align && align !== "left" ? { align } : {}),
          ...(width && width !== "100" ? { width: Number(width) } : {}) }];
      }
      const original = node.localName;
      if (droppedTags.has(original)) return [];
      const tag = aliases[original] || original;
      if (tag === "br") return [{ tag }];
      let children = Array.from(node.childNodes, child => readNode(child, depth + 1)).flat();
      if (!children.length) return [];
      const style = node.style;
      const color = safeColor(node.getAttribute("color")) || safeColor(style?.color);
      const href = tag === "a" && safeUrl(node.getAttribute("href"));
      if (tag === "a" && !href) return children;
      if (tag !== "b" && /^(?:bold|bolder|[6-9]00)$/.test(style?.fontWeight || "")) children = [{ tag: "b", children }];
      if (tag !== "i" && /^(?:italic|oblique)/.test(style?.fontStyle || "")) children = [{ tag: "i", children }];
      const decoration = style?.textDecorationLine || "";
      if (tag !== "u" && decoration.includes("underline")) children = [{ tag: "u", children }];
      if (tag !== "s" && decoration.includes("line-through")) children = [{ tag: "s", children }];
      if (tag === "span") return color ? [{ tag, color, children }] : children;
      if (color) children = [{ tag: "span", color, children }];
      if (!tags.has(tag)) return children;
      return [href ? { tag, href, children } : { tag, children }];
    }
    try {
      return Array.from(root.childNodes, node => readNode(node, 1)).flat();
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return null;
    }
  }

  function hasFormatting(nodes) {
    return nodes.some(node => typeof node !== "string" &&
      (!plainTags.has(node.tag) || hasFormatting(node.children || [])));
  }

  function fitsDocument(nodes) {
    let size = 0;
    function fits(children, depth) {
      return children.every(node => ++size <= maxNodes && depth <= maxDepth &&
        (typeof node === "string" || fits(node.children || [], depth + 1)));
    }
    return fits(nodes, 1) && new TextEncoder().encode(JSON.stringify(nodes)).length <= 64 * 1024;
  }

  function plainText(root, preformatted = false) {
    let text = "";
    let previousBlock = false;
    let previousEmpty = false;
    let started = false;
    for (const child of root.childNodes) {
      const tag = child.localName;
      if (droppedTags.has(tag) || child.dataset?.answerAttachment || child.hasAttribute?.("data-answer-upload")) continue;
      const block = !preformatted && blockTags.has(tag);
      let value;
      if (child.nodeType === Node.TEXT_NODE) value = child.data;
      else if (child.nodeType !== Node.ELEMENT_NODE) continue;
      else if (tag === "br") value = preformatted || root.childNodes.length > 1 ? "\n" : "";
      else value = plainText(child, preformatted || tag === "pre");
      if (!block && !value) continue;
      if (started && (previousBlock || block) && (previousEmpty || !text.endsWith("\n"))) text += "\n";
      text += value;
      previousBlock = block;
      previousEmpty = !value;
      started = true;
    }
    return text;
  }

  function buildDocument(nodes, { editable = false, attachment } = {}) {
    const result = document.createDocumentFragment();
    for (const node of nodes) {
      if (typeof node === "string") {
        result.append(document.createTextNode(node));
        continue;
      }
      if (node?.tag === "attachment") {
        const card = attachment?.(node);
        if (card) result.append(card);
        continue;
      }
      if (!node || !tags.has(node.tag)) continue;
      const el = document.createElement(node.tag);
      if (node.tag === "a") {
        const href = safeUrl(node.href);
        if (href) {
          el.href = href;
          if (!editable) {
            el.target = "_blank";
            el.rel = "noopener noreferrer";
          }
        }
      }
      if (node.tag === "span") el.style.color = safeColor(node.color);
      if (Array.isArray(node.children)) el.append(buildDocument(node.children, { editable, attachment }));
      result.append(el);
    }
    return result;
  }

  function read(editor) {
    // innerText falls back to textContent before the report or a row is visible.
    const comment = plainText(editor);
    if (comment.length > maxLength) {
      return { comment, commentDocument: null, error: "В комментарии может быть до 10 000 символов." };
    }
    const nodes = domDocument(editor, true);
    if (!nodes || !fitsDocument(nodes)) {
      return { comment, commentDocument: null, error: "Слишком сложное форматирование. Упростите оформление комментария." };
    }
    return { comment, commentDocument: hasFormatting(nodes) ? nodes : null };
  }

  function render(editor, comment, commentDocument, attachment) {
    editor.replaceChildren(Array.isArray(commentDocument) && commentDocument.length
      ? buildDocument(commentDocument, { editable: editor.isContentEditable, attachment })
      : document.createTextNode(comment || ""));
  }

  function selectionRange(editor) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    return range && editor.contains(range.startContainer) && editor.contains(range.endContainer) ? range.cloneRange() : null;
  }

  function insertAttachment(editor, card, position) {
    const range = position && editor.contains(position.startContainer) ? position.cloneRange() : document.createRange();
    if (!editor.contains(range.startContainer)) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const start = range.startContainer;
    const parent = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
    const object = parent?.closest("[data-answer-attachment], [data-answer-upload], a");
    if (object && editor.contains(object)) {
      if (object === card) return range;
      range.setStartAfter(object);
    }
    range.collapse(true);
    range.insertNode(card);
    range.setStartAfter(card);
    range.collapse(true);
    return range;
  }

  function insertFragment(editor, fragment) {
    const holder = document.createElement("div");
    holder.append(fragment);
    // The markup comes exclusively from DOM nodes constructed by buildDocument.
    // The editing command lets the browser add the insert to its native undo history.
    if (document.execCommand("insertHTML", false, holder.innerHTML)) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const last = holder.lastChild;
    const content = document.createDocumentFragment();
    content.append(...holder.childNodes);
    range.insertNode(content);
    if (last) range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function paste(editor, event) {
    if (event.defaultPrevented || !event.clipboardData || event.clipboardData.files.length) return false;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    const html = event.clipboardData.getData("text/html");
    if (html && html.length <= 128 * 1024) {
      // Template contents are inert. Only allowed nodes are copied to the editor.
      const template = document.createElement("template");
      template.innerHTML = html;
      const nodes = domDocument(template.content);
      if (nodes?.length) {
        insertFragment(editor, buildDocument(nodes, { editable: true }));
        return true;
      }
    }
    document.execCommand("insertText", false, text);
    return true;
  }

  function bind(toolbar) {
    let activeEditor;
    let selectFiles;
    let range;
    let editingAnchor;
    const controls = document.createElement("div");
    controls.className = "comment-editor-tools";
    const linkFields = document.createElement("div");
    linkFields.className = "comment-editor-link-fields";
    linkFields.hidden = true;
    const linkUrl = document.createElement("input");
    linkUrl.type = "url";
    linkUrl.placeholder = "https://";
    linkUrl.setAttribute("aria-label", "Адрес ссылки");
    const linkLabel = document.createElement("input");
    linkLabel.type = "text";
    linkLabel.placeholder = "Текст ссылки";
    linkLabel.setAttribute("aria-label", "Текст ссылки");
    toolbar.append(controls, linkFields);

    function rememberSelection() {
      const selection = window.getSelection();
      if (!activeEditor || !selection?.rangeCount) return;
      const selected = selection.getRangeAt(0);
      if (activeEditor.contains(selected.startContainer) && activeEditor.contains(selected.endContainer)) {
        range = selected.cloneRange();
      }
    }

    function restoreSelection() {
      if (!activeEditor) return false;
      const savedRange = range?.cloneRange();
      activeEditor.focus({ preventScroll: true });
      const selection = window.getSelection();
      if (!selection) return false;
      if (!savedRange || !activeEditor.contains(savedRange.startContainer) || !activeEditor.contains(savedRange.endContainer)) {
        range = document.createRange();
        range.selectNodeContents(activeEditor);
        range.collapse(false);
      } else range = savedRange;
      selection.removeAllRanges();
      selection.addRange(range.cloneRange());
      return true;
    }

    function addButton(parent, label, caption, callback, { preserveFocus = true } = {}) {
      const button = document.createElement("button");
      button.className = "comment-editor-tool";
      button.type = "button";
      button.textContent = caption;
      button.title = label;
      button.setAttribute("aria-label", label);
      if (preserveFocus) button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", callback);
      parent.append(button);
      return button;
    }

    function addSelect(label, options, callback) {
      const select = document.createElement("select");
      select.className = "comment-editor-tool";
      select.setAttribute("aria-label", label);
      for (const [value, caption] of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = caption;
        select.append(option);
      }
      select.addEventListener("change", () => callback(select));
      controls.append(select);
    }

    function command(name, value) {
      if (!restoreSelection()) return;
      document.execCommand(name, false, value);
      rememberSelection();
    }

    function closeLinkFields() {
      linkFields.hidden = true;
      editingAnchor = undefined;
      linkUrl.setCustomValidity("");
    }

    function openLinkFields() {
      if (!activeEditor) return;
      rememberSelection();
      const start = range?.startContainer;
      const end = range?.endContainer;
      const parent = node => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const anchor = parent(start)?.closest("a");
      editingAnchor = anchor && activeEditor.contains(anchor) && anchor.contains(end) ? anchor : undefined;
      linkFields.hidden = false;
      linkUrl.value = editingAnchor?.getAttribute("href") || "";
      linkLabel.value = editingAnchor?.textContent || range?.toString() || "";
      linkUrl.setCustomValidity("");
      removeLink.hidden = !editingAnchor;
      linkUrl.focus();
    }

    function saveLink() {
      const href = safeUrl(linkUrl.value.trim());
      if (!href) {
        linkUrl.setCustomValidity("Введите адрес, начинающийся с https:// или http://");
        linkUrl.reportValidity();
        return;
      }
      if (editingAnchor && activeEditor?.contains(editingAnchor)) {
        range = document.createRange();
        range.selectNode(editingAnchor);
      }
      if (restoreSelection()) {
        insertFragment(activeEditor, buildDocument([{ tag: "a", href, children: [linkLabel.value.trim() || href] }], { editable: true }));
        rememberSelection();
      }
      closeLinkFields();
    }

    addSelect("Стиль текста", [["p", "Обычный текст"], ["h2", "Заголовок 2"], ["h3", "Заголовок 3"]], select => {
      command("formatBlock", select.value);
    });
    for (const [name, label, caption] of [
      ["bold", "Жирный", "B"], ["italic", "Курсив", "I"], ["underline", "Подчёркнутый", "U"],
      ["strikeThrough", "Зачёркнутый", "S"], ["insertUnorderedList", "Маркированный список", "• ≡"],
      ["insertOrderedList", "Нумерованный список", "1. ≡"],
    ]) addButton(controls, label, caption, () => command(name));
    addButton(controls, "Добавить или изменить ссылку", "Ссылка", openLinkFields);
    addSelect("Цвет текста", [
      ["", "Цвет текста"], ["#172b4d", "Чёрный"], ["#5e6c84", "Серый"], ["#c1c7d0", "Светло-серый"],
      ["#0052cc", "Синий"], ["#4c9aff", "Голубой"], ["#00875a", "Зелёный"], ["#57d9a3", "Мятный"],
      ["#de350b", "Красный"], ["#ff8b00", "Оранжевый"], ["#ffab00", "Жёлтый"], ["#403294", "Фиолетовый"],
      ["#ffbdad", "Розовый"],
    ], select => {
      if (select.value) command("foreColor", select.value);
      select.value = "";
    });
    addButton(controls, "Вставить блок кода", "Код", () => command("formatBlock", "pre"));
    addButton(controls, "Отменить", "↶", () => command("undo"));
    addButton(controls, "Повторить", "↷", () => command("redo"));
    const attachmentButton = addButton(controls, "Добавить вложение", "Вложение", () => {
      rememberSelection();
      selectFiles?.(range?.cloneRange());
    });
    linkFields.append(linkUrl, linkLabel);
    addButton(linkFields, "Сохранить ссылку", "Сохранить", saveLink, { preserveFocus: false });
    const removeLink = addButton(linkFields, "Удалить ссылку", "Удалить ссылку", () => {
      if (editingAnchor && activeEditor?.contains(editingAnchor)) {
        range = document.createRange();
        range.selectNodeContents(editingAnchor);
        command("unlink");
      }
      closeLinkFields();
    }, { preserveFocus: false });
    addButton(linkFields, "Отменить редактирование ссылки", "Отмена", () => {
      restoreSelection();
      closeLinkFields();
    }, { preserveFocus: false });
    linkUrl.addEventListener("input", () => linkUrl.setCustomValidity(""));
    linkFields.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveLink();
      } else if (event.key === "Escape") {
        event.preventDefault();
        restoreSelection();
        closeLinkFields();
      }
    });
    document.addEventListener("selectionchange", rememberSelection);
    document.addEventListener("keydown", event => {
      if (activeEditor?.contains(event.target) && !event.altKey && !event.shiftKey &&
          (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openLinkFields();
      }
    });
    return (editor, chooseFiles) => {
      if (activeEditor !== editor) {
        range = undefined;
        closeLinkFields();
      }
      activeEditor = editor;
      selectFiles = chooseFiles;
      attachmentButton.hidden = !chooseFiles;
      toolbar.hidden = !editor;
      if (editor) rememberSelection();
    };
  }

  window.QaReportSharedComment = { read, render, bind, paste, selectionRange, insertAttachment };
})();
