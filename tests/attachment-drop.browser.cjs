// Native file drag regression: isolated database and synthetic local attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-attachment-drop-'));

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
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/health' || /\/attachment-manifest$/.test(url.pathname)) {
      return route.fulfill({ json: { ok: true, attachmentLimits: {
        appMaxFileBytes: 50 * 1024 * 1024, requestMaxBytes: 150 * 1024 * 1024,
        jiraEnabled: true, jiraUploadLimit: null,
      } } });
    }
    return route.continue();
  });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  await page.waitForFunction(() => localAttachmentLimitCache && !localAttachmentLimitCache.pending);
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    applyDraftLocally({ ...draft, title: 'Перетаскивание файлов', intro: '<p>Вводный текст</p>', sections: [{
      id: 'drop-section', title: 'Вложения',
      columns: Array.from({ length: 6 }, (_, i) => ({ id: `col-${i}`, title: `Колонка ${i + 1}`, width: 320 })),
      rows: [0, 1].map(i => ({ id: `row-${i}`, status: 'НЕ ПРОВЕРЕНО', cells: Object.fromEntries(
        Array.from({ length: 6 }, (_, j) => [`col-${j}`, `<p>Текст ${i + 1}:${j + 1}</p>`])
      ) })),
    }] });
    historyCurrent = serializeDraft(); undoStack = []; redoStack = [];
  });
  const editor = (row, col) => page.locator(`tr[data-row-id="row-${row}"] .cell-editor[data-column-id="col-${col}"]`);
  const scroll = page.locator('.table-scroll').first();
  const shot = path.join(temp, 'shot.png');
  const log = path.join(temp, 'drop.txt');
  fs.writeFileSync(shot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(log, 'drop text');
  const cdp = await context.newCDPSession(page);
  const data = { items: [], files: [shot, log], dragOperationsMask: 1 };
  const drag = async (type, x, y, value = data) => { await cdp.send('Input.dispatchDragEvent', { type, x, y, data: value }); if (type === 'dragOver') await cdp.send('Input.dispatchDragEvent', { type, x, y, data: value }); };
  const point = async locator => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  // Keep a selection in another cell: dropping must not replace it or paste there.
  await editor(0, 0).evaluate(el => {
    el.focus(); const range = document.createRange(); range.selectNodeContents(el);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const destination = await point(editor(1, 1));
  await drag('dragEnter', destination.x, destination.y);
  await drag('dragOver', destination.x, destination.y);
  assert.equal(await editor(1, 1).locator('..').evaluate(el => el.classList.contains('attachment-drop-target')), true);
  await drag('drop', destination.x, destination.y);
  await editor(1, 1).locator('.cell-file').waitFor();
  assert.equal(await editor(1, 1).locator('.cell-image').count(), 1);
  assert.equal(await editor(0, 0).innerText(), 'Текст 1:1');
  assert.match(await editor(1, 1).innerText(), /Текст 2:2/);
  assert.equal(await editor(1, 1).locator('.cell-file').getAttribute('data-data-url'), 'data:text/plain;base64,ZHJvcCB0ZXh0');
  assert.equal(await page.locator('.attachment-drop-target').count(), 0);
  await page.waitForFunction(async () => {
    const record = await getReportRecord(draft.reportId);
    return record && JSON.stringify(record.document).includes('drop.txt') && historyCurrent.includes('drop.txt');
  });
  await page.evaluate(() => undo());
  assert.equal(await page.locator('.cell-editor .cell-file').count(), 0);
  await page.evaluate(() => redo());
  assert.equal(await page.locator('.cell-editor .cell-file').count(), 1);

  // Drop over an existing noneditable attachment: the new card stays beside it.
  const cardPoint = await point(editor(1, 1).locator('.cell-file'));
  await drag('dragEnter', cardPoint.x, cardPoint.y, { ...data, files: [log] });
  await drag('dragOver', cardPoint.x, cardPoint.y, { ...data, files: [log] });
  await drag('drop', cardPoint.x, cardPoint.y, { ...data, files: [log] });
  await page.waitForFunction(() => document.querySelectorAll('tr[data-row-id="row-1"] [data-column-id="col-1"].cell-editor > .cell-file').length === 2);
  assert.equal(await page.locator('.cell-file .cell-file').count(), 0);

  // A stationary native file drag continues scrolling and synchronizes the header.
  await scroll.evaluate(el => { el.scrollLeft = 0; });
  const rect = await scroll.boundingBox();
  const edgeY = Math.min(rect.y + 24, 850);
  const right = rect.x + rect.width - 6;
  const left = rect.x + 6;
  await drag('dragEnter', right, edgeY);
  await drag('dragOver', right, edgeY);
  await page.waitForFunction(() => document.querySelector('.table-scroll').scrollLeft > 60);
  const moving = await scroll.evaluate(el => el.scrollLeft);
  await page.waitForTimeout(200);
  assert.ok(await scroll.evaluate(el => el.scrollLeft) > moving + 10, 'scroll continues without more dragover events');
  const positions = await page.evaluate(() => ({ body: document.querySelector('.table-scroll').scrollLeft, header: document.querySelector('.section-header-scroll').scrollLeft }));
  assert.ok(Math.abs(positions.body - positions.header) < 5, 'header follows body scrolling');
  assert.ok(positions.body - moving < 100, 'browser native autoscroll must not accelerate the slow scroll');
  await drag('dragOver', rect.x + rect.width / 2, edgeY);
  await page.waitForFunction(() => !attachmentDragScroll);
  const centered = await scroll.evaluate(el => el.scrollLeft);
  await page.waitForTimeout(160);
  assert.equal(await scroll.evaluate(el => el.scrollLeft), centered, 'center stops scrolling');
  await drag('dragOver', left, edgeY);
  await page.waitForFunction(start => document.querySelector('.table-scroll').scrollLeft < start - 25, centered);
  await drag('dragCancel', left, edgeY);
  // CDP cancels its native drag session without emitting the OS window-leave event.
  await page.dispatchEvent('body', 'dragleave', { relatedTarget: null });
  await page.waitForFunction(() => !attachmentDragScroll);
  const cancelled = await scroll.evaluate(el => el.scrollLeft);
  await page.waitForTimeout(160);
  assert.equal(await scroll.evaluate(el => el.scrollLeft), cancelled, 'leaving the window stops scrolling');
  assert.equal(await page.locator('.attachment-drop-target').count(), 0);
  assert.equal(await scroll.evaluate(el => el.classList.contains('attachment-drag-active')), false);

  // Reach a hidden column by scrolling, then drop into that column.
  await drag('dragEnter', right, edgeY, { ...data, files: [log] });
  await drag('dragOver', right, edgeY, { ...data, files: [log] });
  await page.waitForFunction(() => {
    const scroll = document.querySelector('.table-scroll');
    const cell = document.querySelector('tr[data-row-id="row-0"] .cell-editor[data-column-id="col-4"]').getBoundingClientRect();
    return cell.left > scroll.getBoundingClientRect().left + 50 && cell.right < scroll.getBoundingClientRect().right - 180;
  }, null, { timeout: 10000 });
  const hiddenPoint = await point(editor(0, 4));
  await drag('dragOver', hiddenPoint.x, hiddenPoint.y, { ...data, files: [log] });
  await drag('drop', hiddenPoint.x, hiddenPoint.y, { ...data, files: [log] });
  await editor(0, 4).locator('.cell-file').waitFor();
  const droppedLeft = await scroll.evaluate(el => el.scrollLeft);
  await page.waitForTimeout(160);
  assert.equal(await scroll.evaluate(el => el.scrollLeft), droppedLeft, 'drop stops scrolling');

  // Invalid service cells must not insert into the previously focused cell.
  const countBefore = await page.locator('.cell-file').count();
  const status = await point(page.locator('tr[data-row-id="row-0"] .status-cell'));
  await drag('dragEnter', status.x, status.y, { ...data, files: [log] });
  await drag('dragOver', status.x, status.y, { ...data, files: [log] });
  await drag('drop', status.x, status.y, { ...data, files: [log] });
  assert.equal(await page.locator('.cell-file').count(), countBefore);
  assert.ok(new URL(page.url()).origin === origin, 'invalid drop must not navigate to the file');

  // Intro, cell padding, known limits and non-file drags keep their existing behavior.
  await page.locator('#introEditor').scrollIntoViewIfNeeded();
  const introPoint = await point(page.locator('#introEditor'));
  await drag('dragEnter', introPoint.x, introPoint.y, { ...data, files: [log] });
  await drag('dragOver', introPoint.x, introPoint.y, { ...data, files: [log] });
  await drag('drop', introPoint.x, introPoint.y, { ...data, files: [log] });
  await page.locator('#introEditor .cell-file').waitFor();
  assert.match(await page.locator('#introEditor').innerText(), /Вводный текст/);
  await scroll.evaluate(el => { el.scrollLeft = 0; });
  await editor(0, 1).evaluate(el => {
    const td = el.closest('td'); td.style.height = '220px'; el.style.height = '58px';
  });
  const padding = await editor(0, 1).locator('..').boundingBox();
  await drag('dragEnter', padding.x + 20, padding.y + padding.height - 12, { ...data, files: [log] });
  await drag('dragOver', padding.x + 20, padding.y + padding.height - 12, { ...data, files: [log] });
  await drag('drop', padding.x + 20, padding.y + padding.height - 12, { ...data, files: [log] });
  await editor(0, 1).locator('.cell-file').waitFor();
  assert.match(await editor(0, 1).innerText(), /Текст 1:2/);
  await page.evaluate(() => { localAttachmentLimitCache.limits.appMaxFileBytes = 1; });
  const limitPoint = await point(editor(0, 1));
  await drag('dragEnter', limitPoint.x, limitPoint.y, { ...data, files: [log] });
  await drag('dragOver', limitPoint.x, limitPoint.y, { ...data, files: [log] });
  await drag('drop', limitPoint.x, limitPoint.y, { ...data, files: [log] });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('лимит'));
  assert.equal(await editor(0, 1).locator('.cell-file').count(), 1);
  await editor(0, 1).evaluate(el => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData('text/plain', 'обычный текст');
    const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    el.dispatchEvent(event);
  });
  assert.equal(await page.evaluate(() => attachmentDragScroll), null, 'plain text drag must not start file scrolling');
  assert.equal(await page.locator('.attachment-drop-target').count(), 0);
  await page.waitForFunction(async () => {
    const record = await getReportRecord(draft.reportId);
    return record?.document?.sections?.[0]?.rows?.[0]?.cells?.['col-4']?.includes('drop.txt');
  });
  await page.reload();
  await editor(0, 4).locator('.cell-file').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.cell-file').count(), 5);
  assert.equal(await page.locator('.cell-image').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: native OS file drops, mixed attachments, target/selection, nested cards, padding, horizontal edges, stationary scrolling, header sync, cancellation, hidden column, invalid target, intro, limits, undo/redo and reload');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
