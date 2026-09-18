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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-manual-numbering-'));
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
  const labels = () => page.locator('.row-number-input').evaluateAll(items => items.map(item=>item.value));
  const autoLabels = () => page.locator('.row-number-text').allTextContents();
  const setMode = async mode => {
    await page.click('#settingsButton');
    await page.check(`input[name="numberingMode"][value="${mode}"]`);
    await page.click('#saveJiraSettingsButton');
    await page.click('#closeJiraSettingsButton');
  };
  const importMarkup = async (text,preserve=true) => {
    await page.click('#jiraMenuButton'); await page.click('#importButton');
    await page.fill('#importMarkup',text); await page.click('#applyImportButton');
    await page.waitForFunction(()=>preparedImport && !elements.applyImportButton.disabled);
    await page.click('#importTab-data');
    assert.equal(await page.locator('#importNumberingChoice').isVisible(),true);
    await page.locator('#importPreserveNumbers').setChecked(preserve);
    if(output) {
      fs.mkdirSync(output,{recursive:true});
      await page.locator('#importModal .modal').screenshot({path:path.join(output,'import.png')});
    }
    await page.click('#applyImportButton');
    await page.waitForFunction(()=>!elements.confirmModal.hidden || elements.importModal.hidden);
    if(await page.locator('#confirmModal').isVisible()) await page.click('#acceptConfirmButton');
    await page.waitForFunction(()=>elements.importModal.hidden);
  };
  await page.click('#settingsButton');
  if(!fs.existsSync(path.join(root,'auth.js'))) {
    assert.equal(await page.locator('[data-settings-section="jira"], [data-settings-panel="jira"]').count(),0);
    assert.equal(await page.locator('#jiraToken').count(),0);
  }
  assert.equal(await page.locator('input[name="numberingMode"][value="manual"]').isVisible(),true);
  // Closing settings without saving leaves automatic numbering in place.
  await page.check('input[name="numberingMode"][value="manual"]');
  await page.click('#closeJiraSettingsButton');
  assert.equal(await page.locator('.row-number-input').count(),0);
  await setMode('manual');
  assert.deepEqual(await labels(),['1.','2.']);
  await page.locator('.row-number-input').first().fill('7.2');
  await page.locator('.cell-editor').first().click();
  await page.evaluate(()=>saveDraft());
  await page.reload(); await page.waitForSelector('.row-number-input');
  assert.deepEqual(await labels(),['7.2','2.']);
  await page.locator('.row-number-input').first().fill('11.3');
  await page.locator('.cell-editor').first().click();
  await page.waitForFunction(()=>!elements.undoButton.disabled);
  await page.click('#undoButton');
  assert.deepEqual(await labels(),['7.2','2.']);
  await page.click('#redoButton');
  assert.deepEqual(await labels(),['11.3','2.']);

  const numbered='h2. Проверки\n||Номер||Проверка||Статус||\n'+[1,2,3,4,5].map(i=>`|${i}.|Проверка ${i}|${i===4?'OK':'НЕ ОК'}|`).join('\n');
  await importMarkup(numbered);
  assert.deepEqual(await labels(),['1.','2.','3.','4.','5.']);
  await page.locator('.row-menu-button').nth(3).click();
  await page.locator('.floating-context-menu').getByRole('button',{name:'Удалить',exact:true}).click();
  assert.deepEqual(await labels(),['1.','2.','3.','5.']);
  await page.locator('.row-number-input').nth(3).fill('5.12');
  // A click that blurs the number still opens the row menu.
  await page.locator('.row-menu-button').nth(3).click();
  await page.locator('.floating-context-menu').getByRole('button',{name:'Поднять выше',exact:true}).click();
  assert.deepEqual(await labels(),['1.','2.','5.12','3.']);
  await page.locator('.add-row-button').click();
  assert.deepEqual(await labels(),['1.','2.','5.12','3.','']);
  await page.locator('.row-menu-button').nth(0).click();
  await page.locator('.floating-context-menu').getByRole('button',{name:'Дублировать',exact:true}).click();
  assert.deepEqual(await labels(),['1.','','2.','5.12','3.','']);
  await page.evaluate(()=>saveDraft());
  await page.reload(); await page.waitForSelector('.row-number-input');
  assert.deepEqual(await labels(),['1.','','2.','5.12','3.','']);
  const exports=await page.evaluate(()=>({markup:generateMarkup(),html:generateVisualPreview(),xlsx:buildXlsxWorksheet(),
    adf:typeof generateAdfDocument==='function'?generateAdfDocument():null}));
  assert.match(exports.markup,/\|5\.12\|/);
  assert.match(exports.html,/>5\.12</);
  assert.match(exports.xlsx.sharedStringsXml,/>5\.12</);
  if(exports.adf) assert.ok(JSON.stringify(exports.adf).includes('5.12'));
  if(output) {
    await page.screenshot({path:path.join(output,'manual-editor.png')});
    await page.click('#settingsButton');
    await page.locator('#jiraSettingsModal .modal').screenshot({path:path.join(output,'settings.png')});
    await page.click('#closeJiraSettingsButton');
  }
  // Plain-text manual labels cannot inject markup into previews or split exported tables.
  await page.locator('.row-number-input').first().fill('<img src=x onerror=alert(1)>|9');
  const safe=await page.evaluate(()=>({html:generateVisualPreview(),parsed:parseJiraMarkup(generateMarkup())}));
  assert.ok(safe.html.includes('&lt;img'));
  assert.equal(safe.parsed.sections[0].columns.length,1);
  await importMarkup('||Номер||Проверка||Статус||\n|3.|A|НЕ ОК|\n|8.4|B|OK|',false);
  assert.equal(await page.locator('.row-number-input').count(),0);
  assert.deepEqual(await autoLabels(),['1.','2.']);
  await setMode('manual');
  assert.deepEqual(await labels(),['1.','2.']);
  // Jira Cloud's ADF reader retains its source number column too.
  if(!fs.existsSync(path.join(root,'auth.js'))) {
    const source=await page.evaluate(()=>{
      const cell=(type,text)=>({type,content:[{type:'paragraph',content:[{type:'text',text}]}]});
      return parseAdfDocument({type:'doc',content:[{type:'table',content:[
        {type:'tableRow',content:[cell('tableHeader','№'),cell('tableHeader','Проверка')]},
        {type:'tableRow',content:[cell('tableCell','12.4'),cell('tableCell','A')]},
      ]}]}).sections[0].rows[0].manualNumber;
    });
    assert.equal(source,'12.4');
  }
  // The inbound choice uses three distinct actions; dismissing never renumbers data.
  for (const [button, expected] of [['#acceptConfirmButton','manual'], ['#alternativeConfirmButton','section'], ['#cancelConfirmButton','cancelled']]) {
    await page.evaluate(() => {
      const imported=parseJiraMarkup('||Номер||Проверка||Статус||\n|8.4|A|OK|');
      window.numberingChoiceResult=null;
      chooseImportedNumbering(imported).then(applied=>window.numberingChoiceResult=applied?imported.numberingMode:'cancelled');
    });
    await page.waitForSelector('#alternativeConfirmButton:visible');
    await page.click(button);
    await page.waitForFunction(()=>window.numberingChoiceResult!==null);
    assert.equal(await page.evaluate(()=>window.numberingChoiceResult),expected);
  }
  if(output) {
    await page.setViewportSize({width:390,height:844});
    await page.click('#settingsButton');
    await page.locator('input[value="manual"]').scrollIntoViewIfNeeded();
    const box=await page.locator('#jiraSettingsModal .modal').boundingBox();
    await page.locator('#jiraSettingsModal .modal').screenshot({path:path.join(output,'settings-mobile.png')});
    assert.ok(box.x>=0 && box.x+box.width<=390,JSON.stringify(box));
    await page.click('#closeJiraSettingsButton');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: settings, import choice, source numbers, deletion, movement, duplication, editing, undo/redo, reload, safe preview and exports.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();
  if(child) {const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();if(child.exitCode===null)await closed;}
  fs.rmSync(temp,{recursive:true,force:true});
});
