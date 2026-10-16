/* Portable .report v1: a bounded, uncompressed ZIP with verified binary assets. */
(function (root) {
  "use strict";
  const MAX_BYTES = 250 * 1024 * 1024;
  const MAX_FILES = 1000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fail = message => { throw new Error(message); };
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function hash(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
  }
  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    for (const [name, bytes] of files) {
      const filename = encoder.encode(name), crc = crc32(bytes);
      const local = new Uint8Array(30), l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
      l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true);
      l.setUint16(26, filename.length, true);
      const header = new Uint8Array(46), c = new DataView(header.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
      c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
      chunks.push(local, filename, bytes); central.push(header, filename);
      offset += local.length + filename.length + bytes.length;
    }
    const size = central.reduce((sum, item) => sum + item.length, 0);
    if (offset + size + 22 > MAX_BYTES || files.size > MAX_FILES + 2) fail("Полная копия превышает лимит 250 МиБ или 1000 вложений.");
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.size, true); e.setUint16(10, files.size, true);
    e.setUint32(12, size, true); e.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: "application/zip" });
  }
  function unzip(bytes) {
    const bad = () => fail("Файл .report повреждён или имеет неподдерживаемый формат.");
    if (bytes.length < 22 || bytes.length > MAX_BYTES) bad();
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
    if (v.getUint32(end, true) !== 0x06054b50 || v.getUint16(end + 4, true) || v.getUint16(end + 6, true) || v.getUint16(end + 20, true)) bad();
    const count = v.getUint16(end + 10, true), start = v.getUint32(end + 16, true);
    if (count < 2 || count > MAX_FILES + 2 || count !== v.getUint16(end + 8, true) || start + v.getUint32(end + 12, true) !== end) bad();
    const files = new Map(); let cursor = start, nextLocal = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || v.getUint32(cursor, true) !== 0x02014b50) bad();
      const size = v.getUint32(cursor + 24, true), nameLength = v.getUint16(cursor + 28, true), local = v.getUint32(cursor + 42, true);
      if (v.getUint16(cursor + 8, true) || v.getUint16(cursor + 10, true) || v.getUint16(cursor + 30, true) || v.getUint16(cursor + 32, true) || v.getUint16(cursor + 34, true) || v.getUint32(cursor + 20, true) !== size) bad();
      if (cursor + 46 + nameLength > end || local !== nextLocal || local + 30 + nameLength + size > start) bad();
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (!/^(?:manifest\.json|report\.json|attachments\/[a-f0-9]{64})$/.test(name) || files.has(name)) bad();
      if (v.getUint32(local, true) !== 0x04034b50 || v.getUint16(local + 6, true) || v.getUint16(local + 8, true) || v.getUint16(local + 28, true) || v.getUint16(local + 26, true) !== nameLength || v.getUint32(local + 18, true) !== size || v.getUint32(local + 22, true) !== size) bad();
      if (decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== name) bad();
      const data = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
      const crc = crc32(data);
      if (crc !== v.getUint32(cursor + 16, true) || crc !== v.getUint32(local + 14, true)) bad();
      files.set(name, data); nextLocal = local + 30 + nameLength + size; cursor += 46 + nameLength;
    }
    if (cursor !== end || nextLocal !== start || !files.has("manifest.json") || !files.has("report.json")) bad();
    return files;
  }
  const statuses = new Set(["OK", "НЕ ОК", "ПОЧТИ ОК", "НЕ ПРОВЕРЕНО", "ЗАБЛОКИРОВАНО", "ЧАСТИЧНО ПРОВЕРЕНО", "ТРЕБУЕТ УТОЧНЕНИЯ"]);
  function documentFields(value) {
    const bad = () => fail("Некорректная структура отчёта в файле.");
    const string = val => typeof val === "string" ? val : bad();
    const id = val => typeof val === "string" && /^[\w-]{1,100}$/.test(val) && !["__proto__", "constructor", "prototype"].includes(val) ? val : bad();
    const unique = list => { if (new Set(list).size !== list.length) bad(); };
    if (!value || value.schemaVersion !== 3 || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > 1000) bad();
    if ((value.overallStatus !== "" && !statuses.has(value.overallStatus)) || !["section", "continuous", "hierarchical", "manual"].includes(value.numberingMode)) bad();
    if (value.sectionNumberingMode !== undefined && !["automatic", "manual"].includes(value.sectionNumberingMode)) bad();
    let rows = 0;
    const result = { schemaVersion: 3, issueUrl: string(value.issueUrl), environment: string(value.environment), overallStatus: value.overallStatus,
      intro: string(value.intro), numberingMode: value.numberingMode,
      ...(value.sectionNumberingMode !== undefined ? { sectionNumberingMode: value.sectionNumberingMode } : {}), sections: value.sections.map(section => {
        if (!section || !Array.isArray(section.columns) || !section.columns.length || section.columns.length > 100 || !Array.isArray(section.rows) || !section.rows.length || (rows += section.rows.length) > 20000) bad();
        const columns = section.columns.map(column => {
          if (!column) bad();
          const copy = { id: id(column.id), title: string(column.title) };
          for (const key of ["name", "type"]) if (typeof column[key] === "string") copy[key] = column[key];
          if (typeof column.required === "boolean") copy.required = column.required;
          if (Number.isFinite(column.width)) copy.width = Math.max(140, Math.min(1000, column.width));
          return copy;
        });
        unique(columns.map(c => c.id));
        return { id: id(section.id), title: string(section.title),
          ...(section.manualNumber !== undefined ? { manualNumber: string(section.manualNumber) } : {}), collapsed: Boolean(section.collapsed), statusSort: Boolean(section.statusSort), columns,
          rows: section.rows.map(row => {
            if (!row || !row.cells || typeof row.cells !== "object" || !statuses.has(row.status)) bad();
            const cells = Object.fromEntries(columns.map(c => [c.id, string(row.cells[c.id])]));
            const bugs = (Array.isArray(row.bugs) ? row.bugs : []).slice(0, 100).map(bug => {
              const url = new URL(string(bug.issueUrl));
              if (!/^https?:$/.test(url.protocol) || url.username || url.password || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(bug.key || "")) bad();
              return { key: string(bug.key), issueUrl: url.href, createdAt: string(bug.createdAt || "") };
            });
            return { id: id(row.id), status: row.status, cells, ...(bugs.length ? { bugs } : {}), ...(row.manualNumber !== undefined ? { manualNumber: string(row.manualNumber) } : {}) };
          }) };
      }) };
    unique(result.sections.map(s => s.id)); unique(result.sections.flatMap(s => s.rows.map(r => r.id)));
    // Deliberately omit identity, cloud ownership, credentials and browser settings.
    return result;
  }
  function fragments(value) {
    return [{ owner: value, key: "intro" }, ...value.sections.flatMap(s => s.rows.flatMap(r => Object.keys(r.cells).map(key => ({ owner: r.cells, key }))))];
  }
  const selector = "img, .cell-file, .jira-image-placeholder, .jira-file-placeholder";
  function attachmentNodes(template) {
    return [...template.content.querySelectorAll(selector)].filter(node => !node.parentElement?.closest(".cell-file"));
  }
  function info(node, issueUrl) {
    const image = node.tagName === "IMG" || node.classList.contains("jira-image-placeholder") || node.dataset.jiraKind === "image";
    return { name: node.dataset.fileName || node.dataset.jiraName || node.getAttribute("alt") || (image ? "image.png" : "file"),
      url: node.tagName === "IMG" ? node.getAttribute("src") || "" : node.dataset.dataUrl || "",
      type: node.dataset.mimeType || (image ? "image/png" : "application/octet-stream"), image,
      issueUrl: node.dataset.jiraSourceIssue || issueUrl, jiraId: node.dataset.jiraId || "", jiraName: node.dataset.jiraName || "" };
  }
  function decodeDataUrl(url) {
    const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(url);
    if (!match) fail("Некорректные данные вложения.");
    const raw = atob(match[2]);
    return { bytes: Uint8Array.from(raw, c => c.charCodeAt(0)), type: match[1].toLowerCase() };
  }
  function dataUrl(bytes, type) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    return `data:${type};base64,${btoa(chunks.join(""))}`;
  }
  function sanitize(html) {
    const template = document.createElement("template"); template.innerHTML = html;
    const tags = new Set("A B BR CODE DIV EM FIGURE H1 H2 H3 I IMG LI OL P PRE S SPAN STRONG SUB SUP U UL".split(" "));
    const attributes = new Set("alt class contenteditable data-align data-attachment-id data-file-extension data-file-name data-file-size data-jira-id data-jira-name data-jira-thumbnail data-jira-options data-jira-url data-jira-source-issue data-jira-source-hash data-jira-kind data-jira-exact-url data-language data-mime-type data-qa-code-snippet data-data-url href rel src style target title".split(" "));
    for (const node of template.content.querySelectorAll("*")) {
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE"].includes(node.tagName)) { node.remove(); continue; }
      if (!tags.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
      for (const attr of [...node.attributes]) if (!attributes.has(attr.name)) node.removeAttribute(attr.name);
      for (const attr of ["href", "data-jira-url", "data-jira-source-issue"]) if (node.hasAttribute(attr)) {
        try { const url = new URL(node.getAttribute(attr)); if (!["http:", "https:", ...(attr === "href" ? ["mailto:"] : [])].includes(url.protocol) || url.username || url.password) throw Error(); }
        catch { node.removeAttribute(attr); }
      }
      if (node.tagName === "A") { node.setAttribute("rel", "noopener noreferrer"); node.setAttribute("target", "_blank"); }
      if (node.hasAttribute("style")) {
        const style = node.style, values = {};
        for (const prop of ["color", "background-color", "width", "text-align", "font-weight", "font-style", "text-decoration", "white-space"]) {
          const value = style.getPropertyValue(prop);
          if (value && !/url|expression|var\(|[<>\\]/i.test(value)) values[prop] = value;
        }
        node.removeAttribute("style");
        for (const [prop, value] of Object.entries(values)) node.style.setProperty(prop, value);
      }
      // A portable file must not initiate external image/file requests on open.
      if (node.hasAttribute("src") && (node.tagName !== "IMG" || !/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(node.getAttribute("src")))) fail("Изображение не включено в полную копию или имеет неподдерживаемый формат.");
      if (node.hasAttribute("data-data-url") && !/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(node.dataset.dataUrl)) fail("Файл не включён в полную копию.");
    }
    return template.innerHTML;
  }
  async function pack(value, { load, onProgress = () => {} } = {}) {
    const report = documentFields(value), assets = new Map(), cache = new Map(), failures = [];
    let bytesTotal = 0, completed = 0;
    const parts = fragments(report).map(part => {
      const template = document.createElement("template"); template.innerHTML = part.owner[part.key];
      // Embedded media is not produced by the editor; do not silently omit it.
      if (template.content.querySelector("video, audio, source, object, embed, iframe")) fail("В отчёте есть неподдерживаемое встроенное медиа. Добавьте его как файл перед сохранением.");
      return { ...part, template, nodes: attachmentNodes(template) };
    });
    const total = parts.reduce((sum, p) => sum + p.nodes.length, 0);
    onProgress({ completed, total });
    for (const part of parts) {
      for (const node of part.nodes) {
        const item = info(node, report.issueUrl), cacheKey = item.url || JSON.stringify([item.issueUrl, item.jiraId, item.jiraName, item.name]);
        try {
          let asset = cache.get(cacheKey);
          if (!asset) {
            const loaded = item.url.startsWith("data:") ? decodeDataUrl(item.url) : await load(item);
            const bytes = loaded.bytes instanceof Uint8Array ? loaded.bytes : new Uint8Array(await loaded.arrayBuffer());
            const type = (loaded.type || item.type).split(";")[0].toLowerCase();
            if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) fail("Неизвестный тип файла.");
            const digest = await hash(bytes);
            if (!assets.has(digest)) {
              bytesTotal += bytes.length;
              if (bytesTotal > MAX_BYTES || assets.size >= MAX_FILES) fail("Превышен лимит 250 МиБ или 1000 вложений.");
              assets.set(digest, bytes);
            }
            asset = { digest, type, size: bytes.length }; cache.set(cacheKey, asset);
          }
          if (item.image && !/^image\/(png|jpeg|gif|webp)$/.test(asset.type)) fail("Неподдерживаемый формат изображения.");
          let target = node;
          if (node.tagName !== "IMG" && !node.classList.contains("cell-file")) {
            const replacement = document.createElement("template");
            replacement.innerHTML = root.QaReportAttachments.render({ id: crypto.randomUUID(), name: item.name, type: item.image ? asset.type : "application/octet-stream", size: asset.size, dataUrl: `data:${asset.type};base64,` });
            target = replacement.content.querySelector("img, .cell-file"); node.replaceWith(replacement.content);
          } else if (node.classList.contains("jira-attachment-reference")) {
            const replacement = document.createElement("template");
            replacement.innerHTML = root.QaReportAttachments.render({ id: node.dataset.attachmentId || crypto.randomUUID(), name: item.name, type: item.image ? asset.type : "application/octet-stream", size: asset.size, dataUrl: `data:${asset.type};base64,` });
            target = replacement.content.querySelector("img, .cell-file");
            for (const attr of [...node.attributes]) if (attr.name.startsWith("data-jira-")) target.setAttribute(attr.name, attr.value);
            node.replaceWith(replacement.content);
          }
          target.setAttribute(target.tagName === "IMG" ? "src" : "data-data-url", `report-asset:${asset.digest}`);
          target.dataset.mimeType = asset.type; target.dataset.fileName = item.name;
          target.dataset.fileSize = String(asset.size); target.dataset.attachmentId ||= crypto.randomUUID();
          target.removeAttribute("data-storage-key");
        } catch (error) { failures.push(`${item.name}: ${error.message}`); }
        onProgress({ completed: ++completed, total });
      }
      part.owner[part.key] = part.template.innerHTML;
    }
    if (failures.length) fail(`Полная копия не создана. Не удалось включить вложения:\n${[...new Set(failures)].join("\n")}`);
    const documentBytes = encoder.encode(JSON.stringify(report));
    const manifest = { format: "qa-report", version: 1, createdAt: new Date().toISOString(), documentHash: await hash(documentBytes), attachments: [...assets].map(([digest, bytes]) => ({ hash: digest, size: bytes.length })) };
    const files = new Map([["manifest.json", encoder.encode(JSON.stringify(manifest))], ["report.json", documentBytes]]);
    for (const [digest, bytes] of assets) files.set(`attachments/${digest}`, bytes);
    return { blob: zip(files), count: assets.size };
  }
  async function unpack(file, { onProgress = () => {} } = {}) {
    if (file.size > MAX_BYTES) fail("Файл превышает лимит 250 МиБ.");
    const files = unzip(new Uint8Array(await file.arrayBuffer()));
    let manifest, value;
    try { manifest = JSON.parse(decoder.decode(files.get("manifest.json"))); value = JSON.parse(decoder.decode(files.get("report.json"))); }
    catch { fail("Не удалось прочитать описание отчёта."); }
    if (manifest?.format !== "qa-report" || manifest.version !== 1) fail("Версия файла .report не поддерживается. Обновите QA Report.");
    if (!Array.isArray(manifest.attachments) || manifest.attachments.length > MAX_FILES || files.size !== manifest.attachments.length + 2) fail("Неполный список вложений.");
    if (await hash(files.get("report.json")) !== manifest.documentHash) fail("Документ отчёта повреждён.");
    const hashes = new Set(); let completed = 0;
    for (const asset of manifest.attachments) {
      const bytes = files.get(`attachments/${asset?.hash}`);
      if (!bytes || hashes.has(asset.hash) || bytes.length !== asset.size || await hash(bytes) !== asset.hash) fail("Вложение отсутствует или повреждено.");
      hashes.add(asset.hash); onProgress({ completed: ++completed, total: manifest.attachments.length });
    }
    const report = documentFields(value), urls = new Map(), used = new Set();
    for (const part of fragments(report)) {
      const template = document.createElement("template"); template.innerHTML = part.owner[part.key];
      for (const node of attachmentNodes(template)) {
        const attr = node.tagName === "IMG" ? "src" : "data-data-url";
        const match = /^report-asset:([a-f0-9]{64})$/.exec(node.getAttribute(attr) || "");
        const type = node.dataset.mimeType || "";
        if (!match || !hashes.has(match[1]) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)) fail("В отчёте есть вложение без локальной копии.");
        const key = `${match[1]}:${type}`;
        if (!urls.has(key)) urls.set(key, dataUrl(files.get(`attachments/${match[1]}`), type));
        node.setAttribute(attr, urls.get(key)); used.add(match[1]);
      }
      part.owner[part.key] = sanitize(template.innerHTML);
    }
    if (used.size !== hashes.size) fail("Список вложений не соответствует отчёту.");
    return { document: report, count: hashes.size };
  }
  const api = { pack, unpack, zip, unzip, hash, documentFields, MAX_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QaReportFile = api;
})(typeof window === "undefined" ? globalThis : window);
