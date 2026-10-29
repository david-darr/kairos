// The host bridge between a bot's page (in a sandboxed frame) and Kairos (Phase 6 unit U2, 2026-10-29).
// Spec: phase-6-design.md section 5.3. JSON-RPC 2.0 over postMessage. The page lives in an iframe with
// sandbox="allow-scripts allow-forms" (no same-origin), so it has no cookies, storage or API access; this file is
// the only door: it checks who sent a message and how big and how often, and answers a short list of methods.
//
//   page -> host:  ui/ready, ui/message {text}, ui/open-link {url}, ui/update-model-context {text},
//                  ui/size-changed {height}, ui/point {tag, label}, ui/point-end
//   host -> page:  ui/theme {vars}, ui/point {on}
//
// Pure parts (limits, head building, theme values) load in plain Node; the DOM is touched only by createBridge.

export const BRIDGE_LIMITS = {
  maxBytes: 1_000_000,
  message: [{ count: 1, ms: 3000 }, { count: 10, ms: 600_000 }],
  openLink: [{ count: 1, ms: 2000 }],
  rpc: [{ count: 10, ms: 10_000 }, { count: 120, ms: 600_000 }],
  linkChars: 2048,
};
export const SANDBOX = 'allow-scripts allow-forms';
export const SCRIPT_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];

// A sliding window per rule; allow() records a hit only when every rule has room.
export function makeLimiter(rules, clock = () => Date.now()) {
  const hits = rules.map(() => []);
  return {
    allow() {
      const now = clock();
      rules.forEach((rule, i) => { while (hits[i].length && now - hits[i][0] >= rule.ms) hits[i].shift(); });
      if (rules.some((rule, i) => hits[i].length >= rule.count)) return false;
      hits.forEach(list => list.push(now));
      return true;
    },
    reset() { hits.forEach(list => { list.length = 0; }); },
  };
}

