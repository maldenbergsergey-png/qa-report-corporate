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
    document:{createElement:()=>({innerHTML:"", get textContent(){return this.innerHTML.replace(/<[^>]*>/g,"");},
      querySelector(){return /<(img|a|pre|table|video|audio|iframe)\b|cell-file/.test(this.innerHTML);}})},
    flushDraftFromDom(){}, askConfirmation:async()=>false });
  for (const name of ["loadDefaultColumns", "hasReportDataToReplace", "confirmImportReplacement", "importedDraftInCurrentReport"]) {
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
      ctx.requestAnimationFrame=callback=>callback();
      ctx.setImportBusy=busy=>{ctx.elements.applyImportButton.disabled=busy;};
      ctx.setImportProgress=()=>{};
      ctx.document.getElementById=()=>({hidden:true});
      ctx.askConfirmation=async()=>confirmed;
      ctx.pendingImportedDraft={intro:"Imported",sections:[{title:"Вход"}]};
      ctx.saveReportSnapshot=async reason=>calls.push(reason);
      ctx.saveDraft=async()=>{calls.push("save");return true;};
      ctx.clone=value=>JSON.parse(JSON.stringify(value));
      ctx.stripSectionNumber=value=>value;
      ctx.serializeDraft=()=>JSON.stringify(ctx.draft);
      for (const fn of ["render","scheduleHistoryCommit","renderEnvironmentOptions","updateChecklistUrl",
        "closeImport","showToast","updateHistoryButtons"]) ctx[fn]=()=>{};
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
