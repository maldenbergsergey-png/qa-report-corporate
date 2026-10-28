// Checklist status-filter regression with isolated history and synthetic attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-status-filter-'));
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

  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    applyDraftLocally({ ...draft, draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), numberingMode: 'hierarchical', environment: 'STAGE', overallStatus: 'OK', intro: '<p>Full intro</p>', sections: [
      { id: 'first', title: 'First', statusSort: true, columns: [{ id: 'check', title: 'Проверка' }], rows:
        Object.keys(STATUS_META).map((status, i) => ({ id: `row-${i}`, status, cells: { check: `Token-${i}` + (i === 0 ? '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5sAAAAASUVORK5CYII=">' : '') } })) },
      { id: 'second', title: 'Second', columns: [{ id: 'check', title: 'Проверка' }], rows: [
        { id: 'second-fail', status: 'НЕ ОК', cells: { check: 'SecondFailure' } },
        { id: 'blank', status: 'НЕ ПРОВЕРЕНО', cells: { check: '' } },
      ] },
      { id: 'hidden', title: 'HiddenSection', columns: [{ id: 'check', title: 'Проверка' }], rows: [
        { id: 'hidden-ok', status: 'OK', cells: { check: 'HiddenOK' } },
      ] },
    ] });
  });
  const rows = () => page.locator('#sections tr[data-row-id]').evaluateAll(nodes => nodes.map(n => n.dataset.rowId));
  const chooseFilter = async statuses => {
    if (await page.locator('#selectionToolbar').isHidden()) await page.click('#selectionToggle');
    await page.click('#selectionFilterButton');
    await page.check('#selectionFilterAll');
    await page.uncheck('#selectionFilterAll');
    for (const status of statuses) await page.check(`#selectionFilterOptions input[value="${status}"]`);
    await page.click('#selectionFilterApply');
  };
  assert.equal((await rows()).length, 10);
  assert.equal(await page.locator('#summaryTotal').textContent(), '9');
  // Pending cell edits survive removing their row from the DOM.
  await page.locator('[data-row-id="hidden-ok"] .cell-editor').fill('Hidden edited');
  await page.click('#selectionToggle');
  await page.check('#selectionAll');
  await chooseFilter(['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  assert.deepEqual(await rows(), ['row-1', 'row-4', 'second-fail']);
  assert.equal(await page.locator('#selectionCount').textContent(), 'Выбрано: 3');
  assert.equal(await page.locator('#summaryTotal').textContent(), '3');
  assert.deepEqual(await page.locator('#summaryList .summary-label').allTextContents(), ['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  assert.match(await page.locator('#reportStatusFilterSummary').textContent(), /3 из 10/);
  assert.equal(await page.locator('[data-section-id="hidden"]').count(), 0);
  assert.deepEqual(await page.locator('#sections .row-number-text').allTextContents(), ['1.2', '1.5', '2.1']);
  // Global, section and by-status selection operate only on the current view.
  await page.uncheck('#selectionAll');
  await page.check('[data-selection-section="first"]');
  assert.equal(await page.locator('#selectionCount').textContent(), 'Выбрано: 2');
  await page.click('#selectionStatusButton');
  await page.check('#selectionStatusOptions input[value="OK"]');
  await page.click('#selectionStatusApply');
  assert.equal(await page.locator('#selectionCount').textContent(), 'Выбрано: 0');
  await page.check('#selectionAll');
  assert.equal(await page.locator('#selectionCount').textContent(), 'Выбрано: 3');
  // Cancel and Escape do not apply staged options.
  await page.click('#selectionFilterButton');
  await page.check('#selectionFilterOptions input[value="OK"]');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#selectionFilterButton').evaluate(n => n === document.activeElement), true);
  assert.equal((await rows()).length, 3);
  // Exiting selection leaves a visible way to change or reset the filter.
  await page.click('#selectionExit');
  assert.equal(await page.locator('#selectionToolbar').isHidden(), true);
  assert.equal(await page.locator('#reportStatusFilterBar').isVisible(), true);
  const snapshot = await page.evaluate(async () => {
    await saveDraft();
    const saved = await getReportRecord(draft.reportId);
    return { count: saved.document.sections.flatMap(s => s.rows).length,
      hidden: saved.document.sections.find(s => s.id === 'hidden').rows[0].cells.check,
      hasAttachment: saved.document.sections[0].rows[0].cells.check.includes('<img'),
      hasFilterField: Object.hasOwn(saved.document, 'reportStatusFilter') };
  });
  assert.deepEqual(snapshot, { count: 10, hidden: 'Hidden edited', hasAttachment: true, hasFilterField: false });
  // The same statuses seed both new and linked publication; users may change them.
  await page.evaluate(() => { void askPublishScope(); });
  assert.deepEqual(await page.locator('#publishStatusList input:checked').evaluateAll(ns => ns.map(n => n.value)), ['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  assert.match(await page.locator('#publishScopeSummary').textContent(), /строк — 3/);
  assert.equal(await page.locator('#publishStatusFilterHint').isVisible(), true);
  await page.click('#closePublishScopeButton');
  await page.evaluate(() => { void askPublishScope({ statuses: ['OK'], sectionIds: ['first', 'second', 'hidden'] }); });
  assert.deepEqual(await page.locator('#publishStatusList input:checked').evaluateAll(ns => ns.map(n => n.value)), ['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  await page.check('#publishStatusList input[value="OK"]');
  assert.match(await page.locator('#publishScopeSummary').textContent(), /строк — 5/);
  await page.click('#closePublishScopeButton');
  // Native HTML copy and markup/Excel exporters exclude hidden rows and images.
  await page.click('#copyMenuButton');
  await page.click('#copyVisualButton');
  assert.deepEqual(await page.locator('#htmlCopyStatusList input:checked').evaluateAll(ns => ns.map(n => n.value)), ['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  assert.equal(await page.locator('#htmlCopyStatusFilterHint').isVisible(), true);
  await page.click('#acceptHtmlCopyScopeButton');
  await page.waitForFunction(() => document.getElementById('acceptHtmlCopyScopeButton').textContent === 'Скопировано в буфер обмена');
  const clipboard = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read(); return (await item.getType('text/html')).text();
  });
  assert.match(clipboard, /Token-1|Token-4/); assert.doesNotMatch(clipboard, /Token-0|Hidden edited|<img/);
  await page.keyboard.press('Escape');
  await page.click('#previewButton');
  assert.equal(await page.locator('#modalSaveMarkupButton').isDisabled(), true);
  assert.match(await page.locator('#markupPreview').inputValue(), /Token-1/);
  assert.doesNotMatch(await page.locator('#markupPreview').inputValue(), /Token-0|Hidden edited/);
  assert.doesNotMatch(await page.locator('#visualPreview').innerHTML(), /Token-0|Hidden edited/);
  assert.equal(await page.locator('#previewStatusFilterHint').isVisible(), true);
  await page.evaluate(() => savePreviewMarkupToDraft());
  assert.equal(await page.evaluate(() => draft.sections.flatMap(s => s.rows).length), 10);
  await page.click('#closePreviewButton');
  const excel = await page.evaluate(() => buildXlsxWorksheet({ statuses: reportStatusFilter }));
  assert.match(excel.sharedStringsXml, /Token-1/); assert.doesNotMatch(excel.sharedStringsXml, /Token-0|Hidden edited/);
  // A complete portable backup keeps filtered-out content and attachments.
  const portable = await page.evaluate(async () => {
    const packed = await window.QaReportFile.pack(clone(draft));
    const unpacked = await window.QaReportFile.unpack(packed.blob);
    return { count: unpacked.document.sections.flatMap(s => s.rows).length,
      hidden: unpacked.document.sections.find(s => s.id === 'hidden').rows[0].cells.check };
  });
  assert.deepEqual(portable, { count: 10, hidden: 'Hidden edited' });
  // Finish the pending typing step before testing a separate status undo.
  await page.waitForFunction(() => historyCurrent === serializeDraft());
  // Changing a visible status removes just that row; undo returns it.
  await page.locator('[data-row-id="row-1"] .status-select').selectOption('OK');
  assert.deepEqual(await rows(), ['row-4', 'second-fail']);
  await page.click('#undoButton');
  assert.deepEqual(await rows(), ['row-1', 'row-4', 'second-fail']);
  // Empty selection is a zero-result filter; both reset paths restore the full model.
  await chooseFilter([]);
  assert.equal((await rows()).length, 0);
  assert.equal(await page.locator('.report-filter-empty').isVisible(), true);
  assert.equal(await page.locator('#summaryTotal').textContent(), '0');
  assert.equal(await page.locator('#selectionDelete').isDisabled(), true);
  await page.click('#resetReportStatusFilter');
  assert.equal((await rows()).length, 10);
  assert.equal(await page.locator('#reportStatusFilterBar').isHidden(), true);
  await page.click('#selectionFilterButton');
  await page.uncheck('#selectionFilterAll');
  await page.check('#selectionFilterOptions input[value="ТРЕБУЕТ УТОЧНЕНИЯ"]');
  await page.click('#selectionFilterApply');
  assert.deepEqual(await rows(), ['row-6']);
  await page.click('#selectionFilterButton');
  await page.click('#selectionFilterReset');
  assert.equal((await rows()).length, 10);
  // Inspect menu and banner across themes and narrow/wide viewports.
  await page.waitForFunction(() => !document.getElementById('toast').classList.contains('visible'));
  await chooseFilter(['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  for (const [theme, width] of [['light', 1440], ['graphite', 1440], ['graphite', 390]]) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.click('#selectionFilterButton');
    await page.waitForFunction(() => {
      const r = document.getElementById('selectionFilterMenu').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    });
    await page.screenshot({ path: path.join(temp, `${theme}-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#reportStatusFilterBar').evaluate(n => n.getBoundingClientRect().right <= innerWidth));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Destructive bulk actions cannot include filtered-out rows.
  await page.check('#selectionAll');
  await page.click('#selectionDelete');
  await page.click('#acceptConfirmButton');
  assert.equal(await page.evaluate(() => draft.sections.flatMap(s => s.rows).length), 7);
  await page.click('#resetReportStatusFilter');
  assert.equal((await rows()).length, 7);
  assert.equal(await page.locator('[data-row-id="hidden-ok"] .cell-editor').textContent(), 'Hidden edited');
  // Switching documents resets transient filters, as does reload.
  await chooseFilter(['OK']);
  await page.evaluate(() => applyDraftLocally({ ...draft, draftId: crypto.randomUUID(), reportId: crypto.randomUUID() }));
  assert.equal(await page.locator('#reportStatusFilterBar').isHidden(), true);
  assert.equal((await rows()).length, 7);
  await chooseFilter(['OK']);
  await page.evaluate(() => saveDraft());
  await page.reload();
  await page.waitForSelector('#sections tr[data-row-id]');
  assert.equal(await page.locator('#reportStatusFilterBar').isHidden(), true);
  assert.equal((await rows()).length, 7);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), filter: true, selection: true, persistence: true, publicationScope: true, htmlClipboard: true, preview: true, excel: true, fullBackup: true, undo: true, responsive: true, screenshots: temp }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); child?.kill();
});
