import { mobileOn, phone } from './mobileShared.js';
import { watchKeyboard } from './mobileDock.js';

export const composerExpanded = ({ focused, draft, attachments, recording, busy }) => !!(focused || draft || attachments || recording || busy);
// Presentation only. No replacement input, send handler, reference picker or
// voice transport: the controller continues owning all of those.
export function mountMobileComposer({ composer, input, context, attachmentHost, busy = () => false, recording = () => false }) {
  const originalPlaceholder = input.placeholder;
  const originalHeight = input.style.height;
  let attachmentHome = null;
  const contextRow = document.createElement('div'); contextRow.className = 'ms-composer-context';
  const contextLabel = document.createElement('span'); contextRow.append(contextLabel);
  composer.prepend(contextRow);
  let frame;
  const sync = () => {
    contextRow.hidden = !mobileOn();
    if (!mobileOn()) {
      if (composer.classList.contains('ms-composer')) {
        composer.classList.remove('ms-composer', 'ms-composer-expanded'); input.placeholder = originalPlaceholder; input.style.height = originalHeight;
        if (attachmentHome?.isConnected) attachmentHome.after(attachmentHost); attachmentHome?.remove(); attachmentHome = null;
      }
      return;
    }
    if (!composer.classList.contains('ms-composer')) composer.classList.add('ms-composer');
    if (attachmentHost && !attachmentHome) {
      attachmentHome = document.createComment('Attachment strip home'); attachmentHost.before(attachmentHome); contextRow.after(attachmentHost);
    }
    const text = typeof context === 'function' ? context() : context;
    if (contextLabel.textContent !== text) contextLabel.textContent = text || 'Current workspace';
    const expanded = composerExpanded({ focused: composer.contains(document.activeElement), draft: input.value, attachments: attachmentHost?.childElementCount || composer.querySelector('.chat-reference-chip'), recording: recording(), busy: busy() });
    if (composer.classList.contains('ms-composer-expanded') !== expanded) composer.classList.toggle('ms-composer-expanded', expanded);
    const chatPhone = !!composer.closest('.ms-conversation');
    const placeholder = chatPhone ? 'Ask anything…' : 'Plan, ask, build…';
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    input.style.height = 'auto';
    const height = expanded ? `${Math.min(160, Math.max(chatPhone ? 44 : 64, input.scrollHeight))}px` : '44px';
    if (input.style.height !== height) input.style.height = height;
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync); };
  input.addEventListener('input', schedule); composer.addEventListener('focusin', schedule); composer.addEventListener('focusout', schedule);
  const observer = new MutationObserver(schedule); observer.observe(composer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'data-mode', 'placeholder'] });
  if (attachmentHost) observer.observe(attachmentHost, { childList: true, subtree: true });
  phone.addEventListener('change', schedule); document.addEventListener('kairos:appearance', schedule);
  const keyboard = watchKeyboard(composer); sync();
  return () => { cancelAnimationFrame(frame); observer.disconnect(); keyboard(); if (attachmentHome?.isConnected) attachmentHome.after(attachmentHost); attachmentHome?.remove(); contextRow.remove(); composer.classList.remove('ms-composer', 'ms-composer-expanded'); input.placeholder = originalPlaceholder; input.style.height = originalHeight; input.removeEventListener('input', schedule); composer.removeEventListener('focusin', schedule); composer.removeEventListener('focusout', schedule); phone.removeEventListener('change', schedule); document.removeEventListener('kairos:appearance', schedule); };
}
