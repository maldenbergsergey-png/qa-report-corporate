const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createSessionToken } = require("../auth");

const SECRET = "integration-session-secret-that-is-at-least-32-bytes";
function sessionCookie(email = "user-a@example.com") {
  return `query-port-session=${encodeURIComponent(createSessionToken(email, { env: { AUTH_SECRET: SECRET } }))}`;
}
function request(url, options = {}, email) {
  return fetch(url, { ...options, headers: { Cookie: sessionCookie(email), ...(options.headers || {}) } });
}

test("multi-Jira OAuth connects a user and signs Jira actions as that user", async () => {
  const received = [];
  const jira = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url === "/jira7/plugins/servlet/oauth/request-token") {
      res.setHeader("Content-Type", "application/x-www-form-urlencoded");
      res.end("oauth_token=request-7&oauth_token_secret=request-secret&oauth_callback_confirmed=true");
      return;
    }
    if (req.url === "/jira7/plugins/servlet/oauth/access-token") {
      res.setHeader("Content-Type", "application/x-www-form-urlencoded");
      res.end("oauth_token=access-user-a&oauth_token_secret=access-secret");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/jira7/rest/api/2/myself") {
      res.end(JSON.stringify({ name: "user-a", emailAddress: "user-a@example.com", displayName: "User A", active: true }));
      return;
    }
    if (req.url === "/jira7/rest/api/2/issue/QA-1/comment?maxResults=100") {
      res.end(JSON.stringify({ total: 0, comments: [] }));
      return;
    }
    if (req.url === "/jira7/rest/api/2/issue/QA-1/comment" && req.method === "POST") {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "10001" }));
      return;
    }
    if (req.url === "/jira7/rest/api/2/issue/QA-1/comment/10001") {
      res.end(JSON.stringify({ id: "10001", body: "Проверено" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => jira.listen(4199, "127.0.0.1", resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-oauth-"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const privateKeyFile = path.join(dir, "jira-private.pem");
  const encryptionFile = path.join(dir, "jira-encryption");
  fs.writeFileSync(privateKeyFile, privateKey);
  fs.writeFileSync(encryptionFile, "integration-jira-token-encryption-key-32-bytes-minimum");
  const instances = [
    { id: "jira7", name: "Jira Legacy", version: "7.3.2", baseUrl: "http://127.0.0.1:4199/jira7" },
    { id: "jira8", name: "Jira Main", version: "8.11.1", baseUrl: "http://127.0.0.1:4199/jira8" },
  ];
  const app = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env, NODE_ENV: "test", PORT: "4174", AUTH_SECRET: SECRET,
      REPORTS_DB_PATH: path.join(dir, "reports.sqlite"),
      JIRA_INSTANCES_JSON: JSON.stringify(instances), JIRA_OAUTH_CONSUMER_KEY: "qa-report",
      JIRA_OAUTH_PRIVATE_KEY_FILE: privateKeyFile, JIRA_TOKEN_ENCRYPTION_KEY_FILE: encryptionFile,
      QA_JIRA_ALLOWED_ORIGINS: "http://127.0.0.1:4199", QA_REPORT_TRUST_PROXY: "true",
      QA_STORAGE_ACCESS_KEY: "", QA_STORAGE_SECRET_KEY: "", QA_STORAGE_ACCESS_KEY_FILE: "", QA_STORAGE_SECRET_KEY_FILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 500); app.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); }); });
    assert.equal((await fetch("http://127.0.0.1:4174/api/health")).status, 200);
    assert.equal((await fetch("http://127.0.0.1:4174/", { redirect: "manual" })).status, 302);
    assert.equal((await fetch("http://127.0.0.1:4174/api/reports", { headers: { "X-User-Email": "admin@example.com" } })).status, 401);

    const before = await request("http://127.0.0.1:4174/api/jira/connections");
    const beforePayload = await before.json();
    assert.deepEqual(beforePayload.instances.map((item) => item.connected), [false, false]);

    const csrfResponse = await request("http://127.0.0.1:4174/api/auth/csrf");
    const csrfCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await csrfResponse.json();
    const start = await fetch("http://127.0.0.1:4174/api/jira/oauth/start", {
      method: "POST",
      headers: { Cookie: `${sessionCookie()}; ${csrfCookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "jira7", csrfToken, callbackUrl: "/" }),
    });
    assert.equal(start.status, 200);
    assert.match((await start.json()).authorizeUrl, /\/jira7\/plugins\/servlet\/oauth\/authorize\?oauth_token=request-7/);

    const callback = await request("http://127.0.0.1:4174/api/jira/oauth/callback?oauth_token=request-7&oauth_verifier=verified", { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/?jiraConnected=jira7");

    const after = await request("http://127.0.0.1:4174/api/jira/connections");
    const afterPayload = await after.json();
    assert.equal(afterPayload.instances[0].connected, true);
    assert.equal(afterPayload.instances[0].jiraUsername, "user-a");
    assert.equal(afterPayload.instances[1].connected, false);

    const disconnectedAction = await request("http://127.0.0.1:4174/api/jira/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instanceId: "jira8" }),
    });
    assert.equal(disconnectedAction.status, 409);
    assert.equal((await disconnectedAction.json()).errorCode, "JIRA_AUTH_REQUIRED");

    const comment = await request("http://127.0.0.1:4174/api/jira/comment", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueUrl: "http://127.0.0.1:4199/jira7/browse/QA-1", token: "browser-token", comment: { format: "wiki", body: "Проверено" } }),
    });
    assert.equal(comment.status, 201, JSON.stringify(await comment.clone().json()));
    const jiraCalls = received.filter((item) => item.url.startsWith("/jira7/rest/api/2/"));
    assert.equal(jiraCalls.every((item) => item.authorization?.startsWith("OAuth ")), true);
    assert.equal(jiraCalls.some((item) => item.authorization?.includes("access-user-a")), true);
    assert.equal(jiraCalls.some((item) => item.body.includes("browser-token")), false);

    const otherUser = await request("http://127.0.0.1:4174/api/jira/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instanceId: "jira7" }),
    }, "user-b@example.com");
    assert.equal(otherUser.status, 409);
  } finally {
    app.kill("SIGTERM");
    await new Promise((resolve) => jira.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
