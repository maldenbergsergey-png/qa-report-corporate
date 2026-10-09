// Local attachment viewer regression with an isolated database and synthetic files.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-file-preview-'));
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
  const editorSelector = 'tr[data-row-id="preview-row"] .cell-editor[data-column-id="comment"]';
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    applyDraftLocally({ ...draft, title: 'Просмотр вложений', issueUrl: '', intro: '', sections: [{
      id: 'preview-section', title: 'Проверка ответа API',
      columns: [{ id: 'check', title: 'Проверка', width: 300 }, { id: 'comment', title: 'Вложения', width: 500 }],
      rows: [{ id: 'preview-row', status: 'OK', cells: { check: 'Проверить XML', comment: '<p>Ответ сервера</p>' } }],
    }] });
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  });
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\r\n<response>\r\n  <message>Проверка успешна</message>\r\n  <details>' + 'Длинная строка '.repeat(30) + '</details>\r\n</response>';
  await page.locator(editorSelector).click();
  await page.locator('#imageInput').setInputFiles({ name: 'response.xml', mimeType: 'application/octet-stream', buffer: Buffer.from(xml) });
  const card = page.locator(editorSelector + ' .cell-file').first();
  await card.waitFor();
  await page.waitForFunction(() => elements.imageInput.value === "" && pwaPendingOperations === 0);
  await page.evaluate(() => collectDocumentFields());
  await page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent === serializeDraft());
  const before = await page.evaluate(() => { const wiki = generateMarkup(); return { report: serializeDraft(), undo: undoStack.length, wiki }; });
  const dialog = page.locator('#fileViewerDialog');
  const text = page.locator('#fileViewerText');
  const close = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('fileViewerDialog').open && !viewingFileCard);
  };
  // The local viewer works without a network connection.
  await context.setOffline(true);
  await card.click();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await text.inputValue(), xml.replace(/\r\n/g, '\n'));
  assert.equal(await text.getAttribute('readonly'), '');
  assert.equal(await page.locator('#fileViewerReadable').isDisabled(), true);
  assert.equal(await page.locator('#fileViewerReadableHint').isVisible(), false);
  assert.match(await page.locator('#fileViewerMeta').textContent(), /UTF-8/);
  await page.locator('#copyFileViewerButton').click();
  await page.waitForFunction(() => document.getElementById('copyFileViewerButton').textContent === 'Скопировано');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), xml);
  // Clipboard fallback remains usable inside the native modal.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('fixture denial'); }; });
  await page.locator('#fileViewerEncoding').selectOption('utf-8');
  await page.locator('#copyFileViewerButton').click();
  await page.waitForFunction(() => document.getElementById('copyFileViewerButton').textContent === 'Скопировано');
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), xml.replace(/\r\n/g, '\n'));
  await page.evaluate(() => { delete navigator.clipboard.writeText; });
  await page.locator('#fileViewerWrap').uncheck();
  assert.equal(await text.getAttribute('wrap'), 'off');
  const downloaded = page.waitForEvent('download');
  await page.locator('#downloadFileViewerButton').click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'response.xml');
  assert.equal(fs.readFileSync(await download.path()).toString(), xml);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.getElementById('fileViewerDialog').contains(document.activeElement)), true);
  }
  await text.focus();
  await page.keyboard.type('must not change the attachment');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await text.inputValue(), xml.replace(/\r\n/g, '\n'));
  await close();
  assert.equal(await card.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await page.evaluate(() => { const wiki = generateMarkup(); return { report: serializeDraft(), undo: undoStack.length, wiki }; }), before);
  // Keyboard and menu both open the same viewer, with modified clicks selecting only.
  await page.keyboard.press('Enter');
  assert.equal(await dialog.isVisible(), true); await close();
  await page.keyboard.press('Space');
  assert.equal(await dialog.isVisible(), true); await close();
  await card.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  assert.equal(await dialog.isVisible(), false);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await card.locator('[aria-label="Ещё действия"]').click();
  await page.getByRole('button', { name: 'Просмотреть файл', exact: true }).click();
  assert.equal(await dialog.isVisible(), true); await close();
  await context.setOffline(false);
  await page.reload();
  await card.waitFor(); await card.click();
  assert.equal(await text.inputValue(), xml.replace(/\r\n/g, '\n'));
  if (screenshots) {
    fs.mkdirSync(screenshots, { recursive: true });
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.screenshot({ path: path.join(screenshots, `preview-${theme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(screenshots, 'preview-mobile.png') });
    for (const id of ['#closeFileViewerButton', '#copyFileViewerButton', '#downloadFileViewerButton']) {
      const rect = await page.locator(id).boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 390 && rect.y >= 0 && rect.y + rect.height <= 844, id);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await close();
  const fixture = async (bytes, name, type = 'application/octet-stream', overrides = {}) => {
    await page.evaluate(({ dataUrl, name, type, size, overrides }) => {
      const editor = document.querySelector('tr[data-row-id="preview-row"] .cell-editor[data-column-id="comment"]');
      editor.innerHTML = createFileCardHtml({ id: 'file-fixture', name, type, size, dataUrl, ...overrides });
      enhanceFileControls(editor);
    }, { dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`, name, type, size: bytes.length, overrides });
    await card.click();
  };

  const readableToggle = page.locator('#fileViewerReadable');
  const rawJson = String.raw`{"product":{"category":{"id":5,"name":"\u041a\u0432\u0430\u0440\u0442\u0438\u0440\u044b"},"id":9007199254740993,"title":"\u041c\u0438\u0440\u0430 \ud83d\ude80","literal":"\\u0410","path":"\/upload\/file","control":"\u000a","quote":"\u0022","slash":"\u005c"}}`;
  const readableJson = String.raw`{
  "product": {
    "category": {
      "id": 5,
      "name": "Квартиры"
    },
    "id": 9007199254740993,
    "title": "Мира 🚀",
    "literal": "\\u0410",
    "path": "\/upload\/file",
    "control": "\u000a",
    "quote": "\u0022",
    "slash": "\u005c"
  }
}`;
  await fixture(Buffer.from(rawJson), 'response.json', 'application/json');
  const jsonBefore = await page.evaluate(() => ({ report: serializeDraft(), undo: undoStack.length, dataUrl: viewingFileCard.dataset.dataUrl }));
  assert.equal(await readableToggle.isChecked(), true);
  assert.equal(await readableToggle.isEnabled(), true);
  assert.equal(await page.locator('#fileViewerReadableHint').isVisible(), true);
  assert.equal(await text.inputValue(), readableJson);
  assert.match(await page.locator('#fileViewerState').textContent(), /^15 строк.*Читаемый текст/);
  await page.locator('#copyFileViewerButton').click();
  await page.waitForFunction(() => document.getElementById('copyFileViewerButton').textContent === 'Скопировано');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), readableJson);
  await readableToggle.uncheck();
  assert.equal(await text.inputValue(), rawJson);
  assert.match(await page.locator('#fileViewerState').textContent(), /Исходный текст/);
  assert.equal(await page.locator('#copyFileViewerButton').textContent(), 'Копировать текст');
  await page.locator('#fileViewerEncoding').selectOption('utf-8');
  assert.equal(await text.inputValue(), rawJson);
  await page.locator('#copyFileViewerButton').click();
  await page.waitForFunction(() => document.getElementById('copyFileViewerButton').textContent === 'Скопировано');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), rawJson);
  await readableToggle.check();
  await page.locator('#fileViewerWrap').uncheck();
  await readableToggle.uncheck(); await readableToggle.check();
  assert.equal(await text.getAttribute('wrap'), 'off');
  // Copy fallback also copies the chosen readable view.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('fixture denial'); }; });
  await page.locator('#copyFileViewerButton').click();
  await page.waitForFunction(() => document.getElementById('copyFileViewerButton').textContent === 'Скопировано');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), readableJson);
  await page.evaluate(() => { delete navigator.clipboard.writeText; });
  const jsonDownloadPending = page.waitForEvent('download');
  await page.locator('#downloadFileViewerButton').click();
  const jsonDownload = await jsonDownloadPending;
  assert.equal(jsonDownload.suggestedFilename(), 'response.json');
  assert.equal(fs.readFileSync(await jsonDownload.path()).toString(), rawJson);
  assert.deepEqual(await page.evaluate(() => ({ report: serializeDraft(), undo: undoStack.length, dataUrl: viewingFileCard.dataset.dataUrl })), jsonBefore);
  await page.locator('#fileViewerWrap').check();
  if (screenshots) {
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.screenshot({ path: path.join(screenshots, `json-readable-${theme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(screenshots, 'json-readable-mobile.png') });
    for (const id of ['#fileViewerReadable', '#fileViewerReadableHint', '#fileViewerText', '#copyFileViewerButton', '#downloadFileViewerButton']) {
      const rect = await page.locator(id).boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 390 && rect.y >= 0 && rect.y + rect.height <= 844, id);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await readableToggle.uncheck(); await close(); await card.click();
  assert.equal(await readableToggle.isChecked(), true);
  assert.equal(await text.inputValue(), readableJson); await close();

  // Formatting also activates the existing toggle for JSON without Unicode escapes.
  const plainJson = '{"outer":[{"count":2},true,null,[]],"id":9007199254740993,"duplicate":1,"duplicate":2}';
  const formattedPlainJson = [
    '{', '  "outer": [', '    {', '      "count": 2', '    },',
    '    true,', '    null,', '    []', '  ],', '  "id": 9007199254740993,',
    '  "duplicate": 1,', '  "duplicate": 2', '}',
  ].join('\n');
  await fixture(Buffer.from(plainJson), 'nested.json', 'application/json');
  assert.equal(await readableToggle.isEnabled(), true);
  assert.equal(await text.inputValue(), formattedPlainJson);
  await readableToggle.uncheck();
  assert.equal(await text.inputValue(), plainJson);
  await readableToggle.check();
  assert.equal(await text.inputValue(), formattedPlainJson); await close();
  const invalidJson = ' {"outer": [1, 2,]}\r\n';
  await fixture(Buffer.from(invalidJson), 'invalid.json', 'application/json');
  assert.equal(await readableToggle.isDisabled(), true);
  assert.equal(await text.inputValue(), invalidJson.replace(/\r\n/g, '\n')); await close();
  await fixture(Buffer.from(String.raw`\u003cimg src="https://example.test/image" onerror="window.previewExecuted=true"\u003e\u003cscript\u003ewindow.previewExecuted=true\u003c/script\u003e`), 'escaped.log');
  assert.match(await text.inputValue(), /^<img/);
  assert.equal(await dialog.locator('script,img,iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined); await close();
  await fixture(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1251"?><x>'), Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2]), Buffer.from('</x>')]), 'legacy.xml');
  assert.match(await text.inputValue(), /Привет/); await close();
  await fixture(Buffer.from('<?xml version="1.0" encoding="bad-encoding"?><x>Привет</x>'), 'wrong.xml');
  assert.match(await page.locator('#fileViewerMessage').textContent(), /кодировку/);
  await page.locator('#fileViewerEncoding').selectOption('utf-8');
  assert.match(await text.inputValue(), /Привет/); await close();
  const unsafe = '<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.test/entity">]><x>&e;</x><img src="https://example.test/image" onerror="window.previewExecuted=true"><script>window.previewExecuted=true</script>';
  await fixture(Buffer.from(unsafe), 'unsafe.html', 'text/html');
  assert.equal(await text.inputValue(), unsafe);
  assert.equal(await dialog.locator('script,img,iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined); await close();
  for (const [bytes, name, expected] of [[Buffer.from('binary'), 'archive.zip', /формата/], [Buffer.from([0,1,2,3]), 'fake.xml', /двоичные/], [Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), 'large.xml', /до 2 МБ/]]) {
    await fixture(bytes, name, 'application/octet-stream', { size: 1 });
    assert.equal(await text.isVisible(), false);
    assert.equal(await readableToggle.isDisabled(), true);
    assert.equal(await page.locator('#fileViewerReadableHint').isVisible(), false);
    assert.equal(await page.locator('#copyFileViewerButton').isDisabled(), true);
    assert.match(await page.locator('#fileViewerMessage').textContent(), expected);
    assert.equal(await page.locator('#downloadFileViewerButton').isEnabled(), true); await close();
  }
  await fixture(Buffer.alloc(0), 'empty.xml');
  assert.equal(await page.locator('#fileViewerState').textContent(), 'Пустой файл'); await close();
  await fixture(Buffer.from(''), 'remote.xml', 'application/xml', { dataUrl: 'https://example.test/file.xml' });
  assert.match(await page.locator('#fileViewerMessage').textContent(), /сохранённых в браузере/); await close();
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: upload/reload, offline XML, indented/readable/source JSON, invalid JSON, exact numbers, literal escapes, clipboard and fallback, original download, keyboard/menu/focus, encodings, safe markup, unsupported/binary/oversized/empty/remote files and responsive layouts.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
