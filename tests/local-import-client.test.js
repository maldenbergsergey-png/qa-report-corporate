const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { parseJiraMarkup } = require("../jira-markup-import");

const clone = value => JSON.parse(JSON.stringify(value));
const checklist = (id, text) => ({ id, kind: "checklist", files: [],
  content: `||Проверка||Фактический результат||\n|Форма|${text}|` });

// Run the complete browser receiver, driving its buttons and polling timer.
function receiver(stored = []) {
  const timers = new Map(), storage = new Map([["qa-report-local-import-session-v1", JSON.stringify(stored)]]), elements = new Map();
  const records = new Map(), batches = new Map(), connections = [], deleted = [], clipboard = [];
  const snapshots = [], acknowledgements = [];
  let timerId = 0, now = Date.now();
  const session = { id: "session", reportId: "report", consumerToken: "reader",
    expiresAt: Date.now() + 60_000, connection: { url: "https://example.test/import", token: "producer" } };
  function element(id) {
    if (!elements.has(id)) elements.set(id, { dataset: {}, handlers: {}, hidden: true,
      classList: { toggle() {} }, setAttribute() {}, focus() {},
      querySelector: selector => element(selector),
      addEventListener(name, callback) { this.handlers[name] = callback; } });
    return elements.get(id);
  }
  const shell = { inert: false };
  const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array, clone,
    Date: class extends Date { static now() { return now; } },
    draft: { ...parseJiraMarkup(checklist("initial", "Исходные данные").content),
      draftId: "draft", reportId: "report", publicId: "public-id", revision: 7 },
    document: {
      getElementById: element,
      addEventListener() {},
      querySelector: selector => selector === ".app-shell" ? shell : null,
      querySelectorAll: () => [],
      createElement: () => ({ innerHTML: "", get content() {
        return { textContent: this.innerHTML.replace(/<[^>]*>/g, "") };
      } }),
    },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      if (url === "/api/local-import/sessions" && options.method === "POST") {
        const reportId = JSON.parse(options.body).reportId;
        const connection = { ...session, id: connections.length ? `session-${connections.length + 1}` : session.id, reportId, expiresAt: now + 5 * 3600_000 };
        connections.push(connection);
        return { ok: true, json: async () => clone(connection) };
      }
      const current = [...connections, ...(Array.isArray(stored) ? stored : [stored])].find(item => url.includes(`/${item.id}/`));
      if (url.endsWith("/next")) return { ok: true, json: async () => ({ batch: batches.get(current.reportId) }) };
      if (url.endsWith("/ack")) {
        acknowledgements.push({ ...JSON.parse(options.body), reportId: current.reportId });
        batches.delete(current.reportId);
        return { ok: true, json: async () => ({}) };
      }
      if (options.binary) return { ok: true, blob: async () => ({ size: 1 }) };
      if (options.method === "DELETE") { deleted.push(url); return { ok: true, json: async () => ({}) }; }
      throw new Error(`Unexpected request: ${url}`);
    },
    reportIdentityHeaders: () => ({}), checkBackendCompatibility: async () => {},
    reportIssueLabel: value => value.issueUrl || "Без задачи",
    getReportRecord: async id => records.has(id) ? clone(records.get(id)) : null,
    saveReportSnapshot: async (reason, candidate, options) => {
      if (candidate && ctx.saveError) throw ctx.saveError;
      options?.validate();
      const saved = { document: clone(candidate || ctx.draft) };
      records.set(saved.document.reportId, saved);
      snapshots.push({ reason, document: saved.document });
    },
    applyDraftLocally: value => { ctx.draft = value; }, normalizeDraft: value => value,
    parseJiraMarkup, stripSectionNumber: value => value,
    QaReportAttachments: { localize: async document => {
      if (ctx.beforeLocalize) await ctx.beforeLocalize();
      return { document, errors: [] };
    } },
    QaReportJiraImport: require("../jira-markup-import"),
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    flushDraftFromDom() {}, broadcastDraftUpdate() {}, showToast() {}, syncBodyModalOverflow() {},
    confirmImportReplacement: async () => { throw new Error("Unexpected replacement confirmation"); },
    saveTimer: 0, historyTimer: 0, tabId: "tab", reportClientId: "client",
    publishInProgress: false, pwaPendingOperations: 0,
  });
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  const start = app.indexOf("function importedDraftInCurrentReport(");
  assert.ok(start >= 0);
  vm.runInContext(app.slice(start, app.indexOf("\n}", start) + 2), ctx);
  vm.runInContext(fs.readFileSync(require.resolve("../local-import-client.js"), "utf8"), ctx);
  return { ctx, shell, snapshots, acknowledgements, session, records, connections, deleted, clipboard, storage, element,
    click: id => element(id).handlers.click(),
    async receive(value, reportId = "report") {
      batches.set(reportId, value);
      const [id, task] = [...timers].find(([, task]) => task.delay !== 1000) || [];
      const callback = task?.callback;
      assert.ok(callback, "an active reception must schedule polling");
      timers.delete(id);
      await callback();
    },
    async advance(ms) {
      now += ms;
      const [id, task] = [...timers].find(([, task]) => task.delay === 1000);
      timers.delete(id); await task.callback();
    },
  };
}

