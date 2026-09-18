const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../app.js"), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}
function harness() {
  const draft = {draftId:"draft", reportId:"report", publicId:"abc12345", revision:7,
    updatedAt:"old", lastSavedBy:"tab", lastSavedClientId:"browser", issueUrl:"", intro:"",
    environment:"STAGE", overallStatus:"OK", sections:[{title:"Основные проверки",
      columns:[{id:"check",title:"Проверка"}], rows:[
        {status:"НЕ ПРОВЕРЕНО", cells:{check:""}}, {status:"НЕ ПРОВЕРЕНО", cells:{check:""}}]}]};
  const ctx = vm.createContext({ draft, DEFAULT_DRAFT:{environment:"STAGE",overallStatus:"OK"},
    DEFAULT_COLUMNS:[{id:"check",title:"Проверка"}], normalizeDraft:value=>value,
    ChecklistNumbering:require('../checklist-numbering'),
    document:{createElement:()=>({innerHTML:"", get textContent(){return this.innerHTML.replace(/<[^>]*>/g,"");},
      querySelector(){return /<(img|a|pre|table|video|audio|iframe)\b|cell-file/.test(this.innerHTML);}})},
    flushDraftFromDom(){}, askConfirmation:async()=>false });
  for (const name of ["loadDefaultColumns", "hasReportDataToReplace", "confirmImportReplacement", "importedDraftInCurrentReport", "chooseImportedNumbering"]) {
    vm.runInContext(functionSource(name), ctx);
  }
  return ctx;
}
test("untouched template imports without warning; meaningful changes require confirmation", async () => {
  const ctx = harness();
  assert.equal(ctx.hasReportDataToReplace(), false);
  assert.equal(await ctx.confirmImportReplacement(), true);
  for (const change of [
    d=>d.intro="<p>Заметка</p>", d=>d.sections[0].title="Вход",
    d=>d.sections[0].rows[0].cells.check="<img src='test.png'>",
    d=>d.sections[0].rows[0].status="OK", d=>d.sections[0].columns[0].title="Иное",
    d=>d.environment="DEV", d=>d.issueUrl="https://example.com/browse/QA-1",
  ]) {
    const c=harness(); change(c.draft);
    const before=JSON.stringify(c.draft);
    assert.equal(c.hasReportDataToReplace(), true);
    assert.equal(await c.confirmImportReplacement(), false);
    assert.equal(JSON.stringify(c.draft), before);
  }
});
test("import preserves report identity and sync revision and replaces content", () => {
  const ctx=harness();
  const result=ctx.importedDraftInCurrentReport({draftId:"unwanted",reportId:"new",publicId:"new",
    revision:0, intro:"Imported", sections:[{title:"Вход"}]});
  for (const field of ["draftId","reportId","publicId","revision","updatedAt","lastSavedBy","lastSavedClientId"])
    assert.equal(result[field],ctx.draft[field]);
  assert.equal(result.intro,"Imported");
  assert.equal(result.sections[0].title,"Вход");
});
test("failed snapshot prevents creating a new report", async () => {
  const ctx=harness(); let message="";
  ctx.saveReportSnapshot=async()=>{throw Error("disk full");};
  ctx.showToast=value=>{message=value;};
  vm.runInContext(functionSource("resetDraft"),ctx);
  const before=JSON.stringify(ctx.draft);
  await ctx.resetDraft();
  assert.equal(JSON.stringify(ctx.draft),before);
  assert.match(message,/disk full/);
});


