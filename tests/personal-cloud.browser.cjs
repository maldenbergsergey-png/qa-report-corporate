// Synthetic account bridge and in-memory private S3, with the real editor in two browsers.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const { DatabaseSync } = require('node:sqlite');
const { createPersonalCloud, createCloudSettings } = require('../personal-cloud');
const { randomBytes } = require('node:crypto');
const { Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), corporate = fs.existsSync(path.join(root, 'auth.js'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cloud-browser-'));
let child, browser, service;
const db = new DatabaseSync(':memory:');
const settings = createCloudSettings({ getDb: () => db, configured: () => true }); settings.set(true);
const objects = new Map(), errors = [], requests = [];
async function main() {
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, secret = randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
    REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'), QA_ADMIN_CONFIG_FILE: path.join(temp, 'absent.json'),
    QA_REPORT_PUBLIC_URL: origin, AUTH_SECRET: secret, AUTH_SECRET_FILE: '',
    QA_REPORT_S3_CONFIG_FILE: '', CLERK_PUBLISHABLE_KEY: '', CLERK_JWT_KEY: '', CLERK_JWT_KEY_FILE: '',
    QA_STORAGE_ACCESS_KEY: '', QA_STORAGE_SECRET_KEY: '', QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let log = ''; child.stdout.on('data', chunk => { log += chunk; if (log.includes('QA Report:')) resolve(); });
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(temp, 'server.log'), chunk));
    child.once('exit', code => reject(Error(`Server exited ${code}: ${fs.existsSync(path.join(temp, 'server.log')) ? fs.readFileSync(path.join(temp, 'server.log'), 'utf8') : ''}`)));
    setTimeout(() => reject(Error('startup timeout')), 10_000).unref();
  });
  service = createPersonalCloud({ getDb: () => db, settings,
    authenticate: req => req.session, validateWrite: req => { assert.equal(req.headers['x-qa-cloud'], '1'); assert.equal(req.headers.origin, origin); },
    readJson: async req => req.body, sendJson: (res, status, data) => { res.status = status; res.json = data; },
    storage: () => ({ activeBucketId: 'test', async put(key, bytes) { objects.set(key, bytes); return { bucketId: 'test', key }; },
      async get({ key }) { return new Response(objects.get(key)); }, async remove({ key }) { objects.delete(key); } }),
  });
  browser = await chromium.launch({ headless: true });
  async function context(owner = 'owner-a', viewport = { width: 1450, height: 1000 }) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    if (corporate) {
      const { createSessionToken } = require('../auth');
      await ctx.addCookies([{ name: 'query-port-session', value: createSessionToken(owner + '@example.test', { env: { AUTH_SECRET: secret } }), url: origin, httpOnly: true, sameSite: 'Lax' }]);
    }
    await ctx.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!corporate && url.pathname === '/api/shared-reports/account') return route.fulfill({ json: { publishableKey: 'pk_test_fixture' } });
      if (!corporate && url.pathname === '/report-account-dialog.js') return route.fulfill({ contentType: 'text/javascript', body: `
        export async function observeProfile(key, callback) { callback({ id: '${owner}', firstName: 'Тест', lastName: 'Автор', email: '${owner}@example.test', avatar: null }); }
        export async function sessionToken() { return 'fixture-session'; }
      ` });
      if (!corporate && url.pathname === '/api/profile/admin') return route.fulfill({ json: { path: '/owner/' } });

      if (!url.pathname.startsWith('/api/cloud-reports')) return route.continue();
      requests.push([owner, req.method(), url.pathname]);
      const chunks = [], response = new Writable({ write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); } });
      response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
      try {
        await service.handle({ session: owner, method: req.method(), headers: req.headers(), body: req.postDataJSON() || {} }, response, url.pathname);
        await route.fulfill({ status: response.status || 200, headers: response.headers || { 'Content-Type': 'application/json' },
          body: response.json ? JSON.stringify(response.json) : Buffer.concat(chunks) });
      } catch (error) { await route.fulfill({ status: error.status || 400, json: { error: error.message } }); }
    });
    const page = await ctx.newPage(); page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.stack); }); page.setDefaultTimeout(12_000);
    await page.goto(origin); await page.waitForSelector('.cell-editor');
    return { ctx, page };
  }
  const a = await context();
  assert.equal(await a.page.locator('[data-settings-section="history"], [data-settings-section="files"], #googleStorageEnabled, #yandexStorageEnabled').count(), 0);
  await a.page.evaluate(() => { openJiraSettings(); saveJiraSettings(); });
  assert.equal(await a.page.locator('.settings-save-label').textContent(), 'Сохранено');
  await a.page.evaluate(() => closeJiraSettings());
  await a.page.evaluate(async () => {
    draft.sections[0].title = 'Личный чек-лист'; draft.sections[0].rows[0].cells.check = '<p>Первое устройство</p>';
    draft.sections[0].rows[0].status = 'НЕ ОК'; draft.sections[0].rows[0].manualNumber = '8.3'; draft.numberingMode = 'manual';
    draft.intro = window.QaReportAttachments.render({ id: 'image-1', name: 'tiny.png', type: 'image/png', size: 68,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' });
    render(); await saveDraft();
    await personalCloud.open();
  });
  await a.page.click('#personalCloudSave');
  await a.page.waitForFunction(() => document.getElementById('personalCloudStatus').textContent === 'Отчёт сохранён в личном облаке.');
  assert.equal(db.prepare('SELECT revision FROM personal_cloud_reports').get().revision, 1); assert.equal(objects.size, 1);
  const originalId = db.prepare('SELECT id FROM personal_cloud_reports').get().id;
  await a.page.click('#personalCloudClose');
  await a.page.evaluate(async () => { draft.sections[0].rows[0].cells.check = '<p>Изменено на первом</p>'; render(); await saveDraft(); await personalCloud.tick(); });
  assert.equal(db.prepare('SELECT revision FROM personal_cloud_reports').get().revision, 2);
  assert.equal(requests.filter(([, method, url]) => method === 'GET' && url.endsWith(originalId)).length, 0, 'background save must not pull a cloud report into the editor');
  const b = await context();
  if (corporate) {
    await b.page.click('#corporateProfileButton');
    await b.page.locator('#corporateProfileDialog [data-personal-cloud]').click();
  } else {
    await b.page.click('#profileButton'); await b.page.click('#openProfilePage');
    await b.page.waitForSelector('#profileAdminLink', { state: 'visible' });
    assert.equal(await b.page.locator('#profileAdminLink').evaluate(element => getComputedStyle(element).textDecorationLine), 'none');
    await b.page.locator('#profilePage [data-personal-cloud]').click();
  }
  await b.page.locator('.cloud-report button').filter({ hasText: /^Открыть$/ }).click();
  await b.page.waitForFunction(() => !document.getElementById('personalCloudDialog').open);
  const restored = await b.page.evaluate(() => ({ check: draft.sections[0].rows[0].cells.check, number: draft.sections[0].rows[0].manualNumber, intro: draft.intro, mode: draft.numberingMode }));
  assert.equal(await b.page.locator('#profilePage').count() ? await b.page.locator('#profilePage').isHidden() : true, true);
  assert.match(restored.check, /Изменено на первом/); assert.equal(restored.number, '8.3'); assert.equal(restored.mode, 'manual'); assert.match(restored.intro, /data:image\/png;base64/);
  await b.ctx.setOffline(true);
  await b.page.evaluate(async () => { draft.sections[0].rows[0].cells.check = '<p>Второе устройство офлайн</p>'; render(); await saveDraft(); await personalCloud.tick(); });
  assert.equal(db.prepare('SELECT revision FROM personal_cloud_reports').get().revision, 2);
  await b.ctx.setOffline(false);
  await b.page.waitForFunction(() => !document.getElementById('personalCloudStatus').classList.contains('cloud-error'));
  await b.page.evaluate(async () => { await personalCloud.tick(); });
  // The online event may have started the same save first.
  for (let i = 0; i < 30 && db.prepare('SELECT revision FROM personal_cloud_reports').get().revision < 3; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(db.prepare('SELECT revision FROM personal_cloud_reports').get().revision, 3);
  await a.page.evaluate(async () => { draft.sections[0].rows[0].cells.check = '<p>Конфликт первого устройства</p>'; render(); await saveDraft(); await personalCloud.tick(); });
  assert.equal(db.prepare('SELECT revision FROM personal_cloud_reports').get().revision, 3);
  assert.match(db.prepare('SELECT document_json FROM personal_cloud_reports').get().document_json, /Второе устройство офлайн/);
  assert.match(await a.page.evaluate(() => draft.sections[0].rows[0].cells.check), /Конфликт/);
  await a.page.evaluate(() => personalCloud.open());
  await a.page.waitForFunction(() => document.getElementById('personalCloudCurrent').textContent.includes('остановлено'));
  await a.page.click('#personalCloudCopy');
  await a.page.waitForFunction(() => document.querySelectorAll('.cloud-report').length === 2 && !document.getElementById('personalCloudSave').disabled);
  assert.equal(db.prepare('SELECT count(*) AS n FROM personal_cloud_reports WHERE revision>0').get().n, 2);
  const c = await context('owner-b'); await c.page.evaluate(() => personalCloud.open());
  assert.equal(await c.page.locator('.cloud-report').count(), 0);
  assert.equal(await c.page.evaluate(async id => (await fetch('/api/cloud-reports/' + id)).status, originalId), 403);
  const localCount = await a.page.evaluate(async () => (await getAllReports()).length);
  a.page.once('dialog', dialog => dialog.accept());
  await a.page.locator('.cloud-report').first().getByRole('button', { name: /Удалить из облака/ }).click();
  await a.page.waitForFunction(() => document.querySelectorAll('.cloud-report').length === 1 && !document.getElementById('personalCloudRefresh').disabled);
  assert.equal(await a.page.evaluate(async () => (await getAllReports()).length), localCount);
  if (process.env.QA_REPORT_SCREENSHOTS) {
    fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
    await a.page.locator('#personalCloudDialog').screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, `cloud-${corporate ? 'corporate' : 'public'}-desktop.png`) });
    await a.page.setViewportSize({ width: 390, height: 844 });
    await a.page.locator('#personalCloudDialog').screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, `cloud-${corporate ? 'corporate' : 'public'}-mobile.png`) });
  }
  assert.equal(await a.page.evaluate(() => document.getElementById('personalCloudDialog').scrollWidth <= document.getElementById('personalCloudDialog').clientWidth + 1), true);
  assert.deepEqual(errors, []);
  console.log(`${corporate ? 'Corporate' : 'Public'}: two-device cloud save/open, attachments, offline edits, revision conflict, independent copy, access isolation, deletion and mobile layout passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await service?.close(); db.close(); child?.kill(); fs.rmSync(temp, { recursive: true, force: true });
});
