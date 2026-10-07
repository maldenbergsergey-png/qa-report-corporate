"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), os=require("node:os"), path=require("node:path"), http=require("node:http"), crypto=require("node:crypto"), {spawn}=require("node:child_process"), {createSessionToken}=require("../auth");
test("corporate HTTP routes preserve session/origin/CSRF gates and scope Connect keys to speech only", async t => {
  const root=path.resolve(__dirname,".."), temp=fs.mkdtempSync(path.join(os.tmpdir(),"corporate-dictation-http-")), secret=crypto.randomBytes(32).toString("hex");
  const listener=http.createServer(); await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${listener.address().port}`; await new Promise(resolve=>listener.close(resolve));
  const child=spawn(process.execPath,["server.js"],{cwd:root,env:{...process.env,PORT:new URL(origin).port,HOST:"127.0.0.1",NODE_ENV:"development",AUTH_SECRET:secret,AUTH_SECRET_FILE:"",REPORTS_DB_PATH:path.join(temp,"db.sqlite"),QA_REPORT_PUBLIC_URL:origin,QA_STORAGE_ACCESS_KEY:"",QA_STORAGE_SECRET_KEY:"",QA_STORAGE_ACCESS_KEY_FILE:"",QA_STORAGE_SECRET_KEY_FILE:""},stdio:["ignore","pipe","pipe"]});
  t.after(async()=>{child.kill();});
  await new Promise((resolve,reject)=>{child.stdout.on("data",chunk=>{if(chunk.includes("QA Report:"))resolve();});child.stderr.on("data",chunk=>fs.appendFileSync(path.join(temp,"server.log"),chunk));child.once("exit",code=>reject(Error(`Server exit ${code}`)));setTimeout(()=>reject(Error("Server timeout")),10000).unref();});
  async function request(url,{cookie,token,body,headers={}}={}) {return fetch(origin+url,{method:body?"POST":"GET",headers:{...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:token}:{}),...(body?{"Content-Type":"application/json"}:{}),...headers},body:body?JSON.stringify(body):undefined,redirect:"manual"});}
  async function session(email) {
    const response=await request("/api/auth/csrf"), {csrfToken}=await response.json();
    return {csrfToken,cookie:`query-port-session=${createSessionToken(email,{env:{AUTH_SECRET:secret}})}; ${response.headers.get("set-cookie").split(";")[0]}`};
  }
  const alice=await session("alice@example.test"), bob=await session("bob@example.test");
  assert.equal((await request("/api/agent/status",{headers:{"X-User-Email":"alice@example.test"}})).status,401);
  assert.equal((await request("/api/agent/pairings",{cookie:alice.cookie,body:{}})).status,403);
  assert.equal((await request("/api/agent/pairings",{cookie:alice.cookie,body:{csrfToken:alice.csrfToken},headers:{Origin:"https://foreign.example.test"}})).status,403);
  const policy=(await request("/",{cookie:alice.cookie})).headers.get("permissions-policy"); assert.match(policy,/microphone=\(self\)/);assert.match(policy,/camera=\(\)/);
  async function pair(identity) {
    const response=await request("/api/agent/pairings",{cookie:identity.cookie,body:{csrfToken:identity.csrfToken}});assert.equal(response.status,201);
    const {code}=await response.json(); const device=await request("/api/agent/pair",{body:{code,name:"Synthetic Connect"}});assert.equal(device.status,201);
    const value=await device.json();return `Bearer ${value.deviceId}.${value.secret}`;
  }
  const token=await pair(alice), other=await pair(bob);
  assert.equal((await request("/api/reports",{token})).status,401);
  assert.equal((await request("/api/ai/refine",{token,body:{text:"Текст",selection:"settings"}})).status,401);
  const queued=await request("/api/ai/refine",{cookie:alice.cookie,body:{csrfToken:alice.csrfToken,text:"Текст",selection:"settings",profileId:"foreign"}});assert.equal(queued.status,202);
  const {jobId}=await queued.json();
  assert.equal((await request(`/api/agent/jobs/${jobId}`,{cookie:bob.cookie})).status,404);
  const polled=await request("/api/agent/poll",{token,body:{version:"0.6.14"}});const {job}=await polled.json();assert.equal(job.id,jobId);assert.equal(job.payload.profileId,undefined);
  assert.equal((await request(`/api/agent/jobs/${jobId}/result`,{token:other,body:{ok:true,result:{text:"Чужой ответ"}}})).status,404);
  assert.equal((await request(`/api/agent/jobs/${jobId}/result`,{token,body:{ok:true,result:{text:"Готово"}}})).status,200);
  const completed=await request(`/api/agent/jobs/${jobId}`,{cookie:alice.cookie});assert.equal((await completed.json()).job.result.text,"Готово");
});
