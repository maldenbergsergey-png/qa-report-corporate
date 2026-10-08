// History loading regression. All data is synthetic and external requests are blocked.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-projects-'));
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
  // Use real IndexedDB for existing reports and synthetic cloud metadata.
  const seed = async () => page.evaluate(async () => {
    await clearReportHistory();
    const keys = ['SHOP-1', 'shop-2', 'APP-3', ''];
    const reports = keys.map((key, index) => {
      const document = normalizeDraft({ ...clone(DEFAULT_DRAFT),
        reportId: `fixture-${index}`, draftId: `draft-${index}`, publicId: `abc000${index + 1}`,
        issueUrl: index === 1 ? `https://tasks.example.test/project/Task/${key}` : key,
        environment: 'STAGE', updatedAt: '2026-10-08T09:00:00.000Z',
      });
      return { id: document.reportId, publicId: document.publicId, document,
        issueKey: key.toUpperCase(), issueUrl: document.issueUrl,
        title: key || 'Без задачи', historyComment: index === 1 ? 'Ретест оплаты' : '',
        updatedAt: document.updatedAt };
    });
    await dbTransaction('readwrite', store => reports.forEach(report => store.put(report)));
    applyDraftLocally(reports[0].document);
    window.cloudFixture = [{ id: 'cloud', publicId: 'abc0005', issueKey: 'CLOUD-5',
      title: 'Облачный чек-лист', updatedAt: '2026-10-08T08:00:00.000Z', source: 'server' }];
    getServerReports = async () => window.cloudFixture;
  });
  const useCloud = async () => page.evaluate(() => {
    getServerReports = async () => [{ id: 'cloud', publicId: 'abc0005', issueKey: 'CLOUD-5',
      title: 'Облачный чек-лист', updatedAt: '2026-10-08T08:00:00.000Z', source: 'server' }];
  });
  const openProjects = async () => {
    await page.click('#settingsButton');
    await page.click('[data-settings-section="projects"]');
    await page.waitForSelector('[data-project-key="SHOP"]');
  };
  const openHistory = async () => {
    await page.click('#historyButton');
    await page.waitForSelector('.history-comment-field');
  };
  const screenshot = async name => {
    if (!process.env.QA_REPORT_SCREENSHOTS) return;
    fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, `${name}.png`) });
  };
  const controlsFit = selector => page.locator(selector).evaluate(modal => {
    const bounds = modal.getBoundingClientRect();
    return modal.scrollWidth <= modal.clientWidth && [...modal.querySelectorAll('input, select, button, .history-item')]
      .filter(node => node.getBoundingClientRect().width > 0).every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
  });
  await seed();
  const oldDocument = await page.evaluate(async () => JSON.stringify((await getReportRecord('fixture-1')).document));
  await openHistory();
  assert.equal(await page.locator('.history-item').count(), 5);
  assert.equal(await page.locator('#historyProjectFilter').evaluate(node => getComputedStyle(node).appearance), 'none');
  assert.equal(await page.locator('#historyProjectFilter').evaluate(node => getComputedStyle(node).backgroundPositionX), 'calc(100% - 12px)');
  assert.deepEqual(await page.locator('#historyProjectFilter option').evaluateAll(options => options.map(option => option.value)), ['', 'APP', 'CLOUD', 'SHOP', 'none']);
  assert.equal(await page.locator('.history-project-label').filter({ hasText: /^SHOP$/ }).count(), 2);
  await page.selectOption('#historyProjectFilter', 'SHOP');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2);
  await page.fill('#historySearch', 'оплаты');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
  assert.equal(await page.locator('.history-item h3').innerText(), 'SHOP-2');
  // Preserve a pending comment before switching projects.
  await page.locator('.history-comment-field').fill('Ретест оплаты — сохранён');
  await page.selectOption('#historyProjectFilter', 'APP');
  await page.waitForSelector('.history-empty');
  await page.fill('#historySearch', '');
  await page.waitForSelector('.history-comment-field');
  assert.equal(await page.locator('.history-item h3').innerText(), 'APP-3');
  await page.selectOption('#historyProjectFilter', 'none');
  await page.waitForFunction(() => document.querySelector('.history-item h3')?.textContent === 'Без задачи');
  await page.selectOption('#historyProjectFilter', '');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 5);
  await page.click('#closeHistoryButton');

  await openProjects();
  assert.deepEqual(await page.locator('#projectSettingsList code').allTextContents(), ['APP', 'CLOUD', 'SHOP']);
  const name = 'Магазин <товары> "главный"';
  await page.fill('[data-project-key="SHOP"]', name);
  await page.fill('[data-project-key="APP"]', 'Application');
  await page.fill('[data-project-key="CLOUD"]', 'Cloud');
  await page.fill('[data-project-color-key="SHOP"]', '#oops');
  await page.click('#saveJiraSettingsButton');
  assert.equal(await page.locator('#saveJiraSettingsButton').getAttribute('class').then(value => value.includes('is-saved')), false);
  assert.equal(await page.locator('[data-project-color-key="SHOP"]').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('qa-report-project-colors-v1')), null);
  await page.fill('[data-project-color-key="SHOP"]', 'E5484D');
  assert.equal(await page.inputValue('[data-project-color-picker="SHOP"]'), '#e5484d');
  await page.locator('[data-project-color-picker="APP"]').evaluate(input => {
    input.value = '#235bbb'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.inputValue('[data-project-color-key="APP"]'), '#235bbb');
  await page.click('#saveJiraSettingsButton');
  assert.equal(await page.locator('.settings-save-label').innerText(), 'Сохранено');
  await screenshot('projects-settings');
  await page.click('#closeJiraSettingsButton');
  await openHistory();
  assert.equal(await page.locator('.history-project-label').filter({ hasText: name }).count(), 2);
  assert.equal(await page.locator('.history-project-label').filter({ hasText: name }).first().evaluate(node => node.style.getPropertyValue('--project-color')), '#e5484d');
  assert.equal(await page.locator('.history-project-label').filter({ hasText: name }).first().evaluate(node => getComputedStyle(node, '::before').backgroundColor), 'rgb(229, 72, 77)');
  assert.equal(await page.locator('#historyProjectFilter option[value="SHOP"]').innerText(), name);
  await page.fill('#historySearch', 'магазин');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2);
  assert.match(await page.locator('#historyUsage').innerText(), /Показано: 2 из 5/);
  assert.equal(await page.locator('.history-project-label img').count(), 0);
  await page.fill('#historySearch', '');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 5);
  for (const theme of ['light', 'graphite', 'dark']) {
    await page.evaluate(value => applyTheme(value), theme);
    assert.equal(await controlsFit('.history-modal'), true, theme);
    await screenshot(`${theme}-projects-history`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await controlsFit('.history-modal'), true, 'mobile history');
  assert.equal(await page.locator('#historyList').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await screenshot('mobile-projects-history');
  await page.click('#closeHistoryButton');
  await openProjects();
  assert.equal(await controlsFit('.settings-modal'), true, 'mobile projects');
  await screenshot('mobile-projects-settings');
  // Switching settings sections keeps unsaved edits; closing discards them.
  await page.fill('[data-project-key="SHOP"]', 'Несохранённое');
  await page.fill('[data-project-color-key="SHOP"]', '#fff');
  await page.click('[data-settings-section="columns"]');
  await page.click('[data-settings-section="projects"]');
  assert.equal(await page.inputValue('[data-project-key="SHOP"]'), 'Несохранённое');
  await page.click('#closeJiraSettingsButton');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.reload();
  await page.waitForSelector('.cell-editor');
  await useCloud();
  await openProjects();
  assert.equal(await page.inputValue('[data-project-key="SHOP"]'), name);
  assert.equal(await page.inputValue('[data-project-color-key="SHOP"]'), '#e5484d');
  assert.equal(await page.inputValue('[data-project-color-key="APP"]'), '#235bbb');
  await page.locator('[data-project-row="SHOP"] [data-reset-project-color]').click();
  assert.equal(await page.inputValue('[data-project-color-key="SHOP"]'), '');
  await page.fill('[data-project-key="SHOP"]', '');
  await page.click('#saveJiraSettingsButton');
  await page.click('#closeJiraSettingsButton');
  await openHistory();
  assert.equal(await page.locator('.history-project-label').filter({ hasText: /^SHOP$/ }).count(), 2);
  assert.equal(await page.locator('.history-project-label').filter({ hasText: /^SHOP$/ }).first().getAttribute('style'), null);
  assert.equal(await page.evaluate(async () => (await getReportRecord('fixture-1')).historyComment), 'Ретест оплаты — сохранён');
  assert.equal(await page.evaluate(async () => JSON.stringify((await getReportRecord('fixture-1')).document)), oldDocument);
  await page.selectOption('#historyProjectFilter', 'SHOP');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2);
  await page.click('#closeHistoryButton');
  // The chosen project remains usable while history is loading.
  await page.evaluate(() => {
    window.originalHistoryRead = getAllHistoryReports;
    getAllHistoryReports = async () => {
      await new Promise(resolve => { window.releaseProjectHistory = resolve; });
      return window.originalHistoryRead();
    };
  });
  await page.click('#historyButton');
  await page.waitForSelector('.history-skeleton');
  await page.selectOption('#historyProjectFilter', 'APP');
  await page.waitForFunction(() => typeof window.releaseProjectHistory === 'function');
  await page.evaluate(() => window.releaseProjectHistory());
  await page.waitForFunction(() => document.querySelector('.history-item h3')?.textContent === 'APP-3');
  await page.click('#closeHistoryButton');
  await page.evaluate(async () => {
    getAllHistoryReports = window.originalHistoryRead;
    window.bulkCloud = [{ id: 'cloud', publicId: 'abc0005', issueKey: 'CLOUD-5', title: 'Облачный чек-лист', updatedAt: '2026-10-08T08:00:00.000Z', source: 'server' }];
    getServerReports = async () => window.bulkCloud;
    window.failCloudDelete = true;
    deleteServerReport = async id => {
      if (window.failCloudDelete) throw Error('fixture temporary failure');
      window.bulkCloud = window.bulkCloud.filter(report => report.id !== id);
    };
    await dbTransaction('readwrite', store => store.put({ id: 'cloud', publicId: 'abc0005', issueKey: 'CLOUD-5',
      document: normalizeDraft({ ...clone(DEFAULT_DRAFT), reportId: 'cloud', publicId: 'abc0005', issueUrl: 'CLOUD-5' }),
      updatedAt: '2026-10-08T08:00:00.000Z' }));
  });
  await openHistory();
  assert.equal(await page.locator('#saveHistorySnapshotButton').count(), 0);
  assert.equal(await page.locator('[data-history-select]').count(), 0);
  assert.equal(await page.locator('#deleteSelectedHistoryButton').isHidden(), true);
  await page.selectOption('#historyProjectFilter', 'SHOP');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2);
  await page.click('#historySelectionToggle');
  await page.waitForSelector('[data-history-select="fixture-0"]');
  await page.locator('[data-history-select="fixture-0"]').check();
  assert.equal(await page.locator('#historySelectAll').evaluate(input => input.indeterminate), true);
  await page.locator('#historySelectAll').check();
  assert.equal(await page.locator('[data-history-select]:checked').count(), 2);
  await page.selectOption('#historyProjectFilter', 'APP');
  await page.waitForSelector('[data-history-select="fixture-2"]');
  await page.locator('#historySelectAll').check();
  assert.equal(await page.locator('#historySelectionCount').innerText(), 'Выбрано: 3 · Скрыто фильтром: 2');
  await page.click('#deleteSelectedHistoryButton');
  await page.waitForSelector('#confirmModal:not([hidden])');
  assert.match(await page.locator('#confirmModalMessage').innerText(), /\(3\)/);
  assert.match(await page.locator('#confirmModalMessage').innerText(), /скрытых текущим фильтром: 2/);
  await page.click('#cancelConfirmButton');
  assert.equal(await page.locator('#historySelectionCount').innerText(), 'Выбрано: 3 · Скрыто фильтром: 2');
  await page.selectOption('#historyProjectFilter', '');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 5);
  await screenshot('history-selection');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await controlsFit('.history-modal'), true, 'mobile selection');
  await screenshot('mobile-history-selection');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.click('#historySelectionExit');
  await page.waitForFunction(() => document.querySelectorAll('[data-history-select]').length === 0);
  await page.click('#historySelectionToggle');
  await page.waitForSelector('[data-history-select="cloud"]');
  await page.locator('[data-history-select="cloud"]').check();
  await page.locator('[data-history-select="fixture-2"]').check();
  await page.click('#deleteSelectedHistoryButton');
  await page.click('#acceptConfirmButton');
  await page.waitForFunction(() => !historyDeleting);
  assert.match(await page.locator('#toast').innerText(), /Удалено: 1. Не удалось удалить: 1/);
  assert.equal(await page.locator('[data-history-select="cloud"]').isChecked(), true);
  assert.equal(await page.locator('[data-history-select="fixture-2"]').count(), 0);
  await page.evaluate(() => { window.failCloudDelete = false; });
  await page.click('#deleteSelectedHistoryButton');
  await page.click('#acceptConfirmButton');
  await page.waitForFunction(() => !historyDeleting);
  assert.equal(await page.locator('[data-history-select="cloud"]').count(), 0);
  assert.equal(await page.evaluate(async () => (await getReportRecord('cloud')) === undefined), true);
  assert.equal(await page.locator('#deleteSelectedHistoryButton').isDisabled(), true);
  await page.selectOption('#historyProjectFilter', 'SHOP');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 2);
  await page.locator('#historySelectAll').check();
  await page.click('#deleteSelectedHistoryButton');
  await page.click('#acceptConfirmButton');
  await page.waitForFunction(() => !historyDeleting);
  assert.equal(await page.evaluate(async () => (await getReportRecord('fixture-0')) === undefined && (await getReportRecord('fixture-1')) === undefined), true);
  assert.equal(await page.evaluate(() => draft.reportId === 'fixture-0'), false);
  await page.click('#closeHistoryButton');
  await page.reload();
  await page.waitForSelector('.cell-editor');
  assert.equal(await page.evaluate(() => draft.reportId === 'fixture-0'), false);
  await openHistory();
  assert.equal(await page.locator('[data-history-select]').count(), 0);
  assert.equal(await page.locator('#deleteSelectedHistoryButton').isHidden(), true);
  assert.equal(await page.locator('.history-item h3').filter({ hasText: /^SHOP-/ }).count(), 0);
  await page.click('#closeHistoryButton');
  // A closed settings request cannot overwrite a reopened form.
  await page.evaluate(() => {
    window.pendingProjectReads = [];
    getAllHistoryReports = () => new Promise(resolve => window.pendingProjectReads.push(resolve));
  });
  await page.click('#settingsButton');
  await page.click('[data-settings-section="projects"]');
  await page.waitForFunction(() => window.pendingProjectReads.length === 1);
  assert.equal(await page.locator('.project-settings-skeleton').count(), 3);
  assert.equal(await page.locator('#projectSettingsList').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('.project-settings-skeleton .history-skeleton-bar').first().evaluate(node => getComputedStyle(node).animationName), 'history-skeleton-pulse');
  assert.doesNotMatch(await page.locator('#projectSettingsList').innerText(), /Загружаем проекты/);
  await screenshot('projects-loading');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await controlsFit('.settings-modal'), true, 'mobile project skeleton');
  await screenshot('mobile-projects-loading');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.project-settings-skeleton .history-skeleton-bar').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.click('#closeJiraSettingsButton');
  await page.click('#settingsButton');
  await page.click('[data-settings-section="projects"]');
  await page.waitForFunction(() => window.pendingProjectReads.length === 2);
  await page.evaluate(() => window.pendingProjectReads[1]([{ issueKey: 'SHOP-1' }]));
  await page.waitForSelector('[data-project-key="SHOP"]');
  await page.fill('[data-project-key="SHOP"]', 'Новая правка');
  await page.evaluate(() => window.pendingProjectReads[0]([{ issueKey: 'APP-1' }]));
  assert.equal(await page.inputValue('[data-project-key="SHOP"]'), 'Новая правка');
  assert.equal(await page.locator('[data-project-key="APP"]').count(), 0);
  assert.equal(await page.locator('#projectSettingsList').getAttribute('aria-busy'), 'false');
  assert.deepEqual(errors, []);
  console.log('History projects browser checks passed:', corporate ? 'corporate' : 'public');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  child?.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
