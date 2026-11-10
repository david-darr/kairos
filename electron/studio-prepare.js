// electron/studio-prepare.js — Prepare post's fill (vault: "Content Studio Team (Build Spec)", section 6,
// "Prepare post first"; D1 "both posting routes").
//
// The person pressed Open upload page in Studio > Content > Publishing. main.js fetched the fill plan for that
// approved post (routes/content_studio_routes.py, desktop only) and opened the platform's upload page in a Browse
// tab, on the person's own sign-in. This module fills what it can on that page, as the fields appear:
//   - the video file (and YouTube's thumbnail) through the DevTools protocol's DOM.setFileInputFiles, the one way a
//     page's file picker can be given a file without the person's dialog;
//   - the title, description or caption, by focusing the field, selecting what is there and inserting the text
//     (document.execCommand('insertText'), so the page's own editor sees ordinary input);
//   - the platform's AI-content label and YouTube's "not made for kids", by turning a switch, checkbox or radio on.
//
// What it never does, by design and by test (scripts/test_content_studio_publishing.py reads this file;
// scripts/browser-smoke.cjs runs it against local pages that mimic the three upload flows):
//   - it never presses Post, Publish, Share, Submit, Upload, Schedule or Next, or any button or link at all: the only
//     element it ever clicks is a switch, checkbox or radio that safeToggle() passed;
//   - it never submits a form, never sends a key press or a mouse event, never solves a CAPTCHA;
//   - it never types into a password field and never fills a sign-in page (Browse's own saved-password offer is the
//     person's, as on any page);
//   - it acts only while the tab is on the platform's own site; on any other page (a sign-in on another host) it waits.
// The person checks the page and presses the final button. Platform pages change: what it cannot find is reported
// back and stays on the person's checklist.

