// Real browser regression for large reports, using an isolated database and synthetic attachments.
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
const output = process.env.QA_REPORT_INPUT_RESULTS;
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
    if (url.origin === origin && url.pathname === '/app.js' && process.env.QA_REPORT_INPUT_BASELINE) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.QA_REPORT_INPUT_BASELINE, 'utf8') });
    return url.origin === origin ? route.continue() : route.abort();
  });
  page.setDefaultTimeout(10000);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const fileData = 'data:text/plain;base64,' + 'YWFh'.repeat(100000);
  const legacy = { schemaVersion: 2, reportId: 'legacy-report', draftId: 'legacy-draft', publicId: 'abcd1234',
    revision: 7, updatedAt: '2025-04-12T12:00:00.000Z', lastSavedBy: 'legacy-tab', lastSavedClientId: 'legacy-browser',
    issueUrl: 'QA-123', environment: 'STAGE', overallStatus: 'НЕ ПРОВЕРЕНО', numberingMode: 'manual',
    intro: '<p>Legacy introduction</p>', customMetadata: { source: 'fixture', nested: [1, 2] },
    sections: [{ id: 'legacy-section', title: 'Legacy checklist', collapsed: false,
      columns: [{ id: 'text', name: 'Old column name', width: 333, required: true, type: 'richtext' },
        { id: 'attachment', title: 'Files', width: 400 }],
      rows: Array.from({ length: 12 }, (_, i) => ({ id: `legacy-row-${i}`, manualNumber: `4.${i + 1}`,
        status: i === 4 ? 'НЕ ОК' : 'НЕ ПРОВЕРЕНО', customRow: { legacy: i },
        cells: { text: i === 0 ? `<figure class="cell-image" contenteditable="false" data-align="left"><img src="${png}" alt="fixture" data-attachment-id="legacy-image" data-file-name="fixture.png" data-mime-type="image/png"></figure><p>Legacy text</p>`
          : i === 1 ? '<pre data-qa-code-snippet="true" data-language="javascript"><code>const legacy = true;</code></pre>' : `<p>Row ${i}</p>`,
          attachment: i < 4 ? `<figure class="cell-file" contenteditable="false" data-attachment-id="legacy-file-${i}" data-file-name="legacy.txt" data-file-size="300000" data-mime-type="text/plain" data-data-url="${fileData}"><span>legacy.txt</span></figure>` : '' } })) }] };
  // Seed the complete old localStorage format before the new app starts. No
  // locator or new database is supplied, so this also exercises first-save compatibility.
  await context.addInitScript(value => {
    if (!localStorage.getItem('compatibility-fixture-seeded')) {
      localStorage.setItem('qa-report-editor-draft-v2', JSON.stringify(value));
      localStorage.setItem('compatibility-fixture-seeded', 'true');
    }
  }, legacy);
  await page.goto(origin);
  const selector = 'tr[data-row-id="legacy-row-2"] .cell-editor[data-column-id="text"]';
  await page.waitForSelector(selector);
  await page.evaluate(() => { cloudHistoryEnabled = false; });
  const expected = await page.evaluate(() => draftContentSnapshot());
  assert.equal(expected.reportId, legacy.reportId);
  assert.equal(expected.draftId, legacy.draftId);
  assert.equal(expected.publicId, legacy.publicId);
  assert.equal(expected.sections[0].columns[0].title, 'Old column name');
  assert.equal(expected.sections[0].columns[0].width, 333);
  assert.deepEqual(expected.customMetadata, legacy.customMetadata);
  assert.equal(expected.sections[0].rows[0].cells.text.includes(png), true);
  assert.equal(expected.sections[0].rows[0].cells.attachment.includes(fileData), true);
  assert.equal(expected.sections[0].rows[1].cells.text.includes('const legacy = true;'), true);
  const waitSaved = () => page.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent.includes('Updated legacy text'));
  await page.locator(selector).fill('Updated legacy text');
  await waitSaved();
  const firstRecord = await page.evaluate(async () => (await getReportRecord(draft.reportId)));
  assert.equal(firstRecord.schemaVersion, 3, 'same format used before these optimizations');
  assert.equal(firstRecord.document.reportId, legacy.reportId);
  assert.equal(firstRecord.document.sections[0].rows[0].cells.attachment, expected.sections[0].rows[0].cells.attachment);
  assert.equal(firstRecord.document.sections[0].rows[0].cells.text, expected.sections[0].rows[0].cells.text);
  assert.deepEqual(firstRecord.document.sections[0].rows[4].customRow, expected.sections[0].rows[4].customRow);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(STORAGE_KEY)).revision), 7,
    'large autosave preserves the complete legacy fallback instead of replacing it with a pointer');
  assert.equal(await page.evaluate(async () => (await getReportMetadata(draft.reportId)).document.revision), firstRecord.document.revision);
  assert.equal(await page.evaluate(() => Boolean(reportMetadataWorker) && !reportMetadataWorkerDisabled), true,
    'Chrome uses the metadata worker');

  await page.evaluate(() => undo());
  assert.equal(await page.locator(selector).innerText(), 'Row 2');
  await page.waitForFunction(() => !hasUnsavedLocalChanges);
  await page.evaluate(() => redo());
  assert.equal(await page.locator(selector).innerText(), 'Updated legacy text');
  await waitSaved();
  const saved = await page.evaluate(async () => { flushDraftFromDom(); await saveDraft(); return draftContentSnapshot(); });
  const comparable = value => { const copy = structuredClone(value); copy.sections[0].rows[2].cells.text = 'EDITED'; return copy; };
  assert.deepEqual(comparable(saved), comparable(expected), 'all unedited legacy fields survive save and undo/redo');

  // Root URL recovery uses the optional locator only after a successful commit.
  await page.evaluate(() => { localStorage.removeItem(STORAGE_KEY); flushPendingDraftSave = () => false; });
  await page.goto(origin);
  await page.waitForFunction(() => htmlToText(draft.sections[0]?.rows[2]?.cells.text || '') === 'Updated legacy text');
  assert.deepEqual(await page.evaluate(() => draftContentSnapshot()), saved);

  // The existing IndexedDB schema and complete record remain readable without
  // any new locator, matching a tester upgrading from an earlier build.
  await page.evaluate(() => {
    localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(DRAFT_LOCATION_KEY);
    flushPendingDraftSave = () => false; // do not reseed either key on navigation
  });
  await page.goto(origin + '/report/abcd1234');
  await page.waitForFunction(() => htmlToText(draft.sections[0]?.rows[2]?.cells.text || '') === 'Updated legacy text');
  assert.deepEqual(await page.evaluate(() => draftContentSnapshot()), saved);
  assert.equal(await page.evaluate(async () => (await openDatabase()).version), 1);

  // A second window receives a small commit notification and reads the durable
  // report, including all existing attachments. No full report is broadcast.
  const other = await context.newPage();
  await other.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await other.goto(origin + '/report/abcd1234');
  await other.waitForSelector(selector);
  await other.evaluate(() => { cloudHistoryEnabled = false; });
  await page.evaluate(() => {
    window.sentDraftMessages = [];
    const original = draftSyncChannel.postMessage.bind(draftSyncChannel);
    draftSyncChannel.postMessage = message => { window.sentDraftMessages.push(message); original(message); };
  });
  await page.locator(selector).fill('From first window');
  await other.waitForFunction(() => htmlToText(draft.sections[0]?.rows[2]?.cells.text || '') === 'From first window');
  assert.equal(await other.evaluate(() => draft.sections[0].rows[0].cells.attachment), saved.sections[0].rows[0].cells.attachment);
  const messages = await page.evaluate(() => window.sentDraftMessages);
  assert.equal(messages.length > 0, true);
  assert.equal(messages.every(message => !message.draft && JSON.stringify(message).length < 1024), true);

  await other.evaluate(() => { flushPendingDraftSave = () => false; });
  await other.close();

  // Simulate a delayed notification from a still-open older application tab.
  await page.evaluate(() => {
    const remote = copyDraftValue(draft); remote.revision += 10; remote.updatedAt = new Date().toISOString();
    remote.lastSavedBy = 'previous-build'; remote.lastSavedClientId = 'legacy-browser'; remote.intro = '<p>Older tab message</p>';
    return handleDraftSyncMessage({ type: 'draft-updated', storageKey: STORAGE_KEY, draft: remote });
  });
  assert.equal(await page.locator('#introEditor').innerText(), 'Older tab message');

  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const sanitation = await page.evaluate(async () => {
      const normalized = normalizeDraft(draft);
      let calls = 0;
      const original = sanitizeRichHtml;
      sanitizeRichHtml = value => { calls++; return original(value); };
      try {
        const unchanged = normalizeDraft(normalized);
        const unchangedCalls = calls;
        unchanged.sections[0].rows[2].cells.text = '<p onclick="evil()"><a href="javascript:evil()">Changed</a></p>';
        const checked = normalizeDraft(unchanged);
        return { unchangedCalls, changedCalls: calls - unchangedCalls, html: checked.sections[0].rows[2].cells.text };
      } finally { sanitizeRichHtml = original; }
    });
    assert.equal(sanitation.unchangedCalls, 0);
    assert.equal(sanitation.changedCalls, 1);
    assert.equal(sanitation.html.includes('onclick'), false);
    assert.equal(sanitation.html.includes('javascript:'), false);
  }
  // Exercise the actual PWA cache as well as a running editor without network.
  const pwaContext = await browser.newContext({ serviceWorkers: 'allow' });
  await pwaContext.addCookies(await context.cookies(origin));
  const pwaPage = await pwaContext.newPage();
  await pwaPage.goto(origin);
  await pwaPage.waitForSelector('#settingsButton');
  await pwaPage.evaluate(async () => { await navigator.serviceWorker.ready; });
  await pwaPage.waitForFunction(async () => {
    const keys = await caches.keys();
    for (const key of keys) if (await (await caches.open(key)).match('/draft-storage-worker.js?v=1')) return true;
    return false;
  });
  await pwaPage.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await pwaPage.evaluate(async value => { cloudHistoryEnabled = false; applyDraftLocally(value); await saveDraft(); }, legacy);
  await pwaContext.setOffline(true);
  if (!fs.existsSync(path.join(root, 'auth.js'))) {
    await pwaPage.reload(); // corporate navigation intentionally requires online authorization
    await pwaPage.waitForSelector(selector);
  }
  await pwaPage.locator(selector).fill('PWA offline edit');
  await pwaPage.waitForFunction(() => !hasUnsavedLocalChanges && historyCurrent.includes('PWA offline edit'));
  assert.equal(await pwaPage.evaluate(async () => htmlToText((await getReportRecord(draft.reportId)).document.sections[0].rows[2].cells.text)), 'PWA offline edit');
  assert.equal(await pwaPage.evaluate(() => Boolean(reportMetadataWorker) && !reportMetadataWorkerDisabled), true);
  assert.equal(await pwaPage.evaluate(() => draft.sections[0].rows[0].cells.attachment.includes('data:text/plain;base64,')), true);
  await pwaContext.setOffline(false);
  await pwaContext.close();
  console.log('PASS: PWA caches the metadata worker and saves existing attachments while offline');
  assert.deepEqual(errors, []);
  console.log('PASS: legacy localStorage and IndexedDB, original IDs and metadata, images/files/code, autosave, undo/redo and root recovery');
  console.log('PASS: compact two-window sync, older-tab messages and corporate HTML validation');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
