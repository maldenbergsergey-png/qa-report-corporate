// Section numbering regression with isolated history and synthetic attachments.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-section-numbers-'));
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
    applyDraftLocally({ ...draft, numberingMode: 'hierarchical', sectionNumberingMode: 'automatic', sections: [
      { id: 'a', title: 'Alpha', columns: [{ id: 'check', title: 'Check' }], rows: [{ id: 'a1', status: 'OK', cells: { check: 'Alpha check' } }] },
      { id: 'b', title: 'Beta', columns: [{ id: 'check', title: 'Check' }], rows: [{ id: 'b1', status: 'НЕ ОК', cells: { check: 'Beta check' } }] },
      { id: 'c', title: 'Gamma', columns: [{ id: 'details', title: 'Details' }], rows: [
        { id: 'c1', status: 'НЕ ОК', cells: { details: '<strong>Gamma one</strong>' } },
        { id: 'c2', status: 'OK', cells: { details: '<em>Gamma two</em>' } },
      ] },
    ] });
    await saveDraft();
  });
  const sectionLabels = () => page.locator('.section-number-input').evaluateAll(nodes => nodes.map(n => n.value));
  const pointLabels = () => page.locator('.row-number-text').allTextContents();
  const changeSectionMode = async mode => {
    await page.click('#settingsButton');
    await page.check(`[name="sectionNumberingMode"][value="${mode}"]`);
    await page.click('#saveJiraSettingsButton');
    await page.click('#closeJiraSettingsButton');
  };
  await changeSectionMode('manual');
  assert.deepEqual(await sectionLabels(), ['1', '2', '3']);
  for (const [id, number] of [['a', '4'], ['b', '8'], ['c', '12']]) {
    await page.fill(`[data-section-id="${id}"] .section-number-input`, number);
    await page.locator(`[data-section-id="${id}"] .section-title`).focus();
  }
  assert.deepEqual(await pointLabels(), ['4.1', '8.1', '12.1', '12.2']);
  await page.click('[data-section-id="b"] .move-section-up');
  assert.deepEqual(await sectionLabels(), ['8', '4', '12']);
  await page.locator('[data-section-id="c"] .drag-handle').dragTo(page.locator('[data-section-id="b"] .section-header'));
  assert.deepEqual(await sectionLabels(), ['12', '8', '4']);
  await page.click('[data-section-id="b"] .delete-section');
  assert.deepEqual(await sectionLabels(), ['12', '4']);
  await page.evaluate(() => saveDraft());
  await page.reload();
  await page.waitForFunction(() => draft.sectionNumberingMode === 'manual' && draft.sections.length === 2);
  assert.deepEqual(await sectionLabels(), ['12', '4']);
  const exports = await page.evaluate(async () => {
    const markup = generateMarkup(), html = generatePortableHtml(), xlsx = buildXlsxWorksheet();
    const packed = await window.QaReportFile.pack(draft);
    const restored = await window.QaReportFile.unpack(packed.blob);
    const headings = document.createElement('div'); headings.innerHTML = html;
    return { markup, headings: [...headings.querySelectorAll('h2')].map(n => n.textContent),
      xlsx: xlsx.sharedStringsXml, mode: restored.document.sectionNumberingMode,
      sectionNumbers: [...ChecklistNumbering.sectionNumbers(restored.document).values()],
      numbers: [...ChecklistNumbering.rowNumbers(restored.document).values()] };
  });
  assert.match(exports.markup, /h2\. 12\. Gamma/);
  assert.match(exports.markup, /h2\. 4\. Alpha/);
  assert.deepEqual(exports.headings, ['12. Gamma', '4. Alpha']);
  assert.match(exports.xlsx, /12\. Gamma/);
  assert.equal(exports.mode, 'manual');
  assert.deepEqual(exports.sectionNumbers, ['12', '4']);
  assert.deepEqual(exports.numbers, ['12.1', '12.2', '4.1']);
  const screenshot = async (selector, name) => {
    if (process.env.QA_REPORT_COPY_SCREENSHOTS) await page.locator(selector).screenshot({ path: path.join(temp, name + '.png') });
  };
  await screenshot('.report-card', 'manual-sections');
  await page.click('#selectionToggle');
  await page.check('#selectionAll');
  // Whole-section copies preserve labels and columns; the flags are independent.
  for (const rows of [false, true]) for (const sections of [false, true]) {
    const previous = await page.evaluate(async () => ({ ids: (await getAllReports()).map(r => r.id), source: JSON.stringify(draftContentSnapshot()) }));
    await page.click('#selectionCopyButton');
    await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
    await page.locator('#selectionCopyPreserveRowNumbers').setChecked(rows);
    await page.locator('#selectionCopyPreserveSectionNumbers').setChecked(sections);
    if (rows && sections) {
      await screenshot('#selectionCopyOptionsModal .modal', 'copy-desktop');
      await page.evaluate(() => applyTheme('dark'));
      await screenshot('#selectionCopyOptionsModal .modal', 'copy-dark');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('#selectionCopyOptionsModal .modal', 'copy-mobile');
      assert.ok(await page.locator('.selection-copy-options-modal').evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => applyTheme('light'));
    }
    await page.click('#acceptSelectionCopyOptions');
    await page.waitForFunction(() => !elements.confirmModal.hidden);
    await page.click('#cancelConfirmButton');
    await page.waitForFunction(() => !selectionCopyBusy);
    const copy = await page.evaluate(async ({ previous }) => {
      if (JSON.stringify(draftContentSnapshot()) !== previous.source) throw Error('Copy changed source');
      const next = (await getAllReports()).find(r => !previous.ids.includes(r.id)).document;
      return { sectionLabels: [...ChecklistNumbering.sectionNumbers(next).values()], rowLabels: [...ChecklistNumbering.rowNumbers(next).values()],
        rowMode: next.numberingMode, sectionMode: next.sectionNumberingMode, columns: next.sections.map(s => s.columns.map(c => c.title)) };
    }, { previous });
    assert.deepEqual(copy.sectionLabels, sections ? ['12', '4'] : ['1', '2']);
    assert.equal(copy.sectionMode, sections ? 'manual' : 'automatic');
    assert.equal(copy.rowMode, rows ? 'manual' : 'hierarchical');
    assert.deepEqual(copy.rowLabels, rows || sections ? ['12.1', '12.2', '4.1'] : ['1.1', '1.2', '2.1']);
    assert.deepEqual(copy.columns, [['Details'], ['Check']]);
  }
  // Individual points can be combined into one named section, retaining either their numbers or new automatic ones.
  await page.uncheck('[data-selection-row="c1"]');
  for (const preserve of [true, false]) {
    const previous = await page.evaluate(async () => (await getAllReports()).map(r => r.id));
    await page.click('#selectionCopyButton');
    await page.waitForSelector('#selectionCopyOptionsModal:not([hidden])');
    await page.check('[name="selectionCopyGrouping"][value="rows"]');
    assert.equal(await page.locator('#selectionCopySectionNumbersOption').isHidden(), true);
    await page.fill('#selectionCopyTitle', 'Retest');
    await page.locator('#selectionCopyPreserveRowNumbers').setChecked(preserve);
    await screenshot('#selectionCopyOptionsModal .modal', 'copy-merged');
    await page.click('#acceptSelectionCopyOptions');
    await page.waitForFunction(() => !elements.confirmModal.hidden);
    await page.click('#cancelConfirmButton');
    await page.waitForFunction(() => !selectionCopyBusy);
    const copy = await page.evaluate(async previous => {
      const next = (await getAllReports()).find(r => !previous.includes(r.id)).document;
      return { title: ChecklistNumbering.sectionTitle(next, next.sections[0]), sections: next.sections.length,
        columns: next.sections[0].columns.map(c => c.title), cells: next.sections[0].rows.map(r => Object.values(r.cells).join(' ')),
        numbers: [...ChecklistNumbering.rowNumbers(next).values()] };
    }, previous);
    assert.equal(copy.title, '1. Retest'); assert.equal(copy.sections, 1);
    assert.deepEqual(copy.columns, ['Details', 'Check']);
    assert.match(copy.cells[0], /Gamma two/); assert.match(copy.cells[1], /Alpha check/);
    assert.deepEqual(copy.numbers, preserve ? ['12.2', '4.1'] : ['1.1', '1.2']);
  }
  await page.click('#selectionExit');
  await page.click('#settingsButton');
  await screenshot('#jiraSettingsModal .modal', 'settings-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('#jiraSettingsModal .modal', 'settings-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#closeJiraSettingsButton');
  // Import preview and commit use the same independent section/point choices.
  await page.click('#importButton');
  await page.fill('#importMarkup', 'h2. 8. Imported Eight\n||Номер||Check||Статус||\n|8.3|Eight|OK|\nh2. 12. Imported Twelve\n||Номер||Check||Статус||\n|12.7|Twelve|OK|');
  await page.click('#applyImportButton');
  await page.waitForFunction(() => preparedImport && !elements.applyImportButton.disabled);
  await page.selectOption('[data-focus="destination-mode"]', 'replace');
  await page.click('#importTab-data');
  await page.check('#importPreserveSectionNumbers');
  await page.uncheck('#importPreserveNumbers');
  await page.click('#applyImportButton');
  await page.waitForSelector('#confirmModal:not([hidden])');
  await page.click('#acceptConfirmButton');
  await page.waitForFunction(() => elements.importModal.hidden);
  assert.deepEqual(await sectionLabels(), ['8', '12']);
  assert.deepEqual(await pointLabels(), ['8.1', '12.1']);
  // Merging points uses the destination section number and leaves both section labels intact.
  await page.evaluate(() => {
    setSelectionMode(true);
    selectedRowIds = new Set([draft.sections[0].rows[0].id]); updateSelectionUi();
    window.pendingSectionMove = moveSelectedRows(draft.sections[1].id);
  });
  await page.waitForSelector('#confirmModal:not([hidden])');
  await page.click('#acceptConfirmButton');
  await page.evaluate(() => window.pendingSectionMove);
  assert.deepEqual(await sectionLabels(), ['8', '12']);
  assert.deepEqual(await page.locator('.check-section').last().locator('.row-number-text').allTextContents(), ['12.1', '12.2']);
  await changeSectionMode('automatic');
  assert.equal(await page.locator('.section-number-input').count(), 0);
  assert.deepEqual(await page.locator('.section-number').allTextContents(), ['1.', '2.']);
  assert.deepEqual(await page.locator('.check-section').last().locator('.row-number-text').allTextContents(), ['2.1', '2.2']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), settings: true, editing: true, dragAndMove: true, deletion: true, reload: true,
    exports: true, reportRoundtrip: true, independentCopyFlags: true, mergedCopy: true, importedSections: true, rowMove: true, screenshots: temp }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); child?.kill(); });