const PLATFORM_HOSTS = {
  youtube: ['youtube.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
};

// Where each field usually is (from general knowledge, 2026-11; not checked against the real pages). `label` is the
// fallback: a field whose accessible name matches it. `scope`: the field must sit inside an area whose text matches.
const FIELDS = {
  youtube: {
    file: { kind: 'file', selectors: ['input[type=file][name=Filedata]', 'ytcp-uploads-file-picker input[type=file]', 'input[type=file][accept*="video"]'] },
    title: { kind: 'text', selectors: ['#title-textarea #textbox', 'ytcp-social-suggestions-textbox#title-textarea [contenteditable=true]'], label: '^title\\b' },
    description: { kind: 'text', selectors: ['#description-textarea #textbox', 'ytcp-social-suggestions-textbox#description-textarea [contenteditable=true]'], label: '^(description|tell viewers about your video)' },
    tags: { kind: 'text', selectors: ['#tags-container input#text-input', 'ytcp-free-text-chip-bar input'], label: '^tags\\b' },
    thumbnail: { kind: 'file', selectors: ['input#file-loader', 'ytcp-thumbnails-compact-editor-uploader input[type=file]', 'input[type=file][accept*="image"]'] },
    made_for_kids: { kind: 'toggle', selectors: ['tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'], label: "^no,? it.?s not made for kids" },
    ai_label: { kind: 'toggle', selectors: ['tp-yt-paper-radio-button[name="VIDEO_HAS_ALTERED_CONTENT_YES"]'], label: '^yes$', scope: 'altered|synthetic' },  // just "Yes": never "Yes, it's made for kids"
  },
  tiktok: {
    file: { kind: 'file', selectors: ['input[type=file][accept*="video"]'] },
    caption: { kind: 'text', selectors: ['[data-e2e="caption_container"] [contenteditable=true]', '.public-DraftEditor-content[contenteditable=true]'], label: '^(caption|description)\\b' },
    ai_label: { kind: 'toggle', selectors: ['[data-e2e="aigc_container"] [role=switch]', '[data-e2e="aigc_container"] input[type=checkbox]'], label: '^ai.generated content', scope: 'ai.generated' },
  },
  instagram: {
    file: { kind: 'file', selectors: ['input[type=file][accept*="video"]', 'form[enctype="multipart/form-data"] input[type=file]'] },
    caption: { kind: 'text', selectors: ['div[aria-label="Write a caption..."][contenteditable=true]', 'textarea[aria-label="Write a caption..."]'], label: '^write a caption' },
    ai_label: { kind: 'toggle', selectors: [], label: '^add ai label', scope: 'ai label' },
  },
};

// Runs in an isolated world of the page (the page's own scripts cannot see or change it). Installs window.__kp.
const PAGE_SCRIPT = String.raw`(() => {
  if (window.__kp) return true;
  const FINAL = /\b(post|publish|share|submit|upload|schedule|next|done|save|send|continue|confirm|create|log ?in|sign ?in)\b/i;
  const TOGGLE_ROLES = new Set(['switch', 'checkbox', 'radio']);
  const docs = () => {
    const out = [document];
    for (let i = 0; i < out.length && out.length < 20; i++) {
      for (const frame of out[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument) out.push(frame.contentDocument); } catch (e) { /* another site's frame: never touched */ }
      }
    }
    return out;
  };
  const deepAll = (selector) => {
    const found = [];
    const walk = (root) => {
      try { found.push(...root.querySelectorAll(selector)); } catch (e) { return; }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    for (const d of docs()) walk(d);
    return found;
  };
  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    const parts = [];
    const add = (v) => { if (v && String(v).trim()) parts.push(String(v).trim()); };
    add(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) add(textOf(el.ownerDocument.getElementById(id)));
    add(el.getAttribute('placeholder'));
    add(el.getAttribute('data-placeholder'));
    if (el.id) for (const l of el.ownerDocument.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) add(textOf(l));
    const wrap = el.closest('label'); if (wrap) add(textOf(wrap));
    if (TOGGLE_ROLES.has(el.getAttribute('role')) || el.matches('input[type=checkbox],input[type=radio]')) add(textOf(el));
    add(el.getAttribute('title'));
    return parts.join(' ');
  };
  const isSecret = (el) => el.matches('input[type=password]') || /password|one-time-code/i.test(el.getAttribute('autocomplete') || '');
  const isToggle = (el) => el.matches('input[type=checkbox],input[type=radio]') || TOGGLE_ROLES.has(el.getAttribute('role') || '');
  // Anything that could post, move the flow on or submit a form is never clicked. Buttons and links are refused
  // outright, except a button that is itself a switch, checkbox or radio and can submit nothing (type=button, or
  // in no form), named for what it switches.
  const isFinal = (el) => {
    const tag = el.tagName;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'A' || role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab') return true;
    if (tag === 'INPUT' && ['submit', 'button', 'image', 'reset'].includes(type)) return true;
    if (tag === 'BUTTON' && !(TOGGLE_ROLES.has(role) && (type === 'button' || !el.form))) return true;
    if (el.closest('a[href]')) return true;
    return FINAL.test(nameOf(el) + ' ' + textOf(el));
  };
  const safeToggle = (el) => !!el && isToggle(el) && !isFinal(el) && !isSecret(el);
  const isOn = (el) => (el.matches('input') ? el.checked : (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.hasAttribute('checked')));
  const editable = (el) => el.matches('textarea,input:not([type]),input[type=text],input[type=search]') || el.isContentEditable;
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const inScope = (el, scope) => {
    if (!scope) return true;
    const re = new RegExp(scope, 'i');
    for (let n = el.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) if (re.test(textOf(n).slice(0, 2000))) return true;
    return false;
  };
  const candidates = (spec) => {
    const out = [];
    for (const s of spec.selectors || []) out.push(...deepAll(s));
    if (spec.label) {
      const re = new RegExp(spec.label, 'i');
      const pool = spec.kind === 'text' ? 'textarea,input,[contenteditable=true],[contenteditable=""]'
        : spec.kind === 'toggle' ? 'input[type=checkbox],input[type=radio],[role=switch],[role=checkbox],[role=radio]' : 'input[type=file]';
      for (const el of deepAll(pool)) if (re.test(nameOf(el))) out.push(el);
    }
    return out.filter((el, i) => out.indexOf(el) === i && inScope(el, spec.scope));
  };
  const find = (spec) => {
    for (const el of candidates(spec)) {
      if (spec.kind === 'file') { if (el.matches('input[type=file]') && !el.disabled) return el; continue; }
      if (!shown(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (spec.kind === 'text' && editable(el) && !isSecret(el)) return el;
      if (spec.kind === 'toggle' && safeToggle(el)) return el;
    }
    return null;
  };
  const valueOf = (el) => (el.isContentEditable ? el.innerText : el.value) || '';
  const same = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();
  window.__kp = {
    scan(specs) {
      const out = {};
      for (const [key, spec] of Object.entries(specs)) {
        const el = find(spec);
        out[key] = !el ? null : spec.kind === 'file' ? { files: el.files ? el.files.length : 0 }
          : spec.kind === 'text' ? { value: valueOf(el).slice(0, 6000) } : { on: isOn(el) };
      }
      return out;
    },
    element(spec) { return find(spec); },
    fileName(spec) { const el = find(spec); return el && el.files && el.files[0] ? el.files[0].name : ''; },
    setText(spec, value) {
      const el = find(spec);
      if (!el) return { ok: false, why: 'not found' };
      const doc = el.ownerDocument, win = doc.defaultView;
      el.focus();
      if (el.isContentEditable) {
        const range = doc.createRange(); range.selectNodeContents(el);
        const sel = win.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      } else { el.select(); }
      let ok = false;
      try { ok = doc.execCommand('insertText', false, value); } catch (e) { ok = false; }
      if (!ok || (!spec.loose && !same(valueOf(el), value))) {
        // The page's editor refused the inserted text: set it the plain way and tell the page it changed.
        if (el.isContentEditable) el.textContent = value;
        else { const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); }
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      return { ok: true, value: valueOf(el).slice(0, 6000), matches: same(valueOf(el), value) };
    },
    choose(spec) {
      const el = find(spec);
      if (!el) return 'not found';
      if (!safeToggle(el)) return 'refused';
      if (isOn(el)) return 'on';
      el.click();
      return isOn(el) ? 'on' : 'clicked';
    },
    safeToggle, isFinal,
  };
  return true;
})()`;

function hostAllowed(platform, rawUrl, extraHosts = []) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (extraHosts.includes(host) && (url.protocol === 'http:' || url.protocol === 'https:')) return true;  // tests' local pages only
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return (PLATFORM_HOSTS[platform] || []).some(h => host === h || host.endsWith('.' + h));
}

