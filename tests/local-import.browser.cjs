// AI reception: real browser, isolated backend and synthetic reports only.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ai-reception-'));
const screenshots = process.env.QA_REPORT_SCREENSHOTS;
let child, browser;
async function until(predicate) {
  const limit = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > limit) throw new Error('Timed out waiting for durable receipt');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

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
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.install({ time: new Date() });
  await page.goto(origin);
  await page.waitForSelector('.cell-editor');

  await page.evaluate(async () => {
    cloudHistoryEnabled = false;
    for (let index = 0; index < 3; index++) {
      applyDraftLocally(normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: `receiver-${index}`,
        draftId: `draft-${index}`, publicId: `abc100${index + 1}`,
        issueUrl: `https://jira.example/browse/QA-${101 + index}`, environment: 'STAGE' }));
      await saveReportSnapshot('fixture');
    }
    applyDraftLocally((await getReportRecord('receiver-0')).document);
  });
  await page.locator('#introEditor').fill('Unsaved context from open report');
  async function open(index) {
    if (await page.locator('#localImportModal').isVisible()) await page.click('#closeLocalImport');
    await page.click('#historyButton');
    const button = page.locator(`[data-history-ai="receiver-${index}"]`);
    await button.waitFor();
    await button.click();
    await page.locator('#localImportModal').waitFor();
    assert.equal(await page.locator('#historyModal').isVisible(), false);
    assert.equal(await page.evaluate(() => draft.reportId), `receiver-${index}`);
    assert.equal(await page.locator('#localImportReport').textContent(), `QA-${101 + index} · abc100${index + 1}`);
  }
  const connections = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')));
  for (let index = 0; index < 3; index++) {
    await open(index);
    await page.click('#startLocalImport');
    await page.waitForFunction(index => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === index + 1, index);
    assert.equal(await page.locator('#localImportCountdown').isVisible(), true);
    assert.match(await page.locator('#localImportRemaining').textContent(), /^0[45]:[0-5]\d:[0-5]\d$/);
  }
  const active = await connections();
  assert.equal(active.length, 3);
  assert.match(await page.evaluate(async () => (await getReportRecord('receiver-0')).document.intro), /Unsaved context from open report/);
  // History reflects each connection and reopening it keeps the same key and expiry.
  await page.click('#closeLocalImport');
  await page.click('#historyButton');
  await page.locator('[data-history-ai="receiver-0"]').waitFor();
  assert.equal(await page.locator('[data-history-ai][data-state="on"]').count(), 3);
  assert.equal(await page.locator('[data-history-ai="receiver-0"]').textContent(), 'AI · ON');
  const targetCard = page.locator('.history-item').filter({ has: page.locator('[data-history-ai="receiver-0"]') });
  await targetCard.locator('.history-comment-field').fill('Receive retest results');
  await page.locator('[data-history-ai="receiver-0"]').click();
  assert.equal(await page.locator('#copyLocalImport').isEnabled(), true);
  await page.click('#copyLocalImport');
  await until(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('"reportId": "receiver-0"')));
  assert.equal(await page.evaluate(async () => (await getReportRecord('receiver-0')).historyComment), 'Receive retest results');
  assert.deepEqual((await connections()).map(item => [item.id, item.expiresAt]), active.map(item => [item.id, item.expiresAt]));
  await open(2);
  assert.equal(await page.locator('.local-import-report').count(), 2);
  const before = await page.locator('#localImportRemaining').textContent();
  await page.clock.fastForward(2100);
  assert.notEqual(await page.locator('#localImportRemaining').textContent(), before);
  const send = (connection, suffix, options = {}) => fetch(connection.connection.url + suffix, {
    ...options, headers: { 'X-QA-Import-Token': connection.connection.token, 'Content-Type': 'application/json', ...options.headers },
  });
  for (let index = 0; index < 3; index++) {
    const payload = { id: `batch-${index}`, kind: 'checklist', format: 'jira',
      content: `||Check||Actual||\n|Only report ${index}|Received ${index}|`, attachmentIds: [] };
    const response = await send(active[index], '/batches', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(response.status, 202);
  }
  await until(() => page.evaluate(async () => {
    const records = await Promise.all([0, 1, 2].map(index => getReportRecord(`receiver-${index}`)));
    return records.every((record, index) => JSON.stringify(record).includes(`Received ${index}`));
  }));
  await until(() => page.evaluate(async active => {
    const receipts = await Promise.all(active.map(async (item, index) => {
      const response = await fetch(`${item.connection.url}/batches/batch-${index}`, { headers: { 'X-QA-Import-Token': item.connection.token } });
      return response.json();
    }));
    return receipts.every(item => item.status === 'saved');
  }, active));
  for (let index = 0; index < 3; index++) {
    assert.equal((await (await send(active[index], `/batches/batch-${index}`)).json()).status, 'saved');
    const result = await (await send(active[index], '/context')).json();
    assert.equal(result.reportId, `receiver-${index}`);
    assert.ok(JSON.stringify(result.context).includes(`Received ${index}`));
  }
  assert.equal(await page.evaluate(() => draft.reportId), 'receiver-2');
  assert.equal(await page.locator('#localImportCountdown').isVisible(), true);
  assert.match(await page.locator('#localImportStatus').textContent(), /сохранены/);
  // Both current and background prompt buttons identify their own report.
  await page.click('[data-import-copy="receiver-0"]');
  await until(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('"reportId": "receiver-0"')));
  await page.click('#copyLocalImport');
  await until(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('"reportId": "receiver-2"')));
  // A concurrent edit or deletion must fail in the same IndexedDB transaction as the write.
  assert.deepEqual(await page.evaluate(async () => {
    const record = await getReportRecord('receiver-0');
    const candidate = clone(record.document); candidate.intro = '<p>Agent overwrite</p>';
    const changed = clone(record); changed.document.intro = '<p>Other tab edit</p>';
    await dbTransaction('readwrite', store => store.put(changed));
    let conflict = false, deletion = false;
    try { await saveReportSnapshot('local-agent-import', candidate, { expectedDocument: record.document }); }
    catch (error) { conflict = Boolean(error.localImportRetryable); }
    const retained = (await getReportRecord(record.id)).document.intro;
    await dbTransaction('readwrite', store => store.delete(record.id));
    try { await saveReportSnapshot('local-agent-import', candidate, { expectedDocument: record.document }); }
    catch (error) { deletion = Boolean(error.localImportRetryable); }
    const absent = !(await getReportRecord(record.id));
    const newerMetadata = { ...changed, historyComment: 'Retest tomorrow' };
    await dbTransaction('readwrite', store => store.put(newerMetadata));
    await saveReportSnapshot('local-agent-import', candidate, { expectedDocument: changed.document });
    const retainedComment = (await getReportRecord(record.id)).historyComment;
    return { conflict, deletion, retained, absent, retainedComment };
  }), { conflict: true, deletion: true, retained: '<p>Other tab edit</p>', absent: true, retainedComment: 'Retest tomorrow' });
  // Check the modal at narrow and wide widths, including all supported themes.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.equal(await page.locator('#localImportModal .modal').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      assert.equal(await page.locator('#localImportModal .modal').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true);
      if (screenshots) {
        fs.mkdirSync(screenshots, { recursive: true });
        await page.locator('#localImportModal .modal').screenshot({ path: path.join(screenshots, `ai-${corporate ? 'corporate' : 'public'}-${width}-${theme}.png`) });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('[data-import-stop="receiver-0"]');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === 2);
  assert.equal((await send(active[0], '/context')).status, 404);
  assert.equal((await send(active[1], '/context')).status, 200);
  await page.click('#closeLocalImport');
  await page.click('#historyButton');
  await page.locator('[data-history-ai="receiver-0"]').waitFor();
  assert.equal(await page.locator('[data-history-ai="receiver-0"]').getAttribute('data-state'), 'off');
  assert.equal(await page.locator('[data-history-ai][data-state="on"]').count(), 2);
  await page.click('#closeHistoryButton');
  const expiresAt = (await connections()).map(item => item.expiresAt);
  await page.reload();
  await page.waitForSelector('.cell-editor');
  assert.deepEqual((await connections()).map(item => item.expiresAt), expiresAt);
  await page.click('#localImportButton');
  assert.equal(await page.locator('#localImportCountdown').isVisible(), true);
  assert.equal(await page.locator('.local-import-report').count(), 1);
  await page.clock.fastForward(5 * 3600_000 + 1000);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === 0);
  assert.equal(await page.locator('#localImportCountdown').isVisible(), false);
  assert.equal(await page.locator('#startLocalImport').isEnabled(), true);
  assert.match(await page.locator('#localImportStatus').textContent(), /истёк/);
  // A cloud card must load its document before reception; a failed load keeps the current report.
  await page.click('#closeLocalImport');
  await page.evaluate(() => {
    window.cloudFixture = normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: 'cloud-receiver',
      draftId: 'cloud-draft', publicId: 'abc1004', issueUrl: 'QA-104', environment: 'STAGE' });
    getServerReports = async () => [{ id: cloudFixture.reportId, publicId: cloudFixture.publicId,
      title: 'QA-104', issueKey: 'QA-104', source: 'server', updatedAt: new Date().toISOString() }];
    getServerReport = async () => { throw new Error('Synthetic history load failure'); };
  });
  const previousId = await page.evaluate(() => draft.reportId);
  await page.click('#historyButton');
  await page.locator('[data-history-ai="cloud-receiver"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Synthetic history load failure'));
  assert.equal(await page.evaluate(() => draft.reportId), previousId);
  assert.equal(await page.locator('#localImportModal').isVisible(), false);
  assert.equal(await page.locator('#historyModal').isVisible(), true);
  await page.evaluate(() => { getServerReport = async () => ({ id: cloudFixture.reportId, document: clone(cloudFixture) }); });
  await page.locator('[data-history-ai="cloud-receiver"]').click();
  await page.locator('#localImportModal').waitFor();
  assert.equal(await page.locator('#localImportReport').textContent(), 'QA-104 · abc1004');
  assert.equal(await page.evaluate(async () => (await getReportRecord('cloud-receiver')).document.reportId), 'cloud-receiver');
  await page.click('#startLocalImport');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === 1);
  await page.click('#copyLocalImport');
  await until(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('"reportId": "cloud-receiver"')));
  assert.deepEqual(errors, []);
  console.log('Passed: history AI entry, local/cloud reports, failed load, unsaved text and comments, three independent connections, prompts and stop by report, unchanged expiry, delivery, reload, three themes and narrow layout.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