test("replacement and inbound import keep the open report; cancel performs no save", async () => {
  for (const entry of ["applyImport", "applyImportedChecklist"]) {
    for (const confirmed of [false,true]) {
      const ctx=harness(); const calls=[];
      ctx.draft.intro="Existing";
      ctx.elements={applyImportButton:{disabled:false},importWarning:{hidden:true},importSummary:{hidden:true}};
      ctx.pwaPendingOperations=0;
      ctx.importSource="markup";
      ctx.importWizard={preserveNumbers:()=>true,getPlacement:()=>({mode:"replace"})};
      ctx.importContext=null; ctx.pendingImportErrors=[]; ctx.saveTimer=0; ctx.historyTimer=0; ctx.clearTimeout=()=>{};
      ctx.historyCurrent=JSON.stringify(ctx.draft); ctx.undoStack=[]; ctx.redoStack=[];
      ctx.requestAnimationFrame=callback=>callback();
      ctx.setImportBusy=busy=>{ctx.elements.applyImportButton.disabled=busy;};
      ctx.setImportProgress=()=>{};
      ctx.document.getElementById=()=>({hidden:true});
      ctx.askConfirmation=async()=>confirmed;
      ctx.pendingImportedDraft={intro:"Imported",sections:[{title:"Вход",rows:[]}]};
      ctx.saveReportSnapshot=async reason=>calls.push(reason);
      ctx.saveDraft=async()=>{calls.push("save");return true;};
      ctx.clone=value=>JSON.parse(JSON.stringify(value));
      ctx.stripSectionNumber=value=>value;
      ctx.serializeDraft=()=>JSON.stringify(ctx.draft);
      for (const fn of ["render","scheduleHistoryCommit","renderEnvironmentOptions","updateChecklistUrl",
        "closeImport","showToast","showImportResult","updateHistoryButtons"]) ctx[fn]=()=>{};
      for (const name of ["checkImportContext","recordImportHistory"]) vm.runInContext(functionSource(name),ctx);
      vm.runInContext(functionSource(entry),ctx);
      const before=JSON.stringify(ctx.draft);
      if (entry==="applyImport") await ctx.applyImport();
      else await ctx.applyImportedChecklist(ctx.pendingImportedDraft,{checklistId:"other",publicId:"other"});
      if (!confirmed) {
        assert.equal(JSON.stringify(ctx.draft),before);assert.deepEqual(calls,[]);
      } else {
        assert.equal(ctx.draft.reportId,"report");assert.equal(ctx.draft.publicId,"abc12345");
        assert.equal(ctx.draft.intro,"Imported");assert.ok(calls.includes("save"));
      }
    }
  }
});
test("environment history survives reload, deduplicates and separates workspaces", () => {
  const stored=new Map(); const list={replaceChildren(){this.items=[];},append(item){this.items.push(item.value);},items:[]};
  const ctx=vm.createContext({reportWorkspaceKey:"a",localStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},
    document:{getElementById:()=>list,createElement:()=>({})}});
  vm.runInContext(functionSource("renderEnvironmentOptions"),ctx);
  ctx.renderEnvironmentOptions("  QA-LOCAL  ");ctx.renderEnvironmentOptions("qa-local");ctx.renderEnvironmentOptions();
  assert.equal(list.items.filter(x=>x.toLowerCase()==="qa-local").length,1);
  ctx.reportWorkspaceKey="b";ctx.renderEnvironmentOptions();
  assert.equal(list.items.some(x=>x.toLowerCase()==="qa-local"),false);
  ctx.reportWorkspaceKey="a";ctx.renderEnvironmentOptions();
  assert.equal(list.items.some(x=>x.toLowerCase()==="qa-local"),true);
});

