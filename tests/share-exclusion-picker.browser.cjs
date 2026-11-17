const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./fixtures/bug-wizard-preview.cjs');
const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(root, '../artifacts/share-exclusion-picker', path.basename(root));
let server, browser;
async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = await start(root); server = fixture.server;
  browser = await chromium.launch({ headless: true, ...(process.env.QA_REPORT_CHROMIUM && { executablePath: process.env.QA_REPORT_CHROMIUM }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await page.route('**/api/shared-reports/availability', route => route.fulfill({ json: { ok: true, enabled: true, requiresPublishToken: false } }));
  await page.goto(fixture.origin); await page.waitForSelector('#settingsButton');
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    const sections = Array.from({ length: 60 }, (_, s) => ({ id: `section-${s}`, title: `Каталог — группа ${s + 1}`, collapsed: true,
      columns: [{ id: 'check', title: 'Проверка' }, { id: 'comment', title: 'Комментарий' }, { id: 'tags', title: 'Метки', type: 'tags' }],
      rows: Array.from({ length: 50 }, (_, r) => ({ id: `row-${s}-${r}`, status: r % 3 ? 'OK' : 'НЕ ОК', cells: {
        check: `Проверка ${s + 1}.${r + 1} оформления и сохранения заказа`,
        comment: s === 59 && r === 49 ? 'Уникальный хвост в комментарии, далеко за первой страницей' : 'Результат сохраняется после обновления страницы',
        tags: QaReportTags.html([r % 3 ? 'Frontend' : 'Backend']),
      } })),
    }));
    applyDraftLocally(normalizeDraft({ ...clone(DEFAULT_DRAFT), draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), issueUrl: '', environment: 'STAGE', overallStatus: 'НЕ ОК', numberingMode: 'hierarchical', sections }));
  });
  await page.evaluate(() => openShareReport({ currentTarget: document.getElementById('shareReportButton') }));
  await page.waitForSelector('#shareReportOptions:not([hidden])');
  assert.equal(await page.locator('#shareReportExclusionList input').count(), 0);
  const picker = page.locator('#shareExclusionPicker');
  const open = async () => { await page.click('#shareReportExclusionSummary'); await page.waitForFunction(() => document.getElementById('applyShareExclusions')?.disabled === false); };
  const apply = async () => { await page.click('#applyShareExclusions'); await picker.waitFor({ state: 'hidden' }); };
  const check = (s, r) => picker.locator(`input[data-section-id="section-${s}"][data-row-id="row-${s}-${r}"]`);
  const search = picker.getByRole('searchbox', { name: 'Найти пункт или раздел' });
  await open();
  assert.equal(await picker.locator('.exclusion-picker-row').count(), 30);
  assert.match(await picker.locator('.exclusion-picker-pager').textContent(), /1–30 из 3000/);
  await check(0, 0).check();
  assert.equal(await page.evaluate(() => selectedSharedExclusions().length), 0);
  await search.press('Escape');
  await picker.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#shareReportModal').isVisible(), true);
  assert.equal(await page.locator('#shareReportExclusionSummary').evaluate(node => node === document.activeElement), true);
  await open(); assert.equal(await check(0, 0).isChecked(), false);
  await picker.locator('.exclusion-picker-group-heading input').first().check();
  assert.match(await picker.locator('.exclusion-picker-total').textContent(), /50 из 3000/);
  await picker.getByRole('button', { name: 'Следующая страница пунктов' }).click();
  assert.equal(await picker.locator('input[data-section-id="section-0"]:checked').count(), 20);
  assert.match(await picker.locator('.exclusion-picker-pager').textContent(), /31–60 из 3000/);
  await search.fill('уникальный хвост');
  assert.equal(await picker.locator('.exclusion-picker-row').count(), 1);
  assert.match(await picker.locator('.exclusion-picker-snippet').textContent(), /Уникальный хвост/);
  await check(59, 49).check();
  await search.fill('');
  await picker.getByRole('button', { name: /^Исключённые/ }).click();
  await picker.getByRole('combobox', { name: 'Раздел чек-листа' }).selectOption('section-59');
  assert.equal(await picker.locator('.exclusion-picker-row').count(), 1);
  await picker.getByRole('button', { name: 'Вернуть найденные', exact: true }).click();
  assert.equal(await picker.locator('.exclusion-picker-row').count(), 0);
  assert.match(await picker.locator('.exclusion-picker-total').textContent(), /50 из 3000/);
  await apply();
  assert.equal(await page.evaluate(() => selectedSharedExclusions().length), 50);
  assert.equal(await page.locator('#shareReportExclusionBadge').textContent(), '50');
  assert.match(await page.locator('#sharedTagCount').textContent(), /2950 из 3000/);
  await open();
  await picker.getByRole('combobox', { name: 'Раздел чек-листа' }).selectOption('section-1');
  await picker.getByRole('button', { name: 'Исключить найденные', exact: true }).click();
  assert.match(await picker.locator('.exclusion-picker-total').textContent(), /100 из 3000/);
  assert.equal(await picker.locator('.exclusion-picker-row').count(), 30);
  for (const theme of ['graphite', 'light', 'dark']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await picker.screenshot({ path: path.join(artifacts, `${theme}-desktop.png`) });
  }
  await apply();
  assert.equal(await page.evaluate(() => selectedSharedExclusions().length), 100);
  await open();
  await picker.getByRole('button', { name: /^Исключённые/ }).click();
  assert.equal(await picker.locator('.exclusion-picker-row').count(), 30);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await picker.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; }));
  await picker.screenshot({ path: path.join(artifacts, 'mobile.png') });
  await picker.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await page.evaluate(() => selectedSharedExclusions().length), 100);
  await page.click('#shareReportExclusionReset');
  assert.equal(await page.evaluate(() => selectedSharedExclusions().length), 0);
  assert.match(await page.locator('#sharedTagCount').textContent(), /3000 из 3000/);
  assert.equal(await page.evaluate(() => draft.sections.reduce((count, section) => count + section.rows.length, 0)), 3000);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), rows: 3000, sections: 60, renderedRows: 30, stagedSelection: true, sectionBatch: true, crossPage: true, fullSearch: true, selectedOnly: true, mobile: true, screenshots: artifacts }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
