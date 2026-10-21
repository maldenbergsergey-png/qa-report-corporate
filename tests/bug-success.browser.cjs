"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "/Users/sergeymaldenberg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { start } = require("./fixtures/bug-wizard-preview.cjs");
const root = path.resolve(__dirname, ".."), output = path.resolve(root, "../artifacts/bug-wizard", path.basename(root));
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const cases = ["dark", "light", "graphite"].map(theme => ({ theme, provider: "jira", failUploads: theme === "graphite" ? 1 : 0 }));
    if (path.basename(root) === "qa-report") cases.push({ theme: "dark", provider: "eva", failUploads: 0 });
    for (const { theme, provider, failUploads } of cases) {
      const fixture = await start(root, 0, { provider, failUploads, metadataDelay: 200, uploadDelay: 700, evidenceDelay: 500 });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
      const baseUrl = provider === "eva" ? "https://eva.example.test/team" : "https://jira.example.test";
      try {
        await ctx.addInitScript(({ theme, provider, baseUrl }) => {
          localStorage.setItem("qa-report-theme", theme);
          localStorage.setItem("qa-report-bug-target-v1", JSON.stringify({ provider, baseUrl, projectKey: "APP", parent: `${baseUrl}/${provider === "eva" ? "desk/Task" : "browse"}/APP-123`, mode: "standalone", issueTypeId: "1" }));
        }, { theme, provider, baseUrl });
        const p = await ctx.newPage(), errors = []; p.setDefaultTimeout(15000); p.on("pageerror", error => errors.push(error.message));
        await p.goto(fixture.origin); await p.click("#reportMenuButton"); await p.click("#openStandaloneBugReport");
        await p.waitForFunction(() => !document.getElementById("bugCreationMode").disabled);
        const metadata = () => fixture.requests.filter(request => /issue-(context|fields|projects)$/.test(request.path));
        assert.equal(await p.locator('[name="bugCreationMode"]:checked').count(), 0, "A previous preference does not select a new task mode");
        assert.equal(await p.locator("#bugProject").isDisabled(), true);
        assert.equal(await p.locator("#bugParent").isDisabled(), true);
        assert.equal(await p.locator("#loadBugContext").isDisabled(), true);
        assert.equal(await p.locator("#bugTargetChoiceHint").isVisible(), true);
        assert.deepEqual(metadata(), [], "No project, type or field request before choosing a mode");
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-mode-choice.png`) });
        await p.locator('[name="bugCreationMode"][value="subtask"]').check();
        await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        assert.equal(await p.locator("#bugParentField").isVisible(), true);
        assert.equal(await p.inputValue("#bugIssueType"), "2");
        assert.ok(metadata().filter(request => request.path !== "/api/jira/issue-projects").every(request => request.input.mode === "subtask"), "Only subtask metadata loads when subtask is chosen first");
        assert.equal(await p.locator("#bugTargetChoiceHint").isVisible(), false);
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-subtask-ready.png`) });
        await p.locator('[name="bugCreationMode"][value="standalone"]').check();
        await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        assert.equal(await p.inputValue("#bugIssueType"), "1");
        assert.equal(metadata().at(-1).input.mode, "standalone");
        await p.click("#loadBugContext"); await p.fill("#bugContextText", "Форма не сохраняется при нажатии кнопки.");
        await p.setInputFiles("#bugContextFiles", [
          { name: "original-log.txt", mimeType: "text/plain", buffer: Buffer.from("original log") },
          { name: "original-data.json", mimeType: "application/json", buffer: Buffer.from('{"result":"error"}') }
        ]);
        await p.waitForFunction(() => document.querySelectorAll(".bug-extra-file").length === 2 && !document.getElementById("bugPrepareDraft").disabled);
        await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])");
        await p.click("#createBugIssue");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments")?.textContent === "Вложения: 0 из 2 загружено");
        const checkMinimal = async () => {
          assert.equal(await p.locator("#bugCreatedResult a").count(), 1);
          assert.ok(await p.locator(".bug-success-issue").evaluate(el => el.lastElementChild.getBoundingClientRect().top >= el.firstElementChild.getBoundingClientRect().bottom), "Task key and summary occupy separate rows without overlap");
          assert.equal(await p.locator(".bug-success-link").getAttribute("href"), `${baseUrl}/${provider === "eva" ? "desk/Task" : "browse"}/APP-1234`);
          assert.equal(await p.locator("#bugReportState").isVisible(), false);
          assert.equal(await p.locator(".bug-wizard-footer").isVisible(), false);
          assert.equal(await p.getByRole("button", { name: "Закрыть", exact: true }).count(), 0);
          assert.equal(await p.locator("#closeBugReport").isVisible(), true);
          assert.equal(await p.locator(".bug-success-check .ui-icon").count(), 1);
          assert.equal(await p.getByRole("heading", { name: "Баг-репорт создан", exact: true }).count(), 1);
          assert.equal(await p.locator(".bug-report-modal").getAttribute("aria-labelledby"), "bugCreatedTitle");
          assert.doesNotMatch(await p.textContent("#bugCreatedResult"), /Jira|EVA|Завершаем|Открыть в/);
        };
        await checkMinimal();
        assert.equal(await p.locator("#bugCreatedAttachments .bug-spinner").count(), 1);
        assert.equal(await p.locator("#bugCreateAnother").isDisabled(), false);
        assert.equal(await p.locator("#closeBugReport").isDisabled(), false);
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-success-uploading.png`) });
        if (failUploads) {
          await p.waitForFunction(() => document.getElementById("bugRetryAttachments") && !document.getElementById("bugRetryAttachments").hidden);
          assert.match(await p.textContent("#bugCreatedError"), /не все вложения/i);
          assert.equal(fixture.creates.length, 1);
          await p.screenshot({ path: path.join(output, `${theme}-${provider}-success-retry.png`) });
          await p.click("#closeBugReport"); await p.click("#confirmBugUploadStop"); await p.waitForSelector("#bugReportModal[hidden]", { state: "attached" }); await p.reload(); await p.click("#reportMenuButton"); await p.click("#openStandaloneBugReport");
          await p.waitForFunction(() => document.getElementById("bugRetryAttachments") && !document.getElementById("bugRetryAttachments").hidden);
          assert.equal(await p.locator('[name="bugCreationMode"][value="standalone"]').isChecked(), true, "An unfinished operation keeps its mode");
          assert.equal(await p.locator('[name="bugCreationMode"][value="standalone"]').isDisabled(), true);
          await p.click("#bugRetryAttachments");
        }
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments").textContent === "Вложения: 1 из 2 загружено");
        // The task link keeps focus while progress is refreshed.
        await p.focus(".bug-success-link");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments").textContent === "Вложения: 2 из 2 загружено");
        assert.equal(await p.locator("#bugCreatedAttachments").getAttribute("data-phase"), "loading", "Evidence insertion is still pending after uploading files");
        await p.waitForFunction(() => document.getElementById("bugCreatedAttachments").dataset.phase === "complete");
        assert.equal(await p.locator("#bugCreatedAttachments .bug-spinner").count(), 0);
        assert.equal(await p.locator('#bugCreatedAttachments use[href="#icon-check"]').count(), 1);
        assert.equal(await p.locator(".bug-success-link").evaluate(el => el === document.activeElement), true);
        assert.equal(await p.locator("#bugRetryAttachments").isVisible(), false);
        assert.equal(await p.locator("#bugCreatedError").isVisible(), false);
        assert.equal(await p.locator("#bugCreateAnother").isDisabled(), false);
        assert.equal(fixture.creates.length, 1, "Upload retry does not create another task");
        assert.deepEqual(fixture.uploads.map(file => file.filename), ["original-log.txt", "original-data.json"]);
        await checkMinimal(); await p.screenshot({ path: path.join(output, `${theme}-${provider}-success-complete.png`) });
        await p.click("#bugCreateAnother"); await p.waitForFunction(() => !document.getElementById("bugCreationMode").disabled);
        assert.equal(await p.locator('[name="bugCreationMode"]:checked').count(), 0);
        assert.equal(await p.locator("#loadBugContext").isDisabled(), true);
        await p.locator('[name="bugCreationMode"][value="standalone"]').check(); await p.waitForFunction(() => !document.getElementById("loadBugContext").disabled);
        await p.click("#loadBugContext"); await p.fill("#bugContextText", "Проверка без файлов."); await p.click("#bugPrepareDraft"); await p.waitForSelector("#bugEditor:not([hidden])");
        await p.click("#createBugIssue"); await p.waitForFunction(() => document.querySelector(".bug-report-modal").dataset.step === "4" && document.querySelector(".bug-report-modal").getAttribute("aria-busy") === "false");
        assert.equal(await p.locator("#bugCreatedAttachments").isVisible(), false, "No empty attachment status when there are no files");
        await p.setViewportSize({ width: 390, height: 844 });
        assert.ok(await p.locator(".bug-report-modal").evaluate(el => el.scrollWidth <= el.clientWidth), "Compact completion fits a narrow viewport");
        await p.screenshot({ path: path.join(output, `${theme}-${provider}-success-narrow.png`) });
        await p.click("#closeBugReport"); assert.equal(await p.locator("#bugReportModal").isVisible(), false);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); await new Promise(resolve => fixture.server.close(resolve)); }
    }
    console.log(`${path.basename(root)}: explicit mode, matching metadata, compact completion, progress, retry/recovery, Jira/EVA links and narrow layout passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
