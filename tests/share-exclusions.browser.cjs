// Publish an isolated report and update its row exclusions through the real editor.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-share-exclusions-'));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await context.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const requests = [], publications = new Map(), snapshots = new Map(), errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/shared-reports/availability') return route.fulfill({ json: { ok: true, enabled: true, requiresPublishToken: false } });
    if (url.pathname === '/api/shared-reports/prepare') {
      const body = route.request().postDataJSON();
      requests.push(body);
      const date = new Date(Date.UTC(2026, 10, 10, 9, requests.length)).toISOString();
      const previous = body.update && publications.get(body.update.id);
      if (previous) assert.equal(body.update.ownerToken, previous.ownerToken);
      const publication = previous ? { ...previous, updatedAt: date } : {
        id: crypto.randomBytes(16).toString('hex'), createdAt: date,
        ownerToken: crypto.randomBytes(32).toString('base64url'), replyToken: crypto.randomBytes(32).toString('base64url'),
      };
      publications.set(publication.id, publication);
      snapshots.set(publication.id, body.snapshot);
      return route.fulfill({ json: { ok: true, publication } });
    }
    if (/^\/api\/shared-reports\/[a-f0-9]{32}\/author$/.test(url.pathname)) return route.fulfill({ json: { ok: true, email: 'qa@example.test' } });
    if (/^\/api\/shared-reports\/[a-f0-9]{32}$/.test(url.pathname)) return route.fulfill({ json: { report: {
      ...snapshots.get(url.pathname.split('/').at(-1)), canReply: true, answers: [],
    } } });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForSelector('#settingsButton');
  await page.evaluate(() => {
    cloudHistoryEnabled = false;
    const columns = [{ id: 'check', title: 'Проверка' }];
    const row = (id, text, status = 'НЕ ОК') => ({ id, status, cells: { check: text } });
    applyDraftLocally({ ...draft, draftId: crypto.randomUUID(), reportId: crypto.randomUUID(), issueUrl: '', intro: '', numberingMode: 'section', sections: [
      { id: 'ios', title: 'iOS', columns, rows: [
        { ...row('backend', '<p>Серверная проверка</p><figure class="cell-file" data-file-name="backend.log" data-mime-type="text/plain" data-data-url="data:text/plain;base64,bG9n">backend.log</figure>'),
          bugs: [{ key: 'QA-17', issueUrl: 'https://tracker.example.test/browse/QA-17' }] },
        row('ui', 'Проверка интерфейса', 'OK'), row('last', 'Последняя проверка', 'OK'),
      ] },
      { id: 'android', title: 'Android', columns, rows: [row('android-first', 'Проверка Android')] },
      { id: 'service', title: 'Служебный раздел', columns, rows: [row('service-first', 'Служебная проверка')] },
    ] });
  });
  const open = async () => {
    await page.click('#publicationMenuButton');
    await page.click(await page.locator('#shareReportManageLink').isVisible() ? '#shareReportManageLink' : '#shareReportButton');
    await page.waitForFunction(() => shareReportContext?.enabled);
  };
  const submit = async () => {
    await page.click('#shareReportPublish');
    await page.waitForFunction(() => !shareReportBusy && !shareReport.Latest.hidden && shareReport.Error.hidden);
  };
  const exclude = (section, row) => page.locator(`#shareReportExclusionList input[data-section-id="${section}"][data-row-id="${row}"]`);
  await open();
  await page.click('#shareReportExclusionSummary');
  assert.match(await exclude('ios', 'backend').getAttribute('aria-label'), /1\. iOS · пункт 1\./);
  assert.match(await exclude('android', 'android-first').getAttribute('aria-label'), /2\. Android · пункт 1\./);
  await page.fill('#shareReportExclusionSearch', 'серверная');
  assert.equal(await page.locator('#shareReportExclusionList label:visible').count(), 1);
  await exclude('ios', 'backend').check();
  await page.fill('#shareReportExclusionSearch', 'Служебный раздел');
  await exclude('service', 'service-first').check();
  await page.fill('#shareReportExclusionSearch', 'нет такого пункта');
  assert.equal(await page.locator('#shareReportExclusionEmpty').isVisible(), true);
  await page.fill('#shareReportExclusionSearch', '');
  assert.equal(await page.locator('#shareReportExclusionSummary').textContent(), 'Исключить пункты · 2');
  await page.locator('#shareReportStatuses input[value="НЕ ОК"]').check();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.locator('.share-report-dialog').evaluate(dialog => {
      const box = dialog.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
    });
    assert.equal(fits, true);
    await page.locator('#shareReportExclusions').evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(os.tmpdir(), path.basename(root) + '-exclusions-' + width + '.png') });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await submit();
  assert.equal(requests.length, 1);
  const first = requests[0].snapshot;
  assert.deepEqual(first.sections.map(section => [section.id, section.rows.map(row => [row.id, row.number])]), [
    ['ios', [['ui', '2.'], ['last', '3.']]], ['android', [['android-first', '1.']]],
  ]);
  assert.deepEqual(requests[0].files, []);
  assert.ok(!JSON.stringify(requests[0]).includes('backend.log'));
  assert.ok(!JSON.stringify(first).includes('QA-17'));
  const publication = [...publications.values()][0];
  const stored = await page.evaluate(() => sharedPublications(draft.reportId)[0]);
  assert.deepEqual(stored.excludedRows, [{ sectionId: 'ios', rowId: 'backend' }, { sectionId: 'service', rowId: 'service-first' }]);
  assert.equal(await page.evaluate(() => draft.sections.reduce((n, section) => n + section.rows.length, 0)), 5);
  assert.equal(await page.evaluate(() => sharePublicationState(sharedPublications(draft.reportId)[0]).state), 'current');
  const shared = await context.newPage();
  shared.on('pageerror', error => errors.push(error.message));
  await shared.goto(`${origin}/shared-report/${publication.id}#${publication.replyToken}`);
  await shared.locator('#report').waitFor();
  await shared.locator('#report-filter summary').click();
  await shared.click('#report-filter-reset');
  assert.equal(await shared.locator('#report-count').textContent(), '3 из 3');
  assert.ok(!(await shared.locator('#report').textContent()).includes('Серверная проверка'));
  assert.ok(!(await shared.locator('#report').textContent()).includes('Служебная проверка'));
  await shared.close();
  await page.click('#shareReportClose');
  await page.reload();
  await page.waitForSelector('#settingsButton');
  await page.evaluate(() => {
    // Exclusions follow row IDs across section reordering and manual numbering.
    const next = copyDraftValue(draft);
    next.sections.reverse(); next.sections.find(section => section.id === 'ios').rows.reverse();
    ChecklistNumbering.setMode(next, 'manual');
    next.sections.find(section => section.id === 'ios').rows.find(row => row.id === 'backend').manualNumber = 'BE-7';
    applyDraftLocally(next);
  });
  await open();
  await page.click('#shareReportUpdate');
  assert.equal(await exclude('ios', 'backend').isChecked(), true);
  assert.match(await exclude('ios', 'backend').getAttribute('aria-label'), /BE-7/);
  assert.equal(await exclude('service', 'service-first').isChecked(), true);
  assert.equal(await exclude('android', 'android-first').isChecked(), false);
  // Removing an exclusion brings back only that point; the same URL is updated.
  await exclude('service', 'service-first').uncheck();
  await submit();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].update.id, publication.id);
  assert.equal(publications.size, 1);
  assert.ok(requests[1].snapshot.sections.some(section => section.id === 'service'));
  assert.ok(!JSON.stringify(requests[1].snapshot).includes('Серверная проверка'));
  await page.click('#shareReportUpdate');
  // Empty publication is rejected without sending a request or changing the draft.
  for (const input of await page.locator('#shareReportExclusionList input').all()) await input.check();
  await page.click('#shareReportPublish');
  await page.locator('#shareReportError').filter({ hasText: 'В публикации должен остаться хотя бы один заполненный пункт.' }).waitFor();
  assert.equal(requests.length, 2);
  await page.click('#shareReportExclusionReset');
  assert.equal(await page.locator('#shareReportExclusionList input:checked').count(), 0);
  await submit();
  assert.equal(requests[2].snapshot.sections.flatMap(section => section.rows).length, 5);
  assert.equal(requests[2].files.length, 1);
  assert.deepEqual(await page.evaluate(() => sharedPublications(draft.reportId)[0].excludedRows), []);
  await page.click('#shareReportClose');
  await page.click('#publicationMenuButton');
  await page.click('#shareReportNewLink');
  await page.waitForFunction(() => shareReportContext?.enabled);
  assert.equal(await page.locator('#shareReportExclusionList input:checked').count(), 0);
  await page.click('#shareReportExclusionSummary');
  await exclude('android', 'android-first').check();
  await submit();
  assert.equal(publications.size, 2);
  assert.deepEqual(await page.evaluate(() => sharedPublications(draft.reportId)[0].excludedRows), [{ sectionId: 'android', rowId: 'android-first' }]);
  await page.selectOption('#shareReportLinkSelect', publication.id);
  await page.click('#shareReportUpdate');
  assert.equal(await page.locator('#shareReportExclusionList input:checked').count(), 0);
  await page.click('#shareReportCancelUpdate');
  await page.click('#shareReportClose');
  // Compare changes only in published points, using exactly the same exclusion scope.
  const changes = await page.evaluate(() => {
    const scope = { includeImages: true, includeFiles: true, excludedRows: [{ sectionId: 'ios', rowId: 'backend' }] };
    const before = sharedContentSnapshot(draft, sharedSnapshotOptions(draft, scope));
    const next = copyDraftValue(draft);
    const ios = next.sections.find(section => section.id === 'ios');
    ios.rows.find(row => row.id === 'backend').cells.check = 'Новая серверная ошибка';
    const hidden = sharedContentSnapshot(next, sharedSnapshotOptions(next, scope));
    ios.rows.find(row => row.id === 'ui').cells.check = 'Новая ошибка интерфейса';
    const visible = sharedContentSnapshot(next, sharedSnapshotOptions(next, scope));
    return { hidden: QaReportJiraPublication.contentChanges(before, hidden), visible: QaReportJiraPublication.contentChanges(before, visible) };
  });
  assert.deepEqual(changes.hidden, []);
  assert.ok(changes.visible.length > 0);
  assert.deepEqual(errors, []);
  console.log('PASS: scoped exclusions, payload and attachment omission, shared view, persistence, renumbering, updates, reset, empty guard and mobile layout');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
