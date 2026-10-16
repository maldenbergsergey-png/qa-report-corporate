// Code editor regression with an isolated database, local fixtures and no remote services.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-code-readable-'));
const screenshots = process.env.QA_REPORT_SCREENSHOTS;
let child, browser;
async function main() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  await new Promise(resolve => listener.close(resolve));
  const secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, NODE_ENV: 'development',
    AUTH_SECRET: secret, AUTH_SECRET_FILE: '', DEV_LOGIN_EMAIL: 'qa@example.com',
    DEV_LOGIN_PASSWORD: crypto.randomBytes(24).toString('hex'),
    REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'), QA_REPORT_PUBLIC_URL: origin,
    QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '',
    QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; if (log.includes('QA Report:')) resolve(); });
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(temp, 'server.log'), chunk));
    child.once('exit', code => reject(Error(`Server exited: ${code}`)));
    setTimeout(() => reject(Error('Server startup timeout')), 10000).unref();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const externalRequests = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    externalRequests.push(url.href); return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#imageButton');

  const selector = 'tr[data-row-id="code-row"] .cell-code-block';
  const source = String.raw`{"name":"\u041f\u0440\u0438\u0432\u0435\u0442","id":9007199254740993,"price":2.5000,"duplicate":1,"duplicate":2,"literal":"\\u0410","control":"\n","html":"<img src=x onerror=alert(1)>"}`;
  const { readableCode } = require(path.join(root, 'file-preview'));
  const readable = readableCode(source);
  await page.evaluate(source => {
    cloudHistoryEnabled = false;
    applyDraftLocally({ ...draft, title:'Редактирование запроса', intro:'', issueUrl:'', sections:[{
      id:'code-section',title:'Ответ API',columns:[{id:'check',title:'Проверка',width:800}],
      rows:[{id:'code-row',status:'OK',cells:{check:codeSnippetHtml('json',source)}}],
    }] });
    collectDocumentFields(); historyCurrent=serializeDraft(); undoStack=[]; redoStack=[];
  }, source);
  const text = page.locator('#codeEditorTextarea');
  const toggle = page.locator('#codeEditorReadable');
  const save = page.locator('#saveCodeButton');
  const open = async () => {
    await page.locator(selector).click(); await page.waitForSelector('#codeEditorModal:not([hidden])');
  };
  const waitSaved = () => page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft());
  await open();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await text.inputValue(), readable); assert.equal(await save.isEnabled(), true);
  assert.equal(await page.locator(selector).evaluate(node => node.querySelector('code').textContent), source, 'Opening must not write the converted preview to the report');
  await toggle.uncheck(); assert.equal(await text.inputValue(), source); assert.equal(await save.isDisabled(), true);
  await toggle.check();
  const edited = readable.replace('Привет', 'Привет, Москва');
  await text.fill(edited);
  await toggle.uncheck(); assert.equal(await text.inputValue(), source);
  await page.click('#closeCodeEditorButton');
  await page.waitForSelector('#confirmModal:not([hidden])');
  await page.click('#cancelConfirmButton');
  assert.equal(await page.locator('#codeEditorModal').isVisible(),true, 'Closing the source view must not silently discard readable edits');
  await toggle.check(); assert.equal(await text.inputValue(), edited, 'Switching views must keep edits');
  assert.equal(await page.locator('#codeEditorLineNumbers').textContent(), edited.split('\n').map((_,i)=>i+1).join('\n'));
  if (screenshots) {
    fs.mkdirSync(screenshots,{recursive:true});
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme=theme, theme);
      await page.screenshot({path:path.join(screenshots,`code-readable-${theme}.png`)});
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(screenshots,'code-readable-mobile.png')});
    const bounds=await page.locator('.code-editor-modal').boundingBox();
    assert.ok(bounds.width <= 390 && bounds.x >= 0);
    await page.setViewportSize({width:1440,height:1000});
  }
  await save.click(); await page.waitForSelector('#codeEditorModal[hidden]',{state:'attached'}); await waitSaved();
  assert.equal(await page.locator(selector).evaluate(node => node.querySelector('code').textContent), edited);
  await page.click('#undoButton'); await waitSaved();
  assert.equal(await page.locator(selector).evaluate(node => node.querySelector('code').textContent), source);
  await page.click('#redoButton'); await waitSaved();
  assert.equal(await page.locator(selector).evaluate(node => node.querySelector('code').textContent), edited);
  await page.reload(); await page.waitForSelector(selector);
  await page.evaluate(() => { cloudHistoryEnabled=false; });
  await open(); assert.equal(await toggle.isChecked(), true); assert.equal(await text.inputValue(),edited);
  assert.equal(await save.isDisabled(),true);
  // Source mode is editable and stores exactly what is shown, including escapes.
  await toggle.uncheck();
  await text.fill(source); await save.click(); await waitSaved();
  assert.equal(await page.locator(selector).evaluate(node => node.querySelector('code').textContent), source);
  await open(); assert.equal(await toggle.isChecked(),true); assert.equal(await text.inputValue(),readable);
  // Pasting an escaped HTTP request while the default setting is on fixes its Cyrillic.
  const request=String.raw`POST /api HTTP/1.1
Content-Type: application/json

{"text":"\u041c\u043e\u0441\u043a\u0432\u0430","literal":"\\u0410"}`;
  await text.fill('');
  await text.evaluate((editor,request) => {
    const clipboard=new DataTransfer();clipboard.setData('text/plain',request);
    editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
  },request);
  const readableRequest=readableCode(request);
  assert.equal(await text.inputValue(),readableRequest);
  await text.press('Control+s'); await waitSaved();
  assert.equal(await page.locator(selector).evaluate(node => node.querySelector('code').textContent),readableRequest);
  // Existing mojibake is corrected on open and persisted by the same Save action.
  const mojibake=new TextDecoder('windows-1251').decode(new TextEncoder().encode('Проверка кириллицы'));
  await page.evaluate(value => {
    const block=document.querySelector('tr[data-row-id="code-row"] .cell-code-block');
    block.querySelector('code').textContent=`{"text":"${value}"}`; commitCodeChange(block);
  },mojibake);
  await waitSaved(); await open(); assert.match(await text.inputValue(),/Проверка кириллицы/);
  await save.click(); await waitSaved();
  await page.reload(); await page.waitForSelector(selector);
  assert.match(await page.locator(selector).evaluate(node => node.querySelector('code').textContent),/Проверка кириллицы/);
  assert.deepEqual(errors,[]); assert.deepEqual(externalRequests,[]);
  console.log('PASS: default readable/source views, safe Unicode and mojibake repair, exact JSON numbers/duplicate keys, editing, paste, Save/Ctrl+S, undo/redo/reload and responsive layouts.');
}
main().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit',resolve)); }
  fs.rmSync(temp,{recursive:true,force:true});
});