test("active AI reception saves successive full checklists without asking and deduplicates retries", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  assert.equal(r.snapshots[0].reason, "before-local-agent");
  assert.match(JSON.stringify(r.snapshots[0].document), /Исходные данные/);
  await r.receive(checklist("first", "Первая часть"));
  await r.receive(checklist("second", "Первая часть и дополнение"));
  await r.receive(checklist("second", "Первая часть и дополнение"));
  assert.deepEqual(r.acknowledgements.map(ack => ack.status), ["saved", "saved", "saved"]);
  assert.equal(r.snapshots.length, 3, "a retry must not save the same checklist twice");
  assert.match(JSON.stringify(r.ctx.draft), /Первая часть и дополнение/);
  assert.equal(r.ctx.draft.reportId, "report");
  assert.equal(r.ctx.draft.publicId, "public-id");
  assert.equal(r.ctx.draft.revision, 9);
  assert.equal(r.shell.inert, false);
  assert.equal(r.ctx.pwaPendingOperations, 0);
});

test("incomplete files leave the existing checklist intact and a corrected batch can be saved", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const original = JSON.stringify(r.ctx.draft);
  await r.receive({ ...checklist("incomplete", "Результат"), files: [{ id: "file", name: "log.txt", size: 10 }] });
  assert.equal(r.acknowledgements[0].status, "rejected");
  assert.match(r.acknowledgements[0].error, /получен не полностью/);
  assert.equal(JSON.stringify(r.ctx.draft), original);
  await r.receive(checklist("corrected", "Результат"));
  assert.equal(r.acknowledgements[1].status, "saved");
});

test("storage failure stays retryable and reports saved only after persistence succeeds", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const original = JSON.stringify(r.ctx.draft);
  r.ctx.saveError = new Error("Storage unavailable");
  await r.receive(checklist("retry", "Результат"));
  assert.equal(r.acknowledgements.length, 0);
  assert.equal(JSON.stringify(r.ctx.draft), original);
  assert.equal(r.shell.inert, false);
  r.ctx.saveError = null;
  await r.receive(checklist("retry", "Результат"));
  assert.equal(r.acknowledgements[0].status, "saved");
  assert.equal(r.snapshots.length, 2);
});

test("stop during preparation prevents automatic replacement", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  r.ctx.beforeLocalize = () => {
    r.click("stopLocalImport");
  };
  await r.receive(checklist("cancelled", "Не применять"));
  assert.equal(r.snapshots.length, 1);
  assert.doesNotMatch(JSON.stringify(r.ctx.draft), /Не применять/);
  assert.equal(r.acknowledgements.length, 0);
});

function metadataUpdates(ctx, fields) {
  return Promise.all(Object.entries(fields).map(async ([field, value]) => [field, {
    value, expectedHash: await ctx.QaLocalImport.cellHash(ctx.draft[field]),
  }])).then(Object.fromEntries);
}

