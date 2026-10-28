"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."), corporate = fs.existsSync(path.join(root, "auth.js"));
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test("async upload completes through short polls, reuses preflight, preserves 504 and prevents duplicate writes", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qa-upload-http-"));
  let uploads = 0, metas = 0, lists = 0, mode = "ok", inventory = [], release;
  let gate = Promise.resolve();
  const jira = http.createServer(async (req, res) => {
    for await (const chunk of req) {} // Drain the synthetic multipart/JSON.
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/plugins/servlet/oauth/")) { res.setHeader("Content-Type", "application/x-www-form-urlencoded"); res.end(req.url.endsWith("request-token") ? "oauth_token=req&oauth_token_secret=fixture&oauth_callback_confirmed=true" : "oauth_token=access&oauth_token_secret=fixture"); return; }
    if (req.url.endsWith("/myself")) { res.end(JSON.stringify({ key: "fixture", name: "fixture", emailAddress: "fixture@example.com", active: true })); return; }
    if (req.url.endsWith("/attachment/meta")) { metas++; res.end(JSON.stringify({ enabled: true, uploadLimit: 1000 })); return; }
    if (req.url.endsWith("?fields=attachment")) { lists++; res.end(JSON.stringify({ fields: { attachment: inventory } })); return; }
    if (req.url.endsWith("/attachments")) {
      uploads++; const item = { id: String(uploads), filename: "fixture.txt", size: 1 }; inventory.push(item); await gate;
      if (mode === "504") { res.writeHead(504, { "Content-Type": "text/html" }); res.end("<html>504 Gateway Time-out</html>"); }
      else res.end(JSON.stringify([item])); return;
    }
    res.statusCode = 404; res.end("{}");
  });
  const jiraOrigin = `http://127.0.0.1:${await listen(jira)}`;
  const reserve = http.createServer(), port = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = "synthetic-fixture-session-secret-at-least-32-bytes";
  const env = { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), REPORTS_DB_PATH: path.join(directory, "reports.sqlite"), QA_REPORT_PUBLIC_URL: origin, QA_ADMIN_CONFIG_FILE: path.join(directory, "none.json") };
  let headers = { "Content-Type": "application/json", "X-QA-Report-Client-Id": "fixture-owner" }, otherHeaders = { ...headers, "X-QA-Report-Client-Id": "fixture-other" };
  let base = { type: "data-center", baseUrl: jiraOrigin, token: "fixture-token", issueUrl: `${jiraOrigin}/browse/QA-1` };
  if (corporate) {
    const key = path.join(directory, "fixture.pem"), encryption = path.join(directory, "encryption");
    fs.writeFileSync(key, crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
    fs.writeFileSync(encryption, "fixture-encryption-key-at-least-32-characters");
    Object.assign(env, { AUTH_SECRET: secret, AUTH_SECRET_FILE: "", JIRA_INSTANCES_JSON: JSON.stringify([{ id: "fixture", name: "Fixture", version: "8.0", baseUrl: jiraOrigin }]), JIRA_OAUTH_PRIVATE_KEY_FILE: key, JIRA_TOKEN_ENCRYPTION_KEY_FILE: encryption, QA_JIRA_ALLOWED_ORIGINS: jiraOrigin, QA_REPORT_TRUST_PROXY: "true", QA_STORAGE_ACCESS_KEY: "", QA_STORAGE_SECRET_KEY: "", QA_STORAGE_ACCESS_KEY_FILE: "", QA_STORAGE_SECRET_KEY_FILE: "" });
    const { createSessionToken } = require("../auth");
    const cookie = email => `query-port-session=${encodeURIComponent(createSessionToken(email, { env: { AUTH_SECRET: secret } }))}`;
    headers.Cookie = cookie("fixture@example.com"); otherHeaders.Cookie = cookie("other@example.com");
    base = { instanceId: "fixture", issueUrl: `${jiraOrigin}/browse/QA-1` };
  }
  const app = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { release?.(); const closed = new Promise(resolve => app.once("close", resolve)); app.kill(); await closed; jira.closeAllConnections(); await new Promise(resolve => jira.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { let text = "", error = ""; const timer = setTimeout(() => reject(Error(error || "startup timeout")), 5000); app.stderr.on("data", c => error += c); app.once("exit", () => { clearTimeout(timer); reject(Error(error)); }); app.stdout.on("data", c => { text += c; if (text.includes(`QA Report: ${origin}`)) { clearTimeout(timer); resolve(); } }); });
  if (corporate) {
    const response = await fetch(origin + "/api/auth/csrf", { headers }); const csrf = await response.json(); headers.Cookie += "; " + response.headers.get("set-cookie").split(";")[0];
    const start = await fetch(origin + "/api/jira/oauth/start", { method: "POST", headers, body: JSON.stringify({ instanceId: "fixture", csrfToken: csrf.csrfToken, callbackUrl: "/" }) }); assert.equal(start.status, 200);
    const callback = await fetch(origin + "/api/jira/oauth/callback?oauth_token=req&oauth_verifier=fixture", { headers, redirect: "manual" }); assert.equal(callback.status, 302);
  }
  const post = async (action, extra) => { const response = await fetch(`${origin}/api/jira/${action}`, { method: "POST", headers, body: JSON.stringify({ ...base, ...extra }) }); return { status: response.status, value: await response.json() }; };
  const poll = async id => fetch(`${origin}/api/jira/uploads/${id}`, { headers }).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 100; i++) { const result = await poll(id); if (result.state !== "running") return result; await pause(10); } throw Error("upload did not complete"); };
  const preflight = crypto.randomUUID(); assert.equal((await post("attachment-manifest", { async: true, operationId: preflight })).status, 202);
  const manifest = (await wait(preflight)).result; assert.ok(manifest.uploadSession); assert.equal(metas, 1); assert.equal(lists, 1);
  const id = crypto.randomUUID(), file = { attachmentId: id, name: "fixture.txt", type: "text/plain", dataBase64: "YQ==" };
  gate = new Promise(resolve => release = resolve);
  const body = { async: true, operationId: id, uploadSession: manifest.uploadSession, files: [file] };
  const accepted = await post("attachments", body); assert.equal(accepted.status, 202);
  for (let i = 0; uploads < 1 && i < 100; i++) await pause(10);
  assert.equal((await poll(id)).state, "running");
  assert.equal((await fetch(`${origin}/api/jira/uploads/${id}`, { headers: otherHeaders })).status, 404);
  assert.equal((await post("attachments", body)).status, 202); assert.equal(uploads, 1);
  release(); const done = await wait(id); assert.equal(done.state, "completed"); assert.equal(done.result.attachments[0].id, "1");
  assert.equal((await post("attachments", body)).status, 202); assert.equal((await wait(id)).state, "completed"); assert.equal(uploads, 1);
  assert.equal((await post("attachments", { ...body, files: [{ ...file, dataBase64: "Yg==" }] })).status, 409);
  mode = "504"; const failedId = crypto.randomUUID(), failed = { ...body, operationId: failedId, files: [{ ...file, attachmentId: failedId }] };
  assert.equal((await post("attachments", failed)).status, 202); const uncertain = await wait(failedId);
  assert.equal(uncertain.state, "unknown"); assert.equal(uncertain.status, 504); assert.equal(uncertain.errorCode, "JIRA_UPSTREAM_ERROR"); assert.doesNotMatch(uncertain.error, /SSO|WAF|PAT/);
  await post("attachments", failed); assert.equal(uploads, 2); assert.equal(inventory.length, 2); assert.equal(metas, 1); assert.equal(lists, 1);
});
