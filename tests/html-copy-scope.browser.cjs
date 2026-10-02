// HTML copy scope regression with isolated history and synthetic attachments.
// QA_REPORT_PLAYWRIGHT may point at an existing Playwright installation.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-html-copy-'));
let child, browser;
async function main() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development',
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
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Never contact a real Jira or external attachment service.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    applyDraftLocally({ ...draft, numberingMode: 'hierarchical', intro: '<p>Intro text</p>', sections: [
      { id: 'first', title: 'First', columns: [{ id: 'check', title: 'Проверка' }], rows: [
        { id: 'one', status: 'OK', cells: { check: 'One' } },
        { id: 'two', status: 'НЕ ОК', cells: { check: '<strong>Two</strong> https://example.com/long/path' } },
      ] },
      { id: 'second', title: 'Second', collapsed: true, columns: [{ id: 'check', title: 'Проверка' }], rows: [
        { id: 'three', status: 'НЕ ОК', manualNumber: '12.3', cells: { check: 'Three' } },
        { id: 'blank', status: 'НЕ ПРОВЕРЕНО', cells: { check: '' } },
      ] },
      { id: 'empty', title: 'Empty', columns: [{ id: 'check', title: 'Проверка' }], rows: [
        { id: 'four', status: 'НЕ ПРОВЕРЕНО', cells: { check: '' } },
      ] },
    ] });
    await saveDraft();
    window.beforeHtmlCopy = JSON.stringify(draftContentSnapshot());
  });
  const open = async () => {
    await page.click('#copyMenuButton');
    await page.click('#copyVisualButton');
    await page.waitForSelector('#htmlCopyScopeModal:not([hidden])');
  };
  const readClipboard = () => page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const html = await (await item.getType('text/html')).text();
    const plain = await (await item.getType('text/plain')).text();
    const root = document.createElement('div'); root.innerHTML = html;
    return { html, plain, headings: [...root.querySelectorAll('h2')].map(n => n.textContent),
      numbers: [...root.querySelectorAll('tbody tr')].map(n => n.cells[0].textContent) };
  });
  await open();
  assert.equal(await page.locator('#htmlCopyScopeModal input:not(:checked)').count(), 0);
  assert.match(await page.locator('#htmlCopyScopeSummary').textContent(), /разделов — 2, пунктов — 3/);
  await page.click('#acceptHtmlCopyScopeButton');
  await page.waitForFunction(() => document.getElementById('acceptHtmlCopyScopeButton').textContent === 'Скопировано в буфер обмена');
  assert.equal(await page.locator('#htmlCopyScopeModal').isVisible(), true);
  const all = await readClipboard();
  assert.deepEqual(all.headings, ['1. First', '2. Second']);
  assert.deepEqual(all.numbers, ['1.1', '1.2', '2.1']);
  assert.match(all.html, /Intro text/);
  assert.match(all.plain, /<table/);
  assert.match(all.html, /min-width:.*px/);
  assert.match(all.html, /<strong>Two<\/strong>/);
  await page.uncheck('#htmlCopyStatusSelectAll');
  assert.equal(await page.locator('#acceptHtmlCopyScopeButton').isDisabled(), true);
  await page.check('#htmlCopyStatusList input[value="НЕ ОК"]');
  await page.uncheck('#htmlCopySectionList input[value="first"]');
  assert.equal(await page.locator('#acceptHtmlCopyScopeButton').textContent(), 'Копировать HTML');
  assert.equal(await page.locator('#htmlCopyStatusSelectAll').evaluate(n => n.indeterminate), true);
  assert.equal(await page.locator('#htmlCopySectionSelectAll').evaluate(n => n.indeterminate), true);
  assert.match(await page.locator('#htmlCopyScopeSummary').textContent(), /разделов — 1, пунктов — 1/);
  await page.click('#acceptHtmlCopyScopeButton');
  await page.waitForFunction(() => document.getElementById('acceptHtmlCopyScopeButton').textContent === 'Скопировано в буфер обмена');
  const filtered = await readClipboard();
  assert.deepEqual(filtered.headings, ['2. Second']);
  assert.deepEqual(filtered.numbers, ['2.1']);
  assert.doesNotMatch(filtered.html, /First|<strong>Two<\/strong>/);
  assert.equal(await page.evaluate(() => JSON.stringify(draftContentSnapshot())), await page.evaluate(() => window.beforeHtmlCopy));
  const capture = async name => { if (process.env.QA_REPORT_COPY_SCREENSHOTS) await page.screenshot({ path: path.join(temp, name + '.png') }); };
  await capture('html-desktop');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('html-mobile-' + theme);
    assert.ok(await page.locator('.html-copy-scope-footer').evaluate(n => n.getBoundingClientRect().height < 130));
    assert.ok(await page.locator('.html-copy-scope-modal').evaluate(n => { const r = n.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; }));
    await page.locator('#htmlCopySectionList input').last().scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#htmlCopySectionList input').last().isVisible(), true);
    const rects = await page.evaluate(() => ['closeHtmlCopyScopeButton', 'acceptHtmlCopyScopeButton'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }));
    assert.ok(rects.every(r => r.x >= 0 && r.y >= 0 && r.right <= 390 && r.bottom <= 844));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#closeHtmlCopyScopeButton');
  assert.equal(await page.locator('#htmlCopyScopeModal').isHidden(), true);
  assert.equal(await page.locator('#copyMenuButton').evaluate(n => n === document.activeElement), true);
  await open();
  assert.equal(await page.locator('#htmlCopyScopeModal input:not(:checked)').count(), 0);
  await page.uncheck('#htmlCopySectionSelectAll');
  assert.equal(await page.locator('#acceptHtmlCopyScopeButton').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#htmlCopyScopeModal').isHidden(), true);
  // The preview action opens the same scope chooser and restores focus on close.
  await page.click('#previewButton');
  await page.click('#modalCopyVisualButton');
  assert.equal(await page.locator('#htmlCopyScopeModal').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#previewModal').isVisible(), true);
  assert.equal(await page.locator('#modalCopyVisualButton').evaluate(n => n === document.activeElement), true);
  await page.click('#closePreviewButton');
  // Original row numbers survive both filters in every numbering mode.
  for (const mode of ['section', 'continuous', 'hierarchical', 'manual']) {
    await page.evaluate(mode => { draft.numberingMode = mode; render(); }, mode);
    await open();
    await page.uncheck('#htmlCopyStatusSelectAll');
    await page.check('#htmlCopyStatusList input[value="НЕ ОК"]');
    await page.uncheck('#htmlCopySectionList input[value="first"]');
    await page.click('#acceptHtmlCopyScopeButton');
    await page.waitForFunction(() => document.getElementById('acceptHtmlCopyScopeButton').textContent === 'Скопировано в буфер обмена');
    assert.deepEqual((await readClipboard()).numbers, { section: ['1.'], continuous: ['3.'], hierarchical: ['2.1'], manual: ['12.3'] }[mode]);
    await page.click('#closeHtmlCopyScopeButton');
  }
  // Clipboard fallback reports success only when the browser actually accepts the copy.
  await open();
  await page.evaluate(() => {
    window.realClipboardWrite = navigator.clipboard.write.bind(navigator.clipboard);
    window.realExecCommand = document.execCommand.bind(document);
    navigator.clipboard.write = async () => { throw Error('Denied'); };
    document.execCommand = action => { window.fallbackHtml = document.activeElement.value; return action === 'copy'; };
  });
  await page.click('#acceptHtmlCopyScopeButton');
  await page.waitForFunction(() => document.getElementById('acceptHtmlCopyScopeButton').textContent === 'Скопировано в буфер обмена');
  assert.match(await page.evaluate(() => window.fallbackHtml), /<table/);
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.click('#acceptHtmlCopyScopeButton');
  await page.waitForSelector('#htmlCopyScopeFeedback:not([hidden])');
  assert.match(await page.locator('#htmlCopyScopeFeedback').textContent(), /Не удалось скопировать/);
  assert.equal(await page.locator('#acceptHtmlCopyScopeButton').textContent(), 'Копировать HTML');
  assert.equal(await page.locator('#htmlCopyScopeModal').isVisible(), true);
  await page.evaluate(() => { navigator.clipboard.write = window.realClipboardWrite; document.execCommand = window.realExecCommand; });
  // Closing during a pending clipboard write cannot update a newly opened chooser.
  await page.evaluate(() => { navigator.clipboard.write = () => new Promise(resolve => { window.finishClipboard = resolve; }); });
  await page.click('#acceptHtmlCopyScopeButton');
  assert.equal(await page.locator('#acceptHtmlCopyScopeButton').isDisabled(), true);
  await page.click('#closeHtmlCopyScopeButton');
  await open();
  await page.evaluate(() => { window.finishClipboard(); navigator.clipboard.write = window.realClipboardWrite; });
  assert.equal(await page.locator('#acceptHtmlCopyScopeButton').textContent(), 'Копировать HTML');
  await page.keyboard.press('Escape');
  // The exit remains in the upper right corner when actions wrap.
  await page.click('#selectionToggle');
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const rect = await page.evaluate(() => {
      const toolbar = document.getElementById('selectionToolbar').getBoundingClientRect();
      const exit = document.getElementById('selectionExit').getBoundingClientRect();
      return { topGap: exit.top - toolbar.top, rightGap: toolbar.right - exit.right, exitRight: exit.right };
    });
    assert.ok(rect.topGap >= 6 && rect.topGap <= 9);
    assert.ok(rect.rightGap >= 6 && rect.rightGap <= 10);
    assert.ok(rect.exitRight <= width);
  }
  await page.click('#selectionExit');
  assert.equal(await page.locator('#selectionToolbar').isHidden(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), htmlScope: true, nativeClipboard: true, allNumberingModes: true, fallback: true, failure: true, staysOpen: true, responsiveExit: true, screenshots: temp }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); child?.kill();
});
