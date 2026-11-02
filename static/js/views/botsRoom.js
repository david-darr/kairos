// A room owns its transcript and feed. Seat sessions never enter this view.
import { h, Button, isAdvanced, onBotsInterface, loadBotsCss, applyBotsInterface } from '../botsUi.js';
import { botKip } from '../botsKip.js';
import { createRoomModel, roomPath, memberId, memberState, memberStateLabel, heldMembers, responderLabel,
  roomMentionItems, queuePositions, mergeMessages, roomSendPayload } from '../botsRoomModel.js';
import { createRoomStream } from '../botsRoomStream.js';
import { mountTranscript } from '../botsTranscript.js';
import { mountBotsComposer, createSendController } from '../botsComposer.js';
import { createBotDraft } from '../botsDrafts.js';
import { renderMessageBody } from '../chatContent.js';
import { roomCall, openRoomPanel, openRoomMembers, openRoomThreads, mountSetup } from '../botsRoomPanel.js';
import { teamRowRenderers } from '../botsTeamChips.js';
import { renderWidget } from '../botsWidget.js';
import { goalCard } from '../botsGoalCard.js';

const CSS = ['bots.css', 'bots-chat.css', 'bots-composer.css', 'bots-rooms.css'];
const enc = encodeURIComponent;
const go = target => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: target }));

