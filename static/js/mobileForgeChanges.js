import { el } from './api.js';
import { mobileOn, phone, button } from './mobileShared.js';
import { openMobileSheet } from './mobileSheet.js';
import { watchKeyboard } from './mobileDock.js';

// Controls are supplied by forgeGitPanel. This adapter neither posts Git
// requests nor decides permissions, busy state, or commit semantics.
export function mountMobileForgeChanges(content, { state, message, commit, push, pull, onDiff }) {
  let sheet, dock, commitProxies = [], anchors = [], cleanups = [];
  function openCommit(opener) {
    const body = el('div', { class: 'mf-commit' });
    const nodes = [message, commit];
    const homes = nodes.map(node => { const a = document.createComment('Commit control home'); node.before(a); body.append(node); return a; });
    body.prepend(el('p', { class: 'forge-branch', text: `${state.branch} · ${state.ahead} ahead · ${state.behind} behind` }));
    for (const [label, target] of [[state.upstream ? 'Push' : 'Publish', push], ['Pull', pull]]) {
      const proxy = button(label, () => target.click()); proxy.disabled = target.disabled; commitProxies.push([proxy, target]); body.append(proxy);
    }
    sheet = openMobileSheet({ title: 'Commit', content: body, opener, onClose: () => { nodes.forEach((node, i) => { homes[i].after(node); homes[i].remove(); }); commitProxies = []; sheet = null; } });
    message.focus();
  }
  function enable() {
    content.classList.add('mf-git');
    const sections = [...content.querySelectorAll('.forge-git-files')];
    for (const [i, label] of ['Unstage all', 'Stage all'].entries()) {
      const action = [...content.querySelectorAll('button')].find(node => node.textContent === label);
      if (action && sections[i]) { const a = document.createComment('Stage action home'); action.before(a); anchors.push([action, a]); sections[i].querySelector('strong').after(action); }
    }
    if (sections[1]) sections[1].querySelector('strong').textContent = 'Changes';
    for (const section of sections) {
      for (const row of section.querySelectorAll('.forge-git-file')) {
        const code = row.querySelector('code');
        if (!onDiff) continue;
        const file = button(code.textContent, () => onDiff(code.textContent), 'mf-file-open');
        row.prepend(file); code.hidden = true; cleanups.push(() => { file.remove(); code.hidden = false; });
      }
    }
    const staged = state.files.filter(file => file.staged).length;
    const stage = [...content.querySelectorAll('button')].find(node => node.textContent === 'Stage all');
    dock = el('div', { class: 'ms-git-dock ms-glass mf-git-dock' });
    let primary;
    if (staged) primary = button(`Commit ${staged}`, () => openCommit(primary));
    else if (state.files.length) primary = button('Stage all', () => stage?.click());
    else if (!state.upstream) primary = button('Publish', () => push.click());
    else if (state.ahead || state.behind) primary = button(state.behind ? 'Sync: Pull' : 'Sync: Push', () => (state.behind ? pull : push).click());
    if (primary) { primary.disabled = stage?.disabled || push.disabled; dock.append(primary); }
    const prepare = button('Commit options', () => openCommit(prepare)); prepare.disabled = stage?.disabled || false;
    // The original Commit all changes path stays available for unstaged files.
    if (state.files.length && !staged) dock.append(prepare);
    const extra = el('details', { class: 'mf-git-more' }, [el('summary', { text: 'Branch and sync options' })]);
    for (const node of [...content.children].filter(node => node !== sections[0] && node !== sections[1] && node !== content.firstElementChild)) {
      const a = document.createComment('Git control home'); node.before(a); anchors.push([node, a]); extra.append(node);
    }
    content.append(extra, dock); cleanups.push(watchKeyboard(dock));
    const observer = new MutationObserver(() => { for (const [proxy, target] of commitProxies) if (proxy.disabled !== target.disabled) proxy.disabled = target.disabled; if (primary && primary.disabled !== (stage?.disabled || push.disabled)) primary.disabled = stage?.disabled || push.disabled; if (prepare.disabled !== (stage?.disabled || false)) prepare.disabled = stage?.disabled || false; });
    observer.observe(content, { subtree: true, attributes: true, attributeFilter: ['disabled'] }); cleanups.push(() => observer.disconnect());
    cleanups.push(() => extra.remove());
  }
  function disable() {
    sheet?.close();
    const hadFocus = content.contains(document.activeElement);
    if (hadFocus) queueMicrotask(() => { if (mobileOn() && content.closest('dialog[open]')) content.querySelector('.mf-git-dock button')?.focus(); });
    for (const [node, a] of anchors) { a.after(node); a.remove(); } anchors = [];
    cleanups.forEach(dispose => dispose()); cleanups = []; dock?.remove(); dock = null; content.classList.remove('mf-git');
    const sections = content.querySelectorAll('.forge-git-files'); if (sections[1]) sections[1].querySelector('strong').textContent = 'Unstaged';
  }
  const gate = () => { if (mobileOn() && !dock) enable(); else if (!mobileOn() && dock) disable(); };
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate); gate();
  return () => { disable(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); };
}
