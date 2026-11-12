// "Pair the iPhone app", the last part of Settings > Remote Access (specs/phone-api.md).
//
// A phone is paired once: this page makes a six-digit code, the person types the address and the code into the
// Kairos iPhone app, and the app is then signed in to this account without a password ever being typed on the
// phone. The code works once and lasts ten minutes. Below it, the phones already paired with this account, each
// with Remove (the phone is signed out at once), and where phone notifications are sent.
//
// Built only from the Settings kit, like every Settings page. Returns the sections; each keeps itself current.
import { api, el, toast, confirmDialog } from "./api.js";
import { group, row, field, pill, note, empty } from "./settingsKit.js";

const WATCH_MS = 3000;   // while a code is showing, look for the phone that claimed it

const clock = (date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (date) => date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

function lastUsed(iso) {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 2) return "Last used just now.";
  if (minutes < 60) return `Last used ${minutes} minutes ago.`;
  if (minutes < 60 * 24) return `Last used ${Math.round(minutes / 60)} hours ago.`;
  return `Last used ${day(then)}.`;
}

// `ready`: accounts are on, so pairing can work. `address`: where a phone reaches this Kairos, or null while
// remote access is off (the server sends its own value with each code; this one is for the note before one is made).
export function iphonePairing({ ready, address }) {
  if (!ready) {
    return [group({ title: "Pair the iPhone app" }, [row({
      title: "Set up remote access first",
      description: "The Kairos iPhone app signs in to your Kairos login and reaches this computer through remote access. Finish the steps above, then pair your phone here.",
      control: pill("Not ready", "muted") })])];
  }

  let known = null;      // ids of the phones listed, to notice a new one
  let watch = null;
  let expiry = null;
  const stopWatching = () => { clearInterval(watch); clearTimeout(expiry); watch = expiry = null; };

  // -- the code ---------------------------------------------------------------------------------------------
  const codeRow = el("div");
  const pairSection = group({ title: "Pair the iPhone app",
    description: "Sign the Kairos iPhone app in to your account with a one-time code. Your password is never typed on the phone." }, [codeRow]);

  function showStart(message) {
    stopWatching();
    const make = el("button", { class: "btn primary", text: "Make a code" });
    make.addEventListener("click", async () => {
      make.disabled = true; make.textContent = "Working…";
      try { showCode(await api("/api/phone/pair/start", { method: "POST" })); }
      catch { make.disabled = false; make.textContent = "Make a code"; }
    });
    codeRow.replaceChildren(row({
      title: "Pairing code",
      description: message || (address
        ? "Make a code, then type it into the iPhone app. It works once and lasts 10 minutes."
        : "Make a code, then type it into the iPhone app. It works once and lasts 10 minutes. Remote access is off, so your phone cannot reach this computer yet: turn it on above."),
      control: make }));
  }

  function showCode(pairing) {
    stopWatching();
    const until = new Date(pairing.expires_at);
    const code = el("div", { class: "set-pair-code", "aria-label": `Pairing code ${pairing.code.split("").join(" ")}`,
      text: `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}` });
    const lines = [
      el("div", { class: "set-pair-label", text: "Address" }),
      pairing.address
        ? el("div", { class: "set-mono set-pair-address", text: pairing.address })
        : el("div", { text: "Remote access is off, so there is no address yet. Turn it on above; the code only works once your phone can reach this computer." }),
      el("div", { class: "set-pair-label", text: "Code" }),
      code,
      el("div", { class: "meta", text: `Type both into the iPhone app. The code works once and is good until ${clock(until)}.` }),
    ];
    const controls = [];
    if (pairing.address) controls.push(el("button", { class: "btn", text: "Copy address", onclick: async () => {
      await navigator.clipboard.writeText(pairing.address); toast("Address copied", "success"); } }));
    const again = el("button", { class: "btn", text: "New code" });
    again.addEventListener("click", async () => {
      again.disabled = true;
      try { showCode(await api("/api/phone/pair/start", { method: "POST" })); } catch { again.disabled = false; }
    });
    controls.push(again);
    codeRow.replaceChildren(row({ title: [el("span", { text: "Waiting for your phone" }), pill("10 minutes", "accent")],
      description: lines, control: controls, stack: true }));
    expiry = setTimeout(() => showStart("That code has run out. Make a new one when you are ready."),
      Math.max(0, until.getTime() - Date.now()));
    watch = setInterval(async () => {
      if (!codeRow.isConnected) { stopWatching(); return; }
      const before = known;
      await loadPhones();
      if (before && known && [...known].some((id) => !before.has(id))) {
        toast("iPhone paired", "success");
        showStart("Your phone is paired. Make another code to pair one more.");
      }
    }, WATCH_MS);
  }

  // -- the paired phones ------------------------------------------------------------------------------------
  const phonesSection = group({ title: "Paired phones", description: "Phones signed in to your account. Removing one signs it out at once." });

  async function loadPhones() {
    let devices;
    try {
      devices = (await api("/api/phone/devices")).devices || [];
    } catch (error) {
      if (!known) phonesSection.body.replaceChildren(note(`Could not read your paired phones: ${error.message.replace(/^\d+: /, "")}`, "set-error"));
      return;
    }
    known = new Set(devices.map((device) => device.id));
    if (!devices.length) { phonesSection.body.replaceChildren(empty("No phones are paired with your account.")); return; }
    phonesSection.body.replaceChildren(...devices.map((device) => {
      const remove = el("button", { class: "btn danger", text: "Remove", "aria-label": `Remove ${device.name}` });
      remove.addEventListener("click", async () => {
        const yes = await confirmDialog({ title: "Remove this phone?",
          message: `${device.name} is signed out at once and stops getting notifications. To use it again, pair it again.`,
          confirmLabel: "Remove phone" });
        if (!yes) return;
        remove.disabled = true;
        try {
          await api(`/api/phone/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
          toast("Phone removed", "success");
          await loadPhones();
        } catch { remove.disabled = false; }
      });
      const details = [`Paired ${day(new Date(device.created_at))}.`, lastUsed(device.last_seen_at)].filter(Boolean).join(" ");
      return row({ title: device.model ? `${device.name} (${device.model})` : device.name, description: details, control: remove });
    }));
  }

  // -- where notifications go (this whole Kairos; the page is admins only) ----------------------------------------
  const relayInput = el("input", { type: "url", placeholder: "https://", autocomplete: "off", spellcheck: "false", "aria-label": "Notification relay address" });
  const relayStatus = el("span", { class: "meta" });
  const relaySave = el("button", { class: "btn", text: "Save" });
  let savedRelay = "";
  relaySave.addEventListener("click", async () => {
    relaySave.disabled = true;
    try {
      const saved = await api("/api/phone/push/relay", { method: "PUT", body: JSON.stringify({ url: relayInput.value.trim() }) });
      savedRelay = relayInput.value = saved.url || "";
      relayStatus.textContent = saved.url ? "Saved" : "Saved. Phone notifications are off.";
    } catch { relayStatus.textContent = ""; }
    finally { relaySave.disabled = false; }
  });
  relayInput.addEventListener("input", () => { relayStatus.textContent = relayInput.value.trim() === savedRelay ? "" : "Not saved yet"; });
  relayInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); relaySave.click(); } });
  const relaySection = group({ title: "Phone notifications",
    description: "Notifications reach the iPhone app through the Kairos push relay. It is told only who and what kind, such as \"Kip needs you\". Never a message, and never why a bot is calling." },
    [field("Relay address", [relayStatus, relayInput, relaySave], "Leave it empty and no phone notifications are sent. This applies to everyone on this Kairos.")]);
  api("/api/phone/push/relay").then((relay) => { savedRelay = relayInput.value = relay.url || ""; }).catch(() => {
    relayInput.disabled = relaySave.disabled = true;
    relayStatus.textContent = "Only an admin can change this.";
  });

  showStart();
  loadPhones();
  return [pairSection, phonesSection, relaySection];
}
