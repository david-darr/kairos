const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = fs.readFileSync(path.join(__dirname, '../App/ActivityProbe.js'), 'utf8');
const execute = new AsyncFunction('location', 'expectedOrigin', 'selectedID', 'fetch', body);
const origin = 'https://preview.example:8433';
const row = {id:'run_123', session_id:'session_123', state:'running', started_at:1234,
    revision:2, permissions:[], title:'PRIVATE TITLE', text:'PRIVATE RESPONSE', tool_steps:['PRIVATE COMMAND']};
let checks = 0;
async function probe(routes, selectedID = '', locationOrigin = origin) {
    const calls = [];
    const result = await execute({origin:locationOrigin}, origin, selectedID, async (url, options) => {
        calls.push(url);
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.redirect, 'error');
        const response = routes[url];
        assert.ok(response, 'Unexpected request: ' + url);
        const status = response.status || 200;
        return {status, ok:status >= 200 && status < 300, json:async () => response.body};
    });
    return {result:JSON.parse(result), calls};
}
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
(async () => {
    await check('foreground snapshot omits all private content', async () => {
        const {result} = await probe({'/api/auth/status':{body:{username:'david'}}, '/api/chat/runs?active=true':{body:[row]}});
        assert.equal(result.account,'david');
        assert.deepEqual(result.runs[0], {id:row.id, sessionID:row.session_id, state:'running', startedAt:1234, revision:2});
        assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    });
    await check('permission reflects currently pending requests', async () => {
        const {result} = await probe({'/api/auth/status':{body:{username:'david'}},
            '/api/chat/runs?active=true':{body:[{...row, permissions:[{id:'private_permission', arguments:'secret'}]}]}});
        assert.equal(result.runs[0].state,'awaiting_permission');
        assert.ok(!JSON.stringify(result).includes('private_permission'));
    });
    await check('resolved permission falls back to working', async () => {
        const {result} = await probe({'/api/auth/status':{body:{username:'david'}},
            '/api/chat/runs?active=true':{body:[{...row, state:'awaiting_permission', permissions:[]}]}});
        assert.equal(result.runs[0].state,'running');
    });
    for (const state of ['completed','failed','interrupted','stopped']) {
        await check('selected run recovers ' + state + ' after it leaves active list', async () => {
            const {result} = await probe({'/api/auth/status':{body:{username:'david'}},
                '/api/chat/runs?active=true':{body:[]}, '/api/chat/runs/run_123':{body:{...row, state, permissions:[{}]}}},'run_123');
            assert.equal(result.selected.state,state);
        });
    }
    await check('logout performs no run lookup', async () => {
        const {result, calls} = await probe({'/api/auth/status':{body:{username:null}}},'run_123');
        assert.equal(result.signedIn,false);
        assert.deepEqual(calls,['/api/auth/status']);
    });
    await check('expired session during run lookup clears status', async () => {
        const {result} = await probe({'/api/auth/status':{body:{username:'david'}}, '/api/chat/runs?active=true':{status:401}});
        assert.equal(result.signedIn,false);
    });
    await check('inaccessible run is missing, never completion', async () => {
        const {result} = await probe({'/api/auth/status':{body:{username:'david'}},
            '/api/chat/runs?active=true':{body:[]}, '/api/chat/runs/run_123':{status:404}}, 'run_123');
        assert.equal(result.missing,true);
        assert.equal(result.selected,null);
    });
    await check('untrusted IDs and unknown states are discarded', async () => {
        const {result} = await probe({'/api/auth/status':{body:{username:'david'}}, '/api/chat/runs?active=true':{body:[
            {...row,id:'../secrets'}, {...row,state:'invented-progress'}, {...row,revision:-1}, {...row,session_id:'chat?approve=yes'}]}});
        assert.deepEqual(result.runs,[]);
    });
    await check('off-origin execution rejected before any request', async () => {
        await assert.rejects(() => probe({},'', 'https://other.example'),/configured Kairos/);
    });
    await check('server failures do not manufacture terminal status', async () => {
        await assert.rejects(() => probe({'/api/auth/status':{body:{username:'david'}}, '/api/chat/runs?active=true':{status:503}}), /connection failed/);
    });
    await check('malformed selected state cannot leave an apparently fresh activity', async () => {
        await assert.rejects(() => probe({'/api/auth/status':{body:{username:'david'}},
            '/api/chat/runs?active=true':{body:[]}, '/api/chat/runs/run_123':{body:{...row,state:'made-up'}}}, 'run_123'), /Invalid activity summary/);
    });
    console.log(`${checks} activity probe checks passed. Swift/device checks require macOS/Xcode.`);
})().catch(error => {console.error(error); process.exitCode = 1;});
