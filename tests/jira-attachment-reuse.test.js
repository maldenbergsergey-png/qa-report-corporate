const test=require('node:test');const assert=require('node:assert/strict');
require('../jira-attachment-reuse');
const reuse=globalThis.QaReportJiraReuse;
const issueUrl='https://jira.example/jira/browse/QA-1';
const data=value=>`data:text/plain;base64,${Buffer.from(value).toString('base64')}`;
const remote={id:'7',filename:'Screenshot 2.txt',content:'https://jira.example/jira/secure/attachment/7/Screenshot%202.txt'};
async function asset(value='original',source=true){return{attachmentId:'local',name:remote.filename,type:'text/plain',dataUrl:data(value),source:{issueUrl:source?issueUrl:'',id:source?'7':'',name:remote.filename,hash:source?(await reuse.digest(data('original'))).hash:'',kind:'file'}};}
const options=(attachments=[remote])=>({issueUrl,attachments,loadSource:()=>{throw Error('unexpected download');}});
test('same issue and unchanged bytes reuse the exact Jira attachment and original name',async()=>{
 const original=await asset();const result=await reuse.plan([original],options());assert.equal(result.uploads.length,0);assert.equal(result.reused[0].id,'7');assert.equal(result.reused[0].filename,remote.filename);
 assert.equal(reuse.bindings(result.reused)[0].attachmentId,'local');
});
test('changed content and a new file with the same name get new names, never false reuse',async()=>{
 for(const candidate of [await asset('changed'),await asset('original',false)]){
  const result=await reuse.plan([candidate],options());assert.equal(result.reused.length,0);assert.equal(result.uploads[0].name,'Screenshot 2 (2).txt');
 }
});
test('deleted attachment is restored from local bytes with its original filename',async()=>{
 const result=await reuse.plan([await asset()],options([]));assert.equal(result.uploads[0].name,remote.filename);assert.equal(result.reused.length,0);
});
test('a reference does not download bytes when its attachment still exists',async()=>{
 const original=await asset();original.dataUrl='';original.source.hash='';
 const result=await reuse.plan([original],options());assert.equal(result.uploads.length,0);assert.equal(result.reused.length,1);
});
test('cross-issue publication copies bytes and deduplicates references and local copies',async()=>{
 const original=await asset();const reference={...original,dataUrl:'',source:{...original.source,hash:''}};
 const result=await reuse.plan([reference,original],{...options([]),issueUrl:'https://jira.example/jira/browse/QA-2'});
 assert.equal(result.reused.length,0);assert.equal(result.uploads.length,1);assert.equal(result.uploads[0].originals.length,2);
});
test('same numeric ID in another Jira is never reused; missing source reports an error',async()=>{
 const original=await asset();original.source.issueUrl='https://other.example/browse/QA-1';
 const result=await reuse.plan([original],options());assert.equal(result.reused.length,0);
 original.dataUrl='';await assert.rejects(reuse.plan([original],{...options(),loadSource:async()=>{throw Error('HTTP 403');}}),/HTTP 403/);
});
test('duplicate Jira names use exact URLs and unavailable inventories fail closed',async()=>{
 const result=await reuse.plan([await asset()],options([remote,{...remote,id:'8'}]));assert.equal(result.reused[0].exactUrl,true);
 await assert.rejects(reuse.plan([await asset()],{issueUrl,attachments:null}),/проверить/);
});
test('invalid source URLs cannot carry credentials or cross into another origin',()=>{
 assert.equal(reuse.sourceUrl('javascript:alert(1)',issueUrl),'');assert.equal(reuse.sourceUrl('https://other.example/file',issueUrl),'');
 assert.equal(reuse.sourceUrl('https://token@jira.example/file',issueUrl),'');
 assert.equal(reuse.issueIdentity('https://jira.example/jira/browse/qa-1?focusedCommentId=2'),issueUrl);
});

test('missing remote attachment can be restored from an unchanged copy beside reference-only occurrences',async()=>{
 const original=await asset();const reference={...original,dataUrl:'',source:{...original.source,hash:''}};
 const result=await reuse.plan([reference,original],options([]));
 assert.equal(result.uploads.length,1);assert.equal(result.uploads[0].originals.length,2);assert.equal(result.uploads[0].name,remote.filename);
});
test('a modified local image does not retarget an unchanged reference to the same source ID',async()=>{
 const original=await asset('modified');const reference={...original,dataUrl:'',source:{...original.source,hash:''}};
 const result=await reuse.plan([original,reference],options());
 assert.equal(result.uploads.length,1);assert.equal(result.reused.length,1);
 assert.notEqual(result.uploads[0].originals[0].key,result.reused[0].originals[0].key);
});
test('reference-only copies across issues read the source once and do not reuse a coincident target ID',async()=>{
 const reference=await asset();reference.dataUrl='';let downloads=0;
 const result=await reuse.plan([reference,{...reference,attachmentId:'second'}],{...options(),issueUrl:'https://jira.example/jira/browse/QA-2',loadSource:async()=>{downloads++;return data('original');}});
 assert.equal(downloads,1);assert.equal(result.uploads.length,1);assert.equal(result.reused.length,0);
});
