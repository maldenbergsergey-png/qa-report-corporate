const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const table = require('../checklist-table');
const numbering = require('../checklist-numbering');
const reportFile = require('../report-file');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function harness() {
  const values = new Map();
  const fields = { pinNumberColumn:{checked:true},pinStatusColumn:{checked:false} };
  const ctx = vm.createContext({ window:{QaReportTable:table}, ChecklistNumbering:numbering,
    PINNED_COLUMNS_KEY:'pins',DEFAULT_NUMBERING_KEY:'numbering',
    DEFAULT_DRAFT:{numberingMode:'hierarchical'},draft:{numberingMode:'section',sectionNumberingMode:'automatic',pinnedColumns:{number:false,status:true}},
    pinnedColumns:{number:false,status:true},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},
    document:{getElementById:id=>fields[id],body:{classList:{toggle(){}}},createElement:()=>({dataset:{},append(){},addEventListener(name,fn){this.fire=()=>fn({stopPropagation(){}});}})},
    elements:{sections:{querySelectorAll:()=>[]},jiraSettingsModal:{querySelector:selector=>({value:selector.includes('[name="numberingMode"]')?'continuous':'automatic'})}},
    scheduleStickySectionUpdate(){},flushDraftFromDom(){},saveLocalMutationNow(){},createUiIcon:()=>({}),renderSections(){assert.fail('Changing a default must not rerender or renumber the current report');} });
  for(const name of ['loadPinnedColumns','fillPinnedColumnsForm','savePinnedColumns','applyPinnedColumns','createEditorColumnPin','loadDefaultNumberingMode','saveChecklistSettings']) {
    const code=source.match(new RegExp('^function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?^}', 'm'))?.[0];
    assert.ok(code,name);vm.runInContext(code,ctx);
  }
  return {ctx,values,fields};
}
test('report pinning is independent of defaults and returns a fresh boolean pair',()=>{
  const defaults={number:true,status:false};
  assert.deepEqual(table.normalizePinning(undefined,defaults),defaults);
  assert.deepEqual(table.normalizePinning({number:false,status:true},defaults),{number:false,status:true});
  const actual=table.normalizePinning(undefined,defaults);actual.number=false;assert.equal(defaults.number,true);
});
test('saving defaults does not change the current checklist; pins only change the report',()=>{
  const {ctx,values}=harness();
  ctx.savePinnedColumns();
  assert.equal(values.get('pins'),JSON.stringify({number:true,status:false}));
  assert.equal(ctx.draft.pinnedColumns.status,true);
  assert.equal(ctx.draft.pinnedColumns.number,false);
  ctx.createEditorColumnPin('status').fire();
  assert.equal(ctx.draft.pinnedColumns.status,false);
  assert.equal(values.get('pins'),JSON.stringify({number:true,status:false}));
  assert.equal(ctx.DEFAULT_DRAFT.pinnedColumns.number,true);
});
test('the numbering setting seeds new checklists without renumbering an existing one',()=>{
  const {ctx,values}=harness();ctx.saveChecklistSettings();
  assert.equal(ctx.draft.numberingMode,'section');
  assert.equal(ctx.DEFAULT_DRAFT.numberingMode,'continuous');
  assert.equal(ctx.loadDefaultNumberingMode(),'continuous');
  assert.equal(values.get('numbering'),'continuous');
});
test('portable reports preserve pinning and validate its values without copying extra fields',()=>{
  const doc={schemaVersion:3,issueUrl:'',environment:'',overallStatus:'',intro:'',numberingMode:'section',
    pinnedColumns:{number:true,status:false,token:'omit'},sections:[{id:'s',title:'Раздел',columns:[{id:'c',title:'Проверка'}],rows:[{id:'r',status:'OK',cells:{c:'Пункт'}}]}]};
  assert.deepEqual(reportFile.documentFields(doc).pinnedColumns,{number:true,status:false});
  delete doc.pinnedColumns;assert.equal(reportFile.documentFields(doc).pinnedColumns,undefined);
  for(const pinnedColumns of [null,[],{number:'yes',status:false},{number:true}]) assert.throws(()=>reportFile.documentFields({...doc,pinnedColumns}),/структура/);
});
