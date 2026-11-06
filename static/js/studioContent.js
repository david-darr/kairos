import { api, el, toast, confirmDialog, openPanelDialog } from './api.js';
import { group, row, pill, note, empty, badge, hueFor } from './settingsKit.js';
import * as M from './studioContentModel.js';

// The Content section of the Studio tab: channels, the pipeline board, approvals, the scoreboard, the weekly report
// and the numbers import for the Content Studio team (routes/content_studio_routes.py). Drawn with the Settings kit
// rows and pills. Approving only marks a post approved; preparing it for the platform comes later.

const BASE = '/api/content-studio';
const TABS = [['approvals', 'Approvals'], ['pipeline', 'Pipeline'], ['channels', 'Channels'], ['scoreboard', 'Scoreboard'], ['report', 'Report']];
const get = path => api(BASE + path);
const send = (path, body = {}) => api(BASE + path, { method: 'POST', body: JSON.stringify(body), toast: false });
const say = error => toast(M.loadFailure(error), 'error');
const longDate = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

let stylesheet;
function loadStyles() {
  stylesheet ||= new Promise(resolve => {
    const link = el('link', { rel: 'stylesheet', href: '/static/css/studio-content.css' });
    link.addEventListener('load', () => resolve(), { once: true }); link.addEventListener('error', () => resolve(), { once: true });
    document.head.append(link);
  });
  return stylesheet;
}

function btn(label, action, cls = '', attrs = {}) {
  const node = el('button', { type: 'button', class: `btn ${cls}`.trim(), text: label, ...attrs });
  node.addEventListener('click', async () => {
    if (node.disabled) return;
    node.disabled = true;
    try { await action(node); } catch (error) { say(error); }
    finally { node.disabled = false; }
  });
  return node;
}
const textInput = (label, attrs = {}) => el('input', { type: 'text', 'aria-label': label, autocomplete: 'off', ...attrs });
const selectOf = (label, options, value) => {
  const node = el('select', { 'aria-label': label }, options.map(([v, text]) => el('option', { value: v, text })));
  if (value != null) node.value = value;
  return node;
};

// The Add the team button deep-links to the Bots templates dialog on its Explore tab, then points at the team card.
async function openTeamTemplate() {
  const templates = await import('./botsTemplates.js');
  await templates.openTemplates({ tab: 'explore' });
  let tries = 0;
  const timer = setInterval(() => {
    const card = [...document.querySelectorAll('.bots-lifecycle-card')].find(c => c.querySelector('h3')?.textContent === 'Content Studio');
    if (card || ++tries > 40) {
      clearInterval(timer);
      card?.scrollIntoView({ block: 'center' }); card?.querySelector('button')?.focus();
    }
  }, 100);
}

