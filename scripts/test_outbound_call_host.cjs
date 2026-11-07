// The live panel for a bot phoning someone else (static/js/outboundCallHost.js). Run: node scripts/test_outbound_call_host.cjs
//   - a call being dialled or held shows one panel with who is called, the transcript as it grows, and Hang up
//   - a question from the bot shows an answer box; Send posts the answer once and the box goes when it is answered
//   - Hang up reaches the server; an ended call shows its summary and closes when it leaves the list; Close keeps it closed
//   - a desktop notification marks a new question only when the window is not in front
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = file => import(pathToFileURL(path.join(__dirname, '..', 'static', file)).href);
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = '';
    this.dataset = {}; this.parent = null; this.hidden = false; this.value = ''; this.disabled = false; this.scrollTop = 0; this.scrollHeight = 0; }
  setAttribute(key, value) { this.attrs[key] = value; }
  append(...kids) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } }
  appendChild(kid) { this.append(kid); return kid; }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(kid => kid !== this); this.parent = null; }
  click() { return this.listeners.click?.(); }
  focus() {}
  querySelector(selector) { return this.find(selector.replace(/^\./, '')); }
  find(cls) { for (const kid of this.children) { if ((kid.className || '').split(' ').includes(cls)) return kid; const hit = kid.find(cls); if (hit) return hit; } return null; }
  findAll(cls, found = []) { for (const kid of this.children) { if ((kid.className || '').split(' ').includes(cls)) found.push(kid); kid.findAll(cls, found); } return found; }
  text() { return [this.textContent, ...this.children.map(kid => kid.text())].join(' '); }
}
const fakeDocument = (focused = true) => {
  const body = new Node_('body');
  return { body, createElement: tag => new Node_(tag), hasFocus: () => focused, querySelector: selector => body.querySelector(selector) };
};
const call = (extra = {}) => ({ id: 'c'.repeat(32), bot_name: 'Kip', who: "Luigi's", to: '+12125550123', topic: 'A dinner reservation',
  status: 'live', transcript: [{ who: 'bot', text: 'Hi, this is Kip, an AI assistant calling on behalf of David.' }], questions: [], ...extra });
const panels = doc => doc.body.findAll('outcall-panel');
const noTimers = { setTimer: () => 0, clearTimer: () => {} };

(async () => {
  global.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  const M = await load('js/outboundCallHost.js');

  await check('a live call shows one panel with who, the transcript as it grows, and Hang up', async () => {
    const doc = fakeDocument();
    let current = call();
    const host = M.createOutboundCallHost({ document: doc, api: async () => ({ calls: [current] }), Notification: null, ...noTimers });
    host.start(); await host.poll();
    assert.equal(panels(doc).length, 1);
    const panel = panels(doc)[0];
    assert.match(panel.text(), /Kip is calling Luigi's/);
    assert.match(panel.text(), /On the call/);
    assert.match(panel.text(), /an AI assistant calling on behalf of David/);
    assert.equal(panel.find('outcall-hangup').hidden, false);
    current = call({ transcript: [...current.transcript, { who: 'them', text: "Luigi's, how can I help?" }] });
    await host.poll();
    assert.equal(panel.findAll('outcall-line').length, 2, 'new lines are added, old ones kept');
    assert.match(panel.findAll('outcall-line')[1].text(), /Luigi's.*how can I help/);
    host.stop();
  });

  await check('a question shows an answer box, Send posts it once, and the box goes when answered', async () => {
    const doc = fakeDocument(), posted = [];
    const question = { id: 'q1', text: 'They only have 8:30. Is that okay?', status: 'waiting' };
    let current = call({ questions: [question] });
    const api = async (url, options = {}) => {
      if (options.method === 'POST') {
        posted.push([url, JSON.parse(options.body)]);
        current = call({ questions: [{ ...question, status: 'answered', answer: 'Yes' }], transcript: [...current.transcript, { who: 'you', text: 'Yes' }] });
        return current;
      }
      return { calls: [current] };
    };
    const host = M.createOutboundCallHost({ document: doc, api, Notification: null, ...noTimers });
    host.start(); await host.poll();
    const panel = panels(doc)[0];
    const box = panel.find('outcall-question');
    assert.match(box.text(), /8:30\. Is that okay\?/);
    box.find('outcall-answer-input').value = 'Yes';
    await box.find('outcall-answer-send').click();
    assert.deepEqual(posted, [[`/api/phone/outbound/${'c'.repeat(32)}/answer`, { question_id: 'q1', answer: 'Yes' }]]);
    assert.equal(panel.find('outcall-question'), null, 'the answered question leaves the panel');
    assert.match(panel.text(), /You Yes/);
    host.stop();
  });

  await check('Hang up reaches the server; an ended call shows its summary, then leaves; Close keeps it closed', async () => {
    const doc = fakeDocument(), posted = [];
    let list = [call()];
    const api = async (url, options = {}) => {
      if (options.method === 'POST') { posted.push(url); return call({ status: 'ended', summary_state: 'pending' }); }
      return { calls: list };
    };
    const host = M.createOutboundCallHost({ document: doc, api, Notification: null, ...noTimers });
    host.start(); await host.poll();
    await panels(doc)[0].find('outcall-hangup').click();
    assert.deepEqual(posted, [`/api/phone/outbound/${'c'.repeat(32)}/hangup`]);
    assert.match(panels(doc)[0].text(), /Writing the summary/);
    list = [call({ status: 'ended', summary_state: 'saved', summary: 'Booked for Friday at 8:30.' })];
    await host.poll();
    assert.match(panels(doc)[0].text(), /Booked for Friday at 8:30\./);
    assert.match(panels(doc)[0].text(), /Kip called Luigi's/);
    assert.equal(panels(doc)[0].find('outcall-hangup').hidden, true);
    list = [];
    await host.poll();
    assert.equal(panels(doc).length, 0);
    list = [call({ id: 'd'.repeat(32) })];
    await host.poll();
    panels(doc)[0].find('outcall-close').click();
    await host.poll();
    assert.equal(panels(doc).length, 0, 'a closed panel stays closed');
    host.stop();
  });

  await check('a new question notifies only when the window is not in front, once', async () => {
    const shown = [];
    class Note { constructor(title, options) { shown.push([title, options.body]); } }
    Note.permission = 'granted';
    const question = { id: 'q9', text: 'Is a booth okay?', status: 'waiting' };
    const back = fakeDocument(false);
    const host = M.createOutboundCallHost({ document: back, api: async () => ({ calls: [call({ questions: [question] })] }), Notification: Note, ...noTimers });
    host.start(); await host.poll(); await host.poll();
    assert.deepEqual(shown, [['Kip asks you', 'Is a booth okay?']]);
    host.stop();
    const front = fakeDocument(true);
    const host2 = M.createOutboundCallHost({ document: front, api: async () => ({ calls: [call({ questions: [{ ...question, id: 'q10' }] })] }), Notification: Note, ...noTimers });
    host2.start(); await host2.poll();
    assert.equal(shown.length, 1);
    host2.stop();
  });

  await check('labels name each speaker plainly', async () => {
    const c = call();
    assert.equal(M.speakerLabel({ who: 'them' }, c), "Luigi's");
    assert.equal(M.speakerLabel({ who: 'question' }, c), 'Kip asks you');
    assert.equal(M.speakerLabel({ who: 'you' }, c), 'You');
  });

  console.log(`outbound call host: ${passed.length} passed`);
  passed.forEach(name => console.log('  ok ' + name));
})().catch(error => { console.error(error); process.exit(1); });
