// Copy selection regression with isolated history and synthetic attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-selection-copy-'));
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
    applyDraftLocally({ ...draft, numberingMode: 'manual', sectionNumberingMode: 'manual', intro: '<p>Intro</p>', sections: [
      { id: 'first', title: 'First', manualNumber: '4', collapsed: false, columns: [{ id: 'check', title: 'Check' }], rows: [
        { id: 'one', status: 'OK', manualNumber: '7', cells: { check: 'One' } },
        { id: 'two', status: 'НЕ ОК', manualNumber: '9', cells: { check: 'Two' } },
      ] },
      { id: 'second', title: 'Second', manualNumber: '8', collapsed: true, columns: [{ id: 'extra', title: 'Details' }], rows: [
        { id: 'three', status: 'НЕ ПРОВЕРЕНО', manualNumber: '12', cells: { extra: '<p>Three</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">' } },
      ] },
    ] });
    await saveDraft();
    window.originalId = draft.reportId;
    window.originalPublicId = draft.publicId;
    window.originalDocument = JSON.stringify(draftContentSnapshot());
  });
  await page.click('#selectionToggle');
  assert.equal(await page.locator('#selectionCopyButton').isDisabled(), true);
  await page.check('#selectionAll');
  await page.uncheck('[data-selection-row="two"]');
  const originalUrl = page.url();
  const historyBeforeCancel = await page.evaluate(async () => (await getAllReports()).length);
  await page.click('#selectionCopyButton');
  await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.QA_REPORT_COPY_SCREENSHOTS) await page.screenshot({ path: path.join(temp, 'numbering-mobile.png') });
  assert.ok(await page.locator('#selectionCopyOptionsModal .modal-footer button').evaluateAll(nodes => nodes.every(n => {
    const r = n.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  })));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#cancelSelectionCopyOptions');
  await page.waitForFunction(() => !selectionCopyBusy);
  assert.equal(await page.evaluate(async () => (await getAllReports()).length), historyBeforeCancel);
  assert.equal(await page.evaluate(() => selectedRowIds.size), 2);

  if (process.env.QA_REPORT_COPY_SCREENSHOTS) {
    await page.screenshot({ path: path.join(temp, 'copy-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(temp, 'copy-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log(`Screenshots: ${temp}`);
  }
  await page.click('#selectionCopyButton');
  await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
  await page.click('#acceptSelectionCopyOptions');
  await page.waitForFunction(() => elements.confirmModalTitle.textContent === 'Новый чек-лист создан' && !elements.confirmModal.hidden);
  assert.match(await page.locator('#confirmModalMessage').textContent(), /Скопировано пунктов: 2/);
  await page.click('#cancelConfirmButton');
  assert.equal(page.url(), originalUrl);
  await page.waitForFunction(() => !selectionCopyBusy);
  const copies = await page.evaluate(async () => {
    const records = await getAllReports();
    const source = records.find(r => r.id === window.originalId);
    const copy = records.find(r => r.reason === 'selection-copy');
    if (JSON.stringify(draftContentSnapshot()) !== window.originalDocument) throw Error('Source changed');
    if (source.document.sections[0].rows.length !== 2) throw Error('Source rows lost');
    if (!selectedRowIds.has('one') || !selectedRowIds.has('three')) throw Error('Selection lost');
    window.firstCopyId = copy.id;
    return { sections: copy.document.sections, publicId: copy.publicId, numbering: copy.document.numberingMode };
  });
  assert.equal(copies.numbering, 'manual');
  assert.deepEqual(copies.sections.map(s => s.manualNumber), ['4', '8']);
  assert.deepEqual(copies.sections.map(s => s.rows.length), [1, 1]);
  assert.equal(copies.sections[0].rows[0].manualNumber, '7');
  assert.match(copies.sections[1].rows[0].cells.extra, /data:image/);
  assert.equal(copies.sections[1].collapsed, false);
  await page.click('#selectionCopyButton');
  await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
  await page.click('#acceptSelectionCopyOptions');
  await page.waitForFunction(() => elements.confirmModalTitle.textContent === 'Новый чек-лист создан' && !elements.confirmModal.hidden);
  await page.click('#acceptConfirmButton');
  await page.waitForFunction(() => !selectionCopyBusy && draft.reportId !== window.originalId);
  assert.notEqual(page.url(), originalUrl);
  assert.equal(await page.locator('tr[data-row-id]').count(), 2);
  const newUrl = page.url();
  await page.reload();
  await page.waitForFunction(() => draft.sections.length === 2 && draft.sections[0].rows.length === 1);
  assert.equal(page.url(), newUrl);
  await page.goto(originalUrl);
  await page.waitForFunction(() => draft.sections[0].rows.length === 2);
  // Storage failure keeps the source open and never offers an unusable copy.
  await page.click('#selectionToggle');
  await page.check('[data-selection-row="one"]');
  await page.evaluate(() => {
    window.realOpenDatabase = openDatabase;
    openDatabase = async () => { throw Error('Test storage failure'); };
  });
  await page.click('#selectionCopyButton');
  await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
  await page.click('#acceptSelectionCopyOptions');
  await page.waitForFunction(() => !selectionCopyBusy);
  assert.equal(page.url(), originalUrl);
  assert.equal(await page.locator('#confirmModal').isHidden(), true);
  await page.evaluate(() => { openDatabase = window.realOpenDatabase; });
  // Verify the transaction itself rolls back the source write if adding the copy fails.
  await page.evaluate(async () => {
    const before = clone(draft);
    const stored = await getReportRecord(before.reportId);
    const changed = { ...before, intro: 'Must roll back' };
    try { await saveSelectionCopy(changed, before); throw Error('Expected duplicate failure'); }
    catch (error) { if (error.message === 'Expected duplicate failure') throw error; }
    const after = await getReportRecord(before.reportId);
    if (after.document.intro !== stored.document.intro) throw Error('Partial history transaction');
  });
  // A changed source is never replaced by the asynchronously created copy.
  await page.evaluate(async () => {
    const realSave = saveSelectionCopy;
    saveSelectionCopy = async (...args) => {
      await realSave(...args);
      elements.introEditor.innerHTML = '<p>Concurrent edit</p>';
    };
    const count = (await getAllReports()).length;
    const first = copySelectedRowsToNewChecklist();
    await copySelectedRowsToNewChecklist(); // Duplicate click while busy is a no-op.
    resolveSelectionCopyOptions(true);
    await first;
    saveSelectionCopy = realSave;
    if (draft.intro !== '<p>Concurrent edit</p>') throw Error('Concurrent edit lost');
    if ((await getAllReports()).length !== count + 1) throw Error('Duplicate copy');
  });
  assert.equal(page.url(), originalUrl);
  assert.equal(await page.locator('#confirmModal').isHidden(), true);
  // Exercise both numbering choices in all modes, around omitted sections and rows.
  for (const mode of ['section', 'continuous', 'hierarchical', 'manual']) {
    for (const preserve of [true, false]) {
      const expected = await page.evaluate(async ({ mode }) => {
        applyDraftLocally({ ...draft, numberingMode: mode, sectionNumberingMode: 'automatic', intro: '', sections: [
          { id: 'omitted', title: 'Omitted', columns: [{ id: 'text', title: 'Check' }], rows: [
            { id: 'ignore', status: 'OK', cells: { text: 'Ignore' } },
          ] },
          { id: 'second', title: 'Second', columns: [{ id: 'text', title: 'Check' }], rows: [
            { id: 'skip', status: 'OK', cells: { text: 'Skip' } },
            { id: 'pick', status: 'НЕ ОК', manualNumber: '9.3', cells: { text: 'Pick' } },
          ] },
          { id: 'third', title: 'Third', columns: [{ id: 'text', title: 'Check' }], rows: [
            { id: 'last', status: 'НЕ ПРОВЕРЕНО', manualNumber: '', cells: { text: 'Last' } },
          ] },
        ] });
        await saveDraft();
        if (!selectionMode) setSelectionMode(true);
        selectedRowIds = new Set(['pick', 'last']);
        updateSelectionUi();
        const numbers = ChecklistNumbering.rowNumbers(draft);
        window.numberingSource = JSON.stringify(draftContentSnapshot());
        window.historyBeforeNumbering = new Set((await getAllReports()).map(r => r.id));
        return [numbers.get('pick'), numbers.get('last')];
      }, { mode });
      await page.click('#selectionCopyButton');
      await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
      await page.locator('#selectionCopyPreserveRowNumbers').setChecked(preserve);
      await page.locator('#selectionCopyPreserveSectionNumbers').setChecked(preserve);
      await page.click('#acceptSelectionCopyOptions');
      await page.waitForFunction(() => elements.confirmModalTitle.textContent === 'Новый чек-лист создан' && !elements.confirmModal.hidden);
      await page.click('#cancelConfirmButton');
      await page.waitForFunction(() => !selectionCopyBusy);
      const actual = await page.evaluate(async () => {
        if (JSON.stringify(draftContentSnapshot()) !== window.numberingSource) throw Error('Numbering choice mutated source');
        const copy = (await getAllReports()).find(r => !window.historyBeforeNumbering.has(r.id));
        return { mode: copy.document.numberingMode, labels: [...ChecklistNumbering.rowNumbers(copy.document).values()] };
      });
      assert.equal(actual.mode, preserve ? 'manual' : mode === 'manual' ? 'section' : mode);
      assert.deepEqual(actual.labels, preserve ? expected : {
        section: ['1.', '1.'], continuous: ['1.', '2.'], hierarchical: ['1.1', '2.1'], manual: ['1.', '1.'],
      }[mode]);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), copied: 2, stay: true, open: true, reload: true, sourceHistory: true, storageFailure: true, rollback: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); child?.kill();
});
