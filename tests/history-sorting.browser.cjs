// History sorting and meaningful modification regression. All data is synthetic and external requests are blocked.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-sorting-'));
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
  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    clearTimeout(saveTimer); clearTimeout(historyTimer);
    await draftWriteQueue;
    await clearReportHistory();
    const dates = [['2026-09-01T10:00:00.000Z', '2026-10-07T10:00:00.000Z'],
      ['2026-10-06T10:00:00.000Z', '2026-10-06T10:00:00.000Z'],
      ['2026-10-05T10:00:00.000Z', '2026-10-05T10:00:00.000Z']];
    const keys = ['SHOP-1', 'SHOP-2', 'APP-3'];
    const records = dates.map(([createdAt, updatedAt], index) => {
      const document = normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: `sort-${index}`,
        draftId: `sort-draft-${index}`, publicId: `def000${index + 1}`, issueUrl: keys[index], updatedAt });
      return { id: document.reportId, publicId: document.publicId, document, createdAt, updatedAt,
        issueKey: keys[index], title: `${keys[index]} — ${document.environment}`, issueUrl: keys[index], historyComment: '' };
    });
    await dbTransaction('readwrite', store => records.forEach(record => store.put(record)));
    applyDraftLocally(records[0].document);
    await saveDraft({ collect: false });
  });
  const order = () => page.locator('.history-item h3').allTextContents();
  const open = async () => { await page.click('#historyButton'); await page.waitForSelector('.history-note-edit'); };
  const close = () => page.click('#closeHistoryButton');
  const record = id => page.evaluate(id => getReportRecord(id), id);
  const screenshot = async name => {
    if (!process.env.QA_REPORT_SCREENSHOTS) return;
    fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, `${name}.png`) });
  };
  const controlsFit = () => page.locator('.history-modal').evaluate(modal => {
    const bounds = modal.getBoundingClientRect();
    return modal.scrollWidth <= modal.clientWidth && [...modal.querySelectorAll('input, select, button, .history-item')]
      .filter(node => node.getBoundingClientRect().width > 0).every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      }) && document.getElementById('historyList').scrollWidth <= document.getElementById('historyList').clientWidth;
  });
  await open();
  assert.equal(await page.locator('#clearHistoryButton').count(), 0);
  assert.equal(await page.inputValue('#historySort'), 'updated');
  assert.deepEqual(await order(), ['SHOP-1', 'SHOP-2', 'APP-3']);
  assert.equal((await record('sort-0')).updatedAt, '2026-10-07T10:00:00.000Z');
  assert.equal(await page.locator('.history-item').first().locator('time').first().getAttribute('datetime'), '2026-09-01T10:00:00.000Z');
  assert.equal(await page.locator('.history-item').first().locator('time').nth(1).getAttribute('datetime'), '2026-10-07T10:00:00.000Z');
  await page.selectOption('#historySort', 'created');
  await page.waitForFunction(() => document.querySelector('.history-item h3')?.textContent === 'SHOP-2');
  assert.deepEqual(await order(), ['SHOP-2', 'APP-3', 'SHOP-1']);
  await page.click('#historySelectionToggle');
  await page.locator('[data-history-select="sort-0"]').check();
  await page.selectOption('#historySort', 'updated');
  await page.waitForFunction(() => document.querySelector('.history-item h3')?.textContent === 'SHOP-1');
  assert.equal(await page.locator('[data-history-select="sort-0"]').isChecked(), true);
  await page.selectOption('#historyProjectFilter', 'SHOP');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2);
  await page.fill('#historySearch', 'SHOP-2');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
  assert.match(await page.locator('#historySelectionCount').innerText(), /Скрыто фильтром: 1/);
  await page.fill('#historySearch', '');
  await page.selectOption('#historyProjectFilter', '');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 3);
  await close();
  await open();
  const second = page.locator('.history-item').filter({ has: page.locator('h3', { hasText: /^SHOP-2$/ }) });
  await second.getByRole('button', { name: 'Редактор', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('historyModal').hidden && document.getElementById('issueUrl').value === 'SHOP-2');
  await page.evaluate(() => draftWriteQueue);
  assert.equal((await record('sort-1')).updatedAt, '2026-10-06T10:00:00.000Z');
  await page.reload();
  await page.waitForSelector('.cell-editor');
  await page.evaluate(async () => { await openReportFromRoute(); await draftWriteQueue; });
  await open();
  assert.deepEqual(await order(), ['SHOP-1', 'SHOP-2', 'APP-3']);
  assert.equal((await record('sort-1')).updatedAt, '2026-10-06T10:00:00.000Z');
  await close();
  // A real editor input advances the date while preserving creation.
  await page.locator('.cell-editor').first().fill('Changed check');
  await page.evaluate(async () => { clearTimeout(saveTimer); await saveDraft(); await draftWriteQueue; });
  const edited = await record('sort-1');
  assert.ok(edited.updatedAt > '2026-10-06T10:00:00.000Z');
  assert.equal(edited.createdAt, '2026-10-06T10:00:00.000Z');
  await open();
  assert.deepEqual(await order(), ['SHOP-2', 'SHOP-1', 'APP-3']);
  assert.equal((await record('sort-1')).updatedAt, edited.updatedAt);
  const third = page.locator('.history-item').filter({ has: page.locator('h3', { hasText: /^APP-3$/ }) });
  await third.locator('.history-note-edit').click();
  await third.locator('textarea').fill('Changed history comment');
  await page.evaluate(() => flushVisibleHistoryComments());
  const commented = await record('sort-2');
  assert.ok(commented.updatedAt > edited.updatedAt);
  assert.equal(await third.locator('time').nth(1).getAttribute('datetime'), commented.updatedAt);
  await close(); await open();
  assert.deepEqual(await order(), ['APP-3', 'SHOP-2', 'SHOP-1']);
  // Both themes and the graphite palette use explicit, theme-aware button surfaces.
  for (const theme of ['light', 'dark', 'graphite']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.click('#historySelectionToggle');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(180);
    const active = await page.locator('#historySelectionToggle').evaluate(node => ({
      color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
      primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    }));
    assert.equal(active.primary === '#ef4444' ? active.color === 'rgb(239, 68, 68)' : true, true);
    assert.notEqual(active.background, 'rgba(0, 0, 0, 0)');
    assert.equal(await controlsFit(), true);
    await screenshot(`${theme}-history-selected`);
    await page.click('#historySelectionToggle');
    await page.mouse.move(0, 0); await page.waitForTimeout(180);
    assert.equal(await page.locator('#historySelectionToggle').evaluate(node => getComputedStyle(node).backgroundColor
      === getComputedStyle(document.querySelector('.history-item')).backgroundColor), true);
    await screenshot(`${theme}-history`);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await controlsFit(), true);
    await page.click('#historySelectionToggle');
    await page.mouse.move(0, 0); await page.waitForTimeout(180);
    assert.equal(await controlsFit(), true);
    assert.equal(await page.locator('#historySelectionToggle').getAttribute('aria-pressed'), 'true');
    await screenshot(`${theme}-mobile-history-selected`);
    await page.click('#historySelectionToggle');
    await page.setViewportSize({ width: 1600, height: 1000 });
  }
  await close();
  // Reloading browser history keeps creation, edit and note dates intact.
  // Personal cloud transport and conflicts are covered by personal-cloud.browser.cjs.
  await page.reload();
  await page.waitForSelector('.cell-editor');
  await open();
  assert.equal((await record('sort-1')).createdAt, edited.createdAt);
  assert.equal((await record('sort-1')).updatedAt, edited.updatedAt);
  assert.equal((await record('sort-2')).updatedAt, commented.updatedAt);
  assert.equal(await page.locator('.history-item').count(), 3);
  assert.deepEqual(errors, []);
  console.log('History sorting browser checks passed:', corporate ? 'corporate' : 'public');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  child?.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
