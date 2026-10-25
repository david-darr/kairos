// The notch's quick composer (Kairos Notch build spec, 4a and phase 3), drawn
// to the NotchComposer board: a new chat with the default model, opened from
// New, from clicking Kip, or from a drop.
//
// - The window takes the keyboard only while the composer is open
//   (bridge.setFocus, electron/usage-overlay-focus.js): typing reaches the
//   app underneath the rest of the time.
// - It never sends by itself and never pre-fills from the clipboard or
//   another window. Send creates the chat through the sessions API and starts
//   one turn through POST /api/chat/live with a request id kept until it is
//   accepted, so a retried or repeated Send starts exactly one turn.
// - Escape closes it and keeps the draft until it is sent or cleared.
// - There is no global hotkey. Signed-in people only (the window itself
//   loads only after sign-in).
// - Dropped files and folders are untrusted: the chat is marked so
//   (routes/notch_routes.py), and a folder reaches the model only as a broker
//   grant's reference.
import { createMascot, KAIROS_SPEC } from './mascot.js';
import { approvalPanel } from './notchPanels.js';
import { splitBySize, refusalLine, uploadFile, askFolder } from './notchDrop.js';

const PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const MIC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/></svg>';
const SEND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const CLOSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function build(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function iconButton(className, label, icon, onClick) {
  const button = build('button', className); button.type = 'button';
  button.setAttribute('aria-label', label); button.innerHTML = icon;
  button.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
  return button;
}
async function json(response) { try { return await response.json(); } catch { return {}; } }

// The steps of one Send, in order. Each step is skipped once done, so a retry
// after a failure resumes rather than repeats: one chat, one turn.
export async function sendDraft(draft, { post, models }) {
  draft.requestId ||= crypto.randomUUID();
  if (!draft.sessionId) {
    const response = await post('/api/sessions', {});
    if (!response.ok) throw new Error('The new chat could not be created.');
    draft.sessionId = (await json(response)).id;
  }
  if (!draft.modelSet) {
    const model = models[draft.model] || models[0];
    if (!model) throw new Error('Add a model in Kairos first.');
    const response = await post(`/api/sessions/${encodeURIComponent(draft.sessionId)}/model`, { model_endpoint_id: model.id });
    if (!response.ok) throw new Error('The model could not be chosen for the new chat.');
    draft.modelSet = true;
  }
  if (draft.files.length && !draft.marked) {
    const response = await post('/api/notch/dropped', { session_id: draft.sessionId });
    if (!response.ok) throw new Error('The dropped files could not be added.');
    draft.marked = true;
  }
  const response = await post('/api/chat/live', { session_id: draft.sessionId, message: draft.text.trim(),
    attachment_ids: draft.files.map(file => file.id), references: draft.folders.map(({ kind, id, session_id, label }) => ({ kind, id, session_id, label })),
    request_id: draft.requestId });
  if (!response.ok) throw new Error((await json(response)).detail || 'The message could not be sent.');
  return draft.sessionId;
}

const emptyDraft = () => ({ text: '', files: [], folders: [], sessionId: null, requestId: null, modelSet: false, marked: false, model: 0 });

export function createComposer({ bridge, post, render, isAdmin, onSent, reducedMotion }) {
  let open = false, draft = emptyDraft(), note = '', sending = false, listening = null;
  let upload = null, folderRequest = null, models = null;
  const deps = { post, openChat: id => bridge.openChat?.(id), openApp: () => bridge.openApp?.('home'), focus: on => bridge.setFocus?.(!!on),
    dismiss() {}, reducedMotion };
  async function loadModels() {
    if (models) return models;
    try {
      const response = await fetch('/api/models/choices', { credentials: 'same-origin', cache: 'no-store' });
      models = response.ok ? await response.json() : [];
    } catch { models = []; }
    return models;
  }
  function setOpen(value) {
    if (open === value) return;
    open = value;
    bridge.setFocus?.(open);  // the keyboard only while the composer is open
    if (open) loadModels().then(render);
    else if (listening) { listening.cancel(); listening = null; }
    render();
  }
  // Remove an empty chat made only for a folder, when the folder is taken out.
  async function dropSession() {
    if (!draft.sessionId || draft.text.trim() || draft.files.length || draft.folders.length) return;
    const id = draft.sessionId;
    draft.sessionId = null; draft.modelSet = false; draft.marked = false;
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  }

  async function addFiles(list) {
    const { ok, refused } = splitBySize([...list]);
    note = refusalLine(refused);
    if (ok.length) {
      const controller = new AbortController();
      upload = { id: crypto.randomUUID(), total: ok.length, done: 0, part: 0, names: ok.map(file => file.name), controller };
      upload.view = uploadPanel(upload);
      render();
      for (const file of ok) {
        try {
          const staged = await uploadFile(file, { signal: controller.signal, onProgress: part => { upload.part = part; upload.view.update(); } });
          draft.files.push({ id: staged.id, name: staged.filename || file.name });
        } catch (error) {
          if (error.cancelled) break;
          note = [note, error.message].filter(Boolean).join(' ');
        }
        upload.done += 1; upload.part = 0; upload.view.update();
      }
      upload = null;
    }
    setOpen(true); render();
  }
  async function addFolders(paths) {
    for (const path of paths) {
      if (!isAdmin()) { note = 'Folders need an admin account. Drop the files instead.'; break; }
      try {
        if (!draft.sessionId) {
          const response = await post('/api/sessions', {});
          if (!response.ok) throw new Error('The new chat could not be created.');
          draft.sessionId = (await json(response)).id;
        }
        const outcome = await askFolder({ sessionId: draft.sessionId, path, onRequest: request => { folderRequest = request; render(); } });
        folderRequest = null;
        if (outcome.status === 'allowed') draft.folders.push(outcome.folder);
        else note = outcome.detail || 'Nothing was attached from that folder.';
      } catch (error) {
        folderRequest = null;
        note = error.message || 'That folder could not be added.';
      }
      render();
    }
    await dropSession();
    setOpen(true); render();
  }

  async function send() {
    if (sending || (!draft.text.trim() && !draft.files.length && !draft.folders.length)) return;
    sending = true; note = 'Sending…'; render();
    try {
      const sessionId = await sendDraft(draft, { post, models: await loadModels() });
      draft = emptyDraft(); note = ''; sending = false;
      setOpen(false);
      onSent(sessionId);
    } catch (error) {
      sending = false; note = error.message; render();
    }
  }

  // The existing dictation (voiceInput.js), loaded on the first press. Kip
  // listens while the mic is open.
  async function dictate() {
    if (listening) {
      const recorder = listening; listening = null;
      note = 'Writing down what you said…'; render();
      try {
        const { transcribeBlob } = await import('./voiceInput.js');
        const audio = await recorder.stop();
        const text = audio ? await transcribeBlob(audio) : '';
        if (text) draft.text = `${draft.text}${draft.text && !/\s$/.test(draft.text) ? ' ' : ''}${text}`;
        note = '';
      } catch (error) { note = error.message || 'Dictation did not work.'; }
      render(); return;
    }
    try {
      const { createRecorder, isRecordingSupported } = await import('./voiceInput.js');
      if (!isRecordingSupported()) { note = 'This computer has no microphone Kairos can use.'; render(); return; }
      const recorder = createRecorder();
      await recorder.start();
      listening = recorder; note = 'Listening. Press the mic again to stop.';
    } catch { note = 'The microphone did not start.'; }
    render();
  }

  function composerPanel() {
    const node = build('section', 'n-panel n-compose');
    node.dataset.kind = 'composer';
    node.setAttribute('aria-label', 'Quick chat');
    const face = createMascot({ state: listening ? 'listening' : 'idle', size: 48, spec: KAIROS_SPEC });
    face.classList.add('n-panel-kip');
    const body = build('div', 'n-compose-body');
    const label = build('label', 'n-compose-label');
    const hidden = build('span', 'n-visually-hidden', 'Message Kairos');
    const field = build('textarea', 'n-compose-field');
    field.rows = 2; field.maxLength = 20000; field.value = draft.text;
    field.placeholder = 'Ask Kairos anything';
    field.addEventListener('input', () => { draft.text = field.value; });
    field.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    });
    label.append(hidden, field);
    const attached = build('div', 'n-compose-attached');
    const chip = (text, onRemove) => {
      const item = build('span', 'n-compose-chip'); item.append(build('span', '', text));
      item.append(iconButton('n-compose-remove', `Remove ${text}`, CLOSE, onRemove)); return item;
    };
    for (const file of draft.files) attached.append(chip(file.name, () => { draft.files = draft.files.filter(f => f !== file); render(); }));
    for (const folder of draft.folders) attached.append(chip(`${folder.label}/`, async () => { draft.folders = draft.folders.filter(f => f !== folder); await dropSession(); render(); }));
    attached.hidden = !attached.children.length;
    const picker = build('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
    picker.addEventListener('change', () => { if (picker.files?.length) addFiles(picker.files); });
    const row = build('div', 'n-compose-row');
    const list = models || [];
    const model = build('button', 'n-compose-model', list.length ? list[draft.model % list.length].name : 'No model');
    model.type = 'button';
    model.setAttribute('aria-label', list.length ? `Model: ${model.textContent}. Click for the next one.` : 'No model. Add one in Kairos.');
    model.addEventListener('click', event => { event.stopPropagation(); if (list.length > 1 && !draft.modelSet) { draft.model = (draft.model + 1) % list.length; render(); } });
    model.disabled = draft.modelSet || list.length < 2;
    const hint = build('span', 'n-compose-hint', 'New chat · Enter sends, Esc closes');
    const sendButton = iconButton('n-compose-send', 'Send', SEND, () => send());
    sendButton.disabled = sending || (models !== null && !list.length);
    row.append(iconButton('n-compose-ic', 'Attach files', PLUS, () => picker.click()), model, hint,
      iconButton(`n-compose-ic n-compose-mic${listening ? ' on' : ''}`, listening ? 'Stop dictation' : 'Dictate', MIC, () => dictate()), sendButton);
    const status = build('div', 'n-panel-note', note); status.setAttribute('role', 'status');
    body.append(label, attached, row, status, picker);
    node.append(face, body);
    return { key: 'composer', kind: 'composer', kip: listening ? 'listening' : 'idle', glow: '', node, sticky: () => true,
      dispose() {}, focus() { field.focus(); field.setSelectionRange(field.value.length, field.value.length); } };
  }

  // "Adding 3 files": a bar whose thumb is Kip, carrying them. Built once per
  // upload; progress moves the bar in place.
  function uploadPanel(job) {
    const words = `Adding ${job.total} file${job.total === 1 ? '' : 's'} to a new chat`;
    const node = build('section', 'n-panel n-upload');
    node.dataset.kind = 'upload';
    node.setAttribute('aria-label', words);
    const copy = build('div', 'n-panel-copy');
    const head = build('div', 'n-upload-head'), pct = build('span', 'n-upload-pct');
    head.append(build('span', 'n-panel-title', words), pct);
    const track = build('div', 'n-upload-track'); track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', words); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    const fill = build('div', 'n-upload-fill');
    const thumb = createMascot({ state: 'carry', size: 30, spec: KAIROS_SPEC }); thumb.classList.add('n-upload-thumb');
    track.append(fill, thumb);
    copy.append(head, track, build('div', 'n-panel-detail', job.names.slice(0, 3).join(', ') + (job.names.length > 3 ? '…' : '')));
    const actions = build('div', 'n-panel-actions');
    const cancel = build('button', 'n-act n-act-quiet', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', event => { event.stopPropagation(); job.controller.abort(); });
    actions.append(cancel);
    node.append(copy, actions);
    const update = () => {
      const share = Math.min(1, (job.done + job.part) / job.total), percent = Math.round(share * 100);
      track.style.setProperty('--share', String(share));
      track.setAttribute('aria-valuenow', String(percent)); pct.textContent = `${percent}%`;
    };
    update();
    return { key: `upload:${job.id}`, kind: 'upload', kip: 'carry', glow: 'sage', node, update, dispose() {} };
  }

  return {
    get open() { return open; },
    openComposer() { setOpen(true); },
    close() { setOpen(false); },
    addFiles, addFolders,
    // The folder grant's request, answered like any approval.
    folderWant() {
      if (!folderRequest) return null;
      const request = folderRequest;
      return { key: `approval:${request.id}`, make: () => approvalPanel(request, { title: 'Dropped folder' }, deps) };
    },
    want() {
      if (upload) { const view = upload.view; return { key: view.key, make: () => view }; }
      if (!open) return null;
      return { key: `composer:${draft.files.length}:${draft.folders.length}:${draft.model}:${!!listening}:${sending}:${note}:${models?.length ?? -1}`,
        make: () => { const panel = composerPanel(); requestAnimationFrame(() => panel.focus()); return panel; } };
    },
  };
}
