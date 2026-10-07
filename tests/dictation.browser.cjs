"use strict";
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto"), { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-dictation-"));
let server, browser;
async function main() {
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`; await new Promise(resolve => listener.close(resolve));
  const secret = crypto.randomBytes(32).toString("hex");
  server = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, HOST:"127.0.0.1", NODE_ENV:"development", AUTH_SECRET:secret, AUTH_SECRET_FILE:"", REPORTS_DB_PATH:path.join(temp, "db.sqlite"), QA_REPORT_PUBLIC_URL:origin, QA_STORAGE_ACCESS_KEY:"", QA_STORAGE_SECRET_KEY:"", QA_STORAGE_ACCESS_KEY_FILE:"", QA_STORAGE_SECRET_KEY_FILE:"" }, stdio:["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { server.stdout.on("data", chunk => { if (chunk.includes("QA Report:")) resolve(); }); server.stderr.on("data", chunk => fs.appendFileSync(path.join(temp,"server.log"),chunk)); server.once("exit", code => reject(Error(`Server exit ${code}`))); setTimeout(() => reject(Error("Server timeout")), 10000).unref(); });
  browser = await chromium.launch({ headless:true, args:["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const context = await browser.newContext({ viewport:{ width:1440, height:1000 }, serviceWorkers:"block" });
  if (fs.existsSync(path.join(root,"auth.js"))) {
    const { createSessionToken } = require(path.join(root,"auth"));
    await context.addCookies([{ name:"query-port-session", value:createSessionToken("qa@example.test", {env:{AUTH_SECRET:secret}}), url:origin, httpOnly:true, sameSite:"Lax" }]);
  }
  const page = await context.newPage(), errors = [], jobs = new Map(); let sequence = 0, processing = "none", speechMode = "browser", held;
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.dictationFixture = { text:"Надиктованный текст", clipboard:[], denyClipboard:false };
    Object.defineProperty(navigator, "clipboard", { value:{ writeText:async text => { if (window.dictationFixture.denyClipboard) throw Error("Permission denied"); window.dictationFixture.clipboard.push(text); } } });
    window.SpeechRecognition = class {
      start() { window.dictationFixture.language = this.lang; queueMicrotask(() => this.onstart()); }
      stop() { const result = [{ transcript:window.dictationFixture.text }]; result.isFinal = true; this.onresult({resultIndex:0, results:[result]}); this.onend(); }
      abort() {}
    };
  });
  await page.route("**/api/ai/*", async route => {
    const action = new URL(route.request().url()).pathname, payload = route.request().postDataJSON(), id = `dictation-${++sequence}`;
    if (action.endsWith("profiles")) jobs.set(id, {status:"completed", result:{profiles:[], speech:{mode:speechMode, available:true, language:"en", selection:"configured-selection", processing, processingAvailable:true}}});
    else if (action.endsWith("refine")) { assert.equal(payload.selection,"configured-selection"); jobs.set(id, {status:"running"}); held = id; }
    else if (action.endsWith("transcribe")) {
      assert.equal(payload.selection,"configured-selection");
      const validate = fs.existsSync(path.join(root,"connect-dictation-server.js")) ? require(path.join(root,"connect-dictation-server")).audioInput : require(path.join(root,"agent/bug-report")).audioInput;
      validate(payload.audio); jobs.set(id,{status:"completed",result:{text:"Распознано локально"}});
    } else throw Error("Unexpected dictation request " + action);
    await route.fulfill({status:202, contentType:"application/json", body:JSON.stringify({jobId:id})});
  });
  await page.route("**/api/agent/jobs/*", route => { const id = new URL(route.request().url()).pathname.split("/").at(-1); return route.fulfill({contentType:"application/json", body:JSON.stringify({job:jobs.get(id)})}); });
  await page.goto(origin); await page.waitForSelector("#dictationButton");
  const fixture = () => page.evaluate(() => {
    cloudHistoryEnabled = false;
    applyDraftLocally({...draft, intro:"<p>Вводный текст</p>", sections:[{id:"voice-section", title:"Проверки", columns:[{id:"check",title:"Проверка",width:350},{id:"comment",title:"Комментарий",width:350}],rows:[{id:"voice-row",status:"НЕ ОК",cells:{check:"До после",comment:"Другая ячейка"}}]}]});
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
    document.activeElement.blur(); window.getSelection().removeAllRanges(); document.body.click();
  });
  const cell = '[data-row-id="voice-row"] .cell-editor[data-column-id="check"]';
  const focus = offset => page.locator(cell).evaluate((editor, offset) => { editor.focus(); const range = document.createRange(); range.setStart(editor.firstChild,offset); range.collapse(true); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); }, offset);
  const start = async () => { await page.click("#dictationButton"); await page.waitForFunction(() => document.querySelector(".editor-toolbar").dataset.dictationPhase === "recording"); };
  const waitForRefine = async previous => { const deadline = Date.now() + 5000; while (held === previous && Date.now() < deadline) await page.waitForTimeout(20); assert.notEqual(held, previous); };
  const stop = async () => { await page.click("#dictationButton"); await page.waitForFunction(() => ["idle", "error"].includes(document.querySelector(".editor-toolbar").dataset.dictationPhase)); assert.equal(await page.locator(".editor-toolbar").getAttribute("data-dictation-phase"),"idle",await page.textContent("#dictationStatus")); };
  await fixture(); await focus(3); await start();
  assert.equal(await page.locator(cell).evaluate(node => node.classList.contains("dictation-target")),true);
  assert.equal(await page.locator("#dictationDestination").count(), 0);
  assert.match(await page.textContent("#dictationStatus"), /REC/);
  assert.equal(await page.evaluate(() => window.dictationFixture.language),"en-US");
  await page.screenshot({path:path.join(temp,"recording-light.png"),fullPage:true});
  await page.locator('[data-column-id="comment"].cell-editor').focus(); await stop();
  assert.equal(await page.locator(cell).innerText(),"До Надиктованный текст после");
  assert.equal(await page.locator(cell).evaluate(node => node === document.activeElement),true);
  assert.equal(await page.locator('[data-column-id="comment"].cell-editor').innerText(),"Другая ячейка");
  await page.waitForTimeout(550); await page.evaluate(() => undo());
  assert.equal(await page.locator(cell).innerText(),"До после");
  // Starting outside an editor copies the result and never uses the default intro editor.
  await fixture(); await page.locator("#dictationButton").focus(); await start(); await stop();
  assert.equal(await page.evaluate(() => window.dictationFixture.clipboard.at(-1)),"Надиктованный текст");
  assert.equal(await page.locator("#introEditor").innerText(),"Вводный текст");
  // Failed clipboard access leaves a selectable recovery result and blocks overwrite.
  await page.evaluate(() => {window.dictationFixture.denyClipboard = true;}); await start(); await stop();
  assert.equal(await page.locator("#dictationRecovery").isVisible(),true);
  await page.click("#dictationButton"); assert.equal(await page.locator("#dictationResult").evaluate(node => node === document.activeElement),true);
  await page.click("#dictationDiscard"); await page.evaluate(() => {window.dictationFixture.denyClipboard = false;});
  // A changed target falls back to clipboard instead of replacing later edits.
  await fixture(); await focus(3); await start(); await page.locator(cell).fill("Изменено во время записи"); await stop();
  assert.equal(await page.locator(cell).innerText(),"Изменено во время записи");
  assert.match(await page.textContent("#dictationStatus"),/буфер/);
  // Processing has a visible loader, plain-text insertion, and an independent cancellation token.
  processing = "rewrite"; const firstRefine = held; await fixture(); await focus(3); await start(); await page.click("#dictationButton");
  await page.waitForFunction(() => document.querySelector(".editor-toolbar").dataset.dictationPhase === "processing");
  assert.equal(await page.locator("#dictationButton").isDisabled(),true);
  await page.screenshot({path:path.join(temp,"processing.png"),fullPage:true});
  await waitForRefine(firstRefine); jobs.set(held,{status:"completed",result:{text:"<script>факт</script>"}});
  await page.waitForFunction(() => document.querySelector(".editor-toolbar").dataset.dictationPhase === "idle");
  assert.equal(await page.locator(cell).innerText(),"До <script>факт</script> после"); assert.equal(await page.locator(cell+" script").count(),0);
  const secondRefine = held; await fixture(); await focus(3); await start(); await page.click("#dictationButton");
  await page.waitForFunction(() => document.querySelector(".editor-toolbar").dataset.dictationPhase === "processing");
  await waitForRefine(secondRefine); const cancelled = held; await page.click("#dictationCancel"); jobs.set(cancelled,{status:"completed",result:{text:"Поздний ответ"}});
  await page.waitForTimeout(1650); assert.equal(await page.locator(cell).innerText(),"До после");
  // An AI failure preserves the original transcript and explains that it was not processed.
  const thirdRefine = held; await focus(3); await start(); await page.click("#dictationButton");
  await page.waitForFunction(() => document.querySelector(".editor-toolbar").dataset.dictationPhase === "processing");
  await waitForRefine(thirdRefine); jobs.set(held,{status:"failed",error:"Модель недоступна"});
  await page.waitForFunction(() => document.querySelector(".editor-toolbar").dataset.dictationPhase === "idle");
  assert.equal(await page.locator(cell).innerText(),"До Надиктованный текст после"); assert.match(await page.textContent("#dictationStatus"),/Без обработки/);
  // Exercise the actual MediaRecorder/WAV path used by the configured local/API models.
  speechMode = "local"; processing = "none"; await fixture(); await focus(3); await start(); await page.waitForTimeout(250); await stop();
  assert.equal(await page.locator(cell).innerText(),"До Распознано локально после");
  await page.evaluate(() => {document.documentElement.dataset.theme = "dark";}); await page.screenshot({path:path.join(temp,"dark.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844}); await page.screenshot({path:path.join(temp,"narrow.png"),fullPage:true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${path.basename(root)}: saved caret, destination, default language, undo, clipboard recovery, changed target, processing, cancellation, plain text, AI failure, narrow layout. Screenshots: ${temp}`);
}
main().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => { await browser?.close(); server?.kill(); });
