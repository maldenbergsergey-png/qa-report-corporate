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


test("code blocks and literal punctuation round-trip to Jira Cloud and safe HTML", () => {
  const value = "*Title*\n{code:javascript}\nconst value = { name: '<script>', tags: '*_+' };\nconsole.log(value);\n{code}\nLiteral \\*stars\\* and file\\_name\\_x\n# First\n# Second";
  const doc = Bugs.textDocument(value);
  const block = doc.content.find(node => node.type === "codeBlock");
  assert.equal(block.attrs.language, "javascript"); assert(!block.content[0].text.endsWith("\n")); assert.match(block.content[0].text, /\{ name: '<script>'/);
  assert.equal(doc.content[2].content.map(node => node.text).join(""), "Literal *stars* and file_name_x");
  const html = Bugs.textHtml(value);
  assert.match(html, /<strong>Title<\/strong>/); assert.match(html, /<pre><code>const value =/);
  assert.match(html, /&lt;script&gt;/); assert(!html.includes("<script>")); assert.match(html, /<ol><li>/);
  assert.equal(Bugs.toJiraValue({ kind: "textarea" }, value, false), value);
  assert.deepEqual(Bugs.toJiraValue({ kind: "textarea" }, value, true), doc);
});

test("HTML conversion preserves nested formatting and rejects executable links", () => {
  assert.equal(Bugs.textHtml("*+_Nested_+* {{<code>}} [Link|https://example.test]"), '<p><strong><u><em>Nested</em></u></strong> <code>&lt;code&gt;</code> <a href="https://example.test/">Link</a></p>');
  assert(!Bugs.textHtml("[x|javascript:alert(1)] <img src=x onerror=alert(1)>").includes("<img"));
});

test("checklist colors, strike, headings and Jira attachment references retain their meaning", () => {
  const value = 'h2. Заголовок\n{color:#0052cc}*Цвет*-старое-{color}\n[^messages_file.json] !original_image.png|thumbnail!\nВерсия 2026-10-09';
  const doc = Bugs.textDocument(value);
  assert.equal(doc.content[0].type, 'heading');
  assert.deepEqual(doc.content[1].content[0].marks, [{type:'textColor',attrs:{color:'#0052cc'}},{type:'strong'}]);
  assert.equal(doc.content[1].content[1].marks.at(-1).type, 'strike');
  assert.equal(doc.content[2].content.map(node => node.text).join(''), '[^messages_file.json] !original_image.png|thumbnail!');
  assert.ok(doc.content[2].content.every(node => !node.marks), 'Filenames never turn into italic text');
  assert.equal(doc.content[3].content[0].text, 'Версия 2026-10-09');
  assert.match(Bugs.textHtml(value), /<span style="color:#0052cc"><strong>Цвет<\/strong><\/span>/);
  assert.match(Bugs.textHtml(value), /<s>старое<\/s>/);
  assert(!Bugs.textHtml('{color:expression(alert(1))}текст{color}').includes('style='));
});
