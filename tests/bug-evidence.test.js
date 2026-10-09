"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createService}=require('../jira-issues'), Bugs=require('../bug-report');
function fixture(t,cloud=true,attachments=[{id:'42',filename:'лог.txt',content:'https://jira.example.test/jira/secure/attachment/42/log[1]|test.txt'}],fieldId='description'){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-bug-evidence-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const connection={baseUrl:'https://jira.example.test/jira',type:cloud?'cloud':'server'},operationId=crypto.randomUUID();
 const description={fieldId,name:'Описание',schema:{type:'string',...(fieldId==='description'?{}:{custom:'com.atlassian.jira.plugin.system.customfieldtypes:textarea'})}},summary={fieldId:'summary',name:'Тема',required:true,schema:{type:'string'}};
 let current=cloud?Bugs.textDocument('Текст пользователя'): 'Текст пользователя', puts=0, loseResponse=false;
 const execute=createService({directory,configuredJira:()=>connection,jiraFetch:async(_,route,options={})=>{
  if(route.includes('/issuetypes/1?'))return {values:[summary,description],isLast:true};
  if(route.includes('/issuetypes?'))return {values:[{id:'1',name:'Ошибка',subtask:false}],isLast:true};
  if(options.method==='POST')return {key:'APP-1'};
  if(route.endsWith('/editmeta'))return {fields:{[fieldId]:description}};
  if(route.includes('?fields=attachment'))return {fields:{[fieldId]:current,attachment:attachments}};
  if(options.method==='PUT'){ puts++;current=JSON.parse(options.body).fields[fieldId];if(loseResponse)throw Error('connection lost');return {};}
  throw Error('Unexpected fixture route');
 }});
 return {execute,operationId,get current(){return current},set current(v){current=v},get puts(){return puts},set loseResponse(v){loseResponse=v}};
}
for(const cloud of [true,false])test(`evidence preserves existing ${cloud?'Cloud ADF':'Server wiki'} content and links confirmed attachments once`,async t=>{
 const f=fixture(t,cloud);await f.execute({},'create-issue',{operationId:f.operationId,mode:'standalone',projectKey:'APP',issueTypeId:'1',fields:{summary:'Баг'}});
 const payload={operationId:f.operationId,issueKey:'APP-1',fieldId:'description',attachmentIds:['42']};
 f.loseResponse=true;await assert.rejects(f.execute({},'issue-evidence',payload),/connection lost/);f.loseResponse=false;
 const result=await f.execute({},'issue-evidence',payload);assert.equal(result.linked,1);assert.equal(f.puts,1);
 const text=JSON.stringify(f.current);assert(text.includes('Текст пользователя'));assert(text.includes('Материалы'));assert(text.includes('лог.txt'));
 if(cloud){assert(text.includes('/attachment/42/'));assert.equal(f.current.content.at(-1).content[0].marks[0].type,'link');}else assert(f.current.includes('[^лог.txt]'));
 await assert.rejects(f.execute({},'issue-evidence',{...payload,issueKey:'OTHER-9'}),e=>e.status===403);
 await assert.rejects(f.execute({},'issue-evidence',{...payload,attachmentIds:['99']}),e=>e.status===404);
 await assert.rejects(f.execute({},'issue-evidence',{...payload,fieldId:'summary'}),e=>e.status===422);
 assert.equal(f.puts,1);
});
test('Server evidence embeds image thumbnails and links files using their confirmed uploaded names',async t=>{
 const attachments=[
  {id:'42',filename:'registration-name256-submit.png',mimeType:'image/png'},
  {id:'43',filename:'name256-request.json',mimeType:'application/json'},
  {id:'44',filename:'name256-response.html',mimeType:'text/html'},
  {id:'45',filename:'Скриншот 2.JPG',mimeType:'application/octet-stream'},
  {id:'46',filename:'not-an-image.png',mimeType:'text/plain'},
 ];
 const f=fixture(t,false,attachments,'customfield_10002');await f.execute({},'create-issue',{operationId:f.operationId,mode:'standalone',projectKey:'APP',issueTypeId:'1',fields:{summary:'Баг'}});
 const payload={operationId:f.operationId,issueKey:'APP-1',fieldId:'customfield_10002',attachmentIds:attachments.map(a=>a.id)};
 f.loseResponse=true;await assert.rejects(f.execute({},'issue-evidence',payload),/connection lost/);f.loseResponse=false;
 assert.equal(f.current,'Текст пользователя\n\nМатериалы\n!registration-name256-submit.png|thumbnail!\n[^name256-request.json]\n[^name256-response.html]\n!Скриншот 2.JPG|thumbnail!\n[^not-an-image.png]');
 assert.equal((await f.execute({},'issue-evidence',payload)).linked,5);assert.equal(f.puts,1);
});
test('Server evidence corrects old generated links on retry without duplicating materials or changing other text',async t=>{
 const attachments=[{id:'42',filename:'shot.png',mimeType:'image/png',content:'https://jira.example.test/jira/secure/attachment/42/shot.png'},
  {id:'43',filename:'log.json',mimeType:'application/json',content:'https://jira.example.test/jira/secure/attachment/43/log.json'}];
 const f=fixture(t,false,attachments);await f.execute({},'create-issue',{operationId:f.operationId,mode:'standalone',projectKey:'APP',issueTypeId:'1',fields:{summary:'Баг'}});
 const before='Текст пользователя\n[Документация|https://example.test/docs]\n\nМатериалы\n'+attachments.map(a=>`[${a.filename}|${a.content}]`).join('\n');f.current=before;
 const payload={operationId:f.operationId,issueKey:'APP-1',fieldId:'description',attachmentIds:['42','43']};
 await f.execute({},'issue-evidence',payload);
 assert.equal(f.current,'Текст пользователя\n[Документация|https://example.test/docs]\n\nМатериалы\n!shot.png|thumbnail!\n[^log.json]');
 await f.execute({},'issue-evidence',payload);assert.equal(f.puts,1);
});
test('Server evidence retains exact URLs for ambiguous filenames and names containing wiki delimiters',async t=>{
 const attachments=[{id:'42',filename:'shot.png',mimeType:'image/png'},
  {id:'43',filename:'shot.png',mimeType:'image/png'},
  {id:'44',filename:'log[1]|test.txt',mimeType:'text/plain',content:'https://jira.example.test/jira/secure/attachment/44/log[1]|test.txt'}];
 const f=fixture(t,false,attachments);await f.execute({},'create-issue',{operationId:f.operationId,mode:'standalone',projectKey:'APP',issueTypeId:'1',fields:{summary:'Баг'}});
 const payload={operationId:f.operationId,issueKey:'APP-1',fieldId:'description',attachmentIds:attachments.map(a=>a.id)};
 await f.execute({},'issue-evidence',payload);
 assert(f.current.includes('/attachment/42/shot.png]'));assert(f.current.includes('/attachment/43/shot.png]'));
 assert(f.current.includes('/attachment/44/log%5B1%5D%7Ctest.txt]'));assert(!f.current.includes('!shot.png|thumbnail!'));
 assert(!f.current.includes('[^log[1]|test.txt]'));
 await f.execute({},'issue-evidence',payload);assert.equal(f.puts,1);
});
test('unconfirmed operations cannot edit Jira fields',async t=>{
 const f=fixture(t);await assert.rejects(f.execute({},'issue-evidence',{operationId:f.operationId,issueKey:'APP-1',fieldId:'description',attachmentIds:['42']}),e=>e.status===403);assert.equal(f.puts,0);
 assert(Bugs.DEFAULT_PROMPT.includes('«Открыть», «Нажать», «Ввести»'));assert(Bugs.LEGACY_DEFAULT_PROMPT.includes('в повелительном наклонении'));
});
for(const cloud of [true,false])test(`inline placements preserve position and formatting in ${cloud?'Cloud':'Server'}, including lost-response retry`,async t=>{
 const attachments=[{id:'42',filename:'renamed.png',mimeType:'image/png',content:'https://jira.example.test/jira/secure/attachment/42/renamed.png'},{id:'43',filename:'log.txt',mimeType:'text/plain'}];
 const f=fixture(t,cloud,attachments);await f.execute({},'create-issue',{operationId:f.operationId,mode:'standalone',projectKey:'APP',issueTypeId:'1',fields:{summary:'Баг'}});
 const text='*До*\n[Вложение: original_name.png]\nПосле';f.current=cloud?Bugs.textDocument(text):text;
 const payload={operationId:f.operationId,issueKey:'APP-1',fieldId:'description',attachmentIds:['42','43'],placements:[{attachmentId:'42',placeholder:'[Вложение: original_name.png]'}]};
 f.loseResponse=true;await assert.rejects(f.execute({},'issue-evidence',payload),/connection lost/);f.loseResponse=false;
 await f.execute({},'issue-evidence',payload);assert.equal(f.puts,1);
 if(cloud){assert.equal(f.current.content[0].content[0].marks[0].type,'strong');assert.equal(f.current.content[1].content[0].text,'renamed.png');assert.equal(f.current.content[1].content[0].marks[0].attrs.href,attachments[0].content);assert.equal(f.current.content[2].content[0].text,'После');}
 else assert.equal(f.current,'*До*\n!renamed.png|thumbnail!\nПосле\n\nМатериалы\n[^log.txt]');
 const serialized=JSON.stringify(f.current);assert(!serialized.includes('Вложение:'));assert(serialized.includes('log.txt'));
 await assert.rejects(f.execute({},'issue-evidence',{...payload,placements:[{attachmentId:'99',placeholder:'[Вложение: foreign]'}]}),/места вставки/);assert.equal(f.puts,1);
});
test('placement validation rejects arbitrary replacement strings, duplicate markers and unknown attachments',()=>{
 for(const placements of [[{attachmentId:'42',placeholder:'Текст пользователя'}],[{attachmentId:'42',placeholder:'[Вложение: x]'}, {attachmentId:'42',placeholder:'[Вложение: x]'}],[{attachmentId:'43',placeholder:'[Вложение: x]'}]])assert.throws(()=>Bugs.attachmentPlacements(placements,['42']),/места вставки/);
 assert.deepEqual(Bugs.attachmentPlacements(undefined,['42']),[]);
});
