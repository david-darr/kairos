export const MAKE_KINDS = Object.freeze([
  { id: 'all', label: 'All' }, { id: 'design', label: 'Design', starter: 'Make a design for ...' },
  { id: 'slides', label: 'Slides', starter: 'Make slides about ...' },
  { id: 'website', label: 'Web page', starter: 'Make a web page for ...' },
  { id: 'files', label: 'Files', starter: 'Make a file with ...' },
]);
export const makeKind = kind => MAKE_KINDS.some(k => k.id === kind) ? kind : 'all';
export function makeItems(items = [], kind = 'all') {
  kind = makeKind(kind);
  return items.filter(item => kind === 'all' || item.kind === kind).slice().sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
}
export function makeEmpty(kind = 'all') {
  const label = MAKE_KINDS.find(k => k.id === makeKind(kind))?.label.toLowerCase();
  return kind === 'all' ? 'Nothing made yet. Tap + to choose what to make.' : `No ${label} yet. Tap + to make one.`;
}
export function starterSelection(value) {
  const start = value.indexOf('...'); return start < 0 ? [value.length, value.length] : [start, start + 3];
}
export function safeMakeThumb(url) {
  return typeof url === 'string' && /^\/api\/designs\/[a-f0-9]{12}\/boards\/[a-z0-9][a-z0-9-]{0,47}\/thumb$/.test(url) ? url : null;
}
export function makeTarget(item) {
  if (!item?.open?.id) return null;
  if (item.open.tab === 'design' && /^[a-f0-9]{12}$/.test(item.open.id)) return { tab: 'design', designId: item.open.id };
  if (item.open.tab === 'artifact' && item.open.session_id && /^\/generated-(?:files|images)\/[^/\\:?#\s]+$/.test(item.open.id)
      && !/%(?:2f|5c|2e|00)/i.test(item.open.id)) return { tab: 'artifact', sessionId: item.open.session_id, url: item.open.id, title: item.title };
  return null;
}
