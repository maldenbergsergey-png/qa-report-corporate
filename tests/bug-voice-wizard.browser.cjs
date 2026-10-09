"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "/Users/sergeymaldenberg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { start } = require("./fixtures/bug-wizard-preview.cjs");
const root = path.resolve(__dirname, "..");
(async () => {
  const fixture = await start(root), fallback = await start(root, 0, { fallback: true, noAi: true });
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
    await context.addInitScript(() => {
      localStorage.setItem("qa-report-theme", "dark");
      class Recognition { start() { window.fixtureRecognition = this; this.onstart(); } stop() { this.onend(); } abort() { this.onend?.(); } }
      window.SpeechRecognition = Recognition;
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(), output = audio.createMediaStreamDestination();
        gain.gain.value = .14; oscillator.connect(gain); gain.connect(output); oscillator.start(); await audio.resume();
        for (const track of output.stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); oscillator.stop(); audio.close(); }; }
        return output.stream;
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = []; page.on("pageerror", error => errors.push(error.message));
    async function prepare(origin) {
      await page.goto(origin); await page.click("#reportMenuButton"); await page.click("#openStandaloneBugReport"); await page.locator('[name="bugCreationMode"][value="standalone"]').check();
      await page.waitForFunction(() => !document.getElementById("bugProject").disabled); await page.fill("#bugProject", "APP"); await page.press("#bugProject", "Tab");
      await page.waitForFunction(() => !document.getElementById("loadBugContext").disabled); await page.click("#loadBugContext");
    }
    await prepare(fixture.origin); await page.fill("#bugContextText", "Исходное описание");
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(["drop fixture"], "dropped.txt", { type: "text/plain" }));
      document.getElementById("bugExtraContext").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForSelector(".bug-extra-file"); assert.equal(await page.inputValue("#bugContextText"), "Исходное описание");
    await page.click("#bugVoice"); await page.waitForFunction(() => document.getElementById("bugVoicePanel").dataset.phase === "recording");
    await page.waitForFunction(() => document.querySelectorAll('#bugVoiceWave rect[height="2"]').length < 60);
    await page.waitForFunction(() => !document.getElementById("bugVoiceTime").textContent.startsWith("0:00"));
    assert.equal(await page.locator("#bugPrepareDraft").isDisabled(), true);
    assert.equal(await page.locator("#bugVoicePanel").evaluate(el => getComputedStyle(el).borderWidth), "0px");
    const output = path.resolve(root, "../artifacts/bug-wizard", path.basename(root)); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "dark-recording.png") });
    await page.evaluate(() => document.documentElement.dataset.theme = "light");
    assert.deepEqual(await page.locator('#bugVoice').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity })), { color: 'rgb(255, 255, 255)', background: 'rgb(255, 25, 61)', opacity: '1' });
    await page.screenshot({ path: path.join(output, "light-recording.png") });
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    // Browser pauses and no-speech events must keep recording and preserve all segments.
    await page.evaluate(() => { const result = [{ transcript: "Первая часть." }]; result.isFinal = true; window.fixtureRecognition.onresult({ resultIndex: 0, results: [result] }); window.fixtureRecognition.onerror({ error: "no-speech" }); window.fixtureRecognition.onend(); });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#bugVoicePanel').getAttribute('data-phase'), 'recording');
    assert.equal(await page.locator('#bugVoiceHint').isVisible(), false);
    assert.equal(await page.inputValue('#bugContextText'), 'Исходное описание');
    await page.evaluate(() => { const result = [{ transcript: "Добавленный голосом текст." }]; result.isFinal = true; window.fixtureRecognition.onresult({ resultIndex: 0, results: [result] }); });
    await page.click("#bugVoiceStop"); assert.equal(await page.inputValue("#bugContextText"), "Исходное описание\n\nПервая часть. Добавленный голосом текст.");
    await page.click("#bugVoice"); await page.waitForFunction(() => document.getElementById("bugVoicePanel").dataset.phase === "recording");
    await page.click("#bugVoiceCancel"); assert.equal(await page.inputValue("#bugContextText"), "Исходное описание\n\nПервая часть. Добавленный голосом текст.");
    // Without AI or dedicated Jira fields, manual sections still publish through description.
    await page.click("#closeBugReport"); await prepare(fallback.origin);
    await page.waitForFunction(() => document.getElementById("bugAiProfile").textContent.includes("ИИ не подключён"));
    assert.equal(await page.locator("#bugPrepareDraft").isDisabled(), false); await page.click("#bugPrepareDraft");
    await page.fill('[data-bug-value="summary"]', "Ручной баг"); await page.fill('[data-bug-field="description"] .bug-rich-visual', "Описание пользователя");
    await page.fill('[data-bug-virtual="steps"] .bug-rich-visual', "Шаг"); await page.fill('[data-bug-virtual="expected"] .bug-rich-visual', "Правильное поведение"); await page.fill('[data-bug-virtual="actual"] .bug-rich-visual', "Неверное поведение");
    await page.press('[data-bug-field="description"] .bug-rich-visual', "ControlOrMeta+A"); await page.locator('[data-bug-field="description"]').getByRole("button", { name: "Полужирный", exact: true }).click();
    assert.equal(await page.inputValue('[data-bug-value="description"]'), "*Описание пользователя*");
    await page.click("#bugBack"); await page.click("#bugReviewDraft"); assert.equal(await page.inputValue('[data-bug-section="steps"]'), "Шаг");
    await page.click("#createBugIssue"); await page.waitForFunction(() => document.querySelector("#bugReportModal [role=dialog]").dataset.step === "4" && document.querySelector("#bugReportModal [role=dialog]").getAttribute("aria-busy") === "false");
    assert.equal(fallback.creates[0].fields.description, "*Описание пользователя*\n\nШаги воспроизведения\nШаг\n\nОжидаемый результат\nПравильное поведение\n\nФактический результат\nНеверное поведение");
    assert.deepEqual(errors, []); console.log(`${path.basename(root)}: voice waveform/transcript/cancel, drag & drop and manual fallback passed`);
  } finally { await browser.close(); await Promise.all([fixture, fallback].map(value => new Promise(resolve => value.server.close(resolve)))); }
})().catch(error => { console.error(error); process.exitCode = 1; });
