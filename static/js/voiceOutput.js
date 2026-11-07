// static/js/voiceOutput.js — speaking replies aloud (David's ask 2026-09-15).
//
// Uses the browser's own speechSynthesis with OS voices: offline, zero bundle
// cost, and available in the desktop shell and a phone browser alike. Kokoro
// (what The Bridge uses) sounds better, but it is a separate local server with
// its own model, which is exactly the dependency the rest of this feature
// avoided. It could later become an optional download like the whisper models.
//
// Text is spoken sentence by sentence as it streams rather than waiting for
// the whole reply. The chunking rule is carried over from voice-line's
// _SentenceChunker: the first sentence ships alone (at a clause break when it
// is long) for the fastest time-to-first-audio, and every later sentence goes
// the moment it is complete. The old two-sentence breaths held sentence 2 until
// sentence 3 arrived; speech that prefetches no longer needs them.

// Matches a sentence boundary only when the next thing genuinely starts a new
// sentence, so "v1.10.0" and "e.g. this" are not split mid-thought.
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'])/;

// Markdown is written to be read, not heard. Speaking the punctuation makes it nearly unintelligible, so it is
// stripped rather than passed through: code becomes one spoken line, links their text, lists and headings sentences.
// core/voice_style.py `strip_for_speech` is the same clean-up for the server's voices (phone, voice notes); both are
// checked against scripts/fixtures/spoken-style-cases.json, so change them together.
export const CODE_LINE = "I've put the code in the chat.";
const CODE_REPEATS = /(?:\s*I've put the code in the chat\.){2,}/g;
function forSpeech(text) {
  let out = String(text || '')
    .replace(/```[\s\S]*?(?:```|$)/g, '\n' + CODE_LINE + '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/g, 'a link')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/^\s*(?:[-*_=]{3,}|\|?[\s:|-]{3,}\|?)\s*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__|~~|\*|(?<!\w)_|_(?!\w))/g, '')
    .replace(/\|/g, ' ');
  // One line per item: end it like a sentence so the voice pauses instead of running on.
  let lines = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) lines = lines.map(line => /[.!?:;,…]['")\]]*$/.test(line) ? line : line + '.');
  out = lines.join(' ');
  return out.replace(CODE_REPEATS, ' ' + CODE_LINE).replace(/\s+/g, ' ').trim();
}

// Words before a first-sentence clause break (comma, semicolon, dash) may be spoken ahead of the full stop.
const FIRST_CLAUSE_WORDS = 6;
// A full stop after one of these does not end a sentence: titles, initials, "U.S.", "e.g.".
const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Gen|Col|Lt|Sgt|Capt|Rep|Sen|Gov|Hon|Rev|vs|Inc|Ltd|Co|Corp|Fig|approx)|\b(?!I\.)[A-Z]|\b[A-Za-z]\.[A-Za-z]|\be\.g|\bi\.e)\.$/;
const CLAUSE_BREAK = /[,;](?=\s)|\s+-{1,2}\s+|\s*[—–]\s*/g;

// The next real sentence end in `text`, skipping abbreviations. Returns the regex match or null.
function nextSentenceEnd(text) {
  const pattern = new RegExp(SENTENCE_END.source, 'g');
  for (let match; (match = pattern.exec(text));) {
    if (!ABBREVIATION.test(text.slice(0, match.index))) return match;
  }
  return null;
}

// The earliest clause break with enough words before it, for the first sentence only.
function firstClauseEnd(text) {
  const pattern = new RegExp(CLAUSE_BREAK.source, 'g');
  for (let match; (match = pattern.exec(text));) {
    const head = text.slice(0, match.index + (/^[,;]/.test(match[0]) ? 1 : 0)).trim();
    if (head.split(/\s+/).length >= FIRST_CLAUSE_WORDS) return { head, length: match.index + match[0].length };
  }
  return null;
}