// The look the page gets: CSS variables under the page's own names, resolved from the live document.
export const THEME_VARS = {
  '--k-bg': '--bg', '--k-surface': '--bg-panel-solid', '--k-surface-2': '--surface-2', '--k-text': '--text', '--k-text-dim': '--text-dim',
  '--k-text-faint': '--text-faint', '--k-accent': '--accent', '--k-success': '--success', '--k-danger': '--danger', '--k-warn': '--warn',
  '--k-border': '--border', '--k-border-strong': '--border-strong', '--k-hairline': '--hairline-soft', '--k-ink': '--k-ink',
  '--k-font-sans': '--k-font-sans', '--k-font-mono': '--font-mono',
};
const SAFE_VALUE = /^[#0-9a-zA-Z(),.%\s"'_-]{1,200}$/;
export function safeCssValue(value) { const text = String(value ?? '').trim(); return SAFE_VALUE.test(text) ? text : ''; }
export function resolveTheme(root = (typeof document !== 'undefined' ? document.documentElement : null)) {
  const out = {};
  if (!root || typeof getComputedStyle !== 'function') return out;
  const style = getComputedStyle(root);
  for (const [name, source] of Object.entries(THEME_VARS)) {
    const value = safeCssValue(style.getPropertyValue(source));
    if (value) out[name] = value;
  }
  const scheme = style.getPropertyValue('color-scheme').trim();
  out.scheme = /dark/.test(scheme) ? 'dark' : 'light';
  return out;
}
export function themeCss(vars) {
  const rules = Object.entries(vars || {}).filter(([k, v]) => k.startsWith('--k-') && safeCssValue(v)).map(([k, v]) => `${k}:${safeCssValue(v)}`);
  return `:root{${rules.join(';')}}body{margin:0;background:var(--k-bg);color:var(--k-text);font-family:var(--k-font-sans,system-ui,sans-serif)}`;
}

// The script the page runs first: window.kairos {send, open, setContext, theme} plus Point mode. The text between the
// markers is the only copy: services/bot_apps.py reads it from this file to build the page the server serves.
export const SHIM_TEMPLATE = String.raw`/*SHIM-START*/(function(){var C=__CHANNEL__,n=0,pointing=false,box=null;
function post(method,params,notify){var m={jsonrpc:'2.0',method:method,params:params,channel:C};if(!notify)m.id=++n;parent.postMessage(m,'*');}
var api={send:function(t){post('ui/message',{text:String(t)});},open:function(u){post('ui/open-link',{url:String(u)});},setContext:function(t){post('ui/update-model-context',{text:String(t)});},theme:{}};
window.kairos=api;
var lastH=-1;
function size(){post('ui/size-changed',{height:Math.ceil(document.documentElement.scrollHeight)},true);}
function label(el){var t=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('placeholder')||el.innerText||el.textContent||el.id||'').replace(/\s+/g,' ').trim();return t.slice(0,40);}
function outline(el){if(box){box.style.outline='';box.style.outlineOffset='';}box=el;if(el){el.style.outline='2px solid '+(api.theme['--k-accent']||'currentColor');el.style.outlineOffset='1px';}}
function over(e){if(pointing)outline(e.target);}
function click(e){if(!pointing)return;e.preventDefault();e.stopPropagation();var el=e.target;post('ui/point',{tag:el.tagName.toLowerCase(),label:label(el)},true);}
function key(e){if(pointing&&e.key==='Escape'){e.preventDefault();post('ui/point-end',{},true);}}
document.addEventListener('mouseover',over,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);
window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data||{};
if(d.method==='ui/theme'&&d.params){api.theme=d.params;var s=document.documentElement.style;for(var k in d.params){if(k.indexOf('--k-')===0)s.setProperty(k,d.params[k]);}}
if(d.method==='ui/point'&&d.params){pointing=!!d.params.on;document.documentElement.style.cursor=pointing?'crosshair':'';if(!pointing)outline(null);}});
window.addEventListener('load',function(){size();post('ui/ready',{},true);});
setInterval(function(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==lastH){lastH=h;size();}},400);
})();/*SHIM-END*/`;
export function pageShim(channel) {
  return SHIM_TEMPLATE.replace('/*SHIM-START*/', '').replace('/*SHIM-END*/', '').replace('__CHANNEL__', JSON.stringify(String(channel).replace(/[^A-Za-z0-9_-]/g, '')));
}

const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// The head block placed before anything the bot wrote: the policy first, then the look, then the bridge.
export function buildHead({ csp, theme, channel }) {
  return `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr(csp)}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${themeCss(theme).replace(/<\/style/gi, '')}</style>`
    + `<script>${pageShim(channel).replace(/<\/script/gi, '<\\/script')}</script>`;
}
// Put `head` at the top of the page's own <head>, whatever shape the page is.
export function injectHead(html, head) {
  const source = String(html ?? '');
  const headTag = /<head(?=[\s>])[^>]*>/i.exec(source);
  if (headTag) return source.slice(0, headTag.index + headTag[0].length) + head + source.slice(headTag.index + headTag[0].length);
  const htmlTag = /<html(?=[\s>])[^>]*>/i.exec(source);
  if (htmlTag) return source.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${head}</head>` + source.slice(htmlTag.index + htmlTag[0].length);
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
}

// Where the sandboxed frame loads the page from (routes/bot_widget_routes.py app_frame).
export function frameUrl(sessionId, messageId, rev, channel) {
  return `/api/bot-widgets/${encodeURIComponent(sessionId)}/apps/${encodeURIComponent(messageId)}/frame?rev=${encodeURIComponent(rev)}&channel=${encodeURIComponent(channel)}`;
}
export function httpLink(url) {
  if (typeof url !== 'string' || url.length > BRIDGE_LIMITS.linkChars) return '';
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}
export function messageBytes(data) { try { return new TextEncoder().encode(JSON.stringify(data)).length; } catch { return Infinity; } }

// Host side. `getWindow()` returns the frame's contentWindow. Handlers return a promise or a value.
// Returns {handle(event), post(method, params), destroy()}. Only messages whose source is that window are heard.
export function createBridge({ getWindow, channel, clock, onReady, onMessage, onOpen, onContext, onSize, onPoint, onPointEnd, isPointing = () => false } = {}) {
  const limits = { message: makeLimiter(BRIDGE_LIMITS.message, clock), openLink: makeLimiter(BRIDGE_LIMITS.openLink, clock), rpc: makeLimiter(BRIDGE_LIMITS.rpc, clock) };
  let alive = true;
  const reply = (id, payload) => { if (id === undefined || !alive) return; try { getWindow()?.postMessage({ jsonrpc: '2.0', id, ...payload }, '*'); } catch { /* the frame is gone */ } };
  const refuse = (id, code, message) => reply(id, { error: { code, message } });
  async function handle(event) {
    if (!alive) return false;
    const win = getWindow?.();
    if (!win || event.source !== win) return false;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return false;
    if (channel && data.channel !== channel) return false;
    if (messageBytes(data) > BRIDGE_LIMITS.maxBytes) { refuse(data.id, -32600, 'That message is too large.'); return true; }
    const params = data.params && typeof data.params === 'object' ? data.params : {};
    const id = data.id;
    try {
      switch (data.method) {
        case 'ui/ready': onReady?.(); break;
        case 'ui/size-changed': if (Number.isFinite(params.height)) onSize?.(Math.max(0, Math.min(100000, params.height))); break;
        case 'ui/point': if (isPointing() && typeof params.tag === 'string') onPoint?.({ tag: params.tag.replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'element', label: String(params.label ?? '').slice(0, 40) }); break;
        case 'ui/point-end': if (isPointing()) onPointEnd?.(); break;
        case 'ui/message':
          if (typeof params.text !== 'string' || !params.text.trim()) return refuse(id, -32602, 'There is nothing to send.'), true;
          if (!limits.rpc.allow() || !limits.message.allow()) return refuse(id, -32000, 'That app is sending too fast.'), true;
          reply(id, { result: await onMessage?.(params.text.slice(0, 4000)) ?? { ok: true } });
          break;
        case 'ui/open-link': {
          const href = httpLink(params.url);
          if (!href) return refuse(id, -32602, 'Only http and https links can be opened.'), true;
          if (!limits.openLink.allow()) return refuse(id, -32000, 'That app is opening links too fast.'), true;
          onOpen?.(href);
          reply(id, { result: { ok: true, pending: true } });
          break;
        }
        case 'ui/update-model-context':
          if (typeof params.text !== 'string') return refuse(id, -32602, 'The note must be text.'), true;
          if (!limits.rpc.allow()) return refuse(id, -32000, 'That app is calling too fast.'), true;
          await onContext?.(params.text.slice(0, 2000));
          reply(id, { result: { ok: true } });
          break;
        default: refuse(id, -32601, 'That call is not supported.');
      }
    } catch (error) { refuse(id, -32000, String(error?.message || 'That did not go through.').slice(0, 200)); }
    return true;
  }
  return {
    handle,
    post(method, params) { if (alive) try { getWindow()?.postMessage({ jsonrpc: '2.0', method, params }, '*'); } catch { /* gone */ } },
    destroy() { alive = false; },
    limits,
  };
}