export async function mountRoom(host, options) {
  const { roomId, call = roomCall } = options;
  if (!roomId) throw new Error('Choose a room to open.');
  await Promise.all(CSS.map(file => loadBotsCss(`/static/css/${file}`)));
  if (options.signal?.aborted) throw new Error('Room closed.');
  applyBotsInterface();
  let disposed = false, composer = null, draft = null, setup = null, dialog = null, callAdapter = null;
  let selectedThread = options.threadId || null, draftThread = null, person = options.person || '', older = null, loadingAll = null;
  let selectionRevision = 0, switching = false;
  let readTimer = null, lastReadSeq = -1;
  let paintedPin;
  const modalAbort = new AbortController();
  const model = createRoomModel(roomId, selectedThread), state = model.state;
  const root = h('section', { class: 'bots-room', 'data-room-id': roomId });
  const error = h('div', { class: 'bots-room-error', role: 'alert', hidden: true });
  const title = Button({ label: 'Room', onClick: async () => { dialog = await openRoomPanel({ roomId, opener: title, signal: modalAbort.signal, onChanged: () => refresh() }); } });
  title.classList.add('bots-room-title');
  const members = h('div', { class: 'bots-room-faces', 'aria-label': 'Members' });
  const callSlot = h('span', { class: 'bots-room-call' });
  const membersButton = Button({ label: 'Members', onClick: async () => { dialog = await openRoomMembers({ roomId, opener: membersButton, signal: modalAbort.signal, onChanged: () => refresh() }); } });
  const threadPicker = h('select', { 'aria-label': 'Room conversation' });
  const advanced = h('div', { class: 'bots-room-advanced' });
  const findInput = h('input', { type: 'search', 'aria-label': 'Find in room', placeholder: 'Find in room' });
  const findCount = h('span', { role: 'status' });
  const findBar = h('div', { class: 'bots-room-find', role: 'search', hidden: true }, [findInput, findCount,
    Button({ label: 'Next', onClick: () => findNext() }), Button({ label: 'Close find', onClick: () => { findBar.hidden = true; composer?.focus(); } })]);
  const findButton = Button({ label: 'Find', onClick: () => showFind() });
  const exportButton = Button({ label: 'Export', onClick: () => exportRoom().catch(showError) });
  const responderSelect = h('select', { 'aria-label': 'Who answers by default' });
  const limit = h('input', { type: 'number', min: '1', max: '1440', 'aria-label': 'Turn limit in minutes', title: 'Turn limit in minutes' });
  const conversationsButton = Button({ label: 'Conversations', onClick: async () => { dialog = await openRoomThreads({ roomId, threadId: state.threadId, signal: modalAbort.signal,
    opener: conversationsButton, onPick: id => selectThread(id), call }); } });
  advanced.append(conversationsButton, findButton, exportButton, responderSelect, limit);
  const banners = h('div', { class: 'bots-room-banners' });
  const setupHost = h('div', { class: 'bots-room-setup-host' });
  const empty = h('div', { class: 'bots-room-empty' });
  const transcriptHost = h('div', { class: 'bots-transcript-host' });
  const goalHost = h('div', { class: 'bots-room-goal-host', 'aria-live': 'polite' });
  const composerHost = h('div', { class: 'bots-composer-host' });
  // A member's approvals and questions are raised in its seat session, which the room never shows; answer them here.
  const seatCards = h('div', { class: 'bots-room-seat-cards' });
  const seatPanels = new Map();   // seat session id -> Promise of the mounted cards panel
  root.append(h('header', { class: 'bots-room-header' }, [title, threadPicker, members, advanced, callSlot, membersButton]), findBar, error, banners, setupHost, empty, transcriptHost, goalHost, seatCards, composerHost);
  host.replaceChildren(root);

  const agentFor = botId => { const m = state.room?.members.find(m => memberId(m) === botId); return { ...m, id: botId, name: m?.name || 'Bot' }; };
  const busy = () => !!state.live.size || state.goal?.status === 'working' || !!state.room?.members.some(m => m.working || m.waiting);
  const newestRetry = () => { const m = state.messages.at(-1); return m && (m.meta?.retry || ['cancelled', 'interrupted', 'timed_out', 'stalled', 'provider_failed'].includes(m.meta?.outcome)) ? m : null; };
  const transcript = mountTranscript(transcriptHost, {
    agent: { name: 'room' }, sessionId: '', room: true, speakerLabels: true,
    // A bot's card in the room (services/bot_widgets.py): drawn like a chat card, answered through the room.
    rowRenderers: { ...teamRowRenderers, widget: row => renderWidget({ id: row.message.id, widget: row.message.meta?.widget },
      { pressUrl: `${roomPath(roomId)}/widgets/press`, refresh: () => refresh() }) },
    messageAgent: m => agentFor(m.bot_id), liveAgent: entry => agentFor(entry.bot_id),
    kip: (bot, size, status) => botKip(bot, { size, state: status }),
    simple: () => !isAdvanced(), renderBody: (node, text, live) => renderMessageBody(node, text, '', true, { live }),
    getContext: () => ({ busy: busy(), pinnedId: state.room?.pinned_message_id }), onNeedOlder: () => loadOlder(), onNeedNewer: () => refresh(),
    canRetry: message => !busy() && newestRetry()?.id === message.id,
    onRetry: message => retry(message).catch(showError), onStopGoal: () => stop(), openTarget: target => go(target),
    jump: async id => { if (!transcript.scrollToMessage(id)) { await allMessages(); if (!disposed) transcript.scrollToMessage(id); } },
    onUnpin: () => action('', { expected_revision: state.room.revision, pinned_message_id: null }, 'PATCH').catch(() => {}),
    handlers: {
      reply: message => { draft.update({ reply_to_id: message.id }); composer.paint(); composer.focus(); },
      copy: async message => { try { await navigator.clipboard.writeText(message.content || ''); } catch (problem) { showError(problem); } },
      pin: message => action('', { expected_revision: state.room.revision, pinned_message_id: state.room.pinned_message_id === message.id ? null : message.id }, 'PATCH').catch(() => {}),
    },
  });
  let displayed = [];
  function showError(problem) { if (!disposed) { error.hidden = false; error.textContent = problem?.message || String(problem); } }
  function clearError() { error.hidden = true; error.textContent = ''; }
  async function action(path, body, method = 'POST') {
    try { await call(`${roomPath(roomId)}${path}`, method, body); await refresh(); }
    catch (problem) { showError(problem); throw problem; }
  }
  function stop(botId) { return action('/stop', { ...(botId ? { bot_id: botId } : {}), thread_id: state.threadId }).catch(() => {}); }
  function refresh() { return stream.refresh().catch(() => {}); }
  function drawMessages() {
    const normalized = state.messages.map(m => ({ ...m, kind: m.kind === 'text' ? null : m.kind, role: m.role === 'person' ? 'user' : m.role === 'bot' ? 'assistant' : 'system', content: m.text, ts: m.created_at }));
    if (!displayed.length) transcript.setMessages(normalized);
    else {
      const first = transcript.get(transcript.loadedIds()[0])?.seq || 0;
      const olderRows = normalized.filter(m => !transcript.has(m.id) && m.seq < first);
      if (olderRows.length) transcript.prepend(olderRows);
      normalized.forEach(m => {
        const previous = transcript.get(m.id);
        if (!previous) { if (transcript.isFollowing()) transcript.append(m); else transcript.appendPage([m]); }
        else if (previous.content !== m.content || JSON.stringify(previous.meta) !== JSON.stringify(m.meta)) transcript.patch(m.id, m);
      });
    }
    displayed = normalized.map(m => m.id);
    const latestLive = [...state.live.values()].at(-1);
    transcript.setLive(latestLive ? { ...latestLive, turnId: latestLive.turn_id, status: 'processing', text: latestLive.text || '', startedAt: latestLive.startedAt || latestLive.started_at || Date.now() / 1000 } : null);
    // Retry eligibility changes when the room becomes idle without a new row.
    if (state.messages.some(m => m.meta?.retry)) transcript.redraw();
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const seq = Math.max(state.room?.last_seq || 0, state.messages.at(-1)?.seq || 0);
      if (!disposed && !document.hidden && document.hasFocus() && transcript.isFollowing() && seq > lastReadSeq) {
        lastReadSeq = seq;
        call(`${roomPath(roomId)}/read`, 'POST', { seq }).catch(() => { lastReadSeq = -1; });
      }
    }, 300);
  }
  function paint() {
    if (disposed || !state.room) return;
    if (state.deleted) { composer?.setState({ locked: true, lockedReason: 'This room was deleted.' }); showError('This room was deleted.'); return; }
    const room = state.room;
    title.textContent = room.name;
    advanced.hidden = !isAdvanced();
    if (document.activeElement !== threadPicker) {
      threadPicker.replaceChildren(...room.threads.map((t, i) => h('option', { value: t.id, text: t.title || `Conversation ${i + 1}` })));
      threadPicker.value = state.threadId;
    }
    if (document.activeElement !== responderSelect) {
      responderSelect.replaceChildren(...[{ value: 'auto', text: 'Auto' }, { value: 'everyone', text: 'Everyone' }, { value: 'mentions', text: 'Mentions only' },
        ...room.members.map(m => ({ value: memberId(m), text: m.name }))].map(v => h('option', v)));
      responderSelect.value = room.default_responder.kind === 'member' ? room.default_responder.bot_id : room.default_responder.kind;
    }
    if (document.activeElement !== limit) limit.value = room.turn_timeout_minutes;
    syncSeatCards();
    callSlot.hidden = !!room.archived_at || room.setup_state === 'pending' || !room.members.some(m => !m.held);
    members.replaceChildren(...room.members.map(m => h('button', { type: 'button', class: 'bots-room-face', 'data-bot-id': memberId(m), 'data-state': memberState(m),
      title: `${m.name}: ${memberStateLabel(m)}`, 'aria-label': `${m.name}: ${memberStateLabel(m)}`, onclick: () => membersButton.click() },
    [botKip(agentFor(memberId(m)), { size: 26, state: m.working ? 'working' : 'idle' }), m.held ? h('span', { class: 'bots-room-pause', text: 'Ⅱ', 'aria-hidden': 'true' }) : null])));
    banners.replaceChildren();
    const held = heldMembers(room);
    if (held.length) banners.append(h('div', { class: 'bots-room-held' }, [h('span', { text: `Held: ${held.map(m => m.name).join(', ')}` }),
      ...held.map(m => Button({ label: `Resume ${m.name}`, onClick: () => action('/holds', { bot_id: memberId(m), held: false }).catch(() => {}) }))]));
    if (room.bulletin) banners.append(h('details', { class: 'bots-room-bulletin' }, [h('summary', { text: 'Room instructions' }), h('p', { text: room.bulletin })]));
    const working = room.members.filter(m => m.working || m.waiting);
    const queue = queuePositions(state.queue, working.map(m => m.name).join(', '));
    if (queue.length) banners.append(h('ol', { class: 'bots-room-queue', 'aria-label': 'Room queue' }, queue.map(item => h('li', { 'data-queue-id': item.id }, [
      h('span', { text: item.label }), Button({ label: 'Cancel', disabled: item.state === 'dispatching', onClick: () => action(`/queue/${enc(item.id)}`, undefined, 'DELETE').catch(() => {}) })]))));
    if (working.length || state.goal?.status === 'working') banners.append(h('div', { class: 'bots-room-stops' }, [
      ...working.map(m => Button({ label: `Stop ${m.name}`, onClick: () => stop(memberId(m)) })), Button({ label: 'Stop all', onClick: () => stop() })]));
    empty.hidden = state.messages.length > 0 || state.live.size > 0 || room.setup_state === 'pending';
    if (!empty.hidden) empty.replaceChildren(h('div', { class: 'bots-room-empty-faces' }, room.members.slice(0, 3).map(m => botKip(agentFor(memberId(m)), { size: 44 }))),
      h('strong', { text: room.name }), h('p', { text: responderLabel(room.default_responder, room.members) }));
    composer?.setState({ busy: busy(), locked: switching || !!room.archived_at || room.setup_state === 'pending', lockedReason: switching ? 'Loading conversation.' : room.archived_at ? 'This room is closed.' : 'Set up this room first.' });
    goalHost.replaceChildren(...(state.goal ? [goalCard(state.goal, { onStop: () => stop() })] : []));
    const pinned = state.messages.find(m => m.id === room.pinned_message_id);
    transcript.renderPinned(pinned ? { ...pinned, content: pinned.text } : null);
    if (paintedPin !== room.pinned_message_id) { paintedPin = room.pinned_message_id; transcript.redraw(); }
    if (room.setup_state === 'pending' && !room.archived_at) {
      if (!setup) setup = mountSetup(setupHost, { room, call, onSaved: () => refresh() });
    } else { setup?.destroy(); setup = null; }
  }
  // A group call with the room's members (agentCall.js room mode). It opens with the room's chosen responder.
  const callable = () => (state.room?.members || []).filter(m => !m.held).map(memberId);
  async function mountCall() {
    if (callAdapter || options.readOnly) return;
    const { agentCall } = await import('../agentCall.js');
    if (disposed || callAdapter || !state.room) return;
    callAdapter = agentCall({ id: `room-${roomId}`, roomId, name: state.room.name, call_mode: 'turns' }, {
      roomId: () => roomId, sessionId: () => roomId, ensureSession: async () => roomId, memberIds: callable, memberName: id => agentFor(id).name,
      agentId: () => { const r = state.room.default_responder, ids = callable(); return r?.kind === 'member' && ids.includes(r.bot_id) ? r.bot_id : ids[0]; },
      busy: () => busy(), summarySaved: async () => { await refresh(); },
    });
    callSlot.replaceChildren(callAdapter.button);
  }
  function syncSeatCards() {
    const seats = new Map((state.room?.members || []).filter(m => m.seat_session_id).map(m => [m.seat_session_id, m]));
    for (const [seat, panel] of seatPanels) {
      if (seats.has(seat)) continue;
      panel.then(p => p?.dispose?.()).catch(() => {}); seatPanels.delete(seat);
      seatCards.querySelector(`[data-seat="${CSS.escape(seat)}"]`)?.remove();
    }
    for (const [seat, member] of seats) {
      if (seatPanels.has(seat)) { seatPanels.get(seat).then(p => p?.refresh?.()).catch(() => {}); continue; }
      const holder = h('section', { class: 'bots-room-seat-card', 'data-seat': seat, 'aria-label': `${member.name} needs your answer`, hidden: true },
        [h('strong', { class: 'bots-room-speaker', text: member.name })]);
      seatCards.append(holder);
      seatPanels.set(seat, import('../botsApprovalCards.js').then(mod => (disposed ? null : mod.mount(holder, {
        agentId: memberId(member), threadId: seat, slot: 'composer', signal: modalAbort.signal, onPending: waiting => { holder.hidden = !waiting; } }))));
    }
  }
  function makeComposer() {
    if (draftThread === state.threadId) return;
    composer?.dispose(); draftThread = state.threadId;
    draft = createBotDraft({ person: person || 'local', bot: `room:${roomId}`, thread: draftThread });
    const sender = createSendController({ draft, getLeaf: () => null, flushSettings: async () => ({ ok: true }),
      request: payload => call(`${roomPath(roomId)}/messages`, 'POST', roomSendPayload(payload, draftThread)),
      onAccepted: async () => { options.onChanged?.(roomId); await refresh(); } });
    composer = mountBotsComposer(composerHost, { draft, name: state.room.name, room: true, attachments: false,
      form: () => matchMedia('(max-width: 768px)').matches ? 'phone' : isAdvanced() ? 'advanced' : 'simple',
      submit: () => sender.send(), stop: () => stop(), mentionSource: token => roomMentionItems(token, state.room.members) });
  }
  async function hydrate() {
    const selection = selectionRevision;
    const room = await call(roomPath(roomId));
    const tid = selectedThread || room.threads[0]?.id;
    if (!tid || !room.threads.some(t => t.id === tid)) throw new Error('That conversation could not be found.');
    if (!person) { try { person = (await call('/api/auth/status')).username || 'local'; } catch { person = 'local'; } }
    const [page, queue, goal] = await Promise.all([call(`${roomPath(roomId)}/messages?limit=50&thread_id=${enc(tid)}`),
      call(`${roomPath(roomId)}/queue?thread_id=${enc(tid)}`), call(`${roomPath(roomId)}/threads/${enc(tid)}/goal`)]);
    if (disposed || selection !== selectionRevision) return;
    if (state.threadId === tid) page.messages = mergeMessages(state.messages, page.messages);
    model.hydrate({ room, page, queue, goal });
    selectedThread = state.threadId; switching = false; makeComposer(); clearError(); drawMessages(); paint();
    mountCall().catch(() => {});
  }
  const stream = createRoomStream({ hydrate, sourceFactory: options.sourceFactory,
    apply: frame => { if (model.apply(frame)) { drawMessages(); paint(); options.onChanged?.(roomId); } }, onError: showError });
  async function loadOlder() {
    if (!state.hasMore || older) return older;
    const tid = state.threadId, first = state.messages[0]?.seq;
    older = call(`${roomPath(roomId)}/messages?limit=200&thread_id=${enc(tid)}&before=${first}`).then(page => {
      if (disposed || state.threadId !== tid) return;
      state.messages = mergeMessages(page.messages, state.messages); state.hasMore = page.has_more;
      transcript.prepend(page.messages.map(m => ({ ...m, kind: m.kind === 'text' ? null : m.kind, role: m.role === 'person' ? 'user' : m.role === 'bot' ? 'assistant' : 'system', content: m.text, ts: m.created_at })));
      displayed = state.messages.map(m => m.id);
    }).catch(showError).finally(() => { older = null; });
    return older;
  }
  async function allMessages() {
    if (loadingAll) return loadingAll;
    loadingAll = (async () => { while (state.hasMore && !disposed) { const first = state.messages[0]?.id; await loadOlder(); if (first === state.messages[0]?.id) break; } return state.messages; })().finally(() => { loadingAll = null; });
    return loadingAll;
  }
  let hits = [], hitAt = -1, findRevision = 0;
  async function runFind() {
    const revision = ++findRevision, query = findInput.value.trim().toLocaleLowerCase();
    if (!query) { hits = []; hitAt = -1; findCount.textContent = ''; return; }
    findCount.textContent = 'Searching';
    const rows = await allMessages();
    if (disposed || revision !== findRevision) return;
    hits = rows.filter(m => m.text.toLocaleLowerCase().includes(query)); hitAt = -1; findNext();
  }
  function findNext() { if (!hits.length) { findCount.textContent = 'No matches'; return; } hitAt = (hitAt + 1) % hits.length; transcript.scrollToMessage(hits[hitAt].id); findCount.textContent = `${hitAt + 1} of ${hits.length}`; }
  function showFind() { findBar.hidden = false; findInput.focus(); }
  findInput.addEventListener('input', () => runFind().catch(showError));
  findInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); findNext(); } });
  async function exportRoom() {
    const tid = state.threadId, rows = await allMessages(); if (disposed || tid !== state.threadId) return;
    const text = `# ${state.room.name}\n\n${rows.map(m => `## ${m.role === 'person' ? 'You' : m.bot_id ? agentFor(m.bot_id).name : 'Room'}\n\n${m.text}`).join('\n\n')}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = h('a', { href: url, download: 'room.md' }); root.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function retry(message) {
    if (busy() || newestRetry()?.id !== message.id) return;
    const botId = message.bot_id || message.meta?.bot_id;
    const mention = roomMentionItems({ query: '' }, state.room.members).find(m => m.id === botId)?.label || '';
    // The last person row may be a queued message, so never guess which text
    // started a cancelled turn. Ask that member to retry in the room context.
    const retryDraft = createBotDraft({ person: person || 'local', bot: `room:${roomId}`, thread: `${state.threadId}:retry:${message.id}` });
    if (!retryDraft.read().pending) retryDraft.update({ text: `${mention} Please try your last room reply again.`.trim() });
    const tid = state.threadId;
    try { await createSendController({ draft: retryDraft, getLeaf: () => null, flushSettings: async () => ({ ok: true }),
      request: payload => call(`${roomPath(roomId)}/messages`, 'POST', roomSendPayload(payload, tid)), onAccepted: () => refresh() }).send(); }
    finally { retryDraft.dispose(); }
  }
  function selectThread(id) {
    if (!id) return;
    selectedThread = id; selectionRevision++; switching = true; findRevision++; hits = []; findCount.textContent = '';
    draft?.flush(); displayed = []; composer?.setState({ locked: true, lockedReason: 'Loading conversation.' }); stream.refresh().catch(showError);
  }
  threadPicker.addEventListener('change', () => selectThread(threadPicker.value));
  responderSelect.addEventListener('change', () => { const value = responderSelect.value; action('', { expected_revision: state.room.revision,
    default_responder: ['auto', 'everyone', 'mentions'].includes(value) ? { kind: value } : { kind: 'member', bot_id: value } }, 'PATCH').catch(() => {}); });
  limit.addEventListener('change', () => action('', { expected_revision: state.room.revision, turn_timeout_minutes: Number(limit.value) }, 'PATCH').catch(() => {}));
  const onKey = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && root.isConnected) { event.preventDefault(); showFind(); } };
  root.addEventListener('keydown', onKey);
  const offInterface = onBotsInterface(() => { paint(); composer?.paint(); });
  const poll = setInterval(() => { if (!document.hidden && !disposed) refresh(); }, 5000);
  const handle = { root, model, stream, refresh, flush: async () => ({ ok: draft?.flush() !== false }), focus: () => composer?.focus(), exportRoom,
    destroy() { if (disposed) return; disposed = true; findRevision++; clearInterval(poll); callAdapter?.dispose();
      for (const panel of seatPanels.values()) panel.then(p => p?.dispose?.()).catch(() => {}); clearTimeout(readTimer); offInterface(); modalAbort.abort(); dialog?.close(); stream.destroy(); composer?.dispose(); setup?.destroy(); transcript.dispose(); root.remove(); options.signal?.removeEventListener('abort', handle.destroy); } };
  options.signal?.addEventListener('abort', handle.destroy, { once: true });
  if (options.signal?.aborted) handle.destroy();
  try { await stream.start(); }
  catch (problem) { if (!disposed) { showError(problem); error.append(Button({ label: 'Try again', onClick: () => refresh() })); } }
  if (options.messageId && !disposed) { await allMessages(); if (!disposed) transcript.scrollToMessage(options.messageId); }
  return handle;
}

// The shell can leave while HTTP state is pending. Cleanup is available at once.
export function render(container, tabId, options = {}) {
  let disposed = false, mounted = null;
  const controller = new AbortController();
  mountRoom(container, { ...options, signal: controller.signal }).then(handle => { if (disposed) handle.destroy(); else mounted = handle; }).catch(error => {
    if (!disposed) container.replaceChildren(h('p', { role: 'alert', text: error.message || 'This room could not load.' }));
  });
  return () => { disposed = true; controller.abort(); mounted?.destroy(); };
}