// Sentence chunking, shared by the speaker and its tests. Duplicating this for
// testability would let the tested rule and the spoken rule drift apart, which
// defeats the point of testing it.
//
// Every completed sentence is released at once: the old rule held sentence 2 until
// sentence 3 arrived, which put a whole sentence of generation time into the gap.
// The first sentence may also go at a clause break (comma, semicolon, dash) after
// about six words, so the first sound starts sooner.
export function createChunker(onFlush) {
  let buffer = '';
  let flushedFirst = false;
  const emit = (sentence) => { flushedFirst = true; onFlush(sentence); };
  return {
    get started() { return flushedFirst; },
    feed(text) {
      buffer += text;
      for (;;) {
        const match = nextSentenceEnd(buffer);
        const clause = flushedFirst ? null : firstClauseEnd(buffer);
        if (clause && (!match || clause.length <= match.index + 1)) {
          buffer = buffer.slice(clause.length);
          if (clause.head) emit(clause.head);
          continue;
        }
        if (!match) break;
        const sentence = buffer.slice(0, match.index + 1).trim();
        buffer = buffer.slice(match.index + match[0].length);
        if (sentence) emit(sentence);
      }
    },
    finish() {
      const leftover = buffer.trim();
      buffer = '';
      if (leftover) emit(leftover);
    },
    flushSentence() {
      // A trailing "3." may be the start of "3.5", so a digit and full stop wait for the next token.
      if (/[.!?]["')\]]?\s*$/.test(buffer) && !ABBREVIATION.test(buffer.trimEnd()) && !/\d\.\s*$/.test(buffer)) {
        const sentence = buffer.trim(); buffer = ''; if (sentence) emit(sentence);
      }
    },
    reset() { buffer = ''; flushedFirst = false; },
  };
}

export function isSpeechOutputSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

// -- voice selection ---------------------------------------------------------
// Which voice speaks. Persisted per device, like the microphone choice: it
// depends on which voices this machine has installed, so it should not follow
// someone to another one.
//
// David asked for a British voice, closer to the films (2026-09-15). This
// machine has none - only Microsoft David and Zira (en-US), plus Mark exposed
// to Chromium - so the preference below is aspirational until an English (UK)
// voice pack is installed, at which point it is selected automatically with no
// further change here. See the Settings > Speech panel, which says as much
// rather than silently offering a choice that cannot be honoured.
const VOICE_KEY = 'jarvis:speech-voice';

// Names Windows and Chromium use for the UK voices, most Kairos-like first.
// Matched on substring because the exposed name varies by source: SAPI reports
// "Microsoft George Desktop" where OneCore reports "Microsoft George".
const BRITISH_MALE = ['ryan', 'george', 'oliver', 'thomas', 'daniel', 'arthur'];

let preferredVoice = (() => {
  try { return localStorage.getItem(VOICE_KEY) || null; } catch { return null; }
})();

export function listVoices() {
  if (!isSpeechOutputSupported()) return [];
  return window.speechSynthesis.getVoices();
}

export function getPreferredVoice() { return preferredVoice || ''; }

export function setPreferredVoice(name) {
  preferredVoice = name || null;
  try {
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
  } catch { /* storage is optional; the choice just will not persist */ }
}

// Voices load asynchronously in Chromium: getVoices() is commonly empty on the
// first call and only populates on voiceschanged. Anything drawing a list has
// to wait for that or it renders an empty picker on a machine that has voices.
export function whenVoicesReady() {
  return new Promise(resolve => {
    if (!isSpeechOutputSupported()) { resolve([]); return; }
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) { resolve(existing); return; }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    // Some builds never fire the event when there is nothing to load, so this
    // resolves empty rather than leaving the caller waiting forever.
    setTimeout(done, 1500);
  });
}

// Exported for the same reason it is used below: the Settings panel needs to
// show which voice is actually speaking, and recomputing that logic there
// would let the two drift apart.
export function resolveVoice(voices) {
  if (!voices.length) return null;
  if (preferredVoice) {
    const chosen = voices.find(v => v.name === preferredVoice);
    if (chosen) return chosen;
    // A saved voice can vanish with an uninstalled language pack. Fall through
    // to the default rather than going silent.
  }
  // A local voice is preferred over a network one: network voices stall
  // without connectivity and would send text off the machine, which the rest
  // of this feature deliberately avoids.
  const local = voices.filter(v => v.localService);
  const pool = local.length ? local : voices;
  const british = pool.filter(v => /^en[-_]GB/i.test(v.lang));
  return british.find(v => BRITISH_MALE.some(name => v.name.toLowerCase().includes(name)))
    || british[0]
    || pool.find(v => /^en/i.test(v.lang))
    || pool[0];
}

function pickVoice() {
  return resolveVoice(listVoices());
}

