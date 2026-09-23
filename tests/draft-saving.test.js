const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ quota = true } = {}) {
  const writes = [], statuses = [], broadcasts = [], stored = [];
  const ctx = vm.createContext({
    draft: { reportId: "report", revision: 1, intro: "Imported with attachments" },
    clone: structuredClone, normalizeDraft: structuredClone,
    hasUnsavedLocalChanges: true, applyingRemoteDraft: false, forceLocalDraftSave: false,
    cloudHistoryEnabled: false, saveTimer: 0, tabId: "tab", reportClientId: "client",
    clearTimeout() {}, flushDraftFromDom() {}, readStoredDraft: () => null, getFreshestStoredDraft: async () => null,
    localStorage: { setItem(key, value) { if (quota) throw new Error("QuotaExceededError"); stored.push(JSON.parse(value)); } },
    STORAGE_KEY: "draft", setSaveStatus: value => statuses.push(value),
    saveReportSnapshot: (reason, candidate) => { const d = deferred(); writes.push({ ...d, candidate: structuredClone(candidate) }); return d.promise; },
    broadcastDraftUpdate: () => broadcasts.push(structuredClone(ctx.draft)),
    serializeDraft: () => JSON.stringify(ctx.draft),
  });
  const source = fs.readFileSync(require.resolve("../app.js"), "utf8");
  for (const name of ["saveDraft", "persistLocalDraft", "flushPendingDraftSave"]) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), ctx);
  }
  return { ctx, writes, statuses, broadcasts, stored };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const method of ["saveDraft", "flushPendingDraftSave"]) {
  test(`${method}: localStorage quota waits for IndexedDB and reports a successful save`, async () => {
    const h = harness();
    const result = h.ctx[method]();
    await settle();
    assert.equal(h.statuses.at(-1), "Сохранение…");
    assert.equal(h.ctx.hasUnsavedLocalChanges, true);
    assert.equal(h.broadcasts.length, 0);
    h.writes[0].resolve();
    await settle();
    assert.equal(h.statuses.at(-1), "Сохранено");
    assert.equal(h.ctx.hasUnsavedLocalChanges, false);
    assert.equal(h.broadcasts.length, 1);
    if (method === "saveDraft") assert.equal(await result, true);
  });
  test(`${method}: failing both stores preserves dirty state and reports an error`, async () => {
    const h = harness();
    const result = h.ctx[method]();
    await settle();
    h.writes[0].reject(new Error("IndexedDB unavailable"));
    await settle();
    assert.equal(h.statuses.at(-1), "Ошибка сохранения");
    assert.equal(h.ctx.hasUnsavedLocalChanges, true);
    assert.equal(h.broadcasts.length, 0);
    if (method === "saveDraft") assert.equal(await result, false);
  });
}

test("IndexedDB failure does not report data loss when localStorage saved successfully", async () => {
  const h = harness({ quota: false });
  const result = h.ctx.saveDraft();
  await settle();
  h.writes[0].reject(new Error("IDB disabled"));
  assert.equal(await result, true);
  assert.equal(h.statuses.at(-1), "Сохранено");
  assert.equal(h.stored.length, 1);
});

for (const change of ["edit", "import", "switch"]) test(`late save completion cannot overwrite ${change} status`, async () => {
  for (const failure of [true, false]) {
    const h = harness();
    h.ctx.flushPendingDraftSave();
    if (change === "edit") h.ctx.draft.intro = "New typing";
    if (change === "import") h.ctx.draft = { ...h.ctx.draft, revision: h.ctx.draft.revision + 1, intro: "New AI batch" };
    if (change === "switch") h.ctx.draft = { ...h.ctx.draft, reportId: "another" };
    h.ctx.setSaveStatus("New operation");
    if (failure) h.writes[0].reject(new Error("old failure")); else h.writes[0].resolve();
    await settle();
    assert.equal(h.statuses.at(-1), "New operation");
    assert.equal(h.writes[0].candidate.intro, "Imported with attachments");
    assert.equal(h.broadcasts.length, 0);
  }
});

test("an older failure cannot replace a newer successful save", async () => {
  const h = harness();
  h.ctx.flushPendingDraftSave();
  h.ctx.flushPendingDraftSave();
  h.writes[1].resolve();
  await settle();
  h.writes[0].reject(new Error("old failure"));
  await settle();
  assert.equal(h.statuses.at(-1), "Сохранено");
  assert.equal(h.ctx.hasUnsavedLocalChanges, false);
});
