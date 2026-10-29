// Connect before reading HTTP state, buffer during hydration, then replay. A
// server reset invalidates the cursor; numeric gaps alone are normal (other owners).
export const ROOM_EVENTS = ['room', 'room.deleted', 'room.message', 'room.chunk', 'room.turn', 'room.queue', 'room.hold', 'room.goal'];
export function createRoomStream({ hydrate, apply, onError = () => {}, sourceFactory = url => new EventSource(url), cursor = 0 }) {
  let source = null, closed = false, loading = null, pending = [], again = false, last = cursor;
  async function refresh() {
    if (closed) return;
    if (loading) { again = true; return loading; }
    loading = (async () => {
      do {
        again = false;
        try { await hydrate(); }
        catch (error) { onError(error); throw error; }
      } while (again && !closed);
      if (!closed) { const frames = pending; pending = []; frames.forEach(apply); }
    })().finally(() => { loading = null; });
    return loading;
  }
  function receive(frame) {
    if (closed) return;
    if (!Number.isSafeInteger(frame.id) || (last !== null && frame.id <= last)) return;
    last = frame.id;
    if (loading) {
      pending.push(frame);
      if (pending.length > 500) { pending = []; again = true; }
    } else apply(frame);
  }
  function hello(data) {
    if (data.reset) { last = data.cursor; pending = []; refresh().catch(() => {}); }
    else if (last === null) last = data.cursor;
  }
  return {
    async start() {
      if (closed || source) return;
      // Start hydration in the same task as subscription, before callbacks can fire.
      const ready = refresh();
      source = sourceFactory(`/api/bot-rooms/events${last === null ? '' : `?last_event_id=${last}`}`);
      source.addEventListener('hello', event => { try { hello(JSON.parse(event.data)); } catch (error) { onError(error); } });
      for (const type of ROOM_EVENTS) source.addEventListener(type, event => {
        try { const data = JSON.parse(event.data); receive({ id: Number(event.lastEventId), type, room_id: data.room_id, data }); }
        catch (error) { onError(error); }
      });
      source.addEventListener('error', () => onError(new Error('Room connection lost. Reconnecting.')));
      return ready;
    },
    receive, hello, refresh, cursor: () => last,
    destroy() { closed = true; source?.close(); source = null; pending = []; },
  };
}
