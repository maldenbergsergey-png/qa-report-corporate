const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../import-options');
const N = require('../checklist-numbering');
const current = () => ({ reportId: 'report', publicId: 'public', draftId: 'draft', intro: '<p>Keep intro</p>',
  issueUrl: 'https://example.test/QA-1', environment: 'PROD', overallStatus: 'НЕ ОК', numberingMode: 'continuous',
  sections: [{ id: 'existing', title: 'Login', columns: [{ id: 'check', title: 'Проверка' }, { id: 'actual', title: 'ФР' }],
    rows: [{ id: 'old', status: 'НЕ ОК', manualNumber: '42', cells: { check: '<strong>Old</strong>', actual: '<img src="data:old">' } }] },
  { id: 'last', title: 'Last', columns: [{ id: 'text', title: 'Проверка' }], rows: [{ id: 'last-row', status: 'OK', cells: { text: 'Last row' } }] }] });
const incoming = () => ({ reportId: 'foreign', intro: '<p>Foreign intro</p>', environment: 'DEV', issueUrl: 'foreign', overallStatus: 'OK',
  sections: [{ id: 'src', title: 'Login', columns: [{ id: 'a', title: '  ПРОВЕРКА  ' }, { id: 'b', title: 'Комментарий' }],
    rows: [{ id: 'row', manualNumber: '7.2', status: 'OK', cells: { a: 'New check', b: '<a data-file-id="file">log</a>' } }] },
  { id: 'src2', title: 'Payment', columns: [{ id: 'c', title: 'Проверка' }, { id: 'd', title: 'Комментарий' }],
    rows: [{ id: 'row2', manualNumber: '9', status: 'НЕ ПРОВЕРЕНО', cells: { c: 'Pay', d: '<img src="data:new">' } }] }] });

test('new sections preserve current report metadata, existing IDs, results and input documents', () => {
  const doc = current(), source = incoming(), before = JSON.stringify([doc, source]);
  const result = O.planAddition(doc, source, { mode: 'sections' });
  for (const field of ['reportId','publicId','draftId','intro','issueUrl','environment','overallStatus','numberingMode']) assert.equal(result.document[field], doc[field]);
  assert.deepEqual(result.document.sections.slice(0,2), doc.sections);
  assert.deepEqual(result.duplicateTitles, ['Login']);
  assert.deepEqual(result.document.sections.map(s=>s.title), ['Login','Last','Login','Payment']);
  assert.deepEqual([...N.rowNumbers(result.document).values()], ['1.','2.','3.','4.']);
  assert.equal(JSON.stringify([doc, source]), before);
  assert.equal(result.document.sections[2].rows[0].manualNumber, undefined);
});

test('placement supports start and after a section; stale anchors are rejected without mutation', () => {
  const doc=current(), source=incoming(), before=JSON.stringify(doc);
  assert.deepEqual(O.planAddition(doc,source,{mode:'sections',afterId:'start'}).document.sections.map(s=>s.title), ['Login','Payment','Login','Last']);
  assert.deepEqual(O.planAddition(doc,source,{mode:'sections',afterId:'existing'}).document.sections.map(s=>s.title), ['Login','Login','Payment','Last']);
  assert.throws(()=>O.planAddition(doc,source,{mode:'sections',afterId:'deleted'}),/больше не существует/);
  assert.equal(JSON.stringify(doc),before);
});

test('merging multiple sections matches names, retains rich content and fills missing columns', () => {
  const doc=current(), source=incoming(), before=JSON.stringify([doc,source]);
  const plan=O.planAddition(doc,source,{mode:'rows',targetId:'existing'}), target=plan.document.sections[0];
  assert.equal(plan.document.sections.length,2);
  assert.deepEqual(target.columns.map(c=>c.title),['Проверка','ФР','Комментарий']);
  assert.equal(plan.newColumns.length,1);
  assert.equal(target.rows[0].cells.actual,'<img src="data:old">');
  const comment=target.columns[2].id;
  assert.equal(target.rows[0].cells[comment],'');
  assert.equal(target.rows[1].cells.check,'New check'); assert.equal(target.rows[1].cells.actual,'');
  assert.equal(target.rows[1].cells[comment],'<a data-file-id="file">log</a>');
  assert.equal(target.rows[2].cells[comment],'<img src="data:new">');
  assert.deepEqual(target.rows.map(r=>r.status),['НЕ ОК','OK','НЕ ПРОВЕРЕНО']);
  assert.deepEqual([...N.rowNumbers(plan.document).values()], ['1.','2.','3.','4.']);
  assert.equal(JSON.stringify([doc,source]),before);
});