test("metadata updates persist the task, environment, outcome and safe introduction without replacing rows", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const sections = JSON.stringify(r.ctx.draft.sections);
  const metadata = await metadataUpdates(r.ctx, { issueUrl: "https://tasks.example.test/browse/QA-123", environment: "https://stage.example.test", overallStatus: "НЕ ОК", intro: "Build 8\n<script>alert(1)</script>" });
  await r.receive({ id: "metadata", kind: "metadata", metadata, files: [] });
  assert.equal(r.acknowledgements[0].status, "saved");
  assert.equal(r.ctx.draft.issueUrl, metadata.issueUrl.value);
  assert.equal(r.ctx.draft.environment, metadata.environment.value);
  assert.equal(r.ctx.draft.overallStatus, "НЕ ОК");
  assert.equal(r.ctx.draft.intro, "<p>Build 8<br>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(JSON.stringify(r.ctx.draft.sections), sections);
  assert.equal(r.snapshots.at(-1).document.overallStatus, "НЕ ОК");
  assert.equal(r.acknowledgements[0].context.metadata.overallStatus.text, "НЕ ОК");
  assert.notEqual(r.acknowledgements[0].context.metadata.overallStatus.hash, metadata.overallStatus.expectedHash);
  await r.receive({ id: "metadata", kind: "metadata", metadata, files: [] });
  assert.equal(r.snapshots.length, 2, "retry is deduplicated");
});

for (const kind of ["metadata", "cells", "checklist"]) test(`${kind}: a metadata conflict rejects the whole batch and preserves a manual edit`, async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const metadata = await metadataUpdates(r.ctx, { overallStatus: "НЕ ОК", intro: "Agent intro" });
  r.ctx.draft.intro = "<p>User edited this</p>";
  const before = JSON.stringify(r.ctx.draft);
  const section = r.ctx.draft.sections[0], row = section.rows[0], columnId = section.columns[0].id;
  const updates = [{ sectionId: section.id, rowId: row.id, columnId, status: "НЕ ОК", expectedHash: await r.ctx.QaLocalImport.cellHash(row.cells[columnId], row.status) }];
  await r.receive({ ...checklist("conflict", "Replacement"), kind, metadata, updates });
  assert.equal(r.acknowledgements[0].status, "rejected");
  assert.match(r.acknowledgements[0].error, /intro.*изменилось/);
  assert.equal(JSON.stringify(r.ctx.draft), before);
  assert.equal(r.snapshots.length, 1);
});

test("checklist and metadata are saved atomically with explicit fields taking precedence", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const metadata = await metadataUpdates(r.ctx, { overallStatus: "НЕ ОК", intro: "Build 8" });
  await r.receive({ ...checklist("combined", "New result"), metadata });
  assert.equal(r.acknowledgements[0].status, "saved");
  assert.equal(r.ctx.draft.overallStatus, "НЕ ОК");
  assert.equal(r.ctx.draft.intro, "<p>Build 8</p>");
  assert.match(JSON.stringify(r.ctx.draft.sections), /New result/);
});

test("editing report fields postpones agent updates until the user leaves the field", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const metadata = await metadataUpdates(r.ctx, { environment: "PROD" });
  const batch = { id: "focused", kind: "metadata", metadata, files: [] };
  r.ctx.document.activeElement = { matches: () => true };
  await r.receive(batch);
  assert.equal(r.acknowledgements.length, 0);
  r.ctx.document.activeElement = null;
  await r.receive(batch);
  assert.equal(r.acknowledgements[0].status, "saved");
});

test("countdown remains separate from batch status and uses elapsed time even after a suspended tab", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  assert.equal(r.element("localImportRemaining").textContent, "05:00:00");
  await r.receive(checklist("first", "Получено"));
  assert.match(r.element("localImportStatus").textContent, /сохранены/);
  assert.equal(r.element("localImportCountdown").hidden, false);
  await r.advance(3 * 3600_000 + 90_000);
  assert.equal(r.element("localImportRemaining").textContent, "01:58:30");
  assert.match(r.element("localImportStatus").textContent, /сохранены/);
  await r.advance(2 * 3600_000);
  assert.equal(r.element("localImportCountdown").hidden, true);
  assert.equal(r.element("startLocalImport").disabled, false);
  assert.match(r.element("localImportStatus").textContent, /истёк/);
  assert.equal(r.deleted.length, 1);
});

test("switching during a download saves only the original report and acknowledges its context", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const another = { ...clone(r.ctx.draft), reportId: "another-report", publicId: "another-id" };
  r.ctx.beforeLocalize = () => { r.ctx.draft = clone(another); };
  await r.receive(checklist("background", "Фоновое обновление"));
  assert.equal(JSON.stringify(r.ctx.draft), JSON.stringify(another));
  assert.match(JSON.stringify(r.records.get("report")), /Фоновое обновление/);
  assert.equal(r.acknowledgements[0].status, "saved");
  assert.equal(r.acknowledgements[0].context.reportId, "report");
  assert.equal(r.acknowledgements[0].context.sections[0].rows[0].cells[Object.keys(r.acknowledgements[0].context.sections[0].rows[0].cells)[1]].text, "Фоновое обновление");
});

