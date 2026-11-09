// Corporate login, editable local profile and independent administrator permissions.
// Real local HTTP and signed S3 fixture; no external systems or user data.
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { passwordHash } = require('../admin/server');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corporate-profile-browser-'));
const screenshots = process.env.QA_REPORT_SCREENSHOTS;
let app, browser;
async function main() {
  const password = crypto.randomBytes(24).toString('hex'), salt = crypto.randomBytes(16).toString('hex');
  const configFile = path.join(temp, 'admin.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, path: '/owner', username: 'owner', passwordSalt: salt,
    passwordHash: await passwordHash(password, salt), visitorSecret: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 });
  const keyFile = path.join(temp, 'jira.pem');
  fs.writeFileSync(keyFile, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const s3Log = path.join(temp, 's3.log'); fs.writeFileSync(s3Log, '');
  const loginPassword = crypto.randomBytes(24).toString('hex');
  app = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/corporate-s3-preload.cjs'), 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', AUTH_SECRET: crypto.randomBytes(32).toString('hex'), AUTH_SECRET_FILE: '',
      DEV_LOGIN_EMAIL: 'qa@example.test', DEV_LOGIN_PASSWORD: loginPassword, REPORTS_DB_PATH: path.join(temp, 'reports.sqlite'),
      QA_ADMIN_CONFIG_FILE: configFile, QA_REPORT_PUBLIC_URL: '', APP_PUBLIC_URL: '', PUBLIC_URL: '', QA_REPORT_TRUST_PROXY: 'false',
      JIRA_INSTANCES_JSON: JSON.stringify([{ id: 'jira-7', name: 'Jira 7', version: '7.3.2', baseUrl: 'https://jira7.example.test' }, { id: 'jira-8', name: 'Jira 8', version: '8.11.1', baseUrl: 'https://jira8.example.test' }]),
      JIRA_OAUTH_PRIVATE_KEY_FILE: keyFile, JIRA_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), JIRA_TOKEN_ENCRYPTION_KEY_FILE: '',
      QA_STORAGE_ENDPOINT: 'https://storage.example.test', QA_STORAGE_BUCKET: 'corporate-fixture-bucket', QA_STORAGE_REGION: 'eu-central-1',
      QA_STORAGE_ACCESS_KEY: 'corporate-fixture-access', QA_STORAGE_SECRET_KEY: 'corporate-fixture-secret', QA_STORAGE_ACCESS_KEY_FILE: '', QA_STORAGE_SECRET_KEY_FILE: '',
      QA_REPORT_TEST_S3: 'enabled', QA_REPORT_TEST_S3_LOG: s3Log },
  });
  let stderr = '';
  app.stderr.on('data', bytes => { stderr += bytes; });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + stderr)), 10000);
    app.stdout.on('data', bytes => { const match = /QA Report: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(bytes)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    app.once('exit', code => { clearTimeout(timer); reject(new Error('Server exit: ' + code + ' ' + stderr)); });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const shot = async (name, locator) => { if (screenshots) { fs.mkdirSync(screenshots, { recursive: true }); await (locator || page).screenshot({ path: path.join(screenshots, name + '.png') }); } };
  await page.goto(origin); await page.locator('#loginForm').waitFor();
  await page.fill('#loginEmail', 'qa@example.test'); await page.fill('#loginPassword', loginPassword); await page.click('#loginSubmit');
  await page.waitForSelector('.cell-editor');
  const openProfile = async () => {
    await page.click('#corporateProfileButton');
    await page.waitForFunction(() => !document.querySelector('#corporateProfileSave').disabled && document.querySelector('#corporateProfileEmail').textContent === 'qa@example.test');
  };
  await openProfile();
  await page.fill('#corporateFirstName', 'Анна'); await page.fill('#corporateLastName', 'Тест'); await page.click('#corporateProfileSave');
  await page.waitForFunction(() => document.querySelector('#corporateProfileMessage').textContent === 'Имя и фамилия сохранены.');
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#cc3344'; paint.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.setInputFiles('#corporateProfileAvatarFile', { name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.querySelector('#corporateProfileMessage').textContent === 'Аватар обновлён.');
  assert.equal(await page.locator('#corporateProfileDialog [data-corporate-avatar]').isVisible(), true);
  assert.equal(await page.locator('#corporateProfileButton svg').isVisible(), false);
  await shot('profile-desktop', page.locator('#corporateProfileDialog'));
  await page.reload(); await page.waitForSelector('.cell-editor'); await openProfile();
  assert.equal(await page.inputValue('#corporateFirstName'), 'Анна');
  assert.equal(await page.locator('#corporateProfileButton [data-corporate-avatar]').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#corporateProfileDialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await shot('profile-mobile', page.locator('#corporateProfileDialog'));
  await page.click('#corporateProfileSettings'); await page.locator('[data-settings-section="jira"]').click();
  await page.waitForFunction(() => document.querySelector('#jiraConnections').textContent.includes('Jira 8'));
  await shot('jira-mobile'); await page.evaluate(() => closeJiraSettings());
  await page.setViewportSize({ width: 1440, height: 1000 }); await openProfile();
  await page.click('#corporateProfileAdmin'); await page.locator('#login-panel').waitFor();
  // An ordinary AD session alone has not opened the administrator dashboard.
  assert.equal(await page.locator('#dashboard').isVisible(), false);
  await page.fill('#username', 'owner'); await page.fill('#password', password); await page.click('#login-submit');
  await page.locator('#dashboard').waitFor(); await page.waitForFunction(() => !document.querySelector('#publish-enabled').disabled && document.querySelector('#users tr'));
  const row = page.locator('#users tr').filter({ hasText: 'qa@example.test' });
  assert.match(await row.innerText(), /Анна Тест/);
  await page.check('#cloud-enabled'); await page.waitForFunction(() => document.querySelector('#cloud-settings-status').textContent.includes('Личное облако: разрешено'));
  const userState = row.locator('[role="status"]');
  await row.getByRole('combobox', { name: 'Публикация по ссылке: qa@example.test', exact: true }).selectOption('deny');
  await userState.getByText('Сохранено', { exact: true }).waitFor();
  const editor = await context.newPage(); editor.on('pageerror', error => errors.push(error.message));
  await editor.goto(origin); await editor.waitForSelector('.cell-editor');
  const availability = await (await context.request.get(origin + '/api/shared-reports/availability')).json();
  assert.equal(availability.publicationDenied, true);
  await editor.click('#publicationMenuButton'); await editor.click('#shareReportButton');
  await editor.waitForFunction(() => document.querySelector('#shareReportStatus').textContent.includes('Для вашего аккаунта отключена публикация'));
  assert.equal(await editor.locator('#shareReportPublish').isDisabled(), true);
  await editor.click('#shareReportClose');
  await row.getByRole('combobox', { name: 'Публикация по ссылке: qa@example.test', exact: true }).selectOption('allow');
  await userState.getByText('Сохранено', { exact: true }).waitFor();
  await page.uncheck('#publish-enabled'); await page.waitForFunction(() => document.querySelector('#cloud-settings-status').textContent.includes('Публикация по ссылке: приостановлена'));
  assert.equal((await (await context.request.get(origin + '/api/shared-reports/availability')).json()).publicationPaused, true);
  await page.check('#publish-enabled'); await page.waitForFunction(() => document.querySelector('#cloud-settings-status').textContent.includes('Публикация по ссылке: разрешена'));
  await shot('admin-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await shot('admin-mobile');
  await editor.evaluate(async () => {
    draft.sections[0].title = 'Корпоративный отчёт'; draft.sections[0].rows[0].cells.check = '<p>Проверка профиля</p>';
    draft.intro = '<p>Тестовая облачная копия</p>'; render(); await saveDraft();
  });
  await editor.click('#corporateProfileButton'); await editor.locator('#corporateProfileDialog [data-personal-cloud]').click();
  await editor.waitForFunction(() => !document.querySelector('#personalCloudSave').disabled); await editor.click('#personalCloudSave');
  await editor.waitForFunction(() => document.querySelectorAll('.cloud-report').length === 1 && !document.querySelector('#personalCloudSave').disabled);
  const listed = await (await context.request.get(origin + '/api/cloud-reports')).json(); assert.equal(listed.reports.length, 1);
  await editor.click('#personalCloudClose'); await editor.click('#corporateProfileButton');
  await editor.click('#corporateProfileSignOut'); await editor.locator('#loginForm').waitFor();
  assert.equal((await context.request.get(origin + '/api/profile')).status(), 401);
  // The independent administrator cookie remains scoped to its own area.
  await page.click('#logout'); await page.locator('#login-panel').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: corporate login, profile name/avatar/reload/mobile, two Jira connections, independent admin login, directory and individual/global policy, cloud save and logout');
}
main().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (screenshots && browser) { fs.mkdirSync(screenshots, { recursive: true }); await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {}); }
}).finally(async () => {
  await browser?.close();
  if (app && app.exitCode === null) { const ended = new Promise(resolve => app.once('exit', resolve)); app.kill(); await ended; }
  fs.rmSync(temp, { recursive: true, force: true });
});
