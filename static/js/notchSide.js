import { ICONS } from './notchIcons.js';
import { quickActions, upNextTile, nextEvent } from './notchQuiet.js';

// The side-edge notch (Kairos Mobile v2 board NotchSide). It is the same shell as
// the top-centre notch, laid out along the left or right edge: a vertical 44 px
// pill at rest, a 380 px panel flush to the edge when expanded. The rail is the
// shell's own collapsed bar and the panel its own expanded one (styled in
// usage-overlay.css); this module adds what only the side panel has (New chat,
// Up next, the quick-action row) and works out where along the edge it sits.

export const SIDE_EDGES = ['left', 'right'];
export const isSideEdge = edge => SIDE_EDGES.includes(edge);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Where the notch's top lies in a window `room` tall: `offset` 0 is the top of
// the window, 1 the bottom, and the notch (whatever `size` it has now, resting
// or expanded) never leaves the window, and the ends are flush with it.
export function sideTop(offset, room, size) {
  const along = Number.isFinite(offset) ? clamp(offset, 0, 1) : .5;
  return Math.max(0, room - size) * along; // not rounded: the notch's height is fractional, and offset 1 must end flush
}

// The usage card opens on the inner side of the notch, level with the reading
// that was hovered, kept 8 px inside the window.
export function sideCardAt(edge, shell, word, card, viewport) {
  const left = edge === 'left' ? shell.right + 8 : shell.left - 8 - card.width;
  const top = Math.round(word.top + (word.bottom - word.top) / 2 - card.height / 2);
  return { left: Math.round(clamp(left, 8, Math.max(8, viewport.width - card.width - 8))),
    top: clamp(top, 8, Math.max(8, viewport.height - card.height - 8)) };
}

export function createSideNotch({ shell, bridge, onNewChat = () => bridge.openApp?.('chat') }) {
  const make = (tag, className) => { const node = document.createElement(tag); node.className = className; return node; };
  const newChat = make('button', 'n-ic ns-new'); newChat.type = 'button'; newChat.setAttribute('aria-label', 'New chat'); newChat.innerHTML = ICONS.plus;
  newChat.addEventListener('click', e => { e.stopPropagation(); onNewChat(); });
  const next = make('div', 'ns-next');
  const actions = make('div', 'nq-tile ns-actions'); actions.setAttribute('aria-label', 'Quick actions');
  actions.append(...quickActions(bridge, ['Chat', 'Note', 'Talk', 'Drop'], onNewChat));
  let edge = '', offset = .5;
  function place() {
    if (!edge) return;
    const height = shell.getBoundingClientRect().height, top = sideTop(offset, innerHeight, height);
    const host = shell.parentElement || shell; // the page root, so the folded tab (#rest) shares the values
    host.style.setProperty('--ns-top', top + 'px'); host.style.setProperty('--ns-mid', (top + height / 2) + 'px');
  }
  // The notch grows and shrinks (expanding, a new agent chip) and must stay inside the window; this also
  // follows the expand animation frame by frame, so it opens about its own middle.
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(shell);
  return {
    newChat, next, actions, place,
    // Called with each configuration: which edge, and how far along it.
    setEdge(value, along) { edge = isSideEdge(value) ? value : ''; offset = along; place(); },
    update(events, now = Date.now()) {
      const event = events && nextEvent(events, now);
      next.replaceChildren(...(event ? [upNextTile(bridge, event, { prep: false, now })] : []));
      next.hidden = !event;
    },
  };
}
