// Kip in Bots mode (Agents 3.0 Phase 0, unit U2). OMB drives 39 procedural
// mascot states; Kip has the eight of mascot.js plus the `carry` pose. Only the
// state model and the beat idea come over, the art stays Kip's: kipStateFor()
// folds the 39 names into Kip's poses and stateForBot() picks a bot's state from
// what it is doing. Motion lives in css/bots-kip.css.
//
// Lists and the rail keep the static agentAvatar face (the 2026-10-14 lesson in
// agentAvatar.js: a roster of live SVGs made ui-smoke flaky). The live mascot
// built here is for the bot page header and the empty states only.
import { createMascot, stateForStatus } from './mascot.js';
import { loadBotsCss } from './botsUi.js';

// OMB's 39 states in its four groups (OMB report 3.12).
export const OMB_STATES = [
  // lifecycle
  'sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching', 'working',
  // reactions
  'excited', 'surprised', 'suspicious', 'angry', 'drowsy', 'happy', 'curious', 'confused', 'bored',
  'proud', 'shy', 'sad', 'laughing', 'scared', 'playful', 'celebrate',
  // agent morphs
  'orbit', 'radar', 'progress',
  // product
  'spawning', 'humming', 'loading', 'dictating', 'writing', 'sending', 'receiving', 'uploading',
  'notifying', 'alerting', 'dragging', 'bouncing', 'powering-down',
];

const FOLD = {
  sleeping: ['sleeping', 'powering-down'],
  idle: ['waking', 'idle', 'bored', 'shy', 'drowsy', 'bouncing', 'dragging', 'spawning'],
  listening: ['listening', 'dictating'],
  thinking: ['thinking', 'searching', 'working', 'writing', 'loading', 'orbit', 'radar', 'progress'],
  speaking: ['humming'],
  success: ['excited', 'happy', 'proud', 'celebrate', 'laughing', 'playful'],
  needs: ['curious', 'surprised', 'confused', 'notifying', 'alerting'],
  error: ['suspicious', 'angry', 'scared', 'sad'],
  carry: ['sending', 'receiving', 'uploading'],
};
export const KIP_FOLD = Object.freeze(Object.fromEntries(
  Object.entries(FOLD).flatMap(([kip, names]) => names.map(name => [name, kip]))));

// An OMB state name as the Kip state or pose to draw. Unknown names are idle.
export function kipStateFor(ombState) {
  return KIP_FOLD[String(ombState || '').toLowerCase()] || 'idle';
}

// What state a bot's face shows, in OMB's priority (feature F21): a failed tool,
// then a turn running, then waiting on the person, then off, else idle.
// ctx.status is a botStatus.js word (needs_you, working, ...), ctx.live is true
// while a turn streams, ctx.failedTool is true after a tool failed this turn.
// OMB's guess from the bot's name and job is not ported.
export function stateForBot(bot, ctx = {}) {
  const status = ctx.status || '';
  if (ctx.failedTool) return 'error';
  if (status === 'working' || ctx.live) return 'thinking';
  if (status === 'needs_you') return 'needs';
  if (status === 'off' || bot?.enabled === false || bot?.status === 'off') return 'sleeping';
  return 'idle';
}

// The one-shot motion beats (css/bots-kip.css), 1.4 s each.
export const KIP_BEATS = ['arrive', 'switch', 'customize', 'alert', 'thinking', 'working', 'success', 'celebrate', 'failure'];
export const KIP_BEAT_MS = 1400;

const KIP_CSS = '/static/css/bots-kip.css';

// Play a beat on a .bots-kip node; a new beat restarts the animation.
export function playKipBeat(node, beat) {
  if (!node || !KIP_BEATS.includes(beat)) return false;
  clearTimeout(node._beatTimer);
  delete node.dataset.beat;
  void node.offsetWidth;  // restart the animation if the same beat plays twice
  node.dataset.beat = beat;
  node._beatTimer = setTimeout(() => { delete node.dataset.beat; }, KIP_BEAT_MS);
  return true;
}

// A live Kip for a bot: a .bots-kip wrapper around <kairos-mascot>.
// node.setState(state) changes the pose, node.beat(name) plays a beat.
export function botKip(bot, { size = 24, state = 'idle', beat = '' } = {}) {
  loadBotsCss(KIP_CSS);
  const node = document.createElement('span');
  node.className = 'bots-kip';
  node.style.setProperty('--kip-size', `${size}px`);
  const mascot = createMascot({ agent: bot, state, size, decorative: true });
  node.append(mascot);
  node.setState = next => mascot.setAttribute('state', next);
  node.beat = name => playKipBeat(node, name);
  if (beat) node.beat(beat);
  return node;
}

// botStatus.js words as Kip states (mascot.js owns the table).
export { stateForStatus };
