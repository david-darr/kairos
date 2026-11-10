import { api, el, toast } from '../api.js';
import { group, row, note, pill, toggle } from '../settingsKit.js';

// Settings > Personal > Reach me (Kairos 2.3.0, core/reach_me.py): where your bots message and call you, in your
// order, quiet hours, a per-bot choice, and the one STOP. Saved for this account only.

const errorText = (error) => String((error && error.message) || 'That could not be saved.').replace(/^\d+: /, '');

export const LOCKED_PHONE_NOTE = 'What reaches a locked phone: only a real phone call (Settings > Phone) rings like a call. '
  + 'A Kairos ring on a phone is a notification, not a call screen, and on iPhone it is a plain banner. Telegram, WhatsApp, '
  + 'Discord, iMessage, Signal and texts arrive as those apps\' own notifications. Nothing works when this computer is off '
  + 'or asleep: every message and call starts here.';

const when = (at) => new Date(at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function orderEditor(kind, state, channels, save) {
  const list = el('div', { class: 'reach-order', 'data-reach-order': kind });
  const draw = () => {
    const chosen = state[kind];
    const rest = channels.map(c => c.id).filter(id => !chosen.includes(id));
    list.replaceChildren(...[...chosen, ...rest].map((id) => {
      const channel = channels.find(c => c.id === id);
      const at = chosen.indexOf(id);
      const on = at >= 0;
      const move = (step) => el('button', { type: 'button', class: 'btn quiet', text: step < 0 ? 'Up' : 'Down',
        'aria-label': `Move ${channel.label} ${step < 0 ? 'up' : 'down'}`,
        disabled: !on || at + step < 0 || at + step >= chosen.length,
        onclick: async () => {
          const next = chosen.slice(); [next[at], next[at + step]] = [next[at + step], next[at]];
          await save({ [kind]: next });
        } });
      return row({
        title: on ? `${at + 1}. ${channel.label}` : channel.label,
        description: channel.detail,
        attrs: { 'data-reach-channel': id },
        control: [pill(channel.ready ? 'Ready' : 'Not set up', channel.ready ? 'ok' : 'muted'), move(-1), move(1),
          toggle({ checked: on, label: `Use ${channel.label}`, onChange: async (value) => {
            await save({ [kind]: value ? [...chosen, id] : chosen.filter(c => c !== id) });
          } })],
      });
    }));
  };
  draw();
  return list;
}

function botChoice(kind, bot, state, channels, save) {
  const current = (state.bots[bot.id] || {})[kind];
  const select = el('select', { 'aria-label': `${bot.name}: ${kind === 'message' ? 'messages' : 'calls'}`, 'data-reach-bot': `${bot.id}:${kind}` }, [
    el('option', { value: 'default', text: 'Your order' }),
    el('option', { value: 'never', text: 'Never' }),
    ...channels.map(c => el('option', { value: c.id, text: `Only ${c.label}` })),
  ]);
  select.value = current == null ? 'default' : current.length === 0 ? 'never' : current.length === 1 ? current[0] : 'default';
  select.addEventListener('change', async () => {
    const bots = { ...state.bots };
    const entry = { ...(bots[bot.id] || {}) };
    if (select.value === 'default') delete entry[kind]; else entry[kind] = select.value === 'never' ? [] : [select.value];
    if (Object.keys(entry).length) bots[bot.id] = entry; else delete bots[bot.id];
    await save({ bots });
  });
  return select;
}

export async function renderReachMePanel(content) {
  const root = el('section', { class: 'reach-panel' });
  content.replaceChildren(root);
  const status = el('p', { class: 'set-note', role: 'status', 'aria-live': 'polite' });
  let state;
  let bots = [];
  try {
    [state, bots] = await Promise.all([api('/api/reach-me'), api('/api/agents').catch(() => [])]);
  } catch (error) { root.append(note(errorText(error), 'set-error')); return; }
  if (!root.isConnected) return;

  async function save(patch) {
    status.textContent = '';
    try {
      state = await api('/api/reach-me', { method: 'PUT', toast: false, body: JSON.stringify(patch) });
      draw();
    } catch (error) { status.textContent = errorText(error); throw error; }
  }

  function draw() {
    const paused = state.paused;
    const pauseRow = row({
      title: paused ? 'Paused: bots will not message or call you' : 'Bots may message and call you',
      description: paused ? `Paused ${when(paused.at)}${paused.by === 'reply' ? ` by a STOP reply on ${paused.channel}` : ' here'}. Reply START anywhere, or turn this on.`
        : 'Reply STOP on any channel (Telegram, WhatsApp, Discord, iMessage, Signal or a text) to pause every bot on every channel at once. START turns it back on.',
      control: toggle({ checked: !paused, label: 'Bots may reach me', onChange: async (on) => {
        state = await api('/api/reach-me/pause', { method: 'POST', body: JSON.stringify({ paused: !on }) });
        toast(on ? 'Bots can reach you again' : 'Paused everywhere', 'success');
        draw();
      } }),
      attrs: { 'data-reach-pause': paused ? 'paused' : 'on' },
    });
    const quiet = state.quiet;
    const start = el('input', { type: 'time', value: quiet.start, 'aria-label': 'Quiet hours start', 'data-reach-quiet': 'start' });
    const end = el('input', { type: 'time', value: quiet.end, 'aria-label': 'Quiet hours end', 'data-reach-quiet': 'end' });
    const saveQuiet = (enabled) => save({ quiet: { enabled, start: start.value, end: end.value } });
    start.addEventListener('change', () => saveQuiet(quiet.enabled).catch(() => {}));
    end.addEventListener('change', () => saveQuiet(quiet.enabled).catch(() => {}));
    const visible = (Array.isArray(bots) ? bots : []).filter(b => !b.hidden);
    const recent = (state.log || []).map(item => row({
      title: `${item.bot_name || 'A bot'} ${item.kind === 'call' ? 'called' : 'messaged'} you${item.ok ? (item.channel ? `: ${(item.kind === 'call' ? state.call_channels : state.message_channels).find(c => c.id === item.channel)?.label || item.channel}` : '') : ': not delivered'}`,
      description: [when(item.at), item.note, ...(item.tried || []).map(t => `skipped ${t.channel}: ${t.reason}`)].filter(Boolean).join(' · '),
    }));
    root.replaceChildren(
      note('Where your bots reach you when they have something for you, in the order you choose. A bot tries the first way that is set up, then the next.'),
      group({ title: 'Messages and calls from bots' }, [pauseRow]),
      group({ title: 'Message me', description: 'For results and things to look at soon. The first way here that is set up and takes it wins.' },
        [orderEditor('message', state, state.message_channels, save)]),
      group({ title: 'Call me', description: 'For something urgent, or when you asked a bot to call. A daily limit or a busy line is reported to the bot, not worked around on another way.' },
        [orderEditor('call', state, state.call_channels, save)]),
      group({ title: 'Quiet hours', description: 'In your own time zone. Messages wait until quiet hours end; calls are not made.' }, [
        row({ title: 'Quiet hours', description: state.quiet_now ? 'It is quiet hours now.' : '', control: toggle({ checked: quiet.enabled, label: 'Quiet hours', onChange: (on) => saveQuiet(on) }) }),
        row({ title: 'From', control: start }), row({ title: 'Until', control: end }),
      ]),
      visible.length ? group({ title: 'Each bot', description: 'A bot can use your order, only one way, or never reach out.' },
        visible.map(bot => row({ title: bot.name, attrs: { 'data-reach-bot-row': bot.id },
          control: [botChoice('message', bot, state, state.message_channels, save), botChoice('call', bot, state, state.call_channels, save)] }))) : null,
      group({ title: 'What reaches you, honestly' }, [note(LOCKED_PHONE_NOTE)]),
      group({ title: 'Recent' }, recent.length ? recent : [row({ title: 'Nothing sent yet.' })]),
      status,
    );
  }
  draw();
}
