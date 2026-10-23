export function parseChatWindow(search) {
  const params = new URLSearchParams(search);
  const id = params.get('session');
  return params.get('window') === 'chat' && /^[a-f0-9]{12}$/.test(id || '') ? { sessionId: id } : null;
}
