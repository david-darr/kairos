import { api, el, toast, confirmDialog } from "./api.js";

// The shared library on this Kairos (Multi-Account phase 6): what accounts here
// have shared with each other. Sharing publishes a snapshot under your name;
// adding makes a private copy in your own account. Routes: routes/library_routes.py.

const KIND_LABELS = { skill: "Skill", automation: "Automation", design: "Look", bot: "Bot", style_pack: "Video style" };
const SHARE_WORDS = { skill: "skill", automation: "automation", design: "look", bot: "bot", style_pack: "video style" };

// A library write that can answer "check this first" (a skill the safety scan wants confirmed), which api()
// would turn into an unreadable error, so it reads the answer itself.
async function libraryWrite(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* No body. */ }
  if (res.ok) return data;
  const detail = data?.detail;
  const error = new Error(typeof detail === "string" ? detail : detail?.message || res.statusText || "That did not work.");
  error.status = res.status;
  error.needsConfirmation = !!(detail && typeof detail === "object" && detail.needs_confirmation);
  error.findings = detail && typeof detail === "object" ? detail.findings : null;
  throw error;
}

export async function shareWithKairos(kind, ref) {
  try {
    const item = await libraryWrite("/api/library/share", { kind, ref });
    toast(item.version > 1 ? `Updated in the shared library (version ${item.version}).` : `Shared with everyone on this Kairos.`, "success");
    document.dispatchEvent(new CustomEvent("kairos:library-changed"));
    return item;
  } catch (error) {
    toast(error.message, "error");
    return null;
  }
}

// The Share button on your own skill, automation, look or bot.
export function libraryShareButton(kind, ref, { text = "Share with this Kairos" } = {}) {
  const button = el("button", { type: "button", class: "btn quiet library-share", text,
    title: `Everyone signed in here can see this ${SHARE_WORDS[kind] || "item"} and add a copy. Nothing private goes with it.`,
    onclick: async () => { button.disabled = true; try { await shareWithKairos(kind, ref); } finally { button.disabled = false; } } });
  return button;
}

async function applyItem(item, verb) {
  const path = `/api/library/${encodeURIComponent(item.id)}/${verb}`;
  try {
    await libraryWrite(path);
  } catch (error) {
    if (!error.needsConfirmation) throw error;
    const findings = (error.findings || []).map((f) => (typeof f === "string" ? f : f.message || f.reason || "")).filter(Boolean).slice(0, 5);
    const ok = await confirmDialog({ title: `${verb === "add" ? "Add" : "Update"} ${item.title} anyway?`,
      message: `The safety scan found something to check.${findings.length ? " " + findings.join(" ") : ""}`,
      confirmLabel: verb === "add" ? "Add anyway" : "Update anyway", danger: false });
    if (!ok) return false;
    await libraryWrite(path, { confirmed: true });
  }
  return true;
}

function libraryCard(item, redraw) {
  const busy = async (button, work) => {
    button.disabled = true;
    try { await work(); } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
  };
  const actions = [];
  if (item.mine) {
    actions.push(el("button", { type: "button", class: "btn quiet", text: "Stop sharing", onclick: (event) => busy(event.currentTarget, async () => {
      if (!await confirmDialog({ title: `Stop sharing ${item.title}?`, message: "People who already added it keep their copy.", confirmLabel: "Stop sharing" })) return;
      await api(`/api/library/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      toast("No longer shared", "success"); redraw();
    }) }));
  } else if (!item.added) {
    actions.push(el("button", { type: "button", class: "btn", text: "Add", onclick: (event) => busy(event.currentTarget, async () => {
      if (!await applyItem(item, "add")) return;
      toast(`Added ${item.title} to your account`, "success");
      document.dispatchEvent(new CustomEvent(item.kind === "bot" ? "jarvis:agents-changed" : "kairos:addons-changed"));
      redraw();
    }) }));
  } else if (item.update_offered) {
    actions.push(el("button", { type: "button", class: "btn", text: "Update", onclick: (event) => busy(event.currentTarget, async () => {
      if (!await applyItem(item, "update")) return;
      toast(`Updated ${item.title}`, "success"); redraw();
    }) }));
  } else {
    actions.push(el("span", { class: "meta", text: "Added" }));
  }
  const by = item.mine ? "Shared by you" : `Shared by ${item.sharer_name}`;
  return el("article", { class: "tool-store-card library-card", "data-library-item": item.id, "data-kind": item.kind }, [
    el("div", { class: "tool-store-card-top" }, [el("span", { class: "tool-store-badge", text: KIND_LABELS[item.kind] || item.kind })]),
    el("h4", { text: item.title }),
    el("p", { text: item.description || "No description." }),
    el("p", { class: "meta library-by", text: `${by} · version ${item.version}${item.update_offered ? " · newer version available" : ""}` }),
    el("div", { class: "tool-store-card-foot" }, actions),
  ]);
}

// Fills `host` with the shared library: everything accounts here shared, with Add, Update and Stop sharing.
export async function renderSharedLibrary(host) {
  const list = el("div", { class: "tool-store-grid" });
  host.replaceChildren(
    el("p", { class: "meta", text: "Skills, automations, looks, video styles and bots people on this Kairos shared. Adding makes your own private copy, so later changes by the sharer never change yours until you update." }),
    list);
  async function draw() {
    let items;
    try { items = (await api("/api/library")).items || []; }
    catch (error) { list.replaceChildren(el("div", { class: "tool-store-notice", text: "The shared library is unavailable right now." })); return; }
    if (!host.isConnected) return;
    if (!items.length) {
      list.replaceChildren(el("div", { class: "tool-store-notice library-empty", text: "Nothing is shared yet. Use Share with this Kairos on a skill, automation, look, video style or bot of yours." }));
      return;
    }
    list.replaceChildren(...items.map((item) => libraryCard(item, draw)));
  }
  const changed = () => { if (host.isConnected) draw(); else document.removeEventListener("kairos:library-changed", changed); };
  document.addEventListener("kairos:library-changed", changed);
  await draw();
}
