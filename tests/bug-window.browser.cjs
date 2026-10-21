"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "/Users/sergeymaldenberg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { start } = require("./fixtures/bug-wizard-preview.cjs");
const root = path.resolve(__dirname, ".."), output = path.resolve(root, "../artifacts/bug-window", path.basename(root));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  fs.mkdirSync(output, { recursive: true }); const browser = await chromium.launch({ headless: true });
  try {
    const cases = ["graphite", "light", "dark"].map(theme => ({ theme, provider: "jira" }));
    if (path.basename(root) === "qa-report") cases.push({ theme: "graphite", provider: "eva" });
    for (const { theme, provider } of cases) {
      const fixture = await start(root, 0, { provider, uploadDelay: 1300, evidenceDelay: 400 });
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
      const baseUrl = provider === "eva" ? "https://eva.example.test/team" : "https://jira.example.test";
      try {
        await context.addInitScript(({ theme, provider, baseUrl }) => {
          localStorage.setItem("qa-report-theme", theme);
          localStorage.setItem("qa-report-bug-target-v1", JSON.stringify({ provider, baseUrl, projectKey: "APP" }));
        }, { theme, provider, baseUrl });
        const p = await context.newPage(), errors = []; p.setDefaultTimeout(15000); p.on("pageerror", e => errors.push(e.message));
        await p.goto(fixture.origin);
        const open = async () => { await p.click("#reportMenuButton"); await p.click("#openStandaloneBugReport"); await p.waitForFunction(() => !document.getElementById("bugCreationMode").disabled || !!document.getElementById("bugRetryAttachments")); };
        const prepare = async prefix => {
          await p.locator('[name="bugCreationMode"][value="standalone"]').check();
          await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
          await p.click("#loadBugContext"); await p.fill("#bugContextText", "Контекст сохранён после сворачивания.");
          await p.setInputFiles("#bugContextFiles", [1, 2, 3].map(i => ({ name: `${prefix}-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`${prefix} content ${i}`) })));
          await p.waitForFunction(() => document.querySelectorAll(".bug-extra-file").length === 3 && !document.getElementById("bugPrepareDraft").disabled);
        };
        await open(); await prepare("first");
        await p.click("#minimizeBugReport");
        assert.equal(await p.locator("#bugReportModal").isVisible(), false);
        assert.equal(await p.locator(".workspace").evaluate(el => el.inert), false);
        assert.equal(await p.locator("#bugDockTitle").textContent(), "Черновик баг-репорта");
        const editor = p.locator(".cell-editor").first();
        if (await editor.count()) { await editor.fill("Правка во время сворачивания"); assert.equal(await editor.innerText(), "Правка во время сворачивания"); }
        await p.click("#restoreBugReport");
        assert.equal(await p.inputValue("#bugContextText"), "Контекст сохранён после сворачивания.");
        assert.equal(await p.locator(".bug-extra-file").count(), 3);
        assert.equal(await p.locator(".bug-report-modal").getAttribute("data-step"), "2");
        await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])");
        await p.fill('[data-bug-value="summary"]', "Ручная правка сохранена");
        await p.click("#minimizeBugReport");
        // Reopening the menu restores the single active wizard instead of replacing it.
        await open(); assert.equal(await p.inputValue('[data-bug-value="summary"]'), "Ручная правка сохранена");
        await p.click("#createBugIssue");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments")?.dataset.phase === "loading");
        await p.click("#minimizeBugReport");
        const bounds = await p.locator("#bugReportDock").boundingBox();
        assert.ok(bounds.width <= 300 && bounds.height <= 110, JSON.stringify(bounds));
        assert.equal(bounds.x, 20); assert.equal(Math.round(bounds.y + bounds.height), 940);
        assert.equal(await p.textContent("#bugDockTitle"), "APP-1234");
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-uploading.png`) });
        await p.waitForFunction(() => document.getElementById("bugDockCount").textContent === "1 из 3");
        await p.click("#restoreBugReport"); await p.click("#closeBugReport");
        assert.equal(await p.locator("#bugUploadConfirm").isVisible(), true);
        assert.equal(await p.textContent("#confirmBugUploadStop"), "Прервать и закрыть");
        assert.equal(await p.locator("#keepBugUpload").evaluate(el => el === document.activeElement), true);
        await p.press("#keepBugUpload", "Shift+Tab"); assert.equal(await p.locator("#confirmBugUploadStop").evaluate(el => el === document.activeElement), true);
        await p.press("#confirmBugUploadStop", "Tab"); assert.equal(await p.locator("#keepBugUpload").evaluate(el => el === document.activeElement), true);
        await p.click("#keepBugUpload"); assert.equal(fixture.creates.length, 1);
        await p.click("#minimizeBugReport"); await p.click("#closeBugDock"); await p.keyboard.press("Escape");
        assert.equal(await p.locator("#bugReportDock").isVisible(), true);
        assert.equal(await p.locator("#bugReportModal").isVisible(), false);
        await p.click("#closeBugDock");
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-confirm.png`) });
        await p.click("#confirmBugUploadStop"); await p.waitForSelector("#bugUploadConfirm[hidden]", { state: "attached" });
        assert.equal(await p.locator("#bugReportDock").isVisible(), false);
        const sent = fixture.requests.filter(r => r.path === "/api/jira/attachments").length;
        await sleep(1500);
        assert.equal(fixture.requests.filter(r => r.path === "/api/jira/attachments").length, sent, "No later files after confirmed cancellation");
        assert.equal(fixture.evidence.length, 0, "Cancellation cannot continue with evidence insertion");
        assert.ok(sent < 3, "The operation was interrupted before its last file");
        await p.reload(); await open();
        await p.waitForFunction(() => document.getElementById("bugRetryAttachments")?.textContent === "Продолжить загрузку");
        assert.equal(fixture.creates.length, 1, "Recovery retains the existing issue");
        assert.equal(fixture.requests.filter(r => r.path === "/api/jira/attachments").length, sent, "Reopening never resumes an intentionally stopped upload");
        await p.click("#bugRetryAttachments"); await p.click("#minimizeBugReport");
        await p.waitForFunction(() => document.getElementById("bugReportDock").dataset.phase === "complete");
        assert.equal(await p.locator("#bugReportDock").isVisible(), true, "Completion stays available until dismissed");
        assert.equal(await p.textContent("#bugDockCount"), "3 из 3");
        assert.equal(fixture.creates.length, 1); assert.equal(fixture.uploads.length, 3, "Retry reuses any accepted in-flight upload");
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-complete.png`) });
        await p.setViewportSize({ width: 390, height: 844 });
        const narrow = await p.locator("#bugReportDock").boundingBox(), help = await p.locator("#feedbackButton").boundingBox();
        assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= help.x, "Dock and help button fit without overlap");
        assert.ok(await p.locator("#bugReportDock").evaluate(el => el.scrollWidth <= el.clientWidth));
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-narrow.png`) });
        await p.setViewportSize({ width: 1280, height: 960 });
        await p.click("#restoreBugReport"); await p.click("#bugCreateAnother");
        await p.waitForFunction(() => !document.getElementById("bugCreationMode").disabled);
        await prepare("second"); await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])"); await p.click("#createBugIssue");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments")?.textContent === "Вложения: 0 из 3 загружено");
        await p.click("#bugCreateAnother");
        assert.equal(await p.locator("#bugUploadConfirm").isVisible(), false, "Create another continues the previous upload in the background");
        await p.waitForFunction(() => document.querySelector(".bug-report-modal").dataset.step === "1" && !document.getElementById("bugCreationMode").disabled);
        assert.equal(await p.locator('[name="bugCreationMode"]:checked').count(), 0, "Create another starts a fresh form instead of recovering the stopped operation");
        assert.equal(fixture.creates.length, 2);
        await p.click("#closeBugReport"); assert.equal(await p.locator("#bugReportModal").isVisible(), false);
        assert.deepEqual(errors, []);
      } finally { await context.close(); await new Promise(resolve => fixture.server.close(resolve)); }
    }
    // A checklist wizard can finish while another report is open. Its metadata
    // must never be written into the new report, even when row IDs are reused.
    {
      const fixture = await start(root, 0, { uploadDelay: 900, evidenceDelay: 300 });
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
      try {
        await context.addInitScript(() => localStorage.setItem("qa-report-bug-target-v1", JSON.stringify({ baseUrl: "https://jira.example.test", projectKey: "APP" })));
        const p = await context.newPage(), errors = []; p.on("pageerror", e => errors.push(e.message)); p.setDefaultTimeout(15000);
        await p.goto(fixture.origin);
        await p.locator(".cell-editor").first().fill("Исходная проверка");
        const source = await p.evaluate(() => ({ reportId: draft.reportId, sectionId: draft.sections[0].id, rowId: draft.sections[0].rows[0].id }));
        await p.evaluate(({ sectionId, rowId }) => window.QaReportBugUI.open(sectionId, rowId, document.querySelector(".row-menu-button")), source);
        await p.locator('[name="bugCreationMode"][value="standalone"]').check(); await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        await p.click("#loadBugContext");
        await p.setInputFiles("#bugContextFiles", [1, 2, 3].map(i => ({ name: `source-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`source content ${i}`) })));
        await p.waitForFunction(() => document.querySelectorAll(".bug-extra-file").length === 3 && !document.getElementById("bugPrepareDraft").disabled);
        await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])"); await p.click("#createBugIssue");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments")?.dataset.phase === "loading");
        await p.click("#minimizeBugReport");
        const uploadDeadline = Date.now() + 10000;
        while (!fixture.requests.some(r => r.path === "/api/jira/attachments")) { assert.ok(Date.now() < uploadDeadline, "An attachment request starts"); await sleep(30); }
        const editor = p.locator(".cell-editor").first();
        await editor.fill("Правка в исходном отчёте"); await editor.focus();
        await p.waitForFunction(() => document.getElementById("bugDockCount").textContent === "1 из 3");
        assert.equal(await editor.evaluate(el => el === document.activeElement), true, "Progress must not rebuild the focused checklist editor");
        assert.equal(await editor.innerText(), "Правка в исходном отчёте");
        await p.click("#clearButton");
        await p.waitForFunction(reportId => draft.reportId !== reportId, source.reportId);
        await p.locator(".cell-editor").first().fill("Правка в новом отчёте");
        await p.waitForFunction(() => document.getElementById("bugReportDock").dataset.phase === "complete");
        const stored = await p.evaluate(async source => {
          const record = await getReportRecord(source.reportId), row = record.document.sections.find(s => s.id === source.sectionId).rows.find(r => r.id === source.rowId);
          return { source: row.bugs, newBugs: draft.sections.flatMap(s => s.rows.flatMap(r => r.bugs || [])), hasForeignLink: JSON.stringify(draft).includes("APP-1234") };
        }, source);
        assert.equal(stored.source.length, 1); assert.equal(stored.source[0].uploads.length, 3); assert.equal(stored.source[0].attachmentsPending, false); assert.equal(stored.source[0].evidencePending, false);
        assert.deepEqual(stored.newBugs, []); assert.equal(stored.hasForeignLink, false);
        assert.equal(await p.locator(".cell-editor").first().innerText(), "Правка в новом отчёте");
        await p.click("#closeBugDock");
        // Finishing successfully while a close confirmation is open performs
        // the originally requested close, without a stale stop confirmation.
        await p.click("#reportMenuButton"); await p.click("#openStandaloneBugReport");
        await p.locator('[name="bugCreationMode"][value="standalone"]').check(); await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        await p.click("#loadBugContext"); await p.fill("#bugContextText", "Проверка завершения во время подтверждения");
        await p.setInputFiles("#bugContextFiles", { name: "finish.txt", mimeType: "text/plain", buffer: Buffer.from("finish") });
        await p.waitForFunction(() => document.querySelectorAll(".bug-extra-file").length === 1 && !document.getElementById("bugPrepareDraft").disabled);
        await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])"); await p.click("#createBugIssue");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments")?.dataset.phase === "loading"); await p.click("#closeBugReport");
        await p.waitForFunction(() => document.getElementById("bugReportModal").hidden && document.getElementById("bugUploadConfirm").hidden);
        assert.equal(fixture.creates.length, 2); assert.equal(fixture.uploads.length, 4);
        assert.deepEqual(errors, []);
      } finally { await context.close(); await new Promise(resolve => fixture.server.close(resolve)); }
    }
    console.log(`${path.basename(root)}: compact dock, draft restoration, background progress, cancellation, recovery, fresh creation, keyboard and narrow layout passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
