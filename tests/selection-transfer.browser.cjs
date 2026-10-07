// Copy/move between sections regression with isolated history and synthetic attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-selection-transfer-'));
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
  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    window.resetTransferFixture = async () => {
      applyDraftLocally({ ...draft, numberingMode: 'manual', sectionNumberingMode: 'manual', intro: '<p>Intro</p>', sections: [
        { id: 'first', title: 'Исходный', manualNumber: '4', collapsed: false, columns: [{ id: 'check', title: 'Проверка' }, { id: 'steps', title: 'Шаги' }], rows: [
          { id: 'one', status: 'OK', manualNumber: '7', cells: { check: '<p>Первый</p>', steps: '<p>Шаги</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">' } },
          { id: 'two', status: 'НЕ ОК', manualNumber: '9', cells: { check: 'Второй', steps: '' } },
        ] },
        { id: 'second', title: 'Другой', manualNumber: '8', collapsed: false, columns: [{ id: 'extra', title: 'Детали' }], rows: [
          { id: 'three', status: 'НЕ ПРОВЕРЕНО', manualNumber: '12', cells: { extra: '<a href="https://example.test/file">Файл</a>' } },
        ] },
        { id: 'target', title: 'Назначение', manualNumber: '10', collapsed: true, columns: [{ id: 'text', title: 'Проверка' }], rows: [
          { id: 'existing', status: 'НЕ ОК', manualNumber: '1', cells: { text: 'Уже здесь' } },
        ] },
      ] });
      await saveDraft();
      setSelectionMode(true);
      selectedRowIds = new Set(['one', 'three']);
      updateSelectionUi();
      window.beforeTransfer = serializeDraft();
      window.sourceSections = JSON.stringify(draft.sections.slice(0, 2));
    };
    await window.resetTransferFixture();
  });
  const open = () => page.click('#selectionMoveButton');
  const chooseTarget = () => page.locator('#selectionDestinations button').filter({ hasText: 'Назначение' }).click();
  const confirm = () => page.click('#acceptConfirmButton');
  await open();
  assert.equal(await page.locator('[name="selectionTransferAction"][value="copy"]').isChecked(), true);
  assert.match(await page.locator('#selectionTransferHint').textContent(), /останутся/);
  await page.fill('#selectionSearch', 'назнач');
  assert.equal(await page.locator('#selectionDestinations button').count(), 1);
  await chooseTarget();
  assert.match(await page.locator('#confirmModalMessage').textContent(), /Скопировать 2 строки/);
  await page.click('#cancelConfirmButton');
  assert.equal(await page.evaluate(() => serializeDraft() === window.beforeTransfer && selectedRowIds.size === 2), true);
  await open();
  await page.check('[name="selectionTransferAction"][value="move"]');
  assert.match(await page.locator('#selectionTransferHint').textContent(), /удалены/);
  assert.equal(await page.locator('#selectionCreateSubmit').textContent(), 'Перенести в новый раздел');
  await page.check('[name="selectionTransferAction"][value="copy"]');
  await chooseTarget();
  await confirm();
  await page.waitForFunction(() => draft.sections[2].rows.length === 3);
  const copy = await page.evaluate(() => {
    if (JSON.stringify(draft.sections.slice(0, 2)) !== window.sourceSections) throw Error('Source changed');
    if (selectedRowIds.size !== 2) throw Error('Source selection lost');
    window.afterTransfer = serializeDraft();
    return draft.sections[2];
  });
  assert.equal(copy.manualNumber, '10');
  assert.deepEqual(copy.rows.map(r => r.manualNumber), ['1', '7', '12']);
  assert.deepEqual(copy.rows.map(r => r.status), ['НЕ ОК', 'OK', 'НЕ ПРОВЕРЕНО']);
  assert.match(copy.rows[1].cells.steps, /data:image/);
  assert.match(copy.rows[2].cells.extra, /https:\/\/example.test\/file/);
  assert.equal(new Set(copy.rows.map(r => r.id)).size, 3);
  assert.ok(copy.rows.slice(1).every(r => !['one', 'three'].includes(r.id)));
  await page.click('#undoButton');
  assert.equal(await page.evaluate(() => serializeDraft() === window.beforeTransfer), true);
  await page.click('#redoButton');
  assert.equal(await page.evaluate(() => serializeDraft() === window.afterTransfer), true);

  // Copies can be made in the source section itself and never duplicate appended rows again.
  await page.evaluate(() => window.resetTransferFixture());
  await open();
  await page.locator('#selectionDestinations button').filter({ hasText: 'Исходный' }).click();
  await confirm();
  await page.waitForFunction(() => draft.sections[0].rows.length === 4);
  assert.deepEqual(await page.evaluate(() => draft.sections[0].rows.map(r => r.manualNumber)), ['7', '9', '7', '12']);
  assert.equal(await page.evaluate(() => draft.sections[1].rows[0].id), 'three');

  // The creation form reuses the chosen action, search text and confirmation/cancel behavior.
  await page.evaluate(() => window.resetTransferFixture());
  await open();
  await page.fill('#selectionSearch', 'Регресс копия');
  assert.equal(await page.locator('#selectionDestinations button').count(), 0);
  await page.click('#selectionNewSection');
  assert.equal(await page.locator('#selectionNewTitle').inputValue(), 'Регресс копия');
  await page.click('#selectionNewSection');
  await page.click('#selectionNewSection');
  assert.equal(await page.locator('#selectionNewTitle').inputValue(), 'Регресс копия');
  await page.click('#selectionCreateSubmit');
  await page.click('#cancelConfirmButton');
  assert.equal(await page.evaluate(() => serializeDraft() === window.beforeTransfer), true);
  await open();
  await page.click('#selectionNewSection');
  await page.fill('#selectionNewTitle', 'Регресс копия');
  await page.click('#selectionCreateSubmit');
  await confirm();
  await page.waitForFunction(() => draft.sections.length === 4);
  assert.equal(await page.evaluate(() => JSON.stringify(draft.sections.slice(0, 2)) === window.sourceSections), true);
  assert.deepEqual(await page.evaluate(() => draft.sections[3].rows.map(r => r.manualNumber)), ['7', '12']);
  await page.click('#undoButton');
  assert.equal(await page.evaluate(() => draft.sections.length), 3);
  await page.click('#redoButton');
  assert.equal(await page.evaluate(() => draft.sections[3].title), 'Регресс копия');

  // Move preserves IDs and leaves a fresh blank row in emptied sections.
  await page.evaluate(() => window.resetTransferFixture());
  await open();
  await page.check('[name="selectionTransferAction"][value="move"]');
  await chooseTarget();
  assert.equal(await page.locator('#acceptConfirmButton').textContent(), 'Перенести');
  await confirm();
  await page.waitForFunction(() => draft.sections[2].rows.length === 3);
  assert.deepEqual(await page.evaluate(() => draft.sections[2].rows.map(r => r.id)), ['existing', 'one', 'three']);
  assert.deepEqual(await page.evaluate(() => draft.sections[0].rows.map(r => r.id)), ['two']);
  assert.equal(await page.evaluate(() => draft.sections[1].rows[0].cells.extra), '');
  assert.equal(await page.evaluate(() => selectedRowIds.size), 0);
  await page.click('#undoButton');
  assert.equal(await page.evaluate(() => serializeDraft() === window.beforeTransfer), true);
  await page.check('[data-selection-row="one"]');
  await open();
  assert.equal(await page.locator('[name="selectionTransferAction"][value="copy"]').isChecked(), true);
  await page.evaluate(() => closeSelectionMenus());

  await page.evaluate(() => window.resetTransferFixture());
  await open();
  await page.check('[name="selectionTransferAction"][value="move"]');
  await page.click('#selectionNewSection');
  await page.fill('#selectionNewTitle', 'Перенесённые');
  await page.click('#selectionCreateSubmit');
  await confirm();
  await page.waitForFunction(() => draft.sections.length === 4);
  assert.deepEqual(await page.evaluate(() => draft.sections[3].rows.map(r => r.id)), ['one', 'three']);

  // Sorting only prevents moving; copying stays available and does not alter source order.
  await page.evaluate(async () => {
    await window.resetTransferFixture();
    draft.sections[0].statusSort = true; draft.sections[2].statusSort = true;
    renderSections();
  });
  await open();
  assert.equal(await page.locator('#selectionDestinations button').filter({ hasText: 'Назначение' }).isDisabled(), false);
  await page.check('[name="selectionTransferAction"][value="move"]');
  assert.equal(await page.locator('#selectionCreateSubmit').isDisabled(), true);
  assert.equal(await page.locator('#selectionDestinations button').filter({ hasText: 'Назначение' }).isDisabled(), true);
  await page.check('[name="selectionTransferAction"][value="copy"]');
  await chooseTarget(); await confirm();
  await page.waitForFunction(() => draft.sections[2].rows.length === 3);
  assert.deepEqual(await page.evaluate(() => draft.sections[0].rows.map(r => r.id)), ['one', 'two']);

  // Both menu modes and the creation form fit on a narrow viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.click('#selectionNewSection');
  await page.fill('#selectionNewTitle', 'Новый раздел');
  await page.waitForFunction(() => {
    const r = selectionUi.MoveMenu.getBoundingClientRect();
    return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
  });
  assert.ok(await page.locator('#selectionCreateSubmit').evaluate(n => {
    const r = n.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }));
  await page.screenshot({ path: path.join(temp, 'transfer-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(temp, 'transfer-desktop.png') });
  await page.evaluate(async () => { await saveDraft(); });
  await page.reload();
  await page.waitForFunction(() => draft.sections[2]?.rows.length === 3);
  assert.deepEqual(await page.evaluate(() => draft.sections.map(s => s.rows.length)), [2, 1, 3]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), copy: true, sameSection: true, newSection: true, move: true, undoRedo: true, reload: true, sorting: true, mobile: true, screenshots: temp }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); child?.kill();
});
