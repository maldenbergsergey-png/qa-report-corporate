(function () {
  "use strict";
  const Bugs = window.QaReportBugs;
  const TEXT_EXTENSIONS = /\.(?:txt|log|md|csv|tsv|json|jsonl|har|xml|ya?ml|ini|cfg|conf|properties|sql|js|jsx|ts|tsx|py|rb|php|java|kt|swift|c|cpp|h|cs|go|rs|sh|ps1|bat|css|scss|html|htm|vue|svelte|feature|diff|patch)$/i;
  const MAX_FILE = 20 * 1024 * 1024, MAX_TEXT = 20000;
  let zipLibrary, pdfLibrary;
  function format(asset) {
    if (asset.source?.kind === "image" || /^image\/(?:png|jpeg|webp|gif)$/i.test(asset.type) || /^data:image\/(?:png|jpeg|webp|gif);/i.test(asset.dataUrl) || /\.(?:png|jpe?g|webp|gif)$/i.test(asset.name)) return "image";
    if (asset.type === "application/pdf" || /\.pdf$/i.test(asset.name)) return "pdf";
    if (/^video\//i.test(asset.type) || /\.(?:mp4|m4v|mov|webm|ogv)$/i.test(asset.name)) return "video";
    if (/\.(?:docx|xlsx|pptx|odt|ods|odp|zip)$/i.test(asset.name)) return "document";
    if (/^text\//i.test(asset.type) || /^application\/(?:json|[\w.+-]+\+json|xml|javascript|x-yaml)(?:\s*;|$)/i.test(asset.type) || TEXT_EXTENSIONS.test(asset.name)) return "text";
    return "";
  }
  async function libraries(kind) {
    if (kind === "pdf") {
      pdfLibrary ||= import("/vendor/pdfjs/pdf.min.mjs").then(pdf => { pdf.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs"; return pdf; }); return pdfLibrary;
    }
    zipLibrary ||= import("/vendor/jszip/jszip.min.js").then(() => window.JSZip); return zipLibrary;
  }
  function name(value) { return String(value).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "Вложение"; }
  function text(bytes) {
    if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be").decode(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("windows-1251").decode(bytes); }
  }
  async function bytes(asset, loadSource) {
    let url = asset.dataUrl;
    if (!url) url = await loadSource(asset.source);
    const match = String(url || "").match(/^data:([^;,]+)(?:;[^;,]*)*;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("Нет локальных данных или доступной ссылки на исходное вложение Jira.");
    if (match[2].length > Math.ceil(MAX_FILE / 3) * 4) throw new Error("Для анализа доступно до 20 МБ на файл.");
    const raw = atob(match[2]); if (raw.length > MAX_FILE) throw new Error("Для анализа доступно до 20 МБ на файл.");
    return { data: Uint8Array.from(raw, c => c.charCodeAt(0)), type: match[1], url };
  }
  function canvasImage(canvas, label) {
    let url = canvas.toDataURL("image/jpeg", 0.9);
    if (url.length > Math.ceil(Bugs.IMAGE_LIMITS.fileBytes / 3) * 4) url = canvas.toDataURL("image/jpeg", 0.75);
    return { name: name(label), type: "image/jpeg", dataBase64: url.split(",")[1] };
  }
  async function image(file, label) {
    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type)) throw new Error("Используйте PNG, JPEG, WebP или GIF.");
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("Изображение повреждено или не поддерживается.")); img.src = file.url; });
    const edge = Math.max(img.naturalWidth, img.naturalHeight);
    if (edge <= 2560 && file.data.length <= Bugs.IMAGE_LIMITS.fileBytes && file.type !== "image/gif") return { name: name(label), type: file.type, dataBase64: file.url.split(",")[1] };
    const scale = Math.min(1, 2560 / edge), canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvasImage(canvas, label);
  }
  async function documentText(file, filename) {
    const JSZip = await libraries("zip"), zip = await JSZip.loadAsync(file.data);
    const all = Object.values(zip.files).filter(entry => !entry.dir);
    if (all.length > 500 || all.some(entry => entry._data.uncompressedSize > 2 * 1024 * 1024) || all.reduce((sum, entry) => sum + entry._data.uncompressedSize, 0) > 12 * 1024 * 1024) throw new Error("Документ или архив слишком большой после распаковки.");
    const isZip = /\.zip$/i.test(filename);
    const entries = all.filter(entry => isZip ? TEXT_EXTENSIONS.test(entry.name) : /^(?:word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml|content\.xml)$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!entries.length) throw new Error("В документе нет доступного текста. Зашифрованные и старые двоичные форматы не поддерживаются.");
    const parts = [];
    const shared = zip.file("xl/sharedStrings.xml"), strings = shared ? [...new DOMParser().parseFromString(text(await shared.async("uint8array")), "application/xml").getElementsByTagName("si")].map(node => node.textContent) : [];
    for (const entry of entries.slice(0, 30)) {
      const raw = await entry.async("uint8array"); if (raw.length > 2 * 1024 * 1024) throw new Error("Содержимое документа превышает лимит.");
      const source = text(raw);
      if (isZip) parts.push(`Файл ${entry.name}:\n${source.slice(0, MAX_TEXT)}`);
      else {
        const xml = new DOMParser().parseFromString(source, "application/xml");
        if (xml.getElementsByTagName("parsererror").length) throw new Error("Структура документа повреждена.");
        if (/^xl\/worksheets\//.test(entry.name)) {
          parts.push(`${entry.name}:\n${[...xml.getElementsByTagName("row")].map(row => [...row.getElementsByTagName("c")].map(cell => {
            const value = cell.getElementsByTagName("v")[0]?.textContent || cell.getElementsByTagName("is")[0]?.textContent || "";
            return cell.getAttribute("t") === "s" ? strings[Number(value)] || value : value;
          }).join("\t")).join("\n")}`); continue;
        }
        const nodes = [...xml.getElementsByTagName("*")].filter(node => ["p", "si"].includes(node.localName));
        const selected = nodes.length ? nodes : [xml.documentElement];
        parts.push(`${entry.name}:\n${selected.map(node => node.textContent.trim()).filter(Boolean).join("\n")}`);
      }
    }
    return { content: parts.join("\n\n"), notes: entries.length > 30 ? "Обработаны первые 30 текстовых частей документа или архива." : "Извлечён текст; встроенные изображения документа не анализируются." };
  }
  async function pdf(file, filename, slots) {
    const pdfjs = await libraries("pdf");
    const task = pdfjs.getDocument({ data: file.data, isEvalSupported: false, maxImageSize: 16000000, canvasMaxAreaInBytes: 64 * 1024 * 1024, useSystemFonts: true, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", wasmUrl: "/vendor/pdfjs/wasm/", disableAutoFetch: true });
    try {
      const doc = await task.promise, pages = Math.min(doc.numPages, 20), parts = [], images = [];
      for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n), content = await page.getTextContent(); parts.push(`Страница ${n}: ${content.items.map(item => item.str || "").join(" ")}`);
        if (n <= Math.min(2, slots)) {
          const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: Math.min(2, 2560 / Math.max(base.width, base.height)) });
          const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise; images.push(canvasImage(canvas, `${filename} — страница ${n}`));
        }
        page.cleanup();
      }
      return { content: parts.join("\n"), images, notes: `Текст: ${pages} из ${doc.numPages} страниц. Изображения: первые ${images.length} страницы. Остальные страницы визуально не анализируются.` };
    } finally { await task.destroy(); }
  }
  function waitMedia(media, event, action) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Видео не удалось прочитать за 20 секунд.")), 20000);
      const success = () => done(), fail = () => done(new Error("Браузер не поддерживает формат видео. Используйте MP4 или WebM."));
      function done(error) { clearTimeout(timer); media.removeEventListener(event, success); media.removeEventListener("error", fail); error ? reject(error) : resolve(); }
      media.addEventListener(event, success, { once: true }); media.addEventListener("error", fail, { once: true }); action();
    });
  }
  async function video(file, filename, slots) {
    const url = URL.createObjectURL(new Blob([file.data], { type: file.type })), media = document.createElement("video"); media.muted = true; media.preload = "auto"; media.playsInline = true;
    try {
      await waitMedia(media, "loadeddata", () => { media.src = url; media.load(); });
      if (media.duration === Infinity) {
        await waitMedia(media, "seeked", () => { media.currentTime = 1e10; });
      }
      if (!Number.isFinite(media.duration) || !media.videoWidth || !media.videoHeight) throw new Error("Не удалось определить длительность или размер видео.");
      const count = Math.min(3, slots), times = count === 1 ? [0] : count === 2 ? [0, Math.max(0, media.duration - 0.01)] : [0, media.duration / 2, Math.max(0, media.duration - 0.01)], images = [];
      const scale = Math.min(1, 2560 / Math.max(media.videoWidth, media.videoHeight)), canvas = document.createElement("canvas"); canvas.width = Math.round(media.videoWidth * scale); canvas.height = Math.round(media.videoHeight * scale);
      for (const time of times) {
        if (time !== media.currentTime) await waitMedia(media, "seeked", () => { media.currentTime = time; });
        canvas.getContext("2d").drawImage(media, 0, 0, canvas.width, canvas.height); images.push(canvasImage(canvas, `${filename} — ${time.toFixed(1)} с`));
      }
      return { content: `Видео ${media.duration.toFixed(1)} с, ${media.videoWidth}×${media.videoHeight}. Кадры на отметках ${times.map(time => time.toFixed(1)).join(", ")} с.`, images, notes: `Анализируются ${images.length} кадра; звук и движение между кадрами не анализируются.` };
    } finally { media.removeAttribute("src"); media.load(); URL.revokeObjectURL(url); }
  }
  async function prepare(assets, { loadSource, progress, active = () => true }) {
    if (assets.length > 20) throw new Error("Выберите до 20 вложений для анализа.");
    const images = [], textAttachments = [], summary = [];
    for (const asset of assets) {
      if (!active()) throw new Error("Окно закрыто"); progress?.(`Готовим «${asset.name}» для ИИ…`);
      try {
        const file = await bytes(asset, loadSource), kind = format(asset); let result;
        if (kind === "image") { if (images.length >= Bugs.IMAGE_LIMITS.count) throw new Error("Для анализа доступно до 8 изображений и кадров. Уберите лишние вложения из выбора."); images.push(await image(file, asset.name)); summary.push({ name: asset.name, notes: file.type === "image/gif" ? "Первый кадр GIF." : "Изображение." }); continue; }
        if (kind === "text") result = { content: text(file.data), notes: "Текст файла." };
        else if (kind === "document") result = await documentText(file, asset.name);
        else if (kind === "pdf") result = await pdf(file, asset.name, Bugs.IMAGE_LIMITS.count - images.length);
        else if (kind === "video") { if (images.length >= Bugs.IMAGE_LIMITS.count) throw new Error("Не осталось места для кадров видео. Уберите лишние вложения из выбора."); result = await video(file, asset.name, Bugs.IMAGE_LIMITS.count - images.length); }
        else throw new Error("Формат пока не поддерживается.");
        const truncated = result.content.length > MAX_TEXT, content = result.content.slice(0, MAX_TEXT);
        if (/\x00/.test(content)) throw new Error("Двоичный файл нельзя анализировать как текст.");
        const notes = `${result.notes}${truncated ? " Текст сокращён до 20 000 символов." : ""}`;
        textAttachments.push({ name: name(asset.name), content: `${notes}\n${content}` }); images.push(...(result.images || [])); summary.push({ name: asset.name, notes });
      } catch (error) { throw new Error(`«${asset.name}»: ${error.message} Уберите файл из выбора для анализа или выключите «Анализировать вложения».`); }
    }
    if (!active()) throw new Error("Окно закрыто");
    return { images: Bugs.imageInputs(images), textAttachments: Bugs.textInputs(textAttachments), summary };
  }
  window.QaReportAttachmentAnalysis = { format, prepare };
})();