// One speaker per conversation. Holds the sentence buffer and the queue so a
// barge-in can silence everything at once.
export function createSpeaker({ onStart, onEnd, onBoundary, onError, getVoice, onSentenceReady, onSentenceStart } = {}) {
  let cancelled = false;
  let speaking = false;
  let queued = 0;
  let generation = 0;
  let sentences = 0;
  let paused = false;
  let heardSentences = [];   // the sentences that actually began to play, raw, in order (what a barge-in leaves in the history)

  // `filler` is an acknowledgement ("Mm, let me think."): it plays like a sentence but is not part of the reply.
  const enqueue = (text, filler = false) => {
    const clean = forSpeech(text);
    if (!clean || cancelled || !isSpeechOutputSupported()) return;
    queued += 1;
    const utterance = new SpeechSynthesisUtterance(clean);
    const mine = generation;
    const index = filler ? -1 : sentences++;
    if (!filler) onSentenceReady?.(index);
    const voice = getVoice ? getVoice() : pickVoice();
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
    utterance.rate = 1.02;
    utterance.addEventListener('start', () => {
      if (cancelled || mine !== generation) return;
      if (!filler) { heardSentences.push(text); onSentenceStart?.(index); }
      if (!speaking) { speaking = true; onStart?.(); }
    });
    utterance.addEventListener('boundary', event => { if (!cancelled && mine === generation) onBoundary?.(event); });
    const settle = () => {
      if (cancelled || mine !== generation) return;
      queued = Math.max(0, queued - 1);
      // Finished means the whole queue drained, not that one utterance ended.
      // Reporting per-utterance would make the Open Mic loop start listening
      // between sentences and hear the assistant's own next sentence.
      if (queued === 0 && !window.speechSynthesis.pending && !window.speechSynthesis.speaking) {
        speaking = false;
        onEnd?.();
      }
    };
    utterance.addEventListener('end', settle);
    utterance.addEventListener('error', event => {
      if (!cancelled && mine === generation) onError?.(event.error || 'Speech playback failed.');
      settle();
    });
    window.speechSynthesis.speak(utterance);
  };

  const chunker = createChunker(enqueue);

  return {
    get speaking() { return speaking; },
    // The sentences that began to play since the last reset(), still readable after cancel().
    heard() { return heardSentences.slice(); },
    // A pause that can be taken back at once (the user may be about to talk): speech holds mid-word and resumes.
    pause() { if (!cancelled && speaking && !paused && isSpeechOutputSupported()) { paused = true; try { window.speechSynthesis.pause(); } catch { paused = false; } } },
    resume() { if (paused) { paused = false; try { window.speechSynthesis.resume(); } catch { /* nothing to resume */ } } },
    get paused() { return paused; },
    filler(clip) { if (!cancelled && clip?.text) enqueue(clip.text, true); },
    feed(deltaText) { if (!cancelled) chunker.feed(deltaText); },
    flushSentence() { if (!cancelled) chunker.flushSentence(); },
    finish() {
      if (cancelled) return;
      chunker.finish();
      // Nothing was ever queued, so no end event is coming to release the
      // caller. Report completion rather than leaving the loop waiting.
      if (queued === 0 && !speaking) onEnd?.();
    },
    // Clears the latch set by cancel(). Without this, cancel() is permanent:
    // `cancelled` was never set back to false, so feed() and enqueue() dropped
    // everything from then on and the session went silent after the first
    // interruption - text kept rendering, nothing was ever spoken again. David
    // hit exactly this. The latch still has to exist, or chunks still in
    // flight from the aborted turn would be spoken over the interruption, so
    // the fix is to clear it deliberately when the next turn begins rather
    // than to drop it.
    reset() {
      generation++;
      cancelled = false;
      paused = false;
      heardSentences = [];
      chunker.reset();
      sentences = 0;
      queued = 0;
      speaking = false;
    },
    cancel() {
      generation++;
      cancelled = true;
      chunker.reset();
      queued = 0;
      if (isSpeechOutputSupported()) {
        try { window.speechSynthesis.cancel(); if (paused) window.speechSynthesis.resume(); } catch { /* nothing to stop */ }
      }
      paused = false;
      if (speaking) { speaking = false; onEnd?.(); }
    },
  };
}

// Exported for tests: chunking and the markdown rules are the parts with real
// behaviour, and driving them through live speech synthesis would be slow and
// machine-dependent.
export const _forSpeech = forSpeech;
export function _chunk(text) {
  const out = [];
  const chunker = createChunker(sentence => out.push(sentence));
  chunker.feed(text);
  chunker.finish();
  return out;
}
