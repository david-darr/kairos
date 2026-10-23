import { keepReadingPosition } from './chatScrollAnchor.js';
import { mountMobileModelSheet, renderMobileCatalogMenu } from './mobileModelSheet.js';
import { mobileOn, phone } from './mobileShared.js';
// One embedded conversation (2026-10-08): the Agents tab's chat pane and a
// tab's own chat (CRM task chats, School course chats) share this. It streams
// through the same chatStream.js registry as every other chat, so a reply
// keeps running if you leave the view and is there when you come back, and
// it shows the app's permission prompts. A tab that only read the stream's
// text would leave a turn waiting on a question nobody can see.
//
// Tabs import it as "/static/js/sessionChat.js"; mountSessionChat is part of
// the tab view contract (skill_templates/build-custom-tab/SKILL.md).
import { api, el, toast, customSelect } from './api.js';
import { shouldSendOnEnter } from './composerKeyboard.js';
import * as chatStream from './chatStream.js';
import { renderMessageBody } from './chatContent.js';
import { dismissPermissionPrompt, showPermissionPrompt } from './permissionPrompt.js';
import { mountChatReferences, renderReferenceChips } from './chatReferences.js';
import { renderAgentHandoff, watchAgentHandoffs } from './agentHandoff.js';
import { agentAvatar } from './agentAvatar.js';
import { createRecorder, transcribeBlob, getSpeechStatus, isRecordingSupported } from './voiceInput.js';
import { creativeSelectionButton } from './creativeConnections.js';
import { mountSessionAttachments, attachmentHistory } from './sessionAttachments.js';
import { agentCall } from './agentCall.js';

const CLI_KINDS = ['claude_cli', 'codex_cli'];
const queues = new Map();
const pausedQueues = new Set();

