"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Import = require("../jira-comment-import");
const connection = { baseUrl: "https://jira.example.test/team", type: "data-center" };
const edit = `${connection.baseUrl}/secure/EditComment!default.jspa?id=14536&commentId=12882`;

test("Jira comment import resolves edit links to a canonical task without report provenance", async () => {
  const calls = [];
  const fetchJira = async (target, path) => {
    assert.equal(target, connection); calls.push(path);
    if (path.endsWith("?fields=key")) return { key: "QA-42" };
    if (path.endsWith("?fields=attachment")) return { fields: { attachment: [{ id: 7, filename: "screen.png" }] } };
    return { body: "||Проверка||\n|Импорт в другой отчёт|" };
  };
  const result = await Import.load(connection, edit, fetchJira);
  assert.equal(result.issueUrl, `${connection.baseUrl}/browse/QA-42`);
  assert.equal(result.commentId, "12882"); assert.equal(result.format, "wiki");
  assert.match(result.body, /другой отчёт/); assert.equal(result.attachments[0].id, "7");
  assert.deepEqual(calls, ["/rest/api/2/issue/14536?fields=key", "/rest/api/2/issue/QA-42/comment/12882", "/rest/api/2/issue/QA-42?fields=attachment"]);
  assert.equal(Import.reference(connection, edit).issueRef, "14536");
});

test("Jira browse links accept query and fragment comment references in Cloud and Data Center", async () => {
  for (const suffix of ["?focusedCommentId=12882", "?commentId=12882", "?selectedItem=comment-12882", "#comment-12882"]) {
    const calls = [];
    const result = await Import.load({ ...connection, type: "cloud" }, `${connection.baseUrl}/browse/qa-42${suffix}`, async (_, path) => {
      calls.push(path); return path.endsWith("?fields=attachment") ? { fields: {} } : { body: { type: "doc" } };
    });
    assert.equal(result.commentId, "12882"); assert.equal(result.format, "adf");
    assert.deepEqual(calls, ["/rest/api/3/issue/QA-42/comment/12882", "/rest/api/3/issue/QA-42?fields=attachment"]);
  }
});

test("foreign origins, context paths, credentials and malformed IDs fail before any Jira request", async () => {
  const badLinks = [edit.replace("jira.example.test", "foreign.example.test"), edit.replace("/team/", "/team-extra/"),
    edit.replace("/team/", "/other/"), edit.replace("https:", "http:"), edit.replace("https://", "https://user:secret@"),
    edit.replace("14536", "abc"), edit.replace("14536", ""), edit.replace("12882", "abc"),
    edit.replace("12882", "7%2Fother"), edit.replace("EditComment!default.jspa", "Unknown.jspa"),
    `${connection.baseUrl}/browse/QA-42`, `${connection.baseUrl}/browse/QA-42/extra?commentId=1`];
  for (const url of badLinks) {
    let called = false;
    await assert.rejects(Import.load(connection, url, async () => { called = true; }));
    assert.equal(called, false, url);
  }
});

test("inaccessible tasks and comments fail; missing attachment permissions still allow text", async () => {
  await assert.rejects(Import.load(connection, edit, async () => { throw new Error("HTTP 403"); }), /403/);
  await assert.rejects(Import.load(connection, edit, async () => ({ key: "invalid" })), /ключ задачи/);
  await assert.rejects(Import.load(connection, `${connection.baseUrl}/browse/QA-42?commentId=1`, async () => { throw new Error("HTTP 404"); }), /404/);
  const result = await Import.load(connection, edit, async (_, path) => {
    if (path.endsWith("?fields=key")) return { key: "QA-42" };
    if (path.endsWith("?fields=attachment")) throw new Error("HTTP 403");
    return { body: "text" };
  });
  assert.equal(result.body, "text"); assert.deepEqual(result.attachments, []);
});
