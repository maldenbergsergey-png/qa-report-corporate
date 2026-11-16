// Synthetic, isolated UI/export coverage; no real tracker, account or upload service.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./fixtures/bug-wizard-preview.cjs');
const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(root, '../artifacts/checklist-tags', path.basename(root));
let server, browser;
async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = await start(root); server = fixture.server;
  browser = await chromium.launch({ headless: true, ...(process.env.QA_REPORT_CHROMIUM && { executablePath: process.env.QA_REPORT_CHROMIUM }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await page.goto(fixture.origin); await page.waitForSelector('.check-section');
  await page.waitForFunction(() => document.getElementById('saveState')?.getAttribute('aria-label') === 'Сохранено');
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    applyDraftLocally(normalizeDraft({ ...clone(DEFAULT_DRAFT), draftId: crypto.randomUUID(), reportId: crypto.randomUUID(),
      issueUrl: 'https://jira.example.test/browse/QA-1', environment: 'STAGE', overallStatus: 'НЕ ОК',
      sections: [{ id: 'test-section', title: 'Заказ', columns: [{ id: 'check', title: 'Проверка', width: 500 }], rows: [
        { id: 'api', status: 'НЕ ОК', cells: { check: 'Ошибка API при создании заказа' } },
        { id: 'form', status: 'НЕ ОК', cells: { check: 'Ошибка в форме заказа' } },
        { id: 'mixed', status: 'НЕ ОК', cells: { check: 'Ошибка интеграции формы и API' } },
        { id: 'plain', status: 'OK', cells: { check: 'Проверка без меток' } },
      ] }],
    }));
  });
  assert.ok(await page.evaluate(() => {
    const tag = document.getElementById('tagFilterButton').getBoundingClientRect();
    const selection = document.getElementById('selectionToggle').getBoundingClientRect();
    const format = document.getElementById('blockFormat').getBoundingClientRect();
    const mic = document.getElementById('dictationButton').getBoundingClientRect();
    return tag.width >= 86 && selection.right <= tag.left && tag.right <= format.left && mic.left > format.right;
  }));
  assert.equal(await page.locator('#tagFilterButton use').getAttribute('href'), '#icon-tag');
  await page.getByRole('button', { name: '+ Столбец меток', exact: true }).click();
  await page.locator('[data-row-id="api"] .qa-tags-cell').click();
  const input = page.getByRole('textbox', { name: 'Название метки или поиск' });
  await input.fill('Backend');
  assert.equal(await page.getByRole('button', { name: 'Создать метку «Backend»', exact: true }).locator('.qa-tag').textContent(), 'Backend');
  await page.screenshot({ path: path.join(artifacts, 'create-tag.png'), fullPage: false });
  await page.getByRole('button', { name: 'Создать метку «Backend»', exact: true }).click();
  await input.fill('back');
  assert.equal(await page.locator('.qa-tag-selected .qa-tag').textContent(), 'Backend');
  assert.equal(await page.getByText('Уже добавлена', { exact: true }).isVisible(), true);
  await input.press('Enter'); assert.equal(await input.inputValue(), 'back');
  await input.fill('BACKEND'); await input.press('Enter');
  assert.equal(await input.inputValue(), 'BACKEND');
  assert.equal(await page.locator('.qa-tag-create').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'existing-tag-search.png'), fullPage: false });
  await input.fill('Нужна аналитика'); await input.press('Enter');
  assert.ok(await page.locator('.qa-tags-picker').evaluate(node => node.getBoundingClientRect().height < 250));
  assert.ok(await page.locator('.qa-tags-picker').evaluate(node => node.querySelector('input').getBoundingClientRect().top - node.querySelector('.qa-tags-close').getBoundingClientRect().bottom >= 12));
  await page.screenshot({ path: path.join(artifacts, 'graphite-picker.png'), fullPage: true });
  await input.press('Escape');
  await page.locator('[data-row-id="form"] .qa-tags-cell').click();
  await input.fill('Frontend'); await input.press('Enter'); await input.press('Escape');
  // Reuse existing suggestions for multiple names without retyping.
  await page.locator('[data-row-id="mixed"] .qa-tags-cell').click();
  await page.locator('.qa-tag-option').filter({ hasText: 'Backend' }).click();
  await page.locator('.qa-tag-option').filter({ hasText: 'Frontend' }).click();
  await input.press('Escape');
  await page.locator('[data-row-id="api"] .row-menu-button').click();
  assert.equal(await page.getByRole('button', { name: 'Метки пункта', exact: true }).locator('use').getAttribute('href'), '#icon-tag');
  await page.screenshot({ path: path.join(artifacts, 'row-menu.png'), fullPage: false });
  await page.evaluate(() => closeFloatingMenu());
  const exports = await page.evaluate(async () => {
    flushDraftFromDom(); await saveDraft();
    const packed = await QaReportFile.pack(draft), restored = await QaReportFile.unpack(packed.blob);
    const markup = generateMarkup(), imported = parseJiraMarkup(markup);
    const importedTags = imported.sections[0].columns.find(QaReportTags.isColumn);
    const scope = { include: ['Frontend'], exclude: ['Backend'], untagged: false, showTags: true };
    const selected = generateMarkup({ tagFilter: scope });
    const html = generateVisualPreview(draft, null, { tagFilter: scope });
    const xlsx = buildXlsxWorksheet({ tagFilter: scope }).sharedStringsXml;
    const shared = await QaReportFile.prepareSharedSnapshot(draft, sharedSnapshotOptions(draft, { tagFilter: scope }));
    const hidden = await QaReportFile.prepareSharedSnapshot(draft, sharedSnapshotOptions(draft, { tagFilter: { ...scope, showTags: false } }));
    const adf = typeof generateAdfDocument === 'function' ? generateAdfDocument() : null;
    return { restored: restored.document, imported: imported.sections[0].rows.map(row => QaReportTags.read(row.cells[importedTags.id])),
      selected, html, xlsx, shared: shared.snapshot, hidden: hidden.snapshot, adf };
  });
  assert.equal(exports.restored.sections[0].rows.length, 4);
  assert.equal(exports.restored.sections[0].columns[1].type, 'tags');
  const restoredTagId = exports.restored.sections[0].columns[1].id;
  assert.match(exports.restored.sections[0].rows[0].cells[restoredTagId], /Backend/);
  assert.deepEqual(exports.imported[0], ['Backend', 'Нужна аналитика']);
  for (const output of [exports.selected, exports.html, exports.xlsx]) {
    assert.match(output, /Ошибка в форме заказа/);
    assert.doesNotMatch(output, /Ошибка API при создании заказа|Ошибка интеграции формы и API|Проверка без меток/);
  }
  assert.equal(exports.shared.sections[0].rows.length, 1);
  assert.equal(exports.shared.sections[0].columns[1].type, 'tags');
  assert.equal(exports.hidden.sections[0].columns.length, 1);
  if (exports.adf) { assert.match(JSON.stringify(exports.adf), /"type":"status"/); assert.equal(await page.evaluate(() => JSON.stringify(generateAdfDocument()) === JSON.stringify(generateAdfDocument())), true); }
  await page.getByRole('button', { name: 'Отбор пунктов по меткам', exact: true }).click();
  await page.getByRole('button', { name: 'Включить: Frontend', exact: true }).click();
  await page.getByRole('button', { name: 'Исключить: Backend', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Включить: Frontend', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Исключить: Backend', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#sections tr[data-row-id]').count(), 1);
  await page.screenshot({ path: path.join(artifacts, 'graphite-filter.png'), fullPage: true });
  await page.getByRole('button', { name: 'Просмотр', exact: true }).click();
  assert.equal(await page.locator('#previewModal .qa-tag').count(), 1);
  await page.screenshot({ path: path.join(artifacts, 'graphite-preview.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { QaReportTags.editorScope = QaReportTags.scope(); renderSections(); renderSummary(); });
  // Adding/removing a tag in bulk preserves every other tag.
  await page.locator('#selectionToggle').click();
  await page.locator('[data-selection-row="api"]').check();
  await page.locator('[data-selection-row="form"]').check();
  await page.locator('#selectionTagsButton').click();
  await input.fill('Проверить повторно'); await input.press('Enter');
  await page.getByRole('button', { name: 'Добавить метки', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => draft.sections[0].rows.slice(0, 2).map(QaReportTags.rowNames)), [
    ['Backend', 'Нужна аналитика', 'Проверить повторно'], ['Frontend', 'Проверить повторно'],
  ]);
  await page.locator('#selectionExit').click();
  await page.evaluate(() => { window.tagScopeResult = askPublishScope(); });
  const publishTags = page.locator('#tagScope-publish');
  assert.equal(await publishTags.getByRole('heading', { name: 'Метки пунктов', exact: true }).isVisible(), true);
  assert.equal(await publishTags.locator('details').count(), 0);
  await publishTags.getByRole('button', { name: 'Исключить метки', exact: true }).click();
  await publishTags.getByRole('button', { name: 'Исключить: Backend', exact: true }).click();
  assert.match(await page.locator('#publishScopeSummary').textContent(), /строк — 2/);
  await publishTags.getByRole('button', { name: 'Включить метки', exact: true }).click();
  await publishTags.getByRole('button', { name: 'Включить: Frontend', exact: true }).click();
  assert.match(await page.locator('#publishScopeSummary').textContent(), /строк — 1/);
  assert.equal(await publishTags.locator('[data-selection="include"]').count(), 1);
  assert.equal(await publishTags.locator('[data-selection="exclude"]').count(), 1);
  assert.equal(await publishTags.getByLabel('Включать пункты без меток').isChecked(), false);
  assert.equal(await publishTags.locator('.qa-tag-choice-mark:not([hidden])').count(), 2);
  await publishTags.getByLabel('Показывать метки получателю').uncheck();
  await publishTags.scrollIntoViewIfNeeded();
  await page.locator('#publishScopeModal .modal').screenshot({ path: path.join(artifacts, 'publish-tags.png') });
  await page.click('#acceptPublishScopeButton');
  const accepted = await page.evaluate(async () => { const result = await window.tagScopeResult; return { filter: result.tagFilter, body: generateMarkup(result) }; });
  assert.deepEqual(accepted.filter, { include: ['Frontend'], exclude: ['Backend'], untagged: false, showTags: false });
  assert.match(accepted.body, /Ошибка в форме заказа/);
  assert.doesNotMatch(accepted.body, /Метки|Backend|Frontend|Ошибка интеграции/);
  // Shared-link composition uses the same colored controls and actually removes matching rows.
  await page.route(fixture.origin + '/api/shared-reports/availability', route => route.fulfill({ json: { ok: true, enabled: true, requiresPublishToken: false } }));
  await page.evaluate(() => openShareReport({ currentTarget: document.getElementById('shareReportButton') }));
  await page.waitForSelector('#shareReportOptions:not([hidden])');
  const sharedTags = page.locator('#tagScope-share');
  assert.equal(await sharedTags.getByRole('heading', { name: 'Метки пунктов', exact: true }).isVisible(), true);
  await sharedTags.getByRole('button', { name: 'Исключить метки', exact: true }).click();
  await sharedTags.getByRole('button', { name: 'Исключить: Backend', exact: true }).click();
  assert.match(await page.locator('#sharedTagCount').textContent(), /2 из 4/);
  await sharedTags.getByRole('button', { name: 'Включить метки', exact: true }).click();
  await sharedTags.getByRole('button', { name: 'Включить: Frontend', exact: true }).click();
  assert.match(await page.locator('#sharedTagCount').textContent(), /1 из 4/);
  assert.equal(await sharedTags.locator('.qa-tag-choice-mark:not([hidden])').count(), 2);
  await page.locator('#shareReportModal .modal').screenshot({ path: path.join(artifacts, 'share-tags.png') });
  const sharedFiltered = await page.evaluate(async () => (await QaReportFile.prepareSharedSnapshot(draft, sharedSnapshotOptions(draft, { tagFilter: tagScopes.share }))).snapshot);
  assert.deepEqual(sharedFiltered.sections[0].rows.map(row => row.id), ['form']);
  await sharedTags.getByRole('button', { name: 'Исключить метки', exact: true }).click();
  await sharedTags.getByRole('button', { name: 'Исключить: Frontend', exact: true }).click();
  assert.match(await page.locator('#sharedTagCount').textContent(), /0 из 4/);
  assert.equal(await page.locator('#shareReportPublish').isEnabled(), false);
  await sharedTags.getByRole('button', { name: 'Сбросить', exact: true }).click();
  assert.equal(await page.locator('#shareReportPublish').isEnabled(), true);
  assert.match(await page.locator('#sharedTagCount').textContent(), /4 из 4/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await sharedTags.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  await page.screenshot({ path: path.join(artifacts, 'share-tags-mobile.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#shareReportClose');
  // HTML copy has its own visible tag selection, independent of the other channels.
  await page.evaluate(() => openHtmlCopyScope());
  const htmlTags = page.locator('#tagScope-html');
  assert.equal(await htmlTags.getByRole('heading', { name: 'Метки пунктов', exact: true }).isVisible(), true);
  await htmlTags.getByRole('button', { name: 'Исключить метки', exact: true }).click();
  await htmlTags.getByRole('button', { name: 'Исключить: Backend', exact: true }).click();
  assert.match(await page.locator('#htmlCopyScopeSummary').textContent(), /пунктов — 2/);
  await page.evaluate(() => closeHtmlCopyScope());
  for (const theme of ['light', 'dark', 'graphite']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.locator('[data-row-id="api"] .qa-tags-cell').click();
    assert.ok(await page.locator('.qa-tags-picker').evaluate(node => { const r = node.getBoundingClientRect(); return r.width <= 322 && r.height < 260 && r.bottom <= innerHeight; }));
    await page.screenshot({ path: path.join(artifacts, `${theme}-compact.png`), fullPage: true });
    await input.press('Escape');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-row-id="api"] .qa-tags-cell').click();
  assert.ok(await page.locator('.qa-tags-picker').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  await page.screenshot({ path: path.join(artifacts, 'mobile-picker.png'), fullPage: true });
  await input.press('Escape');
  // The real shared reader consumes a safe, structured snapshot, with no HTML injection.
  const id = 'a'.repeat(32);
  await page.route(fixture.origin + '/shared-report/' + id, route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'shared-report.html'), 'utf8') }));
  await page.route(fixture.origin + '/api/shared-reports/' + id + '**', route => route.fulfill({ json: { ok: true, report: { ...exports.shared, id, createdAt: new Date().toISOString(), files: [], answers: [], answerFiles: [], canReply: false } } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture.origin + '/shared-report/' + id + '#' + 'b'.repeat(43));
  await page.waitForSelector('#report:not([hidden]) .qa-tag');
  assert.equal(await page.locator('#report .qa-tag').textContent(), 'Frontend');
  await page.screenshot({ path: path.join(artifacts, 'shared-view.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), tags: true, compact: true, filters: true, import: true, exports: true, portable: true, bulk: true, sharedView: true, screenshots: artifacts }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
