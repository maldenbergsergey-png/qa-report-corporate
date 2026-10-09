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

const recoveryOptions = (attachments, loadSource) => ({ ...options(attachments), recoverExisting: true, loadSource });
test('linked report recovers missing bindings by bytes even when Jira uses another filename', async () => {
 const original = await asset('original', false); const calls = [];
 const result = await reuse.plan([original, { ...original, attachmentId: 'second' }], recoveryOptions(
  [{ ...remote, filename: 'legacy-generated.txt', size: 8 }], async source => { calls.push(source); return data('original'); }));
 assert.equal(result.uploads.length, 0); assert.equal(result.reused.length, 1);
 assert.equal(result.reused[0].hash, (await reuse.digest(data('original'))).hash);
 assert.equal(result.reused[0].originals.length, 2);
 assert.deepEqual(calls.map(source => [source.issueUrl, source.id]), [[issueUrl, '7']]);
});
test('a saved attachment ID without a hash is verified before reuse', async () => {
 const original = await asset(); original.source.hash = ''; let calls = 0;
 const result = await reuse.plan([original], { ...options(), loadSource: async () => { calls++; return data('original'); } });
 assert.equal(result.uploads.length, 0); assert.equal(result.reused[0].id, '7'); assert.equal(calls, 1);
});
test('same filename and size with different bytes must upload while identical bytes with another ID are reused', async () => {
 const original = await asset('original', false); const calls = [];
 const inventory = [{ ...remote, size: 8 }, { ...remote, id: '8', size: 8 }, { ...remote, id: '9', size: 100 }];
 const result = await reuse.plan([original], recoveryOptions(inventory, async source => {
  calls.push(source.id); return data(source.id === '8' ? 'original' : 'modified');
 }));
 assert.deepEqual(calls, ['7', '8']); assert.equal(result.uploads.length, 0);
 assert.equal(result.reused[0].id, '8'); assert.equal(result.reused[0].exactUrl, true);
 const changed = await reuse.plan([original], recoveryOptions([inventory[0]], async () => data('modified')));
 assert.equal(changed.reused.length, 0); assert.equal(changed.uploads[0].name, 'Screenshot 2 (2).txt');
});
test('recovery compares all equal-sized candidates but skips different sizes', async () => {
 const original = await asset('original', false); const calls = [];
 const result = await reuse.plan([original], recoveryOptions([{ ...remote, size: 12 }, { ...remote, id: '8', filename: 'other.txt', size: 8 }],
  async source => { calls.push(source.id); return data('original'); }));
 assert.deepEqual(calls, ['8']); assert.equal(result.reused[0].id, '8');
});
test('recovery fails closed on download failure and cancellation', async () => {
 const original = await asset('original', false);
 await assert.rejects(reuse.plan([original], recoveryOptions([remote], async () => { throw Error('HTTP 403'); })), /HTTP 403/);
 const controller = new AbortController();
 await assert.rejects(reuse.plan([original], { ...recoveryOptions([remote], async () => { controller.abort(); return data('original'); }), signal: controller.signal }), { name: 'AbortError' });
});
test('missing or edited source metadata does not bind to a coincident ID from another task without comparing bytes', async () => {
 const original = await asset(); original.source.issueUrl = 'https://other.example/browse/QA-1'; let calls = 0;
 const result = await reuse.plan([original], recoveryOptions([remote], async source => {
  assert.equal(source.issueUrl, issueUrl); calls++; return data('modified');
 }));
 assert.equal(calls, 1); assert.equal(result.reused.length, 0); assert.equal(result.uploads.length, 1);
});
