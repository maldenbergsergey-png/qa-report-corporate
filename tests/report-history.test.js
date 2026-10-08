const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const QaReportHistory = require("../history-content");

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

function harness(records = new Map(), preferences = new Map()) {
  const ctx = vm.createContext({
    QaReportHistory,
    HISTORY_PROJECT_COLORS_KEY: "qa-report-project-colors-v1",
    HISTORY_PROJECT_NAMES_KEY: "qa-report-project-names-v1",
    localStorage: { getItem: key => preferences.get(key) || null, setItem: (key, value) => preferences.set(key, value) },
    URL, localEditGeneration: 0, historyRenderRequestId: 0, historyLoading: false, historySelectionMode: false, historyDeleting: false,
    historyFilteredReports: [], selectedHistoryReportIds: new Set(), pendingHistoryServerSaves: new Map(), document: { createElement: element },
    draft: { reportId: "report", publicId: "abc12345", issueUrl: "", environment: "STAGE", sections: [] },
    elements: {
      issueUrl: element(), environment: { value: "STAGE" }, overallStatus: { value: "OK" },
      historyModal: { hidden: true }, closeHistoryButton: element(),
      historySelectionToggle: element(), historySelectionToolbar: element(), historySelectAll: element(),
      historySelectionCount: element(), historySelectionExit: element(), deleteSelectedHistoryButton: element(),
      introEditor: element(), sections: element(), historySearch: element(), historyProjectFilter: element(), historySort: element(), historyList: element(), historyUsage: element(),
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
    "historyTimestamp", "sortHistoryReports", "historyDatesMarkup", "updateLocalReportComment", "getReportMetadata", "saveReportSnapshot", "reportIssueLabel", "getAllHistoryReports", "updateHistorySelectionUi", "setHistoryLoading", "openHistory", "closeHistory", "flushVisibleHistoryComments", "reportProjectKey", "loadProjectNames", "normalizeProjectColor", "loadProjectColors", "historyProjectKeys", "renderHistoryProjectFilter", "renderHistoryList", "createSmallButton", "escapeHtml"]) {
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
  assert.equal(ctx.elements.historySelectionToggle.disabled, true);
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
  assert.equal(ctx.elements.historySelectionToggle.disabled, false);
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
});


test("projects deduplicate legacy, local and cloud keys while cleared document tasks stay unassigned", async () => {
  const ctx = harness();
  const records = [
    { issueKey: "SHOP-1" },
    { document: { issueUrl: "https://tasks.example.test/project/Task/shop-2" } },
    { issueUrl: "https://jira.example.test/browse/APP_2-35" },
    { issueKey: "SHOP-9", document: { issueUrl: "" } },
    { issueUrl: "https://tasks.example.test/task/123" },
  ];
  assert.equal(JSON.stringify(ctx.historyProjectKeys(records)), '["APP_2","SHOP"]');
  assert.equal(ctx.reportProjectKey(records[3]), "");
  assert.equal(ctx.reportProjectKey(records[4]), "");
});

test("project and text filters combine, custom names are searchable and displayed safely", async () => {
  const records = [historyRecord("SHOP-1"), historyRecord("SHOP-2"), historyRecord("APP-3"), historyRecord("")];
  const names = { SHOP: 'Магазин <img src=x onerror=alert(1)>', APP: "Application" };
  const ctx = harness(new Map(records.map(record => [record.id, record])),
    new Map([["qa-report-project-names-v1", JSON.stringify(names)]]));
  ctx.elements.historyProjectFilter.value = "SHOP";
  ctx.elements.historySearch.value = "магазин";
  await ctx.renderHistoryList();
  assert.equal(ctx.elements.historyList.children.length, 2);
  assert.match(ctx.elements.historyUsage.textContent, /Показано: 2 из 4/);
  assert.match(ctx.elements.historyList.children[0].children[0].innerHTML, /Магазин &lt;img/);
  assert.doesNotMatch(ctx.elements.historyProjectFilter.innerHTML, /<img/);
  ctx.elements.historySearch.value = "shop-2";
  await ctx.renderHistoryList();
  assert.equal(historyLabel(ctx), "SHOP-2");
  ctx.elements.historyProjectFilter.value = "APP";
  await ctx.renderHistoryList();
  assert.match(ctx.elements.historyList.innerHTML, /Ничего не найдено/);
  ctx.elements.historyProjectFilter.value = "none";
  ctx.elements.historySearch.value = "";
  await ctx.renderHistoryList();
  assert.equal(ctx.elements.historyList.children.length, 1);
  assert.equal(historyLabel(ctx), "Без задачи");
  ctx.elements.historyProjectFilter.value = "";
  await ctx.renderHistoryList();
  assert.equal(ctx.elements.historyList.children.length, 4);
});

test("removed projects reset the active filter and malformed saved names fall back to keys", async () => {
  const preferences = new Map([["qa-report-project-names-v1", "invalid-json"]]);
  const ctx = harness(new Map([["APP-3", historyRecord("APP-3")]]), preferences);
  ctx.elements.historyProjectFilter.value = "SHOP";
  await ctx.renderHistoryList();
  assert.equal(ctx.elements.historyProjectFilter.value, "");
  assert.equal(historyLabel(ctx), "APP-3");
  preferences.set("qa-report-project-names-v1", JSON.stringify({ APP: 5, SHOP: " ", "<img>": "bad", QA: " Проверки " }));
  assert.equal(JSON.stringify(ctx.loadProjectNames()), '{"QA":"Проверки"}');
});


test("project colors accept short and full HEX codes and reject CSS or markup injection", async () => {
  const ctx = harness();
  for (const [input, expected] of [["#F00", "#ff0000"], [" #E5484D ", "#e5484d"], ["235BBB", "#235bbb"], ["", ""]]) {
    assert.equal(ctx.normalizeProjectColor(input), expected);
  }
  for (const input of ["red", "#gggggg", "#ff000080", "#fff;display:none", '\" onmouseover=alert(1)', "rgb(255,0,0)"]) {
    assert.equal(ctx.normalizeProjectColor(input), "");
  }
  const names = new Map([["qa-report-project-names-v1", JSON.stringify({ SHOP: "Магазин" })],
    ["qa-report-project-colors-v1", JSON.stringify({ SHOP: "#F00", APP: "#fff;display:none" })]]);
  const colored = harness(new Map([["SHOP-1", historyRecord("SHOP-1")], ["APP-2", historyRecord("APP-2")]]), names);
  await colored.renderHistoryList();
  assert.equal(JSON.stringify(colored.loadProjectColors()), '{"SHOP":"#ff0000"}');
  assert.match(colored.elements.historyList.children.find(item => item.children[0].innerHTML.includes("<h3>SHOP-1</h3>")).children[0].innerHTML, /style="--project-color:#ff0000"/);
  assert.match(colored.elements.historyProjectFilter.innerHTML, />Магазин<\/option>/);
  assert.doesNotMatch(colored.elements.historyProjectFilter.innerHTML, /Магазин · SHOP/);
  assert.doesNotMatch(colored.elements.historyList.children.find(item => item.children[0].innerHTML.includes("<h3>APP-2</h3>")).children[0].innerHTML, /--project-color/);
});


test("bulk delete confirms the full selection, including hidden records, and keeps failed entries selected", async () => {
  const ctx = harness();
  vm.runInContext(functionSource("app.js", "deleteSelectedHistoryReports"), ctx);
  ctx.selectedHistoryReportIds.add("SHOP-1");
  ctx.selectedHistoryReportIds.add("APP-2");
  ctx.historyFilteredReports = [historyRecord("APP-2")];
  ctx.getAllHistoryReports = async () => [historyRecord("SHOP-1"), historyRecord("APP-2"), historyRecord("OTHER-3")];
  let confirmedText = "", deleted = [];
  ctx.askConfirmation = async text => { confirmedText = text; return true; };
  ctx.deleteHistoryReport = async report => {
    if (report.id === "APP-2") throw Error("temporary failure");
    deleted.push(report.id); ctx.selectedHistoryReportIds.delete(report.id);
  };
  ctx.renderHistoryList = async () => {};
  ctx.showToast = text => { ctx.lastToast = text; };
  await ctx.deleteSelectedHistoryReports();
  assert.deepEqual(deleted, ["SHOP-1"]);
  assert.match(confirmedText, /\(2\)/);
  assert.match(confirmedText, /скрытых текущим фильтром: 1/);
  assert.deepEqual([...ctx.selectedHistoryReportIds], ["APP-2"]);
  assert.match(ctx.lastToast, /Не удалось удалить: 1/);
  assert.equal(ctx.historyDeleting, false);
  ctx.askConfirmation = async () => false;
  deleted = [];
  await ctx.deleteSelectedHistoryReports();
  assert.deepEqual(deleted, []);
  assert.deepEqual([...ctx.selectedHistoryReportIds], ["APP-2"]);
});

test("deleting a cloud report waits for in-flight saves and also removes its local copy", async () => {
  const ctx = harness();
  vm.runInContext(functionSource("app.js", "deleteHistoryReport"), ctx);
  const saving = deferred();
  ctx.draftWriteQueue = Promise.resolve();
  ctx.pendingHistoryServerSaves.set("cloud", new Set([saving.promise]));
  ctx.selectedHistoryReportIds.add("cloud");
  const deleted = [];
  ctx.deleteServerReport = async id => deleted.push(`server:${id}`);
  ctx.deleteReportRecord = async id => deleted.push(`local:${id}`);
  const deletion = ctx.deleteHistoryReport({ id: "cloud", source: "server" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deleted, []);
  saving.resolve();
  await deletion;
  assert.deepEqual(deleted, ["server:cloud", "local:cloud"]);
  assert.equal(ctx.selectedHistoryReportIds.size, 0);
});


test("viewing and saving unchanged or legacy content preserves history dates; actual edits advance them", async () => {
  const createdAt = "2026-09-01T10:00:00.000Z", updatedAt = "2026-09-20T10:00:00.000Z";
  const document = { reportId: "report", publicId: "abc12345", issueUrl: "QA-1", environment: "STAGE",
    revision: 1, updatedAt, sections: [{ id: "section", title: "Checks", columns: [{ id: "text", title: "Text" }], rows: [{ id: "row", status: "OK", cells: { text: "Check" } }] }] };
  const records = new Map([["report", { id: "report", createdAt, updatedAt, historyComment: "Note", document }]]);
  const ctx = harness(records);
  const viewed = structuredClone(document);
  viewed.revision = 99;
  viewed.updatedAt = new Date().toISOString();
  viewed.lastSavedBy = "other-tab";
  viewed.sections[0].columns[0].width = 240;
  const saved = await ctx.saveReportSnapshot("open-history", viewed);
  assert.equal(saved.createdAt, createdAt);
  assert.equal(saved.updatedAt, updatedAt);
  assert.equal(saved.document.revision, 99, "sync metadata still persists");
  assert.equal(saved.historyComment, "Note");
  assert.equal((await ctx.saveReportSnapshot("autosave", viewed)).updatedAt, updatedAt);
  for (const edit of [value => { value.sections[0].rows[0].cells.text = "Edited"; },
    value => { value.sections[0].rows[0].status = "НЕ ОК"; },
    value => { value.sections[0].rows.push({ id: "new", status: "OK", cells: { text: "New" } }); }]) {
    const changed = structuredClone(viewed);
    edit(changed);
    records.get("report").updatedAt = updatedAt;
    const result = await ctx.saveReportSnapshot("autosave", changed);
    assert.ok(result.updatedAt > updatedAt);
    assert.equal(result.createdAt, createdAt);
    assert.equal((await ctx.saveReportSnapshot("open-history", changed)).updatedAt, result.updatedAt);
  }
  const prior = records.get("report").updatedAt;
  assert.equal((await ctx.updateLocalReportComment("report", "Note")).updatedAt, prior);
  records.get("report").updatedAt = updatedAt;
  const commented = await ctx.updateLocalReportComment("report", "Changed note");
  assert.ok(commented.updatedAt > updatedAt);
  assert.equal(commented.createdAt, createdAt);
  assert.equal((await ctx.saveReportSnapshot("open-history", commented.document)).updatedAt, commented.updatedAt);
});

test("history orders newest changes by default and creation on request, preserving selection and filters", async () => {
  const old = { ...historyRecord("SHOP-1"), createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-10-08T10:00:00Z" };
  const newer = { ...historyRecord("SHOP-2"), createdAt: "2026-10-07T10:00:00Z", updatedAt: "2026-10-07T10:00:00Z" };
  const other = { ...historyRecord("APP-3"), createdAt: "2026-10-08T10:00:00Z", updatedAt: "2026-10-08T11:00:00Z" };
  const ctx = harness(new Map([old, newer, other].map(report => [report.id, report])));
  const labels = () => ctx.elements.historyList.children.map(item => item.children[0].innerHTML.match(/<h3>(.*?)<\/h3>/)[1]);
  await ctx.renderHistoryList();
  assert.deepEqual(labels(), ["APP-3", "SHOP-1", "SHOP-2"]);
  const markup = ctx.elements.historyList.children[1].children[0].innerHTML;
  assert.match(markup, /Создан <time datetime="2026-09-01T10:00:00.000Z"/);
  assert.match(markup, /Изменён <time datetime="2026-10-08T10:00:00.000Z"/);
  ctx.selectedHistoryReportIds.add("SHOP-1");
  ctx.elements.historyProjectFilter.value = "SHOP";
  ctx.elements.historySort.value = "created";
  await ctx.renderHistoryList();
  assert.deepEqual(labels(), ["SHOP-2", "SHOP-1"]);
  assert.equal(ctx.selectedHistoryReportIds.has("SHOP-1"), true);
  assert.match(ctx.historyDatesMarkup({ createdAt: "invalid" }), /Создан —.*Изменён —/);
});

test("metadata worker detects legacy content off the UI thread without returning attachments", async () => {
  const document = { reportId: "legacy", revision: 5, issueUrl: "QA-1", sections: [{ cells: { file: "data:" + "AAAA".repeat(1000) } }] };
  const record = { id: "legacy", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-20T10:00:00Z", document };
  let handler;
  const metadata = await new Promise((resolve, reject) => {
    const ctx = vm.createContext({
      QaReportHistory, importScripts() {},
      self: { addEventListener: (_name, action) => { handler = action; }, postMessage: result => result.error ? reject(Error(result.error)) : resolve(result.metadata) },
      indexedDB: { open() {
        const request = {};
        queueMicrotask(() => { request.result = { close() {}, transaction() { return { objectStore() { return { get() {
          const read = {}; queueMicrotask(() => { read.result = record; read.onsuccess(); }); return read;
        } }; } }; } }; request.onsuccess(); });
        return request;
      } },
    });
    vm.runInContext(fs.readFileSync(require.resolve("../draft-storage-worker.js"), "utf8"), ctx);
    handler({ data: { requestId: 1, reportId: "legacy", databaseName: "test", databaseVersion: 1, storeName: "reports" } });
  });
  assert.equal(metadata.updatedAt, record.updatedAt);
  assert.equal(metadata.historyContentFingerprint, QaReportHistory.contentFingerprint(document));
  assert.equal(metadata.document.revision, 5);
  assert.equal(metadata.document.sections, undefined);
  assert.doesNotMatch(JSON.stringify(metadata), /data:/);
});

test("pending local edits retain their modification date while cloud metadata is still older", async () => {
  const local = { ...historyRecord("SHOP-1"), createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-10-08T10:00:00Z" };
  const ctx = harness(new Map([[local.id, local]]));
  ctx.getServerReports = async () => [{ ...local, createdAt: "2026-08-01T10:00:00Z", updatedAt: "2026-10-07T10:00:00Z", source: "server" }];
  const reports = await ctx.getAllHistoryReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "server");
  assert.equal(reports[0].createdAt, "2026-08-01T10:00:00Z");
  assert.equal(reports[0].updatedAt, local.updatedAt);
});
