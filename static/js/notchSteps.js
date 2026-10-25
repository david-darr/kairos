// The notch's three-row step list (Kairos Notch build spec, 4a): the last
// finished step, the current step and the next queued item, for one chat or
// one background task. Only what really happened: a chat's own tool steps
// (the live feed's toolSteps), the state of its turn, and the chat's
// background items (bg_tasks). Nothing here guesses at progress, and an empty
// row stays empty. Pure, so scripts/test_notch_panels.cjs runs it in Node.

const VERBS = [
  [/^(read|ls|notebookread)$|read|open|fetch|browse/i, 'Reading'],
  [/grep|glob|search|find|query/i, 'Searching'],
  [/bash|powershell|shell|command|exec|terminal/i, 'Running'],
  [/^edit$|multiedit|patch/i, 'Editing'],
  [/write|save/i, 'Writing'],
];

export function verbFor(name) {
  const text = String(name || '');
  const tool = text.startsWith('mcp__') ? text.split('__').pop() : text;  // a server's tool, by its own name
  for (const [pattern, verb] of VERBS) if (pattern.test(tool)) return verb;
  return tool ? `Using ${tool.replace(/[_-]+/g, ' ')}` : 'Working';
}

export function stepLine(step) {
  const summary = String(step.summary || '').replace(/\s+/g, ' ').trim();
  return summary ? `${verbFor(step.name)} ${summary}` : verbFor(step.name);
}

// Tool steps arrive as a started and a finished event per call id.
export function mergeSteps(steps = []) {
  const byId = new Map();
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') continue;
    const id = step.id || `${step.name}-${index}`;
    const previous = byId.get(id);
    const merged = { ...(previous || {}), ...step, id };
    if (step.phase === 'finished') merged.finishedAt = index;
    byId.delete(id);
    byId.set(id, merged);
  }
  return [...byId.values()];
}

const nextQueued = (items = [], sessionId) =>
  items.find(item => item.status === 'queued' && (!sessionId || item.sessionId === sessionId)) || null;

// A chat turn. `entry` is chatStream's live entry; `items` its bg_tasks.
export function chatRows(entry, items = []) {
  const steps = mergeSteps(entry?.toolSteps);
  const finished = steps.filter(step => step.phase === 'finished').sort((a, b) => a.finishedAt - b.finishedAt);
  const running = steps.filter(step => step.phase !== 'finished');
  const last = finished.at(-1);
  let current;
  if (entry?.permission) current = entry.permission.kind === 'question' ? 'Waiting for your answer' : 'Waiting for your approval';
  else if (running.length) current = stepLine(running.at(-1));
  else current = entry?.text ? 'Writing the reply' : 'Waiting for the model';
  const queued = nextQueued(items);
  return {
    before: last ? (last.ok === false ? `Failed: ${stepLine(last)}` : stepLine(last)) : '',
    current,
    after: queued ? `Next: ${queued.label}` : '',
  };
}

// A background item that is running on its own (no chat turn in flight).
export function taskRows(item, items = []) {
  const done = items.filter(other => other !== item && ['done', 'failed', 'stopped'].includes(other.status))
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0)).at(-1);
  const queued = nextQueued(items.filter(other => other !== item));
  return {
    before: done ? `${done.status === 'done' ? 'Finished' : 'Stopped'}: ${done.label}` : '',
    current: item.activity ? `${item.label} · ${item.activity}` : item.label,
    after: queued ? `Next: ${queued.label}` : '',
  };
}
