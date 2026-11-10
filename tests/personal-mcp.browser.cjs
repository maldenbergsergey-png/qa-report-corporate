const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { initializeSharing } = require("../report-sharing"), { projectOf } = require("../project-mcp-access");
const { connectMcp } = require("./helpers/qa-report-mcp-client.cjs");
const root = path.resolve(__dirname, ".."), corporate = fs.existsSync(path.join(root, "auth.js"));
let app, browser, client, reader, directory, database;
function data(value) { assert.equal(value.error, undefined); assert.notEqual(value.result?.isError, true, JSON.stringify(value)); return JSON.parse(value.result.content[0].text); }
async function main() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-mcp-browser-"));
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(port), QA_REPORT_PUBLIC_URL: origin,
    REPORTS_DB_PATH: path.join(directory, "reports.sqlite"), QA_ADMIN_CONFIG_FILE: path.join(directory, "absent.json"),
    AUTH_SECRET: secret, AUTH_SECRET_FILE: "", QA_REPORT_S3_CONFIG_FILE: "", CLERK_PUBLISHABLE_KEY: "", CLERK_JWT_KEY: "", CLERK_JWT_KEY_FILE: "",
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
  const context = await browser.newContext({ serviceWorkers: "block", locale: "ru-RU", viewport: { width: 1280, height: 900 } });
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
    await page.locator("[data-personal-form]").waitFor();
  }
  await open();
  await page.evaluate(async () => {
    const values = ["aaa0001", "aaa0002"].map((publicId,index) => normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId:"personal_fixture_"+index, publicId,
      issueUrl:"https://tasks.example.test/desk/Task/SHOP-"+(index+1), environment:index ? "PROD" : "STAGE",
      sections:[{id:"section",title:"Browser checklist",columns:[{id:"check",title:"Проверка"},{id:"result",title:"Фактический результат"}],rows:[{id:"row",status:"НЕ ПРОВЕРЕНО",cells:{check:"<p>Проверить форму</p>",result:"<p>Не заполнено</p>"}}]}] }));
    for (const value of values) await dbTransaction("readwrite",store=>store.put({id:value.reportId,publicId:value.publicId,issueUrl:value.issueUrl,updatedAt:new Date().toISOString(),document:value}));
    applyDraftLocally(values[0]);
  });
  await page.locator("[data-personal-label]").fill("Work assistant");
  await page.locator("[data-personal-lifetime]").selectOption("");
  await page.locator("[data-personal-create]").click();
  await page.locator("[data-personal-issued]").waitFor();
  await page.locator("[data-personal-copy]").click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Подключи MCP QA Report/);
  assert.equal(await page.locator("[data-personal-options]").getAttribute("open"), null);
  await page.screenshot({ path: path.join(directory, "personal-chat.png") });
  await page.locator("[data-personal-client]").selectOption("json");
  if (!await page.locator("[data-personal-files]").isVisible()) await page.locator("[data-personal-options] > summary").click();
  await page.locator("[data-personal-files]").fill(directory);
  fs.writeFileSync(path.join(directory,"agent-log.txt"),"Synthetic log from QA verification");
  await page.locator("[data-personal-copy]").click();
  const launch=Object.values(JSON.parse(await page.evaluate(()=>navigator.clipboard.readText())).mcpServers)[0];
  const tokenHash=crypto.createHash("sha256").update(launch.env.QA_REPORT_PERSONAL_TOKEN).digest("hex");
  assert.equal(database.prepare("SELECT expires_at FROM personal_mcp_tokens WHERE token_hash=?").get(tokenHash).expires_at,null);
  await page.locator("[data-personal-browser]").click();
  await page.waitForFunction(()=>document.querySelector("[data-personal-browser-state]").textContent.includes("Подключён ·"));
  await page.locator(".personal-mcp h3").scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(directory,"personal-desktop.png")});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator("#mcpSettingsDialog").evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  await page.screenshot({path:path.join(directory,"personal-mobile.png")});
  await page.locator("#mcpSettingsDialog [data-close]").click();
  client=await connectMcp({...launch.env,npm_config_cache:path.join(directory,"npm-cache"),npm_config_ignore_scripts:"true",npm_config_audit:"false",npm_config_fund:"false"},undefined,undefined,{...launch,timeoutMs:120000});
  const reports=data(await client.call("qa_report_list_reports",{query:"SHOP-"})).reports;
  assert.equal(reports.length,2);
  const first=reports.find(item=>item.issueUrl.endsWith("SHOP-1")), second=reports.find(item=>item.issueUrl.endsWith("SHOP-2"));
  const contexts=await Promise.all([client.call("qa_report_get_context",{reportUrl:first.url}),client.call("qa_report_get_context",{reportUrl:second.url})]);
  const one=data(contexts[0]),two=data(contexts[1]);
  assert.equal(one.reportId,"personal_fixture_0");assert.equal(two.reportId,"personal_fixture_1");
  const hash=one.context.sections[0].rows[0].cells.result.hash;
  data(await client.call("qa_report_upload_attachment",{reportUrl:first.url,fileId:"result_log",path:"agent-log.txt",contentType:"text/plain"}));
  const pending=data(await client.call("qa_report_update_cells",{reportUrl:first.url,operationId:"fill_first",updates:[{sectionId:"section",rowId:"row",columnId:"result",expectedHash:hash,text:"Форма работает",status:"OK",attachmentIds:["result_log"]}]}));assert.equal(pending.status,"pending");
  async function waitOperation(reportUrl,operationId) { for(let i=0;i<20;i++){const value=data(await client.call("qa_report_get_operation",{reportUrl,operationId}));if(value.status!=="pending")return value;await new Promise(resolve=>setTimeout(resolve,2500));}throw Error("No browser confirmation"); }
  assert.equal((await waitOperation(first.url,"fill_first")).status,"saved");
  data(await client.call("qa_report_update_cells",{reportUrl:first.url,operationId:"stale",updates:[{sectionId:"section",rowId:"row",columnId:"result",expectedHash:hash,text:"Old result"}]}));
  assert.equal((await waitOperation(first.url,"stale")).status,"rejected");
  const values=await page.evaluate(async()=>[(await getReportRecord("personal_fixture_0")).document,(await getReportRecord("personal_fixture_1")).document]);
  assert.match(values[0].sections[0].rows[0].cells.result,/Форма работает/);assert.equal(values[0].sections[0].rows[0].status,"OK");assert.match(values[1].sections[0].rows[0].cells.result,/Не заполнено/);
  // Reading published data does not require the browser and never exposes another account.
  assert.equal(data(await client.call("qa_report_list_reports",{query:"QA-"})).reports.length,3);
  assert.equal(data(await client.call("qa_report_get_context",{reportUrl:origin+"/shared-report/"+a})).writable,false);
  await page.evaluate(()=>document.querySelector("[data-mcp-open]").click());
  await page.locator("[data-personal-form]").waitFor();
  await page.locator("[data-personal-keys] .mcp-project-key",{hasText:"Work assistant"}).getByRole("button",{name:"Отозвать"}).click();
  await page.waitForFunction(()=>document.querySelector("[data-personal-keys]").textContent.includes("отозван")).catch(async error=>{ throw Error(error.message+"; state="+await page.locator("[data-personal-state]").textContent()+"; keys="+await page.locator("[data-personal-keys]").textContent()); });
  assert.equal((await client.call("qa_report_list_reports")).result.isError,true);
  await page.locator("[data-personal-label]").fill("Reader");
  await page.locator("[data-personal-readonly]").check();
  await page.locator("[data-personal-create]").click();
  await page.locator("[data-personal-issued]").waitFor();
  await page.locator("[data-personal-client]").selectOption("json");
  const readLaunch=Object.values(JSON.parse(await page.locator("[data-personal-code]").inputValue()).mcpServers)[0];
  reader=await connectMcp(readLaunch.env);
  assert.equal((await reader.request("tools/list",{})).result.tools.some(tool=>tool.name==="qa_report_update_cells"),false);
  await page.evaluate(()=>window.dispatchEvent(new Event("qa-report-account-change")));
  await page.waitForFunction(()=>document.querySelector("[data-personal-browser-state]").textContent.includes("Отключён."));
  assert.equal(data(await reader.call("qa_report_list_reports",{query:"SHOP-"})).reports.length,0);
  if(corporate) {
    const csrf=(await(await context.request.get(origin+"/api/auth/csrf")).json()).csrfToken;
    assert.equal((await context.request.post(origin+"/api/auth/logout",{data:{csrfToken:csrf}})).status(),200);
    assert.equal((await context.request.get(origin+"/api/mcp/personal-tokens")).status(),401);
    assert.equal(data(await reader.call("qa_report_get_context",{reportUrl:origin+"/shared-report/"+a})).writable,false);
  }
  assert.deepEqual(errors,[]);
  console.log((corporate?"Corporate":"Public")+" personal MCP passed: real account, one-time token UI, clean package, key search, two local reports, saved/rejected writes, published ownership and revocation. Screenshots: "+directory);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await client?.close(); await reader?.close(); await browser?.close();
  if (app && app.exitCode === null) await new Promise(resolve => { app.once("exit", resolve); app.kill(); });
  database?.close();
  if (directory) fs.rmSync(path.join(directory, "npm-cache"), { recursive: true, force: true });
});
