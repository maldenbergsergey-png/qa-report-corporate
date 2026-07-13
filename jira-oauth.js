const crypto = require("node:crypto");
const fs = require("node:fs");

function readSecret(name, env = process.env) {
  const file = String(env[`${name}_FILE`] || "").trim();
  if (file) return fs.readFileSync(file, "utf8").trim();
  return String(env[name] || "").trim();
}

function oauthEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader({ method, url, consumerKey, privateKey, token = "", callback = "", verifier = "", now = Date.now(), nonce } = {}) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(18).toString("hex"),
    oauth_signature_method: "RSA-SHA1",
    oauth_timestamp: String(Math.floor(now / 1000)),
    oauth_version: "1.0",
  };
  if (token) oauth.oauth_token = token;
  if (callback) oauth.oauth_callback = callback;
  if (verifier) oauth.oauth_verifier = verifier;
  const target = new URL(url);
  const parameters = [...target.searchParams.entries(), ...Object.entries(oauth)]
    .map(([key, value]) => [oauthEncode(key), oauthEncode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  const normalized = parameters.map(([key, value]) => `${key}=${value}`).join("&");
  const baseUrl = `${target.protocol}//${target.host}${target.pathname}`;
  const base = [String(method || "GET").toUpperCase(), oauthEncode(baseUrl), oauthEncode(normalized)].join("&");
  oauth.oauth_signature = crypto.sign("RSA-SHA1", Buffer.from(base), privateKey).toString("base64");
  return `OAuth ${Object.entries(oauth).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`).join(", ")}`;
}

function parseForm(text) {
  return Object.fromEntries(new URLSearchParams(String(text || "")));
}

function loadJiraOAuthConfig(env = process.env) {
  let raw;
  try { raw = JSON.parse(String(env.JIRA_INSTANCES_JSON || "[]")); }
  catch { throw new Error("JIRA_INSTANCES_JSON содержит некорректный JSON"); }
  if (!Array.isArray(raw) || !raw.length) throw new Error("Не настроен список JIRA_INSTANCES_JSON");
  const consumerKey = String(env.JIRA_OAUTH_CONSUMER_KEY || "qa-report").trim();
  const privateKey = readSecret("JIRA_OAUTH_PRIVATE_KEY", env);
  const encryptionSecret = readSecret("JIRA_TOKEN_ENCRYPTION_KEY", env);
  if (!privateKey || !consumerKey) throw new Error("Не настроен Jira OAuth consumer/private key");
  if (Buffer.byteLength(encryptionSecret) < 32) throw new Error("JIRA_TOKEN_ENCRYPTION_KEY должен содержать не менее 32 байт");
  const ids = new Set();
  const instances = raw.map((item) => {
    const id = String(item.id || "").trim();
    const name = String(item.name || id).trim();
    const version = String(item.version || "").trim();
    const base = new URL(String(item.baseUrl || ""));
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id) || ids.has(id)) throw new Error("Некорректный или повторяющийся Jira instance id");
    if (env.NODE_ENV === "production" && base.protocol !== "https:") throw new Error("Jira URL должен использовать HTTPS в production");
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Некорректная схема Jira URL");
    ids.add(id);
    return { id, name, version, baseUrl: base.origin + base.pathname.replace(/\/+$/, "") };
  });
  return { instances, consumerKey, privateKey, encryptionKey: crypto.createHash("sha256").update(encryptionSecret).digest() };
}

function encryptToken(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptToken(value, key) {
  const [version, iv, tag, encrypted] = String(value || "").split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Некорректный формат Jira OAuth token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"));
}

module.exports = { oauthHeader, parseForm, loadJiraOAuthConfig, encryptToken, decryptToken };
