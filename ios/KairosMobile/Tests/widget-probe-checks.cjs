const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const execute = new AsyncFunction('location', 'expectedOrigin', 'expectedAccount', 'fetch', fs.readFileSync(path.join(__dirname, '../App/WidgetProbe.js'), 'utf8'));
const origin = 'https://kairos.example';
const choices = [{id:'claude',name:'Claude',kind:'claude_cli',api_key:'PRIVATE'}, {id:'claude2',name:'Claude fast',kind:'claude_cli'},
  {id:'api1',name:'API model',kind:'api'}, {id:'local',name:'Local model',kind:'local'}];
const quotas = {providers:[{provider:'claude',status:'ok',stale:false,windows:[{name:'5-hour',used_percent:42.5,resets_at:2000000000}]}]};
async function probe(overrides={}, account='david', actualOrigin=origin) {
  const calls=[];
  const routes={'/api/auth/status':{body:{username:'david',is_admin:true}}, '/api/models/choices':{body:choices}, '/api/models/quotas':{body:quotas}, '/api/models/usage':{body:{api1:{total_tokens:1234},local:{total_tokens:0}}},...overrides};
  const result=await execute({origin:actualOrigin}, origin, account, async (url, options)=>{
    calls.push(url); assert.equal(options.credentials,'same-origin'); assert.equal(options.redirect,'error'); assert.equal(options.cache,'no-store');
    const value=typeof routes[url]==='function'?routes[url](calls):routes[url]; assert.ok(value, url);
    const status=value.status||200; return {status,ok:status>=200&&status<300,json:async()=>value.body};
  });
  return {result:JSON.parse(result),calls};
}
let checks=0;
async function check(label, fn){await fn(); checks++; console.log('PASS '+label);}
(async()=>{
  await check('reported windows and resets, never credentials',async()=>{const {result}=await probe(); assert.equal(result.models[0].windows[0].usedPercent,42.5); assert.equal(result.models[0].windows[0].resetsAt,2000000000); assert.ok(!JSON.stringify(result).includes('PRIVATE'));});
  await check('same provider models share account allowances explicitly',async()=>{const {result}=await probe(); assert.deepEqual(result.models[0].windows,result.models[1].windows); assert.equal(result.models[0].scope,'Shared account allowance');});
  await check('API and local show recorded totals without quota percentages',async()=>{const {result}=await probe(); assert.deepEqual(result.models[2].windows,[]); assert.equal(result.models[2].totalTokens,1234); assert.equal(result.models[3].totalTokens,0);});
  await check('nonadmin never queries host quota data',async()=>{const {result,calls}=await probe({'/api/auth/status':{body:{username:'david',is_admin:false}}}); assert.deepEqual(result.models,[]); assert.deepEqual(calls,['/api/auth/status']);});
  await check('logout replaces readings with sign-in state',async()=>{const {result}=await probe({'/api/auth/status':{body:{}}}); assert.deepEqual(result.models,[]);});
  await check('account change blocks usage lookup',async()=>{const {calls,result}=await probe({},'different'); assert.deepEqual(calls,['/api/auth/status']); assert.deepEqual(result.models,[]);});
  await check('account change during fetch discards gathered readings',async()=>{let n=0; const {result}=await probe({'/api/auth/status':()=>({body:{username:++n===1?'david':'other',is_admin:true}})}); assert.deepEqual(result.models,[]);});
  await check('expired authorization clears snapshot',async()=>{const {result}=await probe({'/api/models/quotas':{status:403}}); assert.deepEqual(result.models,[]);});
  await check('unavailable and stale provider readings remain explicit',async()=>{const {result}=await probe({'/api/models/quotas':{body:{providers:[{provider:'claude',status:'stale',stale:true,windows:quotas.providers[0].windows}]}}}); assert.equal(result.models[0].stale,true);});
  await check('invalid percentages and IDs cannot manufacture usage',async()=>{const {result}=await probe({'/api/models/choices':{body:[...choices,{id:42},{id:'../secret'}]},'/api/models/quotas':{body:{providers:[{provider:'claude',status:'ok',windows:[{used_percent:-1},{used_percent:NaN},{used_percent:101},{used_percent:'44'}]}]}}}); assert.equal(result.models.length,4); assert.deepEqual(result.models[0].windows,[]);});
  await check('off-origin request rejected',async()=>{await assert.rejects(()=>probe({},'david','https://other.example'),/Wrong Kairos/);});
  await check('connection failure cannot replace last reading with invented success',async()=>{await assert.rejects(()=>probe({'/api/models/quotas':{status:503}}),/Usage unavailable/);});
  console.log(`${checks} widget usage projection checks passed.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