// The specs the page gets for this plan: only the fields the plan fills, with their values kept on this side.
function specsFor(plan) {
  const table = FIELDS[plan.platform] || {};
  const out = {};
  for (const f of plan.fields || []) if (table[f.key]) out[f.key] = { ...table[f.key], ...(f.key === 'tags' ? { loose: true } : {}) };
  for (const t of plan.toggles || []) if (table[t.key]) out[t.key] = table[t.key];
  return out;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fills the plan into the tab's page and keeps watching until every field is done, the time is up, or the tab goes.
// `report(body)` sends progress to the backend ({stage, filled, missing, note}); `notify(payload)` tells the app.
async function run({ wc, plan, report = async () => {}, notify = () => {}, timeoutMs = 15 * 60 * 1000, tickMs = 800, extraHosts = [], log = console }) {
  const specs = specsFor(plan);
  const keys = Object.keys(specs);
  const values = Object.fromEntries((plan.fields || []).map(f => [f.key, f]));
  const state = Object.fromEntries(keys.map(k => [k, { done: false, tries: 0, gaveUp: false, seen: 0 }]));
  const dbg = wc.debugger;
  let attached = false, contextId = null, frameId = null, stopped = '', lastSent = '';
  const send = (method, params = {}) => dbg.sendCommand(method, params);
  const filled = () => keys.filter(k => state[k].done);
  const missing = () => keys.filter(k => !state[k].done);
  const progress = async (stage, note = '') => {
    const body = { stage, filled: filled(), missing: missing(), note };
    const key = JSON.stringify(body);
    if (key === lastSent && stage === 'filling') return;
    lastSent = key;
    notify({ prepId: plan.prep_id, ...body });
    try { await report(body); } catch (err) { log.error(`[prepare] report: ${err.message}`); }
  };
  const onNavigate = () => { contextId = null; };
  const onDetach = (_e, reason) => { attached = false; contextId = null; if (!stopped) stopped = `detached: ${reason}`; };
  const onGone = () => { stopped = stopped || 'the tab was closed'; };
  wc.on('did-navigate', onNavigate); wc.on('destroyed', onGone);
  dbg.on('detach', onDetach);

  async function world() {
    if (contextId) return contextId;
    const tree = await send('Page.getFrameTree');
    frameId = tree.frameTree.frame.id;
    const made = await send('Page.createIsolatedWorld', { frameId, worldName: 'kairos-prepare', grantUniveralAccess: false });
    contextId = made.executionContextId;
    await evaluate(PAGE_SCRIPT);
    return contextId;
  }
  async function evaluate(expression, byValue = true) {
    const out = await send('Runtime.evaluate', { expression, contextId, returnByValue: byValue, awaitPromise: false, userGesture: false });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'page script failed');
    return byValue ? out.result.value : out.result;
  }
  const call = (fn, ...args) => `window.__kp.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`;

  try {
    try { dbg.attach('1.3'); attached = true; } catch (err) {
      await progress('failed', 'Kairos could not attach to the tab (close its DevTools and try again).');
      return { ok: false, reason: err.message };
    }
    const began = Date.now();
    let toldWaiting = false;
    while (!stopped && Date.now() - began < timeoutMs && missing().some(k => !state[k].gaveUp)) {
      if (wc.isDestroyed()) { stopped = 'the tab was closed'; break; }
      if (!hostAllowed(plan.platform, wc.getURL(), extraHosts)) { await pause(tickMs); continue; }  // a sign-in elsewhere: the person's
      let scan;
      try { await world(); scan = await evaluate(call('scan', specs)); } catch { contextId = null; await pause(tickMs); continue; }
      for (const key of keys) {
        const s = state[key], spec = specs[key], found = scan[key];
        if (s.done || s.gaveUp || !found) continue;
        // The video goes first; everything else waits until it is attached (the pages show their fields after it).
        if (key !== 'file' && state.file && !state.file.done) continue;
        try {
          if (spec.kind === 'file') {
            const handle = await evaluate(call('element', spec), false);
            if (!handle.objectId) continue;
            await send('DOM.setFileInputFiles', { files: [values[key].path], objectId: handle.objectId });
            s.done = (await evaluate(call('fileName', spec))) === values[key].name;
            if (!s.done && ++s.tries >= 3) s.gaveUp = true;
          } else if (spec.kind === 'text') {
            if (found.value !== undefined && String(found.value).replace(/\s+/g, ' ').trim() === String(values[key].value).replace(/\s+/g, ' ').trim()) {
              // Settled when it still reads the same on the next look (pages fill their own defaults after the upload).
              if (++s.seen >= 2) s.done = true;
              continue;
            }
            if (s.tries >= 3) { s.gaveUp = true; continue; }
            s.tries += 1; s.seen = 0;
            const out = await evaluate(call('setText', spec, values[key].value));
            if (spec.loose && out && out.ok) s.done = true;
          } else if (spec.kind === 'toggle') {
            const out = await evaluate(call('choose', spec));
            if (out === 'on') s.done = true;
            else if (out === 'refused' || ++s.tries >= 3) s.gaveUp = true;
          }
        } catch (err) { log.error(`[prepare] ${key}: ${err.message}`); contextId = null; }
      }
      if (filled().length) toldWaiting = true;
      if (toldWaiting) await progress('filling');
      await pause(tickMs);
    }
    const allDone = !missing().length;
    await progress(allDone ? 'done' : 'stopped', allDone ? '' : (stopped || (Date.now() - began >= timeoutMs ? 'time ran out' : 'some fields were not found')));
    return { ok: true, filled: filled(), missing: missing(), stopped };
  } finally {
    wc.removeListener('did-navigate', onNavigate); wc.removeListener('destroyed', onGone);
    dbg.removeListener('detach', onDetach);
    if (attached && !wc.isDestroyed()) { try { dbg.detach(); } catch { /* already gone */ } }
  }
}

module.exports = { run, hostAllowed, specsFor, FIELDS, PLATFORM_HOSTS, PAGE_SCRIPT };
