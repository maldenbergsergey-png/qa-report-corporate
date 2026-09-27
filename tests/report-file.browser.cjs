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
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const parsed = parseJiraMarkup('||Номер||Проверка||Ожидаемый результат||Фактический результат||Комментарий||Статус||\n|4.2|Проверка переноса|Ожидаемый|Фактический|Комментарий|НЕ ОК|');
    const value = importedDraftInCurrentReport({ ...parsed, numberingMode: 'manual' });
    value.environment = 'TEST'; value.issueUrl = 'https://jira.example/browse/QA-123';
    const picture = window.QaReportAttachments.render({ id: 'image-1', name: 'снимок.png', type: 'image/png', size: 68, dataUrl: image });
    const file = window.QaReportAttachments.render({ id: 'file-1', name: 'лог.txt', type: 'text/plain', size: 6, dataUrl: 'data:text/plain;base64,AAECA//+' });
    const empty = window.QaReportAttachments.render({ id: 'empty-1', name: 'пустой.txt', type: 'text/plain', size: 0, dataUrl: 'data:text/plain;base64,' });
    value.intro = '<p><strong>Описание</strong> с форматированием</p>' + picture + file + empty;
    const section = value.sections[0]; section.statusSort = true; section.columns[0].width = 350;
    section.rows[0].cells[section.columns[0].id] += picture + '<pre class="cell-code-block"><code data-language="js">const n = 42;</code></pre>';
    applyDraftLocally(value);
    // This text has not reached the draft or autosave yet.
    elements.introEditor.insertAdjacentHTML('beforeend', '<p>Последняя несохранённая правка</p>');
    return { reportId: draft.reportId, publicId: draft.publicId };
  });
  await page.click('#copyMenuButton');
  const downloadWait = page.waitForEvent('download');
  await page.click('#exportReportButton');
  const download = await downloadWait.catch(async error => { throw new Error(`${error.message}\n${await page.locator('#reportFileError').textContent()}`); });
  assert.match(download.suggestedFilename(), /^QA-123_.*\.report$/);
  const archive = path.join(temp, 'roundtrip.report'); await download.saveAs(archive);
  await page.waitForFunction(() => !reportFileBusy);
  assert.equal(await page.locator('#reportFileError').isVisible(), false);
  assert.match(await page.locator('#reportFileStatus').innerText(), /3 вложений/);
  const expected = await page.evaluate(() => window.QaReportFile.documentFields(draft));
  const manifest = require('../report-file').unzip(new Uint8Array(fs.readFileSync(archive)));
  assert.equal(manifest.size, 5);
  assert.ok(!Buffer.from(manifest.get('report.json')).toString().includes(original.reportId));
  await page.click('#closeReportFileButton');
  // A new browser profile has no report storage, settings or source credentials.
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (fs.existsSync(path.join(root, 'auth.js'))) {
    const { createSessionToken } = require(path.join(root, 'auth'));
    await fresh.addCookies([{ name: 'query-port-session', value: createSessionToken('qa@example.com', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const other = await fresh.newPage(); other.on('pageerror', e => errors.push(e.message));
  const external = [];
  await other.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await other.goto(origin); await other.waitForSelector('#settingsButton');
  const previous = await other.evaluate(() => { elements.introEditor.innerHTML = '<p>Сохранить прежний отчёт</p>'; return draft.reportId; });
  await other.setInputFiles('#reportFileInput', archive);
  await other.waitForFunction(() => !reportFileBusy && document.getElementById('reportFileStatus').textContent.includes('Открыта отдельная копия'));
  const restored = await other.evaluate(async () => ({ value: window.QaReportFile.documentFields(draft), reportId: draft.reportId, publicId: draft.publicId,
    before: (await getAllReports()).find(r => r.document.intro.includes('Сохранить прежний отчёт')) }));
  assert.notEqual(restored.reportId, original.reportId); assert.notEqual(restored.publicId, original.publicId);
  assert.equal(restored.before.id, previous);
  assert.equal(restored.value.environment, expected.environment); assert.equal(restored.value.numberingMode, expected.numberingMode);
  assert.equal(restored.value.sections[0].rows[0].manualNumber, expected.sections[0].rows[0].manualNumber);
  assert.equal(restored.value.sections[0].rows[0].status, expected.sections[0].rows[0].status);
  assert.equal(restored.value.sections[0].statusSort, true);
  assert.equal(restored.value.sections[0].columns[0].width, expected.sections[0].columns[0].width);
  assert.match(restored.value.intro, /Последняя несохранённая правка/);
  const savedAssets = await other.evaluate(() => [...elements.introEditor.querySelectorAll('img,.cell-file')].map(n => n.getAttribute('src') || n.dataset.dataUrl));
  assert.equal(savedAssets.length, 3); assert.ok(savedAssets[1].endsWith('AAECA//+')); assert.equal(savedAssets[2], 'data:text/plain;base64,');
  assert.deepEqual(external, []);
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await other.locator('#reportFileModal .modal').screenshot({ path: path.join(output, 'restored.png') });
    await other.setViewportSize({ width: 390, height: 844 });
    assert.equal(await other.evaluate(() => document.getElementById('reportFileModal').querySelector('.modal').getBoundingClientRect().right <= innerWidth), true);
    await other.locator('#reportFileModal .modal').screenshot({ path: path.join(output, 'mobile.png') });
    await other.setViewportSize({ width: 1440, height: 1000 });
  }
  await other.click('#closeReportFileButton'); await other.reload();
  await other.waitForFunction(id => draft.reportId === id, restored.reportId);
  assert.match(await other.locator('#introEditor').innerText(), /Последняя несохранённая правка/);
  // Damaged archive must not replace the document or change local history.
  const beforeFailure = await other.evaluate(async () => ({ id: draft.reportId, intro: draft.intro, count: (await getAllReports()).length }));
  const damaged = Buffer.from(fs.readFileSync(archive)); damaged[50] ^= 1;
  await other.setInputFiles('#reportFileInput', { name: 'damaged.report', mimeType: 'application/zip', buffer: damaged });
  await other.waitForFunction(() => !reportFileBusy && !document.getElementById('reportFileError').hidden);
  assert.deepEqual(await other.evaluate(async () => ({ id: draft.reportId, intro: draft.intro, count: (await getAllReports()).length })), beforeFailure);
  await other.click('#closeReportFileButton');
  // A failed second write aborts BOTH records and leaves the open editor intact.
  await other.evaluate(() => { window.originalRecord = portableHistoryRecord; portableHistoryRecord = (value, reason, existing) => { if (reason === 'file-import') throw new DOMException('Quota', 'QuotaExceededError'); return window.originalRecord(value, reason, existing); }; });
  await other.setInputFiles('#reportFileInput', archive);
  await other.waitForFunction(() => !reportFileBusy && !document.getElementById('reportFileError').hidden);
  assert.match(await other.locator('#reportFileError').innerText(), /недостаточно места/);
  assert.deepEqual(await other.evaluate(async () => ({ id: draft.reportId, intro: draft.intro, count: (await getAllReports()).length })), beforeFailure);
  await other.evaluate(() => { portableHistoryRecord = window.originalRecord; });
  await other.click('#closeReportFileButton');
  // Explicit Jira reference download and incomplete export. No real Jira is used.
  const remote = await other.evaluate(async () => {
    const snapshot = window.QaReportFile.documentFields(draft); const originalRequest = jiraRequest;
    let calls = 0;
    snapshot.intro = window.QaReportAttachments.reference({ id: 'ref-1', name: 'remote.txt', source: { issueUrl: 'https://jira.example/browse/QA-123', id: '7', name: 'remote.txt', kind: 'file' } });
    jiraRequest = async (endpoint, body) => { calls++; if (endpoint !== '/api/jira/import-attachment' || body.attachmentId !== '7') throw Error('Unexpected transport'); return new Blob(['remote contents'], { type: 'text/plain' }); };
    try {
      const packed = await window.QaReportFile.pack(snapshot, { load: reportAttachmentLoader() });
      const loaded = await window.QaReportFile.unpack(packed.blob);
      jiraRequest = async () => { throw Error('Нет доступа'); };
      let error = ''; try { await window.QaReportFile.pack(snapshot, { load: reportAttachmentLoader() }); } catch (e) { error = e.message; }
      return { calls, intro: loaded.document.intro, error };
    } finally { jiraRequest = originalRequest; }
  });
  assert.equal(remote.calls, 1); assert.match(remote.intro, /data:text\/plain;base64,/); assert.match(remote.error, /remote.txt: Нет доступа/);
  // Storage references use the existing same-origin endpoint and become local bytes.
  await other.route('**/api/storage/object/fixture', route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'storage contents' }));
  const storage = await other.evaluate(async () => {
    const snapshot = window.QaReportFile.documentFields(draft);
    snapshot.intro = '<figure class="cell-file" data-attachment-id="storage-1" data-file-name="storage.txt" data-mime-type="text/plain" data-data-url="/api/storage/object/fixture">storage.txt</figure>';
    const packed = await window.QaReportFile.pack(snapshot, { load: reportAttachmentLoader() });
    return (await window.QaReportFile.unpack(packed.blob)).document.intro;
  });
  assert.match(storage, /data:text\/plain;base64,/); assert.ok(!storage.includes('/api/storage/object/'));
  // Untrusted HTML is cleaned before being placed into the editor.
  const clean = await other.evaluate(async () => {
    const snapshot = window.QaReportFile.documentFields(draft);
    snapshot.intro = '<p onclick="window.compromised=true">Safe<script>window.compromised=true</script><a href="javascript:alert(1)">link</a></p>';
    const packed = await window.QaReportFile.pack(snapshot);
    return (await window.QaReportFile.unpack(packed.blob)).document.intro;
  });
  assert.ok(!/onclick|script|javascript/i.test(clean));
  if (output) {
    await other.setViewportSize({ width: 390, height: 844 });
    await other.click('#copyMenuButton');
    assert.equal(await other.locator('#copyMenu').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true);
    await other.screenshot({ path: path.join(output, 'menu-mobile.png') });
  }
  assert.deepEqual(errors, []);
  console.log('PASS .report: export, isolated-profile import, binary/empty/repeated attachments, reload, atomic quota failure, damaged archive, Jira, storage and HTML safety');
  await fresh.close(); await context.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (child) child.kill();
});
