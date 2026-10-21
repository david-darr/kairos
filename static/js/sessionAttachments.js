import { api, el, toast } from './api.js';

// Opt-in attachment composer for embedded project chats. Uploads use the
// same staging, model image validation and transport as the main chat.
export function mountSessionAttachments(host, composer, input) {
  let staged = [], uploading = 0, disposed = false, disabled = false;
  const previews = new Set();
  const picker = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose reference files' });
  const button = el('button', { type: 'button', class: 'btn quiet', text: 'Attach references', onclick: () => picker.click() });
  const strip = el('div', { class: 'session-attachments', 'aria-label': 'Attached references', 'aria-live': 'polite' });
  const note = el('span', { class: 'meta', text: 'Images, UI mockups, model references or files. Paste screenshots or drop files here.' });
  const draw = () => {
    button.disabled = uploading > 0 || disabled;
    button.textContent = uploading ? 'Uploading references...' : 'Attach references';
    strip.replaceChildren(...staged.map(item => el('div', { class: 'session-attachment' }, [
      item.preview ? el('img', { src: item.preview, alt: `Reference: ${item.name}` }) : null,
      el('span', { text: item.name }), el('button', { type: 'button', class: 'btn quiet', text: 'Remove', disabled,
        'aria-label': `Remove ${item.name}`, onclick: () => { staged = staged.filter(row => row !== item); draw(); } }),
    ])));
  };
  const stage = async files => {
    if (disabled || disposed) return;
    uploading++; draw();
    try {
      for (const file of files) {
        if (disposed) break;
        const form = new FormData(); form.append('file', file);
        try {
          const item = await api('/api/chat/attachments', { method: 'POST', headers: {}, body: form, toast: false });
          if (disposed) break;
          if (file.type.startsWith('image/')) { item.preview = URL.createObjectURL(file); previews.add(item.preview); }
          staged.push(item);
        } catch (problem) { if (!disposed) toast(`Couldn't attach ${file.name}: ${problem.message}`, 'error'); }
      }
    } finally { uploading--; if (!disposed) draw(); }
  };
  picker.onchange = () => { const files = [...picker.files]; picker.value = ''; stage(files); };
  const paste = event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length && !disabled) { event.preventDefault(); stage(files); }
  };
  const drag = event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); };
  const drop = event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); stage([...event.dataTransfer.files]); } };
  input.addEventListener('paste', paste); host.addEventListener('dragover', drag); host.addEventListener('drop', drop);
  composer.prepend(el('div', { class: 'session-attachment-controls' }, [button, picker, note]), strip);
  return {
    getSelected: () => [...staged], clear: () => { staged = []; draw(); }, busy: () => uploading > 0,
    setDisabled(value) { disabled = value; draw(); },
    dispose() {
      disposed = true; input.removeEventListener('paste', paste); host.removeEventListener('dragover', drag); host.removeEventListener('drop', drop);
      for (const url of previews) URL.revokeObjectURL(url);
    },
  };
}

export function attachmentHistory(items, sessionId) {
  return el('div', { class: 'session-attachment-history' }, items.map(item => el('span', { class: 'session-attachment' }, [
    /\.(png|jpe?g|gif|webp)$/i.test(item.name || '') && sessionId
      ? el('img', { src: `/api/chat/images/${encodeURIComponent(sessionId)}/${encodeURIComponent(item.id)}`, alt: item.name, loading: 'lazy' }) : null,
    el('span', { text: item.name || 'Reference file' }),
  ])));
}
