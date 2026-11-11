const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fixture } = require("./helpers/shared-report-server.cjs");

const cleanup = [];
let browser;
async function main() {
  const f = await fixture({ after: fn => cleanup.push(fn) });
  const directory = process.env.QA_REPORT_SCREENSHOT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "qa-answer-statuses-"));
  await fs.mkdir(directory, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  // The isolated sharing fixture has no session middleware; serve its synthetic CSRF token.
  await context.route("**/api/auth/csrf", route => route.fulfill({ json: { csrfToken: "synthetic-fixture-csrf" } }));
  const url = f.url(f.publication.replyToken);
  await page.goto(url);
  await page.locator("#report").waitFor();
  const select = page.getByRole("combobox", { name: "Статус ответа пункта 1.1", exact: true });
  const comment = page.getByRole("textbox", { name: "Комментарий к пункту 1.1", exact: true });
  const labels = ["Не рассмотрено", "Исправлено", "Не исправлено", "Требует уточнения", "Уточнено", "Изменения не требуются", "Отложено"];
  assert.deepEqual(await select.locator("option").allTextContents(), labels);
  const cases = [["not_fixed", "negative"], ["clarified", "informative"], ["no_changes_needed", "positive"], ["deferred", "muted"]];
  for (const [status, tone] of cases) {
    const explanation = "Решение по пункту: " + status;
    await comment.fill(explanation);
    const saved = page.waitForResponse(response => response.url().endsWith("/answers") && response.request().postDataJSON().status === status && response.ok());
    await select.selectOption(status);
    await saved;
    await page.reload();
    await select.waitFor();
    assert.equal(await select.inputValue(), status);
    assert.equal(await comment.textContent(), explanation);
    assert.equal(await page.locator("#answer-panel-status").getAttribute("data-tone"), tone);
    assert.equal((await f.read()).data.report.sections[0].rows[0].status, "NOT_OK");
    await page.locator('button[data-answer-view="table"]').click();
    assert.equal(await select.inputValue(), status);
    assert.equal(await select.locator("..").getAttribute("data-tone"), tone);
    await page.locator('button[data-answer-view="side"]').click();
  }
  await select.selectOption("no_changes_needed");
  await page.waitForFunction(() => document.querySelector("#saveState").dataset.state === "saved");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["side", "table"]) {
      await page.locator('button[data-answer-view="' + view + '"]').click();
      const fits = await select.evaluate(element => {
        const style = getComputedStyle(element);
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
        ctx.font = style.font;
        const required = ctx.measureText(element.selectedOptions[0].textContent).width;
        return { required, available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      assert.ok(fits.required <= fits.available, JSON.stringify({ width, view, ...fits }));
      await page.screenshot({ path: path.join(directory, view + "-" + width + ".png") });
    }
  }
  for (const [status] of cases) {
    await select.selectOption(status);
    await page.waitForFunction(() => document.querySelector("#saveState").dataset.state === "saved");
    await page.goto(f.url(f.publication.readToken));
    await page.locator("#report").waitFor();
    await page.locator('button[data-answer-view="table"]').click();
    assert.equal(await page.locator("td.correction-status").textContent(), labels[{ not_fixed: 2, clarified: 4, no_changes_needed: 5, deferred: 6 }[status]]);
    assert.equal(await page.locator("td.correction-status select").count(), 0);
    await page.goto(url);
    await select.waitFor();
  }
  assert.deepEqual(errors, []);
  console.log("Answer statuses: persistence, both layouts, read-only labels, QA result and desktop/mobile passed. Screenshots: " + directory);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  for (const fn of cleanup.reverse()) await fn();
});
