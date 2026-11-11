import { api, el, toast, confirmDialog, openPanelDialog } from './api.js';
import { group, row, pill, note, empty, badge, hueFor } from './settingsKit.js';
import * as M from './studioContentModel.js';
import { libraryShareButton } from './libraryShare.js';

// The Content section of the Studio tab: channels, the pipeline board, approvals, the scoreboard, the weekly report
// and the numbers import for the Content Studio team (routes/content_studio_routes.py). Drawn with the Settings kit
// rows and pills. Approving marks a post approved; Publishing is the dashboard from draft to live link: Prepare post
// assembles an approved post for its platform (services/content_studio/prepare.py), Open upload page has the desktop app
// fill the platform's page in the Kairos Browser and stop before the final button, which the person presses. A YouTube
// post can also go out through the person's own Google project when they connect posting (Channels tab). Channels also
// holds the TikTok and Instagram page-read switches (read-only numbers from the person's own signed-in pages).
// Formats shows the Researcher's format cards and the ports the Evaluator checked; the bots write them, this only reads.
// Characters (Pack A) lists each character's versions with their reference sheets: a sheet waiting for you is also in
// Approvals, and only you approve it (routes/character_routes.py). A video may only use an approved version.
// Styles lists the account's own style packs (routes/style_pack_routes.py): make one from a written brief, duplicate one,
// add the starter pack or import a pack file; edit the brief (a new version), render its sample, export it, share it, and
// approve or reject it. A pack waiting for you is also in Approvals. Channels pick their pack in Look.
// Long videos (Video Styles unit 4): a long video's shot plan waits in Approvals before it renders (approved at
// /api/videos/<id>/plan); a YouTube channel sets its long videos a week in Look (one by default); an approval card shows the
// chapter list that goes into the YouTube description.

const BASE = '/api/content-studio';
const TABS = [['approvals', 'Approvals'], ['publishing', 'Publishing'], ['pipeline', 'Pipeline'], ['channels', 'Channels'], ['formats', 'Formats'], ['characters', 'Characters'], ['styles', 'Styles'], ['scoreboard', 'Scoreboard'], ['report', 'Report']];
const CHARACTERS = '/api/characters';
const STYLES = '/api/style-packs';
const sendTo = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body), toast: false });
const get = path => api(BASE + path);
const send = (path, body = {}) => api(BASE + path, { method: 'POST', body: JSON.stringify(body), toast: false });
const put = (path, body) => api(BASE + path, { method: 'PUT', body: JSON.stringify(body), toast: false });
const remove = path => api(BASE + path, { method: 'DELETE', toast: false });
// Google's consent page opens in the system browser (the desktop app) or a new tab.
async function openGoogle(url) {
  if (window.jarvis?.openGoogleSignIn) { if (!await window.jarvis.openGoogleSignIn(url)) throw new Error('Could not open Google sign-in.'); return; }
  window.open(url, '_blank', 'noopener');
}
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

// The Add the team button opens the Bots templates dialog straight on the Content Studio team's preview.
async function openTeamTemplate() {
  const templates = await import('./botsTemplates.js');
  await templates.openTemplates({ tab: 'explore', preview: 'Content Studio' });
}

