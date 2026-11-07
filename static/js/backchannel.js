// Backchannels: the small sounds a listener makes while someone else talks ("mm-hm", "yeah", "right").
//
// While Kairos is speaking or still writing its reply, a transcript made only of these is dropped: it does not start
// a reply and it is not a turn. The same rule runs on the server for phone calls (core/voice_backchannel.py); both
// are checked against scripts/fixtures/backchannel-cases.json so they cannot drift.
//
// After Kairos asked a question, "yeah" or "okay" is the answer, not a nod: then only the pure noises count.

const NOISES = new Set(['mm', 'mmm', 'mhm', 'mmhm', 'mm-hm', 'mm-hmm', 'mmhmm', 'hm', 'hmm', 'uh-huh', 'uhhuh', 'uh', 'um', 'ah', 'aha', 'oh', 'ooh', 'huh']);
const ACKS = new Set(['yeah', 'yep', 'yup', 'yes', 'right', 'okay', 'ok', 'sure', 'alright', 'gotcha', 'cool', 'nice', 'interesting', 'wow',
  'exactly', 'true', 'absolutely', 'really', 'indeed', 'totally', 'definitely', 'correct', 'great', 'good', 'fine', 'kay']);
// Said as a unit: "got it" is a nod, "it" on its own is not.
const PHRASES = ['uh huh', 'mm hm', 'mm hmm', 'got it', 'i see', 'go on', 'makes sense', 'fair enough', 'i get it', 'sounds good'];
// Anything here makes it a real interruption or a real answer, whatever else is in it.
const TAKES_THE_FLOOR = new Set(['no', 'nope', 'wait', 'stop', 'hold', 'actually', 'but', 'however', 'sorry', 'pause', 'what', 'why', 'how',
  'when', 'where', 'who', 'can', 'could', 'would', 'please', "don't", 'dont', 'not', 'never']);
const MAX_WORDS = 5;
const hyphenated = phrases => phrases.map(phrase => phrase.replace(/ /g, '-'));
const NOD_UNITS = new Set(hyphenated(PHRASES));
const NOISE_UNITS = new Set(hyphenated(PHRASES.slice(0, 3)));

function words(text) {
  let cleaned = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const phrase of PHRASES) cleaned = cleaned.split(' ' + phrase + ' ').join(' ' + phrase.replace(/ /g, '-') + ' ');
  return cleaned.split(/\s+/).map(word => word.replace(/^[-']+|[-']+$/g, '')).filter(Boolean);
}

// True when `text` is only listener noises. `asked`: Kairos's last spoken sentence was a question.
export function isBackchannel(text, asked = false) {
  const list = words(text);
  if (!list.length || list.length > MAX_WORDS) return false;
  if (list.some(word => TAKES_THE_FLOOR.has(word))) return false;
  const allowed = word => asked ? NOISES.has(word) || NOISE_UNITS.has(word) : NOISES.has(word) || ACKS.has(word) || NOD_UNITS.has(word);
  if (!list.every(allowed)) return false;
  return new Set(list).size <= 3;
}

// Did the last thing Kairos said (the sentences the listener actually heard) end in a question?
export function endsInQuestion(sentences) {
  const last = [].concat(sentences || []).map(item => String(item || '').trim()).filter(Boolean).at(-1) || '';
  return /\?["')\]]*$/.test(last);
}
