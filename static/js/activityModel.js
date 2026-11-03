const initial = text => (String(text || "").trim()[0] || "K").toUpperCase();
const clip = (text, max = 90) => { const t = String(text || "").replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
// Targets are Bots destinations (botsNavigation.js); this file stays import-free
// because scripts/test_notch_shell.cjs evaluates it as plain text.
export function collectActivity({ chats, remote, dismissed = new Set(), chatStream = {}, openSession = () => {}, go = () => {}, refresh = () => {}, fileDone = null }) {
  const need = [], work = [];
  // Reports and results can be filed as done, as in the Bots Inbox; questions settle only through their answers.
  const doneFor = ident => fileDone ? () => fileDone(ident) : undefined;
  const names = new Map(remote.agents.map(agent => [agent.id, agent]));
  const agentName = id => names.get(id)?.name || "An agent";
  const agentTint = id => names.get(id)?.color || "";

  for (const [id, chat] of chats) {
    const base = { key: `chat:${id}`, kind: "chat", status: chat.status, sessionId: id,
      stop: chat.status === 'processing' ? () => chatStream.stopTurn(id) : null,
      initial: initial(chat.title), title: chat.title, go: () => openSession(id) };
    if (chat.status !== "processing") {
      const word = chat.status === "done" ? "finished" : chat.status === "stopped" ? "stopped" : "failed";
      need.push({ ...base, detail: `Chat · ${word}`, action: chat.status === "done" ? "Open" : "View",
        done: () => { chats.delete(id); refresh(); } });
    } else if (chat.permission) {
      need.push({ ...base, detail: "Chat · waiting for your approval", action: "Review" });
    } else {
      work.push({ ...base, detail: chat.text ? "Chat · receiving response" : "Chat · waiting for response", action: "Open" });
    }
  }
  for (const item of remote.inbox.items) {
    const name = agentName(item.agent_id), question = item.kind === "question";
    need.push({ key: `inbox:${item.id}`, kind: "agent", agent: names.get(item.agent_id), finished: !question, tint: agentTint(item.agent_id), initial: initial(name),
      title: question ? `${name} asked a question` : `${name} sent a report`, detail: clip(item.title),
      action: question ? "Reply" : "Review", go: () => go({ tab: "botsShell", agentId: item.agent_id, attention: "inbox", sourceId: item.id }),
      done: question ? undefined : doneFor(`item:${item.id}`) });
  }
  for (const card of remote.inbox.reviews) {
    const name = agentName(card.agent_id);
    need.push({ key: `review:${card.id}`, kind: "agent", agent: names.get(card.agent_id), finished: true, tint: agentTint(card.agent_id), initial: initial(name),
      title: `${name} has a result ready`, detail: clip(card.title || card.name || "Waiting for your review"),
      action: "Review", go: () => go({ tab: "botsShell", agentId: card.agent_id, attention: "inbox", sourceId: card.id }),
      done: doneFor(`review:${card.id}`) });
  }
  for (const pending of remote.pending) {
    need.push({ key: `pending:${pending.id}`, kind: "review", initial: initial(pending.trigger_name),
      title: `${pending.trigger_name || "A trigger"} is waiting`, detail: clip(pending.summary || "Waiting for your OK"),
      action: "Review", go: () => go({ tab: "tasks" }) });
  }
  for (const device of remote.devices) {
    if (!(device.last_status >= 400)) continue;
    const key = `device:${device.id}:${device.last_status}`;
    if (dismissed.has(key)) continue;
    need.push({ key, kind: "alert", initial: "!", title: "Notification delivery failed",
      detail: "A device did not receive the last notification", action: "Fix",
      go: () => go({ tab: "settings", section: "notifications" }), done: () => { dismissed.add(key); refresh(); } });
  }
  for (const agent of remote.agents) {
    if (agent.status !== "working") continue;
    work.push({ key: `working:${agent.id}`, kind: "agent", agent, agentId: agent.id, modelEndpointId: agent.endpoint_id,
      model: agent.model_override, needsYou: !!agent.activity?.waiting, tint: agent.color || "", initial: initial(agent.name),
      title: `${agent.name} is working`, detail: clip(agent.status_detail || "Working"), action: "View",
      go: () => go({ tab: "botsShell", agentId: agent.id }) });
  }
  return { need, work };
}
