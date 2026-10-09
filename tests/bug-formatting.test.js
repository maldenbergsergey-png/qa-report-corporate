"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), Bugs = require("../bug-report");
test("bug toolbar wiki formatting becomes Jira Cloud marks and lists without executable links", () => {
  const document = Bugs.textDocument("*Выделение* _Курсив_ +Подчёркивание+ {{code}} [Jira|https://jira.example.test]\n* Первый\n* Второй\n# Шаг\nОбычный текст [опасная ссылка|javascript:alert(1)]");
  assert.deepEqual(document.content[0].content.filter(node => node.marks).map(node => node.marks[0].type), ["strong", "em", "underline", "code", "link"]);
  assert.equal(document.content[1].type, "bulletList"); assert.equal(document.content[1].content.length, 2);
  assert.equal(document.content[2].type, "orderedList"); assert.equal(document.content[3].content[0].marks, undefined);
  assert.deepEqual(Bugs.textDocument("Простой текст\n"), { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Простой текст" }] }, { type: "paragraph" }] });
});

test("visual combinations retain nested marks in Jira Cloud", () => {
  const doc = Bugs.textDocument("*+_Комбинация_+* [*Ссылка*|https://jira.example.test] {{_буквальный код_}}");
  assert.deepEqual(doc.content[0].content[0].marks.map(mark => mark.type), ["strong", "underline", "em"]);
  assert.deepEqual(doc.content[0].content[2].marks.map(mark => mark.type), ["link", "strong"]);
  assert.equal(doc.content[0].content.at(-1).text, "_буквальный код_");
});