test("two reports receive independently and stopping the current connection leaves the other active", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  r.ctx.draft = { ...clone(r.ctx.draft), reportId: "second-report", publicId: "second-id" };
  await r.click("startLocalImport");
  assert.equal(r.connections.length, 2);
  assert.equal(r.element("localImportOtherReports").hidden, false);
  await r.receive(checklist("first", "Первый отчёт"), "report");
  await r.receive(checklist("second", "Второй отчёт"), "second-report");
  assert.match(JSON.stringify(r.ctx.draft), /Второй отчёт/);
  assert.doesNotMatch(JSON.stringify(r.ctx.draft), /Первый отчёт/);
  assert.match(JSON.stringify(r.records.get("report")), /Первый отчёт/);
  await r.click("stopLocalImport");
  assert.equal(r.deleted.length, 1);
  assert.match(r.deleted[0], /session-2$/);
  await r.receive(checklist("continued", "Первый продолжает"), "report");
  assert.match(JSON.stringify(r.records.get("report")), /Первый продолжает/);
  assert.equal(r.acknowledgements.at(-1).context.reportId, "report");
  assert.equal(JSON.parse(r.storage.get("qa-report-local-import-session-v1")).length, 1);
});

test("cell updates in a background report reject a stale hash without changing either report", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  const value = r.ctx.draft, section = value.sections[0], row = section.rows[0], columnId = section.columns[1].id;
  const expectedHash = await r.ctx.QaLocalImport.cellHash(row.cells[columnId], row.status);
  const saved = r.records.get("report");
  saved.document.sections[0].rows[0].cells[columnId] = "<p>Ручная правка</p>";
  r.ctx.draft = { ...clone(value), reportId: "other" };
  await r.receive({ id: "stale", kind: "cells", files: [], updates: [{ sectionId: section.id, rowId: row.id, columnId, expectedHash, text: "Устаревший ответ" }] });
  assert.equal(r.acknowledgements[0].status, "rejected");
  assert.match(JSON.stringify(r.records.get("report")), /Ручная правка/);
  assert.doesNotMatch(JSON.stringify(r.ctx.draft), /Устаревший ответ/);
});

test("reload restores all unexpired connections and migrates the previous single-report format", async () => {
  const first = receiver();
  await first.click("startLocalImport");
  first.ctx.draft = { ...clone(first.ctx.draft), reportId: "second", publicId: "second-id" };
  await first.click("startLocalImport");
  const stored = JSON.parse(first.storage.get("qa-report-local-import-session-v1"));
  for (const previous of [stored, stored[0]]) {
    const r = receiver(previous);
    for (const [id, record] of first.records) r.records.set(id, clone(record));
    await r.receive(checklist("resumed", "После перезагрузки"));
    assert.match(JSON.stringify(r.ctx.draft), /После перезагрузки/);
    assert.equal(r.acknowledgements[0].status, "saved");
    assert.equal(JSON.parse(r.storage.get("qa-report-local-import-session-v1")).length, Array.isArray(previous) ? 2 : 1);
  }
});

test("copied prompt names its report so an agent can distinguish several connections", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  await r.click("copyLocalImport");
  assert.match(r.clipboard[0], /"reportId": "report"/);
  assert.match(r.clipboard[0], /Не используй это подключение для других отчётов/);
});


test("switching reports while enabling never enables reception in the new report", async () => {
  const r = receiver();
  r.ctx.checkBackendCompatibility = async () => { r.ctx.draft.reportId = "unapproved-report"; };
  await r.click("startLocalImport");
  assert.equal(r.connections.length, 0);
  assert.match(r.element("localImportStatus").textContent, /Открыт другой отчёт/);
});


test("each report expires at its own deadline without extending or stopping another connection", async () => {
  const r = receiver();
  await r.click("startLocalImport");
  await r.advance(3600_000);
  r.ctx.draft = { ...clone(r.ctx.draft), reportId: "later-report", publicId: "later-id" };
  await r.click("startLocalImport");
  await r.advance(4 * 3600_000);
  assert.equal(r.element("localImportRemaining").textContent, "01:00:00");
  assert.equal(r.element("localImportCountdown").hidden, false);
  assert.equal(r.deleted.length, 1);
  const stored = JSON.parse(r.storage.get("qa-report-local-import-session-v1"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].reportId, "later-report");
});
