const crypto = require("node:crypto");
const fs = require("node:fs");
const tls = require("node:tls");

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE = "query-port-session";
const CSRF_COOKIE = "query-port-csrf";
const MAX_EMAIL_LENGTH = 254;

function normalizeEmail(value) {
  const email = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || /[\u0000-\u001f\u007f]/.test(email)) return "";
  return email;
}

function authenticateDevelopmentAccount(email, password, { env = process.env, host = "" } = {}) {
  if (env.NODE_ENV !== "development") return null;
  const normalizedHost = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(normalizedHost)) return null;
  const configuredEmail = normalizeEmail(env.DEV_LOGIN_EMAIL);
  const configuredPassword = String(env.DEV_LOGIN_PASSWORD || "");
  const normalized = normalizeEmail(email);
  if (!configuredEmail || !configuredPassword || normalized !== configuredEmail) return null;
  const expected = crypto.createHash("sha256").update(configuredPassword).digest();
  const supplied = crypto.createHash("sha256").update(String(password || "")).digest();
  return crypto.timingSafeEqual(expected, supplied)
    ? { ok: true, email: configuredEmail, development: true }
    : { ok: false, category: "invalid_credentials" };
}

function escapeLdapFilter(value) {
  return Buffer.from(String(value || ""), "utf8").toString("utf8").replace(/[\\*()/\0]/g, (char) => {
    const escaped = { "\\": "\\5c", "*": "\\2a", "(": "\\28", ")": "\\29", "/": "\\2f", "\0": "\\00" };
    return escaped[char];
  });
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function readSecret(name, env = process.env) {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, "utf8").trim();
  return String(env[name] || "").trim();
}

function sessionSecret(env = process.env) {
  const secret = readSecret("AUTH_SECRET", env) || readSecret("NEXTAUTH_SECRET", env);
  if (Buffer.byteLength(secret) < 32) throw new Error("AUTH_SECRET/NEXTAUTH_SECRET должен содержать не менее 32 байт");
  return secret;
}

function createSessionToken(email, { env = process.env, now = Date.now() } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Некорректный email");
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: "query-port-web",
    aud: "query-port-session",
    sub: normalized,
    email: normalized,
    iat: issuedAt,
    exp: issuedAt + SESSION_MAX_AGE_SECONDS,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", sessionSecret(env)).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifySessionToken(token, { env = process.env, now = Date.now() } = {}) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac("sha256", sessionSecret(env)).update(unsigned).digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const current = Math.floor(now / 1000);
    const email = normalizeEmail(payload.email);
    if (header.alg !== "HS256" || payload.iss !== "query-port-web" || payload.aud !== "query-port-session") return null;
    if (!email || payload.sub !== email || !Number.isFinite(payload.exp) || payload.exp <= current) return null;
    if (!Number.isFinite(payload.iat) || payload.iat > current + 60 || payload.exp - payload.iat > SESSION_MAX_AGE_SECONDS) return null;
    return { email, sub: email, iat: payload.iat, exp: payload.exp };
  } catch {
    return null;
  }
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([name]) => name));
}

function sessionFromRequest(request, options) {
  return verifySessionToken(parseCookies(request)[SESSION_COOKIE], options);
}

function cookieAttributes({ production = process.env.NODE_ENV === "production", maxAge = SESSION_MAX_AGE_SECONDS } = {}) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production ? "; Secure" : ""}`;
}

function sessionCookie(token, options) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(options)}`;
}

