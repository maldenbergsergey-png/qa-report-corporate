// Real-browser link editing/navigation regression with an isolated database.
// Run with QA_REPORT_PLAYWRIGHT pointing at an existing Playwright installation.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-editor-links-'));
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
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'docs.example') return route.fulfill({ contentType: 'text/html', body: '<h1>Local link fixture</h1>' });
    return url.origin === origin ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#linkButton');
  const fixture = () => page.evaluate(() => {
    cloudHistoryEnabled = false;
    applyDraftLocally({ ...draft, title: 'Ссылки в чек-листе', intro: '<p>Материалы: <a href="https://docs.example/intro">Документация</a></p>', sections: [{
      id: 'links-section', title: 'Выдача результатов: сообщения',
      columns: [{ id: 'check', title: 'Проверка', width: 320 }, { id: 'comment', title: 'Комментарий', width: 440 }],
      rows: [{ id: 'links-row', status: 'НЕ ОК', cells: {
        check: 'Проверить сообщение пользователя и ответ ассистента',
        comment: '<p>До <a href="https://docs.example/design"><strong>Макет выдачи результатов</strong></a> после; <a href="https://docs.example/spec">Описание</a></p>',
      } }],
    }] });
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  });
  const editorSelector = 'tr[data-row-id="links-row"] .cell-editor[data-column-id="comment"]';
  const editor = page.locator(editorSelector);
  const link = editor.locator('a').first();
  let reportUrl;
  const noNavigation = () => {
    assert.equal(context.pages().length, 1, 'selection/copy must not open a tab');
    assert.equal(page.url(), reportUrl);
  };
  await fixture();
  reportUrl = page.url();
  await link.click();
  assert.equal(await page.locator('#linkPopover').isVisible(), true);
  assert.equal(await page.locator('#linkTextInput').inputValue(), 'Макет выдачи результатов');
  assert.equal(await page.locator('#linkUrlInput').inputValue(), 'https://docs.example/design');
  noNavigation();

  // Opening is an explicit button action with no access to the editor window.
  const opened = context.waitForEvent('page');
  await page.locator('#openLinkButton').click();
  const popup = await opened;
  await popup.waitForURL('https://docs.example/design');
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.close();
  await page.locator('#linkTextInput').fill('Макет сообщений');
  await page.locator('#linkUrlInput').fill('www.docs.example/messages?view=1&size=2');
  await page.locator('#applyLinkButton').click();
  assert.equal(await link.textContent(), 'Макет сообщений');
  assert.equal(await link.getAttribute('href'), 'https://www.docs.example/messages?view=1&size=2');
  const exported = await page.evaluate(() => ({ markup: generateMarkup(), html: generatePortableHtml() }));
  assert.ok(exported.markup.includes('[Макет сообщений|https://www.docs.example/messages?view=1&size=2]'));
  assert.ok(exported.html.includes('Макет сообщений'));
  await page.waitForFunction(() => !hasUnsavedLocalChanges);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('tr[data-row-id="links-row"] a')?.textContent === 'Макет сообщений');
  // After reload the history starts afresh; exercise edit + undo/redo together.
  await fixture();
  await link.click();
  await page.locator('#linkTextInput').fill('Новое имя');
  await page.locator('#applyLinkButton').click();
  await page.evaluate(() => undo());
  assert.equal(await link.textContent(), 'Макет выдачи результатов');
  await page.evaluate(() => redo());
  assert.equal(await link.textContent(), 'Новое имя');
  await fixture();
  await link.click();
  await page.locator('#removeLinkButton').click();
  assert.equal(await editor.locator('a').count(), 1);
  assert.equal(await editor.locator('strong').textContent(), 'Макет выдачи результатов');
  await page.evaluate(() => undo());
  assert.equal(await editor.locator('a').count(), 2);

  // The toolbar finds a caret inside a link and selection of the whole anchor.
  for (const wholeLink of [false, true]) {
    await link.evaluate((anchor, whole) => {
      anchor.closest('.cell-editor').focus();
      const range = document.createRange();
      if (whole) range.selectNode(anchor);
      else { range.selectNodeContents(anchor.querySelector('strong')); range.collapse(true); }
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, wholeLink);
    await page.locator('#linkButton').click();
    assert.equal(await page.locator('#linkPopoverTitle').textContent(), 'Изменить ссылку');
    await page.locator('#linkUrlInput').press('Escape');
  }
  // A selection spanning two links creates one new link rather than renaming one.
  await editor.evaluate(node => {
    node.focus(); const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator('#linkButton').click();
  assert.equal(await page.locator('#linkPopoverTitle').textContent(), 'Добавить ссылку');
  await page.locator('#closeLinkPopoverButton').click();
  noNavigation();

  // Copy the real browser selection without changing the system clipboard.
  await link.evaluate(anchor => {
    anchor.closest('.cell-editor').focus(); const range = document.createRange(); range.selectNodeContents(anchor);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.addEventListener('copy', event => {
      window.linkCopyText = window.getSelection().toString(); event.preventDefault();
    }, { once: true });
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
  assert.equal(await page.evaluate(() => window.linkCopyText), 'Макет выдачи результатов');
  assert.equal(await page.locator('#linkPopover').isVisible(), false);
  for (const options of [{ modifiers: ['Control'] }, { modifiers: ['Meta'] }, { modifiers: ['Shift'] }, { button: 'middle' }]) {
    await link.click(options);
    assert.equal(await page.locator('#linkPopover').isVisible(), false);
    noNavigation();
  }
  await link.dblclick();
  assert.equal(await page.locator('#linkPopover').isVisible(), false);
  assert.ok(await page.evaluate(() => window.getSelection().toString().length > 0));
  noNavigation();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const box = await link.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  assert.equal(await page.locator('#linkPopover').isVisible(), false);
  noNavigation();
  await page.evaluate(() => setSelectionMode(true));
  await link.click();
  assert.equal(await page.locator('#linkPopover').isVisible(), false);
  await page.evaluate(() => setSelectionMode(false));

  // Keyboard creation also works in the introduction; invalid URLs cannot open.
  await page.locator('#introEditor a').evaluate(anchor => {
    anchor.closest('.intro-editor').focus(); const range = document.createRange(); range.selectNodeContents(anchor); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  assert.equal(await page.locator('#linkTextInput').inputValue(), 'Документация');
  for (const invalid of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/a', 'https://', 'https://bad host']) {
    await page.locator('#linkUrlInput').fill(invalid);
    assert.equal(await page.locator('#openLinkButton').isDisabled(), true);
    await page.locator('#applyLinkButton').click();
    assert.equal(await page.locator('#linkPopoverError').isVisible(), true);
    noNavigation();
  }
  await page.locator('#linkUrlInput').fill('https://docs.example/intro');
  await page.locator('#closeLinkPopoverButton').click();

  // Name a new link from selected text, escape its title and retain surrounding text.
  await editor.evaluate(node => {
    node.innerHTML = '<p>До Новый материал после</p>';
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.focus(); const text = node.firstChild.firstChild;
    const range = document.createRange(); range.setStart(text, 3); range.setEnd(text, 17);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator('#linkButton').click();
  assert.equal(await page.locator('#linkTextInput').inputValue(), 'Новый материал');
  await page.locator('#linkTextInput').fill('Материал <script>');
  await page.locator('#linkUrlInput').fill('https://docs.example/new');
  await page.locator('#linkUrlInput').press('Enter');
  assert.equal(await editor.locator('a').textContent(), 'Материал <script>');
  assert.equal(await editor.locator('script').count(), 0);
  assert.equal(await editor.innerText(), 'До Материал <script> после');
  noNavigation();
  await fixture();

  // The popover fits every theme and a narrow viewport, including near the bottom.
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  for (const theme of ['light', 'dark', 'graphite']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.getSelection().removeAllRanges(); }, theme);
    await link.click();
    const bounds = await page.locator('#linkPopover').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 1000);
    assert.ok(bounds.width <= 300 && bounds.height <= 240, 'compact link popover');
    for (const [id, label] of [['openLinkButton', 'Открыть в новой вкладке'], ['removeLinkButton', 'Удалить ссылку, оставить текст'], ['applyLinkButton', 'Применить изменения']]) {
      const button = page.locator('#' + id);
      assert.equal(await button.getAttribute('aria-label'), label);
      assert.ok(await button.getAttribute('title'));
      assert.equal(await button.locator('svg').count(), 1);
      assert.equal((await button.textContent()).trim(), '');
      const size = await button.boundingBox();
      assert.ok(size.width >= 24 && size.width <= 36 && size.height >= 24 && size.height <= 36);
    }
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `${theme}.png`) });
    await page.locator('#closeLinkPopoverButton').click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#introEditor a').click();
  const narrow = await page.locator('#linkPopover').boundingBox();
  assert.ok(narrow.x >= 0 && narrow.y >= 0 && narrow.x + narrow.width <= 390 && narrow.y + narrow.height <= 844);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'mobile.png') });
  assert.deepEqual(errors, []);
  console.log('Passed: explicit opening, editing, persistence, exports, undo/redo, copy/selection protection, keyboard, URL validation, themes and narrow layout.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