export async function mountContent(host, { signal } = {}) {
  await loadStyles();
  let disposed = false, tab = null, data = null;
  const root = el('div', { class: 'sc', 'data-studio-content': '' });
  host.replaceChildren(root);
  signal?.addEventListener('abort', () => { disposed = true; }, { once: true });
  const alive = () => !disposed && root.isConnected;

  async function loadCore() {
    const names = ['niches', 'channels', 'pipeline', 'approvals', 'watch', 'settings', 'analytics/youtube/status', 'posting/youtube/status', 'publishing'];
    const [results, styles] = await Promise.all([Promise.allSettled(names.map(n => get('/' + n))), api(STYLES).catch(() => null)]);
    if (!alive()) return;
    if (results.every(r => r.status === 'rejected')) {
      root.replaceChildren(el('p', { role: 'alert', class: 'sc-error', text: M.loadFailure(results[0].reason) }), btn('Try again', reload));
      data = null; return;
    }
    const value = (name, fallback) => { const r = results[names.indexOf(name)]; return r.status === 'fulfilled' ? r.value : fallback; };
    data = { ...(data || {}), niches: value('niches', { niches: [] }).niches, maxLive: value('niches', {}).max_live,
      channels: value('channels', { channels: [] }).channels, items: value('pipeline', { items: [] }).items,
      approvals: value('approvals', { posts: [] }).posts, sheets: value('approvals', {}).characters || [], packsWaiting: value('approvals', {}).style_packs || [],
      plans: value('approvals', {}).plans || [],
      styles, findings: value('watch', { findings: [] }).findings,
      hasTeam: (value('settings', {}).team_bot_ids || []).length > 0, settings: value('settings', {}),
      yt: value('analytics/youtube/status', null), ytPost: value('posting/youtube/status', null), pub: value('publishing', null),
      failed: names.filter((n, i) => results[i].status === 'rejected' && !n.includes('youtube')) };
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
    out.push(youtubeGroup());
    const reads = pageReadsGroup();
    if (reads) out.push(reads);
    for (const { niche, channels } of M.groupChannels(data.niches, data.channels)) {
      const rows = channels.map(channelRow);
      if (!rows.length) rows.push(empty('No channels in this niche yet.'));
      out.push(group({ title: niche.name, description: niche.status === 'live' ? `${niche.slots} posting slot${niche.slots === 1 ? '' : 's'}` : 'Retired. History kept.' }, rows));
    }
    if (!data.niches.length) out.push(empty('No channels yet. Add the first one above.'));
    return out;
  }
  // After Google's consent page, the status is read again when the person comes back to Kairos.
  function reloadOnReturn() { window.addEventListener('focus', () => { if (alive()) reload(); }, { once: true }); }

  function youtubeGroup() {
    const a = data.yt, p = data.ytPost;
    if (!a && !p) return group({ title: 'YouTube' }, [empty('YouTube connections could not load. Try again in a moment.')]);
    const configured = (a || p).configured;
    const rows = [];
    if (!configured) rows.push(row({ title: 'Google first', description: 'Set up Google in Library (your own Google OAuth client and a sign-in), then connect YouTube here.' }));
    const [aLabel, aTone] = M.connectionState(a);
    const aControls = [pill(aLabel, aTone)];
    if (a?.connected) {
      aControls.push(btn('Sync now', async () => { const out = await send('/analytics/youtube/sync'); toast(M.syncText(out.result)); await reload(); }, '', { 'aria-label': 'Sync YouTube numbers now' }),
        btn('Disconnect', async () => { await remove('/analytics/youtube'); toast('YouTube analytics disconnected. Numbers already stored stay.'); await reload(); }, 'quiet', { 'aria-label': 'Disconnect YouTube analytics' }));
    } else if (configured) {
      aControls.push(btn(a?.needs_reconnect ? 'Reconnect' : 'Connect', async () => { const out = await send('/analytics/youtube/connect'); await openGoogle(out.url); reloadOnReturn(); toast('Finish in the Google window, then come back here.'); }, '', { 'aria-label': 'Connect YouTube analytics' }));
    }
    rows.push(row({ title: 'Analytics', description: M.analyticsText(a), control: aControls, attrs: { 'data-youtube': 'analytics' } }));
    const [pLabel, pTone] = M.connectionState(p);
    const pControls = [pill(pLabel, pTone)];
    if (p?.connected) {
      const privacy = selectOf('Privacy of YouTube uploads', M.PRIVACY, p.privacy || 'private');
      privacy.addEventListener('change', async () => {
        try { data.ytPost = await put('/posting/youtube/privacy', { privacy: privacy.value }); toast(`Uploads ask for ${privacy.value}.`); } catch (error) { say(error); privacy.value = data.ytPost.privacy; }
      });
      pControls.push(privacy, btn('Disconnect', async () => { await remove('/posting/youtube'); toast('YouTube posting disconnected.'); await reload(); }, 'quiet', { 'aria-label': 'Disconnect YouTube posting' }));
    } else if (configured) {
      pControls.push(btn(p?.needs_reconnect ? 'Reconnect' : 'Connect', async () => { const out = await send('/posting/youtube/connect'); await openGoogle(out.url); reloadOnReturn(); toast('Finish in the Google window, then come back here.'); }, '', { 'aria-label': 'Connect YouTube posting' }));
    }
    rows.push(row({ title: 'Posting', description: M.postingText(p), control: pControls, attrs: { 'data-youtube': 'posting' },
      below: p ? el('p', { class: 'sc-dim sc-notice', text: p.notice }) : null }));
    return group({ title: 'YouTube', description: 'Your own Google project. Analytics only reads; posting only sends posts you approved.' }, rows);
  }

  function lookDialog(channel) {
    const name = `${M.platformName(channel.platform)} ${channel.handle}`;
    const look = textInput('Look id', { value: channel.look || '', maxlength: '80', placeholder: 'For example, sport' });
    const aspect = selectOf('Aspect', M.ASPECTS, channel.aspect || '');
    const notes = el('textarea', { rows: 4, 'aria-label': 'Voice notes', maxlength: '1000', placeholder: 'How this channel talks. For example, calm and curious, no hype.' });
    notes.value = channel.notes || '';
    const voice = textInput('Narrator voice', { value: channel.voice || '', maxlength: '40', placeholder: 'For example, af_heart' });
    const pack = selectOf('Style pack', M.packOptions(data.styles?.available), channel.style_pack || '');
    // Pack B: what renders this channel's 3D videos. Blender is offered only when it is installed on this computer.
    const status3d = data.styles?.renderers;
    const renderer = selectOf('3D renderer', M.rendererOptions(status3d, { inherit: true }), channel.renderer || '');
    if (!status3d?.blender?.supported) renderer.querySelector('option[value="blender"]').disabled = channel.renderer !== 'blender';
    // Step 6: the channel's frame rate; 60 is smoother and takes about twice as long to render.
    const fps = selectOf('Frame rate', [['30', '30 frames a second'], ['60', '60 frames a second']], String(channel.fps || 30));
    // Pack C: whether this channel's videos are made for kids (YouTube asks every upload; a blocky world post needs an answer).
    const kids = selectOf('Made for kids', M.KIDS_OPTIONS, M.kidsValue(channel.made_for_kids));
    const youtube = channel.platform === 'youtube';
    const longWeek = el('input', { type: 'number', min: '0', max: '7', step: '1', 'aria-label': 'Long videos a week', value: String(channel.long_per_week ?? 1) });
    longWeek.value = String(channel.long_per_week ?? 1);
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [
      note('The Editor renders this channel\'s videos in its style pack, look and aspect, and the Script Writer follows its voice notes.'),
      group({}, [row({ title: 'Style pack', description: 'How this channel\'s videos look and sound. Only approved packs are listed (Styles).', control: pack }),
        row({ title: '3D renderer', description: status3d?.blender?.supported ? `For glossy 3D packs. three.js is built in and fast; Blender ${status3d.blender.version} is installed here: softer light, much slower.` : 'For glossy 3D packs. three.js is built in. Blender isn\'t installed on this computer, so it cannot be picked.', control: renderer }),
        row({ title: 'Look', description: 'A Studio video look id. Leave it empty to let the Editor choose.', control: look, stack: true }),
        row({ title: 'Aspect', control: aspect }),
        row({ title: 'Frame rate', description: '60 is smoother for fast motion and takes about twice as long to render. Shorts and most explainers look fine at 30.', control: fps }),
        row({ title: 'Made for kids', description: 'Answer honestly: YouTube asks this for every upload. A post can answer for itself. Blocky world videos draw children and cannot be prepared until this is set here or on the post. On YouTube, made-for-kids videos have comments and personalised ads turned off (general knowledge, not checked).', control: kids }),
        row({ title: 'Voice notes', control: notes, stack: true }),
        row({ title: 'Narrator voice', description: 'The Kokoro voice that narrates every video on this channel. Left empty, the first narrated video sets it.', control: voice, stack: true }),
        youtube ? row({ title: 'Long videos a week', description: 'Longer videos in chapters, on top of the daily Shorts. The team plans within it, and each plan comes to you before it renders.', control: longWeek }) : null]), status]);
    const save = btn('Save look', async () => {
      status.textContent = '';
      const week = Number(longWeek.value);
      if (youtube && (!Number.isInteger(week) || week < 0 || week > 7)) { status.textContent = 'Long videos a week is a whole number from 0 to 7.'; return; }
      try { await send(`/channels/${channel.id}/edit`, { look: look.value.trim(), aspect: aspect.value, notes: notes.value.trim(), voice: voice.value.trim(), style_pack: pack.value, renderer: renderer.value, fps: Number(fps.value), made_for_kids: kids.value, ...(youtube ? { long_per_week: week } : {}) }); }
      catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('Look saved.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: `Look for ${name}`, body, footer: el('div', {}, [save]), className: 'sc-dialog-panel' });
  }

  function channelRow(channel) {
    const state = M.channelState(channel), name = `${M.platformName(channel.platform)} ${channel.handle}`;
    const warning = channel.paused && channel.status !== 'archived' ? (M.warningFor(channel.id, data.findings) || 'The platform sent a warning.') : '';
    const controls = [pill(state.label, state.tone)];
    if (channel.status === 'archived') controls.push(btn('Restore', async () => { await send(`/channels/${channel.id}/restore`); toast('Channel restored.'); await reload(); }, 'quiet', { 'aria-label': `Restore ${name}` }));
    else {
      controls.push(btn('Look', () => lookDialog(channel), 'quiet', { 'aria-label': `Look for ${name}` }));
      if (warning) controls.push(btn('Resolve warning', () => resolveWarning(channel.id, name), '', { 'aria-label': `Resolve warning for ${channel.handle}` }));
      controls.push(btn('Archive', async () => {
        const ok = await confirmDialog({ title: 'Archive this channel?', message: `${name} leaves the rotation. Its history is kept and you can restore it.`, confirmLabel: 'Archive', danger: false });
        if (!ok) return;
        await send(`/channels/${channel.id}/archive`); toast('Channel archived.'); await reload();
      }, 'quiet', { 'aria-label': `Archive ${name}` }));
    }
    return row({ icon: badge(M.platformName(channel.platform), hueFor(channel.platform)), title: channel.handle,
      description: M.platformName(channel.platform) + (channel.status === 'archived' ? '' : `. ${M.channelLookText(channel, data.styles?.available)}`) + (channel.archive_reason ? `. ${channel.archive_reason}` : ''),
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
      const listed = data.pub?.items.find(i => i.post_id === post.id);
      if (listed?.prep_id) actions.push(btn('Open in Publishing', () => { dialog.close(); select('publishing'); preparedDialog(listed); }, 'primary'));
      else actions.push(btn('Prepare post', async () => { dialog.close(); await prepareItem({ post_id: post.id }); select('publishing'); }, 'primary'));
      if (post.platform === 'youtube' && !post.direct_post_blocker) {
        actions.push(btn('Post to YouTube', async () => {
          const privacy = data.ytPost?.privacy || 'private';
          const ok = await confirmDialog({ title: 'Post to YouTube?', message: `"${post.title}" is uploaded exactly as approved, as ${privacy}, with YouTube's AI-content label. YouTube may keep it private until your Google project passes its API audit.`, confirmLabel: 'Post to YouTube', danger: false });
          if (!ok) return;
          const out = await send(`/posts/${post.id}/publish-youtube`);
          dialog.close(); toast(M.publishText(out)); await reload();
        }, 'primary'));
      } else if (post.platform === 'youtube' && post.direct_post_blocker) {
        parts.push(note(`Posting straight to YouTube: ${post.direct_post_blocker}`));
      }
      parts.push(note('Prepare post assembles it for its platform; Publishing opens the upload page and fills it for you. After you posted it, paste the link here to mark it posted.'),
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
    const made = M.postFormatText(post);
    return el('div', { class: 'sc-preview' }, [
      post.pick_reason ? el('div', { class: 'sc-block' }, [el('h4', { text: 'Why this topic' }), el('p', { class: 'sc-text', text: post.pick_reason })]) : null,
      made ? el('div', { class: 'sc-block', 'data-post-format': '' }, [el('h4', { text: 'Format' }), el('p', { class: 'sc-text', text: made })]) : null,
      el('div', { class: 'sc-block' }, [el('h4', { text: 'Caption' }), el('p', { class: 'sc-text', text: post.caption || 'No caption yet.' })]),
      post.tags ? el('div', { class: 'sc-block' }, [el('h4', { text: 'Tags' }), el('p', { class: 'sc-text', text: post.tags })]) : null,
      post.thumbnail ? el('div', { class: 'sc-block' }, [el('h4', { text: 'Thumbnail' }), el('p', { class: 'sc-text', text: post.thumbnail })]) : null,
      M.kidsText(post.made_for_kids) ? el('div', { class: 'sc-block', 'data-post-kids': '' }, [el('h4', { text: 'Made for kids' }), el('p', { class: 'sc-text', text: M.kidsText(post.made_for_kids) })]) : null,
      post.long_form ? el('div', { class: 'sc-block', 'data-post-chapters': '' }, [el('h4', { text: 'Chapters (added to the YouTube description)' }),
        el('p', { class: 'sc-text', text: post.chapters || 'The chapter list comes with the render.' })]) : null,
      el('div', { class: 'sc-block' }, [el('h4', { text: 'Script' }), el('p', { class: 'sc-text', text: post.script_ref || 'No script yet.' })]),
      el('div', { class: 'sc-block' }, [el('h4', { text: 'Video' }), renderNode]),
      el('div', { class: 'sc-block', 'data-ai-label': label.required ? 'required' : 'none' }, [el('h4', { text: 'AI label' }),
        el('p', { class: 'sc-text' }, [pill(label.required ? 'Required' : 'Not needed', label.required ? 'accent' : 'muted'), ' ', label.text])])]);
  }

  // -- publishing (Prepare post and the dashboard) -------------------------------------------------

  // Open upload page: the desktop app opens the platform's page in a Browse tab on the person's own sign-in and fills
  // it, stopping before the final button. Without the desktop app the checklist is the way.
  async function openUpload(item) {
    const browse = window.jarvis?.browse;
    if (!browse?.preparePost) { toast('Open upload page needs the Kairos desktop app. The checklist has everything to post it by hand.', 'error'); return; }
    const out = await browse.preparePost(item.prep_id);
    if (!out?.ok) { toast(out?.reason || 'Kairos could not open the upload page.', 'error'); return; }
    toast(`Kairos is filling the ${M.platformName(item.platform)} page. Check it, then press ${M.POST_BUTTONS[item.platform]} yourself.`);
    try { const { switchMode } = await import('./app.js'); await switchMode('browse'); } catch { /* stays here; the tab is open in Browse */ }
  }

  async function prepareItem(item, schedule) {
    const prep = await send(`/posts/${item.post_id}/prepare`, schedule ? { schedule_at: schedule } : {});
    toast(M.prepareText(prep));
    await reload();
    return prep;
  }

  async function postToYouTube(item) {
    const privacy = data.ytPost?.privacy || 'private';
    const ok = await confirmDialog({ title: 'Post to YouTube?', message: `"${item.title}" is uploaded exactly as approved, as ${privacy}, with YouTube's AI-content label${item.scheduled_at ? `, scheduled for ${M.timeText(item.scheduled_at)}` : ''}. YouTube may keep it private until your Google project passes its API audit.`, confirmLabel: 'Post to YouTube', danger: false });
    if (!ok) return;
    toast(M.publishText(await send(`/posts/${item.post_id}/publish-youtube`))); await reload();
  }

  function markPostedDialog(item) {
    const link = textInput('Link to the live post', { placeholder: 'https://', maxlength: '500' });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const save = btn('Mark posted', async () => {
      status.textContent = '';
      if (!link.value.trim()) { status.textContent = 'Paste the link to the post.'; return; }
      try { await send(`/posts/${item.post_id}/posted`, { url: link.value.trim() }); } catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('Marked as posted. Its numbers can be tracked now.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: `Mark posted: ${item.title}`, className: 'sc-dialog-panel', footer: el('div', {}, [save]),
      body: el('div', { class: 'sc-dialog' }, [note(`After you pressed ${M.POST_BUTTONS[item.platform]} on ${M.platformName(item.platform)}, paste the post's link.`),
        group({}, [row({ title: 'Live link', control: link, stack: true })]), status]) });
    link.focus();
  }

  function scheduleDialog(item) {
    const when = el('input', { type: 'datetime-local', 'aria-label': 'When to post', value: M.scheduleValue(item.scheduled_at) });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const save = btn('Save schedule', async () => {
      status.textContent = '';
      const at = M.parseSchedule(when.value);
      if (!at) { status.textContent = 'Choose a date and time.'; return; }
      try { await send(`/posts/${item.post_id}/schedule`, { at }); } catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast(`Scheduled for ${M.timeText(at)}.`); await reload();
    }, 'primary');
    const clear = item.scheduled_at ? btn('Clear schedule', async () => { await send(`/posts/${item.post_id}/schedule`, { at: null }); dialog.close(); toast('Schedule cleared.'); await reload(); }, 'quiet') : null;
    const how = item.platform === 'youtube' ? 'With YouTube posting connected, YouTube publishes it at this time. On the upload page you set it under Visibility.'
      : item.platform === 'tiktok' ? 'You set it on TikTok\'s page under Schedule; the checklist reminds you.' : 'Instagram on the web posts at once: press Share at this time, or schedule it in Meta Business Suite.';
    const dialog = openPanelDialog({ title: `Schedule: ${item.title}`, className: 'sc-dialog-panel', footer: el('div', { class: 'sc-actions' }, [save, clear]),
      body: el('div', { class: 'sc-dialog' }, [note(how), group({}, [row({ title: 'When', control: when })]), status]) });
  }

  function itemActions(item, { inDialog = false, close = () => {} } = {}) {
    const out = [], label = `${item.title} on ${M.platformName(item.platform)}`;
    const after = fn => async () => { close(); await fn(); };
    if (item.state === 'awaiting_approval') out.push(btn('Go to Approvals', after(() => select('approvals')), 'primary', { 'aria-label': `Go to Approvals for ${label}` }));
    if (item.state === 'approved') out.push(btn('Prepare post', after(() => prepareItem(item)), 'primary', { 'aria-label': `Prepare ${label}` }));
    if (['prepared', 'waiting_for_you', 'failed'].includes(item.state)) {
      const blocked = item.problems?.length;
      if (item.routes?.includes('api') && !blocked) out.push(btn('Post to YouTube', after(() => postToYouTube(item)), 'primary', { 'aria-label': `Post ${label} to YouTube` }));
      if (!blocked) out.push(btn(item.state === 'waiting_for_you' ? 'Open upload page again' : 'Open upload page', after(() => openUpload(item)), item.routes?.includes('api') ? '' : 'primary', { 'aria-label': `Open the upload page for ${label}` }));
      if (!inDialog) out.push(btn('Checklist', () => preparedDialog(item), '', { 'aria-label': `Checklist for ${label}` }));
      out.push(btn('Schedule', after(() => scheduleDialog(item)), 'quiet', { 'aria-label': `Schedule ${label}` }));
      out.push(btn('Mark posted', after(() => markPostedDialog(item)), 'quiet', { 'aria-label': `Mark ${label} posted` }));
      if (item.state === 'failed' || blocked) out.push(btn('Prepare again', after(() => prepareItem(item)), 'quiet', { 'aria-label': `Prepare ${label} again` }));
    }
    if (item.state === 'posted' && item.posted_url) out.push(el('a', { class: 'btn quiet', href: item.posted_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open post', 'aria-label': `Open the live post of ${label}` }));
    return out;
  }

  // The prepared post: the file, the text as it goes on the page, the AI label, cover, schedule and the checklist.
  async function preparedDialog(item) {
    const body = el('div', { class: 'sc-dialog sc-prepared' }, [el('p', { role: 'status', text: 'Loading...' })]);
    const dialog = openPanelDialog({ title: `${M.platformName(item.platform)}: ${item.title}`, body, className: 'sc-dialog-panel' });
    let prep;
    try { prep = await get(`/preparations/${item.prep_id}`); } catch (error) { body.replaceChildren(el('p', { role: 'alert', text: M.loadFailure(error) })); return; }
    const pkg = prep.package || {}, file = pkg.file || {}, fill = prep.fill || {};
    const copyable = (title, text) => el('div', { class: 'sc-block' }, [el('h4', { text: title }), el('p', { class: 'sc-text', text }),
      btn('Copy', async () => { await navigator.clipboard.writeText(text); toast(`${title} copied.`); }, 'quiet sc-copy', { 'aria-label': `Copy the ${title.toLowerCase()}` })]);
    const filled = new Set(fill.filled || []), missing = new Set(fill.missing || []);
    const stateOf = c => c.by !== 'kairos' ? ['You', 'muted'] : filled.has(c.key) ? ['Filled', 'ok'] : missing.has(c.key) ? ['Not found, do it yourself', 'warn'] : ['Kairos', 'accent'];
    body.replaceChildren(...[
      pkg.problems?.length ? el('div', { class: 'sc-warning', role: 'alert' }, [el('strong', { text: 'Fix before posting: ' }), pkg.problems.join(' ')]) : null,
      prep.error ? el('div', { class: 'sc-warning', role: 'alert' }, [el('strong', { text: 'Failed: ' }), prep.error]) : null,
      el('div', { class: 'sc-post-pills' }, [pill(M.stateLabel(item.state), M.stateTone(item.state)), pill(item.handle, 'muted'),
        pkg.ai_label ? pill(`${pkg.ai_label.name}: on`, 'accent') : null]),
      el('div', { class: 'sc-preview' }, [
        el('div', { class: 'sc-block' }, [el('h4', { text: 'Video' }), el('p', { class: 'sc-text', text: `${file.name || ''}, ${file.aspect || 'aspect unknown'}${file.seconds ? `, ${M.clock(file.seconds)}` : ''}${file.approved_file === false ? ' (the editor\'s export of the version you approved)' : ''}` })]),
        ...Object.entries(pkg.text || {}).map(([key, text]) => copyable(M.FILL_NAMES[key] || key, text)),
        pkg.hashtags_left_out?.length ? el('p', { class: 'sc-dim', text: `Left out (over ${M.platformName(item.platform)}'s hashtag count): ${pkg.hashtags_left_out.join(' ')}` }) : null,
        el('div', { class: 'sc-block' }, [el('h4', { text: pkg.cover?.name || 'Cover' }), el('p', { class: 'sc-text', text: pkg.cover?.file ? `${pkg.cover.file}${pkg.cover.what ? `: ${pkg.cover.what}` : ''}` : 'Pick a frame on the page.' })]),
        el('div', { class: 'sc-block' }, [el('h4', { text: 'Schedule' }), el('p', { class: 'sc-text', text: prep.scheduled_at ? M.timeText(prep.scheduled_at) : 'Not scheduled: it goes out when you post it.' })])]),
      el('h4', { class: 'sc-check-title', text: 'Checklist' }),
      el('ol', { class: 'sc-checklist', 'aria-label': 'Checklist' }, (pkg.checklist || []).map(c => {
        const [text, tone] = stateOf(c);
        return el('li', { class: `sc-check by-${c.by}`, 'data-check': c.key }, [pill(text, tone), el('span', { text: c.text })]);
      })),
      M.fillText(fill) ? note(M.fillText(fill)) : null,
      el('p', { class: 'sc-dim', text: pkg.rules_note || '' }),
      el('div', { class: 'sc-actions' }, itemActions(item, { inDialog: true, close: () => dialog.close() }))].filter(Boolean));
  }

  function publishRow(item) {
    const label = `${item.title} on ${M.platformName(item.platform)}`;
    const node = el('article', { class: `sc-pub sc-pub-${item.state}`, 'data-pub': item.post_id, 'aria-label': label }, [
      el('header', { class: 'sc-post-head' }, [
        el('h3', { class: 'sc-post-title', text: item.title }),
        el('div', { class: 'sc-post-pills' }, [pill(M.stateLabel(item.state), M.stateTone(item.state)), badge(M.platformName(item.platform), hueFor(item.platform)),
          el('span', { class: 'sc-dim', text: item.handle }), item.long_form ? pill('Long video', 'muted') : null])]),
      el('p', { class: 'sc-pub-when', text: M.whenText(item) }),
      el('p', { class: `sc-pub-next by-${item.next.who}`, text: M.nextText(item.next) }),
      item.state === 'waiting_for_you' && M.fillText(item.fill) ? el('p', { class: 'sc-dim', text: M.fillText(item.fill) }) : null,
      item.posted_url ? el('p', { class: 'sc-dim sc-pub-link' }, [el('a', { href: item.posted_url, target: '_blank', rel: 'noopener noreferrer', text: item.posted_url })]) : null,
      el('div', { class: 'sc-actions' }, itemActions(item))]);
    return node;
  }

  let pubView = 'list', pubFilter = 'all', pubWeek = null;
  function publishingView() {
    const pub = data.pub;
    if (!pub) return [el('p', { role: 'alert', class: 'sc-error', text: 'The publishing dashboard did not load. Try again in a moment.' }), btn('Try again', reload)];
    pubWeek ??= pub.this_week;
    const views = el('div', { class: 'sc-seg', role: 'group', 'aria-label': 'View' }, [['list', 'List'], ['week', 'Week']].map(([id, text]) =>
      btn(text, () => { pubView = id; draw(); }, pubView === id ? 'is-on' : 'quiet', { 'aria-pressed': String(pubView === id), 'data-view': id })));
    const filters = el('div', { class: 'sc-filters', role: 'group', 'aria-label': 'Show posts' }, [{ id: 'all', label: 'All', count: pub.items.length }, ...M.stateCounts(pub.counts)].map(f =>
      btn(`${f.label} ${f.count}`, () => { pubFilter = f.id; draw(); }, pubFilter === f.id ? 'is-on' : 'quiet', { 'aria-pressed': String(pubFilter === f.id), 'data-filter': f.id })));
    const intro = note('Every post, its state and what happens next. Prepare post assembles it for its platform; Open upload page fills the page in the Kairos Browser and stops before Post, which you press yourself.');
    const items = M.filterItems(pub.items, pubFilter);
    const out = [intro, el('div', { class: 'sc-bar sc-pub-bar' }, [filters, views])];
    if (!pub.items.length) return [...out, empty('No posts yet. They appear here from the first draft to the live link.')];
    if (pubView === 'week') {
      const days = M.weekDays(pubWeek), byDay = M.itemsByDay(items, pubWeek);
      out.push(el('div', { class: 'sc-week-nav' }, [
        btn('Previous week', () => { pubWeek = M.addDays(pubWeek, -7); draw(); }, 'quiet', { 'aria-label': 'Previous week' }),
        el('h3', { class: 'sc-week-title', text: M.weekLabel(pubWeek, pub.this_week) }),
        pubWeek !== pub.this_week ? btn('This week', () => { pubWeek = pub.this_week; draw(); }, 'quiet') : null,
        btn('Next week', () => { pubWeek = M.addDays(pubWeek, 7); draw(); }, 'quiet', { 'aria-label': 'Next week' })]));
      out.push(el('div', { class: 'sc-week', role: 'list', 'aria-label': 'Posts by day' }, days.map((day, i) => el('section', { class: `sc-day${day.at === M.addDays(Date.now() / 1000, 0) ? ' is-today' : ''}`, role: 'listitem', 'aria-label': `${day.label}, ${byDay[i].length} posts` }, [
        el('h4', { class: 'sc-day-title', text: day.label }),
        ...(byDay[i].length ? byDay[i].map(item => {
          const chip = el('button', { type: 'button', class: `sc-cal sc-pub-${item.state}`, 'data-pub': item.post_id, 'aria-label': `${item.title}, ${M.platformName(item.platform)}, ${M.stateLabel(item.state)}` }, [
            el('span', { class: 'sc-cal-time', text: M.timeText(item.when).split(', ')[1] }), el('span', { class: 'sc-cal-title', text: item.title }),
            el('span', { class: 'sc-cal-meta' }, [badge(M.platformName(item.platform), hueFor(item.platform)), pill(M.stateLabel(item.state), M.stateTone(item.state))])]);
          chip.addEventListener('click', () => item.prep_id ? preparedDialog(item) : openDetails({ kind: 'post', id: item.post_id, title: item.title, step: item.state, owner: item.next.who === 'you' ? 'user' : 'publisher', age_h: 0, niche_name: item.niche, platform: item.platform }, chip));
          return chip;
        }) : [el('p', { class: 'sc-none', text: 'Nothing.' })])]))));
      return out;
    }
    if (!items.length) out.push(empty('No posts in this state.'));
    out.push(...items.map(publishRow));
    return out;
  }

  // Page-read analytics switches on the Channels tab: TikTok and Instagram, each off until the person turns it on.
  function pageReadsGroup() {
    const reads = data.pub?.page_reads;
    if (!reads) return null;
    const rows = Object.entries(reads.platforms).map(([platform, p]) => {
      const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `Read ${p.name} numbers from your signed-in pages`, ...(p.on ? { checked: '' } : {}) });
      toggle.checked = !!p.on;
      toggle.addEventListener('change', async () => {
        try { await put('/analytics/pages', { [platform]: toggle.checked }); toast(toggle.checked ? `${p.name} page reads on.` : `${p.name} page reads off.`); await reload(); }
        catch (error) { say(error); toggle.checked = !toggle.checked; }
      });
      const controls = [toggle];
      if (p.on && p.paused === 'page_changed') controls.push(btn('Try again', async () => { await send('/analytics/pages/try-again', { platform }); toast('Reading again from now.'); await reload(); }, '', { 'aria-label': `Try ${p.name} page reads again` }));
      else if (p.on) controls.push(btn('Read now', async () => { await send('/analytics/pages/read', { platform }); toast(`Reading ${p.name} pages, 20 seconds apart.`); }, 'quiet', { 'aria-label': `Read ${p.name} numbers now` }));
      return row({ title: p.name, description: M.pageReadText(p), control: controls, attrs: { 'data-page-reads': platform } });
    });
    return group({ title: 'TikTok and Instagram numbers', description: reads.note }, [...rows, el('p', { class: 'sc-dim sc-notice', text: `Read-only, at most ${Object.values(reads.platforms)[0]?.max_per_day || 40} pages a day per platform, each post once a day, only your own posts. ${reads.desktop ? '' : 'Needs the Kairos desktop app open. '}${reads.rules_note}` })]);
  }

  // -- approvals -------------------------------------------------------------------------------

  // A long video's shot plan: its chapters and shots, then Approve (the render may start) or Reject with a note.
  function planCard(v) {
    const node = el('article', { class: 'sc-post sc-plan', 'data-plan': v.video_id, 'aria-label': `Shot plan of ${v.title}` });
    const header = el('header', { class: 'sc-post-head' }, [el('h3', { class: 'sc-post-title', text: `Long video plan: ${v.title}` }),
      el('div', { class: 'sc-post-pills' }, [pill(`${Math.round((v.seconds || 0) / 6) / 10} min`, 'accent'), pill(`${(v.chapters || []).length} chapters`, 'muted')])]);
    const chapters = el('ol', { class: 'sc-chapters' }, (v.chapters || []).map(c => el('li', { text: `${M.clock(c.start)} ${c.title}` })));
    const plan = el('details', { class: 'sc-plan-text' }, [el('summary', { text: 'Every shot' }), el('pre', { class: 'sc-text', text: v.text || '' })]);
    const view = () => node.replaceChildren(header, chapters, plan, note('It renders only after you approve this plan. A change to the plan comes back to you.'),
      el('div', { class: 'sc-actions' }, [
        btn('Approve plan', async () => { await sendTo(`/api/videos/${v.video_id}/plan/approve`); toast('Plan approved. The team can render it now.'); await reload(); }, 'primary', { 'aria-label': `Approve the plan of ${v.title}` }),
        btn('Reject', () => asking(), 'quiet danger', { 'aria-label': `Reject the plan of ${v.title}` })]));
    const asking = () => {
      const reason = el('textarea', { rows: 3, 'aria-label': 'What should change?', maxlength: '500', placeholder: 'What should change? The team sees this.' });
      node.replaceChildren(header, chapters, plan, reason, el('div', { class: 'sc-actions' }, [
        btn('Reject plan', async () => { await sendTo(`/api/videos/${v.video_id}/plan/reject`, { reason: reason.value.trim() }); toast('Plan rejected.'); await reload(); }, 'danger'),
        btn('Cancel', () => view(), 'quiet')]));
      reason.focus();
    };
    view();
    return node;
  }

  function approvalsView() {
    const sheets = [...data.plans.map(planCard), ...data.packsWaiting.map(v => packCard(v)), ...data.sheets.map(sheetCard)];
    if (!data.approvals.length) return sheets.length ? sheets : [empty('Nothing is waiting for you. Posts appear here when the Producer brings them for approval.')];
    const out = [...sheets, note('Approving marks a post approved. Nothing is posted by approving: the Publisher prepares it, and you post it from Publishing.')];
    const count = data.approvals.length;
    if (data.settings?.batch_approval && count > 1) {
      out.push(el('div', { class: 'sc-actions sc-batch' }, [btn(`Approve all ${count}`, async () => {
        const ok = await confirmDialog({ title: `Approve all ${count} posts?`, message: 'Each post shown here is approved as it is now. Nothing is posted by approving.', confirmLabel: 'Approve all', danger: false });
        if (!ok) return;
        const result = await send('/approvals/approve-batch', { post_ids: data.approvals.map(p => p.id) });
        toast(M.batchText(result)); await reload();
      }, 'primary', { 'aria-label': `Approve all ${count} posts` })]));
    }
    return [...out, ...data.approvals.map(approvalCard)];
  }
  function approvalCard(post) {
    const node = el('article', { class: 'sc-post', 'data-post-id': post.id, 'aria-label': post.title });
    const header = () => el('header', { class: 'sc-post-head' }, [el('h3', { class: 'sc-post-title', text: post.title }),
      el('div', { class: 'sc-post-pills' }, [pill(M.platformName(post.platform), 'accent'), pill(post.niche_name, 'muted'), post.rejection_count ? pill(`Rejected ${post.rejection_count}x before`, 'warn') : null])]);
    const done = async text => { toast(text); await reload(); };
    const view = () => {
      const actions = el('div', { class: 'sc-actions' }, [
        btn('Approve', async () => { await send(`/posts/${post.id}/approve`); await done('Approved. It is in Publishing, ready to prepare.'); }, 'primary', { 'aria-label': `Approve ${post.title}` }),
        btn('Edit', () => node.replaceChildren(header(), editor()), '', { 'aria-label': `Edit ${post.title}` }),
        btn('Reject', () => asking('reject'), 'quiet danger', { 'aria-label': `Reject ${post.title}` }),
        btn('Redraft', () => asking('redraft'), 'quiet', { 'aria-label': `Redraft ${post.title}` })]);
      node.replaceChildren(header(), postBody(post), actions, el('p', { class: 'sc-dim sc-post-note', text: 'After you approve, Publishing prepares it and opens the upload page; you press Post yourself.' }));
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
      const script = el('textarea', { rows: 4, 'aria-label': 'Script', maxlength: '20000' }); script.value = post.script_ref || '';
      const kids = selectOf('Made for kids', M.POST_KIDS_OPTIONS, M.kidsValue(post.made_for_kids));
      const save = btn('Save changes', async () => {
        const changes = {};
        if (title.value !== post.title) changes.title = title.value;
        if (caption.value !== (post.caption || '')) changes.caption = caption.value;
        if (script.value !== (post.script_ref || '')) changes.script_ref = script.value;
        if (kids.value !== M.kidsValue(post.made_for_kids)) changes.made_for_kids = kids.value;
        if (Object.keys(changes).length) Object.assign(post, await send(`/posts/${post.id}/edit`, changes));
        toast('Saved.'); view();
      }, 'primary');
      return el('div', { class: 'sc-edit' }, [group({}, [row({ title: 'Title', control: title, stack: true }), row({ title: 'Caption', control: caption, stack: true }),
        row({ title: 'Script', control: script, stack: true }),
        row({ title: 'Made for kids', description: 'This post\'s own answer; left as the channel\'s, the channel decides.', control: kids })]), el('div', { class: 'sc-actions' }, [save, btn('Cancel', () => view(), 'quiet')])]);
    };
    view();
    return node;
  }

  // -- characters (Pack A) -------------------------------------------------------------------------

  // A sheet waiting for the person: the picture, then Approve or Reject with a note.
  function sheetCard(v) {
    const node = el('article', { class: 'sc-post sc-sheet', 'data-sheet': `${v.id}-${v.version}`, 'aria-label': `${v.name} character sheet` });
    const title = `${v.name}, version ${v.version}`;
    const header = el('header', { class: 'sc-post-head' }, [el('h3', { class: 'sc-post-title', text: `Character sheet: ${title}` }),
      el('div', { class: 'sc-post-pills' }, [pill(M.characterStatus(v.status)[0], 'accent'), pill(v.family, 'muted')])]);
    const image = el('img', { class: 'sc-sheet-img', src: M.sheetUrl(v.id, v.version), alt: `Reference sheet of ${title}: every view, expression and mouth shape, and the palette`, loading: 'lazy' });
    const view = () => node.replaceChildren(header, image, v.note ? el('p', { class: 'sc-dim', text: v.note }) : null,
      note('Approving lets videos cast this version. Every frame is drawn from the same numbers, so it stays this character.'),
      el('div', { class: 'sc-actions' }, [
        btn('Approve', async () => { await sendTo(`${CHARACTERS}/${v.id}/versions/${v.version}/approve`); toast(`${v.name} version ${v.version} approved.`); await reload(); }, 'primary', { 'aria-label': `Approve ${title}` }),
        btn('Reject', () => asking(), 'quiet danger', { 'aria-label': `Reject ${title}` })]));
    const asking = () => {
      const reason = el('textarea', { rows: 3, 'aria-label': 'What should change?', maxlength: '500', placeholder: 'What should change? The next version follows it.' });
      node.replaceChildren(header, image, reason, el('div', { class: 'sc-actions' }, [
        btn('Reject sheet', async () => { await sendTo(`${CHARACTERS}/${v.id}/versions/${v.version}/reject`, { reason: reason.value.trim() }); toast('Rejected.'); await reload(); }, 'danger'),
        btn('Cancel', () => view(), 'quiet')]));
      reason.focus();
    };
    view();
    return node;
  }

  function newCharacterDialog() {
    const family = selectOf('Family', M.FAMILIES, 'round');
    const name = textInput('Name', { maxlength: '40', placeholder: 'For example, Pip' });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [
      note('Kairos starts from its own round, square or triangle design with dot eyes. Change the colours in a new version. Never another channel\'s characters.'),
      group({}, [row({ title: 'Family', control: family }), row({ title: 'Name', control: name, stack: true })]), status]);
    const make = btn('Make character', async () => {
      status.textContent = '';
      try { await sendTo(CHARACTERS, { family: family.value, ...(name.value.trim() ? { name: name.value.trim() } : {}) }); }
      catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('Character made. Make its sheet to send it for approval.'); await draw();
    }, 'primary');
    const dialog = openPanelDialog({ title: 'New character', body, footer: el('div', {}, [make]), className: 'sc-dialog-panel' });
  }

  async function versionDialog(character) {
    const got = await api(`${CHARACTERS}/${character.id}`), spec = got.spec;
    const colour = (key, label) => { const node = el('input', { type: 'color', 'aria-label': label, value: spec.palette[key] }); return [key, label, node]; };
    const colours = [colour('body', 'Body'), colour('body_shade', 'Body shade'), colour('head', 'Head'), colour('accent', 'Accent')];
    const accessory = selectOf('Accessory', M.ACCESSORIES, spec.accessory);
    const name = textInput('Name', { value: spec.name, maxlength: '40' });
    const why = textInput('What changed', { maxlength: '300', placeholder: 'For example, warmer orange for the autumn series' });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [note('Any change makes a new version. Older versions stay as they were, and videos keep the version they cast.'),
      group({}, [row({ title: 'Name', control: name, stack: true }), ...colours.map(([, label, node]) => row({ title: label, control: node })),
        row({ title: 'Accessory', control: accessory }), row({ title: 'What changed', control: why, stack: true })]), status]);
    const save = btn('Save new version', async () => {
      status.textContent = '';
      const changes = M.characterChanges(spec, { ...Object.fromEntries(colours.map(([key, , node]) => [key, node.value])), accessory: accessory.value, name: name.value });
      if (!Object.keys(changes).length) { status.textContent = 'Change something first.'; return; }
      try { await sendTo(`${CHARACTERS}/${character.id}/versions`, { changes, note: why.value.trim() }); }
      catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('New version saved as a draft.'); await draw();
    }, 'primary');
    const dialog = openPanelDialog({ title: `New version of ${character.name}`, body, footer: el('div', {}, [save]), className: 'sc-dialog-panel' });
  }

  async function charactersView() {
    const got = await api(CHARACTERS);
    const out = [el('div', { class: 'sc-bar' }, [note('Characters for the Flat 2D style pack. Each version has a reference sheet you approve; videos can only use an approved version.'),
      btn('New character', () => newCharacterDialog())])];
    if (!got.characters.length) out.push(empty('No characters yet. Make one here, or the Editor makes one when a channel uses the Flat 2D pack.'));
    for (const character of got.characters) {
      const rows = [...character.versions].reverse().map(v => {
        const [label, tone] = M.characterStatus(v.status), controls = [pill(label, tone)];
        if (v.status === 'draft' || v.status === 'rejected') controls.push(btn('Make sheet', async () => {
          await sendTo(`${CHARACTERS}/${character.id}/versions/${v.version}/sheet`); toast('Sheet made. It is waiting for your OK in Approvals.'); await reload();
        }, '', { 'aria-label': `Make the sheet of ${character.name} version ${v.version}` }));
        if (v.status === 'awaiting_approval') controls.push(btn('Review', () => select('approvals'), 'primary', { 'aria-label': `Review ${character.name} version ${v.version}` }));
        const below = v.sheet_url ? el('a', { href: v.sheet_url, target: '_blank', rel: 'noopener', class: 'sc-sheet-link' },
          [el('img', { class: 'sc-sheet-thumb', src: v.sheet_url, alt: `Sheet of ${character.name} version ${v.version}`, loading: 'lazy' })]) : null;
        return row({ title: `Version ${v.version}`, description: [v.note, v.reason ? `Rejected: ${v.reason}` : ''].filter(Boolean).join(' ') || ' ',
          control: controls, below, attrs: { 'data-character-version': `${character.id}-${v.version}` } });
      });
      out.push(group({ title: character.name, description: `${character.family[0].toUpperCase() + character.family.slice(1)} family. ${M.castableText(character)}`, cls: 'sc-character',
        actions: [btn('New version', () => versionDialog(character), 'quiet', { 'aria-label': `New version of ${character.name}` })] }, rows));
    }
    return out;
  }

  // -- style packs ---------------------------------------------------------------------------------

  // A pack version waiting for the person: its sample video and contact sheet, then Approve or Reject with a note.
  function packCard(v) {
    const title = `${v.name}, version ${v.version}`;
    const node = el('article', { class: 'sc-post sc-pack', 'data-pack-approval': `${v.id}-${v.version}`, 'aria-label': `${v.name} style pack` });
    const header = el('header', { class: 'sc-post-head' }, [el('h3', { class: 'sc-post-title', text: `Style pack: ${title}` }),
      el('div', { class: 'sc-post-pills' }, [pill(M.packStatus(v)[0], 'accent')])]);
    const base = `${STYLES}/${encodeURIComponent(v.id)}/versions/${Number(v.version)}`;
    const media = el('div', { class: 'sc-pack-media' }, [
      el('video', { class: 'sc-pack-video', src: `${base}/sample.mp4`, controls: '', preload: 'metadata', 'aria-label': `Sample video of ${title}` }),
      el('img', { class: 'sc-sheet-img', src: `${base}/sample-sheet.png`, alt: `Contact sheet of the ${title} sample`, loading: 'lazy' })]);
    const notes = (v.sample?.notes || []).slice(0, 6);
    const view = () => node.replaceChildren(header, media,
      notes.length ? el('ul', { class: 'sc-problems' }, notes.map(n => el('li', { text: n }))) : el('p', { class: 'sc-dim', text: 'The sample passed its checks.' }),
      note('Approving lets channels and videos use this version. Its characters keep their own approved sheets.'),
      el('div', { class: 'sc-actions' }, [
        btn('Approve', async () => { await sendTo(`${base}/approve`); toast(`${v.name} version ${v.version} approved.`); await reload(); }, 'primary', { 'aria-label': `Approve ${title}` }),
        btn('Reject', () => asking(), 'quiet danger', { 'aria-label': `Reject ${title}` })]));
    const asking = () => {
      const reason = el('textarea', { rows: 3, 'aria-label': 'What should change?', maxlength: '500', placeholder: 'What should change? The next version follows it.' });
      node.replaceChildren(header, media, reason, el('div', { class: 'sc-actions' }, [
        btn('Reject pack', async () => { await sendTo(`${base}/reject`, { reason: reason.value.trim() }); toast('Rejected.'); await reload(); }, 'danger'),
        btn('Cancel', () => view(), 'quiet')]));
      reason.focus();
    };
    view();
    return node;
  }

  function briefDialog() {
    const brief = el('textarea', { rows: 12, 'aria-label': 'Brief', maxlength: '12000',
      placeholder: 'Describe the style like notes to a director: the look and colours, the characters, the scenes, the camera, the pacing, the sound and the captions.' });
    const name = textInput('Name', { maxlength: '60', placeholder: 'Optional. For example, Calm space explainer' });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [
      note('A model from your Settings > Models turns the brief into the pack\'s look, scenes, pacing and sound. The brief stays with the pack. Use your own characters and words, never another channel\'s.'),
      group({}, [row({ title: 'Brief', control: brief, stack: true }), row({ title: 'Name', control: name, stack: true })]), status]);
    const make = btn('Make pack', async () => {
      status.textContent = '';
      if (!brief.value.trim()) { status.textContent = 'Write the brief first.'; return; }
      status.textContent = 'Turning the brief into a pack...';
      try { await sendTo(STYLES, { source: 'brief', brief: brief.value.trim(), name: name.value.trim() }); }
      catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('Pack made as a draft. Render its sample to send it for your OK.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: 'New style pack from a brief', body, footer: el('div', {}, [make]), className: 'sc-dialog-panel' });
  }

  function duplicateDialog(pack) {
    const name = textInput('Name', { maxlength: '60', value: `${pack.name.slice(0, 52)} copy` });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [note('The copy is a new pack of your own, starting as a draft. The original stays as it is.'),
      group({}, [row({ title: 'Name', control: name, stack: true })]), status]);
    const go = btn('Duplicate', async () => {
      status.textContent = '';
      try { await sendTo(STYLES, { source: 'duplicate', pack_id: pack.id, name: name.value.trim() }); }
      catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('Duplicated as a draft.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: `Duplicate ${pack.name}`, body, footer: el('div', {}, [go]), className: 'sc-dialog-panel' });
  }

  function editDialog(pack) {
    const spec = pack.spec;
    const name = textInput('Name', { maxlength: '60', value: spec.name });
    const summary = el('textarea', { rows: 2, 'aria-label': 'Summary', maxlength: '300' }); summary.value = spec.summary || '';
    const brief = el('textarea', { rows: 12, 'aria-label': 'Director brief', maxlength: '12000' }); brief.value = spec.director_brief || '';
    const mood = selectOf('Music mood', [['energetic', 'Energetic'], ['calm', 'Calm'], ['warm', 'Warm'], ['dark', 'Dark'], ['playful', 'Playful']], spec.music.mood);
    const caseSel = selectOf('Caption case', [['sentence', 'Sentence case'], ['upper', 'Upper case']], spec.captions.case);
    const captions = selectOf('Captions', [['on', 'On'], ['off', 'Off']], spec.captions.on ? 'on' : 'off');
    const voice = textInput('Narrator voice', { maxlength: '40', value: spec.voice.voice });
    const three = spec.base === 'glossy-3d', status3d = data.styles?.renderers;
    const renderer = three ? selectOf('3D renderer', M.rendererOptions(status3d), spec.renderer) : null;
    if (renderer && !status3d?.blender?.supported) renderer.querySelector('option[value="blender"]').disabled = spec.renderer !== 'blender';
    const why = textInput('What changed', { maxlength: '300', placeholder: 'For example, calmer music for the night series' });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [note('Any change makes a new version, a draft until you approve its sample. Older versions stay as they were.'),
      group({}, [row({ title: 'Name', control: name, stack: true }), row({ title: 'Summary', control: summary, stack: true }),
        row({ title: 'Director brief', description: 'The long notes the team follows when it makes a video in this pack.', control: brief, stack: true }),
        row({ title: 'Music mood', control: mood }), row({ title: 'Captions', control: captions }), row({ title: 'Caption case', control: caseSel }),
        row({ title: 'Narrator voice', description: 'A Kokoro voice id, for example af_heart.', control: voice, stack: true }),
        three ? row({ title: '3D renderer', description: M.rendererText('blender', status3d).startsWith('Blender, but') ? 'three.js is built in. Blender isn\'t installed on this computer; install it yourself from blender.org to pick it.' : 'three.js is built in and fast. Blender is installed here: softer, more realistic light, much slower.', control: renderer }) : null,
        row({ title: 'What changed', control: why, stack: true })]), status]);
    const save = btn('Save new version', async () => {
      status.textContent = '';
      const changes = {};
      if (name.value.trim() !== spec.name) changes.name = name.value.trim();
      if (summary.value.trim() !== (spec.summary || '')) changes.summary = summary.value.trim();
      if (brief.value.trim() !== (spec.director_brief || '')) changes.director_brief = brief.value.trim();
      if (mood.value !== spec.music.mood) changes.music = { mood: mood.value };
      const on = captions.value === 'on';
      if (on !== spec.captions.on || caseSel.value !== spec.captions.case) changes.captions = { on, case: caseSel.value };
      if (voice.value.trim() !== spec.voice.voice) changes.voice = { voice: voice.value.trim() };
      if (renderer && renderer.value !== spec.renderer) changes.renderer = renderer.value;
      if (!Object.keys(changes).length) { status.textContent = 'Change something first.'; return; }
      try { await sendTo(`${STYLES}/${encodeURIComponent(pack.id)}/versions`, { changes, note: why.value.trim() }); }
      catch (error) { status.textContent = M.loadFailure(error); return; }
      dialog.close(); toast('New version saved as a draft.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: `Edit ${pack.name}`, body, footer: el('div', {}, [save]), className: 'sc-dialog-panel' });
  }

  function importDialog() {
    const file = el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Style pack file' });
    const status = el('p', { class: 'set-error', role: 'alert' });
    const body = el('div', { class: 'sc-dialog' }, [
      note('A style pack file holds data only: the look, the rules, the brief and its characters. Nothing in it runs. It arrives as a draft: render its sample and approve it, and approve its characters\' sheets, before any channel uses it.'),
      group({}, [row({ title: 'Pack file', control: file })]), status]);
    const go = btn('Import', async () => {
      status.textContent = '';
      const chosen = file.files?.[0];
      if (!chosen) { status.textContent = 'Choose a pack file first.'; return; }
      const form = new FormData(); form.append('file', chosen);
      const res = await fetch(`${STYLES}/import`, { method: 'POST', body: form });
      if (!res.ok) { let detail = ''; try { detail = (await res.json()).detail; } catch { /* No body. */ } status.textContent = typeof detail === 'string' && detail ? detail : 'That file could not be imported.'; return; }
      dialog.close(); toast('Imported as a draft.'); await reload();
    }, 'primary');
    const dialog = openPanelDialog({ title: 'Import a style pack', body, footer: el('div', {}, [go]), className: 'sc-dialog-panel' });
  }

  function packVersionRow(pack, v) {
    const [label, tone] = M.packStatus(v), controls = [pill(label, tone)];
    const base = `${STYLES}/${encodeURIComponent(pack.id)}/versions/${v.version}`;
    if (v.status === 'draft' || v.status === 'rejected') {
      const rendering = v.sample?.status === 'rendering';
      controls.push(btn(rendering ? 'Rendering' : 'Make sample', async () => {
        const out = await sendTo(`${base}/sample`);
        const now = out.versions?.find(x => x.version === v.version);
        toast(now?.sample?.status?.startsWith('waiting') ? 'Character sheets sent for your OK first. Approve them, then make the sample.' : 'Rendering the sample. It takes a few minutes.');
        await reload();
      }, '', { 'aria-label': `Make the sample of ${pack.name} version ${v.version}`, ...(rendering ? { disabled: '' } : {}) }));
    }
    if (v.status === 'awaiting_approval') controls.push(btn('Review', () => select('approvals'), 'primary', { 'aria-label': `Review ${pack.name} version ${v.version}` }));
    const bits = [v.note, v.reason ? `Rejected: ${v.reason}` : '', v.sample?.status?.startsWith('failed') ? v.sample.status : '',
      v.sample?.waiting?.length ? `Waiting for the sheets of ${v.sample.waiting.join(', ')}.` : ''].filter(Boolean);
    const below = v.sample_url ? el('div', { class: 'sc-pack-links' }, [el('a', { href: v.sample_url, target: '_blank', rel: 'noopener', text: 'Watch the sample' }), ' ',
      el('a', { href: v.sheet_url, target: '_blank', rel: 'noopener', text: 'Contact sheet' })]) : null;
    return row({ title: `Version ${v.version}`, description: bits.join(' ') || ' ', control: controls, below, attrs: { 'data-pack-version': `${pack.id}-${v.version}` } });
  }

  async function stylesView() {
    const got = await api(STYLES);
    data.styles = got;
    const hasStarter = id => got.packs.some(p => p.origin?.kind === 'starter' && p.origin?.from === id);
    const actions = [btn('New from a brief', () => briefDialog(), 'primary'), btn('Import', () => importDialog())];
    for (const starter of got.starters || []) {
      if (!hasStarter(starter.id)) actions.push(btn(`Add ${starter.name}`, async () => {
        await sendTo(STYLES, { source: 'starter', starter: starter.id }); toast(`${starter.name} added as a draft. Make its sample to review it.`); await reload();
      }, '', { 'aria-label': `Add the starter pack ${starter.name}` }));
    }
    const out = [el('div', { class: 'sc-bar' }, [note('A style pack is how a channel\'s videos look and sound: palette, characters, scenes, camera, pacing, captions, music and voice, with a director brief the team follows. You approve each pack from its sample before a channel can use it.'),
      el('div', { class: 'sc-actions' }, actions)])];
    if (!got.packs.length) out.push(empty('No style packs yet. Write a brief, add the starter pack, or import a pack file.'));
    for (const pack of got.packs) {
      const spec = pack.spec;
      const rows = M.packFacts(spec, got.renderers).map(([k, v]) => row({ title: k, description: v, stack: true }));
      if (spec?.director_brief) {
        rows.push(row({ title: 'Director brief', stack: true, below: el('details', { class: 'sc-brief' }, [el('summary', { text: 'Show the brief' }), el('p', { class: 'sc-text', text: spec.director_brief })]) }));
      }
      rows.push(...[...pack.versions].reverse().map(v => packVersionRow(pack, v)));
      const latest = pack.versions.at(-1);
      const tools = [btn('Edit', () => editDialog(pack), 'quiet', { 'aria-label': `Edit ${pack.name}` }),
        btn('Duplicate', () => duplicateDialog(pack), 'quiet', { 'aria-label': `Duplicate ${pack.name}` }),
        el('a', { class: 'btn quiet', href: latest.export_url.replace(/v=\d+$/, `v=${pack.approved_version || latest.version}`), download: '', text: 'Export', 'aria-label': `Export ${pack.name}` })];
      if (pack.approved_version) tools.push(libraryShareButton('style_pack', pack.id, { text: 'Share' }));
      out.push(group({ title: pack.name, description: [spec?.summary, M.packOriginText(pack.origin), M.packUseText(pack)].filter(Boolean).join(' '), cls: 'sc-style-pack',
        actions: tools }, rows));
    }
    const built = got.built_in.map(p => row({ title: p.name, description: p.note, control: pill(p.available ? 'Available' : 'Not built yet', p.available ? 'ok' : 'muted'), attrs: { 'data-pack': p.id } }));
    out.push(group({ title: 'Built into Kairos', description: 'The engines every pack is drawn by.' }, built));
    return out;
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
    if (board.formats.length) out.push(group({ title: 'Formats' }, M.rankRows(board.formats).map(r => scoreRow(r, r.status === 'retired' ? 'Retired' : r.kind === 'card' ? '' : 'No card'))));
    if (board.style_packs?.length) out.push(group({ title: 'Style packs' }, M.rankRows(board.style_packs).map(r => scoreRow(r, r.available === false ? 'Not built yet' : ''))));
    out.push(group({ title: 'Recent decisions', description: 'Every retirement, promotion and swap is kept with its numbers.' },
      sorted.recent.length ? sorted.recent.slice(0, 12).map(d => decisionRow(d)) : [empty('No decisions yet.')]));
    out.push(settingsGroup());
    return out;
  }

  function settingsGroup() {
    const s = data.settings || {};
    const pct = M.weightPercents(s.weights || { views: 0.4, watch: 0.4, engagement: 0.2 });
    const inputs = Object.fromEntries(M.WEIGHTS.map(([k, label]) => [k, el('input', { type: 'number', min: '0', max: '100', step: '1', inputmode: 'numeric', 'aria-label': `${label} weight, percent`, value: String(pct[k]) })]));
    const status = el('p', { class: 'set-error', role: 'alert' });
    const save = btn('Save weights', async () => {
      status.textContent = '';
      const built = M.weightsFromPercents(Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value])));
      if (built.error) { status.textContent = built.error; return; }
      data.settings = await put('/settings', { weights: built.weights });
      toast('Weights saved. Scores use them from now on.'); draw();
    }, '', { 'aria-label': 'Save score weights' });
    const batch = selectOf('One-tap batch approval', [['off', 'Off'], ['on', 'On']], s.batch_approval ? 'on' : 'off');
    batch.addEventListener('change', async () => {
      try { data.settings = await put('/settings', { batch_approval: batch.value === 'on' }); toast(batch.value === 'on' ? 'Batch approval is on.' : 'Batch approval is off.'); }
      catch (error) { say(error); batch.value = data.settings?.batch_approval ? 'on' : 'off'; }
    });
    return group({ title: 'Team settings', description: 'Each part is ranked within its platform before mixing, so these are shares of the score.' }, [
      ...M.WEIGHTS.map(([k, label]) => row({ title: label, control: inputs[k] })), row({ title: 'Save', description: 'Shares of 100. Scores use them from the next read.', control: save, below: status }),
      row({ title: 'One-tap batch approval', description: 'Approve every post waiting for you with one tap. Off by default: each post gets its own OK.', control: batch })]);
  }
  function scoreRow(r, tag) {
    const enough = r.eligible && r.score != null;
    return row({ title: [r.name, tag ? pill(tag, 'muted') : null], attrs: { 'data-score-row': r.name },
      description: enough ? `${r.posts_scored} posts scored over ${Math.round(r.age_days)} days` : `${r.not_yet || 'No posts yet'}. ${r.posts_posted} posted.`,
      control: enough ? el('span', { class: 'sc-score', text: M.scoreText(r) }) : pill('Needs more data', 'muted') });
  }
  function decisionRow(d, controls) {
    const [label, tone] = M.decisionStatus(d);
    return row({ title: [M.decisionTitle(d)], description: [d.reason, M.decisionNumbers(d) ? ` (${M.decisionNumbers(d)})` : '', M.decisionEvidence(d) ? ` ${M.decisionEvidence(d)}` : ''].join(''),
      control: controls || [pill(label, tone), el('span', { class: 'sc-dim', text: longDate(d.at) })], attrs: { 'data-decision-id': d.id } });
  }
  function decisionAsk(d) {
    const consequence = d.kind === 'retire' ? ` Its live channels are archived with their history kept. Nothing is deleted.`
      : d.kind === 'add' ? ' The niche starts with no channels. Create them yourself on each platform, then add them in Channels.' : '';
    return decisionRow(d, [
      btn('Confirm', async () => {
        const ok = await confirmDialog({ title: `${M.decisionTitle(d)}?`, message: `${d.reason}${consequence}`, confirmLabel: 'Confirm', danger: false });
        if (!ok) return;
        await send(`/decisions/${d.id}/confirm`, { actor: 'user' }); toast('Confirmed.'); await reload();
      }, 'primary', { 'aria-label': `Confirm: ${M.decisionTitle(d)}` }),
      btn('Reject', async () => { await send(`/decisions/${d.id}/reject`, { reason: '' }); toast('Rejected. Nothing changed.'); await reload(); }, 'quiet danger', { 'aria-label': `Reject: ${M.decisionTitle(d)}` })]);
  }

  // -- format cards and ports ----------------------------------------------------------------------

  async function formatsView() {
    const got = await get('/formats');
    const packs = got.style_packs || [];
    const out = [note('A format card is the structure of a video that worked somewhere else: its premise, beats, length and audience, with the links and dates behind every number. The Researcher can propose porting it into one of your niches with a new premise, our own mascot, title and look. The Evaluator checks each port before any episode is made, and every post still waits for your OK.')];
    if (!got.formats.length) out.push(empty('No format cards yet. The Researcher writes one when it finds a format that works, with its sources.'));
    for (const card of got.formats) out.push(formatCard(card, got.ports.filter(p => p.format_id === card.id), packs));
    out.push(group({ title: 'Style packs', description: 'How a post looks and is rendered. Only packs that are built can be picked; cost is a planning estimate, not measured.' },
      packs.map(p => row({ title: p.name, description: p.note, control: pill(p.available ? 'Available' : 'Not built yet', p.available ? 'ok' : 'muted'), attrs: { 'data-pack': p.id } }))));
    return out;
  }

  function formatCard(card, ports, packs) {
    const rows = [
      row({ title: 'Beats', description: card.beats.join(', '), stack: true }),
      row({ title: 'Typical length', control: el('span', { class: 'set-mono', text: M.formatLength(card.length_min_s, card.length_max_s) }) }),
      row({ title: 'Audience', description: M.audienceText(card.audience), stack: true }),
      row({ title: 'Seen in', description: card.source_niche || 'Not named', stack: true }),
      ...card.evidence.map(e => row({ title: [el('a', { href: e.url, text: e.title || e.channel, target: '_blank', rel: 'noopener noreferrer' })],
        description: `${e.channel}. ${M.evidenceText(e)}`, stack: true, attrs: { 'data-evidence': e.url } })),
      row({ title: 'Not ours to use', description: card.do_not_use.join(', ') || 'Nothing listed', stack: true }),
    ];
    if (!ports.length) rows.push(row({ title: 'Ports', description: 'Not ported into any of your niches yet.' }));
    for (const port of ports) rows.push(portRow(port, packs));
    return group({ title: card.name, description: card.premise, cls: 'sc-format' }, rows);
  }

  function portRow(port, packs) {
    const [label, tone] = M.portStatus(port);
    const checks = M.portChecks(port.checks);
    const changes = [['New premise', port.premise], ['Subject', port.subject], ['Mascot', port.mascot], ['Style pack', M.packName(port.style_pack, packs)],
      ['Thumbnail', port.thumbnail], ['Example title', port.example_title]];
    const below = el('div', { class: 'sc-port' }, [
      el('p', { class: 'sc-text', text: `Because: ${port.audience_match}` }),
      ...port.audience_evidence.map(e => el('p', { class: 'sc-dim' }, [el('a', { href: e.url, text: e.supports, target: '_blank', rel: 'noopener noreferrer' }), ` Checked ${e.checked}.`])),
      el('dl', { class: 'sc-changes' }, changes.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v || 'None' })])),
      checks.length ? el('div', { class: 'sc-checks', 'data-port-checks': '' }, checks.map(([name, result, t]) => pill(`${name}: ${result}`, t))) : el('p', { class: 'sc-dim', text: 'Not checked yet.' }),
      ...M.portReasons(port.checks).map(r => el('p', { class: 'sc-dim', text: r })),
      port.checks?.cost ? el('p', { class: 'sc-dim', text: M.costText(port.checks.cost) }) : null,
      port.verdict_reason ? el('p', { class: 'sc-dim', text: `The Evaluator: ${port.verdict_reason}` }) : null]);
    return row({ title: `From ${port.source_niche || 'another niche'} into ${port.niche_name}`, control: pill(label, tone), below, stack: true,
      attrs: { 'data-port-id': port.id } });
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
    tab ||= data.approvals.length || data.plans.length || data.sheets.length || data.packsWaiting.length ? 'approvals' : 'pipeline';
    const bar = el('div', { class: 'sc-tabs', role: 'tablist', 'aria-label': 'Content sections' }, TABS.map(([id, name]) => {
      const waiting = data.approvals.length + data.plans.length + data.sheets.length + data.packsWaiting.length, count = id === 'approvals' && waiting ? ` ${waiting}` : '';
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
    const build = { approvals: approvalsView, publishing: publishingView, pipeline: pipelineView, channels: channelsView, formats: formatsView, characters: charactersView, styles: stylesView, scoreboard: scoreboardView, report: reportView }[shown];
    try {
      const content = await build();
      if (alive() && tab === shown && panel.isConnected) panel.replaceChildren(...content);
    } catch (error) { if (alive() && panel.isConnected) panel.replaceChildren(el('p', { role: 'alert', class: 'sc-error', text: M.loadFailure(error) }), btn('Try again', () => draw())); }
  }

  // The desktop app's fill reports back (electron/studio-prepare.js): refresh the dashboard when a page is filled.
  const stopProgress = window.jarvis?.browse?.onPrepareProgress?.(progress => {
    if (!alive() || !progress || progress.stage === 'filling') return;
    if (progress.stage === 'done') toast('The upload page is filled. Check it and press Post yourself.');
    else if (progress.stage === 'stopped' && progress.missing?.length) toast(`Some fields were not on the page: ${progress.missing.map(k => M.FILL_NAMES[k] || k).join(', ')}. Do those yourself.`);
    reload();
  });
  signal?.addEventListener('abort', () => stopProgress?.(), { once: true });
  await reload();
  return () => { disposed = true; stopProgress?.(); };
}
