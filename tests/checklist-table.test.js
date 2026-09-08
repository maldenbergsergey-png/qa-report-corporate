const test = require("node:test");
const assert = require("node:assert/strict");
const {visibleRows,canMove,statuses} = require("../checklist-table");
const fs=require("node:fs"), vm=require("node:vm");
const source=fs.readFileSync(require.resolve("../app.js"),"utf8");
function fn(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);return source.slice(start,source.indexOf("\n}",start)+2);}
const fixture=()=>({id:"s", statusSort:true,columns:[{id:"x",title:"X"}],rows:[
 {id:"a",status:"OK",cells:{x:"one"}}, {id:"b",status:"НЕ ОК",cells:{x:"two"}},
 {id:"c",status:"OK",cells:{x:"three"}}]});
test("sorting is stable, covers all statuses and does not mutate canonical order",()=>{
 const section=fixture();assert.deepEqual(visibleRows(section).map(r=>r.id),["b","a","c"]);
 assert.deepEqual(section.rows.map(r=>r.id),["a","b","c"]);
 const all={statusSort:true,rows:[...statuses].reverse().map(status=>({status}))};
 assert.deepEqual(visibleRows(all).map(r=>r.status),statuses);
});
test("unchecked rows always stay below checked rows",()=>{
 const section={statusSort:true,rows:[
  {id:"u1",status:"НЕ ПРОВЕРЕНО"},{id:"ok",status:"OK"},{id:"fail",status:"НЕ ОК"},{id:"u2",status:"НЕ ПРОВЕРЕНО"}
 ]};
 assert.deepEqual(visibleRows(section).map(r=>r.id),["fail","ok","u1","u2"]);
});
test("restoring after edits, deletion and insertion keeps latest data",()=>{
 const section=fixture();section.rows[0].cells.x="edited";
 section.rows.splice(1,1); section.rows.push({id:"d",status:"НЕ ОК",cells:{x:"new"}});
 assert.deepEqual(visibleRows(section).map(r=>r.id),["d","a","c"]);
 const restored=JSON.parse(JSON.stringify(section));restored.statusSort=false;
 assert.deepEqual(visibleRows(restored).map(r=>r.id),["a","c","d"]);
 assert.equal(restored.rows[0].cells.x,"edited");
});
test("moving blocks sorted sources and destinations but allows unaffected sections",()=>{
 const sections=[fixture(),{id:"t",rows:[{id:"z"}]},{id:"u",rows:[]}];
 assert.equal(canMove(sections,new Set(["a"]),"t"),false);
 assert.equal(canMove(sections,new Set(["z"]),"s"),false);
 assert.equal(canMove(sections,new Set(["z"]),"u"),true);
});
test("row action handlers cannot reorder or split a sorted section",()=>{
 for(const action of ["move-up","move-down","split","insert-above","insert-below"]){
  const section=fixture(); const before=JSON.stringify(section);
  const ctx=vm.createContext({draft:{sections:[section]},flushDraftFromDom(){}});
  vm.runInContext(fn("applyRowAction"),ctx);ctx.applyRowAction(section,"b",action);
  assert.equal(JSON.stringify(section),before);
 }
});
test("default column configuration preserves IDs, custom names/order and empty set",()=>{
 const defaults=[{id:"a",title:"A"},{id:"b",title:"B"}];
 let value=null;
 const ctx=vm.createContext({DEFAULT_COLUMNS:defaults,localStorage:{getItem:()=>value}});
 vm.runInContext(fn("loadDefaultColumns"),ctx);
 assert.equal(JSON.stringify(ctx.loadDefaultColumns()),JSON.stringify(defaults));
 value=JSON.stringify([{id:"b",title:"Renamed"}]);
 assert.equal(JSON.stringify(ctx.loadDefaultColumns()),value);
 value="[]";assert.equal(ctx.loadDefaultColumns().length,0);
 value="broken";assert.equal(ctx.loadDefaultColumns().length,2);
});
