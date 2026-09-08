const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJiraMarkup } = require("../jira-markup-import");

function onlyRow(markup, attachments = []) {
  const imported = parseJiraMarkup(markup, attachments);
  assert.equal(imported.sections.length, 1);
  assert.equal(imported.sections[0].rows.length, 1);
  return {
    section: imported.sections[0],
    row: imported.sections[0].rows[0],
  };
}

test("Jira image options do not split an imported table row", () => {
  const { section, row } = onlyRow(
    [
      "h2. Регистрация",
      "||№||Проверка||Ожидаемый результат||Фактический результат||Комментарий||Статус||",
      "|18|Проверить форму|Открывается окно|!screenshot-15.png|thumbnail!|Окно закрывается корректно|*НЕ ОК*|",
    ].join("\n"),
    [
      {
        id: "70015",
        filename: "screenshot-15.png",
        content: "https://jira.example.com/secure/attachment/70015/screenshot-15.png",
        thumbnail: "https://jira.example.com/secure/thumbnail/70015/screenshot-15.png",
      },
    ],
  );

  assert.equal(section.columns.length, 4);
  assert.equal(row.status, "НЕ ОК");
  assert.match(row.cells[section.columns[2].id], /class="cell-image"/);
  assert.match(row.cells[section.columns[2].id], /data-jira-name="screenshot-15\.png"/);
  assert.match(row.cells[section.columns[2].id], /data-jira-options/);
  assert.equal(row.cells[section.columns[3].id], "Окно закрывается корректно");
});

