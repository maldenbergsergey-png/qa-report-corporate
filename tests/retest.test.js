const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createReportSharing } = require("../report-sharing");
const Retest = require("../retest");

const key = () => randomBytes(32).toString("base64url");
test("one publication keeps each round, rejects stale edits and only accepts retest results from its signed-in creator", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const origin = "https://qa.example.test";
  const objects = new Map();
  const service = createReportSharing({ getDb: () => db, readJson: async req => req.body,
    sendJson: (res, status, data) => Object.assign(res, { status, data }), requestOrigin: () => origin,
    configPath: "fixture", publisherIdentity: req => ({ id: req.user }), storageLoader: () => ({ activeBucketId: "test", hasBucket: () => true,
      put: async (key, data) => objects.set(key, data), remove: async file => objects.delete(file.key),
      get: async file => { if (!objects.has(file.key)) throw new Error("missing"); return { body: null }; } }) });
  async function call(path, body, token, user, round = 1, method = body === undefined ? "GET" : "POST") {
    const url = "/api/shared-reports" + path;
    const req = { url, method, user, body,
      headers: { origin, authorization: "Bearer " + (token || ""), "x-qa-report-round": String(round), "content-type": "application/json" } };
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
    try { await service(req, res, url.split("?")[0]); return res; } catch (error) { return { status: error.status, error: error.message }; }
  }
  const owner = "publisher", outsider = "other";
  const rows = ["issue", "also", "untouched"].map(id => ({ id, number: id, status: id === "issue" ? "НЕ ОК" : "OK", cells: { check: { text: id } } }));
  const snapshot = { title: "Filters", sections: [{ id: "s", columns: [{ id: "check", label: "Проверка" }], rows }] };
  const input = { files: [], reportId: "abcd1234", snapshot };
  const p = (await call("", { ...input, publishKey: key() }, null, owner)).data.publication;
  const url = "/" + p.id;
  const post = (action, body, token = p.replyToken, user, round) => call(url + "/" + action, body, token, user, round);
  const read = (query = "", token = p.replyToken, user) => call(url + query, undefined, token, user).then(r => r.data.report);
  const answer = { sectionId: "s", rowId: "issue", status: "fixed", revision: 0, comment: "Dev note" };
  assert.equal((await post("answers", answer)).status, 200);
  const file = { sectionId: "s", rowId: "issue", id: "proof", type: "text/plain", name: "proof.txt", data: "eA==" };
  const uploaded = await post("answer-files", file, p.replyToken, outsider);
  assert.equal(uploaded.status, 200, uploaded.error);
  assert.equal((await post("close-corrections", {}, p.readToken, outsider)).status, 403);
  assert.equal((await post("close-corrections", {})).status, 200);
  const closed = await read("", p.readToken, owner);
  assert.equal(closed.workflow.author, true);
  assert.equal(closed.workflow.phase, "ready");
  assert.deepEqual(closed.workflow.required, [["s", "issue"]]);
  assert.equal(closed.canReply, false);
  assert.equal((await post("answers", { ...answer, revision: 1 })).status, 409);
  const result = { ...answer, status: "ПОЧТИ ОК", comment: "QA note" };
  assert.equal((await post("retest-result", result, p.ownerToken, outsider)).status, 403);
  assert.equal((await post("retest-result", result, p.readToken, owner)).status, 409);
  for (const actor of [undefined, outsider]) assert.equal((await post("start-retest", {}, p.ownerToken, actor)).status, 403);
  assert.equal((await post("start-retest", {}, p.readToken, owner)).status, 200);
  assert.equal((await read("", p.readToken, owner)).workflow.phase, "retest");
  assert.equal((await post("finish-retest", { revision: 0 }, p.readToken, owner)).status, 409);
  assert.equal((await post("retest-result", result, p.readToken, owner)).status, 200);
  assert.equal((await post("retest-result", result, p.readToken, owner)).status, 409);
  assert.equal((await post("retest-result", { ...result, rowId: "also", status: "НЕ ОК" }, p.readToken, owner)).status, 200);
  assert.equal((await post("finish-retest", { revision: 1 }, p.readToken, owner)).status, 409);
  assert.equal((await post("finish-retest", { revision: 2, outcome: "qualified" }, p.readToken, owner)).status, 409);
  assert.equal((await post("retest-result", { ...result, rowId: "also", status: "OK", revision: 1 }, p.readToken, owner)).status, 200);
  assert.equal((await post("finish-retest", { revision: 3, outcome: "passed" }, p.readToken, owner)).status, 409);
  assert.equal((await post("finish-retest", { revision: 3, outcome: "qualified" }, p.readToken, owner)).status, 200);
  assert.equal((await read()).workflow.outcome, "qualified");
  assert.equal((await post("retest-result", { ...result, revision: 1 }, p.readToken, owner)).status, 409);
  const next = { ...input, publishKey: key(), update: { id: p.id, ownerToken: p.ownerToken, nextRound: 2 } };
  const updated = await call("/prepare", next, null, owner);
  assert.equal(updated.status, 200, updated.error);
  assert.equal(updated.data.publication.id, p.id);
  const current = await read();
  assert.equal(current.workflow.round, 2);
  assert.equal(current.workflow.phase, "corrections");
  assert.equal(current.answers[0].comment, "");
  assert.equal(current.workflow.results.length, 0);
  assert.equal(current.answerFiles.length, 0);
  assert.equal((await call(url + "/answer-files/proof", undefined, p.replyToken, outsider, 2, "DELETE")).status, 200);
  assert.equal((await call(url + "/answer-files/proof?round=1", undefined, p.readToken, outsider)).status, 200);
  const history = await read("?round=1");
  assert.equal(history.canReply, false);
  assert.equal(history.workflow.archived, true);
  assert.equal(history.answers[0].comment, "Dev note");
  assert.equal(history.workflow.results.length, 2);
  assert.equal((await post("answers", { ...answer, revision: current.answers[0].revision })).status, 409);
  assert.equal((await post("answers", { ...answer, revision: current.answers[0].revision }, p.replyToken, outsider, 2)).status, 200);
  assert.equal((await post("close-corrections", {}, p.readToken, owner, 2)).status, 200);
  for (const actor of [undefined, outsider]) {
    assert.equal((await post("return-to-corrections", { revision: 0 }, p.ownerToken, actor, 2)).status, 403);
    assert.equal((await post("retest-result", result, p.replyToken, actor, 2)).status, 403);
    assert.equal((await post("finish-retest", { revision: 0 }, p.replyToken, actor, 2)).status, 403);
    assert.equal((await read("", p.replyToken, actor)).workflow.author, false);
  }
  assert.equal((await post("start-retest", {}, p.readToken, owner, 2)).status, 200);
  assert.equal((await post("retest-result", { ...result, rowId: "also", status: "OK" }, p.readToken, owner, 2)).status, 200);
  assert.equal((await post("return-to-corrections", { revision: 1 }, p.readToken, owner, 2)).status, 409);
  assert.equal((await post("retest-result", { ...result, status: "НЕ ОК" }, p.readToken, owner, 2)).status, 200);
  assert.equal((await post("return-to-corrections", { revision: 2 }, p.readToken, owner, 2)).status, 200);
  assert.equal((await post("return-to-corrections", { revision: 1 }, p.readToken, owner, 2)).status, 409);
  const returned = await read();
  assert.equal(returned.canReply, true);
  assert.equal(returned.workflow.round, 3);
  assert.deepEqual(returned.workflow.handoff.corrections, [["s", "issue"]]);
  assert.equal((await post("answers", { ...answer, rowId: "also" }, p.replyToken, outsider, 3)).status, 409);
  assert.equal(returned.workflow.handoff.points[0].comment, "QA note");
  assert.ok((await read("?round=2")).workflow.returnedAt);
  assert.equal((await post("close-corrections", {}, p.replyToken, outsider, 3)).status, 200);
  assert.deepEqual((await read()).workflow.required, [["s", "issue"]]);
  assert.equal((await post("start-retest", {}, p.readToken, owner, 3)).status, 200);
  assert.equal((await post("retest-result", { ...result, status: "OK" }, p.readToken, owner, 3)).status, 200);
  assert.equal((await post("finish-retest", { revision: 1 }, p.readToken, owner, 3)).status, 200);
  const final = await read();
  assert.deepEqual(Retest.effectiveResults(final.workflow, final.answers).map(point => point.rowId).sort(), ["also", "issue"]);
  assert.equal((await read("?round=1")).answers[0].revision, 1);
  assert.equal((await call(url, undefined, p.ownerToken, owner, 2, "DELETE")).status, 200);
  assert.equal((await call(url + "?round=1", undefined, p.readToken, outsider)).status, 404);
});

