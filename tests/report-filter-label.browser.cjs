// Real label clicks are essential: checking the input directly misses the Chromium crash.
// All content and API responses are synthetic; no server or user history is used.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const origin = 'http://qa-report.test';
const reportId = 'a'.repeat(32);
const clarification = 'ТРЕБУЕТ УТОЧНЕНИЯ';
const sections = [7, 5, 4].map((count, sectionIndex) => ({
  id: `section-${sectionIndex}`, title: `Раздел ${sectionIndex + 1}`,
  columns: Array.from({ length: count }, (_, index) => ({ id: `c${index}`, title: `Колонка ${index}`, label: `Колонка ${index}` })),
  rows: Array.from({ length: sectionIndex ? 1 : 7 }, (_, index) => ({
    id: `row-${index}`, number: `${index + 1}.`,
    status: sectionIndex === 2 ? 'НЕ ПРОВЕРЕНО' : sectionIndex === 1 ? 'НЕ ОК'
      : ['OK', clarification, 'OK', 'OK', 'OK', 'НЕ ОК', 'OK'][index],
    cells: Object.fromEntries(Array.from({ length: count }, (_, column) => [`c${column}`, `Пункт ${index + 1}, колонка ${column}`])),
  })),
}));
const report = { title: 'Проверка фильтра', environment: 'STAGE', overallStatus: 'OK', sections };
const published = { ...report, intro: { text: 'Описание проверки' }, canReply: false,
  sections: sections.map(section => ({ ...section, rows: section.rows.map(row => ({ ...row,
    cells: Object.fromEntries(Object.entries(row.cells).map(([key, text]) => [key, { text }])),
  })) })) };
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = index.indexOf('<dialog class="qa-report-view report-preview"');
const end = index.indexOf('<div class="modal-backdrop publish-progress-backdrop"', start);
assert.ok(start >= 0 && end > start);
const previewHtml = '<!doctype html><html lang="ru" data-theme="graphite"><head><meta charset="utf-8">'
  + ['styles.css', 'report-view.css', 'status-palette.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')
  + ['tracker-links.js', 'file-preview.js', 'shared-table-layout.js', 'report-view.js'].map(file => `<script defer src="/${file}"></script>`).join('')
  + '</head><body>' + index.slice(start, end) + '</body></html>';

async function verifyFilter(page, { filterId, countId, headingId, expectedTotal = 9 }) {
  const filter = page.locator(filterId);
  const summary = filter.locator('summary');
  const options = filter.locator('fieldset');
  const expectCount = async count => {
    await page.waitForFunction(({ countId, count, expectedTotal }) => document.querySelector(countId).textContent === `${count} из ${expectedTotal}`,
      { countId, count, expectedTotal });
  };
  for (let iteration = 0; iteration < 6; iteration++) {
    await summary.click();
    // Clicking the label blurs the summary before the browser focuses the input.
    await options.getByText(clarification, { exact: true }).click();
    await expectCount(1);
    assert.notEqual(await filter.getAttribute('open'), null, 'Label activation keeps the menu open');
    assert.equal(await options.locator(`input[value="${clarification}"]`).isChecked(), true);
    await options.getByText('НЕ ОК', { exact: true }).click();
    await expectCount(3);
    await options.getByText(clarification, { exact: true }).click();
    await expectCount(2);
    await filter.getByRole('button', { name: 'Все пункты', exact: true }).click();
    await expectCount(expectedTotal);
    assert.equal(await filter.getAttribute('open'), null);
    assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  }
  // Direct checkbox activation, Escape and outside clicks still behave normally.
  await summary.click();
  await options.locator(`input[value="${clarification}"]`).check();
  await expectCount(1);
  await options.locator(`input[value="${clarification}"]`).press('Escape');
  assert.equal(await filter.getAttribute('open'), null);
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  await summary.click();
  await page.locator(headingId).click();
  assert.equal(await filter.getAttribute('open'), null);
  await summary.click();
  // Tab between controls must stay usable; leaving the menu closes it.
  await summary.press('Tab');
  assert.notEqual(await filter.getAttribute('open'), null);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  await summary.press('Shift+Tab');
  await page.waitForFunction(filterId => !document.querySelector(filterId).open, filterId);
  await expectCount(1);
}

async function main() {
  const browser = await chromium.launch({ headless: process.env.QA_REPORT_HEADED !== '1',
    channel: process.env.QA_REPORT_BROWSER || undefined, args: ['--force-renderer-accessibility'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1460, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/preview-test') return route.fulfill({ contentType: 'text/html', body: previewHtml });
      if (url.pathname === `/api/shared-reports/${reportId}`) return route.fulfill({ json: { report: published } });
      if (url.pathname === `/api/shared-reports/${reportId}/attachment-status`) return route.fulfill({ json: { pending: [] } });
      const name = url.pathname.startsWith('/shared-report/') ? 'shared-report.html' : path.basename(url.pathname);
      if (!/\.(?:js|css|html|svg)$/.test(name) || !fs.existsSync(path.join(root, name))) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: path.join(root, name), contentType: name.endsWith('.js') ? 'text/javascript'
        : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    });
    const page = await context.newPage();
    const failures = [];
    page.on('crash', () => failures.push('Renderer crashed'));
    page.on('pageerror', error => failures.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(`${origin}/preview-test`);
    await page.evaluate(report => QaReportView.createPreview(document.querySelector('#previewModal'), () => {}, node => node.textContent)(report), report);
    await verifyFilter(page, { filterId: '#previewFilter', countId: '#previewModal .counts', headingId: '#previewTitle' });
    await page.goto(`${origin}/shared-report/${reportId}#${'A'.repeat(43)}`);
    await page.locator('#report').waitFor({ state: 'visible' });
    const sharedSelectors = { filterId: '#report-filter', countId: '#report-count', headingId: '#report-title' };
    await verifyFilter(page, sharedSelectors);
    await page.locator('#report-filter summary').click();
    await page.locator('#report-filter-reset').click();
    await page.getByRole('button', { name: 'В таблице', exact: true }).click();
    await verifyFilter(page, sharedSelectors);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator('#report').waitFor({ state: 'visible' });
    await verifyFilter(page, sharedSelectors);
    assert.deepEqual(failures, []);
    if (process.env.QA_REPORT_SCREENSHOTS) {
      fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, 'report-filter.png') });
    }
    console.log('Filter label clicks passed: preview, developer report in both reply views, mobile, keyboard and reset');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
