"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "/Users/sergeymaldenberg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { start } = require("./fixtures/bug-wizard-preview.cjs");
const root = path.resolve(__dirname, ".."), output = path.resolve(root, "../artifacts/bug-multiple", path.basename(root));
(async () => {
  fs.mkdirSync(output, { recursive: true }); const browser = await chromium.launch({ headless: true });
  try {
    for (const provider of path.basename(root) === "qa-report" ? ["jira", "eva"] : ["jira"]) {
      const fixture = await start(root, 0, { provider, uniqueIssues: true, uploadDelay: 2200, createDelay: 3000, failIssueKeys: ["APP-1235"] });
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
      try {
        const baseUrl = provider === "eva" ? "https://eva.example.test/team" : "https://jira.example.test";
        await context.addInitScript(({ provider, baseUrl }) => {
          localStorage.setItem("qa-report-theme", "graphite");
          localStorage.setItem("qa-report-bug-target-v1", JSON.stringify({ provider, baseUrl, projectKey: "APP" }));
        }, { provider, baseUrl });
        const p = await context.newPage(), errors = []; p.setDefaultTimeout(20000); p.on("pageerror", e => errors.push(e.message));
        await p.goto(fixture.origin); await p.locator(".cell-editor").first().fill("Исходная проверка для нескольких багов");
        const source = await p.evaluate(() => ({ reportId: draft.reportId, sectionId: draft.sections[0].id, rowId: draft.sections[0].rows[0].id }));
        await p.evaluate(({ sectionId, rowId }) => window.QaReportBugUI.open(sectionId, rowId, document.querySelector(".row-menu-button")), source);
        const prepare = async number => {
          await p.waitForFunction(() => !document.getElementById("bugCreationMode").disabled);
          await p.locator('[name="bugCreationMode"][value="standalone"]').check();
          await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
          await p.click("#loadBugContext"); await p.fill("#bugContextText", `Контекст бага ${number}`);
          await p.setInputFiles("#bugContextFiles", [1, 2, 3, 4].map(i => ({ name: `bug-${number}-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`independent ${number} file ${i}`) })));
          await p.waitForFunction(() => document.querySelectorAll(".bug-extra-file").length === 4 && !document.getElementById("bugPrepareDraft").disabled);
          await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])");
          await p.fill('[data-bug-value="summary"]', `Отдельный баг ${number}`);
        };
        for (let i = 1; i <= 3; i++) {
          await prepare(i); await p.click("#createBugIssue");
          if (i === 2) {
            await p.waitForFunction(() => Number(document.querySelector("#bugUploadDockList progress")?.value) > 0);
            const pending = await p.evaluate(() => draft.sections[0].rows[0].pendingBug?.id);
            assert.equal(pending, fixture.creates[1].operationId, "An earlier upload cannot erase a later task's pending creation");
          }
          await p.waitForFunction(number => document.querySelector(".bug-report-modal").dataset.step === "4" && document.querySelector("#bugCreatedResult .bug-success-link strong")?.textContent === `APP-${1233+number}`, i);
          assert.equal(await p.locator("#bugCreatedResult .bug-success-link strong").textContent(), `APP-${1233+i}`);
          await p.click("#bugCreateAnother");
          await p.waitForFunction(() => document.querySelector(".bug-report-modal").dataset.step === "1" && !document.getElementById("bugCreationMode").disabled);
          assert.equal(await p.locator("#bugUploadConfirm").isVisible(), false, "Create another never asks to stop the previous task");
          assert.equal(await p.locator("#bugUploadDockList [data-bug-operation]").count(), i);
        }
        const ids = fixture.creates.map(value => value.operationId), card = index => p.locator(`[data-bug-operation="${ids[index]}"]`);
        assert.equal(fixture.creates.length, 3);
        assert.equal(await card(0).getAttribute("data-phase"), "loading");
        assert.equal(await card(2).getAttribute("data-phase"), "loading");
        // Keep an editable fourth draft while viewing previous task results.
        await p.locator('[name="bugCreationMode"][value="standalone"]').check(); await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        await p.click("#loadBugContext"); await p.fill("#bugContextText", "Не потерять новый черновик");
        await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])"); await p.fill('[data-bug-value="summary"]', "Мой новый черновик");
        await p.click("#minimizeBugReport");
        assert.equal(await p.locator("#bugReportDock").isVisible(), true);
        await p.screenshot({ path: path.join(output, `${provider}-three-uploads.png`) });
        await card(0).locator(".bug-dock-restore").click();
        assert.equal(await p.locator("#backgroundBugCreatedResult .bug-success-link strong").textContent(), "APP-1234");
        await p.click("#closeBackgroundBug");
        assert.match(await p.textContent("#bugUploadConfirmText"), /APP-1234/);
        await p.click("#confirmBugUploadStop"); await p.waitForSelector("#bugUploadConfirm[hidden]", { state: "attached" });
        assert.equal(await card(0).count(), 0);
        const sentFirst = fixture.requests.filter(r => r.path === "/api/jira/attachments" && r.input.issueUrl.endsWith("/APP-1234")).length;
        await p.waitForFunction(id => document.querySelector(`[data-bug-operation="${id}"]`)?.dataset.phase === "error", ids[1]);
        await card(1).locator(".bug-dock-restore").click();
        assert.match(await p.textContent("#backgroundBugCreatedError"), /ошибка отдельного бага/);
        await p.click("#backgroundBugCreateAnother");
        assert.equal(await p.inputValue('[data-bug-value="summary"]'), "Мой новый черновик", "Returning to creation preserves the active draft");
        assert.equal(await p.inputValue("#bugContextText"), "Не потерять новый черновик");
        assert.equal(await p.locator(".bug-report-modal").getAttribute("data-step"), "3");
        assert.equal(fixture.creates.length, 3);
        // Close only the unfinished draft, switch reports, and recover multiple
        // created tasks after reload. None of them may resume automatically.
        await p.click("#closeBugReport"); await p.click("#clearButton");
        await p.waitForFunction(id => draft.reportId !== id, source.reportId);
        await p.reload();
        await p.waitForFunction(() => document.querySelectorAll("#bugUploadDockList [data-bug-operation]").length === 2);
        const sentAfterReload = fixture.requests.filter(r => r.path === "/api/jira/attachments").length;
        assert.equal(await card(1).getAttribute("data-phase"), "pending"); assert.equal(await card(2).getAttribute("data-phase"), "pending");
        await p.setViewportSize({ width: 390, height: 844 });
        const bounds = await p.locator("#bugDockStack").boundingBox(), help = await p.locator("#feedbackButton").boundingBox();
        assert.ok(bounds.height <= 440 && bounds.x + bounds.width <= help.x, "Multiple cards stay within a compact scrollable area without covering help");
        await p.screenshot({ path: path.join(output, `${provider}-narrow-stack.png`) });
        await p.setViewportSize({ width: 1280, height: 960 });
        assert.equal(fixture.requests.filter(r => r.path === "/api/jira/attachments").length, sentAfterReload);
        for (const index of [1, 2]) {
          await card(index).locator(".bug-dock-restore").click(); await p.click("#backgroundBugRetryAttachments"); await p.click("#minimizeBackgroundBug");
        }
        await card(2).locator(".bug-dock-restore").click(); await p.click("#backgroundBugCreateAnother");
        await p.waitForFunction(() => !document.getElementById("bugCreationMode").disabled);
        await p.locator('[name="bugCreationMode"][value="standalone"]').check(); await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        await p.click("#loadBugContext"); await p.fill("#bugContextText", "Другой отчёт не меняется от фоновых загрузок");
        await p.click("#minimizeBugReport");
        await p.waitForFunction(ids => ids.every(id => document.querySelector(`[data-bug-operation="${id}"]`)?.dataset.phase === "complete"), ids.slice(1));
        assert.equal(fixture.creates.length, 3, "Retries cannot create more issues");
        assert.equal(fixture.requests.filter(r => r.path === "/api/jira/attachments" && r.input.issueUrl.endsWith("/APP-1234")).length, sentFirst, "Stopping one task prevents only that task's next files");
        for (const key of ["APP-1235", "APP-1236"]) {
          const files = fixture.uploads.filter(file => file.issueUrl.endsWith("/" + key));
          assert.equal(files.length, 4); assert.equal(new Set(files.map(file => file.filename)).size, 4, "Recovery and retry never duplicate accepted files");
          const evidence = fixture.evidence.find(item => item.issueKey === key);
          assert.ok(evidence); assert.deepEqual(new Set(evidence.attachmentIds), new Set(files.map(file => file.id)), "Evidence contains only this issue's attachments");
        }
        const saved = await p.evaluate(async source => {
          const record = await getReportRecord(source.reportId), row = record.document.sections.find(s => s.id === source.sectionId).rows.find(r => r.id === source.rowId);
          return { bugs: row.bugs, newBugs: draft.sections.flatMap(s => s.rows.flatMap(r => r.bugs || [])) };
        }, source);
        assert.equal(saved.bugs.length, 3); assert.deepEqual(saved.newBugs, []);
        for (const bug of saved.bugs.slice(1)) { assert.equal(bug.uploads.length, 4); assert.equal(bug.attachmentsPending, false); assert.equal(bug.evidencePending, false); }
        await p.click("#restoreBugReport"); assert.equal(await p.inputValue("#bugContextText"), "Другой отчёт не меняется от фоновых загрузок");
        await p.click("#closeBugReport");
        await card(1).locator(".bug-dock-close").click(); assert.equal(await card(1).count(), 0); assert.equal(await card(2).count(), 1);
        await card(2).locator(".bug-dock-close").click(); assert.equal(await p.locator("#bugDockStack").isVisible(), false);
        assert.deepEqual(errors, []);
      } finally { await context.close(); await new Promise(resolve => fixture.server.close(resolve)); }
    }
    console.log(`${path.basename(root)}: parallel bug uploads, fresh creation, preserved draft, independent cancellation/failure/retry, durable recovery, source isolation and compact stack passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
