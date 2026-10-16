// Blocked outcomes and first-use preferences on isolated synthetic reports.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-blocked-defaults-'));
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

  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'graphite');
  assert.equal(await page.evaluate(() => draft.numberingMode), 'hierarchical');
  assert.deepEqual(await page.locator('.row-number-text').allTextContents(), ['1.1', '1.2']);
  await page.click('#settingsButton');
  assert.equal(await page.isChecked('[name="numberingMode"][value="hierarchical"]'), true);
  await page.check('[name="numberingMode"][value="section"]');
  await page.click('#saveJiraSettingsButton');
  await page.click('[data-settings-section="appearance"]');
  await page.click('.theme-menu-item[data-theme="light"]');
  await page.click('#closeJiraSettingsButton');
  assert.deepEqual(await page.locator('.row-number-text').allTextContents(), ['1.', '2.']);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.locator('.cell-editor[data-column-id="check"]').nth(0).fill('Создание заказа');
  await page.locator('.cell-editor[data-column-id="check"]').nth(1).fill('Оплата заказа');
  await page.locator('.cell-editor[data-column-id="comment"]').nth(1).fill('Проверка ждёт исправления создания заказа');
  await page.locator('.status-select').nth(0).selectOption('НЕ ОК');
  await page.locator('.status-select').nth(1).selectOption('ЗАБЛОКИРОВАНО');
  await page.selectOption('#overallStatus', 'ЗАБЛОКИРОВАНО');
  assert.equal(await page.locator('#summaryTotal').textContent(), '2');
  assert.equal(await page.locator('.summary-row').filter({ hasText: 'ЗАБЛОКИРОВАНО' }).locator('.summary-count').textContent(), '1');
  const exports = await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    await saveDraft();
    const packed = await window.QaReportFile.pack(draft);
    const restored = await window.QaReportFile.unpack(packed.blob);
    return { overall: restored.document.overallStatus, rows: restored.document.sections[0].rows.map(row => row.status),
      markup: generateMarkup({ statuses: ['ЗАБЛОКИРОВАНО'] }), visual: generateVisualPreview(),
      xlsx: buildXlsxWorksheet().sharedStringsXml };
  });
  assert.equal(exports.overall, 'ЗАБЛОКИРОВАНО');
  assert.deepEqual(exports.rows, ['НЕ ОК', 'ЗАБЛОКИРОВАНО']);
  assert.match(exports.markup, /ЗАБЛОКИРОВАНО/);
  assert.doesNotMatch(exports.markup, /Создание заказа/);
  assert.match(exports.visual, /ЗАБЛОКИРОВАНО/);
  assert.match(exports.xlsx, /ЗАБЛОКИРОВАНО/);
  await page.reload();
  await page.waitForSelector('.status-select.status-blocked');
  assert.equal(await page.inputValue('#overallStatus'), 'ЗАБЛОКИРОВАНО');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.deepEqual(await page.locator('.row-number-text').allTextContents(), ['1.', '2.']);
  await page.evaluate(async () => {
    const original = draftContentSnapshot();
    for (const mode of ['section', 'continuous', 'manual', 'hierarchical']) {
      if (normalizeDraft({ ...original, numberingMode: mode }).numberingMode !== mode) throw Error('Existing mode changed');
    }
    const legacy = clone(original); delete legacy.numberingMode;
    if (normalizeDraft(legacy).numberingMode !== 'section') throw Error('Legacy numbers changed');
  });
  for (const theme of ['light', 'dark', 'graphite']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.waitForFunction(expected => {
      const row = getComputedStyle(document.querySelector('.status-select.status-blocked'));
      const overall = getComputedStyle(document.getElementById('overallStatus'));
      return overall.color === expected && overall.backgroundColor === row.backgroundColor;
    }, theme === 'light' ? 'rgb(80, 95, 121)' : 'rgb(193, 203, 217)');
    const colors = await page.locator('.status-select.status-blocked').evaluate(select => {
      const row = getComputedStyle(select), overall = getComputedStyle(document.getElementById('overallStatus'));
      return { row: row.color, overall: overall.color, background: row.backgroundColor, overallBackground: overall.backgroundColor };
    });
    assert.equal(colors.row, colors.overall);
    assert.equal(colors.background, colors.overallBackground);
    assert.equal(colors.row, theme === 'light' ? 'rgb(80, 95, 121)' : 'rgb(193, 203, 217)');
    await page.screenshot({ path: path.join(temp, `${theme}-desktop.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(temp, 'graphite-mobile.png'), fullPage: true });
  assert.ok(await page.locator('#overallStatus').evaluate(node => {
    const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
  }));
  // Login shares the default appearance while keeping saved choices.
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const loginContext = await browser.newContext({ serviceWorkers: 'block', colorScheme: 'dark' });
    const login = await loginContext.newPage();
    await login.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await login.goto(origin + '/login');
    assert.equal(await login.evaluate(() => document.documentElement.dataset.theme), 'graphite');
    await login.evaluate(() => localStorage.setItem('qa-report-theme', 'light'));
    await login.reload();
    assert.equal(await login.evaluate(() => document.documentElement.dataset.theme), 'light');
    await loginContext.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version: path.basename(root), defaults: true, preferencesEditable: true,
    savedChoicesPreserved: true, blocked: true, summary: true, reload: true, exports: true, reportRoundtrip: true, screenshots: temp }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); child?.kill(); });
