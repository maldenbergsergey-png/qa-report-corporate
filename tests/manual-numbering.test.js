const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const numbering = require('../checklist-numbering');
const { parseJiraMarkup } = require('../jira-markup-import');
const selection = require('../checklist-selection');
const fixture = () => ({ numberingMode: 'continuous', sections: [
  { id: 'a', columns: [{id:'check',title:'Check'}], rows: [1,2,3,4,5].map(id => ({id:String(id),cells:{check:`Check ${id}`},status:'НЕ ОК'})) },
  { id: 'b', columns: [{id:'check',title:'Check'}], rows: [{id:'6',cells:{check:'Check 6'},status:'OK'}] },
] });
const labels = doc => [...numbering.rowNumbers(doc).values()];

test('manual mode freezes current labels through deletion, moves, sorting and JSON persistence', () => {
  const doc=fixture(); numbering.setMode(doc,'manual');
  const result=selection.deleteRows(doc.sections,new Set(['4']),()=>({id:'empty'}),()=>assert.fail());
  doc.sections=result.sections;
  assert.deepEqual(labels(doc),['1.','2.','3.','5.','6.']);
  selection.moveRows(doc.sections,new Set(['3','5']),'b',()=>assert.fail(),()=>({id:'empty'}));
  doc.sections.reverse(); doc.sections[0].rows.reverse();
  const restored=JSON.parse(JSON.stringify(doc));
  assert.equal(numbering.rowNumbers(restored).get('5'),'5.');
  assert.equal(numbering.rowNumbers(restored).get('3'),'3.');
  restored.sections[0].rows.push({id:'new'});
  assert.equal(numbering.rowNumbers(restored).get('new'),'');
  numbering.setMode(restored,'section');
  assert.deepEqual(labels(restored),['1.','2.','3.','4.','1.','2.']);
});

test('entering manual mode freezes hierarchical labels and edits never renumber other rows', () => {
  const doc=fixture(); numbering.setMode(doc,'hierarchical'); numbering.setMode(doc,'manual');
  doc.sections[0].rows[1].manualNumber='3.12';
  assert.deepEqual(labels(doc),['1.1','3.12','1.3','1.4','1.5','2.1']);
  assert.ok(numbering.columnWidth(doc)>=80);
});

const markup='h2. Retest\n||Номер||Проверка||Статус||\n|003.|First|НЕ ОК|\n|7.2|Second|OK|\n| |Third|OK|';
test('Jira import preserves source labels, gaps, leading zeroes and empty numbers on request', () => {
  const imported=parseJiraMarkup(markup);
  assert.equal(numbering.hasSourceNumbers(imported),true);
  numbering.configureImport(imported,true,'continuous');
  assert.equal(imported.numberingMode,'manual');
  assert.deepEqual(labels(imported),['003.','7.2','']);
  assert.equal(imported.sections[0].columns.length,1);
  for (const mode of ['section','continuous','hierarchical','manual']) {
    const reset=numbering.configureImport(parseJiraMarkup(markup),false,mode);
    assert.equal(reset.numberingMode,mode==='manual'?'section':mode);
    assert.equal(numbering.hasSourceNumbers(reset),false);
    assert.equal(labels(reset)[1],mode==='hierarchical'?'1.2':'2.');
  }
  const unnumbered=parseJiraMarkup('||Проверка||Статус||\n|First|OK|');
  numbering.configureImport(unnumbered,true,'manual');
  assert.deepEqual(labels(unnumbered),['']);
});

test('inbound import asks before keeping or recalculating source numbers; cancel leaves data untouched', async () => {
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
  const code=source.match(/^async function chooseImportedNumbering\([\s\S]*?^}/m)[0];
  for (const choice of [true,'alternative',false]) {
    const imported=parseJiraMarkup(markup), before=JSON.stringify(imported);
    let prompts=0;
    const ctx=vm.createContext({ChecklistNumbering:numbering,draft:{numberingMode:'continuous'},
      askConfirmation:async()=>{prompts++;return choice;}});
    vm.runInContext(code,ctx);
    assert.equal(await ctx.chooseImportedNumbering(imported),choice!==false);
    assert.equal(prompts,1);
    if (choice===false) assert.equal(JSON.stringify(imported),before);
    else assert.deepEqual(labels(imported),choice===true?['003.','7.2','']:['1.','2.','3.']);
  }
});

test('formatted source numbers lose decoration without changing identifier characters', () => {
  const doc=parseJiraMarkup('||Номер||Проверка||\n|{color:red}*7.2*{color}|A|\n|QA_10|B|');
  numbering.configureImport(doc,true);
  assert.deepEqual(labels(doc),['7.2','QA_10']);
});