test("an unavailable Jira image remains in its source cell as a round-trip placeholder", () => {
  const { section, row } = onlyRow(
    [
      "||№||Проверка||Факт||Комментарий||Статус||",
      "|1|Проверить форму|Макет: !missing image.png|thumbnail,width=320!|Без замечаний|OK|",
    ].join("\n"),
  );

  assert.equal(row.status, "OK");
  assert.match(row.cells[section.columns[1].id], /class="jira-image-placeholder"/);
  assert.match(row.cells[section.columns[1].id], /data-jira-name="missing image\.png"/);
  assert.match(row.cells[section.columns[1].id], /data-jira-options="thumbnail,width=320"/);
  assert.doesNotMatch(row.cells[section.columns[1].id], /\[Изображение:/);
  assert.match(row.cells[section.columns[1].id], />missing image\.png<\/span>/);
  assert.equal(row.cells[section.columns[2].id], "Без замечаний");
});

test("Jira rich text formatting is preserved in imported cells", () => {
  const { section, row } = onlyRow(
    [
      "||№||Проверка||Результат||Статус||",
      "|1|*Жирный*, _курсив_, +подчёркнутый+ и -зачёркнутый-|{{код}}, ^верхний^, ~нижний~, {color:#de350b}красный{color} и [ссылка|https://example.com/docs]|OK|",
    ].join("\n"),
  );

  const check = row.cells[section.columns[0].id];
  const result = row.cells[section.columns[1].id];
  assert.match(check, /<strong>Жирный<\/strong>/);
  assert.match(check, /<em>курсив<\/em>/);
  assert.match(check, /<u>подчёркнутый<\/u>/);
  assert.match(check, /<s>зачёркнутый<\/s>/);
  assert.match(result, /<code>код<\/code>/);
  assert.match(result, /<sup>верхний<\/sup>/);
  assert.match(result, /<sub>нижний<\/sub>/);
  assert.match(result, /<span style="color:#de350b">красный<\/span>/);
  assert.match(result, /<a href="https:\/\/example\.com\/docs"/);
});

test("code and noformat macros containing table delimiters stay in their source cell", () => {
  const { section, row } = onlyRow(
    [
      "||№||Код||Комментарий||Статус||",
      "|1|{code:javascript}const first = a | b;{code} и {code}const second = c | d;{code}|{noformat}alpha | beta{noformat}|OK|",
    ].join("\n"),
  );

  assert.equal(section.columns.length, 2);
  assert.equal(row.status, "OK");
  assert.equal((row.cells[section.columns[0].id].match(/class="cell-code-block"/g) || []).length, 2);
  assert.match(row.cells[section.columns[0].id], /a \| b/);
  assert.match(row.cells[section.columns[0].id], /c \| d/);
  assert.match(row.cells[section.columns[1].id], /alpha \| beta/);
});

test("repeated code markers preserve all text as consecutive Jira code blocks", () => {
  const { section, row } = onlyRow(
    [
      "||Код||Статус||",
      "|{code}внешний {code}внутренний{code} ещё внешний{code}|OK|",
    ].join("\n"),
  );

  assert.equal(
    row.cells[section.columns[0].id],
    '<pre class="cell-code-block" data-language="text"><code>внешний</code></pre>'
      + 'внутренний'
      + '<pre class="cell-code-block" data-language="text"><code>ещё внешний</code></pre>',
  );
});

test("escaped Jira markers remain literal and an escaped pipe does not split the row", () => {
  const { section, row } = onlyRow(
    [
      "||№||Текст||Комментарий||Статус||",
      "|1|текст с \\| трубкой и \\! знаком|\\[не ссылка\\] и \\-не зачёркнуто\\-|OK|",
    ].join("\n"),
  );

  assert.equal(section.columns.length, 2);
  assert.equal(row.cells[section.columns[0].id], "текст с | трубкой и ! знаком");
  assert.equal(row.cells[section.columns[1].id], "[не ссылка] и -не зачёркнуто-");
});

test("empty and whitespace-only cells do not shift adjacent values", () => {
  const { section, row } = onlyRow(
    [
      "||№||Пусто||Пробелы||Комментарий||Статус||",
      "|1||   |после пустых ячеек|OK|",
    ].join("\n"),
  );

  assert.equal(row.cells[section.columns[0].id], "");
  assert.equal(row.cells[section.columns[1].id], "   ");
  assert.equal(row.cells[section.columns[2].id], "после пустых ячеек");
});

test("long table cells are imported without truncation", () => {
  const longText = "длинный текст ".repeat(5_000);
  const { section, row } = onlyRow(
    ["||№||Текст||Статус||", `|1|${longText}|OK|`].join("\n"),
  );

  assert.equal(row.cells[section.columns[0].id], longText);
});

test("strikethrough markers require non-whitespace content at both boundaries", () => {
  const { section, row } = onlyRow(
    [
      "||№||Текст||Статус||",
      "|1|- -зачёркнутый-, но - это дефисы -|OK|",
    ].join("\n"),
  );

  assert.equal(
    row.cells[section.columns[0].id],
    "- <s>зачёркнутый</s>, но - это дефисы -",
  );
});

test("color formatting inside links is rendered once and keeps HTML escaped", () => {
  const { section, row } = onlyRow(
    [
      "||№||Текст||Статус||",
      "|1|[проверить {color:red}критичный <script>alert(1)</script>{color}|https://example.com/docs]|OK|",
    ].join("\n"),
  );

  const html = row.cells[section.columns[0].id];
  assert.match(html, /<a href="https:\/\/example\.com\/docs"/);
  assert.match(html, /<span style="color:red">критичный &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /&lt;span/);
});

test("unsafe link protocols and color attribute payloads do not create active HTML", () => {
  const { section, row } = onlyRow(
    [
      "||№||Ссылка||Цвет||Статус||",
      "|1|[кликни|javascript:alert(1)]|{color:red\" onmouseover=\"alert(1)}опасно{color}|OK|",
    ].join("\n"),
  );

  const link = row.cells[section.columns[0].id];
  const color = row.cells[section.columns[1].id];
  assert.equal(link, "кликни");
  assert.doesNotMatch(link, /href=|javascript:/i);
  assert.doesNotMatch(color, /<span/i);
  assert.match(color, /red&quot; onmouseover=&quot;alert\(1\)/);
});

test("attachment names containing HTML are escaped in placeholders", () => {
  const { section, row } = onlyRow(
    [
      "||№||Изображение||Статус||",
      "|1|!<img src=x onerror=alert(1)>!|OK|",
    ].join("\n"),
  );

  const html = row.cells[section.columns[0].id];
  assert.match(html, /class="jira-image-placeholder"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img\s/i);
});

test("nested and escaped brackets stay inside a Jira link and its table cell", () => {
  const { section, row } = onlyRow(
    [
      "||№||Вложенная ссылка||Экранированная ссылка||Комментарий||Статус||",
      "|1|[outer [inner] text|https://example.com]|[RFC \\] *важный*|https://example.com/a\\]b]|после|OK|",
    ].join("\n"),
  );

  assert.equal(section.columns.length, 3);
  assert.match(row.cells[section.columns[0].id], />outer \[inner\] text<\/a>/);
  assert.match(row.cells[section.columns[1].id], /href="https:\/\/example\.com\/a\]b"/);
  assert.match(row.cells[section.columns[1].id], />RFC \] <strong>важный<\/strong><\/a>/);
  assert.equal(row.cells[section.columns[2].id], "после");
  assert.doesNotMatch(row.cells[section.columns[1].id], /@@JIRATOKEN/);
});

test("comparison operators and Jira line breaks remain inside strikethrough text", () => {
  const { section, row } = onlyRow(
    [
      "||№||Текст||Статус||",
      "|1|-проверка > 5 значений- и -строка\\\\продолжение-|OK|",
    ].join("\n"),
  );

  assert.equal(
    row.cells[section.columns[0].id],
    "<s>проверка &gt; 5 значений</s> и <s>строка<br>продолжение</s>",
  );
});


test("section ordinals are removed without deleting meaningful numeric titles", () => {
  for (const [title, expected] of [
    ["1. Авторизация", "Авторизация"], ["12) Оплата", "Оплата"],
    ["2FA", "2FA"], ["2026 год", "2026 год"], ["1.5 версия", "1.5 версия"],
    ["Авторизация", "Авторизация"], ["2026. Итоги", "2026. Итоги"],
  ]) {
    const markup = `h2. ${title}\n||Проверка||Статус||\n|Вход|OK|`;
    const section = parseJiraMarkup(markup).sections[0];
    assert.equal(section.title, expected);
    const repeated = parseJiraMarkup(`h2. 1. ${section.title}\n||Проверка||Статус||\n|Вход|OK|`);
    assert.equal(repeated.sections[0].title, expected);
  }
});
