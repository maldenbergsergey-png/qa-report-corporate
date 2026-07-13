const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  SESSION_MAX_AGE_SECONDS,
  normalizeEmail,
  escapeLdapFilter,
  createSessionToken,
  verifySessionToken,
  sanitizeCallbackUrl,
  createLoginRateLimiter,
  ldapConfig,
  authenticateLdap,
  authenticateDevelopmentAccount,
} = require("../auth");
const { oauthHeader, loadJiraOAuthConfig, encryptToken, decryptToken } = require("../jira-oauth");

const SECRET = "test-only-session-secret-that-is-at-least-32-bytes-long";

function ldapFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-auth-"));
  const caFile = path.join(dir, "ca.pem");
  const ca = tls.rootCertificates[0];
  fs.writeFileSync(caFile, ca);
  const fingerprint = new crypto.X509Certificate(ca).fingerprint256;
  return {
    dir,
    env: {
      LDAP_URL: "ldaps://10.99.20.10:636",
      LDAP_TLS_SERVERNAME: "sister.ADV.local",
      LDAP_SEARCH_BASE: "DC=ADV,DC=local",
      LDAP_BIND_DN: "CN=query-port,OU=Service,DC=ADV,DC=local",
      LDAP_BIND_PASSWORD: "service-secret",
      LDAP_CA_FILE: caFile,
      LDAP_CA_SHA256: fingerprint,
    },
  };
}

function fakeClient({ entry, bindError } = {}) {
  return {
    binds: [],
    closed: false,
    bind(dn, password, callback) {
      this.binds.push({ dn, password });
      queueMicrotask(() => callback(bindError || null));
    },
    search(base, options, callback) {
      this.searchArgs = { base, options };
      const result = new EventEmitter();
      queueMicrotask(() => {
        callback(null, result);
        queueMicrotask(() => {
          if (entry) result.emit("searchEntry", { pojo: entry });
          result.emit("end", { status: 0 });
        });
      });
    },
    unbind(callback) { this.closed = true; queueMicrotask(callback); },
  };
}

test("normalization and input validation happen before LDAP", async () => {
  assert.equal(normalizeEmail("  TEST@Example.COM  "), "test@example.com");
  let calls = 0;
  assert.deepEqual(await authenticateLdap("", "password", { createClient: () => { calls += 1; } }), { ok: false, category: "invalid_input" });
  assert.deepEqual(await authenticateLdap("user@example.com", "", { createClient: () => { calls += 1; } }), { ok: false, category: "invalid_input" });
  assert.equal(calls, 0);
});

test("development account works only in development on loopback", () => {
  const env = {
    NODE_ENV: "development",
    DEV_LOGIN_EMAIL: "admin@local.test",
    DEV_LOGIN_PASSWORD: "local-password",
  };
  assert.deepEqual(
    authenticateDevelopmentAccount(" ADMIN@LOCAL.TEST ", "local-password", { env, host: "127.0.0.1" }),
    { ok: true, email: "admin@local.test", development: true },
  );
  assert.deepEqual(
    authenticateDevelopmentAccount("admin@local.test", "wrong", { env, host: "127.0.0.1" }),
    { ok: false, category: "invalid_credentials" },
  );
  assert.equal(authenticateDevelopmentAccount("admin@local.test", "local-password", { env, host: "0.0.0.0" }), null);
  assert.equal(
    authenticateDevelopmentAccount("admin@local.test", "local-password", {
      env: { ...env, NODE_ENV: "production" },
      host: "127.0.0.1",
    }),
    null,
  );
});

test("LDAP filter escapes RFC4515 metacharacters including slash", () => {
  assert.equal(escapeLdapFilter("a\\*()/\0"), "a\\5c\\2a\\28\\29\\2f\\00");
});

