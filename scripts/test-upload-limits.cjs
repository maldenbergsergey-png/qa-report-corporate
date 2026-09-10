// Local browser regression; Jira calls are fixtures and never reach an external service.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-upload-browser-"));
let child, browser;
async function main() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const secret = "local-browser-test-secret-at-least-32-bytes";
  child = spawn(process.execPath, ["server.js"], { cwd: root, env: {
    ...process.env, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "development",
    AUTH_SECRET: secret, AUTH_SECRET_FILE: "", REPORTS_DB_PATH: path.join(temp, "reports.sqlite"), QA_REPORT_PUBLIC_URL: origin,
  }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", data => { if (data.toString().includes("QA Report:")) resolve(); });
    child.stderr.on("data", data => fs.appendFileSync(path.join(temp, "server.log"), data));
    child.once("exit", code => reject(Error(`Server exited ${code}`)));
    setTimeout(() => reject(Error("Startup timeout")), 10000).unref();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (fs.existsSync(path.join(root, "auth.js"))) {
    const { createSessionToken } = require(path.join(root, "auth"));
    await context.addCookies([{ name: "query-port-session", value: createSessionToken("qa@example.com", { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: "Lax" }]);
  }
  const page = await context.newPage();
  const errors = [], uploads = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  let jiraLimit = 1204756;
  await page.route("**/api/jira/attachment-manifest", route => route.fulfill({ json: {
    ok: true, attachmentReuse: true, issueUrl: "https://jira.example/browse/QA-1", attachments: [],
    attachmentLimits: { appMaxFileBytes: 80 * 1024 * 1024, requestMaxBytes: 150 * 1024 * 1024, jiraEnabled: true, jiraUploadLimit: jiraLimit },
  } }));
  await page.route("**/api/jira/attachments", route => {
    const data = route.request().postDataJSON(); uploads.push(data);
    return route.fulfill({ json: { ok: true, attachments: data.files.map(file => ({ attachmentId: file.attachmentId, id: String(900 + uploads.length), filename: file.name })) } });
  });
  await page.goto(origin); await page.waitForSelector(".cell-editor");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "graphite";
    elements.issueUrl.value = "https://jira.example/browse/QA-1";
    draft.issueUrl = elements.issueUrl.value;
    if (typeof jiraSettings !== "undefined") {
      jiraSettings = { transport: "server", baseUrl: "https://jira.example", type: "data-center", authMethod: "pat" };
      jiraSecret = "fixture";
    }
  });
  const editor = page.locator(".cell-editor").first(); await editor.click();
  const video = Buffer.alloc(1204756, 0x82);
  await page.locator("#imageInput").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: video });
  await page.waitForFunction(() => document.querySelector(".cell-file")?.dataset.fileName === "clip.mp4");
  const hint = page.locator("#attachmentLimitsHint");
  assert.match(await hint.textContent(), /83.*886.*080/); // configured 80 MiB, not hardcoded 50
  assert.match(await hint.textContent(), /1.*204.*756/);
  const imagePath = process.env.QA_REPORT_SCREENSHOT;
  if (imagePath) await page.screenshot({ path: imagePath });
  await page.evaluate(() => { collectDocumentFields(); });
  jiraLimit = 1204755;
  const preflight = await page.evaluate(async () => {
    try { await uploadPendingImages({}, { issueUrl: elements.issueUrl.value }); return "unexpected success"; }
    catch (error) { return error.message; }
  });
  assert.match(preflight, /лимит Jira/); assert.equal(uploads.length, 0);
  jiraLimit = 1204756;
  await page.evaluate(() => uploadPendingImages({}, { issueUrl: elements.issueUrl.value }));
  assert.equal(uploads.length, 1);
  assert.deepEqual(Buffer.from(uploads[0].files[0].dataBase64, "base64"), video);
  // New local file over the Jira limit never enters the editor.
  await editor.click();
  await page.locator("#imageInput").setInputFiles({ name: "too-large.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1204757) });
  await page.waitForFunction(() => document.querySelector("#imageInput").value === "");
  assert.equal(await page.locator('.cell-file[data-file-name="too-large.mp4"]').count(), 0);
  const messages = await page.evaluate(() => ({
    proxy: friendlyJiraError(new JiraRequestError("HTTP 413", { status: 413 })),
    jira: friendlyJiraError(new JiraRequestError("Jira limit fixture", { status: 413, code: "JIRA_PAYLOAD_TOO_LARGE" })),
  }));
  assert.match(messages.proxy, /Прокси QA Report/); assert.equal(messages.jira, "Jira limit fixture");
  await page.unroute("**/api/jira/attachments");
  let proxyAttempts = 0;
  await page.route("**/api/jira/attachments", route => {
    proxyAttempts++;
    return route.fulfill({ status: 413, contentType: "text/html", body: "<html>413 Request Entity Too Large</html>" });
  });
  const actualProxyMessage = await page.evaluate(async () => {
    try { await jiraRequest("/api/jira/attachments", { files: [{ name: "clip.mp4", dataBase64: "eA==" }] }); }
    catch (error) { return friendlyJiraError(error); }
  });
  assert.match(actualProxyMessage, /Прокси QA Report/);
  assert.equal(proxyAttempts, 1, "an uncertain upload is never retried automatically");
  assert.deepEqual(errors, []);
  console.log("Browser upload regression passed:", path.basename(root));
}
main().finally(async () => {
  await browser?.close(); child?.kill("SIGTERM"); fs.rmSync(temp, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