function additionHarness(mode = 'rows') {
  const ctx=harness();
  ctx.draft.sections[0].id='target';
  ctx.draft.sections[0].rows.forEach((row,index)=>row.id=`old-${index}`);
  ctx.draft.sections[0].rows[0].cells.check='Existing check';
  ctx.draft.numberingMode='manual';ctx.draft.sections[0].rows[0].manualNumber='11';
  ctx.pendingImportedDraft=require('../jira-markup-import').parseJiraMarkup('h2. New\n||Проверка||ФР||Статус||\n|New A|<strong>Actual</strong>|OK|\n|New B|Other|НЕ ОК|');
  ctx.pendingImportErrors=[];ctx.preparedImport={};ctx.importSource='markup';ctx.pwaPendingOperations=0;
  ctx.importWizard={getPlacement:()=>({mode,targetId:'target',preserveNumbers:true}),preserveNumbers:()=>true,refreshCurrent(){}};
  ctx.window={QaReportImportOptions:require('../import-options')};ctx.crypto=require('node:crypto');
  ctx.elements={applyImportButton:{disabled:false},importWarning:{hidden:true},importSummary:{hidden:true},undoButton:{},redoButton:{}};
  ctx.document.getElementById=()=>({hidden:true});ctx.requestAnimationFrame=cb=>cb();ctx.clearTimeout=()=>{};
  ctx.setImportBusy=value=>{ctx.elements.applyImportButton.disabled=value;};ctx.setImportProgress=()=>{};
  ctx.clone=value=>JSON.parse(JSON.stringify(value));ctx.serializeDraft=()=>JSON.stringify(ctx.draft);
  ctx.historyCurrent=ctx.serializeDraft();ctx.undoStack=[];ctx.redoStack=[];ctx.historyTimer=0;ctx.saveTimer=0;
  ctx.importContext={reportId:ctx.draft.reportId,snapshot:ctx.serializeDraft()};
  ctx.calls=[];ctx.saveReportSnapshot=async reason=>{ctx.calls.push(reason);};ctx.saveDraft=async()=>true;
  ctx.flushDraftFromDom=()=>{ctx.draft.sections.forEach(s=>s.rows.forEach(row=>{if(ctx.draft.numberingMode==='manual')row.manualNumber??='';}));};
  ctx.flushDraftFromDom();ctx.importContext.snapshot=ctx.serializeDraft();ctx.historyCurrent=ctx.serializeDraft();
  for(const fn of ['render','renderEnvironmentOptions','updateChecklistUrl','updateHistoryButtons','showToast','showImportResult'])ctx[fn]=()=>{};
  ctx.closeImport=()=>{ctx.closed=true;};ctx.collectDocumentFields=ctx.flushDraftFromDom;
  for(const name of ['checkImportContext','recordImportHistory','applyImport','undo','redo','restoreSerializedDraft'])vm.runInContext(functionSource(name),ctx);
  return ctx;
}

test('adding sections or rows retains prior edits and is exactly one undo/redo step in manual mode', async()=>{
  for(const mode of ['rows','sections']) {
    const ctx=additionHarness(mode), untouched=ctx.historyCurrent;
    ctx.draft.sections[0].rows[0].cells.check='Just typed';
    ctx.importContext.snapshot=ctx.serializeDraft();const before=ctx.serializeDraft();
    await ctx.applyImport();
    assert.equal(ctx.closed,true);assert.equal(ctx.elements.importWarning.hidden,true);
    assert.equal(ctx.draft.sections[0].rows[0].cells.check,'Just typed');
    assert.equal(ctx.draft.sections[0].rows[0].manualNumber,'11');
    const applied=ctx.serializeDraft();
    ctx.undo();assert.equal(ctx.serializeDraft(),before);
    ctx.redo();assert.equal(ctx.serializeDraft(),applied);
    ctx.undo();ctx.undo();assert.equal(ctx.serializeDraft(),untouched);
  }
});

test('failure saving the pre-import snapshot does not change the checklist or undo history', async()=>{
  const ctx=additionHarness(), before=ctx.serializeDraft();
  ctx.saveReportSnapshot=async()=>{throw Error('Storage unavailable');};
  await ctx.applyImport();
  assert.equal(ctx.serializeDraft(),before);assert.equal(ctx.undoStack.length,0);assert.equal(ctx.closed,undefined);
  assert.match(ctx.elements.importWarning.textContent,/Storage unavailable/);assert.equal(ctx.elements.applyImportButton.disabled,false);
});

test('stale preview refreshes before adding; switching reports never imports into the new report', async()=>{
  for(const switchReport of [false,true]) {
    const ctx=additionHarness();let refreshed=false;ctx.importWizard.refreshCurrent=()=>{refreshed=true;};
    if(switchReport)ctx.draft.reportId='different';else ctx.draft.sections[0].title='Renamed';
    const before=ctx.serializeDraft();await ctx.applyImport();
    assert.equal(ctx.serializeDraft(),before);assert.equal(ctx.calls.length,0);assert.equal(ctx.closed,undefined);
    assert.equal(refreshed,!switchReport);assert.equal(ctx.elements.importWarning.hidden,false);
  }
});

test('rapid repeated submit commits the addition only once', async()=>{
  const ctx=additionHarness();let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  ctx.saveReportSnapshot=async reason=>{ctx.calls.push(reason);if(reason==='before-import')await waiting;};
  const first=ctx.applyImport(), second=ctx.applyImport();release();await Promise.all([first,second]);
  assert.equal(ctx.draft.sections[0].rows.length,4);
  assert.equal(ctx.calls.filter(reason=>reason==='before-import').length,1);
});
