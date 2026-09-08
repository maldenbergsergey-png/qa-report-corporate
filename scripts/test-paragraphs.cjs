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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-markup-references-'));
const output = process.env.QA_REPORT_SCREENSHOTS;
const markup = [
  'Материалы: [^report notes.pdf]',
  'h2. Авторизация',
  '||Проверка||Ожидаемый результат||Фактический результат||Комментарий||Статус||',
  '|Вход|Ожидание|!screenshot-4.png|thumbnail!|Комментарий|OK|',
  '|Повторный вход|Два: !Screenshot 2.png|thumbnail,width=320! !full-size.png!|[^log.txt]|alpha\\|beta [Документация|https://docs.example/path]|НЕ ОК|',
].join('\n');
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
  const errors = [], downloads = [], uploads = [], comments = [];
  page.on('pageerror', error => errors.push(error.message));
  // Never contact a real Jira or external attachment service.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  await page.route('**/api/jira/import-attachment', route => { downloads.push(1); return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } }); });
  await page.route('**/api/jira/attachments', route => { uploads.push(1); return route.fulfill({ status: 400, json: { error: 'Unexpected upload of a markup reference' } }); });
  await page.route('**/api/jira/attachment-manifest', route => route.fulfill({ json: { ok: true, attachmentReuse: true, issueUrl: 'https://jira.example/browse/QA-1', attachments: [] } }));
  await page.route('**/api/jira/comment', route => {
    comments.push(route.request().postDataJSON().comment.body);
    return route.fulfill({ json: { ok: true, verified: true, apiRevision: 8, commentId: '1' } });
  });
  const configure = () => page.evaluate(() => {
    document.documentElement.dataset.theme = 'graphite';
    if (typeof jiraSettings !== 'undefined') {
      jiraSettings = { ...jiraSettings, transport: 'server', baseUrl: 'https://jira.example', type: 'data-center', authMethod: 'pat' };
      jiraSecret = 'fixture-token';
    }
  });
  await page.goto(origin); await page.waitForSelector('#jiraMenuButton'); await configure();
  const samples = [
    ['Enter', 'Первый<div>Второй</div>', 'Первый\\\\ Второй'],
    ['Literal token-like text', '@@JIRA_CELL_0@@ <span class="jira-image-placeholder" data-jira-name="a.png">a.png</span>', '@@JIRA_CELL_0@@ !a.png!'],
    ['Blank line', 'Первый<div><br></div><div>Второй</div>', 'Первый\\\\ \\\\ Второй'],
    ['Soft breaks', 'Первый<br><br>Второй', 'Первый\\\\ \\\\ Второй'],
    ['Paragraphs', '<p>Первый</p><p>Второй</p>', 'Первый\\\\ \\\\ Второй'],
    ['Image boundaries', '<div>До</div><figure class="cell-image"><img data-jira-name="screenshot-4.png"></figure><div>После</div>', 'До\\\\ !screenshot-4.png|thumbnail!\\\\ После'],
  ];
  // Actual production serializers, including block HTML produced by Chromium Enter.
  for (const [name, html, expected] of samples) {
    const result = await page.evaluate(html => jiraCell(html), html);
    assert.equal(result, expected, name);
  }
  const rich = await page.evaluate(() => {
    const colored = jiraCell('<p><span style="color:#ff0000">Первый</span></p><p><span style="color:#ff0000">Второй</span></p>');
    const literals = jiraCell('C:\\Temp\\file.txt | plain');
    const code = jiraCell('<div>До</div><pre class="cell-code-block"><code>const path = "C:\\Temp";\nleft | right\n\nlast</code></pre><div>После</div>');
    const list = jiraCell('<div>До</div><ul><li>Первый | пункт</li><li>Второй C:\\Temp</li></ul><div>После</div>');
    const values = [colored,literals,code,list,jiraCell('<div>До</div><figure class="cell-image"><img data-jira-name="screenshot-4.png"></figure><div>После</div>')];
    const wiki = '||Цвет||Путь||Код||Список||Изображение||Статус||\n|' + values.join('|') + '|OK|';
    const parsed = parseJiraMarkup(wiki); const section = parsed.sections[0];
    const cells = section.columns.map(column => section.rows[0].cells[column.id]);
    const round = cells.map(html => jiraCell(html));
    const temp = document.createElement('div');temp.innerHTML=cells[1];
    return {colored,literals,code,list,wiki,cells,round,columns:section.columns.length,rows:section.rows.length,path:temp.textContent};
  });
  assert.match(rich.colored,/Первый.*\\\\ \\\\ .*Второй/);
  assert.equal(rich.path,'C:\\Temp\\file.txt | plain');
  assert.equal(rich.columns,5); assert.equal(rich.rows,1);
  assert.ok(rich.code.includes('{code}\nconst path = "C:\\Temp";\nleft | right\n\nlast\n{code}'));
  assert.match(rich.list,/\n\* Первый \\?\| пункт\n\* Второй C:&#92;Temp\n/);
  assert.ok(rich.round[4].includes('!screenshot-4.png|thumbnail!'));
  assert.match(rich.cells[4], /<br>.*jira-image-placeholder/);
  assert.doesNotMatch(rich.wiki,/@@JIRA/);
  // Type Enter/Shift+Enter through the real editor, rather than only passing HTML strings.
  const editor = page.locator('.cell-editor').first();
  for (const keys of [['Enter'],['Enter','Enter'],['Shift+Enter'],['Shift+Enter','Shift+Enter']]) {
    await editor.fill('Первый'); for(const key of keys) await editor.press(key); await page.keyboard.insertText('Второй');
    const result = await editor.evaluate(el => jiraCell(cleanEditorHtml(el)));
    assert.equal(result, 'Первый' + '\\\\ '.repeat(keys.length) + 'Второй', keys.join(','));
  }
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=';
  await page.evaluate(png => {
    const section = draft.sections[0];
    section.rows[0].cells[section.columns[0].id] = `<figure class="cell-image" contenteditable="false"><img src="${png}" data-jira-name="screenshot-4.png" data-file-name="screenshot-4.png" style="width:150px"></figure>`;
    section.rows[0].cells[section.columns[1].id] = '<pre class="cell-code-block" data-language="text"><code>left | right\nC:\\Temp</code></pre>';
    render();
  },png);
  for (const selector of ['.cell-image','.cell-code-block']) {
    const object = page.locator('.cell-editor '+selector).first();
    const box = await object.boundingBox();
    await page.mouse.click(box.x+3,box.y+Math.min(box.height/2,65));
    assert.equal(await page.locator('#mediaViewerModal').isVisible(),false);
    assert.equal(await page.locator('#codeEditorModal').isVisible(),false);
    const boundary = await object.evaluate(el => {
      const range=window.getSelection().getRangeAt(0);
      return range.collapsed && range.startContainer===el.parentNode && range.startContainer.childNodes[range.startOffset]===el;
    });
    assert.equal(boundary,true,'Native caret is before '+selector);
    const before = await object.boundingBox();
    await page.keyboard.press('Shift+Enter');
    const after = await object.boundingBox(); assert.ok(after.y > before.y,'Object moves down');
    const label = selector === '.cell-image' ? 'Текст перед изображением' : 'Текст перед кодом';
    await page.keyboard.insertText(label);
    assert.equal(await object.evaluate(el => el.previousElementSibling.textContent),label);
    const clean = await object.evaluate(el => jiraCell(cleanEditorHtml(el.closest('.cell-editor'))));
    assert.ok(clean.startsWith(label+'\\\\ '),clean);
    // Keyboard-only entry to both sides of an object is available too.
    await object.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+Enter');
    await page.keyboard.insertText('Подпись после блока');
    assert.equal(await object.evaluate(el => el.nextElementSibling.textContent),'Подпись после блока');
  }
  // Direct typing at the boundary also works, without a preparatory space or newline.
  const firstImage = page.locator('.cell-editor .cell-image').first();
  await firstImage.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.insertText('Вставка у границы');
  const typedAtBoundary = await firstImage.evaluate(el => ({html:cleanEditorHtml(el.closest('.cell-editor')),previous:el.previousSibling?.textContent}));
  assert.ok(typedAtBoundary.html.indexOf('Вставка у границы') < typedAtBoundary.html.indexOf('<figure') && typedAtBoundary.html.includes('Вставка у границы'), JSON.stringify(typedAtBoundary));
  const imageBox = await firstImage.boundingBox();
  await page.mouse.click(imageBox.x+imageBox.width/2,imageBox.y+imageBox.height/2);
  assert.equal(await page.locator('#mediaViewerModal').isVisible(),true);
  await page.keyboard.press('Escape');
  const codeObject = page.locator('.cell-editor .cell-code-block').first();
  const codeBox = await codeObject.boundingBox();
  await page.mouse.click(codeBox.x+codeBox.width/2,codeBox.y+codeBox.height/2);
  assert.equal(await page.locator('#codeEditorModal').isVisible(),true);
  const documentBeforeCodeEdit = await page.evaluate(() => cleanEditorHtml(document.querySelector('.cell-code-block').closest('.cell-editor')));
  await page.locator('#codeEditorTextarea').press('End'); await page.locator('#codeEditorTextarea').press('Shift+Enter');
  assert.equal(await page.evaluate(() => cleanEditorHtml(document.querySelector('.cell-code-block').closest('.cell-editor'))),documentBeforeCodeEdit,'Shift+Enter in the code modal must not modify an editor object boundary');
  await page.keyboard.press('Escape');
  if (await page.locator('#confirmModal').isVisible()) await page.click('#acceptConfirmButton');
  await page.waitForFunction(()=>document.getElementById('codeEditorModal').hidden);
  await page.fill('#issueUrl','https://jira.example/browse/QA-1');
  await page.evaluate(() => saveDraft());
  const beforeReload = await page.evaluate(() => generateMarkup());
  await page.reload(); await page.waitForSelector('.cell-code-block'); await configure();
  assert.equal(await page.evaluate(() => generateMarkup()),beforeReload);
  const row = await page.evaluate(() => {
    const section = parseJiraMarkup(generateMarkup()).sections[0]; return {columns:section.columns.length, row:section.rows[0]};
  });
  assert.equal(Object.keys(row.row.cells).length,row.columns);
  await page.click('#jiraMenuButton'); await page.click('#publishButton'); await page.click('#acceptPublishScopeButton');
  await page.waitForFunction(() => !publishInProgress);
  assert.equal(await page.locator('#publishErrorText').isVisible(),false,await page.locator('#publishErrorText').textContent());
  assert.equal(comments.length,1,await page.evaluate(()=>JSON.stringify({error:elements.publishErrorText.textContent,toast:document.getElementById('toast').textContent,issue:draft.issueUrl}))); assert.equal(comments[0],beforeReload,'Jira receives the exact markup without extra escaping');
  await page.click('#publishCancelButton');
  if(output) {fs.mkdirSync(output,{recursive:true});await page.locator('.check-table').first().screenshot({path:path.join(output,'paragraphs-and-objects.png')});}
  assert.deepEqual(errors,[]);
  console.log('PASS: Enter/Shift+Enter, paragraph gaps, colors, code, literal backslashes, protected image pipes, table round trip, leading-edge caret, moving images/code and persistence.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); if (child.exitCode === null) await closed; }
  fs.rmSync(temp, { recursive: true, force: true });
});
