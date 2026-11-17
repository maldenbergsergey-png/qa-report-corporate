// Clipboard history regression with an isolated database, local fixtures and no remote services.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-clipboard-text-'));
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


  const selector = 'tr[data-row-id="paste-row"] .cell-editor';
  async function fixture() {
    await page.evaluate(() => {
      cloudHistoryEnabled = false;
      applyDraftLocally({ ...draft, title: 'Clipboard history', intro: '', issueUrl: '', sections: [{
        id: 'paste-section', title: 'Logs', columns: [{ id: 'check', title: 'Check', width: 800 }],
        rows: [{ id: 'paste-row', status: 'OK', cells: { check: 'Keep this text. ' } }],
      }] });
      collectDocumentFields(); historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
    });
    await page.locator(selector).focus();
    await page.keyboard.press('End');
  }
  async function paste(value) {
    await page.locator(selector).evaluate((editor, value) => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', value);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, value);
  }

  const content = () => page.locator(selector).evaluate(editor => cleanEditorHtml(editor));
  const plainLog = '11-17 12:34:56 D/Logs: {"message":"Ответ получен","status":200}';
  const json = '{"message":"Ответ получен","status":200}';
  // The saved fixture is anonymized; a local sample can be checked without committing it.
  const androidLog = fs.readFileSync(process.env.QA_REPORT_LOG_SAMPLE || path.join(__dirname, 'fixtures/android-http-error.txt'), 'utf8').trimEnd();
  const rawAndroidLog = androidLog.replaceAll('&#x20;', ' ').replace(/\\+([:*])/g, '$1').replace(/\\+$/gm, '').replace(/\n\n/g, '\n');
  const httpOnlyLog = rawAndroidLog.slice(rawAndroidLog.indexOf('[http-error]'));
  const samples = [
    [plainLog, false], [json, true], ['```json\n' + json + '\n```', true], ['https://example.test/log', false],
    [androidLog, false], [rawAndroidLog, false], [httpOnlyLog, true],
  ];
  for (const [value, codeExpected] of samples) {
    for (const delayed of [false, true]) {
      await fixture();
      const original = await content();
      await page.keyboard.type('Typed before pasting. ');
      const before = await content();
      await paste(value);
      assert.equal(await page.locator(selector + ' .cell-code-block').count(), codeExpected ? 1 : 0);
      const after = await content();
      assert.notEqual(after, before);
      assert.equal(await page.locator('#undoButton').isEnabled(), true);
      if (delayed) await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft());
      await page.keyboard.press('Control+z');
      assert.equal(await content(), before, 'Undo removes only the entire paste, preserving pending typing');
      await page.keyboard.press('Control+z');
      assert.equal(await content(), original, 'Prior typing is a separate undo step');
      await page.keyboard.press('Control+y');
      assert.equal(await content(), before);
      await page.keyboard.press('Control+Shift+z');
      assert.equal(await content(), after);
    }
  }
  // Also exercise the browser clipboard and native paste shortcut with the supplied log.
  for (const value of [androidLog, rawAndroidLog, httpOnlyLog]) {
    await fixture();
    const before = await content();
    await page.evaluate(value => navigator.clipboard.writeText(value), value);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
    await page.waitForFunction(() => undoStack.length > 0);
    const after = await content();
    assert.notEqual(after, before);
    await page.keyboard.press('Control+z');
    assert.equal(await content(), before, 'Native clipboard paste must also undo the whole HTTP error log');
    await page.keyboard.press('Control+y');
    assert.equal(await content(), after);
  }
  // Replacing selected text must restore that text on undo.
  await fixture();
  const original = await content();
  await page.locator(selector).evaluate(editor => {
    const range = document.createRange(); range.selectNodeContents(editor);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await paste(plainLog.repeat(2000));
  await page.keyboard.press('Control+z');
  assert.equal(await content(), original);

  // Non-Latin layouts still send physical KeyZ / KeyY for the same shortcuts.
  for (const modifier of ['ctrlKey', 'metaKey']) {
    await fixture();
    const before = await content();
    await paste(plainLog);
    const after = await content();
    for (const [key, code, shiftKey, expected] of [
      ['я', 'KeyZ', false, before], ['н', 'KeyY', false, after],
      ['я', 'KeyZ', false, before], ['Я', 'KeyZ', true, after],
    ]) {
      const handled = await page.locator(selector).evaluate((editor, options) =>
        !editor.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })),
      { key, code, shiftKey, [modifier]: true });
      assert.equal(handled, true, 'History shortcuts must work with a Russian keyboard layout');
      assert.equal(await content(), expected);
    }
  }
  // Browser Edit-menu undo/redo must use the report history for DOM insertions too.
  await fixture();
  const before = await content();
  await paste(plainLog);
  const after = await content();
  for (const [inputType, expected] of [['historyUndo', before], ['historyRedo', after]]) {
    await page.locator(selector).focus();
    const handled = await page.locator(selector).evaluate((editor, inputType) =>
      !editor.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })), inputType);
    assert.equal(handled, true);
    assert.equal(await content(), expected);
  }
  // Browser history must not reach an inactive editor behind another control.
  await page.locator('#issueUrl').focus();
  const inactiveHandled = await page.locator(selector).evaluate(editor =>
    !editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })));
  assert.equal(inactiveHandled, true);
  assert.equal(await content(), after);
  // Intro text uses the same insertion/history path as checklist cells.
  await page.locator('#introEditor').focus();
  await page.locator('#introEditor').evaluate(editor => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'Intro log {"result":"готово"}');
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  assert.match(await page.locator('#introEditor').textContent(), /Intro log/);
  await page.keyboard.press('Meta+z');
  assert.equal(await page.locator('#introEditor').textContent(), '');
  assert.deepEqual(externalRequests, []);
  console.log('PASS: escaped/raw HTTP error logs through the native clipboard, plain text/code/URL paste, pending typing, immediate/delayed undo and redo, replacement, large logs, Russian layouts, browser history commands and intro text.');
  assert.deepEqual(errors, []);
}
main().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit',resolve)); }
  fs.rmSync(temp,{recursive:true,force:true});
});
