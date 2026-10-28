"use strict";
const { chromium } = require(process.env.QA_REPORT_PLAYWRIGHT || "playwright");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict"), crypto = require("node:crypto");
(async () => {
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Upload fixture</title>"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, "../jira-upload-client.js"), "utf8") });
    let posts = 0, gets = 0, mode = "normal", id = crypto.randomUUID();
    await page.route("**/api/jira/**", async route => {
      const request = route.request();
      if (request.method() === "POST") {
        posts++; assert.equal(request.postDataJSON().operationId, id);
        if (mode === "lost-submit") return route.abort("failed");
        return route.fulfill({ status: 202, json: { statusUrl: `/api/jira/uploads/${id}` } });
      }
      gets++;
      if (mode === "transient-poll" && gets === 1) return route.fulfill({ status: 502, json: {} });
      if (mode === "504") return route.fulfill({ json: { operationId: id, state: "unknown", phase: "upload", status: 504, errorCode: "JIRA_UPSTREAM_ERROR", error: "Jira или шлюз перед ней вернули HTTP 504" } });
      if (mode === "cancel" || (mode === "normal" && gets === 1)) return route.fulfill({ json: { operationId: id, state: "running", phase: "upload" } });
      return route.fulfill({ json: { operationId: id, state: "completed", result: { attachments: [{ id: "42" }] } } });
    });
    for (const value of ["normal", "lost-submit", "transient-poll", "504", "cancel"]) {
      mode = value; posts = 0; gets = 0; id = crypto.randomUUID();
      const result = await page.evaluate(async ({ id, mode }) => {
        const controller = new AbortController(), stages = [];
        if (mode === "cancel") setTimeout(() => controller.abort(), 200);
        try { const result = await QaReportJiraUploads.send("/api/jira/attachments", { operationId: id, files: [{ name: "fixture.txt", type: "text/plain", dataBase64: "YQ==" }] }, { signal: controller.signal, onStage: text => stages.push(text) }); return { result, stages }; }
        catch (error) { return { status: error.status, code: error.code, name: error.name, message: error.message }; }
      }, { id, mode });
      assert.equal(posts, 1, "Polling and response recovery must never repeat the upload POST");
      if (mode === "504") { assert.equal(result.status, 504); assert.equal(result.code, "JIRA_UPSTREAM_ERROR"); assert.ok(result.message.includes(id)); }
      else if (mode === "cancel") assert.equal(result.name, "AbortError");
      else { assert.equal(result.result.attachments[0].id, "42"); if (mode === "normal") assert.ok(result.stages.some(text => text.includes("подтверждения Jira"))); }
    }
    console.log("PASS: async stages, lost submission reply, transient status failure, genuine upstream 504 and cancellation; every case sends one file POST.");
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
