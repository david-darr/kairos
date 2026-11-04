// A Bots conversation (Agents 3.0 Phase 1, unit U3): mountBotsChat() replaces mountAgentChat() for
// Bots mode. Ordinary Chats, tab chats and Forge keep their own renderer.
//
// It speaks U1's contract (phase-1-design.md, section 5.1) and the existing live feed:
//   GET  /api/bot-chat/{sid}/state          -> { active_leaf_id, branch_revision, last_read_message_id, pinned_message_id,
//                                               queue:{items:[{id,text,state}],revision,paused}, goal, model:{label},
//                                               capabilities:{steer,queueing,images,speech}, turn:{id}, context:{percent} }
//   GET  /api/bot-chat/{sid}/messages       -> { messages, has_before, has_after, active_leaf_id, branch_revision }
//   POST /api/bot-chat/{sid}/send           -> { message, turn_id } | { queued:true, queue_id, reason }
//   queue edit / delete / steer / resume, interrupt, message edit, regenerate, active-branch, reaction, pin, read, compact,
//   export, search and presence as listed there. Live text, tools and permissions still arrive through chatStream.js.
import { api, toast } from './api.js';
import { h, applyReaction } from './botsMessageActions.js';
import { icon } from './botsIcons.js';
import { openMenu, isAdvanced, onBotsInterface, loadBotsCss } from './botsUi.js';
import { botKip } from './botsKip.js';
import * as chatStream from './chatStream.js';
import { renderMessageBody, copyText } from './chatContent.js';
import { showPermissionPrompt, dismissPermissionPrompt } from './permissionPrompt.js';
import { createBotDraft } from './botsDrafts.js';
import { mountBotsComposer, createSendController, sendKey, redactForSupport } from './botsComposer.js';
import { mountTranscript, announcementFor } from './botsTranscript.js';
import { botRowRenderers } from './botsRowKinds.js';
import { createUploader, shouldChipPaste } from './botsChatAttachments.js';
import { mountFindBar, landOnHit, searchUrl, downloadExport } from './botsChatSearch.js';
import { agentCall } from './agentCall.js';
import { createRecorder, transcribeBlob, getSpeechStatus, isRecordingSupported } from './voiceInput.js';
import { createSpeaker, isSpeechOutputSupported } from './voiceOutput.js';
import { loadSkillCommands } from './botsSkillCommands.js';
import { currentDataContext } from './botsDataModel.js';
import { list as pointedList, clearPointed, mountPointChips } from './botsPoint.js';

const CSS = ['/static/css/bots-chat.css', '/static/css/bots-composer.css'];
const PAGE = 200, FIRST_PAGE = 50, PRESENCE_MS = 60000, QUEUE_POLL_MS = 5000, SEND_KEY = 'kairos:bots-send-key';
const enc = encodeURIComponent;

// api() reports a refusal as "409: detail"; the send controller needs the number to tell a refusal from a lost reply.
async function call(path, { method = 'GET', body } = {}) {
  try {
    return await api(path, { method, cache: method === 'GET' ? 'no-store' : undefined, body: body === undefined ? undefined : JSON.stringify(body), toast: false });
  } catch (error) {
    const found = /^(\d{3}): ([\s\S]*)$/.exec(error?.message || '');
    if (found) { error.status = Number(found[1]); error.message = found[2] || `Request failed (${found[1]})`; }
    throw error;
  }
}
const sendKeyPreference = () => { try { const v = localStorage.getItem(SEND_KEY); return ['enter', 'shift-enter', 'mod-enter'].includes(v) ? v : 'enter'; } catch { return 'enter'; } };
const uuid = () => crypto.randomUUID();
const asQueue = raw => {
  const list = Array.isArray(raw) ? raw : raw?.items || [];
  return { items: list.map(i => ({ id: i.id, text: String(i.text || i.payload?.text || ''), state: i.state || 'pending', attachment_ids: i.attachment_ids || i.payload?.attachment_ids || [] })).filter(i => i.id && i.state !== 'cancelled' && i.state !== 'consumed'),
    revision: raw?.revision ?? 0, paused: !!raw?.paused || list.some(i => i.state === 'interrupted') };
};
// The server reports a session's newest turn for minutes after it ends; only one still processing is running here
// (2026-11-03: a finished reply read as running, so reopening the chat showed "Thinking" for it).
const runningTurnId = turn => turn && (turn.status ?? 'processing') === 'processing' ? turn.id || null : null;
function readState(raw = {}) {
  const caps = raw.capabilities || {};
  return { leaf: raw.active_leaf_id ?? null, revision: raw.branch_revision ?? raw.revision ?? 0, readId: raw.last_read_message_id ?? null, pinnedId: raw.pinned_message_id ?? null,
    queue: asQueue(raw.queue), goal: raw.goal || null, model: raw.model?.label || raw.effective_model?.label || '', turnId: runningTurnId(raw.turn) || raw.running_turn_id || null,
    caps: { steer: !!caps.steer, queueing: caps.queueing !== false, images: caps.images !== false, speech: caps.speech !== false }, contextPercent: raw.context?.percent ?? null };
}