test("merge preserves earlier comments, skips changed points and distinguishes successive rounds of the same link", () => {
  const draft = { sections: [{ id: "s", columns: [{ id: "check", title: "Проверка" }, { id: "comment", title: "Комментарий" }],
    rows: [{ id: "r", status: "НЕ ОК", cells: { comment: "First" } }, { id: "changed", status: "OK", cells: {} }] },
    { id: "other", columns: [], rows: [] }] };
  const result = { sectionId: "s", rowId: "r", status: "OK", comment: "Retested", updatedAt: "date" };
  const report = { id: "a".repeat(32), sections: [{ id: "s", columns: [], rows: [{ id: "r", status: "НЕ ОК" }, { id: "changed", status: "НЕ ОК" }] }],
    answers: [{ sectionId: "s", rowId: "r", status: "fixed", comment: "Dev response", updatedAt: "date" }],
    workflow: { round: 1, finishedAt: "date", results: [result, { ...result, rowId: "changed", status: "ПОЧТИ ОК" }, { ...result, rowId: "absent" }] } };
  const plan = () => Retest.planMerge(draft, report, () => "");
  assert.equal(plan().skipped.length, 2);
  Retest.applyMerge(plan(), report, String, String);
  assert.equal(draft.sections[0].rows[0].status, "OK");
  assert.match(draft.sections[0].rows[0].cells.comment, /^First<br>.*Retested$/);
  assert.equal(plan().applied, 1);
  const plain = Retest.withoutServiceColumns(draft);
  assert.deepEqual(plain.sections[0].columns.map(column => column.id), ["check", "comment"]);
  assert.deepEqual(Object.keys(plain.sections[0].rows[0].cells), ["comment"]);
  assert.equal(draft.sections[0].columns.filter(Retest.serviceColumn).length, 3);
  assert.equal(plan().changes.length, 0);
  assert.equal(draft.sections[1].columns.length, 0);
  report.workflow.round++;
  assert.equal(plan().changes.length, 1);
});
