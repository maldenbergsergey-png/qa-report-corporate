/* Shared local attachment rendering and import. No server storage is required. */
(function (root) {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function render(file) {
    const { id, name, type, size, dataUrl } = file;
    if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(dataUrl || "")) throw new Error("Некорректные данные вложения");
    const attrs = `data-attachment-id="${escape(id)}" data-file-name="${escape(name)}" data-mime-type="${escape(type)}"`;
    if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${escape(dataUrl)}" alt="${escape(name)}" ${attrs}></figure>`;
    const extension = (String(name).split(".").pop() || "FILE").slice(0,8).toUpperCase();
    const label = size >= 1048576 ? `${(size / 1048576).toFixed(1)} МБ` : `${Math.ceil(size / 1024)} КБ`;
    return `<figure class="cell-file" contenteditable="false" tabindex="0" ${attrs} data-file-size="${Number(size) || 0}" data-file-extension="${escape(extension)}" data-data-url="${escape(dataUrl)}"><span class="file-type-badge">${escape(extension)}</span><span class="file-card-body"><strong class="file-card-name" title="${escape(name)}">${escape(name)}</strong><span class="file-card-meta">${label}</span></span></figure>`;
  }
  function dataUrl(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  }
  async function localize(documentValue, { attachments = [], load, include = true, onProgress = () => {} }) {
    const copy = JSON.parse(JSON.stringify(documentValue));
    const cache = new Map(); const failures = new Map(); let loaded = 0; let totalBytes = 0; let completed = 0;
    const plan = html => {
      const template = document.createElement("template"); template.innerHTML = html || "";
      const nodes = template.content.querySelectorAll("img, .jira-image-placeholder, .jira-file-placeholder, a[href]");
      const items = [];
      for (const node of nodes) {
        const name = node.dataset.jiraName || node.dataset.fileName || node.getAttribute("alt") || "Вложение";
        const id = node.dataset.jiraId || node.dataset.attachmentId;
        const href = node.getAttribute(node.tagName === "A" ? "href" : "src");
        const byId = id && attachments.find(file => String(file.id) === id);
        const byUrl = href && attachments.find(file => file.content === href || file.thumbnail === href);
        const byName = attachments.filter(file => file.filename === name);
        const attachment = byId || byUrl || (byName.length === 1 ? byName[0] : null);
        if (node.tagName === "A" && !attachment) continue;
        const target = node.closest(".cell-image, .cell-file") || node;
        const displayName = attachment?.filename || name;
        items.push({ target, attachment, displayName, key: attachment?.id || displayName, ambiguous: byName.length > 1 });
      }
      return { template, items };
    };
    const fragments = [{ owner: copy, field: "intro" }];
    for (const section of copy.sections || []) for (const row of section.rows || []) {
      for (const field of Object.keys(row.cells || {})) fragments.push({ owner: row.cells, field });
    }
    const plans = fragments.map(({ owner, field }) => ({ owner, field, ...plan(owner[field]) }));
    const total = new Set(plans.flatMap(part => part.items.map(item => item.key))).size;
    const notify = () => onProgress({ completed, total, loaded, failed: failures.size });
    if (include && total) notify();
    for (const { owner, field, template, items } of plans) {
      for (const { target, attachment, displayName, key, ambiguous } of items) {
        if (!include) { target.replaceWith(document.createTextNode(`[${displayName}: без вложения]`)); continue; }
        let file = cache.get(key);
        if (!file && !failures.has(key)) {
          try {
            if (!attachment) throw new Error(ambiguous ? "несколько файлов с таким именем" : "файл не найден среди вложений задачи");
            if (cache.size >= 100) throw new Error("не более 100 вложений за импорт");
            const blob = await load(attachment);
            if (blob.size > 50 * 1048576 || totalBytes + blob.size > 100 * 1048576) throw new Error("превышен лимит: 50 МБ на файл, 100 МБ на импорт");
            file = { id: crypto.randomUUID(), name: displayName, type: blob.type || "application/octet-stream", size: blob.size, dataUrl: await dataUrl(blob) };
            cache.set(key, file); totalBytes += blob.size; loaded++;
          } catch (error) { failures.set(key, `${displayName}: ${error.message}`); }
          completed++; notify();
        }
        if (file) {
          const replacement = document.createElement("template"); replacement.innerHTML = render(file);
          target.replaceWith(replacement.content);
        } else {
          const placeholder = document.createElement("span"); placeholder.className = "attachment-import-error";
          placeholder.textContent = `[${displayName}: не удалось загрузить]`; placeholder.title = failures.get(key);
          target.replaceWith(placeholder);
        }
      }
      owner[field] = template.innerHTML;
    }
    return { document: copy, loaded, errors: [...failures.values()] };
  }
  root.QaReportAttachments = { render, dataUrl, localize };
})(typeof window === "undefined" ? globalThis : window);
