import { api, el } from './api.js';
import { ICON as MARK } from './brand.js';
import { ICONS } from './icons.js';
import { mobileOn, phone, go, button, edgeBlur, haptic, pageBleed } from './mobileShared.js';
import { mountPager } from './mobilePager.js';
import { mountHistory } from './mobileHistory.js';
import { watchKeyboard } from './mobileDock.js';
import { openTabSheet, initTabSheet } from './mobileTabSheet.js';
import { initActivity, attachActivity, activityMetadata, refreshActivity } from './mobileActivity.js';

let selectedPage = 0, launchDraft = '', selectedModelId = '';
export function clearMobileDraft(text) { if (launchDraft === text) launchDraft = ''; }
export const isPhoneShell = mobileOn;
export function phoneRoute(tab, options) {
  if (mobileOn() && ['forgeShell', 'forgeProjects', 'forgeSessions'].includes(tab) && !options.sessionId && !options.mobileTool) return { tab: 'forgeHome', options: { ...options, mobilePage: 1 } };
  if (!mobileOn() || tab !== 'chat' || options.mobileConversation || options.sessionId || options.projectId) return { tab, options };
  return { tab: 'mobileLaunch', options: { ...options, mobilePage: options.mobilePage ?? 0 } };
}
export function initMobileShell() { initTabSheet(); initActivity(); }

