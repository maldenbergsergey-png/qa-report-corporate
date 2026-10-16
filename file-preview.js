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
  function readableText(text, { preserveAscii = false } = {}) {
    // Consume other escapes too, so literal \\uXXXX stays literal. Do not parse
    // and serialize JSON: that would change whitespace, duplicate keys and numbers.
    return text.replace(/\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\[\s\S]/g,
      (escape, high, low, hex) => {
        if (high) return String.fromCharCode(parseInt(high, 16), parseInt(low, 16));
        if (!hex) return escape;
        const code = parseInt(hex, 16);
        // Keep JSON delimiters, controls and unpaired surrogates escaped.
        if ((preserveAscii && (code < 0xa0 || code === 0x2028 || code === 0x2029)) || code < 0x20 || code === 0x22 || code === 0x5c || (code >= 0x7f && code <= 0x9f) ||
          (code >= 0xd800 && code <= 0xdfff)) return escape;
        return String.fromCharCode(code);
      });
  }
  function formatJson(text) {
    if (!/^\s*[\[{]/.test(text)) return text;
    try { JSON.parse(text); } catch { return text; }
    // Validate only; format the original tokens to preserve exact numbers,
    // duplicate keys, key order and every escape inside strings.
    const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|[^\s{}\[\],:]+/g);
    const parts = [];
    let depth = 0, length = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      let part = token;
      if (token === "{" || token === "[") {
        if (++depth > 64) return text;
        const closing = token === "{" ? "}" : "]";
        if (tokens[index + 1] !== closing) part += "\n" + "  ".repeat(depth);
      } else if (token === "}" || token === "]") {
        depth--;
        const opening = token === "}" ? "{" : "[";
        if (tokens[index - 1] !== opening) part = "\n" + "  ".repeat(depth) + token;
      } else if (token === ",") {
        part += "\n" + "  ".repeat(depth);
      } else if (token === ":") {
        part += " ";
      }
      length += part.length;
      // Keep unusually deep or expanding input from exhausting the viewer.
      if (length > MAX_BYTES * 4) return text;
      parts.push(part);
    }
    return parts.join("");
  }
  // Reverse only lossless UTF-8 -> Windows-1251 misdecoding. Keep a fixed table
  // so browser and Node imports behave alike without an optional ICU encoding.
  const cp1251Extra = [
    0x402, 0x403, 0x201a, 0x453, 0x201e, 0x2026, 0x2020, 0x2021,
    0x20ac, 0x2030, 0x409, 0x2039, 0x40a, 0x40c, 0x40b, 0x40f,
    0x452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x98, 0x2122, 0x459, 0x203a, 0x45a, 0x45c, 0x45b, 0x45f,
    0xa0, 0x40e, 0x45e, 0x408, 0xa4, 0x490, 0xa6, 0xa7,
    0x401, 0xa9, 0x404, 0xab, 0xac, 0xad, 0xae, 0x407,
    0xb0, 0xb1, 0x406, 0x456, 0x491, 0xb5, 0xb6, 0xb7,
    0x451, 0x2116, 0x454, 0xbb, 0x458, 0x405, 0x455, 0x457,
  ];
  const cp1251Bytes = new Map([...cp1251Extra, ...Array.from({ length: 64 }, (_, i) => 0x410 + i)]
    .map((code, i) => [String.fromCharCode(code), i + 128]));

  function repairEncodingPass(source) {
    let result = "", index = 0;
    while (index < source.length) {
      const start = index;
      let decoded = "", letters = 0, streak = 0, longest = 0;
      while (index < source.length) {
        const character = source[index];
        if (character.charCodeAt(0) < 128) { decoded += character; streak = 0; index++; continue; }
        const lead = cp1251Bytes.get(character);
        const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (!length || index + length > source.length) break;
        let code = lead & (0x7f >> length), valid = true;
        for (let offset = 1; offset < length; offset++) {
          const byte = cp1251Bytes.get(source[index + offset]);
          if (!(byte >= 0x80 && byte <= 0xbf)) { valid = false; break; }
          code = (code << 6) | (byte & 0x3f);
        }
        // Reject overlong encodings, surrogate code points and invalid Unicode.
        if (!valid || code < [0, 0, 0x80, 0x800, 0x10000][length] || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) break;
        decoded += String.fromCodePoint(code);
        if (code >= 0x400 && code <= 0x4ff) { letters++; longest = Math.max(longest, ++streak); }
        else streak = 0;
        index += length;
      }
      // One or two apparent letters can be legitimate text (e.g. Р° or СЃ).
      result += letters >= 3 && longest >= 2 ? decoded : source.slice(start, index);
      if (index < source.length) result += source[index++];
    }
    return result;
  }

  function repairCyrillic(value) {
    const source = String(value ?? "");
    let result = source;
    // Handle repeated Windows conversions, but never return a half-repaired
    // value that would change again when the browser parses the server result.
    for (let pass = 0; pass < 3; pass++) {
      const next = repairEncodingPass(result);
      if (next === result) return result;
      result = next;
    }
    return repairEncodingPass(result) === result ? result : source;
  }

  function readableCode(text) {
    // Code can contain regexes or quoted strings: keep escaped ASCII syntax.
    return formatJson(repairCyrillic(readableText(text, { preserveAscii: true })));
  }
  function textViews(source, transform) {
    const initialReadable = transform(source);
    let original = source, readable = initialReadable, derived = readable;
    return {
      value: enabled => enabled ? readable : original,
      hasEdits: () => original !== source || readable !== initialReadable,
      update(enabled, value) {
        if (enabled) readable = value;
        else {
          original = value;
          // Refresh a derived view, but never overwrite edits to either buffer.
          if (readable === derived) readable = derived = transform(original);
        }
      },
    };
  }
  const api = { decode, readableText, readableCode, textViews, formatJson, isText, MAX_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QaReportFilePreview = api;
})(typeof window === "undefined" ? globalThis : window);