// options: agent, sessionId, initialMessage (a message ID to land on), onThreadChanged(sessionId, why), person, flushSettings(), mentions()
export async function mountBotsChat(host, options) {
  let agent = options.agent;
  const sid = options.sessionId;
  await Promise.all(CSS.map(href => loadBotsCss(href)));
  let disposed = false, state = readState(), settled = null, shownPermission = null, placeholderTurn = null, hasBefore = false, hasAfter = false;
  const timers = new Set(), offs = [];
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, ms); timers.add(t); return t; };
  const phone = typeof matchMedia === 'function' ? matchMedia('(max-width: 768px)') : { matches: false };

  const root = h('div', { class: 'bots-chat', 'data-session-id': sid, 'data-bots-agent-id': agent.id, 'data-bots-session-id': sid });
  host.replaceChildren(root);
  const scheduled = agent.enabled === false || agent.status === 'off' || agent.status === 'capped' || (Number.isFinite(agent.daily_run_cap) && agent.runs_today >= agent.daily_run_cap);
  if (scheduled) root.append(h('p', { class: 'bots-chat-honesty', text: `${agent.name} will answer here, but will not pick up scheduled work while turned off or capped.` }));
  const contextPill = h('button', { type: 'button', class: 'bots-pill bots-context-pill', hidden: true, onclick: () => compact() });
  const findButton = h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Find in this conversation', title: 'Find (Ctrl+F)', onclick: () => find.toggle() }, [icon('search', { size: 17 })]);
  const moreButton = h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Conversation actions', title: 'Conversation actions', 'aria-haspopup': 'menu' }, [icon('ellipsis', { size: 17 })]);
  const toolbar = h('div', { class: 'bots-chat-toolbar' }, [h('span', { class: 'bots-head-fill' }), contextPill, findButton, moreButton]);
  const goalHost = h('div', { class: 'bots-goal-host' });
  const composerHost = h('div', { class: 'bots-composer-host' });
  const transcriptHost = h('div', { class: 'bots-transcript-host' });
  root.append(toolbar, transcriptHost, goalHost, composerHost);
  const cardTranscript = h('div', { class: 'bots-card-transcript' });
  const cardComposer = h('div', { class: 'bots-card-composer' });
  const limitHost = h('div', { class: 'bots-limit-host' });
  root.insertBefore(cardTranscript, goalHost);
  root.insertBefore(cardComposer, composerHost);
  // Point mode's chips (Phase 6) sit just above the composer and leave with the next message.
  const pointHost = h('div', { class: 'bots-point-host' });
  root.insertBefore(pointHost, composerHost);
  const pointChips = mountPointChips(pointHost);
  offs.push(() => pointChips.destroy());
  toolbar.prepend(limitHost);
  const control = new AbortController();
  offs.push(() => control.abort());
  const mountPiece = async (path, host, extra = {}) => {
    const module = await import(path);
    if (disposed) return;
    const piece = await module.mount(host, { agentId: agent.id, threadId: sid, signal: control.signal, ...extra });
    const end = () => (piece?.dispose || piece?.destroy)?.call(piece);  // pieces return {dispose} or {destroy}
    if (disposed) end(); else offs.push(end);
  };
  mountPiece('./botsApprovalCards.js', cardTranscript, { slot: 'transcript' }).catch(error => console.warn('Bots cards could not load', error));
  // A question or approval sits in the conversation, under the message that asked (2026-11-02); the composer stays,
  // with one line that leads back to it.
  const waitingLine = h('button', { type: 'button', class: 'bots-waiting-line', hidden: true,
    onclick: () => cardComposer.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [icon('hand', { size: 15 }), h('span', { text: `${agent.name} is waiting on your answer` })]);
  root.insertBefore(waitingLine, composerHost);
  mountPiece('./botsApprovalCards.js', cardComposer, { slot: 'composer', onPending: waiting => {
    const was = !waitingLine.hidden; waitingLine.hidden = !waiting;
    // The card can report before the transcript below is made; then it is the first thing on screen anyway.
    let following = true; try { following = transcript.isFollowing(); } catch { /* not mounted yet */ }
    if (waiting && !was && following) requestAnimationFrame(() => cardComposer.scrollIntoView({ block: 'nearest' }));
  } }).catch(error => console.warn('Bots cards could not load', error));
  // First-run setup card for a new blank bot (Phase 4). The server sends the chosen "/setup <job>" itself, so a
  // pick only reloads the conversation; "Something else" puts "/setup " in the composer to finish by hand.
  const setupHost = h('div', { class: 'bots-setup-host' });
  root.insertBefore(setupHost, goalHost);
  mountPiece('./botsSetupCard.js', setupHost, { onPick: async (text, info = {}) => {
    if (info.other) { composer?.insert('/setup '); composer?.focus(); return; }
    await Promise.all([refreshLatest({ keepPosition: false }), refreshState()]).catch(() => {});
  } }).catch(error => console.warn('Bots setup card could not load', error));
  mountPiece('./botsLimitReset.js', limitHost, { stoppedByLimit: () => /limit|quota|usage/i.test(chatStream.getInFlight(sid)?.error || '') }).catch(error => console.warn('Bots limits could not load', error));
  let skillCommands = [];
  loadSkillCommands(agent.id, path => api(path, { toast: false })).then(commands => { skillCommands = commands; }).catch(error => console.warn('Bots skill commands could not load', error));

  // -- Person, draft, uploads ---------------------------------------------------------
  let person = options.person || '';
  if (!person) { try { person = (await api('/api/auth/status')).username || ''; } catch { /* Signed-out local use */ } }
  const draft = createBotDraft({ person: person || 'local', bot: agent.id, thread: sid });
  const uploader = createUploader({
    initialIds: draft.read().attachment_ids,
    upload: async file => { const form = new FormData(); form.append('file', file); try { return await api('/api/chat/attachments', { method: 'POST', headers: {}, body: form, toast: false }); } catch (e) { const f = /^(\d{3}): ([\s\S]*)$/.exec(e?.message || ''); if (f) { e.status = +f[1]; e.message = f[2]; } throw e; } },
    onChange: () => composer?.paint(),
  });

  // -- The pieces ----------------------------------------------------------------------
  const replyStyle = () => agent.reply_style || 'default';
  const lastAssistantId = () => [...(transcript.loadedIds())].reverse().find(id => transcript.get(id)?.role === 'assistant' && !transcript.get(id)?.kind) || null;
  const isBusy = () => chatStream.getInFlight(sid)?.status === 'processing' || !!placeholderTurn;
  const transcript = mountTranscript(transcriptHost, {
    rowRenderers: botRowRenderers({ agentId: agent.id, sessionId: sid, botName: agent.name, refresh: () => refreshLatest({ keepPosition: true }) }), openTarget: target => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: target })),
    agent, sessionId: sid, replyStyle, simple: () => !isAdvanced(),
    renderBody: (node, text, live) => renderMessageBody(node, text, sid, true, { live }),
    kip: (bot, size, st) => botKip(bot, { size, state: st }),
    getContext: () => ({ busy: isBusy(), lastAssistantId: lastAssistantId(), pinnedId: state.pinnedId, canSpeak: state.caps.speech && isSpeechOutputSupported() }),
    isSendKey: event => sendKey(event, { phone: phone.matches, preference: sendKeyPreference() }),
    jump: id => jumpToMessage(id), goToSource: id => jumpToMessage(id), selectVersion: id => selectBranch(id),
    react: (m, emoji, on) => react(m, emoji, on),
    onNeedOlder: () => loadOlder(), onNeedNewer: () => loadNewer(), onUnpin: () => pin(null),
    onEdit: (id, text) => editMessage(id, text),
    handlers: {
      reply: m => { draft.update({ reply_to_id: m.id }); composer.paint(); composer.focus(); },
      copy: m => copyText(m.content || ''),
      pin: m => pin(state.pinnedId === m.id ? null : m.id),
      edit: m => transcript.startEdit(m.id),
      regenerate: () => regenerate(),
      speak: m => speak(m),
      'copy-id': m => copyText(m.id),
      report: m => import('./botsReport.js').then(mod => mod.openReport({ sessionId: sid, messageId: m.id, botName: agent.name })),
      react: (m, emoji, on) => react(m, emoji, on),
    },
  });
  // The setup card and the pending question or approval follow the last message, in the same column, and scroll with it.
  transcript.scroller.append(h('div', { class: 'bots-inline-cards' }, [setupHost, cardComposer]));
  const sendController = createSendController({
    draft, getLeaf: () => state.leaf,
    flushSettings: options.flushSettings || (async () => { const mod = await import('./botsPatchQueue.js'); return mod.flushBotEdits ? mod.flushBotEdits(agent.id) : { ok: true }; }),
    request: async payload => {
      if (payload.attachment_ids?.length) await call('/api/chat/validate-attachments', { method: 'POST', body: { session_id: sid, attachment_ids: payload.attachment_ids } });
      // The draft calls an ordinary message 'chat'; the server's modes are none, 'goal' and 'spoken' (bot_chat_service.MODES).
      return call(`/api/bot-chat/${enc(sid)}/send`, { method: 'POST', body: { ...payload, mode: payload.mode === 'chat' ? null : payload.mode } });
    },
    // The data result the person has open and the parts of an app they pointed at (Phase 6) go with the message.
    extras: () => ({ data_context: currentDataContext(agent.id), pointed: pointedList().map(({ tag, label }) => ({ tag, label })) }),
    onAccepted: async (result, ticket) => {
      if (ticket.payload.pointed?.length) clearPointed();  // the chips went with this message
      if (result?.queued || result?.queue_id) { await refreshState(); transcript.announce('Queued. It sends when the reply finishes.'); return; }
      if (result?.message) { transcript.append(result.message); state.leaf = result.message.id; }
      if (result?.turn_id) beginLive(result.turn_id, ticket.payload.text);
      options.onThreadChanged?.(sid, 'sent');
      await refreshState();
    },
  });
  const dictation = { recorder: null };
  const call_ = { adapter: null };
  const composer = mountBotsComposer(composerHost, {
    draft, name: agent.name, selfId: agent.id, uploader, sendPreference: sendKeyPreference(),
    form: () => (phone.matches ? 'phone' : isAdvanced() ? 'advanced' : 'simple'),
    submit: async () => {
      try { return await sendController.send(); }
      catch (error) { if (error.status === 409) { await Promise.all([refreshLatest({ keepPosition: true }), refreshState()]).catch(() => {}); error.message = 'This conversation changed. Review it, then send again.'; } throw error; }
    },
    stop: () => stopTurn(), steer: () => steerQueue(), openCall: () => call_.adapter?.button.click(), modelLabel: () => (isAdvanced() ? state.model : ''),
    queue: { edit: item => editQueued(item), remove: item => deleteQueued(item), steer: item => steerQueue(item), resume: () => resumeQueue() },
    mentions: () => options.mentions?.() || [], skills: () => options.skills?.() || skillCommands, onSupport: () => openSupportDraft(),
    onNotice: text => composer.notice(text), pasteAsFile: shouldChipPaste, replyLabel: id => (transcript.get(id)?.role === 'user' ? 'you' : agent.name),
    onEditLast: () => { const last = transcript.lastUserMessage(); if (last && !isBusy()) { transcript.scrollToMessage(last.id, { flash: false }); transcript.startEdit(last.id); } },
    onEscape: () => { if (dictation.recorder) { dictation.recorder.cancel(); dictation.recorder = null; return true; } return false; },
    onDictate: toggleDictation,
  });
  const find = mountFindBar(root, {
    search: q => call(searchUrl({ query: q, sessionId: sid })),
    land: hit => land(hit), onClose: () => composer.focus(),
  });
  root.insertBefore(find.root, transcriptHost);
  if (!options.readOnly) {
    call_.adapter = agentCall(agent, {
      busy: isBusy, sessionId: () => sid, ensureSession: async () => sid,
      summarySaved: async () => { await refreshLatest({ keepPosition: true }); options.onThreadChanged?.(sid, 'call'); },
    });
    composer.callSlot(call_.adapter.button);
  }
  offs.push(onBotsInterface(() => { composer.paint(); transcript.redraw(); }));
  phone.addEventListener?.('change', () => composer.paint());

  // -- Loading -----------------------------------------------------------------------------
  const normalizePage = page => ({ messages: Array.isArray(page?.messages) ? page.messages : [], before: !!(page?.has_before ?? page?.hasBefore), after: !!(page?.has_after ?? page?.hasAfter), leaf: page?.active_leaf_id, revision: page?.branch_revision });
  async function refreshState() {
    try { const next = readState(await call(`/api/bot-chat/${enc(sid)}/state`)); if (disposed) return state; state = { ...next, leaf: state.leaf && next.leaf === null ? state.leaf : next.leaf }; paintState(); } catch { /* The next refresh tries again. */ }
    return state;
  }
  async function refreshLatest({ keepPosition = false } = {}) {
    const page = normalizePage(await call(`/api/bot-chat/${enc(sid)}/messages?limit=${FIRST_PAGE}`));
    if (disposed) return;
    hasBefore = page.before; hasAfter = page.after;
    transcript.setMessages(page.messages, { read: state.readId, keepPosition });
    if (page.leaf !== undefined) state.leaf = page.leaf ?? page.messages.at(-1)?.id ?? null; else state.leaf = page.messages.at(-1)?.id ?? null;
    if (page.revision !== undefined) state.revision = page.revision;
    paintPinned(); scheduleRead();
  }
  let loadingOlder = null;
  function loadOlder() {
    if (!hasBefore || loadingOlder) return Promise.resolve();
    const first = transcript.loadedIds()[0];
    loadingOlder = call(`/api/bot-chat/${enc(sid)}/messages?limit=${PAGE}&before=${enc(first)}`).then(raw => { const page = normalizePage(raw); hasBefore = page.before; transcript.prepend(page.messages); })
      .catch(() => {}).finally(() => { loadingOlder = null; });
    return loadingOlder;
  }
  async function loadNewer() {
    if (!hasAfter) return;
    const ids = transcript.loadedIds();
    const page = normalizePage(await call(`/api/bot-chat/${enc(sid)}/messages?limit=${PAGE}&after=${enc(ids.at(-1))}`).catch(() => ({})));
    hasAfter = page.after; transcript.appendPage(page.messages);
  }
  async function jumpToMessage(id) {
    if (!id) return false;
    if (transcript.scrollToMessage(id)) return true;
    try {
      const page = normalizePage(await call(`/api/bot-chat/${enc(sid)}/messages?limit=${PAGE}&around=${enc(id)}`));
      hasBefore = page.before; hasAfter = page.after;
      transcript.around(page.messages, id);
      return transcript.scrollToMessage(id);
    } catch { return false; }
  }
  const land = hit => landOnHit(hit, { currentSession: () => sid, token: (() => { let n = 0; return () => n; })(), openThread: async () => {}, selectBranch: id => selectBranch(id), loadAround: id => jumpToMessage(id), scrollTo: id => transcript.scrollToMessage(id), flash: id => transcript.flashMessage(id) });

  // -- State on screen ---------------------------------------------------------------------------
  function paintPinned() {
    const pinned = state.pinnedId ? transcript.get(state.pinnedId) : null;
    transcript.renderPinned(pinned || (state.pinnedId ? { id: state.pinnedId, snippet: 'Pinned message' } : null));
  }
  let busyKey = '';
  // Busy and locked change rarely; a chunk of text never rebuilds the composer.
  function syncBusy(force = false) {
    const live = chatStream.getInFlight(sid);
    const locked = !!live?.permission && live.status === 'processing', busy = isBusy();
    const key = `${busy}|${locked}`;
    if (key === busyKey && !force) return;
    busyKey = key;
    composer.setState({ busy, locked, lockedReason: 'Answer the question above to continue' });
  }
  function paintState() {
    composer.setQueue(state.queue);
    syncBusy(true);
    const percent = state.contextPercent;
    contextPill.hidden = !(Number.isFinite(percent) && percent >= 80);
    contextPill.textContent = contextPill.hidden ? '' : `Context ${Math.round(percent)}% full. Compact now`;
    contextPill.disabled = isBusy();
    paintGoal(); paintPinned(); ensurePoll();
  }
  // While work or a queue is open the server's state is read every few seconds, so a missed frame cannot strand it.
  function ensurePoll() {
    if (queueTimer || disposed || !(state.queue.items.length || isBusy())) return;
    queueTimer = later(() => { queueTimer = null; refreshState(); }, QUEUE_POLL_MS);
  }
  let queueTimer = null;
  function paintGoal() {
    const goal = state.goal;
    goalHost.hidden = !goal; goalHost.replaceChildren();
    if (!goal) return;
    const working = goal.status === 'running' || goal.status === 'working';
    const label = { running: 'Working', working: 'Working', completed: 'Done', 'needs-input': 'Needs you', blocked: 'Blocked', stopped: 'Stopped', 'limit-reached': 'Step limit reached', failed: 'Failed' }[goal.status] || 'Goal';
    goalHost.append(h('div', { class: `bots-goal-card ${goal.status}`, 'data-status': goal.status }, [
      h('div', { class: 'bots-goal-icon', 'aria-hidden': 'true' }, [icon(working ? 'zap' : goal.status === 'completed' ? 'check' : goal.status === 'needs-input' ? 'circle-alert' : goal.status === 'stopped' ? 'square' : 'triangle-alert', { size: 18 })]),
      h('div', { class: 'bots-goal-main' }, [
        h('strong', { class: 'bots-goal-title', text: String(goal.title || 'Working until done').slice(0, 180) }),
        h('span', { class: 'bots-goal-status', text: label }),
        ...(goal.detail ? [].concat(goal.detail).slice(0, 2).map(line => h('span', { class: 'bots-goal-detail', text: String(line) })) : []),
        h('span', { class: 'bots-goal-foot', text: `${agent.name} working${goal.step ? `. Step ${goal.step} of ${goal.max_steps || 13}` : ''}` })]),
      working ? h('button', { type: 'button', class: 'bots-btn', text: 'Stop', onclick: () => stopTurn() }) : null]));
  }

  // -- The live turn ------------------------------------------------------------------------------
  function beginLive(turnId, prompt) {
    if (chatStream.getInFlight(sid)?.status === 'processing' && chatStream.getInFlight(sid).turnId === turnId) return;
    placeholderTurn = turnId; settled = settled === turnId ? null : settled;
    transcript.setLive({ status: 'processing', text: '', startedAt: Date.now() / 1000, turnId, prompt, toolSteps: [], toolEvents: [], placeholder: true });
    composer.setState({ busy: true });
    chatStream.sync().catch(() => {});
    // A reply this quick may finish before the feed shows it; read the saved result instead of waiting forever.
    const check = async () => {
      if (placeholderTurn !== turnId || chatStream.getInFlight(sid)?.turnId === turnId) return;
      await refreshState();
      if (placeholderTurn === turnId && state.turnId !== turnId) { placeholderTurn = null; await refreshLatest({ keepPosition: false }); transcript.clearLive(); paintState(); }
      // Still running on the server but not on the feed: keep asking, so the placeholder never outlives the turn
      // (2026-11-02: a bot could stay on "Thinking" after its reply had saved).
      else if (placeholderTurn === turnId) later(check, 8000);
    };
    later(check, 2500);
  }
  // The feed can miss a turn's end (a sleep, a lost connection). Every 20 s while it says a turn is running, ask the
  // server; when the server has no turn, a fresh snapshot lets chatStream.js settle the stale one.
  const watchdog = async () => {
    if (chatStream.getInFlight(sid)?.status === 'processing') {
      await refreshState();
      if (!disposed && !state.turnId && chatStream.getInFlight(sid)?.status === 'processing') chatStream.sync().catch(() => {});
    }
    later(watchdog, 20000);
  };
  later(watchdog, 20000);
  function paint(entry) {
    if (disposed || !entry) return;
    if (entry.status === 'processing') {
      if (placeholderTurn && entry.turnId && entry.turnId !== placeholderTurn) placeholderTurn = null;
      if (entry.turnId === placeholderTurn) placeholderTurn = null;
      transcript.setLive(entry);
      if (entry.permission && entry.permission.id !== shownPermission) {
        shownPermission = entry.permission.id;
      } else if (!entry.permission && shownPermission) { dismissPermissionPrompt(shownPermission); shownPermission = null; }
      const said = announcementFor(entry, agent.name, announced); if (said) transcript.announce(said);
      syncBusy(); ensurePoll();
      return;
    }
    if (shownPermission) { dismissPermissionPrompt(shownPermission); shownPermission = null; }
    if (settled === entry.turnId) return;
    settled = entry.turnId; placeholderTurn = null;
    transcript.setLive(entry);
    const said = announcementFor(entry, agent.name, announced); if (said) transcript.announce(said);
    settle();
  }
  const announced = new Set();
  async function settle() {
    try { await refreshLatest({ keepPosition: !transcript.isFollowing() }); } catch { /* The saved reply shows on the next load. */ }
    await refreshState();
    const current = chatStream.getInFlight(sid);
    if (current?.status === 'processing') paint(current); else transcript.clearLive();
    paintState();
    options.onThreadChanged?.(sid, 'turn-ended');
  }
  offs.push(chatStream.subscribe(sid, paint));
  const onRuntime = event => { if (event.detail?.sessionId === sid || event.detail?.session_id === sid) {
    // A front-desk card was added or changed (Phase 5): reload the messages, keeping the reader's place.
    if (event.detail.type === 'bot.fd_card') { refreshLatest({ keepPosition: true }).catch(() => {}); return; }
    if (event.detail.queue) { state.queue = asQueue(event.detail.queue); paintState(); } else later(refreshState, 100); } };
  document.addEventListener('kairos:bot-runtime', onRuntime); offs.push(() => document.removeEventListener('kairos:bot-runtime', onRuntime));

  // -- Actions -----------------------------------------------------------------------------------
  async function stopTurn() {
    const entry = chatStream.getInFlight(sid);
    if (entry?.status === 'processing') { chatStream.stopTurn(sid, { bot: true }); return; }
    const turnId = placeholderTurn || state.turnId;
    if (turnId) { await call(`/api/bot-chat/${enc(sid)}/interrupt`, { method: 'POST', body: { turn_id: turnId } }); await refreshState(); }
  }
  async function editQueued(item) {
    const result = await call(`/api/bot-chat/${enc(sid)}/queue/${enc(item.id)}/edit`, { method: 'POST', body: {} });
    const payload = result?.payload || result || {};
    composer.restore(String(payload.text ?? item.text));
    if (payload.reply_to_id || payload.citations?.length || payload.mode === 'goal') draft.update({ reply_to_id: payload.reply_to_id || null, citations: payload.citations || [], mode: payload.mode === 'goal' ? 'goal' : 'chat' });
    await refreshState(); composer.paint();
  }
  async function deleteQueued(item) { await call(`/api/bot-chat/${enc(sid)}/queue/${enc(item.id)}`, { method: 'DELETE' }); await refreshState(); }
  async function steerQueue(item = state.queue.items[0]) {
    if (!item) { composer.notice('Nothing is queued to send now.'); return; }
    const turnId = chatStream.getInFlight(sid)?.turnId || state.turnId;
    const result = await call(`/api/bot-chat/${enc(sid)}/queue/${enc(item.id)}/steer`, { method: 'POST', body: { turn_id: turnId, queue_revision: state.queue.revision } });
    if (result?.blocked) composer.notice(`It could not interrupt: ${result.blocked}.`);
    await refreshState();
  }
  async function resumeQueue() { await call(`/api/bot-chat/${enc(sid)}/queue/resume`, { method: 'POST', body: {} }); await refreshState(); }
  async function react(message, emoji, on) {
    const before = transcript.get(message.id)?.reactions || message.reactions || [];
    transcript.patch(message.id, { reactions: applyReaction(before, emoji, on) });
    try {
      const result = await call(`/api/bot-chat/${enc(sid)}/messages/${enc(message.id)}/reaction`, { method: 'POST', body: { emoji, on } });
      if (Array.isArray(result?.reactions)) transcript.patch(message.id, { reactions: result.reactions });
    } catch (error) { transcript.patch(message.id, { reactions: before }); toast(error.message, 'error'); }
  }
  async function pin(messageId) {
    try { const result = await call(`/api/bot-chat/${enc(sid)}/pin`, { method: 'PATCH', body: { message_id: messageId } }); state.pinnedId = result?.pinned_message_id !== undefined ? result.pinned_message_id : messageId; paintPinned(); transcript.redraw(); }
    catch (error) { toast(error.message, 'error'); }
  }
  async function editMessage(id, text) {
    const result = await call(`/api/bot-chat/${enc(sid)}/messages/${enc(id)}/edit`, { method: 'POST', body: { text, send_id: uuid(), expected_leaf_id: state.leaf, expected_revision: state.revision } });
    transcript.stopEdit();
    if (result?.branch_revision !== undefined) state.revision = result.branch_revision;
    await refreshLatest();
    if (result?.turn_id) beginLive(result.turn_id, text);
    await refreshState(); options.onThreadChanged?.(sid, 'edited');
  }
  async function regenerate() {
    try {
      const result = await call(`/api/bot-chat/${enc(sid)}/regenerate`, { method: 'POST', body: { send_id: uuid(), expected_leaf_id: state.leaf, expected_revision: state.revision } });
      await refreshLatest(); if (result?.turn_id) beginLive(result.turn_id, '');
      await refreshState();
    } catch (error) { toast(error.status === 409 ? 'Wait for the reply to finish, then try again.' : error.message, 'error'); }
  }
  async function selectBranch(messageId) {
    const result = await call(`/api/bot-chat/${enc(sid)}/active-branch`, { method: 'POST', body: { message_id: messageId, expected_revision: state.revision } });
    if (result?.branch_revision !== undefined) state.revision = result.branch_revision;
    await refreshLatest({ keepPosition: true }); await refreshState();
  }
  async function compact() {
    if (isBusy()) return;
    contextPill.disabled = true;
    try { await call(`/api/bot-chat/${enc(sid)}/compact`, { method: 'POST', body: {} }); await refreshLatest({ keepPosition: true }); await refreshState(); toast('Earlier messages summarised', 'success'); }
    catch (error) { toast(error.message, 'error'); }
    finally { paintState(); }
  }
  const speaker = { value: null };
  function speak(message) {
    speaker.value ||= createSpeaker({ onError: text => toast(String(text), 'error') });
    speaker.value.reset?.(); speaker.value.feed(message.content || ''); speaker.value.finish();
  }
  async function toggleDictation(setActive) {
    if (dictation.recorder) {
      const active = dictation.recorder; dictation.recorder = null; setActive(false);
      const blob = await active.stop(); const text = blob ? await transcribeBlob(blob) : '';
      if (!disposed && text) composer.insert(`${composer.input.value ? ' ' : ''}${text}`);
      return;
    }
    const speech = await getSpeechStatus();
    if (!speech?.engine_available || !speech.active_model) throw new Error('Set up speech recognition in Settings > Speech.');
    const recorder = createRecorder(); await recorder.start();
    if (disposed) { recorder.cancel(); return; }
    dictation.recorder = recorder; setActive(true);
  }
  const mic = composerHost.querySelector('.bots-composer-mic'); if (mic && !isRecordingSupported()) mic.hidden = true;

  // The support shortcut: a redacted note the person reads and sends themselves. Nothing is sent from here.
  function openSupportDraft() {
    const recent = transcript.loadedIds().slice(-6).map(id => transcript.get(id)).filter(m => m && !m.kind);
    const body = `What happened:\n\n\nRecent messages (redacted):\n${recent.map(m => `${m.role === 'user' ? 'Me' : agent.name}: ${redactForSupport(m.content).slice(0, 400)}`).join('\n')}`;
    const area = h('textarea', { class: 'bots-support-text', rows: '12', 'aria-label': 'Note for Kairos Support' }); area.value = body;
    const dialog = h('div', { class: 'bots-support', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Note for Kairos Support' }, [
      h('h2', { text: 'Note for Kairos Support' }), h('p', { class: 'bots-hint', text: 'Names, addresses, keys and file paths are hidden. Read it, edit it, then copy it. Nothing is sent from here.' }), area,
      h('div', { class: 'bots-editor-actions' }, [h('button', { type: 'button', class: 'bots-btn', text: 'Close', onclick: () => close() }), h('button', { type: 'button', class: 'bots-btn primary', text: 'Copy note', onclick: () => copyText(area.value) })])]);
    const close = () => { dialog.remove(); document.removeEventListener('keydown', onKey, true); composer.focus(); };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true); root.append(dialog); area.focus();
  }

  moreButton.addEventListener('click', () => openMenu(moreButton, [
    { label: 'Find in conversation', iconName: 'search', onSelect: () => find.show() },
    { label: 'Compact now', iconName: 'archive', disabled: isBusy(), onSelect: () => compact() },
    { separator: true },
    { label: 'Export as Markdown', iconName: 'download', onSelect: () => downloadExport(sid, 'markdown').catch(e => toast(e.message, 'error')) },
    { label: 'Export as JSON', iconName: 'download', onSelect: () => downloadExport(sid, 'json').catch(e => toast(e.message, 'error')) },
  ], { align: 'end' }));
  const onKeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && root.isConnected) { event.preventDefault(); find.show(); } };
  document.addEventListener('keydown', onKeydown); offs.push(() => document.removeEventListener('keydown', onKeydown));

  // -- Reading and presence ----------------------------------------------------------------------------
  let lastRead = state.readId, readTimer = null, lastPresence = 0;
  function scheduleRead() {
    clearTimeout(readTimer);
    readTimer = later(async () => {
      const latest = transcript.loadedIds().at(-1);
      if (!latest || latest === lastRead || document.hidden || !document.hasFocus() || hasAfter) return;
      lastRead = latest;
      try { await call(`/api/bot-chat/${enc(sid)}/read`, { method: 'POST', body: { message_id: latest } }); } catch { lastRead = null; }
    }, 300);
  }
  const presence = () => {
    const now = Date.now();
    if (now - lastPresence < PRESENCE_MS || document.hidden) return;
    lastPresence = now;
    call('/api/bot-chat/presence', { method: 'POST', body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, focused_thread: sid } }).catch(() => {});
  };
  const onActive = () => { presence(); scheduleRead(); };
  for (const name of ['focus', 'pointerdown', 'keydown']) window.addEventListener(name, onActive, true);
  offs.push(() => { for (const name of ['focus', 'pointerdown', 'keydown']) window.removeEventListener(name, onActive, true); });

  // -- First load ----------------------------------------------------------------------------------------
  try {
    await refreshState();
    await refreshLatest();
  } catch (problem) {
    transcriptHost.replaceChildren(h('div', { class: 'bots-chat-error', role: 'alert' }, [h('p', { text: `This conversation could not load. ${problem.message || ''}`.trim() }),
      h('button', { type: 'button', class: 'bots-btn primary', text: 'Try again', onclick: () => options.onRetry?.() })]));
  }
  chatStream.connect().catch(() => {});
  const current = chatStream.getInFlight(sid);
  if (current?.status === 'processing') paint(current); else if (state.turnId) beginLive(state.turnId, '');
  paintState(); presence();
  if (options.initialMessage) await jumpToMessage(options.initialMessage);

  return {
    sessionId: () => sid,
    jumpToMessage, insert: text => composer.insert(text), focus: () => composer.focus(), refresh: async () => { await refreshLatest({ keepPosition: true }); await refreshState(); },
    find: () => find.show(), compact, exportConversation: format => downloadExport(sid, format),
    update(next) { if (next?.agent) { agent = { ...agent, ...next.agent }; transcript.redraw(); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(readTimer); clearTimeout(queueTimer);
      if (shownPermission) dismissPermissionPrompt(shownPermission);
      dictation.recorder?.cancel(); call_.adapter?.dispose(); speaker.value?.reset?.();
      uploader.dispose(); composer.dispose(); transcript.dispose(); find.hide?.(); root.remove();
    },
  };
}

