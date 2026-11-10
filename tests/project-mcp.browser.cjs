const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { initializeSharing } = require("../report-sharing"), { projectOf } = require("../project-mcp-access");
const { connectMcp } = require("./helpers/qa-report-mcp-client.cjs");
const root = path.resolve(__dirname, ".."), corporate = fs.existsSync(path.join(root, "auth.js"));
let app, browser, client, namedClient, directory, database;
function data(value) { assert.equal(value.error, undefined); assert.notEqual(value.result?.isError, true, JSON.stringify(value)); return JSON.parse(value.result.content[0].text); }
async function main() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-mcp-browser-"));
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, NODE_ENV: "development", QA_REPORT_TRUST_PROXY: "true", HOST: "127.0.0.1", PORT: String(port), QA_REPORT_PUBLIC_URL: origin,
    REPORTS_DB_PATH: path.join(directory, "reports.sqlite"), QA_ADMIN_CONFIG_FILE: path.join(directory, "absent.json"),
    AUTH_SECRET: secret, AUTH_SECRET_FILE: "", DEV_LOGIN_EMAIL: "developer@example.test", DEV_LOGIN_PASSWORD: "synthetic-device-login", QA_REPORT_S3_CONFIG_FILE: "", CLERK_PUBLISHABLE_KEY: "", CLERK_JWT_KEY: "", CLERK_JWT_KEY_FILE: "",
    QA_STORAGE_ACCESS_KEY: "", QA_STORAGE_SECRET_KEY: "", QA_STORAGE_ACCESS_KEY_FILE: "", QA_STORAGE_SECRET_KEY_FILE: "" };
  let jwt = "";
  if (!corporate) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    env.CLERK_PUBLISHABLE_KEY = "pk_test_" + Buffer.from("clerk.example.test$").toString("base64");
    env.CLERK_JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
    const time = Math.floor(Date.now() / 1000);
    const unsigned = [Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ iss: "https://clerk.example.test", azp: origin,
      sub: "user_author", sid: "sess_fixture", iat: time, nbf: time - 1, exp: time + 600, sts: "active" })).toString("base64url")].join(".");
    jwt = unsigned + "." + crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  }
  database = new DatabaseSync(env.REPORTS_DB_PATH); initializeSharing(database);
  function publish(issueUrl, author = corporate ? "author@example.test" : "user_author") {
    const id = crypto.randomBytes(16).toString("hex"), time = new Date().toISOString();
    const snapshot = { title: issueUrl, issueUrl, environment: "STAGE", overallStatus: "NOT_OK", intro: { text: "", attachments: [] }, sections: [
      { id: "section", title: "Checks", columns: [{ id: "check", label: "Проверка" }], rows: [{ id: "row", number: "1", status: "NOT_OK", cells: { check: { text: "Открыть форму", attachments: [] } } }] },
    ] };
    database.prepare("INSERT INTO shared_publications (id,payload_digest,snapshot_json,manifest_json,read_hash,reply_hash,owner_hash,created_at,published_at,ready_at,author_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "d".repeat(64), JSON.stringify(snapshot), "[]", "a".repeat(64), "b".repeat(64), "c".repeat(64), time, time, time, author);
    return id;
  }
  const a = publish("https://tasks.example.test/browse/QA-1"), b = publish("https://tasks.example.test/browse/QA-2");
  publish("https://other.example.test/browse/QA-3"); publish("https://tasks.example.test/browse/OTHER-1");
  publish("https://tasks.example.test/browse/QA-4", corporate ? "other@example.test" : "user_other");
  app = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let log = ""; const timer = setTimeout(() => reject(Error(log || "Startup timeout")), 10000);
    app.stdout.on("data", chunk => { log += chunk; if (log.includes("QA Report:")) { clearTimeout(timer); resolve(); } });
    app.stderr.on("data", chunk => { log += chunk; }); app.once("exit", code => { clearTimeout(timer); reject(Error("Server exited " + code + ": " + log)); });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.11" }, locale: "ru-RU", viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  async function login() {
    if (corporate) await context.addCookies([{ name: "query-port-session", value: require("../auth").createSessionToken("author@example.test", { env }), url: origin, httpOnly: true, sameSite: "Lax" }]);
  }
  await login();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!corporate && url.pathname === "/report-account-dialog.js") return route.fulfill({ contentType: "text/javascript", body: `
      export async function observeProfile(key, callback) { callback({ id: 'user_author', firstName: 'Тест', lastName: 'Автор', email: 'author@example.test' }); }
      export async function sessionToken() { return ${JSON.stringify(jwt)}; }
    ` });
    return route.continue();
  });
  const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
  async function open() {
    await page.goto(corporate ? origin : origin + "/profile");
    if (corporate) await page.click("#corporateProfileButton");
    await page.locator(corporate ? "#corporateProfileDialog [data-mcp-open]" : "#profilePage [data-mcp-open]").click();
    await page.getByRole("tab", { name: "Для разработчика", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-project-select] option").length === 4);
  }
  await open();
  await page.locator("[data-project-select]").selectOption(projectOf("https://tasks.example.test/browse/QA-1").id);
  await page.locator("[data-project-label]").fill("Frontend developer");
  await page.locator("[data-project-create]").click();
  await page.locator("[data-project-issued]").waitFor();
  await page.locator("[data-project-copy]").click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Подключи MCP QA Report/);
  assert.equal(await page.locator("[data-project-options]").getAttribute("open"), null);
  await page.locator("[data-project-client]").selectOption("json");
  await page.locator("[data-project-copy]").click();
  const launch = Object.values(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).mcpServers)[0];
  const keyId = new URL(launch.env.QA_REPORT_PROJECT_URL).pathname.split("/")[4];
  assert.ok(launch.args.includes(origin + "/downloads/qa-report-mcp.tgz"));
  client = await connectMcp({ ...launch.env, npm_config_cache: path.join(directory, "npm-cache"), npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" }, undefined, undefined, { ...launch, timeoutMs: 120000 });
  assert.deepEqual(new Set(data(await client.call("qa_report_list_reports")).reports.map(row => row.id)), new Set([a, b]));
  const future = publish("https://tasks.example.test/browse/QA-5");
  assert.equal(data(await client.call("qa_report_list_reports", { query: "QA-5" })).reports[0].id, future);
  data(await client.call("qa_report_read", { reportId: b }));
  data(await client.call("qa_report_save_answer", { reportId: a, sectionId: "section", rowId: "row", revision: 0, status: "fixed", comment: "Исправлено" }));
  assert.equal(JSON.parse(database.prepare("SELECT snapshot_json FROM shared_publications WHERE id = ?").get(a).snapshot_json).sections[0].rows[0].status, "NOT_OK");
  await page.locator("[data-project-issued]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, "project-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator("#mcpSettingsDialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: path.join(directory, "project-mobile.png") });
  if (corporate) {
    const csrf = (await (await context.request.get(origin + "/api/auth/csrf")).json()).csrfToken;
    assert.equal((await context.request.post(origin + "/api/auth/logout", { data: { csrfToken: csrf } })).status(), 200);
    assert.equal((await context.request.get(origin + "/api/mcp/project-keys")).status(), 401);
    assert.equal(data(await client.call("qa_report_read", { reportId: a })).id, a);
    await login();
  }
  await open();
  const row = page.locator(".mcp-project-key", { hasText: "Frontend developer" });
  await row.getByRole("button", { name: "Отозвать" }).click();
  await page.waitForFunction(() => document.querySelector("[data-project-keys]")?.textContent.includes("отозван"));
  assert.equal((await client.call("qa_report_list_reports")).result.isError, true);
  assert.equal(database.prepare("SELECT revoked_at FROM shared_report_project_keys WHERE id = ?").get(keyId).revoked_at > 0, true);
  // An author grants projects before the recipient's first login. The same
  // downloaded MCP remains running during login, grants, revocation and logout.
  await page.locator("[data-project-install]").click();
  await page.waitForFunction(() => document.querySelector("[data-project-install-state]").textContent.includes("Вставьте запрос"));
  const setup = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(setup, /--links/);
  const siteGrant = page.locator("[data-project-grant-form]");
  await siteGrant.locator("[data-project-recipient]").fill("developer@example.test");
  await siteGrant.locator("[data-project-grant-project]").selectOption(projectOf("https://tasks.example.test/browse/QA-1").id);
  await siteGrant.locator("[data-project-grant-create]").click();
  await page.locator("[data-project-grants] .mcp-project-key").first().waitFor();
  const info = await (await fetch(origin + "/api/mcp/package")).json();
  const installed = path.join(directory, "qa-report-developer.cjs");
  const bytes = Buffer.from(await (await fetch(origin + info.developerUrl)).arrayBuffer());
  assert.ok(setup.includes(crypto.createHash("sha256").update(bytes).digest("hex")));
  fs.writeFileSync(installed, bytes);
  const state = { QA_REPORT_MCP_STATE_DIR: path.join(directory, "private") };
  require("node:child_process").execFileSync(process.execPath, [installed, "--trust", origin], { env: { ...process.env, ...state } });
  namedClient = await connectMcp(state, undefined, undefined, { command: process.execPath, args: [installed, "--links"] });
  const pairing = data(await namedClient.call("qa_report_connect", { site: origin }));
  // The employee browser, author browser and MCP are separate clients behind the test proxy.
  const employee = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.22" } });
  const approval = await employee.newPage();
  await approval.goto(pairing.verificationUrl);
  await approval.locator("#loginEmail").fill("developer@example.test");
  await approval.locator("#loginPassword").fill("synthetic-device-login");
  await approval.locator("#loginSubmit").click();
  await approval.waitForURL(origin + "/mcp-connect.html");
  await approval.locator("input[name=code]").fill(pairing.code);
  await approval.getByRole("button", { name: "Подтвердить подключение" }).click();
  await approval.waitForFunction(() => document.querySelector("#approve").hidden);
  assert.ok((await approval.locator("#identity").textContent()).includes("developer@example.test"));
  const list = query => namedClient.call("qa_report_list_reports", { site: origin, query });
  const namedReports = data(await list("QA-1")).reports;
  assert.equal(namedReports.length, 1);
  const report = data(await namedClient.call("qa_report_read", { url: namedReports[0].url }));
  data(await namedClient.call("qa_report_save_answer", { reportRef: report.reportRef, sectionId: "section", rowId: "row", revision: 1, comment: "Проверено разработчиком" }));
  await siteGrant.locator("[data-project-grant-project]").selectOption("");
  await siteGrant.locator("[data-project-grant-url]").fill("https://tasks.example.test/desk/Task/TWO-1");
  await siteGrant.locator("[data-project-grant-create]").click();
  await page.locator("[data-project-grants] .mcp-project-key", { hasText: "TWO" }).waitFor();
  const later = publish("https://tasks.example.test/desk/Task/TWO-2");
  assert.equal(data(await list("TWO-2")).reports[0].id, later);
  await page.locator("[data-project-grants] .mcp-project-key", { hasText: " · QA · " }).getByRole("button").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-project-grants] .mcp-project-key").length === 1);
  assert.equal(data(await list("QA-1")).reports.length, 0);
  assert.equal(data(await list("TWO-2")).reports.length, 1);
  const csrfEmployee = (await (await employee.request.get(origin + "/api/auth/csrf")).json()).csrfToken;
  assert.equal((await employee.request.post(origin + "/api/auth/logout", { data: { csrfToken: csrfEmployee } })).status(), 200);
  assert.equal((await list("TWO-2")).result.isError, true);
  await employee.close();
  assert.deepEqual(errors, []);
  console.log((corporate ? "Corporate" : "Public") + " project MCP: real account, scoped reports, clean package, future publication, answer, logout and revocation passed. Screenshots: " + directory);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await namedClient?.close(); await client?.close(); await browser?.close();
  if (app && app.exitCode === null) await new Promise(resolve => { app.once("exit", resolve); app.kill(); });
  database?.close();
  if (directory) fs.rmSync(path.join(directory, "npm-cache"), { recursive: true, force: true });
});
