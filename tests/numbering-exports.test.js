const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ChecklistNumbering = require('../checklist-numbering');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
// Run the production exporters on plain-text cells without a browser or network.
const functions = ['sectionsForPublication', 'generateMarkup', 'hasRowContent', 'xlsxEscape', 'columnName',
  'createSharedStringStore', 'xlsxCell', 'xlsxRow', 'estimateXlsxRowHeight',
  'getXlsxStatusStyle', 'buildXlsxWorksheet'];
const exporterCode = functions.map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `Production function ${name} exists`);
  return match[0];
}).join('\n');

for (const mode of ['section', 'continuous', 'hierarchical']) {
  test(`${mode}: Jira markup and Excel keep document numbers around omitted rows and sections`, () => {
    const row = (id, text = '') => ({ id, status: 'НЕ ПРОВЕРЕНО', cells: { text } });
    const draft = { numberingMode: mode, environment: 'STAGE', overallStatus: 'OK', intro: '', sections: [
      { id: 'a', title: 'First', columns: [{ id: 'text', title: 'Check' }], rows: [row('a1', 'A'), row('a2')] },
      { id: 'b', title: 'Second', columns: [{ id: 'text', title: 'Check' }], rows: [row('b1'), row('b2', 'B')] },
      { id: 'c', title: 'Empty', columns: [{ id: 'text', title: 'Check' }], rows: [row('c1')] },
      { id: 'd', title: 'Fourth', columns: [{ id: 'text', title: 'Check' }], rows: [row('d1', 'D')] },
    ] };
    const context = vm.createContext({ draft, ChecklistNumbering, Set,
      collectDocumentFields() {}, htmlToText: text => text, htmlToWiki: text => text,
      jiraCell: text => text, htmlToSpreadsheetText: text => text,
      htmlToAdfBlocks: text => [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      STATUS_META: { OK: { jiraColor: '#008000' }, 'НЕ ПРОВЕРЕНО': { jiraColor: '#800080' } },
      XLSX_STATUS_STYLES: { OK: 5, 'НЕ ПРОВЕРЕНО': 8 },
    });
    vm.runInContext(exporterCode, context);
    // Status and section filters intersect without changing source rows or numbers.
    draft.sections[1].rows[1].status = 'OK';
    const filteredOptions = { statuses: ['OK'], sectionIds: ['a', 'b', 'c'] };
    const filtered = context.generateMarkup(filteredOptions);
    assert.match(filtered, /h2. 2\. Second/);
    assert.doesNotMatch(filtered, /h2. 1\. First|h2. 3\. Empty|h2. 4\. Fourth/);
    assert.equal(context.sectionsForPublication(null, draft, []).length, 0);
    assert.equal(context.sectionsForPublication(['a'], draft, ['OK']).length, 0);
    assert.equal(draft.sections[1].rows.length, 2);
    draft.sections[1].rows[1].status = 'НЕ ПРОВЕРЕНО';
    const expected = {
      section: ['1.', '2.', '1.'], continuous: ['1.', '4.', '6.'], hierarchical: ['1.1', '2.2', '4.1'],
    }[mode];
    for (const sectionIds of [null, ['b', 'd']]) {
      const wanted = sectionIds ? expected.slice(1) : expected;
      const markup = context.generateMarkup({ sectionIds });
      assert.deepEqual([...markup.matchAll(/^\|([^|]+)\|/gm)].map(match => match[1]), wanted);
      assert.match(markup, /h2. 2\. Second/);
      assert.match(markup, /h2. 4\. Fourth/);

    }
    const { sheetXml, sharedStringsXml } = context.buildXlsxWorksheet();
    const strings = [...sharedStringsXml.matchAll(/<t[^>]*>(.*?)<\/t>/g)].map(match => match[1]);
    assert.ok(strings.includes('2. Second'));
    assert.ok(strings.includes('4. Fourth'));
    const excelNumbers = [...sheetXml.matchAll(/<c r="A\d+" t="s" s="11"><v>(\d+)<\/v><\/c>/g)]
      .map(match => strings[Number(match[1])]);
    assert.deepEqual(excelNumbers, expected);
  });
}
