/* Shared attachment inspection, local copies and Jira references. */
(function (root) {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function sourceAttrs(source = {}) {
    return source.issueUrl ? ` data-jira-source-issue="${escape(source.issueUrl)}" data-jira-id="${escape(source.id)}" data-jira-name="${escape(source.name)}" data-jira-url="${escape(source.url)}" data-jira-source-hash="${escape(source.hash || "")}" data-jira-kind="${escape(source.kind || "file")}"` : "";
  }
  function render(file) {
    const { id, name, type, size, dataUrl } = file;
    if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(dataUrl || "")) throw new Error("Некорректные данные вложения");
    const attrs = `data-attachment-id="${escape(id)}" data-file-name="${escape(name)}" data-mime-type="${escape(type)}"${sourceAttrs(file.source)}`;
    if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${escape(dataUrl)}" alt="${escape(name)}" ${attrs}></figure>`;
    const extension = (String(name).split(".").pop() || "FILE").slice(0,8).toUpperCase();
    const label = size >= 1048576 ? `${(size / 1048576).toFixed(1)} МБ` : `${Math.ceil(size / 1024)} КБ`;
    return `<figure class="cell-file" contenteditable="false" tabindex="0" ${attrs} data-file-size="${Number(size) || 0}" data-file-extension="${escape(extension)}" data-data-url="${escape(dataUrl)}"><span class="file-type-badge">${escape(extension)}</span><span class="file-card-body"><strong class="file-card-name" title="${escape(name)}">${escape(name)}</strong><span class="file-card-meta">${label}</span></span></figure>`;
  }
  function reference(file) {
    return `<figure class="cell-file jira-attachment-reference" contenteditable="false" tabindex="0" data-attachment-id="${escape(file.id)}" data-file-name="${escape(file.name)}" data-mime-type="${escape(file.type || "application/octet-stream")}"${sourceAttrs(file.source)}><span class="file-type-badge">JIRA</span><span class="file-card-body"><strong class="file-card-name">${escape(file.name)}</strong><span class="file-card-meta">В Jira · не скачан в браузер</span></span></figure>`;
  }
  function dataUrl(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  }
  async function hashBlob(blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
  }
  function fragments(value) {
    const result = [{ owner: value, field: "intro", location: "intro", sectionId: "intro", sectionTitle: "Описание", title: "Вложения в описании" }];
    for (const section of value.sections || []) for (const row of section.rows || []) {
      for (const column of section.columns || []) result.push({ owner: row.cells, field: column.id, location: JSON.stringify([section.id,column.id]), sectionId: section.id, sectionTitle: section.title, title: column.title });
    }
    return result;
  }
  function planHtml(html, attachments) {
    const template = document.createElement("template"); template.innerHTML = html || "";
    const items = [];
    for (const node of template.content.querySelectorAll("img, .jira-image-placeholder, .jira-file-placeholder, a[href]")) {
      const name = node.dataset.jiraName || node.dataset.fileName || node.getAttribute("alt") || "Вложение";
      const id = node.dataset.jiraId || node.dataset.attachmentId;
      const href = node.getAttribute(node.tagName === "A" ? "href" : "src");
      const byId = id && attachments.find(file => String(file.id) === id);
      const byUrl = href && attachments.find(file => file.content === href || file.thumbnail === href);
      const byName = attachments.filter(file => file.filename === name);
      const attachment = byId || byUrl || (byName.length === 1 ? byName[0] : null);
      if (node.tagName === "A" && !attachment) continue;
      items.push({ target: node.closest(".cell-image, .cell-file") || node, attachment,
        name: attachment?.filename || name, key: attachment ? `jira:${attachment.id}` : `missing:${name}`,
        ambiguous: byName.length > 1, kind: node.tagName === "IMG" || node.classList.contains("jira-image-placeholder") ? "image" : "file" });
    }
    return { template, items };
  }
  function inspect(value, attachments = []) {
    const groups = new Map(); const all = new Set();
    for (const fragment of fragments(value)) {
      const items = planHtml(fragment.owner?.[fragment.field], attachments).items;
      if (fragment.location === "intro" && !items.length) continue;
      if (!groups.has(fragment.sectionId)) groups.set(fragment.sectionId, { id: fragment.sectionId, title: fragment.sectionTitle, columns: new Map() });
      const columns = groups.get(fragment.sectionId).columns;
      if (!columns.has(fragment.location)) columns.set(fragment.location,{ id: fragment.location, title: fragment.title, keys: new Set(), missing: new Set(), files: new Map() });
      const column = columns.get(fragment.location);
      for (const item of items) { column.keys.add(item.key); column.files.set(item.key,{name:item.name,kind:item.kind}); all.add(item.key); if (!item.attachment) column.missing.add(item.key); }
    }
    return { total: all.size, groups: [...groups.values()].map(group => ({...group, columns:[...group.columns.values()].map(column => ({...column, keys:[...column.keys], files:[...column.files.values()], missing:column.missing.size}))})) };
  }
  async function localize(documentValue, { attachments = [], load, include = true, locations = null, sourceIssueUrl = "", onProgress = () => {} }) {
    const copy = JSON.parse(JSON.stringify(documentValue));
    const cache = new Map(), failures = new Map(), ids = new Map(); let loaded = 0, totalBytes = 0, completed = 0;
    const plans = fragments(copy).map(fragment => ({...fragment, ...planHtml(fragment.owner?.[fragment.field], attachments)}));
    const chosen = part => include && (!locations || locations.has(part.location));
    const total = new Set(plans.filter(chosen).flatMap(part => part.items.map(item => item.key))).size;
    const notify = () => onProgress({ completed, total, loaded, failed: failures.size });
    if (total) notify();
    for (const part of plans) {
      for (const { target, attachment, name, key, ambiguous, kind } of part.items) {
        if (!ids.has(key)) ids.set(key, crypto.randomUUID());
        const source = sourceIssueUrl && attachment ? { issueUrl: sourceIssueUrl, id: String(attachment.id), name, url: root.QaReportJiraReuse?.sourceUrl(attachment.content, sourceIssueUrl) || "", kind } : undefined;
        if (!chosen(part)) {
          if (source) {
            const replacement = document.createElement("template"); replacement.innerHTML = reference({id:ids.get(key),name,type:attachment.mimeType,source}); target.replaceWith(replacement.content);
          } else target.replaceWith(document.createTextNode(`[${name}: без вложения]`));
          continue;
        }
        let file = cache.get(key);
        if (!file && !failures.has(key)) {
          try {
            if (!attachment) throw new Error(ambiguous ? "несколько файлов с таким именем" : "файл не найден среди вложений задачи");
            if (cache.size >= 100) throw new Error("не более 100 вложений за импорт");
            const blob = await load(attachment);
            if (blob.size > 50 * 1048576 || totalBytes + blob.size > 100 * 1048576) throw new Error("превышен лимит: 50 МБ на файл, 100 МБ на импорт");
            file = { id: ids.get(key), name, type: blob.type || "application/octet-stream", size: blob.size, dataUrl: await dataUrl(blob), source: source ? {...source, hash:await hashBlob(blob)} : undefined };
            cache.set(key,file); totalBytes += blob.size; loaded++;
          } catch (error) { failures.set(key,`${name}: ${error.message}`); }
          completed++; notify();
        }
        const replacement = document.createElement("template");
        if (file) replacement.innerHTML = render({...file, source:file.source ? {...file.source,kind} : undefined});
        else if (source) replacement.innerHTML = reference({id:ids.get(key),name,type:attachment.mimeType,source});
        else { const placeholder = document.createElement("span"); placeholder.className = "attachment-import-error"; placeholder.textContent = `[${name}: не удалось загрузить]`; replacement.content.append(placeholder); }
        target.replaceWith(replacement.content);
      }
      if (part.owner) part.owner[part.field] = part.template.innerHTML;
    }
    return { document:copy, loaded, errors:[...failures.values()] };
  }
  root.QaReportAttachments = { render, reference, dataUrl, hashBlob, inspect, localize };
})(typeof window === "undefined" ? globalThis : window);
