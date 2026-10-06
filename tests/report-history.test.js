const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function functionSource(file, name) {
  const source = fs.readFileSync(require.resolve(`../${file}`), "utf8");
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

for (const file of ["app.js", "server.js"]) {
  test(`${file}: task keys are recognized outside Jira browse URLs`, () => {
    const ctx = vm.createContext({ URL });
    vm.runInContext(functionSource(file, "issueKeyFromUrl"), ctx);
    for (const value of [
      "https://tasks.example.test/project/Task/QA-123",
      " https://tasks.example.test/project/Task/qa-123/?view=details#comments ",
      "https://jira.example.test/browse/QA-123",
      "https://jira.example.test/jira/browse/qa-123?focusedCommentId=456",
      "qa-123",
    ]) assert.equal(ctx.issueKeyFromUrl(value), "QA-123", value);
    for (const value of ["", null, "https://tasks.example.test/project/Task/", "https://tasks.example.test/project/Task/QA-123invalid"]) {
      assert.equal(ctx.issueKeyFromUrl(value), "", String(value));
    }
  });
}

function element() {
  return {
    children: [], value: "", textContent: "", classList: { toggle() {} },
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html || ""; },
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

function harness(records = new Map()) {
  const ctx = vm.createContext({
    URL, localEditGeneration: 0, historyRenderRequestId: 0, historyLoading: false, document: { createElement: element },
    draft: { reportId: "report", publicId: "abc12345", issueUrl: "", environment: "STAGE", sections: [] },
    elements: {
      issueUrl: element(), environment: { value: "STAGE" }, overallStatus: { value: "OK" },
      historyModal: { hidden: true }, clearHistoryButton: element(), saveHistorySnapshotButton: element(),
      introEditor: element(), sections: element(), historySearch: element(), historyList: element(), historyUsage: element(),
    },
    requestAnimationFrame: callback => setImmediate(callback), syncBodyModalOverflow() {}, setSaveStatus() {},
    clone: structuredClone, cleanEditorHtml: () => "", suppressNextServerSave: false,
    getReportRecord: async id => structuredClone(records.get(id)),
    dbTransaction: async (mode, action) => action({ put: record => records.set(record.id, structuredClone(record)) }),
    trimReportHistory: async () => {}, queueServerReportSave() {},
    getAllReports: async () => [...records.values()].map(record => structuredClone(record)),
    getServerReports: async () => [], reportPublicId: report => report.publicId,
  });
  for (const name of ["copyDraftValue", "issueKeyFromUrl", "collectDocumentFields", "collectSectionsFromDom", "flushDraftFromDom",
    "getReportMetadata", "saveReportSnapshot", "reportIssueLabel", "getAllHistoryReports", "setHistoryLoading", "openHistory", "closeHistory", "flushVisibleHistoryComments", "renderHistoryList", "createSmallButton", "escapeHtml"]) {
    vm.runInContext(functionSource("app.js", name), ctx);
  }
  return ctx;
}

function historyLabel(ctx) {
  return ctx.elements.historyList.children[0]?.children[0]?.innerHTML.match(/<h3>(.*?)<\/h3>/)?.[1];
}

test("saving a non-Jira task from the editor preserves its URL and shows its key after reload", async () => {
  const records = new Map();
  const ctx = harness(records);
  const issueUrl = "https://tasks.example.test/project/Task/QA-123";
  ctx.elements.issueUrl.value = issueUrl;
  const saved = await ctx.saveReportSnapshot("autosave");
  assert.equal(saved.issueUrl, issueUrl);
  assert.equal(saved.document.issueUrl, issueUrl);
  assert.equal(saved.issueKey, "QA-123");
  assert.equal(saved.title, "QA-123 — STAGE");
  const reloaded = harness(records);
  await reloaded.renderHistoryList();
  assert.equal(historyLabel(reloaded), "QA-123");
});

test("previously saved local and cloud entries recover their label without resaving", async () => {
  for (const cloud of [false, true]) {
    const record = { id: "old", publicId: "abc12345", title: "Без задачи — STAGE", issueKey: "",
      issueUrl: "https://tasks.example.test/project/Task/QA-123", updatedAt: "2026-09-11T12:00:00Z" };
    const records = new Map([[record.id, record]]);
    const before = JSON.stringify(record);
    const ctx = harness(cloud ? new Map() : records);
    if (cloud) ctx.getServerReports = async () => [{ ...record, source: "server" }];
    ctx.elements.historySearch.value = "qa-123";
    await ctx.renderHistoryList();
    assert.equal(historyLabel(ctx), "QA-123");
    assert.equal(JSON.stringify(records.get(record.id)), before);
  }
});

test("history uses the document's task when summary metadata is stale, including search and clearing", async () => {
  const record = { id: "old", publicId: "abc12345", title: "Без задачи — STAGE", issueKey: "",
    issueUrl: "", document: { issueUrl: "https://tasks.example.test/project/Task/QA-123" }, updatedAt: "2026-09-11T12:00:00Z" };
  const ctx = harness(new Map([[record.id, record]]));
  ctx.elements.historySearch.value = "qa-123";
  await ctx.renderHistoryList();
  assert.equal(historyLabel(ctx), "QA-123");
  record.issueUrl = record.document.issueUrl;
  record.issueKey = "QA-123";
  record.document.issueUrl = "";
  ctx.elements.historySearch.value = "";
  await ctx.renderHistoryList();
  assert.equal(historyLabel(ctx), "Без задачи");
});

test("links without a recognizable task key remain visible and are escaped as text", async () => {
  const ctx = harness();
  ctx.elements.issueUrl.value = "https://tasks.example.test/task/123?title=<img>&view=all";
  const record = await ctx.saveReportSnapshot("autosave");
  assert.doesNotMatch(record.title, /Без задачи/);
  await ctx.renderHistoryList();
  assert.equal(historyLabel(ctx), "https://tasks.example.test/task/123?title=&lt;img&gt;&amp;view=all");
  ctx.elements.issueUrl.value = "";
  await ctx.saveReportSnapshot("autosave");
  await ctx.renderHistoryList();
  assert.equal(historyLabel(ctx), "Без задачи");
});


test("legacy history entries with only an issue key retain their label", async () => {
  const record = { id: "old", publicId: "abc12345", issueUrl: "", issueKey: "QA-123", updatedAt: "2026-09-11T12:00:00Z" };
  const ctx = harness(new Map([[record.id, record]]));
  await ctx.renderHistoryList();
  assert.equal(historyLabel(ctx), "QA-123");
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function historyRecord(key) {
  return { id: key, publicId: "abc12345", issueKey: key, title: key, source: "local", updatedAt: "2026-10-06T12:00:00Z" };
}

test("opening history shows loading before saving and applies search typed during the wait", async () => {
  const ctx = harness();
  const saving = deferred(), loading = deferred();
  let saveCalls = 0, loadCalls = 0;
  ctx.saveReportSnapshot = () => { saveCalls++; return saving.promise; };
  ctx.getAllHistoryReports = () => { loadCalls++; return loading.promise; };
  const opened = ctx.openHistory();
  assert.equal(ctx.elements.historyModal.hidden, false);
  assert.equal(saveCalls, 0);
  assert.match(ctx.elements.historyList.innerHTML, /Загружаем историю…/);
  assert.equal((ctx.elements.historyList.innerHTML.match(/class="history-item history-skeleton"/g) || []).length, 3);
  assert.equal(ctx.elements.historyList.attributes["aria-busy"], "true");
  assert.equal(ctx.elements.clearHistoryButton.disabled, true);
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.equal(saveCalls, 1);
  assert.equal(loadCalls, 0);
  saving.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadCalls, 1);
  ctx.elements.historySearch.value = "qa-2";
  loading.resolve([historyRecord("QA-1"), historyRecord("QA-2")]);
  await opened;
  assert.equal(historyLabel(ctx), "QA-2");
  assert.equal(ctx.elements.historyList.children.length, 1);
  assert.equal(ctx.elements.historyList.attributes["aria-busy"], "false");
  assert.equal(ctx.elements.clearHistoryButton.disabled, false);
  assert.equal(ctx.elements.saveHistorySnapshotButton.disabled, false);
});

test("a closed history request cannot overwrite a newly opened list", async () => {
  const ctx = harness();
  const old = deferred(), current = deferred();
  ctx.elements.historyModal.hidden = false;
  ctx.getAllHistoryReports = () => old.promise;
  const first = ctx.renderHistoryList({ showLoading: true });
  ctx.closeHistory();
  ctx.elements.historyModal.hidden = false;
  ctx.getAllHistoryReports = () => current.promise;
  const second = ctx.renderHistoryList({ showLoading: true });
  old.resolve([historyRecord("QA-OLD")]);
  await first;
  assert.equal(ctx.elements.historyList.attributes["aria-busy"], "true");
  assert.match(ctx.elements.historyList.innerHTML, /Загружаем историю…/);
  current.resolve([historyRecord("QA-NEW")]);
  await second;
  assert.equal(historyLabel(ctx), "QA-NEW");
});

test("empty and failed loads leave loading and restore the history controls", async () => {
  const ctx = harness();
  await ctx.renderHistoryList({ showLoading: true });
  assert.match(ctx.elements.historyList.innerHTML, /Отчётов пока нет/);
  assert.equal(ctx.historyLoading, false);
  ctx.getAllHistoryReports = async () => { throw Error("unavailable"); };
  await ctx.renderHistoryList({ showLoading: true });
  assert.match(ctx.elements.historyList.innerHTML, /Не удалось загрузить историю/);
  assert.match(ctx.elements.historyList.innerHTML, /data-retry-history/);
  assert.equal(ctx.historyLoading, false);
  assert.equal(ctx.elements.saveHistorySnapshotButton.disabled, false);
});