export async function mountContent(host, { signal } = {}) {
  await loadStyles();
  let disposed = false, tab = null, data = null;
  const root = el('div', { class: 'sc', 'data-studio-content': '' });
  host.replaceChildren(root);
  signal?.addEventListener('abort', () => { disposed = true; }, { once: true });
  const alive = () => !disposed && root.isConnected;

  async function loadCore() {
    const names = ['niches', 'channels', 'pipeline', 'approvals', 'watch', 'settings'];
    const results = await Promise.allSettled(names.map(n => get('/' + n)));
    if (!alive()) return;
    if (results.every(r => r.status === 'rejected')) {
      root.replaceChildren(el('p', { role: 'alert', class: 'sc-error', text: M.loadFailure(results[0].reason) }), btn('Try again', reload));
      data = null; return;
    }
    const value = (name, fallback) => { const r = results[names.indexOf(name)]; return r.status === 'fulfilled' ? r.value : fallback; };
    data = { ...(data || {}), niches: value('niches', { niches: [] }).niches, maxLive: value('niches', {}).max_live,
      channels: value('channels', { channels: [] }).channels, items: value('pipeline', { items: [] }).items,
      approvals: value('approvals', { posts: [] }).posts, findings: value('watch', { findings: [] }).findings,
      hasTeam: (value('settings', {}).team_bot_ids || []).length > 0,
      failed: names.filter((n, i) => results[i].status === 'rejected') };
    await draw();
  }
  const reload = () => loadCore();

  // -- shared pieces ---------------------------------------------------------------------------

  function addChannelDialog() {
    const live = data.niches.filter(n => n.status === 'live');
    const options = [...live.map(n => [String(n.id), n.name]), ['new', 'A new niche']];
    const niche = selectOf('Niche', options, live.length ? String(live[0].id) : 'new');
    const newName = textInput('New niche name', { placeholder: 'For example, Home cooking' });
    const platform = selectOf('Platform', M.PLATFORMS, 'youtube');
    const handle = textInput('Channel handle', { placeholder: '@yourchannel' });
    const newRow = row({ title: 'New niche name', description: 'A niche is the theme the channels share.', control: newName, stack: true });
    const showNew = () => { newRow.hidden = niche.value !== 'new'; };
    niche.addEventListener('change', showNew); showNew();
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [
      note('Add a channel you created yourself. Kairos never creates accounts. The team only makes and prepares posts for channels you register here.'),
      group({}, [row({ title: 'Niche', control: niche }), newRow, row({ title: 'Platform', control: platform }),
        row({ title: 'Handle', description: 'As it appears on the platform.', control: handle })]), status]);
    const submit = btn('Add channel', async () => {
      status.textContent = '';
      try {
        let nicheId = Number(niche.value);
        if (niche.value === 'new') {
          if (!newName.value.trim()) { status.textContent = 'Name the niche first.'; return; }
          nicheId = (await send('/niches', { name: newName.value.trim() })).id;
        }
        if (!handle.value.trim()) { status.textContent = 'Enter the channel handle.'; return; }
        await send('/channels', { niche_id: nicheId, platform: platform.value, handle: handle.value.trim() });
      } catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('Channel added.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: 'Add a channel', body, footer: el('div', {}, [submit]), className: 'sc-dialog-panel' });
  }

  async function resolveWarning(channelId, label) {
    const ok = await confirmDialog({ title: 'Resume this channel?', message: `Read the platform's notice for ${label} and fix what it names first. Resuming lets the team make posts for it again.`, confirmLabel: 'Resume channel', danger: false });
    if (!ok) return;
    await send(`/channels/${channelId}/resume`); toast('Channel resumed.'); await reload();
  }

  function alerts() {
    const warned = data.channels.filter(c => c.paused && c.status !== 'archived');
    const urgent = M.urgentFindings(data.findings);
    if (!warned.length && !urgent.length) return null;
    return el('div', { class: 'sc-alerts', role: 'alert' }, [
      ...warned.map(c => el('div', { class: 'sc-alert', 'data-channel-id': c.id }, [
        el('div', { class: 'sc-alert-text' }, [el('strong', { text: 'Platform warning. ' }),
          el('span', { text: M.warningFor(c.id, data.findings) || `${M.platformName(c.platform)} paused ${c.handle}. The channel is paused.` })]),
        btn('Resolve warning', () => resolveWarning(c.id, `${M.platformName(c.platform)} ${c.handle}`), '', { 'aria-label': `Resolve warning for ${c.handle}` })])),
      ...urgent.map(f => el('div', { class: 'sc-alert' }, [el('div', { class: 'sc-alert-text', text: f.message })]))]);
  }

  // -- empty state -----------------------------------------------------------------------------

  function emptyState() {
    return el('section', { class: 'sc-empty', 'aria-label': 'Content Studio' }, [
      el('h3', { text: 'A team that makes short videos for your channels' }),
      el('p', { text: 'Seven bots find topics, write scripts, render videos and prepare posts for the channels you made. A Producer leads them and brings every post to you for approval.' }),
      el('p', { text: 'Nothing is posted without your OK. Kairos never creates accounts.' }),
      el('div', { class: 'sc-actions' }, [
        data.hasTeam ? null : btn('Add the Content Studio team', openTeamTemplate, 'primary'),
        btn('Add a channel', () => addChannelDialog(), data.hasTeam ? 'primary' : '')])]);
  }

  // -- channels --------------------------------------------------------------------------------

  function channelsView() {
    const out = [];
    const cap = data.maxLive ? ` At most ${data.maxLive} niches can be live at once.` : '';
    out.push(el('div', { class: 'sc-bar' }, [note('Channels you created. Kairos never creates accounts.' + cap), btn('Add a channel', () => addChannelDialog())]));
    for (const { niche, channels } of M.groupChannels(data.niches, data.channels)) {
      const rows = channels.map(channelRow);
      if (!rows.length) rows.push(empty('No channels in this niche yet.'));
      out.push(group({ title: niche.name, description: niche.status === 'live' ? `${niche.slots} posting slot${niche.slots === 1 ? '' : 's'}` : 'Retired. History kept.' }, rows));
    }
    if (!data.niches.length) out.push(empty('No channels yet. Add the first one above.'));
    return out;
  }
  function channelRow(channel) {
    const state = M.channelState(channel), name = `${M.platformName(channel.platform)} ${channel.handle}`;
    const warning = channel.paused && channel.status !== 'archived' ? (M.warningFor(channel.id, data.findings) || 'The platform sent a warning.') : '';
    const controls = [pill(state.label, state.tone)];
    if (channel.status === 'archived') controls.push(btn('Restore', async () => { await send(`/channels/${channel.id}/restore`); toast('Channel restored.'); await reload(); }, 'quiet', { 'aria-label': `Restore ${name}` }));
    else {
      if (warning) controls.push(btn('Resolve warning', () => resolveWarning(channel.id, name), '', { 'aria-label': `Resolve warning for ${channel.handle}` }));
      controls.push(btn('Archive', async () => {
        const ok = await confirmDialog({ title: 'Archive this channel?', message: `${name} leaves the rotation. Its history is kept and you can restore it.`, confirmLabel: 'Archive', danger: false });
        if (!ok) return;
        await send(`/channels/${channel.id}/archive`); toast('Channel archived.'); await reload();
      }, 'quiet', { 'aria-label': `Archive ${name}` }));
    }
    return row({ icon: badge(M.platformName(channel.platform), hueFor(channel.platform)), title: channel.handle,
      description: M.platformName(channel.platform) + (channel.archive_reason ? `. ${channel.archive_reason}` : ''),
      below: warning ? el('div', { class: 'sc-warning', role: 'alert' }, [el('strong', { text: 'Platform warning: ' }), warning]) : null,
      control: controls, cls: warning ? 'sc-row-warning' : '', attrs: { 'data-channel-id': channel.id } });
  }

  // -- pipeline --------------------------------------------------------------------------------

  function pipelineView() {
    const columns = M.boardColumns(data.items);
    if (!data.items.length) return [empty('No ideas in the pipeline yet. Topics and posts appear here as the team works.')];
    return [el('div', { class: 'sc-board', role: 'list', 'aria-label': 'Pipeline' }, columns.map(column =>
      el('section', { class: 'sc-col', role: 'listitem', 'data-column': column.id, 'aria-label': `${column.title}, ${column.items.length}` }, [
        el('h3', { class: 'sc-col-title' }, [column.title, el('span', { class: 'sc-count', text: String(column.items.length) })]),
        ...(column.items.length ? column.items.map(card) : [el('p', { class: 'sc-none', text: 'Nothing here.' })])])))];
  }
  function card(item) {
    const flags = M.cardFlags(item);
    const where = [item.niche_name, item.platform ? M.platformName(item.platform) : null].filter(Boolean).join(' · ');
    const node = el('button', { type: 'button', class: `sc-item${item.overdue ? ' is-overdue' : ''}`, 'data-item': `${item.kind}-${item.id}`,
      'aria-label': `${item.title}, ${where}` }, [
      el('span', { class: 'sc-item-title', text: item.title }), el('span', { class: 'sc-item-meta', text: where }),
      el('span', { class: 'sc-item-foot' }, [el('span', { text: M.ownerName(item.owner) }), el('span', { text: M.formatAge(item.age_h) })]),
      flags.length ? el('span', { class: 'sc-item-flags' }, flags.map(([t, tone]) => pill(t, tone))) : null]);
    node.addEventListener('click', () => openDetails(item, node));
    return node;
  }

  async function openDetails(item, opener) {
    const body = el('div', { class: 'sc-dialog' }, [el('p', { role: 'status', text: 'Loading...' })]);
    const dialog = openPanelDialog({ title: item.title, body, className: 'sc-dialog-panel', opener });
    const facts = [['Step', `${item.step} (${M.ownerName(item.owner)})`], ['Age', M.formatAge(item.age_h)], ['Niche', item.niche_name]];
    if (item.platform) facts.push(['Channel', M.platformName(item.platform)]);
    const factRows = () => group({}, facts.filter(f => f[1]).map(([k, v]) => row({ title: k, control: el('span', { class: 'set-mono', text: v }) })));
    if (item.overdue) facts.push(['Overdue', M.overdueText(item)]);
    if (item.kind === 'topic') {
      facts.push(['Source', item.source || '']);
      body.replaceChildren(factRows(), note('A topic the Researcher found. The Evaluator picks which ones get made.'));
      return;
    }
    let post;
    try { post = await get(`/posts/${item.id}`); } catch (error) { body.replaceChildren(el('p', { role: 'alert', text: M.loadFailure(error) })); return; }
    if (!dialog.backdrop.isConnected) return;
    const parts = [factRows(), postBody(post)];
    if (post.reject_reason) parts.push(note(`Rejected: ${post.reject_reason}`));
    const actions = [];
    if (post.state === 'rejected') actions.push(btn('Redraft', async () => { await send(`/posts/${post.id}/redraft`); dialog.close(); toast('Sent back to drafting.'); await reload(); }, 'primary'));
    if (post.state === 'awaiting_approval') actions.push(btn('Go to Approvals', () => { dialog.close(); select('approvals'); }, 'primary'));
    if (post.state === 'approved') {
      const link = textInput('Link to the live post', { placeholder: 'https://' });
      actions.push(btn('Prepare post', () => {}, '', { disabled: true, title: 'Coming later' }));
      parts.push(note('Prepare post is not built yet. For now, post it yourself, then paste the link here to mark it posted.'),
        group({}, [row({ title: 'Mark as posted', description: 'Needed before you can import its numbers.', control: [link, btn('Mark posted', async () => {
          if (!link.value.trim()) { toast('Paste the link to the post.', 'error'); return; }
          await send(`/posts/${post.id}/posted`, { url: link.value.trim() }); dialog.close(); toast('Marked as posted.'); await reload();
        })], stack: true })]));
    }
    if (post.state === 'posted') {
      parts.push(group({}, [row({ title: 'Posted', description: post.posted_url || '', control: pill(`${(post.metrics || []).length} number sets`, 'muted') })]));
    }
    if (actions.length) parts.push(el('div', { class: 'sc-actions' }, actions));
    body.replaceChildren(...parts);
  }

  // The preview shared by approval cards and the details dialog.
  function postBody(post) {
    const label = M.aiLabel(post.platform), link = M.renderLink(post.render_ref);
    const renderNode = !link ? el('span', { class: 'sc-dim', text: 'No render yet' })
      : link.href ? el('a', { href: link.href, text: link.label, ...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) })
      : el('span', { text: link.label });
    return el('div', { class: 'sc-preview' }, [
      el('div', { class: 'sc-block' }, [el('h4', { text: 'Caption' }), el('p', { class: 'sc-text', text: post.caption || 'No caption yet.' })]),
      el('div', { class: 'sc-block' }, [el('h4', { text: 'Script' }), el('p', { class: 'sc-text', text: post.script_ref || 'No script yet.' })]),
      el('div', { class: 'sc-block' }, [el('h4', { text: 'Video' }), renderNode]),
      el('div', { class: 'sc-block', 'data-ai-label': label.required ? 'required' : 'none' }, [el('h4', { text: 'AI label' }),
        el('p', { class: 'sc-text' }, [pill(label.required ? 'Required' : 'Not needed', label.required ? 'accent' : 'muted'), ' ', label.text])])]);
  }

  // -- approvals -------------------------------------------------------------------------------

  function approvalsView() {
    if (!data.approvals.length) return [empty('Nothing is waiting for you. Posts appear here when the Producer brings them for approval.')];
    return [note('Approving marks a post approved. Preparing it for the platform comes later, so approved posts wait in the Pipeline until then.'),
      ...data.approvals.map(approvalCard)];
  }
  function approvalCard(post) {
    const node = el('article', { class: 'sc-post', 'data-post-id': post.id, 'aria-label': post.title });
    const header = () => el('header', { class: 'sc-post-head' }, [el('h3', { class: 'sc-post-title', text: post.title }),
      el('div', { class: 'sc-post-pills' }, [pill(M.platformName(post.platform), 'accent'), pill(post.niche_name, 'muted'), post.rejection_count ? pill(`Rejected ${post.rejection_count}x before`, 'warn') : null])]);
    const done = async text => { toast(text); await reload(); };
    const view = () => {
      const actions = el('div', { class: 'sc-actions' }, [
        btn('Approve', async () => { await send(`/posts/${post.id}/approve`); await done('Approved. Preparing the post comes later.'); }, 'primary', { 'aria-label': `Approve ${post.title}` }),
        btn('Edit', () => node.replaceChildren(header(), editor()), '', { 'aria-label': `Edit ${post.title}` }),
        btn('Reject', () => asking('reject'), 'quiet danger', { 'aria-label': `Reject ${post.title}` }),
        btn('Redraft', () => asking('redraft'), 'quiet', { 'aria-label': `Redraft ${post.title}` })]);
      node.replaceChildren(header(), postBody(post), actions, el('p', { class: 'sc-dim sc-post-note', text: 'The Post action comes later with Prepare post.' }));
    };
    const asking = mode => {
      const reason = el('textarea', { rows: 3, 'aria-label': mode === 'reject' ? 'Why are you rejecting this?' : 'What should change?', maxlength: '500',
        placeholder: mode === 'reject' ? 'Why are you rejecting it? The team sees this.' : 'What should change in the next draft?' });
      const go = btn(mode === 'reject' ? 'Reject post' : 'Send back for redraft', async () => {
        await send(`/posts/${post.id}/reject`, { reason: reason.value.trim() });
        if (mode === 'redraft') await send(`/posts/${post.id}/redraft`);
        await done(mode === 'reject' ? 'Rejected.' : 'Sent back for a new draft.');
      }, mode === 'reject' ? 'danger' : 'primary');
      node.replaceChildren(header(), postBody(post), reason, el('div', { class: 'sc-actions' }, [go, btn('Cancel', () => view(), 'quiet')]));
      reason.focus();
    };
    const editor = () => {
      const title = textInput('Title', { value: post.title, maxlength: '200' });
      const caption = el('textarea', { rows: 4, 'aria-label': 'Caption', maxlength: '5000' }); caption.value = post.caption || '';
      const script = el('textarea', { rows: 4, 'aria-label': 'Script', maxlength: '500' }); script.value = post.script_ref || '';
      const save = btn('Save changes', async () => {
        const changes = {};
        if (title.value !== post.title) changes.title = title.value;
        if (caption.value !== (post.caption || '')) changes.caption = caption.value;
        if (script.value !== (post.script_ref || '')) changes.script_ref = script.value;
        if (Object.keys(changes).length) Object.assign(post, await send(`/posts/${post.id}/edit`, changes));
        toast('Saved.'); view();
      }, 'primary');
      return el('div', { class: 'sc-edit' }, [group({}, [row({ title: 'Title', control: title, stack: true }), row({ title: 'Caption', control: caption, stack: true }),
        row({ title: 'Script', control: script, stack: true })]), el('div', { class: 'sc-actions' }, [save, btn('Cancel', () => view(), 'quiet')])]);
    };
    view();
    return node;
  }

  // -- scoreboard ------------------------------------------------------------------------------

  async function scoreboardView() {
    const [board, decisions] = await Promise.all([get('/scoreboard'), get('/decisions')]);
    const sorted = M.sortDecisions(decisions.decisions);
    const out = [note(`${M.weightsText(board.weights)} ${M.minimumText(board.minimum)}`)];
    if (sorted.awaiting.length) out.push(group({ title: 'Needs your OK', description: 'The Producer confirmed these. They change your channels, so they wait for you.' }, sorted.awaiting.map(decisionAsk)));
    if (sorted.producer.length) out.push(group({ title: 'With the Producer', description: 'Proposed by the Executor. The Producer confirms first.' }, sorted.producer.map(d => decisionRow(d))));
    out.push(group({ title: 'Niches' }, board.niches.length ? M.rankRows(board.niches).map(r => scoreRow(r, r.status !== 'live' ? 'Retired' : '')) : [empty('No niches yet.')]));
    for (const [role, rows] of Object.entries(board.strategies)) {
      out.push(group({ title: M.roleTitle(role) }, rows.length ? M.rankRows(rows).map(r => scoreRow(r, r.status === 'dropped' ? 'Dropped' : r.is_default ? 'Default' : '')) : [empty('No strategies yet.')]));
    }
    if (board.formats.length) out.push(group({ title: 'Formats' }, M.rankRows(board.formats).map(r => scoreRow(r, ''))));
    out.push(group({ title: 'Recent decisions', description: 'Every retirement, promotion and swap is kept with its numbers.' },
      sorted.recent.length ? sorted.recent.slice(0, 12).map(d => decisionRow(d)) : [empty('No decisions yet.')]));
    return out;
  }
  function scoreRow(r, tag) {
    const enough = r.eligible && r.score != null;
    return row({ title: [r.name, tag ? pill(tag, 'muted') : null], attrs: { 'data-score-row': r.name },
      description: enough ? `${r.posts_scored} posts scored over ${Math.round(r.age_days)} days` : `${r.not_yet || 'No posts yet'}. ${r.posts_posted} posted.`,
      control: enough ? el('span', { class: 'sc-score', text: M.scoreText(r) }) : pill('Needs more data', 'muted') });
  }
  function decisionRow(d, controls) {
    const [label, tone] = M.decisionStatus(d);
    return row({ title: [M.decisionTitle(d)], description: [d.reason, M.decisionNumbers(d) ? ` (${M.decisionNumbers(d)})` : ''].join(''),
      control: controls || [pill(label, tone), el('span', { class: 'sc-dim', text: longDate(d.at) })], attrs: { 'data-decision-id': d.id } });
  }
  function decisionAsk(d) {
    const consequence = d.kind === 'retire' ? ` Its live channels are archived with their history kept. Nothing is deleted.` : '';
    return decisionRow(d, [
      btn('Confirm', async () => {
        const ok = await confirmDialog({ title: `${M.decisionTitle(d)}?`, message: `${d.reason}${consequence}`, confirmLabel: 'Confirm', danger: false });
        if (!ok) return;
        await send(`/decisions/${d.id}/confirm`, { actor: 'user' }); toast('Confirmed.'); await reload();
      }, 'primary', { 'aria-label': `Confirm: ${M.decisionTitle(d)}` }),
      btn('Reject', async () => { await send(`/decisions/${d.id}/reject`, { reason: '' }); toast('Rejected. Nothing changed.'); await reload(); }, 'quiet danger', { 'aria-label': `Reject: ${M.decisionTitle(d)}` })]);
  }

  // -- report and numbers import -------------------------------------------------------------------

  async function reportView() {
    const [report, posted] = await Promise.all([get('/report'), get('/posts?state=posted')]);
    const lines = String(report.text || '').split('\n').filter(l => l.trim());
    const sendBtn = btn('Send to my Inbox', async () => { await send('/report/send'); toast('Report sent to your Inbox.'); });
    const out = [group({ title: 'Latest report', description: `${longDate(report.from)} to ${longDate(report.to)}`, actions: [sendBtn] }, [
      el('div', { class: 'sc-report', 'data-report': '' }, lines.slice(1).map(l => el('p', { class: l.startsWith('  ') ? 'sc-report-sub' : '', text: l.trim() })))])];
    out.push(importView(posted.posts));
    return out;
  }

  function importView(posts) {
    const paste = el('textarea', { rows: 6, 'aria-label': 'Paste CSV', placeholder: 'Paste the rows exported from the platform, header row first.' });
    const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', 'aria-label': 'Upload CSV' });
    const mapHost = el('div'), result = el('div', { role: 'status', 'aria-live': 'polite' });
    const bring = btn('Read columns', () => read(), '', { 'aria-label': 'Read columns' });
    file.addEventListener('change', async () => { const f = file.files[0]; if (f) { paste.value = await f.text(); read(); } });
    let parsed = null, mapping = {};
    const defaultLength = el('input', { type: 'number', min: '1', 'aria-label': 'Video length in seconds', placeholder: 'e.g. 45' });
    defaultLength.addEventListener('input', () => preview());
    function read() {
      parsed = M.parseCsv(paste.value); mapping = M.guessMapping(parsed.headers);
      if (parsed.headers.length < 2 || !parsed.rows.length) { mapHost.replaceChildren(el('p', { class: 'set-error', role: 'alert', text: 'Add a header row and at least one row of numbers.' })); result.replaceChildren(); return; }
      const rows = M.IMPORT_FIELDS.map(field => {
        const choice = selectOf(`Column for ${field.label}`, [['-1', field.required ? 'Choose a column' : 'Not in my file'], ...parsed.headers.map((h, i) => [String(i), h || `Column ${i + 1}`])], String(mapping[field.key]));
        choice.addEventListener('change', () => { mapping[field.key] = Number(choice.value); preview(); });
        return row({ title: field.label + (field.required ? '' : ' (optional)'), control: choice });
      });
      rows.push(row({ title: 'Video length if the file has none', description: 'Seconds. Used for every row without a length.', control: defaultLength }));
      mapHost.replaceChildren(group({ title: 'Match your columns', description: `${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} found.` }, rows));
      preview();
    }
    function preview() {
      if (!parsed) return;
      if (!posts.length) { result.replaceChildren(note('Numbers attach to posted posts. Mark a post as posted from the Pipeline first.')); return; }
      const built = M.buildImport(parsed.rows, mapping, posts, { defaultLength: Number(defaultLength.value) || null });
      const children = [el('p', { class: 'sc-import-count', text: `${built.body.rows.length} of ${parsed.rows.length} rows ready.` })];
      if (built.problems.length) children.push(el('ul', { class: 'sc-problems' }, built.problems.slice(0, 8).map(p => el('li', { text: p.line ? `Line ${p.line}: ${p.text}` : p.text }))));
      if (built.problems.length > 8) children.push(el('p', { class: 'sc-dim', text: `And ${built.problems.length - 8} more.` }));
      if (built.body.rows.length) children.push(btn(`Import ${built.body.rows.length} row${built.body.rows.length === 1 ? '' : 's'}`, async () => {
        const stored = await send('/metrics/import', built.body);
        toast(`Imported ${stored.stored} rows.`); paste.value = ''; parsed = null; mapHost.replaceChildren(); result.replaceChildren(note(`Imported ${stored.stored} rows.`));
      }, 'primary'));
      result.replaceChildren(...children);
    }
    return group({ title: 'Import numbers', description: 'Analytics exported from YouTube, TikTok or Instagram. Each row needs its post, views and average view duration.', cls: 'sc-import' }, [
      row({ title: 'CSV file', control: file }), row({ title: 'Or paste it', control: [paste, bring], stack: true }), mapHost, result]);
  }

  // -- layout ------------------------------------------------------------------------------------

  function select(next) { tab = next; draw(); }
  async function draw() {
    if (!data) return;
    if (!data.niches.length && !data.channels.length) { root.replaceChildren(emptyState()); return; }
    tab ||= data.approvals.length ? 'approvals' : 'pipeline';
    const bar = el('div', { class: 'sc-tabs', role: 'tablist', 'aria-label': 'Content sections' }, TABS.map(([id, name]) => {
      const count = id === 'approvals' && data.approvals.length ? ` ${data.approvals.length}` : '';
      const node = el('button', { type: 'button', role: 'tab', class: 'sc-tab', id: `sc-tab-${id}`, 'aria-selected': String(id === tab), 'aria-controls': 'sc-body', 'data-tab': id, text: name + count });
      node.addEventListener('click', () => select(id));
      return node;
    }));
    bar.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]; if (!step) return;
      const at = TABS.findIndex(t => t[0] === tab); select(TABS[(at + step + TABS.length) % TABS.length][0]);
      root.querySelector('[role=tab][aria-selected=true]')?.focus();
    });
    const panel = el('div', { class: 'sc-body', id: 'sc-body', role: 'tabpanel', 'aria-labelledby': `sc-tab-${tab}` }, [el('p', { role: 'status', text: 'Loading...' })]);
    root.replaceChildren(...[alerts(), data.failed.length ? el('p', { class: 'set-error', role: 'alert', text: 'Some parts did not load. Try again in a moment.' }) : null, bar, panel].filter(Boolean));
    const shown = tab;
    const build = { approvals: approvalsView, pipeline: pipelineView, channels: channelsView, scoreboard: scoreboardView, report: reportView }[shown];
    try {
      const content = await build();
      if (alive() && tab === shown && panel.isConnected) panel.replaceChildren(...content);
    } catch (error) { if (alive() && panel.isConnected) panel.replaceChildren(el('p', { role: 'alert', class: 'sc-error', text: M.loadFailure(error) }), btn('Try again', () => draw())); }
  }

  await reload();
  return () => { disposed = true; };
}
