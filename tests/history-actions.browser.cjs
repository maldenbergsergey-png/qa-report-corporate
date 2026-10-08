// History publication metadata and actions; synthetic fixtures, no external requests.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-actions-'));
const screenshots = process.env.QA_REPORT_SCREENSHOTS;
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
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('.cell-editor');
  const seed = async () => page.evaluate(async () => {
    cloudHistoryEnabled = false;
    queueServerReportSave = () => {};
    await clearReportHistory();
    const reports = [0, 1, 2, 3, 4, 5].map(index => {
      const document = normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: `history-${index}`,
        draftId: `draft-${index}`, publicId: `abc000${index + 1}`, issueUrl: `https://jira.example/browse/QA-${index + 1}`,
        environment: 'STAGE', overallStatus: 'OK', createdAt: '2026-10-07T10:00:00.000Z',
        updatedAt: `2026-10-08T10:0${5 - index}:00.000Z` });
      if (index === 0 || index === 2) document.jiraPublication = {
        reportId: document.reportId, issueUrl: document.issueUrl, format: 'wiki',
        firstPublishedAt: '2026-10-08T08:00:00.000Z', lastPublishedAt: '2026-10-08T09:00:00.000Z',
        parts: [{ commentId: String(10001 + index), bodyHash: 'a'.repeat(64), publishedAt: '2026-10-08T09:00:00.000Z' }] };
      return { id: document.reportId, publicId: document.publicId, document, jiraPublication: document.jiraPublication,
        title: `QA-${index + 1}`, issueKey: `QA-${index + 1}`, issueUrl: document.issueUrl,
        createdAt: document.createdAt, updatedAt: document.updatedAt, historyComment: index === 0 ? 'Ожидает ретеста' : '' };
    });
    await dbTransaction('readwrite', store => reports.forEach(report => store.put(report)));
    applyDraftLocally(reports[0].document);
    getServerReports = async () => [];
  });
  await seed();
  const open = async () => { await page.click('#historyButton'); await page.waitForSelector('.history-comment-field'); };
  const screenshot = async name => {
    if (screenshots) { fs.mkdirSync(screenshots, { recursive: true });
      await page.locator('.history-modal').screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' }); }
  };
  await open();
  const first = page.locator('.history-item').filter({ has: page.locator('h3', { hasText: /^QA-1$/ }) });
  const link = first.getByRole('link', { name: 'Комментарий в Jira', exact: true });
  assert.equal(await link.getAttribute('href'), 'https://jira.example/browse/QA-1?focusedCommentId=10001#comment-10001');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await first.locator('.history-publication-dates time').nth(0).getAttribute('datetime'), '2026-10-08T08:00:00.000Z');
  assert.equal(await first.locator('.history-publication-dates time').nth(1).getAttribute('datetime'), '2026-10-08T09:00:00.000Z');
  assert.equal(await page.locator('.history-publication-info').count(), 2);
  assert.deepEqual(await first.locator('.history-action > svg use').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['#icon-eye', '#icon-link', '#icon-copy']);
  assert.equal(await first.getByRole('button', { name: 'Удалить', exact: true }).count(), 0);
  // The overflow menu is reachable by keyboard and Escape closes it without closing history.
  const more = first.getByRole('button', { name: /^Другие действия/ });
  await more.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await first.getByRole('menuitem', { name: 'Удалить', exact: true }).isVisible(), true);
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#historyModal').isVisible(), true);
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await more.evaluate(node => document.activeElement === node), true);
  await more.click();
  await page.click('#historyTitle');
  assert.equal(await first.getByRole('menu').isVisible(), false);
  await more.click();
  await page.locator('#historyList').evaluate(node => { node.scrollTop += 60; });
  await page.waitForFunction(() => !document.querySelector('.history-action-menu:popover-open'));
  await first.scrollIntoViewIfNeeded();
  // Existing clipboard action refers to this record and preserves the open report.
  await page.evaluate(() => { window.copiedHistoryLink = ''; writeClipboardText = async text => { window.copiedHistoryLink = text; }; });
  await first.getByRole('button', { name: 'Копировать ссылку', exact: true }).click();
  assert.equal(await page.evaluate(() => copiedHistoryLink), `${origin}/report/abc0001`);
  assert.equal(await page.evaluate(() => draft.reportId), 'history-0');
  await first.locator('.history-comment-field').fill('Ретест после исправления');
  await first.getByRole('button', { name: 'Открыть', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#historyModal').hidden);
  assert.equal(await page.evaluate(() => draft.reportId), 'history-0');
  assert.equal(await page.evaluate(() => draft.jiraPublication.parts[0].commentId), '10001');
  assert.equal(await page.evaluate(async () => (await getReportRecord('history-0')).historyComment), 'Ретест после исправления');
  await open();
  // Wide and narrow cards fit each theme; menus remain visible at the bottom of the list.
  for (const width of [1600, 1000, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await first.scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.history-list').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      assert.equal(await page.locator('.history-item').evaluateAll(cards => cards.every(card => {
        const rect = card.getBoundingClientRect();
        return [...card.querySelectorAll('.history-comment-field, .history-action, .history-more-button, .history-publication-link')]
          .every(node => { const box = node.getBoundingClientRect(); return box.left >= rect.left && box.right <= rect.right; });
      })), true);
      await page.evaluate(() => document.activeElement?.blur());
      await screenshot(`${theme}-${width}`);
      const last = page.locator('.history-item').last();
      await last.scrollIntoViewIfNeeded();
      await last.getByRole('button', { name: /^Другие действия/ }).click();
      const menu = last.getByRole('menu');
      assert.equal(await menu.isVisible(), true);
      assert.equal(await menu.evaluate(node => {
        const r = node.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
          && node.contains(document.elementFromPoint(r.left + 12, r.top + 12));
      }), true);
      if (theme === 'graphite') await screenshot(`menu-${width}`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#historyModal').isVisible(), true);
    }
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await first.scrollIntoViewIfNeeded();
  await first.getByRole('button', { name: 'Копия', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#historyModal').hidden);
  assert.notEqual(await page.evaluate(() => draft.reportId), 'history-0');
  assert.equal(await page.evaluate(() => draft.jiraPublication), null);
  await open();
  const target = page.locator('.history-item').filter({ has: page.locator('h3', { hasText: /^QA-6$/ }) });
  await target.getByRole('button', { name: /^Другие действия/ }).click();
  await target.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
  assert.equal(await page.locator('#confirmModal').isVisible(), true);
  await page.click('#cancelConfirmButton');
  assert.equal(await page.evaluate(async () => Boolean(await getReportRecord('history-5'))), true);
  await target.getByRole('button', { name: /^Другие действия/ }).click();
  await target.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
  await page.click('#acceptConfirmButton');
  await page.waitForFunction(async () => !(await getReportRecord('history-5')));
  // A cleared binding disappears from history even with a stale cloud/document copy.
  await page.evaluate(async () => { await writeJiraPublication({ reportId: 'history-0' }, null); await renderHistoryList(); });
  assert.equal(await first.locator('.history-publication-info').count(), 0);
  await page.click('#closeHistoryButton');
  await page.reload(); await page.waitForSelector('.cell-editor');
  await page.evaluate(() => { cloudHistoryEnabled = false; getServerReports = async () => []; });
  await open();
  assert.equal(await first.locator('.history-publication-info').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed: linked comment and publication dates, icon actions, keyboard menu, clipboard, comments, open, copy, delete confirmation, removed binding, reload, all themes and widths.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