export function mountMobileHome({ container, content, banner, options }) {
  if (!options.mobileLaunchSurface) return { update() {}, dispose() {} };
  const shell = el('section', { class: 'ms-shell', 'aria-label': 'Launch workspace' });
  const avatar = button('', () => openTabSheet(avatar), 'ms-avatar ms-glass'); avatar.setAttribute('aria-label', 'Open workspace tabs');
  const settings = button('', () => go('settings'), 'ms-settings ms-glass'); settings.innerHTML = ICONS.settings; settings.setAttribute('aria-label', 'Settings');
  const switcher = el('div', { class: 'ms-switch ms-glass', role: 'tablist', 'aria-label': 'Workspace pages' });
  const newTab = button('New', () => {}, 'ms-segment'), chatsTab = button('Chats', () => {}, 'ms-segment');
  [newTab, chatsTab].forEach((tab, i) => { tab.setAttribute('role', 'tab'); tab.id = `ms-tab-${i}`; tab.setAttribute('aria-controls', `ms-page-${i}`); });
  switcher.append(el('span', { class: 'ms-switch-thumb', 'aria-hidden': 'true' }), newTab, chatsTab);
  const modelChoice = el('select', { 'aria-label': 'Model for new chat', 'data-mobile-hook': 'model-picker' }, [el('option', { value: '', text: 'Choose a model' })]);
  modelChoice.addEventListener('change', () => { selectedModelId = modelChoice.value; });
  const context = el('div', { class: 'ms-context' }, [modelChoice]);
  const header = el('header', { class: 'ms-header' }, [edgeBlur('top'), el('div', { class: 'ms-header-row' }, [avatar, switcher, settings]), context]);
  const launch = el('section', { class: 'ms-page ms-launch', id: 'ms-page-0', role: 'tabpanel', 'aria-labelledby': newTab.id });
  const history = el('section', { class: 'ms-page ms-history', id: 'ms-page-1', role: 'tabpanel', 'aria-labelledby': chatsTab.id });
  const mark = el('div', { class: 'ms-mark', 'aria-hidden': 'true' }); mark.innerHTML = MARK;
  const intro = el('div', { class: 'ms-intro' }, [mark, el('h1', { text: 'What should we work on?' })]);
  const activitySlot = el('div', { class: 'ms-activity-slot' });
  const input = el('textarea', { rows: '1', placeholder: 'Plan, ask, build...', 'aria-label': 'Message Kairos', value: launchDraft });
  input.value = launchDraft;
  input.addEventListener('input', () => { launchDraft = input.value; input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; });
  const start = send => {
    if (send && !input.value.trim()) { input.focus(); return; }
    launchDraft = input.value;
    go('chat', { mobileConversation: true, mobileDraft: launchDraft, mobileSend: send && !!selectedModelId, mobileModelEndpointId: selectedModelId });
  };
  const more = button('+', () => start(false)); more.setAttribute('aria-label', 'Open full composer with attachments, model and voice');
  const send = button('Send', () => start(true));
  const composer = el('div', { class: 'ms-launch-composer ms-glass', 'data-mobile-hook': 'composer' }, [more, input, send]);
  const bottom = el('div', { class: 'ms-launch-bottom' }, [edgeBlur('bottom'), activitySlot, composer]);
  launch.append(intro, bottom);
  const track = el('div', { class: 'ms-page-track' }, [launch, history]);
  shell.append(header, el('div', { class: 'ms-page-window' }, [track])); content.prepend(shell);
  const historyUI = mountHistory(history);
  const pager = mountPager(shell, [launch, history], [newTab, chatsTab], options.mobilePage ?? selectedPage, value => {
    selectedPage = value; historyUI.closeRows();
    if (value === 1 && shell.contains(document.activeElement) && document.activeElement.matches('textarea')) document.activeElement.blur();
  });
  const bannerAnchor = document.createComment('Home backdrop position'); banner.before(bannerAnchor);
  let detachActivity = null, active = false, disposed = false, composerVersion = 0;
  let disposeLaunch = () => {}, launchHost = null, launchContextObserver = null, launchContextButton = null;
  const mountLaunch = async () => {
    const version = ++composerVersion;
    launchHost = el('div', { class: 'ms-launch-chat', hidden: true }); composer.after(launchHost);
    const host = launchHost;
    try {
      const chat = await import('./views/chat.js');
      if (disposed || version !== composerVersion || !mobileOn()) { host.remove(); return; }
      const result = await chat.render(host, 'chat', {
        mobileLaunch: true,
        registerCleanup(cleanup) {
          if (disposed || version !== composerVersion) { cleanup(); return; }
          disposeLaunch = cleanup;
          const field = host.querySelector('#chat-input');
          if (field) {
            field.value = launchDraft; field.dispatchEvent(new Event('input'));
            field.addEventListener('input', () => { launchDraft = field.value; });
          }
          const wasFocused = composer.contains(document.activeElement);
          composer.hidden = true; modelChoice.hidden = true; host.hidden = false;
          launchContextButton = button('Choose model', () => host.querySelector('#model-picker-btn')?.click(), 'ms-launch-context');
          context.append(launchContextButton);
          const updateContext = () => { launchContextButton.textContent = host.querySelector('#model-picker-label')?.textContent || 'Choose model'; };
          launchContextObserver = new MutationObserver(updateContext);
          const label = host.querySelector('#model-picker-label'); if (label) launchContextObserver.observe(label, { childList: true, characterData: true, subtree: true });
          updateContext();
          if (wasFocused) field?.focus();
        },
        onBeforeSend() { shell.classList.add('ms-live-chat'); host.classList.add('ms-launch-chat-open'); detachActivity?.(); detachActivity = null; },
      });
      if (disposed || version !== composerVersion) { result?.(); host.remove(); return; }
      disposeLaunch = result;
    } catch (error) { if (version === composerVersion) { releaseLaunch(); input.value = launchDraft; } host.remove(); console.error('Launch composer could not load', error); }
  };
  const releaseLaunch = () => {
    ++composerVersion;
    launchContextObserver?.disconnect(); launchContextObserver = null; launchContextButton?.remove(); launchContextButton = null;
    const field = launchHost?.querySelector('#chat-input'); if (field) launchDraft = field.value;
    disposeLaunch?.(); disposeLaunch = () => {}; launchHost?.remove(); launchHost = null;
    composer.hidden = false; modelChoice.hidden = false; shell.classList.remove('ms-live-chat');
  };
  const sync = () => {
    const enabled = mobileOn();
    if (enabled === active) return; active = enabled;
    container.classList.toggle('ms-home', enabled); shell.hidden = !enabled;
    if (enabled) {
      // In an iOS Safari tab the picture runs under Safari's bars from the page-level layer.
      (pageBleed() || shell).prepend(banner); banner.classList.add('ms-background');
      avatar.textContent = document.querySelector('.sidebar-avatar')?.textContent || 'K';
      detachActivity = attachActivity(activitySlot); mountLaunch();
    } else {
      releaseLaunch(); bannerAnchor.after(banner); banner.classList.remove('ms-background'); detachActivity?.(); detachActivity = null;
    }
  };
  shell.hidden = true; sync();
  // The shell fills the page (CSS); the keyboard lift pads its bottom so the composer rides the keyboard.
  const keyboard = watchKeyboard(shell);
  phone.addEventListener('change', sync); document.addEventListener('kairos:appearance', sync);
  return { update(key, value) {
    historyUI.update(key, value);
    if (key === 'endpoints' && Array.isArray(value)) {
      modelChoice.replaceChildren(el('option', { value: '', text: value.length ? 'Choose a model' : 'Set up a model in Settings' }), ...value.map(m => el('option', { value: m.id, text: `${m.name} · ${m.model || 'Provider default'}` })));
      if (!value.some(m => m.id === selectedModelId)) selectedModelId = '';
      modelChoice.value = selectedModelId; activityMetadata(null, value);
    }
    if (key === 'sessions') activityMetadata(value, null);
  }, dispose() {
    disposed = true; if (!launchHost) launchDraft = input.value; releaseLaunch(); detachActivity?.(); pager.dispose(); historyUI.dispose();
    keyboard();
    phone.removeEventListener('change', sync); document.removeEventListener('kairos:appearance', sync);
    if (banner.parentElement === pageBleed()) banner.remove();
    shell.remove(); bannerAnchor.remove();
  } };
}

