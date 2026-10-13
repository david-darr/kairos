// All chat surfaces use the same Return policy, including embedded chats.
// keyCode 229 covers composition-confirming Enter on browsers that clear
// isComposing before the final keydown (notably Safari).
export const isComposingKey = event => event.isComposing || event.keyCode === 229;

export function shouldSendOnEnter(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented
    && !isComposingKey(event) && !matchMedia('(max-width: 768px)').matches;
}
