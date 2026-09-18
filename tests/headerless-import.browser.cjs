// Real browser regression: isolated local app; every Jira request is a fixture.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-headerless-'));
const output = process.env.QA_REPORT_SCREENSHOTS;
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  const original = await page.evaluate(async () => {
    const parsed = parseJiraMarkup('Окружение: PROD\n||Номер||Проверка||Шаги||Ожидаемый результат||Фактический результат||Комментарий||Статус||\n|1|Existing check|Existing steps|Expected|Actual|Keep note|НЕ ОК|');
    applyDraftLocally(importedDraftInCurrentReport({ ...parsed, numberingMode: 'manual' }));
    flushDraftFromDom();
    await saveReportSnapshot('browser-fixture');
    return JSON.parse(JSON.stringify(draft));
  });
  const fragment = '|3.|Порядок записей|Сверить {{items}}|По возрастанию|Не проверено напрямую: нет доступа|Источник — документация|{color:#6b778c}*НЕ ПРОВЕРЕНО*{color}|\n|8.|Повторная проверка|Шаги|Ожидание|Факт|[^log.txt]|OK|';
  async function analyze(text) {
    await page.click('#importButton');
    await page.fill('#importMarkup', text);
    await page.click('#applyImportButton');
    await page.waitForFunction(() => preparedImport && !importBusy);
  }
  await analyze(fragment);
  assert.equal(await page.locator('[data-focus="destination-mode"]').inputValue(), 'rows');
  assert.equal(await page.locator('[data-focus="destination-section"]').inputValue(), original.sections[0].id);
  assert.equal(await page.locator('[data-disclosure="destination-columns"]').getAttribute('open'), '');
  assert.equal(await page.locator('[data-focus^="source-number-"]').isChecked(), true);
  assert.equal(await page.locator('[data-focus^="source-status-"]').isChecked(), true);
  for (const role of ['number', 'status']) {
    await page.locator(`[data-focus^="source-${role}-"]`).uncheck();
    assert.equal(await page.locator('[data-focus^="destination-column-"]').count(), 6);
    await page.locator(`[data-focus^="source-${role}-"]`).check();
    assert.equal(await page.locator('[data-focus^="destination-column-"]').count(), 5);
    assert.equal(await page.locator('#applyImportButton').isDisabled(), false);
  }
  // Swap the last two destinations and check that the preview and saved report agree.
  const controls = page.locator('[data-focus^="destination-column-"]');
  await controls.nth(3).selectOption(original.sections[0].columns[4].id);
  await controls.nth(4).selectOption(original.sections[0].columns[3].id);
  await page.locator('[data-disclosure="preview"] > summary').click();
  await page.locator('.import-result-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.import-result-table tbody tr').count(), 2);
  assert.match(await page.locator('.import-result-table tbody tr').first().innerText(), /Не проверено напрямую/);
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await page.waitForFunction(() => !elements.toast.classList.contains('visible'));
    await page.locator('#importModal .import-body').evaluate(node => { node.scrollTop = 0; });
    await page.locator('#importModal .modal').screenshot({ path: path.join(output, 'preview.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.querySelector('#importModal .modal').scrollWidth <= window.innerWidth), true);
    await page.locator('#importModal .modal').screenshot({ path: path.join(output, 'mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.click('#applyImportButton');
  await page.waitForFunction(() => elements.importModal.hidden && draft.sections[0].rows.length === 3);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(draft)));
  assert.deepEqual(after.sections[0].rows[0], original.sections[0].rows[0]);
  assert.equal(after.reportId, original.reportId);
  assert.equal(after.environment, 'PROD');
  assert.deepEqual(after.sections[0].columns, original.sections[0].columns);
  assert.equal(after.sections[0].rows[1].manualNumber, '3.');
  assert.equal(after.sections[0].rows[1].status, 'НЕ ПРОВЕРЕНО');
  assert.match(after.sections[0].rows[1].cells[original.sections[0].columns[4].id], /Не проверено напрямую/);
  assert.match(after.sections[0].rows[1].cells[original.sections[0].columns[3].id], /Источник/);
  assert.equal(await page.locator('#confirmModal').isVisible(), false);
  await page.click('#undoButton');
  await page.waitForFunction(() => draft.sections[0].rows.length === 1);
  await page.click('#redoButton');
  await page.waitForFunction(() => draft.sections[0].rows.length === 3);
  await page.evaluate(() => saveReportSnapshot('browser-fixture-final'));
  await page.reload();
  await page.waitForFunction(() => draft.sections[0].rows.length === 3);
  assert.equal(await page.evaluate(() => draft.sections[0].rows[1].manualNumber), '3.');
  // Multiple targets require an explicit choice. Cancelling changes nothing.
  await page.evaluate(() => {
    draft.sections.push(parseJiraMarkup('||Проверка||Статус||\n|Another section|OK|').sections[0]);
    render(); flushDraftFromDom();
  });
  const beforeCancel = await page.evaluate(() => serializeDraft());
  await analyze('|9|New check|Blocked|');
  assert.equal(await page.locator('[data-focus="destination-section"]').inputValue(), '');
  assert.equal(await page.locator('#applyImportButton').isDisabled(), true);
  await page.locator('[data-focus="destination-section"]').selectOption(original.sections[0].id);
  await page.locator('[data-focus^="source-status-"]').check();
  assert.equal(await page.locator('#applyImportButton').isDisabled(), true);
  await page.locator('[data-focus="mapping-Blocked"]').selectOption('ТРЕБУЕТ УТОЧНЕНИЯ');
  assert.equal(await page.locator('#applyImportButton').isDisabled(), false);
  await page.click('#closeImportButton');
  assert.equal(await page.evaluate(() => serializeDraft()), beforeCancel);
  assert.deepEqual(errors, []);
  console.log('PASS: headerless import, role correction, column mapping, metadata, preview, append, undo/redo, reload, target choice and cancel');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
