"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "/Users/sergeymaldenberg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { start } = require("./fixtures/bug-wizard-preview.cjs");
const root = path.resolve(__dirname, ".."), output = path.resolve(root, "../artifacts/bug-wizard", path.basename(root));
(async () => {
  fs.mkdirSync(output, { recursive: true }); const fixture = await start(root, 0, { aiDelay: 700 }), failedAi = await start(root, 0, { aiDelay: 300, aiFailure: true }), browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ["dark", "light", "graphite"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
      await context.addInitScript(theme => localStorage.setItem("qa-report-theme", theme), theme);
      const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
      page.setDefaultTimeout(15000); await page.goto(fixture.origin);
      if (theme === "light") {
        assert.match(await page.locator('.report-publication-buttons').evaluate(el => getComputedStyle(el).backgroundColor), /255, 255, 255, 0.72/);
        await page.screenshot({ path: path.join(output, 'light-publication.png') });
      }
      await page.click("#reportMenuButton"); await page.click("#openStandaloneBugReport");
      await page.waitForFunction(() => !document.getElementById("bugProject").disabled);
      assert.equal(await page.locator("#loadBugContext").isDisabled(), true);
      await page.fill("#bugProject", "APP"); await page.press("#bugProject", "Tab");
      await page.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
      const size = async () => { const box = await page.locator(".bug-report-modal").boundingBox(); return [box.width, box.height]; };
      const originalSize = await size(); assert.deepEqual(originalSize, [1000, 750]);
      assert.equal(await page.locator('#cancelBugReport').isVisible(), false);
      assert.ok(await page.locator('.bug-steps').evaluate(el => {
        const first = el.firstElementChild.getBoundingClientRect(), last = el.lastElementChild.getBoundingClientRect(), modal = el.closest('[role="dialog"]').getBoundingClientRect();
        return Math.abs((first.left + last.right) / 2 - (modal.left + modal.right) / 2) < 1;
      }), "The visible progress sequence is centered");
      await page.screenshot({ path: path.join(output, `${theme}-target.png`) });
      await page.click("#loadBugContext"); await page.fill("#bugContextText", "Объект не удаляется из избранного. Открыть подборщик, нажать удалить. Ожидается удаление объекта.");
      assert.equal(await page.locator('.bug-preparation-main').evaluate(el => getComputedStyle(el).borderWidth), '0px');
      const beforeResize = await page.locator('#bugContextText').boundingBox();
      await page.mouse.move(beforeResize.x + beforeResize.width - 4, beforeResize.y + beforeResize.height - 4); await page.mouse.down(); await page.mouse.move(beforeResize.x + beforeResize.width - 4, beforeResize.y + beforeResize.height + 75, { steps: 8 }); await page.mouse.up();
      const afterResize = await page.locator('#bugContextText').boundingBox(), tools = await page.locator('.bug-context-tools').boundingBox();
      assert.ok(afterResize.height > beforeResize.height + 40, 'Native vertical resizing works');
      assert.ok(tools.y >= afterResize.y + afterResize.height, 'Recording controls flow below the resized field');
      assert.deepEqual(await size(), originalSize);
      const footerHeights = await page.locator('.bug-wizard-footer .button').evaluateAll(els => els.filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect().height));
      assert.ok(footerHeights.every(height => Math.abs(height - 42) < .1), 'All footer actions have identical height');
      await page.locator('#bugContextText').evaluate(el => el.style.height = '900px');
      await page.waitForFunction(() => parseFloat(document.getElementById('bugContextText').style.getPropertyValue('--bug-context-occlusion')) > 0);
      const bodyBox = await page.locator('.bug-report-body').boundingBox(), pinnedTools = await page.locator('.bug-context-dock').boundingBox(), footerBox = await page.locator('.bug-wizard-footer').boundingBox();
      assert.ok(pinnedTools.y >= bodyBox.y && Math.abs(pinnedTools.y + pinnedTools.height - footerBox.y) < 1, 'The pinned toolbar meets navigation with no field visible below');
      assert.match(await page.locator('.bug-context-dock').evaluate(el => getComputedStyle(el).backdropFilter), /blur\(16px\)/);
      assert.equal(await page.locator('.bug-context-dock').evaluate(el => getComputedStyle(el).borderRadius), '12px');
      await page.locator('.bug-report-body').evaluate(el => el.scrollTop = 300);
      const scrolledTools = await page.locator('.bug-context-dock').boundingBox();
      assert.ok(Math.abs(scrolledTools.y - pinnedTools.y) < 1, 'Recording controls stay pinned as the large field scrolls');
      await page.screenshot({ path: path.join(output, `${theme}-resized.png`) });
      await page.locator('#bugContextText').evaluate(el => el.style.removeProperty('height'));
      await page.locator('.bug-report-body').evaluate(el => el.scrollTop = 0);
      assert.equal(await page.locator('#bugVoicePrivacy').isVisible(), false);
      await page.locator('#bugVoiceInfo summary').click();
      assert.equal(await page.locator('#bugVoicePrivacy').isVisible(), true);
      assert.match(await page.textContent('#bugVoicePrivacy'), /Диктовка браузера/);
      await page.locator('#bugVoiceInfo summary').press('Escape');
      assert.equal(await page.locator('#bugVoicePrivacy').isVisible(), false);
      assert.equal(await page.locator('#bugReportModal').isVisible(), true);
      await page.setInputFiles("#bugContextFiles", { name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
      await page.waitForSelector(".bug-extra-file"); const problem = await page.inputValue("#bugContextText");
      assert.deepEqual(await size(), originalSize);
      await page.click("#editBugPrompt"); await page.fill("#bugWizardPrompt", "Подготовь баг на русском языке, используя только переданные факты."); await page.click("#saveBugPrompt");
      assert.equal(await page.inputValue("#bugContextText"), problem); assert.equal(await page.locator(".bug-extra-file").count(), 1);
      await page.screenshot({ path: path.join(output, `${theme}-prepare.png`) });
      await page.click("#bugPrepareDraft");
      await page.waitForFunction(() => document.querySelector('.bug-report-modal').dataset.generating === 'true');
      assert.equal(await page.locator('.bug-report-modal').getAttribute('data-step'), '2');
      assert.equal(await page.locator('#bugSpinner').isVisible(), true);
      assert.equal(await page.locator('#bugEditor').isVisible(), false);
      assert.equal(await page.locator('#bugManualDraft').isDisabled(), true);
      assert.deepEqual(await size(), originalSize);
      await page.screenshot({ path: path.join(output, `${theme}-generating.png`) });
      await page.waitForFunction(() => document.querySelector('.bug-report-modal').dataset.generating === 'false' && document.querySelector('.bug-report-modal').dataset.step === '3');
      await page.waitForSelector('#bugEditor:not([hidden])');
      assert.deepEqual(await size(), originalSize);
      assert.equal(await page.locator("#bugRequiredFields [data-bug-value]").count(), 5);
      assert.equal(await page.locator(".bug-optional-badge").count(), 0);
      assert.equal(await page.locator(".bug-rich-toolbar").count(), 4);
      // Real divider dragging changes the two columns and preserves edited values.
      const divider = page.locator('#bugDraftResize'), left = page.locator('.bug-draft-content'), right = page.locator('.bug-draft-parameters');
      const beforeColumns = [await left.boundingBox(), await right.boundingBox()], handle = await divider.boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 30); await page.mouse.down();
      await page.mouse.move(handle.x - 120, handle.y + 30, { steps: 10 }); await page.mouse.up();
      assert.ok((await left.boundingBox()).width < beforeColumns[0].width - 100);
      assert.ok((await right.boundingBox()).width > beforeColumns[1].width + 100);
      const draggedRatio = Number(await divider.getAttribute('aria-valuenow'));
      assert.ok(Math.abs(await page.evaluate(() => JSON.parse(localStorage.getItem('qa-report-bug-layout-v1'))) - draggedRatio) < 1);
      await divider.press('ArrowRight'); assert.equal(Number(await divider.getAttribute('aria-valuenow')), draggedRatio + 2);
      await divider.press('Home'); assert.ok((await left.boundingBox()).width >= 320);
      await divider.press('End'); assert.ok((await right.boundingBox()).width >= 240);
      await divider.dblclick(); assert.equal(await divider.getAttribute('aria-valuenow'), '65');
      assert.deepEqual(await size(), originalSize);
      // Visual formatting renders immediately and source switching preserves it.
      const descField = page.locator('[data-bug-field="description"]'), visual = descField.locator('.bug-rich-visual');
      assert.equal(await visual.isVisible(), true);
      assert.ok((await visual.boundingBox()).height >= 180);
      assert.equal(await descField.getByRole('button', { name: 'Полужирный', exact: true }).evaluate(el => el.getBoundingClientRect().height), 32);
      await visual.fill('Визуальное описание'); await visual.press('ControlOrMeta+A');
      await descField.getByRole('button', { name: 'Полужирный', exact: true }).click();
      assert.equal(await visual.locator('b, strong').textContent(), 'Визуальное описание');
      assert.equal(await page.inputValue('[data-bug-value="description"]'), '*Визуальное описание*');
      await descField.getByRole('button', { name: 'Разметка', exact: true }).click();
      assert.equal(await page.locator('[data-bug-value="description"]').isVisible(), true);
      await descField.getByRole('button', { name: 'Визуально', exact: true }).click();
      assert.equal(await visual.locator('b, strong').textContent(), 'Визуальное описание');
      await visual.fill('Первый\nВторой'); await visual.press('ControlOrMeta+A');
      await descField.getByRole('button', { name: 'Нумерованный список', exact: true }).click();
      assert.equal(await visual.locator('ol li').count(), 2);
      await visual.fill('Ссылка'); await visual.press('ControlOrMeta+A');
      await descField.getByRole('button', { name: 'Ссылка', exact: true }).click();
      await descField.getByLabel('Адрес ссылки', { exact: true }).fill('https://jira.example.test/browse/APP-1');
      await descField.getByRole('button', { name: 'Добавить ссылку', exact: true }).click();
      assert.equal(await visual.locator('a').getAttribute('href'), 'https://jira.example.test/browse/APP-1');
      // An existing attachment can be selected at the caret from the editor toolbar.
      await visual.press('ControlOrMeta+End');
      await descField.getByRole('button', { name: 'Вставить вложение в описание', exact: true }).click();
      await descField.getByRole('button', { name: 'Вставить fixture.txt', exact: true }).click();
      assert.equal(await visual.locator('.bug-rich-asset').count(), 1);
      await descField.getByRole('button', { name: 'Разметка', exact: true }).click();
      await page.locator('[data-bug-field="components"] .bug-user-toggle').click();
      await page.locator('[data-bug-field="components"]').getByRole('option', { name: 'ИИ-подборщик', exact: true }).click();
      await page.locator('[data-bug-field="fixVersions"] .bug-user-toggle').click();
      await page.locator('[data-bug-field="fixVersions"]').getByRole('option', { name: '1.0', exact: true }).click();
      for (const id of ['components', 'fixVersions']) {
        assert.equal(await page.locator(`[data-bug-field="${id}"] .bug-user-entry input`).evaluate(el => getComputedStyle(el).borderWidth), '0px', 'The selected values and search share one field border');
        assert.ok(await page.locator(`[data-bug-field="${id}"] .bug-user-chips > span`).evaluate(el => {
          const chip = el.getBoundingClientRect(), field = el.closest('.bug-user-entry').getBoundingClientRect();
          return chip.top >= field.top && chip.bottom <= field.bottom && chip.left >= field.left && chip.right <= field.right;
        }), 'Selected values are rendered inside their field');
      }
      await page.fill('[data-bug-value="summary"]', "Моя правка: объект не удаляется");
      await page.fill('[data-bug-value="labels"] + .bug-user-picker input', "fixture-label"); await page.press('[data-bug-value="labels"] + .bug-user-picker input', "Enter");
      await page.click("#bugBack"); assert.equal(await page.inputValue("#bugContextText"), problem);
      await page.click("#bugBack"); await page.click("#loadBugContext"); await page.click("#bugReviewDraft");
      assert.equal(await page.inputValue('[data-bug-value="summary"]'), "Моя правка: объект не удаляется");
      const description = page.locator('[data-bug-value="description"]');
      await description.fill("До\nПосле");
      await description.evaluate(el => el.setSelectionRange(3, 3));
      await page.getByRole("button", { name: "Вставить fixture.txt в описание", exact: true }).click();
      assert.equal(await description.inputValue(), "До\n[Вложение: fixture.txt]После");
      // Unchecking a file removes its insertion, then dragging places it at the pointer.
      await page.locator('#bugAttachmentList input').first().uncheck();
      assert.equal(await description.inputValue(), "До\nПосле");
      await description.evaluate(el => el.setSelectionRange(0, 0));
      await page.evaluate(() => {
        const control = document.querySelector('[data-bug-value="description"]'), box = control.getBoundingClientRect(), style = getComputedStyle(control), transfer = new DataTransfer();
        transfer.setData("application/x-qa-bug-attachment", document.querySelector('#bugAttachmentList input').dataset.assetKey);
        control.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + parseFloat(style.paddingLeft) + 1, clientY: box.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) * 1.5 }));
      });
      assert.equal(await description.inputValue(), "До\n[Вложение: fixture.txt]После", "Drop follows pointer rather than old cursor");
      await descField.getByRole('button', { name: 'Визуально', exact: true }).click();
      assert.match(await visual.innerText(), /fixture.txt/);
      // Image paste in the visual editor displays a local preview and retains an upload placement.
      await visual.press('ControlOrMeta+End');
      await visual.evaluate(el => {
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'screen.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await page.waitForSelector('.bug-rich-asset img');
      assert.equal(await visual.locator('.bug-rich-asset img').getAttribute('alt'), 'screen.png');
      await page.screenshot({ path: path.join(output, `${theme}-visual-editor.png`) });
      await descField.getByRole('button', { name: 'Разметка', exact: true }).click();
      const summaryBeforeDrop = await page.inputValue('[data-bug-value="summary"]');
      await page.evaluate(() => {
        const transfer = new DataTransfer(); transfer.items.add(new File(["blocked"], "blocked.txt", { type: "text/plain" }));
        for (const value of ["summary", "customfield_steps", "customfield_expected", "customfield_actual"]) document.querySelector(`[data-bug-value="${value}"]`).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      assert.equal(await page.inputValue('[data-bug-value="summary"]'), summaryBeforeDrop); assert.equal(await page.locator('#bugAttachmentList input').count(), 2);
      await description.evaluate(el => { const transfer = new DataTransfer(); transfer.items.add(new File(["direct"], "direct.txt", { type: "text/plain" })); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })); });
      await page.waitForFunction(() => document.querySelector('[data-bug-value="description"]').value.includes("[Вложение: direct.txt]"));
      assert.equal(await page.locator('#bugAttachmentList input:checked').count(), 3);
      await page.click("#bugBack"); await page.click("#bugReviewDraft");
      assert.match(await description.inputValue(), /\[Вложение: fixture.txt\]/);
      await descField.getByRole('button', { name: 'Визуально', exact: true }).click();
      await page.locator('.bug-report-body').evaluate(el => el.scrollTop = 0);
      await page.screenshot({ path: path.join(output, `${theme}-draft.png`) });
      await page.locator('[data-bug-field="customfield_actual"] .bug-rich-visual').click();
      const lastEditor = await page.locator('[data-bug-field="customfield_actual"] .bug-rich-visual').boundingBox();
      const footer = await page.locator(".bug-wizard-footer").boundingBox(); assert.ok(lastEditor.y < footer.y && lastEditor.y + lastEditor.height <= footer.y, "The larger fields scroll into view above navigation");
      await page.click("#createBugIssue"); await page.waitForFunction(() => !document.getElementById("bugCreatedResult").hidden && document.querySelector("#bugReportModal [role=dialog]").getAttribute("aria-busy") === "false");
      assert.ok((await size())[0] < originalSize[0]); assert.match(await page.textContent("#bugCreatedResult"), /APP-1234/);
      assert.equal(fixture.creates.at(-1).fields.summary, "Моя правка: объект не удаляется");
      assert.deepEqual(fixture.creates.at(-1).fields.labels, ["fixture-label"]);
      assert.deepEqual(fixture.creates.at(-1).fields.components, ["1"]); assert.deepEqual(fixture.creates.at(-1).fields.fixVersions, ["1"]);
      assert.deepEqual(fixture.evidence.at(-1).placements.map(item => item.placeholder), ["[Вложение: fixture.txt]", "[Вложение: screen.png]", "[Вложение: direct.txt]"]);
      assert.equal(fixture.evidence.at(-1).fieldId, "description");
      assert.equal(await page.locator(".bug-success-issue").getAttribute("href"), "https://jira.example.test/browse/APP-1234");
      await page.screenshot({ path: path.join(output, `${theme}-success.png`) });
      await page.getByRole("button", { name: "Создать ещё один", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".bug-report-modal").dataset.step === "1" && !document.getElementById("loadBugContext").disabled);
      assert.equal(await page.inputValue("#bugContextText"), ""); assert.equal(await page.locator(".bug-extra-file").count(), 0);
      assert.deepEqual(errors, []); await context.close();
    }
    const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
    const remotePage = await remoteContext.newPage(); await remotePage.goto(fixture.origin);
    await remotePage.waitForFunction(() => typeof draft !== "undefined" && document.querySelector(".row-menu-button"));
    await remotePage.evaluate(() => {
      draft.sections[0].rows[0].cells.comment = window.QaReportAttachments.reference({ id: "remote-log", name: "remote.txt", type: "text/plain", source: { issueUrl: "https://jira.example.test/browse/APP-1", id: "42", name: "remote.txt", kind: "file" } });
      renderSections();
    });
    await remotePage.locator(".row-menu-button").first().click(); await remotePage.getByRole("button", { name: "Завести баг-репорт", exact: true }).click();
    await remotePage.waitForFunction(() => !document.getElementById("bugProject").disabled);
    await remotePage.fill("#bugProject", "APP"); await remotePage.press("#bugProject", "Tab");
    await remotePage.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
    await remotePage.click("#loadBugContext"); await remotePage.check("#bugAiAttachments"); await remotePage.click("#bugPrepareDraft");
    await remotePage.waitForSelector("#bugEditor:not([hidden])");
    assert.match(fixture.aiRequests.at(-1).textAttachments[0].content, /remote fixture log/);
    await remoteContext.close();
    // Real toolbar file chooser, report-library reuse, source selection and AI regeneration.
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
      await ctx.addInitScript(theme => localStorage.setItem('qa-report-theme', theme), theme);
      const p = await ctx.newPage(); await p.goto(fixture.origin);
      await p.click('#reportMenuButton'); await p.click('#openStandaloneBugReport');
      await p.waitForFunction(() => !document.getElementById('bugProject').disabled);
      await p.fill('#bugProject', 'APP'); await p.press('#bugProject', 'Tab');
      await p.waitForFunction(() => !document.getElementById('loadBugContext').disabled); await p.click('#loadBugContext');
      await p.fill('#bugContextText', 'Проверка форматирования и файлов.'); await p.click('#bugManualDraft');
      const field = p.locator('[data-bug-field="description"]'), visual = field.locator('.bug-rich-visual'), source = field.locator('textarea');
      assert.equal(await p.textContent('#bugReportEyebrow'), 'Создание задачи');
      assert.match(await p.textContent('.bug-prompt-note'), /условия предзаполнения/);
      assert.match(await p.textContent('.bug-prompt-note'), /обязательно.*не хватает/);
      assert.equal(await p.locator('.bug-prompt-card').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
      assert.equal(await field.locator('[data-format="code"]').count(), 0, 'Only one code command');
      assert.equal(await p.locator('.bug-preparation-help').count(), 0);
      await visual.fill('До После'); await field.getByRole('button', { name: 'Разметка', exact: true }).click();
      await source.evaluate(el => el.setSelectionRange(3, 3));
      await field.getByRole('button', { name: 'Вставить вложение в описание', exact: true }).click();
      const chooserWait = p.waitForEvent('filechooser'); await field.getByRole('button', { name: 'Загрузить новый файл', exact: true }).click();
      const chooser = await chooserWait; await chooser.setFiles({ name: 'Исходное имя.log', mimeType: 'text/plain', buffer: Buffer.from('New attachment evidence') });
      await p.waitForFunction(() => document.querySelector('[data-bug-value="description"]').value.includes('[Вложение: Исходное имя.log]'));
      assert.equal(await source.inputValue(), 'До [Вложение: Исходное имя.log]После');
      assert.equal(await p.locator('#bugAiAttachments').isChecked(), true);
      await source.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
      await field.getByRole('button', { name: 'Вставить вложение в описание', exact: true }).click();
      await field.getByRole('button', { name: 'Вставить Исходное имя.log', exact: true }).click();
      assert.equal((await source.inputValue()).match(/\[Вложение: Исходное имя.log\]/g).length, 2);
      assert.equal(await p.locator('#bugAttachmentList input').count(), 1, 'Repeat insertion reuses the same original file');
      await p.click('#bugBack'); await p.click('#bugPrepareDraft'); await p.waitForSelector('#bugEditor:not([hidden])');
      assert.equal(fixture.aiRequests.at(-1).textAttachments[0].name, 'Исходное имя.log');
      assert.match(fixture.aiRequests.at(-1).textAttachments[0].content, /New attachment evidence/);
      assert.equal((await source.inputValue()).match(/\[Вложение: Исходное имя.log\]/g).length, 2, "Regeneration preserves repeat insertions");
      await field.getByRole('button', { name: 'Визуально', exact: true }).click();
      await visual.fill('const value = { name: "original" };\nconsole.log(value);'); await visual.press('ControlOrMeta+A');
      await field.getByRole('button', { name: 'Блок кода', exact: true }).click();
      assert.match((await source.inputValue()).trim(), /^\{code(?::javascript)?\}\nconst value/);
      assert.equal(await visual.locator('pre').count(), 1);
      await p.screenshot({ path: path.join(output, `${theme}-formatting-fixed.png`) });
      await field.getByRole('button', { name: 'Разметка', exact: true }).click();
      await field.getByRole('button', { name: 'Визуально', exact: true }).click();
      assert.match(await visual.locator('pre').innerText(), /console.log/);
      await visual.fill('file_name_x and *literal*'); await field.getByRole('button', { name: 'Разметка', exact: true }).click();
      await field.getByRole('button', { name: 'Визуально', exact: true }).click();
      assert.equal(await visual.innerText(), 'file_name_x and *literal*'); assert.equal(await visual.locator('em, strong').count(), 0);
      // Mouse selection must be wrapped, while text before and after is retained.
      await visual.fill('До console.log(value); После');
      const selectionBox = await visual.evaluate(el => { const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode()) && !node.data.includes('До console.log(value); После')) {} const r = document.createRange(); r.setStart(node, 3); r.setEnd(node, 22); const b = r.getBoundingClientRect(); return { x:b.x, y:b.y, right:b.right, height:b.height }; });
      await p.mouse.move(selectionBox.x, selectionBox.y + selectionBox.height / 2); await p.mouse.down();
      await p.mouse.move(selectionBox.right, selectionBox.y + selectionBox.height / 2, {steps:12}); await p.mouse.up();
      assert.equal(await p.evaluate(() => getSelection().toString()), 'console.log(value);');
      await field.getByRole('button', { name:'Блок кода', exact:true }).click();
      assert.equal(await visual.locator('pre').innerText(), 'console.log(value);');
      assert.match(await source.inputValue(), /^До\s*\n\{code:javascript\}\nconsole\.log\(value\);\n\{code\}\n.*После/s);
      // Clipboard formats and recognition are shared with the checklist.
      for (const [text, html, expected] of [
        ['```js\nconst a = 1;\n```', '', 'const a = 1;'],
        ['{code:sql}\nSELECT * FROM users;\n{code}', '', 'SELECT * FROM users;'],
        ['const a = 1;\nconsole.log(a);', '', 'const a = 1;\nconsole.log(a);'],
        ['print(1)', '<pre class="cell-code-block" data-qa-code-snippet="true" data-language="python"><code>print(1)</code></pre>', 'print(1)']
      ]) {
        await visual.fill(''); await visual.evaluate((el, data) => { const transfer = new DataTransfer(); transfer.setData('text/plain', data.text); if (data.html) transfer.setData('text/html', data.html); el.dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer, bubbles:true, cancelable:true})); }, {text,html});
        assert.equal(await visual.locator('pre').innerText(), expected);
        await field.getByRole('button', {name:'Разметка',exact:true}).click(); await field.getByRole('button', {name:'Визуально',exact:true}).click();
        assert.equal(await visual.locator('pre').innerText(), expected);
      }
      await p.screenshot({ path: path.join(output, `${theme}-selection-and-paste.png`) });
      await visual.locator('pre').click(); await p.keyboard.press('End');
      await visual.evaluate(el => { const data = new DataTransfer(); data.setData('text/plain', '\nprint(2)'); el.dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true})); });
      assert.equal(await visual.locator('pre').count(), 1, 'Pasting inside a code block does not nest another block');
      assert.match(await visual.locator('pre').innerText(), /print\(1\)\nprint\(2\)/);
      // Existing checklist attachments remain available even in a standalone bug.
      await p.click('#closeBugReport');
      await p.evaluate(() => { draft.sections[0].rows[0].cells.comment = window.QaReportAttachments.reference({ id: 'library-log', name: 'Ранее загруженный.log', type: 'text/plain', source: { issueUrl: 'https://jira.example.test/browse/APP-1', id: '42', name: 'Ранее загруженный.log', kind: 'file' } }); renderSections(); });
      await p.click('#reportMenuButton'); await p.click('#openStandaloneBugReport');
      await p.waitForFunction(() => !document.getElementById('loadBugContext').disabled); await p.click('#loadBugContext');
      await p.fill('#bugContextText', 'Проверка вложения из чек-листа.'); await p.click('#bugManualDraft');
      await p.locator('[data-bug-field="description"] .bug-rich-visual').fill('Описание с ранее загруженным файлом.');
      await p.locator('[data-bug-field="description"]').getByRole('button', { name: 'Вставить вложение в описание', exact: true }).click();
      await p.getByRole('button', { name: 'Вставить Ранее загруженный.log', exact: true }).click();
      assert.match(await p.locator('[data-bug-field="description"] .bug-rich-visual').innerText(), /Ранее загруженный.log/);
      await p.screenshot({ path: path.join(output, `${theme}-attachment-reuse.png`) });
      await p.click('#bugBack'); await p.screenshot({ path: path.join(output, `${theme}-prepare-compact.png`) });
      await ctx.close();
    }
    const retryContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" }), retryPage = await retryContext.newPage();
    await retryPage.goto(failedAi.origin); await retryPage.click('#reportMenuButton'); await retryPage.click('#openStandaloneBugReport');
    await retryPage.waitForFunction(() => !document.getElementById('bugProject').disabled);
    await retryPage.fill('#bugProject', 'APP'); await retryPage.press('#bugProject', 'Tab');
    await retryPage.waitForFunction(() => !document.getElementById('loadBugContext').disabled); await retryPage.click('#loadBugContext');
    await retryPage.fill('#bugContextText', 'Контекст после ошибки должен сохраниться.'); await retryPage.click('#bugPrepareDraft');
    await retryPage.waitForFunction(() => document.getElementById('bugReportState').classList.contains('error') && document.querySelector('.bug-report-modal').dataset.generating === 'false');
    assert.equal(await retryPage.locator('.bug-report-modal').getAttribute('data-step'), '2');
    assert.equal(await retryPage.inputValue('#bugContextText'), 'Контекст после ошибки должен сохраниться.');
    assert.match(await retryPage.locator('#bugReportMessage').textContent(), /ИИ не ответил/);
    assert.ok(await retryPage.locator('.bug-report-modal').evaluate(el => el.scrollWidth <= el.clientWidth), 'The narrow wizard has no horizontal overflow');
    await retryPage.click('#bugManualDraft'); await retryPage.waitForSelector('#bugEditor:not([hidden])');
    await retryPage.screenshot({ path: path.join(output, 'narrow-draft.png') });
    await retryContext.close();
    // First-load progress stays visible; a remembered type needs one metadata request.
    for (const remembered of ['1', '999']) {
      const startup = await start(root, 0, {metadataDelay:400, rejectType:'999', devices:[
        {online:true,version:'0.6.3',lastSeenAt:new Date().toISOString(),jiraBaseUrls:['https://other.example.test']},
        {online:true,version:'0.6.17',lastSeenAt:new Date(Date.now()-1000).toISOString(),jiraBaseUrls:['https://jira.example.test']}
      ]});
      const ctx = await browser.newContext({viewport:{width:1280,height:960}, serviceWorkers:'block'});
      try {
        await ctx.addInitScript(id => localStorage.setItem('qa-report-bug-target-v1', JSON.stringify({provider:'jira',baseUrl:'https://jira.example.test',projectKey:'APP',mode:'standalone',issueTypeId:id})), remembered);
        const p = await ctx.newPage(); await p.goto(startup.origin); await p.click('#reportMenuButton'); await p.click('#openStandaloneBugReport');
        await p.waitForFunction(() => document.getElementById('bugReportMessage').textContent.includes('тип задачи и поля'));
        assert.equal(await p.locator('#bugReportState').isVisible(), true); assert.equal(await p.locator('#bugSpinner').isVisible(), true);
        assert.equal(await p.locator('#loadBugContext').isDisabled(), true);
        await p.screenshot({path:path.join(output, `target-loading-${remembered}.png`)});
        if (remembered === '1') {
          await p.waitForFunction(() => !document.getElementById('loadBugContext').disabled);
          assert.equal(startup.requests.filter(r => r.path === '/api/jira/issue-context').length, 0);
          assert.equal(startup.requests.filter(r => r.path === '/api/jira/issue-fields').length, 1);
          await p.click('#loadBugContext'); await p.click('#bugManualDraft');
          await p.locator('[data-bug-field="description"] [data-attachments]').click();
          assert.equal(await p.getByRole('button',{name:'Загрузить новый файл',exact:true}).isVisible(), true, 'Attachments use the Connect version for the selected Jira');
        } else {
          await p.waitForFunction(() => document.getElementById('bugReportMessage').textContent.includes('больше недоступен'));
          assert.equal(await p.locator('#bugIssueType').inputValue(), '');
          await p.selectOption('#bugIssueType','1'); await p.waitForFunction(() => !document.getElementById('loadBugContext').disabled);
        }
      } finally { await ctx.close(); await new Promise(resolve => startup.server.close(resolve)); }
    }
    console.log(`${path.basename(root)}: wizard navigation, geometry, themes, prompt, attachments, fields and create/restart passed`);
  } finally { await browser.close(); await Promise.all([fixture, failedAi].map(value => new Promise(resolve => value.server.close(resolve)))); }
})().catch(error => { console.error(error); process.exitCode = 1; });
