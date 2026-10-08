// History loading regression. All data is synthetic and external requests are blocked.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const corporate = fs.existsSync(path.join(root, 'auth.js'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-loading-'));
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
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  if (corporate) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/api/agent/status', route => route.fulfill({ json: { devices: [] } }));
  await page.route('**/api/agent/downloads', route => route.fulfill({ json: { downloads: [] } }));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('.cell-editor');
  // Keep the real storage and renderer; pause snapshot and history reads deterministically.
  await page.evaluate(() => {
    window.originalSaveHistorySnapshot = saveReportSnapshot;
    window.originalHistoryRead = getAllHistoryReports;
    window.historySaveCalls = 0;
    saveReportSnapshot = async (...args) => {
      window.historySaveCalls++;
      await new Promise(resolve => { window.releaseHistorySave = resolve; });
      return window.originalSaveHistorySnapshot(...args);
    };
    getAllHistoryReports = async () => {
      await new Promise(resolve => { window.releaseHistoryRead = resolve; });
      return window.originalHistoryRead();
    };
  });
  await page.click('#historyButton');
  await page.waitForSelector('.history-skeleton');
  assert.equal(await page.locator('.history-skeleton').count(), 3);
  assert.equal(await page.locator('.history-loading-status').innerText(), 'Загружаем историю…');
  assert.equal(await page.locator('#historyList').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#clearHistoryButton').isDisabled(), true);
  assert.equal(await page.locator('#historySearch').isDisabled(), false);
  await page.waitForFunction(() => typeof window.releaseHistorySave === 'function');
  const screenshot = async name => {
    if (!process.env.QA_REPORT_SCREENSHOTS) return;
    fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
    await page.locator('.history-modal').screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, `${name}.png`) });
  };
  for (const theme of ['light', 'graphite', 'dark']) {
    await page.evaluate(value => applyTheme(value), theme);
    await screenshot(`${theme}-history-loading`);
    assert.equal(await page.locator('#historyList').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.history-skeleton-bar').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('.history-skeleton-bar').first().evaluate(node => getComputedStyle(node).animationName), 'history-skeleton-pulse');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.history-skeleton').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
  assert.equal(await page.locator('.history-skeleton').first().evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.locator('.history-modal').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.locator('#historyList').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  const controlsFit = () => page.locator('.history-modal').evaluate(modal => {
    const bounds = modal.getBoundingClientRect();
    return [...modal.querySelectorAll('input, select, button, .history-item')].filter(node => node.getBoundingClientRect().width > 0).every(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right;
    });
  });
  assert.equal(await controlsFit(), true);
  await screenshot('mobile-history-loading');
  await page.setViewportSize({ width: 1600, height: 1000 });

  await page.fill('#historySearch', 'missing-test-task');
  await page.evaluate(() => window.releaseHistorySave());
  await page.waitForFunction(() => typeof window.releaseHistoryRead === 'function');
  assert.equal(await page.locator('.history-skeleton').count(), 3);
  await page.evaluate(() => window.releaseHistoryRead());
  await page.waitForFunction(() => document.getElementById('historyList').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.history-skeleton').count(), 0);
  assert.equal(await page.locator('.history-empty p').innerText(), 'Ничего не найдено');
  assert.equal(await page.locator('#clearHistoryButton').isDisabled(), false);
  await page.evaluate(() => { saveReportSnapshot = window.originalSaveHistorySnapshot; getAllHistoryReports = window.originalHistoryRead; });
  await page.fill('#historySearch', '');
  await page.waitForSelector('.history-comment-field');
  assert.equal(await page.locator('.history-item').count(), 1);
  await screenshot('history-loaded');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await controlsFit(), true);
  assert.equal(await page.locator('#historyList').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await screenshot('mobile-history-loaded');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.fill('.history-comment-field', 'Комментарий до повторного открытия');
  await page.click('#closeHistoryButton');
  await page.click('#historyButton');
  await page.waitForSelector('.history-comment-field');
  assert.equal(await page.locator('.history-comment-field').inputValue(), 'Комментарий до повторного открытия');
  await page.click('#closeHistoryButton');

  // Closing and reopening invalidates the older in-flight result.
  await page.evaluate(() => {
    window.historyReads = [];
    getAllHistoryReports = () => new Promise(resolve => window.historyReads.push(resolve));
  });
  await page.click('#historyButton');
  await page.waitForFunction(() => window.historyReads.length === 1);
  await page.click('#closeHistoryButton');
  assert.equal(await page.locator('#historyModal').isHidden(), true);
  await page.click('#historyButton');
  await page.waitForFunction(() => window.historyReads.length === 2);
  await page.evaluate(() => window.historyReads[0]([{ id: 'old', issueKey: 'QA-OLD', source: 'local' }]));
  assert.equal(await page.locator('.history-skeleton').count(), 3);
  assert.equal(await page.locator('#historyList').getAttribute('aria-busy'), 'true');
  await page.evaluate(() => window.historyReads[1]([]));
  await page.waitForSelector('.history-empty');
  assert.equal(await page.locator('.history-empty p').innerText(), 'Отчётов пока нет');
  await page.click('#closeHistoryButton');

  await page.evaluate(() => { getAllHistoryReports = async () => { throw Error('fixture unavailable'); }; });
  await page.click('#historyButton');
  await page.waitForSelector('[data-retry-history]');
  assert.equal(await page.locator('.history-empty p').innerText(), 'Не удалось загрузить историю');
  await page.evaluate(() => { getAllHistoryReports = window.originalHistoryRead; });
  await page.click('[data-retry-history]');
  await page.waitForSelector('.history-comment-field');
  assert.equal(await page.locator('#historyList').getAttribute('aria-busy'), 'false');
  assert.deepEqual(errors, []);
  console.log('History loading browser checks passed:', corporate ? 'corporate' : 'public');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  child?.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
