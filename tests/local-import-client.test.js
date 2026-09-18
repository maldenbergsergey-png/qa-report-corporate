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
function receiver() {
  const timers = new Map(), storage = new Map(), elements = new Map();
  const snapshots = [], acknowledgements = [];
  let timerId = 0, saved = null, batch = null;
  const session = { id: "session", reportId: "report", consumerToken: "reader",
    expiresAt: Date.now() + 60_000, connection: { url: "https://example.test/import", token: "producer" } };
  function element(id) {
    if (!elements.has(id)) elements.set(id, { dataset: {}, handlers: {}, hidden: true,
      classList: { toggle() {} }, setAttribute() {}, focus() {},
      addEventListener(name, callback) { this.handlers[name] = callback; } });
    return elements.get(id);
  }
  const shell = { inert: false };
  const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array, clone,
    draft: { ...parseJiraMarkup(checklist("initial", "Исходные данные").content),
      draftId: "draft", reportId: "report", publicId: "public-id", revision: 7 },
    document: {
      getElementById: element,
      querySelector: selector => selector === ".app-shell" ? shell : null,
      createElement: () => ({ innerHTML: "", get content() {
        return { textContent: this.innerHTML.replace(/<[^>]*>/g, "") };
      } }),
    },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      if (url === "/api/local-import/sessions" && options.method === "POST") return { ok: true, json: async () => clone(session) };
      if (url.endsWith("/next")) return { ok: true, json: async () => ({ batch }) };
      if (url.endsWith("/ack")) {
        acknowledgements.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({}) };
      }
      if (options.binary) return { ok: true, blob: async () => ({ size: 1 }) };
      if (options.method === "DELETE") return { ok: true, json: async () => ({}) };
      throw new Error(`Unexpected request: ${url}`);
    },
    reportIdentityHeaders: () => ({}), checkBackendCompatibility: async () => {},
    getReportRecord: async () => saved,
    saveReportSnapshot: async (reason, candidate) => {
      if (candidate && ctx.saveError) throw ctx.saveError;
      saved = { document: clone(candidate || ctx.draft) };
      snapshots.push({ reason, document: saved.document });
    },
    applyDraftLocally: value => { ctx.draft = value; }, normalizeDraft: value => value,
    parseJiraMarkup, stripSectionNumber: value => value,
    QaReportAttachments: { localize: async document => {
      if (ctx.beforeLocalize) await ctx.beforeLocalize();
      return { document, errors: [] };
    } },
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
  return { ctx, shell, snapshots, acknowledgements, session,
    click: id => element(id).handlers.click(),
    async receive(value) {
      batch = value;
      const [id, callback] = timers.entries().next().value || [];
      assert.ok(callback, "an active reception must schedule polling");
      timers.delete(id);
      await callback();
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

for (const action of ["stop", "switch"]) test(`${action} during preparation prevents automatic replacement`, async () => {
  const r = receiver();
  await r.click("startLocalImport");
  r.ctx.beforeLocalize = () => {
    if (action === "stop") r.click("stopLocalImport");
    else r.ctx.draft.reportId = "another-report";
  };
  await r.receive(checklist("cancelled", "Не применять"));
  assert.equal(r.snapshots.length, 1);
  assert.doesNotMatch(JSON.stringify(r.ctx.draft), /Не применять/);
  assert.equal(r.acknowledgements[0].status, "rejected");
});
