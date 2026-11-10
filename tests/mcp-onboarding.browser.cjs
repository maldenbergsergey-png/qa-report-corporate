const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { spawn } = require("node:child_process");
const { connectMcp } = require("./helpers/qa-report-mcp-client.cjs");
const root = path.resolve(__dirname, ".."), corporate = require("node:fs").existsSync(path.join(root, "auth.js"));
let app, browser, client, directory;
const authEnv = { AUTH_SECRET: "synthetic-mcp-session-secret-at-least-32-bytes", AUTH_SECRET_FILE: "" };
async function main() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-mcp-onboarding-"));
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, ...authEnv,
    HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "development", QA_REPORT_PUBLIC_URL: origin,
    REPORTS_DB_PATH: path.join(directory, "reports.sqlite"), FEEDBACK_DIR: path.join(directory, "feedback"),
    QA_ADMIN_CONFIG_FILE: path.join(directory, "none.json"), CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "",
    QA_STORAGE_ACCESS_KEY: corporate ? "synthetic-key" : "", QA_STORAGE_SECRET_KEY: corporate ? "synthetic-secret" : "",
    QA_STORAGE_ACCESS_KEY_FILE: "", QA_STORAGE_SECRET_KEY_FILE: "", QA_STORAGE_ENDPOINT: "https://storage.example.test", QA_STORAGE_BUCKET: "synthetic-reports",
  }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend startup timeout")), 10000);
    app.stdout.on("data", bytes => { if (String(bytes).includes("QA Report:")) { clearTimeout(timeout); resolve(); } });
    app.once("exit", code => { clearTimeout(timeout); reject(new Error("Backend exited " + code)); });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    const headers = route.request().headers();
    delete headers.authorization; // The corporate reverse proxy removes this header.
    return route.continue({ headers });
  });
  if (corporate) {
    const { createSessionToken } = require("../auth");
    await context.addCookies([{ name: "query-port-session", value: createSessionToken("qa@example.test", { env: authEnv }), url: origin, httpOnly: true, sameSite: "Lax" }]);
    assert.equal((await fetch(origin + "/api/mcp/connections", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(origin + "/api/shared-reports/" + "a".repeat(32))).status, 401);
  }
  assert.equal((await fetch(origin + "/api/mcp/package")).status, 200);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(corporate ? origin : origin + "/profile");
  await page.waitForSelector("#localImportButton", { state: "attached" });
  if (corporate) await page.click("#corporateProfileButton");
  await page.locator(corporate ? "#corporateProfileDialog [data-mcp-open]" : "#profilePage [data-mcp-open]").click();
  await page.locator("#mcpSettingsDialog").waitFor();
  assert.equal(await page.getByRole("tab", { name: "Личный MCP", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('[data-mcp-panel="developer"]').isVisible(), false);
  await page.getByRole("tab", { name: "Личный MCP", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "Для разработчика", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('[data-mcp-panel="personal"]').isVisible(), false);
  await page.keyboard.press("Home");
  assert.equal(await page.locator("#mcpSettingsDialog [data-setup]").isVisible(), false);
  await page.screenshot({ path: path.join(directory, "guide-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator("#mcpSettingsDialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: path.join(directory, "guide-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#mcpSettingsDialog [data-close]").click();
  await page.goto(origin);
  await page.click("#localImportButton");
  await page.click("#startLocalImport");
  await page.waitForFunction(() => window.QaReportMcpEditor?.session());
  const firstSession = await page.evaluate(() => window.QaReportMcpEditor.session());
  await page.click("#closeLocalImport");
  await page.evaluate(async () => {
    applyDraftLocally(normalizeDraft({ ...clone(draft), reportId: crypto.randomUUID(), publicId: "b0000002", issueUrl: "QA-202" }));
    await saveReportSnapshot("Second MCP report");
  });
  await page.click("#localImportButton");
  await page.click("#startLocalImport");
  await page.waitForFunction(() => window.QaReportMcpEditor?.sessions().length === 2);
  await page.goto(corporate ? origin : origin + "/profile");
  if (corporate) await page.click("#corporateProfileButton");
  await page.locator(corporate ? "#corporateProfileDialog [data-mcp-open]" : "#profilePage [data-mcp-open]").click();
  const reportSelect = page.locator("#mcpSettingsDialog [data-report-select]");
  assert.equal(await reportSelect.inputValue(), "");
  assert.equal(await reportSelect.locator("option").count(), 3);
  assert.equal(await page.locator("#mcpSettingsDialog [data-setup]").isVisible(), false);
  await page.locator("[data-temporary] > summary").click();
  await reportSelect.selectOption(firstSession.id);
  await page.waitForFunction(() => !document.querySelector("#mcpSettingsDialog [data-copy]").disabled);
  assert.match(await page.locator("#mcpSettingsDialog [data-code]").inputValue(), /^Подключи MCP QA Report/);
  await page.locator("#mcpSettingsDialog [data-client]").selectOption("json");
  await page.locator("#mcpSettingsDialog [data-copy]").click();
  const setup = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  const qaLaunch = Object.values(setup.mcpServers)[0];
  assert.ok(qaLaunch.env.QA_REPORT_IMPORT_TOKEN); assert.equal(qaLaunch.env.QA_REPORT_SHARE_URL, undefined);
  client = await connectMcp(qaLaunch.env);
  const contextReply = await client.call("qa_report_get_context");
  assert.notEqual(contextReply.result?.isError, true, JSON.stringify(contextReply));
  assert.equal(JSON.parse(contextReply.result.content[0].text).reportId, firstSession.reportId);
  await client.close(); client = undefined;
  await page.screenshot({ path: path.join(directory, "qa-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator("#mcpSettingsDialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: path.join(directory, "qa-mobile.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("mcpSettingsDialog").open && document.querySelector("#mcpSettingsDialog [data-code]").value === "");
  assert.equal(await page.locator("#mcpSettingsDialog [data-code]").inputValue(), "");
  if (corporate) {
    const csrfResponse = await context.request.get(origin + "/api/auth/csrf");
    const { csrfToken } = await csrfResponse.json();
    const publish = await context.request.post(origin + "/api/shared-reports", { headers: { "X-QA-CSRF-Token": csrfToken }, data: {
      publishKey: require("node:crypto").randomBytes(32).toString("base64url"), files: [], snapshot: { title: "MCP fixture", sections: [
        { id: "section", title: "Вход", columns: [{ id: "check", label: "Проверка" }], rows: [{ id: "row", number: "1", status: "NOT_OK", cells: { check: { text: "Проверить форму" } } }] },
      ] },
    } });
    assert.equal(publish.status(), 201, await publish.text());
    const { publication } = await publish.json();
    const shareUrl = token => origin + "/shared-report/" + publication.id + "#" + token;
    await page.goto(shareUrl(publication.replyToken));
    await page.click("#shared-mcp-open");
    await page.waitForFunction(() => !document.getElementById("shared-mcp-copy").disabled);
    await page.locator("#shared-mcp-client").selectOption("json");
    await page.waitForFunction(() => document.getElementById("shared-mcp-code").value.startsWith("{"));
    const developer = Object.values(JSON.parse(await page.locator("#shared-mcp-code").inputValue()).mcpServers)[0];
    assert.ok(developer.env.QA_REPORT_MCP_ACCESS_TOKEN);
    // Execute exactly the downloaded package from this corporate host, without browser cookies.
    client = await connectMcp({ ...developer.env, npm_config_cache: path.join(directory, "npm-cache"), npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" }, undefined, undefined, { ...developer, timeoutMs: 120000 });
    const read = await client.call("qa_report_read"); assert.notEqual(read.result?.isError, true, JSON.stringify(read));
    const saved = await client.call("qa_report_save_answer", { sectionId: "section", rowId: "row", revision: 0, status: "fixed", comment: "Форма исправлена" });
    assert.notEqual(saved.result?.isError, true, JSON.stringify(saved));
    const response = await context.request.get(origin + "/api/shared-reports/" + publication.id, { headers: { Authorization: `Bearer ${publication.replyToken}` } });
    const report = (await response.json()).report;
    assert.equal(report.sections[0].rows[0].status, "NOT_OK"); assert.equal(report.answers[0].status, "fixed");
    await page.screenshot({ path: path.join(directory, "developer-mobile.png") });
    await page.click("#shared-mcp-disconnect");
    await page.waitForFunction(() => document.getElementById("shared-mcp-copy").disabled);
    assert.equal((await client.call("qa_report_read")).result.isError, true);
    await client.close(); client = undefined;
    await page.goto(shareUrl(publication.readToken)); await page.click("#shared-mcp-open");
    await page.waitForFunction(() => !document.getElementById("shared-mcp-copy").disabled);
    await page.locator("#shared-mcp-client").selectOption("json");
    await page.waitForFunction(() => document.getElementById("shared-mcp-code").value.startsWith("{"));
    const viewer = Object.values(JSON.parse(await page.locator("#shared-mcp-code").inputValue()).mcpServers)[0];
    assert.equal(viewer.env.QA_REPORT_MCP_READ_ONLY, "1");
    const denied = await fetch(origin + "/api/mcp/shared/" + publication.id + "/answers", { method: "POST", headers: {
      Authorization: `Bearer ${publication.readToken}`, "X-QA-MCP-Token": viewer.env.QA_REPORT_MCP_ACCESS_TOKEN, "Content-Type": "application/json",
    }, body: JSON.stringify({ sectionId: "section", rowId: "row", revision: 1, status: "not_fixed" }) });
    assert.equal(denied.status, 403);
    const logoutCsrf = (await (await context.request.get(origin + "/api/auth/csrf")).json()).csrfToken;
    assert.equal((await context.request.post(origin + "/api/auth/logout", { data: { csrfToken: logoutCsrf } })).status(), 200);
    const loggedOut = await fetch(origin + "/api/mcp/shared/" + publication.id, { headers: { Authorization: `Bearer ${publication.readToken}`, "X-QA-MCP-Token": viewer.env.QA_REPORT_MCP_ACCESS_TOKEN } });
    assert.equal(loggedOut.status, 401);
  }
  assert.deepEqual(errors, []);
  console.log((corporate ? "Corporate" : "Public") + " MCP onboarding passed; screenshots: " + directory);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await client?.close(); await browser?.close();
  if (app && app.exitCode === null) await new Promise(resolve => { app.once("exit", resolve); app.kill(); });
  if (directory) await fs.rm(path.join(directory, "npm-cache"), { recursive: true, force: true });
});