test('custom mappings support differently named columns; explicit choices take priority over automatic matches', () => {
  const doc=current(), source=incoming(); source.sections=source.sections.slice(0,1);
  const columns=new Map([[O.key('src','b'),'check']]);
  const plan=O.planAddition(doc,source,{mode:'rows',targetId:'existing',columns});
  const target=plan.document.sections[0], row=target.rows[1];
  assert.equal(row.cells.check,'<a data-file-id="file">log</a>');
  assert.equal(row.cells[plan.newColumns[0].id],'New check');
  assert.equal(target.rows[0].cells.check,'<strong>Old</strong>');
});

test('duplicate source names never overwrite one another and explicit new columns remain separate', () => {
  const doc=current(), source=incoming(); source.sections=source.sections.slice(0,1);
  source.sections[0].columns[1].title='Проверка';
  const plan=O.planAddition(doc,source,{mode:'rows',targetId:'existing'});
  assert.equal(plan.newColumns.length,1);
  const row=plan.document.sections[0].rows[1];
  assert.equal(row.cells.check,'New check'); assert.equal(row.cells[plan.newColumns[0].id],'<a data-file-id="file">log</a>');
  const separate=O.planAddition(doc,source,{mode:'rows',targetId:'existing',columns:new Map([[O.key('src','a'),'new']])});
  assert.equal(separate.document.sections[0].rows[1].cells.check,'<a data-file-id="file">log</a>');
});

test('invalid and duplicate column destinations block the whole operation', () => {
  const doc=current(), source=incoming(), before=JSON.stringify(doc);
  for (const columns of [new Map([[O.key('src','a'),'missing']]), new Map([[O.key('src','a'),'check'],[O.key('src','b'),'check']])])
    assert.throws(()=>O.planAddition(doc,source,{mode:'rows',targetId:'existing',columns}));
  assert.throws(()=>O.planAddition(doc,source,{mode:'rows',targetId:'missing'}),/Выберите раздел/);
  assert.equal(JSON.stringify(doc),before);
});

test('new fields from later sources are empty in all earlier rows, including imported ones', () => {
  const source=incoming();source.sections[1].columns[1].title='Additional';
  const plan=O.planAddition(current(),source,{mode:'rows',targetId:'existing'}), target=plan.document.sections[0];
  const added=target.columns.find(c=>c.title==='Additional');
  assert.equal(target.rows[0].cells[added.id],'');assert.equal(target.rows[1].cells[added.id],'');
  for(const row of target.rows) assert.deepEqual(Object.keys(row.cells).sort(),target.columns.map(c=>c.id).sort());
});

test('manual numbering only preserves requested incoming numbers and never changes current numbers', () => {
  const doc=current();doc.numberingMode='manual';
  for(const mode of ['sections','rows']) for(const preserveNumbers of [false,true]) {
    const plan=O.planAddition(doc,incoming(),{mode,targetId:'existing',preserveNumbers});
    const numbers=N.rowNumbers(plan.document);
    assert.equal(plan.document.numberingMode,'manual'); assert.equal(numbers.get('old'),'42');
    assert.deepEqual(plan.rowIds.map(id=>numbers.get(id)),preserveNumbers?['7.2','9']:['','']);
  }
});

test('section and hierarchical numbering previews reflect the destination, including collapsed sections', () => {
  const doc=current();doc.sections[0].collapsed=true;
  for(const mode of ['section','hierarchical']) {
    doc.numberingMode=mode;
    const plan=O.planAddition(doc,incoming(),{mode:'rows',targetId:'existing',preserveNumbers:true});
    assert.deepEqual(plan.rowIds.map(id=>N.rowNumbers(plan.document).get(id)),mode==='section'?['2.','3.']:['1.2','1.3']);
    assert.equal(plan.document.sections[0].collapsed,false);
  }
});

test('fresh identifiers keep repeated imports independent, even when imported IDs collide with current IDs', () => {
  const source=incoming();source.sections[0].id='existing';source.sections[0].rows[0].id='old';
  let count=0;const createId=()=>`id-${++count}`;
  const first=O.planAddition(current(),source,{mode:'sections'},createId);
  const second=O.planAddition(first.document,source,{mode:'sections'},createId);
  const ids=second.document.sections.flatMap(s=>[s.id,...s.rows.map(r=>r.id),...s.columns.map(c=>c.id)]);
  assert.equal(new Set(ids).size,ids.length);
  assert.deepEqual(second.document.sections.slice(0,4),first.document.sections);
});
