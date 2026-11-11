const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers/shared-report-server.cjs");

function data(reply) {
  assert.equal(reply.error, undefined);
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply.result));
  return JSON.parse(reply.result.content[0].text);
}

test("new answer statuses round-trip through both MCP adapters and API without changing QA results", async t => {
  const f = await fixture(t);
  const clients = [await f.connect(), await f.connect({}, "shared-report-mcp.cjs")];
  const statuses = { clarified: "Уточнено", no_changes_needed: "Изменения не требуются", deferred: "Отложено" };
  const capabilities = data(await clients[0].call("qa_report_capabilities"));
  assert.equal(capabilities.answerStatuses.not_fixed, "Не исправлено");
  assert.equal(capabilities.qaStatusEditable, false);
  for (const [status, label] of Object.entries(statuses)) assert.equal(capabilities.answerStatuses[status], label);
  let revision = 0;
  for (const client of clients) {
    const tools = (await client.request("tools/list", {})).result.tools;
    const allowed = tools.find(tool => tool.name === "qa_report_save_answer").inputSchema.properties.status.enum;
    for (const status of Object.keys(statuses)) {
      assert.ok(allowed.includes(status));
      const comment = "Пояснение: " + statuses[status];
      const answer = data(await client.call("qa_report_save_answer", { sectionId: "section", rowId: "row", revision, status, comment }));
      assert.equal(answer.status, status);
      assert.equal(answer.revision, ++revision);
      const report = (await f.read()).data.report;
      assert.equal(report.answers[0].status, status);
      assert.equal(report.answers[0].comment, comment);
      assert.equal(report.sections[0].rows[0].status, "NOT_OK");
      assert.equal(data(await client.call("qa_report_read")).answers[0].status, status);
    }
  }
  const rejected = await f.json("/" + f.publication.id + "/answers", { method: "POST", token: f.publication.replyToken,
    body: { sectionId: "section", rowId: "row", revision, status: "unsupported", comment: "" } });
  assert.equal(rejected.status, 400);
  assert.equal((await f.read()).data.report.answers[0].revision, revision);
});