// options:
//   sessionId     the chat to show, or null to create it on first send
//   createSession async () => id, used when sessionId is null
//   title         the chat's name, used for the in-flight indicator
//   placeholder, emptyTitle, emptyText
//   modelPicker   show connection and model choices for this chat
//   permissionPicker show Base/Auto permissions for an existing chat
//   openInChats   show a button that opens the chat in Chats
//   onTurnEnd     called once after each reply finishes
//   initialMessage sends the first task after loading a new session
//   queue         editable follow-ups; paused after Stop or leaving the view
//   readOnly      show history with sending disabled
//   onModelChange called after saving a model connection (endpoint, exact model or null)
// Returns a cleanup function.
export async function mountSessionChat(host, options = {}) {
  let sessionId = options.sessionId || null;
  let session = null;
  let unsubscribe = () => {};
  let liveTurnId = null;
  let shownPermission = null;
  let disposed = false, submitting = false;
  let modelSaving = false, modelControls = [], disposePhoneModels = () => {};
  let permissionSaving = false, permissionControl = null;
  let workingTimer = null;
  let call = null;
  const label = options.title || 'Chat';
  // Forge supplies document rendering/chrome; transport, queues and model
  // changes remain the same controller used by the embedded chats.
  const transcript = options.transcript;

  const messages = transcript?.messages || el('div', { class: 'side-messages session-chat-messages', role: 'log', 'aria-label': label });
  const input = el('textarea', { class: 'side-chat-input', rows: '1', placeholder: options.placeholder || 'Message Kairos', 'aria-label': options.placeholder || 'Message Kairos' });
  const inputTop = el('div', { class: 'side-chat-input-top' }, [input]);
  // Forge's continuous transcript owns its composer and deliberately has no
  // reference chips. Other embedded sessions use the full shared picker.
  const references = transcript ? { getSelected: () => [], clear() {}, dispose() {} } : mountChatReferences(input, inputTop, () => sessionId);
  const send = el('button', { type: 'button', class: 'side-chat-send btn', text: 'Send' });
  const queueButton = el('button', { type: 'button', class: 'btn quiet', text: 'Queue', hidden: true });
  const queueList = el('div', { class: 'session-chat-queue', 'aria-label': 'Queued messages', hidden: true });
  const tools = el('div', { class: 'session-chat-tools' });
  const status = el('span', { class: 'meta session-chat-status', role: 'status' });
  const scrollHost = options.agent ? el('div', { class: 'agent-conversation-stream' }, [messages]) : messages;
  const composer = el('div', { class: 'side-chat-composer glass' }, [inputTop, queueButton, send]);
  const attachments = options.attachments && !transcript ? mountSessionAttachments(host, composer, input) : null;
  let recorder = null;
  if (options.agent) {
    const add = el('button', { type: 'button', class: 'btn quiet agent-composer-add', text: '+', 'aria-label': 'Add a reference', onclick: () => references.openPicker() });
    const mic = el('button', { type: 'button', class: 'btn quiet agent-composer-mic', 'aria-label': 'Dictate a message', hidden: !isRecordingSupported(), onclick: async () => {
      mic.disabled = true;
      try {
        if (recorder) {
          const active = recorder; recorder = null;
          const blob = await active.stop();
          const text = blob ? await transcribeBlob(blob) : '';
          if (!disposed && text) { input.value = `${input.value}${input.value ? ' ' : ''}${text}`; input.dispatchEvent(new Event('input')); input.focus(); }
          mic.setAttribute('aria-label', 'Dictate a message');
        } else {
          const speech = await getSpeechStatus();
          if (!speech?.engine_available || !speech.active_model) throw new Error('Set up speech recognition in Settings > Speech.');
          const active = createRecorder(); await active.start();
          if (disposed) { active.cancel(); return; }
          recorder = active; mic.setAttribute('aria-label', 'Stop recording and transcribe');
        }
      } catch (problem) { toast(problem.message, 'error'); }
      finally { mic.disabled = false; }
    } });
    mic.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M8 21h8"/></svg>';
    composer.prepend(add); composer.insertBefore(mic, send);
  }
  if (transcript) transcript.mount(host, { input, inputTop, send, queueButton, queueList, tools, status });
  else host.replaceChildren(el('div', { class: 'session-chat' }, [tools, scrollHost, queueList,
    ...(options.agent ? [el('div', { class: 'agent-composer-row' }, [el('div', { class: 'agent-composer-orb', 'aria-label': options.agent.name }, [agentAvatar(options.agent, 38)]), composer])] : [composer]),
  ]));
  const disposeAnchor = transcript ? () => {} : keepReadingPosition(scrollHost);
  tools.hidden = false;
  tools.append(creativeSelectionButton(() => ({ sessionId }), host));

  const card = (role, text, message = null) => {
    if (transcript) return transcript.card(role, text, message);
    const agent = message && renderAgentHandoff(message, sessionId);
    if (agent) return agent;
    const body = el('div', { class: 'msg-body' });
    renderMessageBody(body, text, sessionId, role === 'assistant');
    return el('div', { class: `msg ${role}`, ...(message?.call_summary_id ? {'data-call-summary':message.call_summary_id} : {}) }, [body,
      ...(options.agent && role === 'assistant' ? [el('div', { class: 'agent-message-byline' }, [agentAvatar(options.agent, 24), el('span', { text: options.agent.name })])] : []),
      ...(role === 'user' && message?.attachments?.length ? [attachmentHistory(message.attachments, sessionId)] : []),
      ...(role === 'user' && message?.references?.length ? [renderReferenceChips(message.references)] : [])]);
  };
  let lastDay = '';
  const dateMarker = (stamp = Date.now() / 1000) => {
    if (!options.agent || transcript) return [];
    const date = new Date(stamp * 1000), day = date.toDateString();
    if (lastDay === day || !Number.isFinite(date.getTime())) return [];
    lastDay = day;
    return [el('div', { class: 'agent-message-date', text: day === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) })];
  };
  const busy = () => !!sessionId && chatStream.getInFlight(sessionId)?.status === 'processing';
  const syncSend = () => {
    const stopping = !!sessionId && !!chatStream.getInFlight(sessionId)?.stopping;
    send.textContent = stopping ? 'Stopping…' : busy() ? 'Stop' : 'Send';
    send.dataset.mode = busy() ? 'stop' : 'send';
    queueButton.hidden = !options.queue || !busy() || options.readOnly;
    input.disabled = !!options.readOnly;
    send.disabled = stopping || permissionSaving || !!options.readOnly;
    attachments?.setDisabled(!!options.readOnly || submitting || busy());
    for (const control of modelControls) control.disabled = busy() || modelSaving || permissionSaving || !!options.readOnly;
    if (permissionControl) permissionControl.disabled = busy() || submitting || modelSaving || permissionSaving || !!options.readOnly;
    transcript?.setBusy(busy());
  };
  const drawQueue = () => {
    const queued = queues.get(sessionId) || [];
    queueList.hidden = !queued.length;
    queueList.replaceChildren(...queued.map((item, index) => {
      const edit = el('textarea', { rows: '1', value: item.text, 'aria-label': `Queued message ${index + 1}` });
      edit.value = item.text;
      edit.oninput = () => { item.text = edit.value; };
      return el('div', { class: 'session-chat-queue-row' }, [edit, el('button', { class: 'btn quiet', text: 'Remove', onclick: () => { queued.splice(index, 1); drawQueue(); } })]);
    }));
    if (queued.length && pausedQueues.has(sessionId)) queueList.append(el('button', { class: 'btn quiet', text: 'Resume queue', disabled: busy() || !!options.readOnly, onclick: () => { pausedQueues.delete(sessionId); sendNext(); } }));
  };
  const sendNext = () => {
    if (disposed || !host.isConnected || busy() || permissionSaving || pausedQueues.has(sessionId) || options.readOnly) return;
    const queued = queues.get(sessionId) || [];
    const next = queued.shift(); drawQueue();
    if (next) { if (next.text.trim()) runTurn(next.text.trim(), next.references, next.attachments); else sendNext(); }
  };
  const handoffs = transcript ? { refresh() {}, dispose() {} } : watchAgentHandoffs(messages, () => sessionId);

  const attach = (replyBody) => {
    unsubscribe();
    clearInterval(workingTimer); workingTimer = null;
    const id = sessionId;
    const bound = chatStream.getInFlight(id);
    liveTurnId = chatStream.getInFlight(id)?.turnId || null;
    let finished = false;
    const agentTurn = !!session?.agent_id;
    const replyCard = replyBody.closest('.msg');
    let working = null, heading = null, verb = null, elapsed = null, steps = null;
    const openedSteps = new Set();
    if (agentTurn && replyCard && !transcript) {
      working = el('div', { class: 'agent-turn-working', role: 'status' });
      const face = agentAvatar(options.agent || { id: session.agent_id }, 38);
      verb = el('span', { class: 'agent-turn-verb', text: 'Writing' });
      elapsed = el('time', { class: 'agent-turn-elapsed' });
      steps = el('div', { class: 'agent-turn-steps' });
      heading = el('div', { class: 'agent-turn-heading' }, [face, verb, elapsed]);
      working.append(heading, steps);
      replyCard.prepend(working);
    }
    const timeLabel = entry => {
      const seconds = Math.max(0, Math.floor(Date.now() / 1000 - (entry.startedAt || Date.now() / 1000)));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    const action = step => {
      const name = String(step.name || step.kind || '').toLowerCase();
      if (/search|grep|find|query/.test(name)) return 'Searching';
      if (/read|open|fetch|browse|web/.test(name)) return 'Reading';
      if (/command|shell|bash|exec|terminal/.test(name)) return 'Running a command';
      if (/write|edit|patch|save/.test(name)) return 'Writing';
      return name ? `Using ${step.name || step.kind}` : 'Writing';
    };
    const drawSteps = entry => {
      if (!steps) return;
      const events = [...(entry.toolSteps || []), ...(entry.toolEvents || [])];
      const byId = new Map();
      for (const [index, item] of events.entries()) {
        // Computer events do not carry call IDs; pair each finish with its
        // most recent start for the same tool (2026-10-14).
        const terminal = item.phase === 'finished' || /finished|failed/.test(item.kind || '');
        const pending = terminal && [...byId].reverse().find(([, step]) =>
          step.name === item.name && (step.phase === 'started' || /started/.test(step.kind || '')));
        const id = item.id || pending?.[0] || `${item.name || item.kind}-${index}`;
        const previous = byId.get(id) || {};
        byId.set(id, { ...previous, ...item });
      }
      steps.replaceChildren(...[...byId.entries()].map(([key, item]) => {
        const failed = item.ok === false || item.phase === 'failed' || item.kind === 'tool_failed';
        const complete = item.phase === 'finished' || /finished|failed/.test(item.kind || '');
        const row = el('details', { class: `agent-turn-step${failed ? ' is-failed' : ''}`, open: failed || !complete || openedSteps.has(key) });
        row.addEventListener('click', event => { if (event.target.closest('summary')) {
          if (row.open) openedSteps.delete(key); else openedSteps.add(key);
        } });
        row.append(el('summary', { text: `${failed ? 'Failed' : complete ? 'Done' : 'Working'} · ${item.summary || action(item)}` }),
          el('pre', { text: item.output || item.detail || item.summary || item.name || '' }));
        return row;
      }));
      const active = [...byId.values()].reverse().find(item => item.phase === 'started' || /started/.test(item.kind || ''));
      verb.textContent = entry.stopping ? 'Stopping' : active ? action(active) : 'Writing';
    };
    const paint = (entry) => {
      // A newer turn must never paint into this reply.
      if (bound && entry !== bound) return;
      if (!host.isConnected || sessionId !== id) return;
      // Decision 3, 2026-10-13: only a session with agent_id buffers its
      // visible reply. The stream entry still retains all text for Stop/error.
      if (agentTurn && entry.status === 'processing') replyBody.replaceChildren();
      else renderMessageBody(replyBody, entry.text || (entry.status === 'processing' ? '' : '(no reply)'), id, true);
      if (working) {
        heading.hidden = entry.status !== 'processing';
        if (entry.status === 'processing') {
          elapsed.textContent = timeLabel(entry); drawSteps(entry);
          if (!workingTimer) workingTimer = setInterval(() => { if (working.isConnected && !heading.hidden) elapsed.textContent = timeLabel(entry); }, 1000);
        } else { clearInterval(workingTimer); workingTimer = null; drawSteps(entry); }
        working.hidden = heading.hidden && !steps.children.length;
      }
      transcript?.paint(replyBody, entry);
      if (entry.permission && entry.permission.id !== shownPermission) {
        shownPermission = entry.permission.id;
        if (!transcript) showPermissionPrompt(entry.permission, () => { entry.permission = null; }, options.agent ? { mount: replyCard, inline: true } : {});
      } else if (!entry.permission && shownPermission) {
        dismissPermissionPrompt(shownPermission);
        shownPermission = null;
      }
      if (entry.status === 'done' && entry.handoffs) { replyCard?.remove(); handoffs.refresh(); }
      if (entry.status === 'failed' && replyCard && !replyCard.classList.contains('msg-failed')) {
        replyCard.classList.add('msg-failed');
        replyCard.append(el('div', { class: 'msg-interrupted', text: entry.error || 'Response interrupted. Try again.' }));
      }
      if (agentTurn && entry.status === 'stopped' && replyCard && !replyCard.classList.contains('msg-stopped')) {
        replyCard.classList.add('msg-stopped');
        replyCard.append(el('div', { class: 'msg-interrupted', text: 'Stopped' }));
      }
      replyCard?.setAttribute('aria-busy', String(entry.status === 'processing'));
      call?.update(entry);
      syncSend();
      if (transcript) transcript.follow(); else scrollHost.scrollTop = scrollHost.scrollHeight;
      if (entry.status !== 'processing' && !finished) {
        finished = true;
        if (entry.status !== 'done') pausedQueues.add(id);
        Promise.resolve(options.onTurnEnd?.()).catch(() => {}).finally(() => { drawQueue(); sendNext(); });
      }
    };
    unsubscribe = chatStream.subscribe(id, paint);
    const current = chatStream.getInFlight(id);
    if (current) paint(current);
  };

  const showEmpty = () => {
    messages.replaceChildren(el('div', { class: 'agent-chat-empty' }, [
      el('div', { class: 'title', text: options.emptyTitle || 'Start the conversation' }),
      el('div', { class: 'meta', text: options.emptyText || '' }),
    ]));
  };

  const load = async () => {
    if (!sessionId) { showEmpty(); return; }
    try { session = await api(`/api/sessions/${sessionId}`); }
    catch (problem) {
      messages.replaceChildren(el('div', { class: 'agent-chat-empty' }, [
        el('div', { class: 'title', text: "This chat couldn't load" }),
        el('div', { class: 'meta', text: `${problem.message}. Reopen it to try again.` }),
      ]));
      return;
    }
    if (!host.isConnected) return;
    const shown = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    lastDay = '';
    const historyCards = shown.map((m) => card(m.role, m.content, m));
    messages.replaceChildren(...shown.flatMap((m, index) => [...dateMarker(m.ts), historyCards[index]]));
    if (transcript) await transcript.history(session);
    if (disposed) return;
    const current = chatStream.getInFlight(sessionId);
    // History may finish loading after the stream completes. Reattach the
    // retained entry, using a saved reply when present, so switches neither
    // duplicate this turn nor lose a reply that raced the history request.
    if (current) {
      const userIndex = shown.findLastIndex(m => m.role === 'user' && m.content === current.prompt && m.ts >= current.startedAt - 1);
      const savedIndex = shown.findIndex((m, index) => m.role === 'assistant' &&
        (current.runId ? m.run_id === current.runId : userIndex >= 0 && index === userIndex + 1));
      if (savedIndex >= 0) attach(historyCards[savedIndex].querySelector('.msg-body, .forge-prose'));
      else {
        if (userIndex < 0 && current.prompt) messages.append(card('user', current.prompt));
        const reply = card('assistant', ''); messages.append(reply); attach(reply.querySelector('.msg-body, .forge-prose'));
      }
    } else if (busy()) {
      const reply = card('assistant', '');
      messages.append(reply);
      attach(reply.querySelector('.msg-body, .forge-prose'));
    }
    if (!shown.length && !busy() && !current) showEmpty();
    if (transcript) transcript.follow(); else scrollHost.scrollTop = scrollHost.scrollHeight;
  };

  // Connection and model for this chat, the same choices as the chat
  // composer's picker. Saved on the chat, so Chats shows the same choice.
  const drawModelPicker = async () => {
    if (!options.modelPicker || !sessionId) return;
    let endpoints;
    try { endpoints = await api('/api/models/choices'); }
    catch { status.textContent = "Models couldn't load."; return; }
    if (!host.isConnected) return;
    const current = session || {};
    let phoneCatalog = [], phoneMenu, phoneTrigger;
    const refreshPhoneMenu = () => {
      if (!phoneMenu) return;
      const endpoint = endpoints.find(item => item.id === connection.value);
      phoneTrigger.textContent = [endpoint?.name || 'Choose model', current.model_override || endpoint?.model, current.model_effort].filter(Boolean).join(' · ');
      renderMobileCatalogMenu(phoneMenu, {
        endpoints, endpointId: connection.value, model: current.model_override, effort: current.model_effort, catalog: phoneCatalog,
        onConnection: value => { if (phoneTrigger.disabled) return; connection.value = value; connection.dispatchEvent(new Event('change')); },
        onModel: value => { if (!phoneTrigger.disabled) save(value, null); }, onEffort: value => { if (!phoneTrigger.disabled) save(current.model_override, value); },
      });
    };
    const connection = customSelect({}, [el('option', { value: '', text: endpoints.length ? 'Choose a model' : 'Add a model in Settings' }),
      ...endpoints.map((e) => el('option', { value: e.id, text: e.name }))]);
    connection.value = current.model_endpoint_id || '';
    let variantNode = customSelect({}, [el('option', { value: '', text: 'Default model' })]);
    variantNode.hidden = true;
    const loadVariants = async (selected) => {
      const endpoint = endpoints.find((e) => e.id === connection.value);
      if (!endpoint || ![...CLI_KINDS, 'api'].includes(endpoint.kind)) { variantNode.hidden = true; phoneCatalog = []; refreshPhoneMenu(); return; }
      let choices = [];
      try { choices = await api(`/api/models/${encodeURIComponent(endpoint.id)}/catalog`); } catch { /* default only */ }
      if (!host.isConnected) return;
      const next = customSelect({}, [el('option', { value: '', text: 'Default model' }),
        ...choices.map((m) => el('option', { value: m.id, text: m.display_name || m.id }))]);
      next.value = choices.some((m) => m.id === selected) ? selected : '';
      next.addEventListener('change', () => save(next.value || null));
      variantNode.replaceWith(next);
      variantNode = next;
      phoneCatalog = choices; refreshPhoneMenu();
      modelControls = [connection, variantNode]; syncSend();
    };
    const save = async (override, effort) => {
      if (busy() || options.readOnly) { status.textContent = 'Wait for the current reply before changing the model.'; return; }
      if (modelSaving || permissionSaving) return;
      modelSaving = true; syncSend();
      try {
        const saved = await api(`/api/sessions/${sessionId}/model`, { method: 'POST',
          body: JSON.stringify({ model_endpoint_id: connection.value || null, model_override: override, ...(effort === undefined ? {} : { effort }) }) });
        current.model_effort = saved.effort ?? null;
        status.textContent = '';
        current.model_endpoint_id = connection.value || null; current.model_override = override;
        options.onModelChange?.(endpoints.find(e => e.id === connection.value), override);
      } catch (problem) { connection.value = current.model_endpoint_id || ''; variantNode.value = current.model_override || ''; status.textContent = problem.message; }
      finally { modelSaving = false; syncSend(); refreshPhoneMenu(); }
    };
    connection.addEventListener('change', async () => { await save(null); await loadVariants(null); });
    const controls = el('div', { class: 'session-chat-models', role: 'group', 'aria-label': 'Model for this chat' }, [connection, variantNode]);
    tools.prepend(controls);
    if (transcript) {
      controls.classList.add('ms-phone-model-controls');
      phoneTrigger = el('button', { type: 'button', class: 'ms-embedded-model-trigger model-picker-btn', text: 'Choose model' });
      phoneMenu = el('div', { class: 'model-picker-menu hidden' }); tools.prepend(phoneTrigger, phoneMenu);
      const picker = mountMobileModelSheet({ trigger: phoneTrigger, menu: phoneMenu, permission: options.modeControl });
      const gate = () => { phoneTrigger.hidden = !mobileOn(); }; gate(); phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate);
      disposePhoneModels = () => { picker.dispose(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); };
      const syncTrigger = new MutationObserver(() => { phoneTrigger.disabled = connection.disabled; });
      syncTrigger.observe(connection.querySelector('button'), { attributes: true, attributeFilter: ['disabled'] });
      const dispose = disposePhoneModels; disposePhoneModels = () => { syncTrigger.disconnect(); dispose(); };
      refreshPhoneMenu();
    }
    modelControls = [connection, variantNode]; syncSend();
    await loadVariants(current.model_override || null);
  };

  const drawPermissionPicker = async () => {
    if (!options.permissionPicker || !sessionId || !session) return;
    let admin = false;
    try { admin = !!(await api('/api/auth/status')).is_admin; } catch { /* Base remains available. */ }
    if (disposed || !host.isConnected) return;
    const description = 'Auto approves routine chat tool requests. Codex Auto also removes its workspace sandbox. Blender and Higgsfield requests still require approval.';
    const picker = customSelect({}, [el('option', { value: 'base', text: 'Base' }),
      el('option', { value: 'auto', text: 'Auto', disabled: !admin })]);
    picker.querySelector('button').setAttribute('aria-label', 'Chat permission mode');
    const notice = el('div', { class: 'chat-permission-notice', text: description, hidden: true });
    const control = el('div', { class: 'session-chat-permissions', title: `${description} Auto is available only to admins.` }, [el('span', { class: 'meta', text: 'Mode' }), picker]);
    const sync = () => {
      picker.value = session.permission_mode === 'auto' ? 'auto' : 'base';
      control.dataset.mode = picker.value;
      notice.hidden = picker.value !== 'auto';
    };
    picker.addEventListener('change', async () => {
      const requested = picker.value;
      if (busy() || submitting || modelSaving || permissionSaving || options.readOnly || (requested === 'auto' && !admin)) { sync(); return; }
      permissionSaving = true; syncSend();
      try {
        const result = await api(`/api/sessions/${sessionId}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode: requested }) });
        session.permission_mode = result.mode;
      } catch (problem) { toast(problem.message, 'error'); }
      finally { permissionSaving = false; if (!disposed) { sync(); syncSend(); } }
    });
    permissionControl = picker;
    tools.insertBefore(control, status);
    composer.append(notice);
    sync(); syncSend();
  };

  if (options.openInChats) {
    tools.append(el('button', { type: 'button', class: 'btn quiet', text: 'Open in Chats', onclick: async () => {
      if (!sessionId) return;
      const app = await import('./app.js');
      await app.switchTab('chat');
      (await import('./views/chat.js')).openSessionById(sessionId);
    } }));
  }
  tools.append(status);
  if (options.agent && host.closest('.is-messages')) composer.append(tools);

  const runTurn = (text, selected = [], attached = []) => {
    messages.querySelector('.agent-chat-empty')?.remove();
    messages.append(...dateMarker());
    messages.append(card('user', text, { references: selected, attachments: attached }));
    const reply = card('assistant', ''); messages.append(reply);
    let entry;
    // startTurn notifies synchronously, so detach the previous reply first.
    unsubscribe(); unsubscribe = () => {};
    try { entry = chatStream.startTurn(sessionId, session?.title || label, text, attached.map(item => item.id), selected); }
    catch (error) { toast(error.message, 'error'); reply.remove(); pausedQueues.add(sessionId); return; }
    attach(reply.querySelector('.msg-body, .forge-prose')); syncSend(); if (transcript) transcript.follow(); else scrollHost.scrollTop = scrollHost.scrollHeight;
    return entry;
  };
  if (options.agent && !options.readOnly) {
    call = agentCall(options.agent, {
      busy,
      sessionId: () => sessionId,
      async ensureSession() {
        if (disposed || submitting || permissionSaving) throw new Error('Finish the current chat action first.');
        if (!sessionId) {
          submitting=true;syncSend();
          try { sessionId = await options.createSession(); session = await api(`/api/sessions/${sessionId}`); }
          finally { submitting=false;syncSend(); }
        }
        return sessionId;
      },
      async summarySaved(record) {
        if (disposed || record.parent_id!==sessionId) return;
        // Upsert only this call card so a concurrent typed reply and drafts
        // retain their DOM, subscriptions and buffered rendering.
        const saved = await api(`/api/sessions/${sessionId}`);
        if (disposed) return;
        const message = saved.messages.find(m => m.call_summary_id === record.id);
        if (!message) return;
        const existing = [...messages.querySelectorAll('[data-call-summary]')].find(n => n.dataset.callSummary === record.id);
        const node = card('assistant', message.content, message); node.dataset.callSummary = record.id;
        if (existing) existing.replaceWith(node); else { messages.querySelector('.agent-chat-empty')?.remove(); messages.append(node); }
        options.onTurnEnd?.();
      },
    });
    const callHost = host.closest('.agent-conversation-page')?.querySelector('.agent-topbar-tools') || tools;
    callHost.prepend(call.button);
  }
  const submit = async ({ fromKeyboard = false, enqueue = false } = {}) => {
    if (options.readOnly || submitting || permissionSaving || disposed) return;
    if (attachments?.busy()) { toast('Wait for the reference uploads to finish.', 'error'); return; }
    if (busy()) {
      if (options.queue && (fromKeyboard || enqueue)) {
        if (!input.value.trim()) return;
        const queued = queues.get(sessionId) || []; queues.set(sessionId, queued);
        queued.push({ text: input.value.trim(), references: references.getSelected(), attachments: attachments?.getSelected() || [] });
        input.value = ''; references.clear(); attachments?.clear(); drawQueue();
      } else if (fromKeyboard) toast('A reply is still running. Wait for it, or press Stop.', 'error');
      else chatStream.stopTurn(sessionId);
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    if (!sessionId) {
      submitting = true;
      try { sessionId = await options.createSession(); if (options.agent) session = await api(`/api/sessions/${sessionId}`); }
      catch (problem) { toast(problem.message, 'error'); return; }
      finally { submitting = false; }
      if (disposed) return;
    }
    const selected = references.getSelected();
    const attached = attachments?.getSelected() || [];
    if (attached.length) {
      submitting = true; syncSend();
      try { await api('/api/chat/validate-attachments', { method: 'POST',
        toast: false, body: JSON.stringify({ session_id: sessionId, attachment_ids: attached.map(item => item.id) }) }); }
      catch (problem) { toast(problem.message, 'error'); return; }
      finally { submitting = false; syncSend(); }
      if (disposed) return;
    }
    references.clear();
    attachments?.clear();
    input.value = ''; input.style.height = 'auto';
    runTurn(text, selected, attached);
  };

  send.addEventListener('click', () => submit());
  queueButton.addEventListener('click', () => submit({ enqueue: true }));
  input.addEventListener('keydown', (event) => {
    if (shouldSendOnEnter(event)) { event.preventDefault(); submit({ fromKeyboard: true }); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  await load();
  const unsubscribeLive = chatStream.subscribeAll((id, entry) => {
    if (disposed || !host.isConnected || id !== sessionId || !entry || entry.local ||
        entry.status !== 'processing' || liveTurnId === entry.turnId) return;
    messages.querySelector('.agent-chat-empty')?.remove();
    messages.append(card('user', entry.prompt));
    const reply = card('assistant', '');
    messages.append(reply);
    attach(reply.querySelector('.msg-body, .forge-prose'));
  });
  await drawModelPicker();
  await drawPermissionPicker();
  syncSend();
  if (queues.get(sessionId)?.length && !busy()) pausedQueues.add(sessionId);
  drawQueue();
  if (options.initialMessage && session && !session.messages.length && !disposed && host.isConnected) { input.value = options.initialMessage; await submit(); }
  else if (options.initialMessage && !session) input.value = options.initialMessage;
  return () => { disposeAnchor(); disposePhoneModels(); disposed = true; call?.dispose(); recorder?.cancel(); attachments?.dispose(); if (shownPermission) dismissPermissionPrompt(shownPermission); clearInterval(workingTimer); if (queues.get(sessionId)?.length) pausedQueues.add(sessionId); unsubscribe(); unsubscribeLive(); references.dispose(); handoffs.dispose(); transcript?.dispose(); };
}
