const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { createPersonalMcpAccess } = require('../personal-mcp-access');
const { createLocalImportService } = require('../local-import-server');
const { connectMcp } = require('./helpers/qa-report-mcp-client.cjs');
const { buildSetup } = require('../shared-mcp-setup');
async function fixture(t) {
  const database = new DatabaseSync(':memory:'), imports = createLocalImportService(); let origin, time = Date.now();
  const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type':'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req, limit) => { let bytes = ''; for await (const chunk of req) { bytes += chunk; if (Buffer.byteLength(bytes) > limit) throw Object.assign(Error('large'), { status:413 }); } return JSON.parse(bytes || '{}'); };
  const mcp = createPersonalMcpAccess({ getDb:()=>database, readJson, sendJson, requestOrigin:()=>origin, localImportService:imports, now:()=>time,
    authenticateOwner:async req=>req.headers['x-fixture-owner'], validateWrite:req=>{ if(req.headers.origin!==origin || req.headers['x-qa-personal-request']!=='1') throw Object.assign(Error('CSRF'),{status:403}); } });
  const server = http.createServer(async(req,res)=>{ try {
    const path = new URL(req.url,origin).pathname;
    if(await mcp.machine(req,res,path) || await mcp.browser(req,res,path)) return;
    if(await imports.producer(req,res,origin)) return;
    if(await imports.browser(req,res,{ owner:'browser:'+req.headers['x-fixture-owner'], accountOwner:req.headers['x-fixture-owner'], origin })) return;
    sendJson(res,404,{});
  } catch(error) { sendJson(res,error.status||500,{error:error.message}); } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{imports.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));database.close();});
  async function call(path,{method='GET',body,owner='a',token,headers={}}={}) {
    const response=await fetch(origin+path,{method,headers:{Origin:origin,'X-Fixture-Owner':owner,'X-QA-Personal-Request':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  const issue=async(readOnly=false,lifetimeDays=30)=>{const value=await call('/api/mcp/personal-tokens',{method:'POST',body:{label:'My assistant',lifetimeDays,readOnly}});assert.equal(value.status,201,JSON.stringify(value));return value.body;};
  return {database,imports,call,issue,origin,advance:ms=>{time+=ms;},expire:()=>{time+=31*86400000;}};
}
const text=value=>{assert.notEqual(value.result?.isError,true,JSON.stringify(value));return JSON.parse(value.result.content[0].text);};
test('personal tokens enforce login, CSRF, three active keys, owner-only revocation, expiry and secret hashing',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/mcp/personal-tokens',{owner:''})).status,401);
  assert.equal((await f.call('/api/mcp/personal-tokens',{method:'POST',body:{},headers:{'X-QA-Personal-Request':''}})).status,403);
  assert.equal((await f.call('/api/mcp/personal-tokens',{token:'a'.repeat(43),owner:''})).status,401);
  const a=await f.issue(), b=await f.issue(true,90), c=await f.issue(false,null);
  assert.equal(c.key.expiresAt,null);assert.equal(a.key.expiresAt-a.key.createdAt,30*86400000);
  assert.equal(JSON.stringify((await f.call('/api/mcp/personal-tokens')).body).includes(a.connection.token),false);
  assert.equal(JSON.stringify(f.database.prepare('SELECT * FROM personal_mcp_tokens').all()).includes(a.connection.token),false);
  assert.equal((await f.call('/api/mcp/personal-tokens',{method:'POST',body:{label:'fourth',lifetimeDays:30,readOnly:false}})).status,429);
  assert.equal((await f.call('/api/mcp/personal-tokens/'+a.key.id,{method:'DELETE',owner:'b'})).status,404);
  await f.call('/api/mcp/personal-tokens/'+a.key.id,{method:'DELETE'});
  assert.equal((await f.call('/api/mcp/personal/reports',{token:a.connection.token})).status,401);
  const d=await f.issue();f.expire();assert.equal((await f.call('/api/mcp/personal/reports',{token:d.connection.token})).status,401);
  assert.equal((await f.call('/api/mcp/personal/reports',{token:c.connection.token})).status,200);
});
test('one personal MCP searches only its account and fills an explicitly selected browser report, with stale-hash protocol and revocation guarding queued writes',async t=>{
  const f=await fixture(t), key=await f.issue(), foreign=await f.call('/api/mcp/personal-workspaces',{method:'POST',owner:'b',body:{catalog:[{id:'other',publicId:'bbbbbbb',title:'QA-123'}]}});
  const item={id:'report_a',publicId:'aaaaaaa',title:'Payment',issueKey:'QA-123',issueUrl:'https://tasks.example.test/desk/Task/QA-123'};
  const w=(await f.call('/api/mcp/personal-workspaces',{method:'POST',body:{catalog:[item]}})).body;
  const session=(await f.call('/api/local-import/sessions',{method:'POST',body:{reportId:item.id,context:{sections:[]},personalMcp:true},headers:{'X-QA-Import-Request':'1'}})).body;
  const client=await connectMcp({QA_REPORT_PERSONAL_URL:key.connection.url,QA_REPORT_PERSONAL_TOKEN:key.connection.token});t.after(()=>client.close());
  const reports=text(await client.call('qa_report_list_reports',{query:'QA-123'})).reports;
  assert.equal(reports.length,1);assert.equal(reports[0].browserId,w.id);assert.equal(reports[0].url,f.origin+'/report/aaaaaaa');
  const reading=client.call('qa_report_get_context',{reportUrl:reports[0].url});
  let command;
  for(let i=0;i<20;i++){command=(await f.call('/api/mcp/personal-workspaces/'+w.id,{method:'POST',body:{catalog:[item]}})).body.commands[0];if(command)break;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.ok(command);
  assert.equal((await f.call('/api/mcp/personal-workspaces/'+w.id+'/ack',{method:'POST',body:{commandId:command.id,sessionId:session.id}})).status,200);
  assert.equal(text(await reading).reportId,item.id);
  assert.equal((await f.call(new URL(session.connection.url).pathname+"/context",{headers:{"X-QA-Import-Token":session.connection.token}})).status,403);
  const saved=text(await client.call('qa_report_update_metadata',{reportUrl:reports[0].url,operationId:'op',metadata:{environment:{value:'STAGE',expectedHash:'a'.repeat(64)}}}));assert.equal(saved.status,'pending');
  // A different account cannot impersonate the consumer even with its reader secret.
  assert.equal((await f.call('/api/local-import/sessions/'+session.id+'/next',{owner:'b',headers:{'X-QA-Import-Request':'1','X-QA-Import-Reader':session.consumerToken}})).status,404);
  const streamKey=await f.issue();
  const streamBody=JSON.stringify({id:'race',kind:'metadata',metadata:{environment:{value:'PROD',expectedHash:'a'.repeat(64)}}});
  let stream;
  const streaming=new Promise(resolve=>{
    stream=http.request(f.origin+'/api/mcp/personal/report/batches',{method:'POST',headers:{Authorization:'Bearer '+streamKey.connection.token,'X-QA-Report-Url':reports[0].url,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    stream.write(streamBody.slice(0,20));
  });
  await new Promise(resolve=>setTimeout(resolve,40));
  await f.call('/api/mcp/personal-tokens/'+streamKey.key.id,{method:'DELETE'});stream.end(streamBody.slice(20));
  assert.equal(await streaming,401);
  await f.call('/api/mcp/personal-tokens/'+key.key.id,{method:'DELETE'});
  assert.equal((await f.call('/api/local-import/sessions/'+session.id+'/next',{headers:{'X-QA-Import-Request':'1','X-QA-Import-Reader':session.consumerToken}})).status,401);
  assert.equal((await f.call('/api/mcp/personal-workspaces/'+foreign.body.id,{method:'POST',body:{catalog:[]}})).status,404);
});
test('personal read-only permissions, published ownership, route restrictions and stable setup are enforced',async t=>{
  const f=await fixture(t), key=await f.issue(true);
  const snap=JSON.stringify({title:'EVA QA-8',issueUrl:'https://tasks.example.test/project/Task/QA-8',sections:[]});
  for(const [id,owner] of [['a'.repeat(32),'a'],['b'.repeat(32),'b']]) f.database.prepare('INSERT INTO shared_publications (id,payload_digest,snapshot_json,manifest_json,read_hash,reply_hash,owner_hash,created_at,published_at,author_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,'d',snap,'[]','r','p','o','now','now',owner);
  const list=(await f.call('/api/mcp/personal/reports?query=QA-8',{token:key.connection.token})).body;assert.equal(list.reports.length,1);
  const headers={'X-QA-Report-Url':f.origin+'/shared-report/'+'a'.repeat(32)};
  assert.equal((await f.call('/api/mcp/personal/report/context',{token:key.connection.token,headers})).body.writable,false);
  assert.equal((await f.call('/api/mcp/personal/report/batches',{method:'POST',token:key.connection.token,headers,body:{}})).status,403);
  assert.equal((await f.call('/api/mcp/personal/report/context',{token:key.connection.token,headers:{'X-QA-Report-Url':f.origin+'/shared-report/'+'b'.repeat(32)}})).status,404);
  assert.equal((await f.call('/api/mcp/personal/report/context',{token:key.connection.token,headers:{'X-QA-Report-Url':'https://attacker.test/report/aaaaaaa'}})).status,400);
  assert.equal((await f.call('/api/mcp/personal/settings',{token:key.connection.token})).status,404);
  const setup=JSON.parse(buildSetup({personal:key.connection,packageUrl:f.origin+'/downloads/qa-report-mcp.tgz?v='+'f'.repeat(64),client:'json',readOnly:true}).code);
  const conf=Object.values(setup.mcpServers)[0];assert.equal(conf.env.QA_REPORT_PERSONAL_TOKEN,key.connection.token);assert.ok(conf.args.includes(f.origin+'/downloads/qa-report-mcp.tgz'));
});

test('workspace disconnection and heartbeat expiry remove local discovery; duplicate browser copies require explicit selection',async t=>{
  const f=await fixture(t), key=await f.issue(false,null), item={id:'local',publicId:'abcdef1',title:'APP-12'};
  const create=()=>f.call('/api/mcp/personal-workspaces',{method:'POST',body:{catalog:[item]}});
  const a=(await create()).body,b=(await create()).body;
  assert.equal((await f.call('/api/mcp/personal/reports',{token:key.connection.token})).body.reports.length,2);
  assert.equal((await f.call('/api/mcp/personal/report/context',{token:key.connection.token,headers:{'X-QA-Report-Url':f.origin+'/report/abcdef1'}})).status,409);
  await f.call('/api/mcp/personal-workspaces/'+b.id,{method:'DELETE'});
  assert.equal((await f.call('/api/mcp/personal/reports',{token:key.connection.token})).body.reports.length,1);
  f.advance(30001);
  assert.equal((await f.call('/api/mcp/personal/reports',{token:key.connection.token})).body.reports.length,0);
  assert.equal((await f.call('/api/mcp/personal-workspaces/'+a.id,{method:'POST',body:{catalog:[]}})).status,404);
});

test('authenticated temporary reception retains its three-report limit separately from personal sessions',async t=>{
  const f=await fixture(t), create=(id,personalMcp)=>f.call('/api/local-import/sessions',{method:'POST',body:{reportId:id,context:{sections:[]},personalMcp},headers:{'X-QA-Import-Request':'1','X-QA-Import-Manager':'f'.repeat(64)}});
  for(const id of ['first','second','third']) assert.equal((await create(id,false)).status,201);
  assert.equal((await create('fourth',false)).status,429);
  assert.equal((await create('personal',true)).status,201);
  const recovered=await f.call('/api/local-import/sessions',{headers:{'X-QA-Import-Request':'1','X-QA-Import-Manager':'f'.repeat(64)}});
  assert.equal(recovered.body.sessions.length,3);assert.equal(recovered.body.sessions.some(item=>item.reportId==='personal'),false);
});
