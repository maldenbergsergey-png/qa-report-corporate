const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJiraMarkup, matchStatus } = require('../jira-markup-import');
const O = require('../import-options');
const N = require('../checklist-numbering');
const fixture = () => parseJiraMarkup('h2. First\n||Номер||Проверка||ФР||Комментарий||Статус||\n|003.|A|Old A !old.png!|Keep A|Failed|\n|8|B|Old B|Keep B|Не пройдено|\n|14|C|Old C|Keep C|Passed|\nh2. Second\n||Номер||Проверка||Actual Result||Status||\n|21|D|Old D|Not run|');

test('status aliases preserve source labels; ambiguous and unknown names require mapping', () => {
  const doc = fixture(), state = O.create(doc);
  assert.equal(doc.sections[0].rows[0].sourceStatus, 'Failed');
  assert.equal(state.mapping.get('Failed'), 'НЕ ОК');
  assert.equal(state.mapping.get('Passed'), 'OK');
  assert.equal(state.mapping.get('Not run'), 'НЕ ПРОВЕРЕНО');
  assert.equal(state.mapping.get('Не пройдено'), '');
  assert.deepEqual(matchStatus('Не пройдено'), {status:'НЕ ОК',certain:false});
  assert.equal(matchStatus('Strange status').certain, false);
  assert.deepEqual(matchStatus('{color:red}*   Passed  *{color}'), {status:'OK',certain:true});
  assert.equal(O.summary(doc,state).unresolved,1);
  state.mapping.set('Не пройдено','НЕ ОК');
  assert.equal(O.summary(doc,state).unresolved,0);
});

test('retest filters by original mapped statuses before reset, keeps gaps and does not mutate source', () => {
  const doc = fixture(), before = JSON.stringify(doc), state = O.create(doc);
  state.mapping.set('Не пройдено','НЕ ОК'); state.statuses = new Set(['НЕ ОК']);
  O.preset(doc,state,'retest');
  const result = O.build(doc,state); N.configureImport(result,true,'continuous');
  assert.equal(result.sections.length,1);
  assert.deepEqual(result.sections[0].rows.map(r=>r.status),['НЕ ПРОВЕРЕНО','НЕ ПРОВЕРЕНО']);
  assert.deepEqual([...N.rowNumbers(result).values()],['003.','8']);
  assert.equal(result.overallStatus,'НЕ ПРОВЕРЕНО');
  assert.equal(result.sections[0].rows[0].cells[doc.sections[0].columns[1].id],'');
  assert.equal(result.sections[0].rows[0].sourceStatus,undefined);
  assert.equal(JSON.stringify(doc),before);
});

test('column exclusion and individual clear/keep overrides use stable IDs, even for equal titles', () => {
  const doc = fixture(), state = O.create(doc), section=doc.sections[0], [a,b]=section.rows, [,actual,comment]=section.columns;
  O.preset(doc,state,'retest'); state.mapping.set('Не пройдено','НЕ ОК');
  state.columns.set(O.key(section.id,comment.id),'omit');
  state.cells.set(O.key(b.id,actual.id),'keep');
  state.selectedRows.delete(a.id);
  const result = O.build(doc,state);
  assert.equal(result.sections[0].rows[0].id,b.id);
  assert.equal(result.sections[0].rows[0].cells[actual.id],'Old B');
  assert.equal(result.sections[0].rows[0].cells[comment.id],undefined);
  assert.equal(result.sections[1].columns.length,2);
  assert.equal(Object.values(result.sections[1].rows[0].cells)[1],'');
  O.preset(doc,state,'source');
  assert.equal(O.build(doc,state).sections[0].rows[0].cells[comment.id],'Keep B');
  assert.equal(state.selectedRows.has(a.id),false);
});

test('manual row exclusions survive filter changes; zero rows and zero columns are reported', () => {
  const doc=fixture(), state=O.create(doc), row=doc.sections[0].rows[0];
  state.mapping.set('Не пройдено','НЕ ОК'); state.selectedRows.delete(row.id);
  state.statuses = new Set(['OK']); assert.equal(O.summary(doc,state).count,1);
  state.statuses = new Set(['НЕ ОК']); assert.equal(O.summary(doc,state).count,1);
  for (const c of doc.sections[0].columns) state.columns.set(O.key(doc.sections[0].id,c.id),'omit');
  assert.equal(O.summary(doc,state).emptyColumns,true);
  state.statuses.clear(); assert.equal(O.summary(doc,state).count,0);
});

test('mapping changes regroup rows without losing their source names or manual selection', () => {
  const doc=fixture(), state=O.create(doc);
  state.mapping.set('Не пройдено','OK'); state.statuses = new Set(['OK']);
  assert.equal(O.summary(doc,state).count,2);
  state.mapping.set('Не пройдено','НЕ ОК');
  assert.equal(O.summary(doc,state).count,1);
  assert.equal(doc.sections[0].rows[1].sourceStatus,'Не пройдено');
});

const fs = require('node:fs'), vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'),'utf8');
if (app.includes('function parseAdfDocument(')) test('ADF comment import retains status labels for mapping before filtering', () => {
  const jira=require('../jira-markup-import');
  const ctx=vm.createContext({crypto:require('node:crypto'),createPublicId:()=> 'test',
    window:{QaReportJiraImport:jira},normalizeStatus:jira.normalizeStatus,stripSectionNumber:jira.stripSectionNumber,
    escapeHtml:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;')});
  for (const name of ['adfNodeText','adfNodeToHtml','parseAdfDocument']) {
    const start=app.indexOf(`function ${name}(`),end=app.indexOf('\n}',start)+2;
    vm.runInContext(app.slice(start,end),ctx);
  }
  const cell=(text,header=false)=>({type:header?'tableHeader':'tableCell',content:[{type:'paragraph',content:[{type:'text',text}]}]});
  const doc=ctx.parseAdfDocument({type:'doc',content:[{type:'table',content:[
    {type:'tableRow',content:['Номер','Проверка','Status'].map(text=>cell(text,true))},
    {type:'tableRow',content:['7.2','ADF check','Не пройдено'].map(text=>cell(text))},
  ]}]});
  assert.equal(doc.sections[0].rows[0].sourceStatus,'Не пройдено');
  assert.equal(doc.sections[0].rows[0].manualNumber,'7.2');
  assert.equal(doc.sections[0].columns.length,1);
  const state=O.create(doc); assert.equal(O.summary(doc,state).unresolved,1);
  state.mapping.set('Не пройдено','НЕ ОК');
  assert.equal(O.build(doc,state).sections[0].rows[0].status,'НЕ ОК');
});
