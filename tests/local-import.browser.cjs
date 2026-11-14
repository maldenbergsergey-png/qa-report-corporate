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
    ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', QA_REPORT_TRUST_PROXY: 'true',
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
  browser = await chromium.launch({ headless: true, channel: process.env.QA_REPORT_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Forwarded-For': '192.0.2.1' } });
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
    if (!await page.locator('#historyModal').isVisible()) await page.click('#historyButton');
    const before = await page.evaluate(() => draft.reportId);
    await page.locator(`[data-history-ai="receiver-${index}"]`).click();
    await page.locator('.history-ai-popover:popover-open').waitFor();
    assert.equal(await page.locator('#historyModal').isVisible(), true);
    assert.equal(await page.locator('#localImportModal').isVisible(), false);
    assert.equal(await page.evaluate(() => draft.reportId), before);
    assert.equal(await page.locator('.history-ai-popover:popover-open .history-ai-report').textContent(), `QA-${101 + index} · abc100${index + 1}`);
    assert.equal(await page.locator('.history-ai-popover:popover-open').evaluate(panel => {
      const hint = panel.querySelector('.history-ai-hint').getBoundingClientRect();
      const buttons = [...panel.querySelectorAll('.history-ai-actions button')].filter(button => !button.hidden);
      return buttons.every(button => button.getBoundingClientRect().top - hint.bottom >= 14);
    }), true, 'AI actions stay separated from their explanation');
  }
  const connections = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')));
  for (let index = 0; index < 3; index++) {
    await open(index);
    assert.equal(await page.locator(`[data-history-ai="receiver-${index}"] .history-ai-indicator`).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(152, 163, 191)');
    if (screenshots && index === 0) {
      fs.mkdirSync(screenshots, { recursive: true });
      await page.locator('.history-ai-popover:popover-open').screenshot({ path: path.join(screenshots, 'history-ai-off.png') });
    }
    await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Включить приём', exact: true }).click();
    await page.waitForFunction(index => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === index + 1, index);
    assert.match(await page.locator('.history-ai-popover:popover-open .history-ai-status').textContent(), /Приём включён/);
    assert.equal(await page.evaluate(() => draft.reportId), 'receiver-0');
  }
  // Popovers remain inside narrow screens in each theme, and Escape preserves history.
  for (const width of [320, 390, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark', 'graphite']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await open(2);
      assert.equal(await page.locator('.history-ai-popover:popover-open').evaluate(panel => {
        const rect = panel.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && panel.scrollWidth <= panel.clientWidth;
      }), true);
      if (screenshots) {
        fs.mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `history-ai-${width}-${theme}.png`) });
        if (width === 1600 && theme === 'graphite') {
          const panel = await page.locator('.history-ai-popover:popover-open').boundingBox();
          const trigger = await page.locator('[data-history-ai="receiver-2"]').boundingBox();
          const left = Math.min(panel.x, trigger.x) - 8, top = Math.min(panel.y, trigger.y) - 8;
          await page.screenshot({ path: path.join(screenshots, 'history-ai-preview.png'), clip: {
            x: left, y: top, width: Math.max(panel.x + panel.width, trigger.x + trigger.width) - left + 8,
            height: Math.max(panel.y + panel.height, trigger.y + trigger.height) - top + 8,
          } });
        }
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#historyModal').isVisible(), true);
    }
  }
  await page.click('#closeHistoryButton');
  const active = await connections();
  assert.equal(active.length, 3);
  // A fresh tab has no reader keys in sessionStorage but can recover this browser's sessions.
  const recovered = await context.newPage();
  await recovered.goto(origin);
  await recovered.waitForSelector('.cell-editor');
  await recovered.evaluate(async () => applyDraftLocally((await getReportRecord('receiver-2')).document));
  await recovered.click('#localImportButton');
  await until(() => recovered.locator('.local-import-report').count().then(count => count === 2));
  assert.equal(await recovered.locator('#startLocalImport').textContent(), 'Возобновить приём');
  await recovered.click('#startLocalImport');
  await recovered.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).find(item => item.reportId === 'receiver-2')?.remote !== true);
  const recoveredConnections = await recovered.evaluate(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).map(item => [item.id, item.expiresAt]));
  assert.deepEqual(recoveredConnections, active.map(item => [item.id, item.expiresAt]));
  await recovered.close();
  assert.match(await page.evaluate(async () => (await getReportRecord('receiver-0')).document.intro), /Unsaved context from open report/);
  // History reflects each connection and reopening it keeps the same key and expiry.
  await page.click('#historyButton');
  await page.locator('[data-history-ai="receiver-0"]').waitFor();
  assert.equal(await page.locator('[data-history-ai][data-state="on"]').count(), 3);
  assert.equal(await page.locator('[data-history-ai="receiver-0"]').textContent(), 'AI');
  assert.equal(await page.locator('[data-history-ai="receiver-0"]').getAttribute('aria-description'), 'Приём включён');
  assert.equal(await page.locator('[data-history-ai="receiver-0"] .history-ai-indicator').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(21, 184, 137)');
  const targetCard = page.locator('.history-item').filter({ has: page.locator('[data-history-ai="receiver-0"]') });
  await targetCard.locator('.history-note-edit').click();
  await targetCard.locator('.history-comment-field').fill('Receive retest results');
  await page.locator('[data-history-ai="receiver-0"]').click();
  assert.equal(await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Скопировать промпт' }).isEnabled(), true);
  await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Скопировать промпт' }).click();
  await until(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('"reportId": "receiver-0"')));
  assert.equal(await page.evaluate(async () => (await getReportRecord('receiver-0')).historyComment), 'Receive retest results');
  assert.deepEqual((await connections()).map(item => [item.id, item.expiresAt]), active.map(item => [item.id, item.expiresAt]));
  await page.click('#closeHistoryButton');
  await page.evaluate(async () => applyDraftLocally((await getReportRecord('receiver-2')).document));
  await page.click('#localImportButton');
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
  // New sessions use the real server clock; restore it after the expiry simulation.
  await page.clock.setSystemTime(new Date());
  // The next history fixture has its own IP budget; report-owner limits stay unchanged.
  await context.setExtraHTTPHeaders({ 'X-Forwarded-For': '192.0.2.2' });
  // A history card must load its document before reception; a failed load keeps the current report.
  await page.click('#closeLocalImport');
  await page.evaluate(async () => {
    window.cloudFixture = normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: 'cloud-receiver',
      draftId: 'cloud-draft', publicId: 'abc1004', issueUrl: 'QA-104', environment: 'STAGE' });
    await saveReportSnapshot('fixture', cloudFixture);
    window.originalGetReportRecord = getReportRecord;
    getReportRecord = async id => {
      if (id === cloudFixture.reportId) throw new Error('Synthetic history load failure');
      return originalGetReportRecord(id);
    };
  });
  const previousId = await page.evaluate(() => draft.reportId);
  await page.click('#historyButton');
  await page.locator('[data-history-ai="cloud-receiver"]').click();
  await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Включить приём', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.history-ai-popover:popover-open .history-ai-status').textContent.includes('Synthetic history load failure'));
  assert.equal(await page.evaluate(() => draft.reportId), previousId);
  assert.equal(await page.locator('#localImportModal').isVisible(), false);
  assert.equal(await page.locator('#historyModal').isVisible(), true);
  await page.evaluate(() => { getReportRecord = originalGetReportRecord; });
  await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Включить приём', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === 1);
  await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Скопировать промпт' }).click();
  await until(() => page.evaluate(async () => (await navigator.clipboard.readText()).includes('"reportId": "cloud-receiver"')));
  assert.equal(await page.evaluate(() => draft.reportId), previousId);
  await page.locator('.history-ai-popover:popover-open').getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-report-local-import-session-v1')).length === 0);
  assert.equal(await page.locator('#historyModal').isVisible(), true);
  assert.equal(await page.evaluate(() => draft.reportId), previousId);
  assert.deepEqual(errors, []);
  console.log('Passed: history AI entry, new-tab recovery, failed history load, unsaved text and comments, three independent connections, prompts and stop by report, unchanged expiry, delivery, reload, three themes and narrow layout.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
