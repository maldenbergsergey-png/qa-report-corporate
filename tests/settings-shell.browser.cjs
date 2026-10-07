// Local Settings regression. All data is synthetic and external requests are blocked.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-settings-shell-'));
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
  await page.click('#settingsButton');
  const panels = corporate ? ['checklist', 'columns', 'environments', 'history', 'connect', 'jira', 'appearance'] : ['checklist', 'columns', 'environments', 'history', 'files', 'bugs', 'connect', 'jira', 'eva', 'appearance'];
  assert.deepEqual(await page.locator('.settings-sidebar [data-settings-section]').evaluateAll(nodes => nodes.map(n => n.dataset.settingsSection)), panels);
  assert.equal(await page.locator('[data-settings-section="pinning"]').count(), 0);
  assert.equal(await page.locator('[data-settings-panel="pinning"]').count(), 0);
  const modal = page.locator('.settings-modal');
  const content = page.locator('#settingsContent');
  const select = key => page.click(`[data-settings-section="${key}"]`);
  const geometry = () => page.evaluate(() => {
    const rect = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return { modal: rect('.settings-modal'), header: rect('.settings-header'), sidebar: rect('.settings-sidebar'), footer: rect('.settings-footer'), save: rect('#saveJiraSettingsButton') };
  });

  for (const theme of ['light', 'graphite', 'dark']) {
    await select('appearance');
    await page.click(`.theme-menu-item[data-theme="${theme}"]`);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    for (const viewport of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }, { width: 1024, height: 700 }, { width: 800, height: 600 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const expected = await geometry();
      assert(expected.modal.x >= 0 && expected.modal.y >= 0);
      assert(expected.modal.x + expected.modal.width <= viewport.width);
      assert(expected.modal.y + expected.modal.height <= viewport.height);
      const margin = viewport.width <= 820 ? 24 : 64;
      assert.equal(expected.modal.width, Math.min(viewport.width - margin, 1440));
      assert.equal(expected.modal.height, Math.min(viewport.height - margin, viewport.width <= 820 ? viewport.height : 900));
      for (const key of panels) {
        await select(key);
        assert.deepEqual(await geometry(), expected, `${theme} ${viewport.width} ${key}: fixed shell`);
        assert.equal(await page.locator('.settings-section:not([hidden])').count(), 1);
        assert.equal(await page.locator(`.settings-section[data-settings-panel="${key}"] .settings-page-header h3`).count(), 1);
        assert.equal(await page.locator(`[data-settings-section="${key}"]`).getAttribute('aria-current'), 'page');
        assert.equal(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `${key}: no horizontal overflow`);
        assert.equal(await modal.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'no modal scrollbar');
        if (viewport.width >= 800) assert.equal(await page.locator('.settings-sidebar').evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, `${theme} ${viewport.width}x${viewport.height} ${key}: sidebar fits`);
        await content.evaluate(el => { el.scrollTop = el.scrollHeight; });
        assert.deepEqual(await geometry(), expected, 'scroll keeps header/sidebar/footer in place');
      }
      await select('checklist');
      await content.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await select('appearance');
      assert.equal(await content.evaluate(el => el.scrollTop), 0);
      if (process.env.QA_REPORT_SCREENSHOTS && (viewport.width === 1600 || viewport.width === 390)) {
        await page.waitForFunction(() => !document.getElementById('toast').classList.contains('visible'));
        fs.mkdirSync(process.env.QA_REPORT_SCREENSHOTS, { recursive: true });
        for (const key of ['checklist', 'columns', 'environments', 'appearance']) {
          await select(key);
          await modal.screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS, `${theme}-${viewport.width}-${key}.png`) });
        }
      }
    }
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  // Environment choices are explicitly managed; deleting presets must not rewrite reports or resurrect them.
  await page.setViewportSize({ width: 1280, height: 900 });
  await select('environments');
  const environmentInputs = page.locator('#environmentSettingsList input');
  const choices = () => page.locator('#environmentOptions option').evaluateAll(nodes => nodes.map(node => node.value));
  assert.deepEqual(await environmentInputs.evaluateAll(nodes => nodes.map(node => node.value)), ['DEV', 'STAGE', 'PROD']);
  const reportEnvironment = await page.locator('#environment').inputValue();
  await page.fill('#newEnvironmentName', 'QA');
  await page.press('#newEnvironmentName', 'Enter');
  assert.equal(await environmentInputs.count(), 4);
  assert.deepEqual(await choices(), ['DEV', 'STAGE', 'PROD'], 'unsaved choices stay out of the report');
  await page.fill('#newEnvironmentName', ' qa ');
  await page.click('#addEnvironment');
  assert.match(await page.textContent('#environmentSettingsError'), /уже есть/);
  assert.equal(await environmentInputs.count(), 4);
  await page.click('#closeJiraSettingsButton');
  await page.click('#settingsButton'); await select('environments');
  assert.equal(await environmentInputs.count(), 3, 'closing discards edits');
  await environmentInputs.first().fill('Sandbox');
  await page.locator('#environmentSettingsList .environment-remove').nth(1).click();
  await page.locator('#environmentSettingsList .environment-remove').nth(1).click();
  await page.fill('#newEnvironmentName', 'QA'); await page.click('#addEnvironment');
  await page.fill('#newEnvironmentName', 'UAT');
  await page.click('#saveJiraSettingsButton');
  assert.equal(await page.locator('.settings-save-label').textContent(), 'Сохранено');
  assert.deepEqual(await choices(), ['Sandbox', 'QA', 'UAT'], 'save also includes the pending name');
  assert.equal(await page.locator('#environment').inputValue(), reportEnvironment);
  await page.click('#closeJiraSettingsButton'); await page.reload(); await page.waitForSelector('.cell-editor');
  assert.deepEqual(await choices(), ['Sandbox', 'QA', 'UAT']);
  await page.locator('#environment').focus();
  assert.deepEqual(await choices(), ['Sandbox', 'QA', 'UAT'], 'the current STAGE value does not restore a deleted preset');
  await page.click('#settingsButton'); await select('environments');
  await environmentInputs.nth(1).fill('sandbox'); await page.click('#saveJiraSettingsButton');
  assert.equal(await page.locator('.settings-save-label').textContent(), 'Сохранить');
  assert.match(await page.textContent('#environmentSettingsError'), /повторяться/);
  await environmentInputs.nth(1).fill('QA');
  while (await environmentInputs.count()) await page.locator('#environmentSettingsList .environment-remove').first().click();
  await page.click('#saveJiraSettingsButton');
  assert.deepEqual(await choices(), []);
  await page.click('#closeJiraSettingsButton'); await page.reload(); await page.waitForSelector('.cell-editor');
  assert.deepEqual(await choices(), [], 'all presets can be removed permanently');
  await page.click('#settingsButton'); await select('environments');
  await page.fill('#newEnvironmentName', 'QA'); await page.click('#addEnvironment'); await page.click('#saveJiraSettingsButton');
  await page.click('#closeJiraSettingsButton');
  await page.fill('#environment', 'QA'); await page.locator('#environment').blur();
  assert.equal(await page.locator('#environment').inputValue(), 'QA');
  await page.click('.section-header-table .column-menu-button');
  const clear = page.locator('.floating-context-menu button', { hasText: 'Очистить столбец' });
  assert.equal(await clear.locator('use').getAttribute('href'), '#icon-broom');
  assert.equal(await page.locator('.floating-context-menu button', { hasText: 'Удалить столбец' }).locator('use').getAttribute('href'), '#icon-trash');
  await page.screenshot({ path: path.join(process.env.QA_REPORT_SCREENSHOTS || temp, 'column-menu.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dictationDestination').count(), 0);
  await page.click('#settingsButton');

  // Closing without saving must retain the old numbering and pinning choices.
  await select('checklist');
  const oldMode = await page.locator('[name="numberingMode"]:checked').inputValue();
  const nextMode = oldMode === 'continuous' ? 'section' : 'continuous';
  await page.check(`[name="numberingMode"][value="${nextMode}"]`);
  await select('columns');
  const oldPin = await page.locator('#pinNumberColumn').isChecked();
  await page.locator('#pinNumberColumn').setChecked(!oldPin);
  await page.click('#closeJiraSettingsButton');
  await page.click('#settingsButton');
  assert.equal(await page.locator('[name="numberingMode"]:checked').inputValue(), oldMode);
  await select('columns');
  assert.equal(await page.locator('#pinNumberColumn').isChecked(), oldPin);

  // One save still applies existing settings from several pages together.
  await select('checklist');
  await page.check(`[name="numberingMode"][value="${nextMode}"]`);
  await select('columns');
  await page.locator('#pinNumberColumn').setChecked(!oldPin);
  await page.click('#addDefaultColumn');
  await page.locator('#defaultColumnsList input').last().fill('Settings regression column');
  await select('history');
  await page.uncheck('#cloudHistoryEnabled');
  if (!corporate) {
    await select('bugs');
    await page.fill('#bugSystemPrompt', 'Synthetic settings prompt');
    await select('files');
    await page.fill('#yandexStoragePath', '/Settings regression');
  }
  await page.click('#saveJiraSettingsButton');
  assert.equal(await page.locator('.settings-save-label').textContent(), 'Сохранено');
  await page.click('#closeJiraSettingsButton');
  await page.reload();
  await page.waitForSelector('.cell-editor');
  await page.click('#settingsButton');
  assert.equal(await page.locator('[name="numberingMode"]:checked').inputValue(), nextMode);
  await select('columns');
  assert.equal(await page.locator('#pinNumberColumn').isChecked(), !oldPin);
  assert((await page.locator('#defaultColumnsList input').evaluateAll(nodes => nodes.map(n => n.value))).includes('Settings regression column'));
  if (!corporate) {
    await select('bugs');
    assert.equal(await page.locator('#bugSystemPrompt').inputValue(), 'Synthetic settings prompt');
    await select('files');
    assert.equal(await page.locator('#yandexStoragePath').inputValue(), '/Settings regression');
    await select('connect');
    await page.locator('#prepareDesktopAgentButton').waitFor({ state: 'visible' });
    await select('jira');
    assert.equal(await page.locator('#agentConnectionState').isVisible(), true);
    await page.click('#jiraSetupConnect');
    assert.equal(await page.locator('[data-settings-section="connect"]').getAttribute('aria-current'), 'page');
    await select('eva');
    await page.click('#evaSetupConnect');
    assert.equal(await page.locator('[data-settings-section="connect"]').getAttribute('aria-current'), 'page');
  }
  assert.deepEqual(errors, []);
  console.log(`Settings shell (${corporate ? 'corporate' : 'public'}) passed: all pages, 3 themes, 5 viewports, fixed geometry, scroll, discard, save/reload, integration navigation.`);
}

main().finally(async () => {
  await browser?.close();
  child?.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