test("plaintext LDAP and a mismatched CA fingerprint are rejected", () => {
  assert.throws(() => ldapConfig({ LDAP_URL: "ldap://dc:389" }), /ldaps:\/\//);
  const fixture = ldapFixture();
  assert.throws(() => ldapConfig({ ...fixture.env, LDAP_CA_SHA256: "00".repeat(32) }), /Fingerprint/);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test("two-step LDAP bind uses TLS verification, escaped filter, UPN, and closes both clients", async () => {
  const fixture = ldapFixture();
  const service = fakeClient({ entry: { attributes: { mail: "user@example.com", userAccountControl: "0" } } });
  const user = fakeClient();
  const options = [];
  const clients = [service, user];
  const result = await authenticateLdap(" User@Example.COM ", "user-password", {
    env: fixture.env,
    createClient: (value) => { options.push(value); return clients.shift(); },
  });
  assert.deepEqual(result, { ok: true, email: "user@example.com" });
  assert.equal(service.binds[0].dn, fixture.env.LDAP_BIND_DN);
  assert.equal(user.binds[0].dn, "user@example.com");
  assert.equal(user.binds[0].password, "user-password");
  assert.match(service.searchArgs.options.filter, /^\(&\(mail=user@example\.com\)/);
  assert.equal(options[0].url.startsWith("ldaps://"), true);
  assert.equal(options[0].tlsOptions.rejectUnauthorized, true);
  assert.equal(options[0].tlsOptions.minVersion, "TLSv1.2");
  assert.equal(options[0].tlsOptions.servername, fixture.env.LDAP_TLS_SERVERNAME);
  assert.equal(typeof options[0].tlsOptions.checkServerIdentity, "function");
  assert.equal(service.closed, true);
  assert.equal(user.closed, true);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test("disabled AD account is rejected and clients are closed", async () => {
  const fixture = ldapFixture();
  const service = fakeClient({ entry: { attributes: { userAccountControl: "514" } } });
  const result = await authenticateLdap("user@example.com", "password", { env: fixture.env, createClient: () => service });
  assert.equal(result.category, "account_disabled");
  assert.equal(service.closed, true);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test("session is finite, contains no password, expires, and secret rotation revokes it", () => {
  const env = { AUTH_SECRET: SECRET };
  const now = Date.now();
  const token = createSessionToken("USER@example.com", { env, now });
  assert.equal(token.includes("password"), false);
  const session = verifySessionToken(token, { env, now });
  assert.equal(session.email, "user@example.com");
  assert.equal(session.exp - session.iat, SESSION_MAX_AGE_SECONDS);
  assert.equal(verifySessionToken(token, { env, now: now + (SESSION_MAX_AGE_SECONDS + 1) * 1000 }), null);
  assert.equal(verifySessionToken(token, { env: { AUTH_SECRET: `${SECRET}-rotated` }, now }), null);
});

test("independent account/IP limits clear on success and after window", () => {
  let time = 0;
  const limiter = createLoginRateLimiter({ maxAccount: 2, maxIp: 3, windowMs: 1000, now: () => time });
  limiter.fail("a@example.com", "1.1.1.1");
  limiter.fail("a@example.com", "2.2.2.2");
  assert.equal(limiter.isBlocked("a@example.com", "3.3.3.3"), true);
  limiter.success("a@example.com", "1.1.1.1");
  assert.equal(limiter.isBlocked("a@example.com", "3.3.3.3"), false);
  limiter.fail("b@example.com", "1.1.1.1");
  limiter.fail("c@example.com", "1.1.1.1");
  limiter.fail("d@example.com", "1.1.1.1");
  assert.equal(limiter.isBlocked("e@example.com", "1.1.1.1"), true);
  time = 1001;
  assert.equal(limiter.isBlocked("e@example.com", "1.1.1.1"), false);
});

test("callback URL cannot escape the current origin", () => {
  assert.equal(sanitizeCallbackUrl("/report/abc?x=1"), "/report/abc?x=1");
  assert.equal(sanitizeCallbackUrl("//evil.example/path"), "/");
  assert.equal(sanitizeCallbackUrl("https://evil.example/path"), "/");
});

test("production sources contain no authentication bypass switches", () => {
  const source = ["auth.js", "server.js"].map((name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")).join("\n");
  assert.doesNotMatch(source, /AUTH_BYPASS|SKIP_LDAP|MASTER_PASSWORD|TEST_(?:USER|ALIAS)|PASSWORDLESS/i);
});

test("Jira OAuth supports two instances, RSA-SHA1 signing, and authenticated token encryption", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-oauth-unit-"));
  const keyFile = path.join(dir, "private.pem");
  fs.writeFileSync(keyFile, privateKey);
  const config = loadJiraOAuthConfig({
    NODE_ENV: "test",
    JIRA_INSTANCES_JSON: JSON.stringify([
      { id: "legacy", name: "Jira 7", version: "7.3.2", baseUrl: "http://jira7.local" },
      { id: "main", name: "Jira 8", version: "8.11.1", baseUrl: "http://jira8.local" },
    ]),
    JIRA_OAUTH_CONSUMER_KEY: "qa-report",
    JIRA_OAUTH_PRIVATE_KEY_FILE: keyFile,
    JIRA_TOKEN_ENCRYPTION_KEY: "jira-encryption-key-with-more-than-thirty-two-bytes",
  });
  assert.equal(config.instances.length, 2);
  const header = oauthHeader({ method: "GET", url: "http://jira7.local/rest/api/2/myself", consumerKey: config.consumerKey, privateKey: config.privateKey, token: "user-token", now: 1000, nonce: "fixed" });
  assert.match(header, /^OAuth /);
  assert.match(header, /oauth_signature_method="RSA-SHA1"/);
  assert.match(header, /oauth_token="user-token"/);
  const encrypted = encryptToken({ oauthToken: "secret-token", oauthTokenSecret: "secret" }, config.encryptionKey);
  assert.equal(encrypted.includes("secret-token"), false);
  assert.deepEqual(decryptToken(encrypted, config.encryptionKey), { oauthToken: "secret-token", oauthTokenSecret: "secret" });
  const encryptedParts = encrypted.split(".");
  encryptedParts[2] = `${encryptedParts[2][0] === "A" ? "B" : "A"}${encryptedParts[2].slice(1)}`;
  assert.throws(() => decryptToken(encryptedParts.join("."), config.encryptionKey));
  fs.rmSync(dir, { recursive: true, force: true });
});
