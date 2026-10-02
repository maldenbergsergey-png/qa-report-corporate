/* Local text attachments only: decode bytes without parsing or executing markup. */
(function (root) {
  "use strict";
  const MAX_BYTES = 2 * 1024 * 1024;
  const TEXT_EXTENSION = /\.(?:xml|xsd|xsl|xslt|wsdl|dtd|plist|json|jsonl|ndjson|ya?ml|txt|text|log|csv|tsv|md|markdown|html?|css|[cm]?js|jsx|tsx?|sql|graphql|gql|ini|conf|cfg|properties|env|toml|sh|bash|zsh|ps1|bat|cmd|py|rb|java|c|h|cpp|hpp|cs|go|rs|swift|kts?)$/i;
  function isText(name = "", type = "") {
    const mime = String(type).split(";")[0].trim().toLowerCase();
    return TEXT_EXTENSION.test(name) || /^(?:dockerfile|makefile|\.env)$/i.test(name) ||
      mime.startsWith("text/") || /^application\/(?:xml|json|javascript|x-javascript|yaml|x-yaml|x-ndjson|sql|graphql)$/.test(mime) ||
      /^application\/[a-z0-9.+-]+\+(?:xml|json)$/.test(mime);
  }
  function readBytes(dataUrl) {
    if (!/^data:/i.test(dataUrl || "")) {
      throw new Error("Просмотр доступен для файлов, сохранённых в браузере. Скачайте файл, чтобы открыть его на устройстве.");
    }
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(5, comma);
    if (comma < 0 || !/;base64$/i.test(header)) throw new Error("Не удалось прочитать данные файла. Попробуйте скачать его.");
    const payloadLength = dataUrl.length - comma - 1;
    if (payloadLength > Math.ceil(MAX_BYTES / 3) * 4) throw new Error("Для просмотра доступны файлы до 2 МБ. Скачайте файл, чтобы открыть его целиком.");
    const payload = dataUrl.slice(comma + 1);
    if (!/^[a-z0-9+/]*={0,2}$/i.test(payload)) throw new Error("Данные файла повреждены. Попробуйте скачать его.");
    let binary;
    try { binary = atob(payload); }
    catch { throw new Error("Данные файла повреждены. Попробуйте скачать его."); }
    if (binary.length > MAX_BYTES) throw new Error("Для просмотра доступны файлы до 2 МБ. Скачайте файл, чтобы открыть его целиком.");
    return { bytes: Uint8Array.from(binary, character => character.charCodeAt(0)), header };
  }
  function detectEncoding(bytes, header) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
    if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) return "utf-16le";
    if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) return "utf-16be";
    const prefix = new TextDecoder("windows-1252").decode(bytes.subarray(0, 1024));
    const xmlEncoding = prefix.match(/^\s*<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
    const charset = header.match(/;charset=([^;]+)/i)?.[1];
    if (xmlEncoding || charset) return (xmlEncoding || charset).trim();
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return "utf-8"; }
    catch { return "windows-1251"; }
  }
  function decode(file, encoding = "auto") {
    if (!isText(file.name, file.type)) throw new Error("Просмотр этого формата пока недоступен. Скачайте файл, чтобы открыть его на устройстве.");
    const { bytes, header } = readBytes(file.dataUrl);
    let decoder, text;
    try {
      decoder = new TextDecoder(encoding === "auto" ? detectEncoding(bytes, header) : encoding, { fatal: true });
      text = decoder.decode(bytes);
    } catch { throw new Error("Не удалось прочитать текст в этой кодировке. Выберите другую кодировку или скачайте файл."); }
    const controls = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || [];
    if (text.includes("\u0000") || controls.length > Math.max(1, text.length * 0.01)) {
      throw new Error("В файле обнаружены двоичные данные. Скачайте его, чтобы открыть на устройстве.");
    }
    return { text, encoding: decoder.encoding, size: bytes.length };
  }
  const api = { decode, isText, MAX_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QaReportFilePreview = api;
})(typeof window === "undefined" ? globalThis : window);
