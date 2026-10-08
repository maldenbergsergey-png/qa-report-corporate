// Synthetic publication workflow; all external traffic is blocked.
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
const api = require(path.join(root, 'jira-publication'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-jira-publication-'));
let child, browser;
(async () => {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', AUTH_SECRET: secret, AUTH_SECRET_FILE: '',
    DEV_LOGIN_EMAIL: 'qa@example.com', DEV_LOGIN_PASSWORD: crypto.randomBytes(24).toString('hex'),
    REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'), QA_REPORT_PUBLIC_URL: origin,
    QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '', QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
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
  if (corporate) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  let creates = 0, updates = 0, preflights = 0;
  const comments = new Map();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (/\/api\/(?:agent\/)?jira\/(?:update-comment|comment)$/.test(url.pathname)) {
      const body = route.request().postDataJSON();
      let id, publishedAt;
      if (url.pathname.endsWith('/update-comment')) {
        id = String(body.commentId);
        assert.equal(api.fingerprint(comments.get(id)), body.expectedBodyHash);
        if (body.checkOnly) { preflights++; return route.fulfill({ json: { ok: true, verified: true, commentId: id } }); }
        updates++; publishedAt = '2026-10-08T10:00:00.000Z';
      } else { creates++; id = String(10000 + creates); publishedAt = `2026-10-08T09:0${creates}:00.000Z`; }
      comments.set(id, body.comment.body);
      return route.fulfill({ status: url.pathname.endsWith('/update-comment') ? 200 : 201, json: {
        apiRevision: 9, verified: true, commentId: id, bodyHash: api.fingerprint(body.comment.body), publishedAt,
        commentUrl: api.commentUrl(body.issueUrl, id),
      } });
    }
    return route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin); await page.waitForSelector('.cell-editor');
  async function prepare() {
    await page.evaluate(() => {
      cloudHistoryEnabled = false;
      isJiraReadyToPublish = async () => true;
      uploadPendingImages = async () => {};
      window.open = () => null;
      if (typeof jiraSettings !== 'undefined') jiraSettings = { transport: 'agent', baseUrl: 'https://jira.example', type: 'data-center' };
      if (typeof validateJiraSettings === 'function') validateJiraSettings = () => {};
    });
  }
  await prepare();
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-1');
  await page.fill('#environment', 'STAGE'); await page.selectOption('#overallStatus', 'НЕ ОК');
  await page.locator('.cell-editor').first().fill('Ошибка сохранения настроек');
  await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(creates, 1); assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
  const first = await page.evaluate(() => structuredClone(draft.jiraPublication));
  assert.equal(first.firstPublishedAt, '2026-10-08T09:01:00.000Z');
  assert.match(await page.locator('#publicationInfo').innerText(), /Опубликован/);
  await page.click('#publishCancelButton');
  await page.locator('.cell-editor').first().fill('Проверка после исправления');
  await page.click('#copyMenuButton'); await page.click('#publishExportButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(creates, 1); assert.equal(updates, 1); assert.equal(preflights, 1);
  assert.equal(await page.evaluate(() => draft.jiraPublication.firstPublishedAt), first.firstPublishedAt);
  assert.equal(await page.evaluate(() => draft.jiraPublication.lastPublishedAt), '2026-10-08T10:00:00.000Z');
  await page.click('#publishCancelButton');
  await page.reload(); await page.waitForSelector('.cell-editor'); await prepare();
  assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
  await page.evaluate(() => openHistory());
  assert.equal(await page.locator('.history-publication-info a').first().getAttribute('href'), 'https://jira.example/browse/QA-1?focusedCommentId=10001#comment-10001');
  assert.match(await page.locator('.history-publication-info').first().innerText(), /Опубликован[\s\S]*Обновлён/);
  await page.evaluate(() => closeHistory());
  await page.click('#publicationMenuButton'); await page.click('#publishAgainButton');
  assert.equal(await page.locator('#confirmModal').isVisible(), true);
  await page.click('#acceptConfirmButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(creates, 2); assert.equal(comments.size, 2); assert.equal(await page.evaluate(() => draft.jiraPublication.parts[0].commentId), '10002');
  await page.click('#publishCancelButton');
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-2');
  assert.equal(await page.locator('#publishButton').innerText(), 'Опубликовать отчёт');
  await page.fill('#issueUrl', 'https://jira.example/browse/QA-1');
  assert.equal(await page.locator('#publishButton').innerText(), 'Обновить отчёт');
  // Verify the real server round trip and the lighter history-list response.
  const persisted = await page.evaluate(async () => {
    const document = structuredClone(draft), id = crypto.randomUUID();
    document.reportId = id; document.publicId = createPublicId();
    document.jiraPublication.reportId = id; document.jiraPublication.token = "should-not-persist";
    await reportApi("/api/reports", { method: "POST", body: JSON.stringify({ id, document }) });
    const { reports } = await reportApi("/api/reports");
    const { report } = await reportApi("/api/reports/" + id);
    const list = reports.find(record => record.id === id);
    await reportApi("/api/reports/" + id, { method: "DELETE" });
    return { list: list.jiraPublication, document: report.document.jiraPublication };
  });
  assert.equal(persisted.list.parts[0].commentId, '10002');
  assert.deepEqual(persisted.document, persisted.list);
  assert.equal(JSON.stringify(persisted).includes('should-not-persist'), false);
  const screenshots = process.env.QA_REPORT_SCREENSHOTS;
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const bounds = await page.locator('.report-heading').evaluate(node => [...node.querySelectorAll('button, a, time')].map(child => ({ left: child.getBoundingClientRect().left, right: child.getBoundingClientRect().right })));
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width), `${theme}/${width}: heading overflow`);
    if (screenshots) await page.locator('.report-heading').screenshot({ animations: 'disabled', path: path.join(screenshots, `${corporate ? 'corporate' : 'public'}-${theme}-${width}.png`) });
    await page.click('#publicationMenuButton');
    assert.equal(await page.locator('#publishAgainButton').isVisible(), true);
    const placement = await page.locator('.report-publication-buttons').evaluate(node => {
      const trigger = node.querySelector('#publicationMenuButton').getBoundingClientRect(), menu = node.querySelector('#publicationMenu').getBoundingClientRect();
      const main = getComputedStyle(node.querySelector('#publishButton')), arrow = getComputedStyle(node.querySelector('#publicationMenuButton'));
      return { triggerBottom: trigger.bottom, menuTop: menu.top, menuLeft: menu.left, menuRight: menu.right, mainColor: main.color, arrowColor: arrow.color };
    });
    assert.ok(placement.menuTop >= placement.triggerBottom && placement.menuLeft >= 0 && placement.menuRight <= width);
    assert.equal(placement.mainColor, placement.arrowColor);

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#publicationMenu').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'publicationMenuButton');
  }
  await page.evaluate(() => openHistory());
  await page.getByRole('button', { name: 'Копия', exact: true }).first().click();
  await page.waitForFunction(() => draft.jiraPublication === null);
  assert.equal(await page.locator('#publishButton').innerText(), 'Опубликовать отчёт');
  assert.deepEqual(errors, []);
  console.log(`${corporate ? 'Corporate' : 'Public'} publication UI: create, update, new comment, persistence, history, copy and responsive layout OK`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); child?.kill();
  if (child) await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});
