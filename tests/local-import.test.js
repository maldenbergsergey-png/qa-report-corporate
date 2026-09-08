const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createLocalImportService } = require("../local-import-server");
const { downloadJiraAttachment } = require("../jira-attachment-transfer");
const { parseJiraMarkup } = require("../jira-markup-import");
async function fixture(options = {}) {
  const service = createLocalImportService(options);
  let origin;
  const server = http.createServer(async (req,res) => {
    try {
      if (await service.producer(req,res,origin)) return;
      if (await service.browser(req,res,{owner:req.headers["x-test-owner"] || "a", origin})) return;
      res.writeHead(404);res.end();
    } catch(error) { res.writeHead(error.status || 500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message})); }
  });
  await new Promise((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  origin = `http://127.0.0.1:${server.address().port}`;
  const context = {sections:[{id:"section",columns:[{id:"actual",title:"ФР"}],rows:[{id:"row",cells:{actual:{text:"",hash:"0".repeat(64)}}}]}]};
  const create = (headers={}) => fetch(`${origin}/api/local-import/sessions`,{method:"POST",headers:{"X-QA-Import-Request":"1","Content-Type":"application/json",...headers},body:JSON.stringify({reportId:"report",context})});
  const session = await (await create()).json();
  const agent = (suffix,options={}) => fetch(session.connection.url+suffix,{...options,headers:{"X-QA-Import-Token":session.connection.token,...options.headers}});
  const browser = (suffix,options={}) => fetch(`${origin}/api/local-import/sessions/${session.id}${suffix}`,{...options,headers:{"X-QA-Import-Request":"1","X-QA-Import-Reader":session.consumerToken,...options.headers}});
  return { origin, create,session,agent,browser,close:async()=>{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));} };
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=","base64");
const payload = (id="batch", file="shot") => ({id,kind:"cells",updates:[{sectionId:"section",rowId:"row",columnId:"actual",expectedHash:"0".repeat(64),text:"Проверено",attachmentIds:[file]}]});
test("binary upload reaches the browser, remains pending until durable acknowledgement and is then removed", async()=>{
  const f=await fixture();try {
    assert.equal((await f.agent("/files/shot",{method:"PUT",headers:{"Content-Type":"image/png","X-QA-File-Name":encodeURIComponent("Скриншот.png")},body:png})).status,201);
    const body=JSON.stringify(payload());
    assert.equal((await f.agent("/batches",{method:"POST",body})).status,202);
    const next=await (await f.browser("/next")).json();
    assert.equal(next.batch.files[0].name,"Скриншот.png");assert.equal(next.batch.files[0].type,"image/png");
    const file=await f.browser("/files/shot");assert.equal(file.headers.get("cache-control"),"no-store");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);
    assert.equal((await (await f.agent("/batches/batch")).json()).status,"pending");
    assert.equal((await f.agent("/batches",{method:"POST",body})).status,200);
    assert.equal((await f.agent("/batches",{method:"POST",body:JSON.stringify({...payload(),title:"different"})})).status,409);
    assert.equal((await f.browser("/ack",{method:"POST",body:JSON.stringify({id:"batch",status:"saved"})})).status,200);
    assert.equal((await (await f.agent("/batches/batch")).json()).status,"saved");
    assert.equal((await f.browser("/files/shot")).status,404);
    assert.equal((await (await f.browser("/next")).json()).batch,null);
    assert.equal((await f.agent("/batches",{method:"POST",body})).status,200);
  } finally {await f.close();}
});
test("session capabilities separate producer and consumer, enforce owner and origin, and revoke on close",async()=>{
  const f=await fixture();try {
    assert.equal((await f.agent("/context",{headers:{"X-QA-Import-Token":"wrong"}})).status,404);
    assert.equal((await f.browser("/next",{headers:{"X-QA-Import-Reader":f.session.connection.token}})).status,404);
    assert.equal((await f.browser("/next",{headers:{"X-Test-Owner":"b"}})).status,404);
    assert.equal((await f.agent("/files/x",{method:"PUT",headers:{Origin:"https://evil.example"},body:"x"})).status,403);
    assert.equal((await f.create({Origin:"https://evil.example"})).status,403);
    assert.equal((await f.browser("",{method:"DELETE"})).status,200);
    assert.equal((await f.agent("/context")).status,404);
  } finally {await f.close();}
});
test("expired sessions discard files; oversized requests and missing files never become pending batches",async()=>{
  let time=1000;const f=await fixture({maxFileBytes:8,maxSessionBytes:10,ttlMs:100,now:()=>time});try {
    assert.equal((await f.agent("/files/big",{method:"PUT",body:"012345678"})).status,413);
    assert.equal((await f.agent("/files/a",{method:"PUT",body:"01234567"})).status,201);
    assert.equal((await f.agent("/files/b",{method:"PUT",body:"012"})).status,413);
    assert.equal((await f.agent("/batches",{method:"POST",body:JSON.stringify(payload())})).status,409);
    time+=101;
    assert.equal((await f.browser("/files/a")).status,404);
    assert.equal((await f.agent("/context")).status,404);
  } finally {await f.close();}
});
test("rejected batches release files and explicit hashes are required",async()=>{
  const f=await fixture();try {
    await f.agent("/files/shot",{method:"PUT",body:png});
    const missingHash=payload();delete missingHash.updates[0].expectedHash;
    assert.equal((await f.agent("/batches",{method:"POST",body:JSON.stringify(missingHash)})).status,400);
    await f.agent("/batches",{method:"POST",body:JSON.stringify(payload())});
    await f.browser("/ack",{method:"POST",body:JSON.stringify({id:"batch",status:"rejected",error:"conflict"})});
    assert.equal((await (await f.agent("/batches/batch")).json()).error,"conflict");
    assert.equal((await f.browser("/files/shot")).status,404);
  } finally {await f.close();}
});
test("Jira downloader resolves only authorized issue attachments, rejects external URLs, redirects, login pages and oversized files",async()=>{
  const attachment={id:"1",filename:"shot.png",content:"https://jira.example/secure/attachment/1/shot.png",mimeType:"image/png"};
  const opts={connection:{type:"data-center",baseUrl:"https://jira.example"},issueKey:"QA-1",attachmentId:"1",jiraFetch:async()=>({fields:{attachment:[attachment]}}),fetchFile:async()=>new Response(png,{headers:{"Content-Type":"image/png"}}),maxBytes:1000};
  const file=await downloadJiraAttachment(opts);assert.deepEqual(file.bytes,png);assert.equal(file.type,"image/png");
  await assert.rejects(downloadJiraAttachment({...opts,attachmentId:"2"}),{status:404});
  attachment.content="https://other.example/file";await assert.rejects(downloadJiraAttachment(opts),{status:403});
  attachment.content="https://jira.example/file";
  await assert.rejects(downloadJiraAttachment({...opts,fetchFile:async()=>new Response(null,{status:302,headers:{Location:"https://other.example"}})}),{status:502});
  await assert.rejects(downloadJiraAttachment({...opts,fetchFile:async()=>new Response("login",{headers:{"Content-Type":"text/html"}})}),{status:502});
  await assert.rejects(downloadJiraAttachment({...opts,maxBytes:4}),{status:413});
  let target;
  await downloadJiraAttachment({...opts,connection:{...opts.connection,type:"cloud"},fetchFile:async url=>{target=url;return new Response(png);}});
  assert.equal(target,"https://jira.example/rest/api/3/attachment/content/1?redirect=false");
});
test("Jira file markers and image markers retain their own cells, including escaped filenames",()=>{
  const doc=parseJiraMarkup("||Проверка||ОР||ФР||\n|Форма|!shot.png!|[^report<1>.pdf]|");
  const values=Object.values(doc.sections[0].rows[0].cells);
  assert.match(values[1],/jira-image-placeholder/);assert.match(values[2],/jira-file-placeholder/);assert.match(values[2],/report&lt;1&gt;\.pdf/);
});
function client() {
  const ctx=vm.createContext({crypto:crypto.webcrypto,TextEncoder,Uint8Array});
  vm.runInContext(fs.readFileSync(require.resolve("../attachment-import.js"),"utf8"),ctx);
  vm.runInContext(fs.readFileSync(require.resolve("../local-import-client.js"),"utf8"),ctx);
  return ctx;
}
test("cell updates preserve other columns, attach actual bytes, escape text and reject stale hashes atomically",async()=>{
  const ctx=client();const doc={sections:[{id:"s",columns:[{id:"expected"},{id:"actual"}],rows:[{id:"r",status:"НЕ ПРОВЕРЕНО",cells:{expected:"Expected",actual:"Before"}}]}]};
  const hash=await ctx.QaLocalImport.cellHash("Before","НЕ ПРОВЕРЕНО");
  const update={sectionId:"s",rowId:"r",columnId:"actual",expectedHash:hash,text:"<script>unsafe</script>",attachmentIds:["file"],status:"OK"};
  const file={id:"local-id",name:"shot.png",type:"image/png",size:png.length,dataUrl:`data:image/png;base64,${png.toString("base64")}`};
  const result=await ctx.QaLocalImport.applyCells(doc,[update],new Map([["file",file]]));
  assert.equal(result.sections[0].rows[0].cells.expected,"Expected");
  assert.match(result.sections[0].rows[0].cells.actual,/&lt;script&gt;/);assert.match(result.sections[0].rows[0].cells.actual,/data:image\/png;base64,/);
  assert.equal(doc.sections[0].rows[0].cells.actual,"Before");
  doc.sections[0].rows[0].cells.actual="User edit";
  await assert.rejects(ctx.QaLocalImport.applyCells(doc,[update],new Map([["file",file]])),/изменилась/);
  assert.equal(doc.sections[0].rows[0].cells.actual,"User edit");
});