export function mountMobileChat(container, actions) {
  const header = container.querySelector('.chat-mobile-header');
  const title = container.querySelector('.chat-title');
  const menu = container.querySelector('.chat-phone-tools .overflow-menu');
  if (!header || !menu || !title) return () => {};
  const back = button('‹', () => { launchDraft = container.querySelector('#chat-input')?.value || ''; haptic(); go('chat', { mobilePage: selectedPage }); }, 'ms-chat-back ms-glass'); back.setAttribute('aria-label', 'Back to workspace');
  const heading = el('div', { class: 'ms-chat-heading' }, [el('strong', { text: title.textContent }), el('small', { text: 'All chats' })]);
  const blur = edgeBlur('top'); header.prepend(blur, back, heading); refreshActivity();
  const extras = Object.entries({ 'Your workspace': () => openTabSheet(container.querySelector('.chat-phone-tools > button')), ...actions }).map(([label, action]) => button(label, () => { menu.classList.add('hidden'); action(); }, 'overflow-menu-item ms-chat-action'));
  menu.append(...extras);
  let projects = [];
  const main = container.querySelector('#chat-main');
  const syncTitle = () => {
    heading.firstChild.textContent = title.textContent;
    heading.lastChild.textContent = projects.find(p => p.id === main?.dataset.projectId)?.name || container.querySelector('#project-picker-label')?.textContent || 'All chats';
  };
  const observer = new MutationObserver(syncTitle);
  observer.observe(title, { childList: true, characterData: true, subtree: true });
  const project = container.querySelector('#project-picker-label'); if (project) observer.observe(project, { childList: true, characterData: true, subtree: true });
  if (main) observer.observe(main, { attributes: true, attributeFilter: ['data-project-id'] });
  if (mobileOn()) api('/api/projects').then(value => { if (container.isConnected) { projects = value; syncTitle(); } }).catch(() => {});
  const capsule = el('div', { class: 'ms-chat-capsule ms-glass' }); header.append(capsule);
  const movable = [...header.querySelectorAll(':scope > .chat-files-toggle, :scope > .chat-documents-toggle, :scope > .chat-phone-tools, :scope > .context-pill')];
  const modelPill = container.querySelector('.chat-header-model');
  const anchors = new Map();
  const modelMenu = container.querySelector('#model-picker-menu');
  const placeModelMenu = () => {
    if (!mobileOn() || !modelMenu || modelMenu.closest('.ms-sheet') || modelMenu.classList.contains('hidden')) return;
    const dockTop = container.querySelector('.chat-composer-dock').getBoundingClientRect().top;
    const styles = { position: 'fixed', top: 'auto', bottom: `${Math.max(12, innerHeight - dockTop + 8)}px`, left: '12px', right: '12px', maxWidth: 'calc(100vw - 24px)', maxHeight: `${Math.max(80, dockTop - 24)}px` };
    for (const [key, value] of Object.entries(styles)) if (modelMenu.style[key] !== value) modelMenu.style[key] = value;
  };
  const menuObserver = new MutationObserver(placeModelMenu);
  if (modelMenu) menuObserver.observe(modelMenu, { attributes: true, attributeFilter: ['class', 'style'] });
  let phoneApplied = false;
  const restore = () => {
    for (const [node, anchor] of anchors) {
      // redesignChat's desktop listener runs first and may already own this node.
      if (node !== modelPill || !node.classList.contains('rd-in-composer')) anchor.after(node);
      anchor.remove();
    }
    anchors.clear(); phoneApplied = false;
  };
  const sync = () => {
    const on = mobileOn(); container.classList.toggle('ms-conversation', on);
    for (const node of [blur, back, heading, capsule, ...extras]) node.hidden = !on;
    if (on) {
      if (!phoneApplied) {
        for (const node of [...movable, modelPill].filter(Boolean)) {
          const anchor = document.createComment('Phone header control'); node.before(anchor); anchors.set(node, anchor);
        }
        phoneApplied = true;
      }
      capsule.append(...movable);
      if (modelPill) container.querySelector('.chat-input-right')?.prepend(modelPill);
    } else if (phoneApplied) restore();
  }; sync();
  header.addEventListener('kairos:desktop-chat-layout', restore);
  let syncFrame;
  const scheduleSync = () => { cancelAnimationFrame(syncFrame); syncFrame = requestAnimationFrame(sync); };
  phone.addEventListener('change', scheduleSync); document.addEventListener('kairos:appearance', scheduleSync);
  return () => {
    observer.disconnect(); menuObserver.disconnect();
    restore();
    blur.remove(); back.remove(); heading.remove(); capsule.remove(); extras.forEach(n => n.remove());
    cancelAnimationFrame(syncFrame); header.removeEventListener('kairos:desktop-chat-layout', restore);
    phone.removeEventListener('change', scheduleSync); document.removeEventListener('kairos:appearance', scheduleSync);
  };
}