function clearSessionCookie(options) {
  return `${SESSION_COOKIE}=; ${cookieAttributes({ ...options, maxAge: 0 })}`;
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function csrfCookie(token, options) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes({ ...options, maxAge: 600 })}`;
}

function verifyCsrf(request, token) {
  const cookie = parseCookies(request)[CSRF_COOKIE] || "";
  const supplied = String(token || "");
  const a = Buffer.from(cookie);
  const b = Buffer.from(supplied);
  return a.length >= 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sanitizeCallbackUrl(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\u0000-\u001f\\]/.test(raw)) return "/";
  try {
    const url = new URL(raw, "https://query-port.invalid");
    if (url.origin !== "https://query-port.invalid") return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function clientIp(request, trustProxy = process.env.QA_REPORT_TRUST_PROXY === "true") {
  if (trustProxy) return String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() || request.socket.remoteAddress || "unknown";
  return request.socket.remoteAddress || "unknown";
}

function createLoginRateLimiter({ maxAccount = 5, maxIp = 50, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const accounts = new Map();
  const ips = new Map();
  const active = (map, key) => (map.get(key) || []).filter((time) => now() - time < windowMs);
  return {
    isBlocked(email, ip) {
      const accountAttempts = active(accounts, email);
      const ipAttempts = active(ips, ip);
      if (accountAttempts.length) accounts.set(email, accountAttempts); else accounts.delete(email);
      if (ipAttempts.length) ips.set(ip, ipAttempts); else ips.delete(ip);
      return accountAttempts.length >= maxAccount || ipAttempts.length >= maxIp;
    },
    fail(email, ip) {
      accounts.set(email, [...active(accounts, email), now()]);
      ips.set(ip, [...active(ips, ip), now()]);
    },
    success(email, ip) { accounts.delete(email); ips.delete(ip); },
    _counts(email, ip) { return { account: active(accounts, email).length, ip: active(ips, ip).length }; },
  };
}

function ldapConfig(env = process.env) {
  const url = String(env.LDAP_URL || "").trim();
  if (!url.startsWith("ldaps://")) throw new Error("LDAP_URL должен использовать только ldaps://");
  const servername = String(env.LDAP_TLS_SERVERNAME || "").trim();
  const searchBase = String(env.LDAP_SEARCH_BASE || "").trim();
  const bindDn = String(env.LDAP_BIND_DN || "").trim();
  const bindPassword = readSecret("LDAP_BIND_PASSWORD", env);
  const caFile = String(env.LDAP_CA_FILE || "").trim();
  if (!servername || !searchBase || !bindDn || !bindPassword || !caFile) throw new Error("Неполная LDAP-конфигурация");
  const ca = fs.readFileSync(caFile);
  const expectedFingerprint = String(env.LDAP_CA_SHA256 || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  if (expectedFingerprint) {
    const actual = new crypto.X509Certificate(ca).fingerprint256.replace(/:/g, "").toUpperCase();
    if (actual !== expectedFingerprint) throw new Error("Fingerprint корпоративного LDAP CA не совпадает");
  }
  return { url, servername, searchBase, bindDn, bindPassword, ca };
}

function ldapErrorCategory(error, fallback) {
  const message = `${error?.message || ""} ${error?.lde_message || ""}`;
  const subcode = message.match(/data\s+([0-9a-f]{3,4})/i)?.[1]?.toLowerCase() || "";
  const categories = { "532": "password_expired", "533": "account_disabled", "701": "account_expired", "773": "password_change_required", "775": "account_locked" };
  return { category: categories[subcode] || fallback, subcode };
}

function bind(client, dn, password) {
  return new Promise((resolve, reject) => client.bind(dn, password, (error) => error ? reject(error) : resolve()));
}

function unbind(client) {
  return new Promise((resolve) => {
    if (!client) return resolve();
    client.unbind(() => resolve());
  });
}

function searchOne(client, base, filter) {
  return new Promise((resolve, reject) => client.search(base, { scope: "sub", sizeLimit: 2, filter, attributes: ["mail", "userAccountControl"] }, (error, result) => {
    if (error) return reject(error);
    const entries = [];
    result.on("searchEntry", (entry) => entries.push(entry.pojo || entry.object || {}));
    result.on("error", reject);
    result.on("end", () => resolve(entries.length === 1 ? entries[0] : null));
  }));
}

async function authenticateLdap(email, password, { env = process.env, createClient } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !String(password || "")) return { ok: false, category: "invalid_input" };
  const config = ldapConfig(env);
  const factory = createClient || ((options) => require("ldapjs").createClient(options));
  const clientOptions = {
    url: config.url,
    reconnect: false,
    timeout: 10_000,
    connectTimeout: 10_000,
    tlsOptions: {
      ca: [config.ca], servername: config.servername, rejectUnauthorized: true, minVersion: "TLSv1.2",
      checkServerIdentity: (hostname, certificate) => tls.checkServerIdentity(config.servername, certificate),
    },
  };
  let serviceClient;
  let userClient;
  try {
    serviceClient = factory(clientOptions);
    try { await bind(serviceClient, config.bindDn, config.bindPassword); }
    catch (error) { return { ok: false, ...ldapErrorCategory(error, "service_bind_failed") }; }
    let entry;
    try {
      const filter = `(&(mail=${escapeLdapFilter(normalized)})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`;
      entry = await searchOne(serviceClient, config.searchBase, filter);
    } catch (error) { return { ok: false, ...ldapErrorCategory(error, "search_failed") }; }
    if (!entry) return { ok: false, category: "user_not_found", subcode: "" };
    const attributes = entry.attributes || entry;
    const uac = Number(attributes.userAccountControl || attributes.useraccountcontrol || 0);
    if (uac & 2) return { ok: false, category: "account_disabled", subcode: "533" };
    userClient = factory(clientOptions);
    try { await bind(userClient, normalized, String(password)); }
    catch (error) { return { ok: false, ...ldapErrorCategory(error, "user_bind_failed") }; }
    return { ok: true, email: normalized };
  } finally {
    await Promise.all([unbind(userClient), unbind(serviceClient)]);
  }
}

module.exports = {
  SESSION_MAX_AGE_SECONDS, SESSION_COOKIE, CSRF_COOKIE, normalizeEmail, escapeLdapFilter,
  createSessionToken, verifySessionToken, sessionFromRequest, sessionCookie, clearSessionCookie,
  createCsrfToken, csrfCookie, verifyCsrf, sanitizeCallbackUrl, clientIp,
  createLoginRateLimiter, ldapConfig, authenticateLdap,
  authenticateDevelopmentAccount,
};
