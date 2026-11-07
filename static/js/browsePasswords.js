// static/js/browsePasswords.js — the password manager in Browse settings
// (Kairos Browser, David's feedback 2026-11-06: "it needs a proper password
// keeper").
//
// Lists the signed-in account's saved passwords (routes/browse_routes.py
// /api/browse/passwords): site and username only. A password is shown only
// after the person re-enters their Kairos password (or, with accounts off,
// presses Show), for five minutes. Search, add, edit, delete, import from
// another browser's CSV export (through the desktop app, which offers to
// move the file to the Recycle Bin after), and a strong-password generator.
// Every value from a site is set as text, never as HTML.

import { api, el, toast, confirmDialog } from "./api.js";

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };
const when = (s) => (s ? new Date(s * 1000).toLocaleDateString([], { dateStyle: "medium" }) : "Never");

export function mountPasswords(box, { b }) {
  let rows = [], never = [], unlockedUntil = null, needsPassword = true, query = "", max = 5000;
  let editing = null, adding = false, error = "", destroyed = false;
  const shown = new Map(); // login id -> password, while unlocked
  let lockTimer = null;

  const search = el("input", { type: "search", class: "browse-page-search", placeholder: "Search passwords", "aria-label": "Search passwords" });
  let searchTimer = null;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = search.value; load(); }, 200); });

  const unlocked = () => !!unlockedUntil && unlockedUntil * 1000 > Date.now();
  function scheduleLock() {
    clearTimeout(lockTimer);
    if (!unlocked()) return;
    lockTimer = setTimeout(() => { shown.clear(); unlockedUntil = null; draw(); }, unlockedUntil * 1000 - Date.now());
  }

  async function load() {
    try {
      const data = await api(`/api/browse/passwords?q=${encodeURIComponent(query)}`, { toast: false });
      rows = data.logins || []; never = data.never || []; unlockedUntil = data.unlocked_until; needsPassword = !!data.needs_password; max = data.max || max;
      error = "";
    } catch (e) {
      error = String(e.message || "").replace(/^\d+: /, "") || "Saved passwords couldn't be read.";
    }
    if (!unlocked()) shown.clear();
    scheduleLock();
    draw();
  }

  async function unlock(password) {
    try {
      const data = await api("/api/browse/passwords/unlock", { method: "POST", body: JSON.stringify({ password: password || "" }), toast: false });
      unlockedUntil = data.unlocked_until;
      scheduleLock();
      return true;
    } catch (e) {
      toast(String(e.message || "").replace(/^\d+: /, "") || "That didn't work.", "error");
      return false;
    }
  }

  async function reveal(row) {
    if (!unlocked()) { askUnlock(() => reveal(row)); return; }
    try {
      const data = await api(`/api/browse/passwords/${encodeURIComponent(row.id)}/reveal`, { method: "POST", toast: false });
      shown.set(row.id, data.password);
    } catch (e) { toast(String(e.message || "").replace(/^\d+: /, ""), "error"); }
    draw();
  }

  async function copy(row) {
    if (!shown.has(row.id)) { await reveal(row); if (!shown.has(row.id)) return; }
    try { await navigator.clipboard.writeText(shown.get(row.id)); toast("Password copied."); } catch { toast("Couldn't copy.", "error"); }
  }

  // Re-entering the Kairos password: a small form in place, then the action.
  let unlockFor = null;
  function askUnlock(then) {
    if (!needsPassword) { unlock("").then((ok) => { if (ok) then(); else draw(); }); return; }
    unlockFor = then; draw();
  }

  async function remove(row) {
    const ok = await confirmDialog({ title: "Delete saved password", message: `Delete the password for ${row.username || "this sign-in"} on ${hostOf(row.origin)}? This can't be undone.` });
    if (!ok) return;
    await api(`/api/browse/passwords/${encodeURIComponent(row.id)}`, { method: "DELETE" }).catch(() => null);
    shown.delete(row.id);
    load();
  }

  async function generate(target) {
    try {
      const data = await api("/api/browse/passwords/generate", { toast: false });
      target.value = data.password; target.type = "text";
    } catch { toast("Couldn't make a password.", "error"); }
  }

  function editForm(row) {
    const site = el("input", { type: "url", class: "browse-page-search", "aria-label": "Site address", placeholder: "https://example.com", value: row ? row.origin : "" });
    const user = el("input", { type: "text", class: "browse-page-search", "aria-label": "Username", placeholder: "Username or email", value: row ? row.username : "", autocomplete: "off" });
    const pass = el("input", { type: "password", class: "browse-page-search", "aria-label": row ? "New password (leave empty to keep it)" : "Password",
      placeholder: row ? "New password (leave empty to keep it)" : "Password", autocomplete: "new-password" });
    const status = el("span", { class: "browse-list-meta", role: "status" });
    const save = async () => {
      const body = row ? { url: site.value.trim(), username: user.value } : { url: site.value.trim(), username: user.value, password: pass.value };
      if (row && pass.value) body.password = pass.value;
      if (!row && !pass.value) { status.textContent = "Enter a password."; return; }
      try {
        await api(row ? `/api/browse/passwords/${encodeURIComponent(row.id)}` : "/api/browse/passwords", { method: row ? "PATCH" : "POST", body: JSON.stringify(body), toast: false });
        editing = null; adding = false; if (row) shown.delete(row.id);
        load();
      } catch (e) { status.textContent = String(e.message || "").replace(/^\d+: /, "") || "That didn't save."; }
    };
    return el("form", { class: "browse-pw-form", onsubmit: (e) => { e.preventDefault(); save(); } }, [
      site, user,
      el("div", { class: "browse-pw-pass" }, [pass, el("button", { type: "button", class: "btn quiet", text: "Strong password", onclick: () => generate(pass) })]),
      el("div", { class: "browse-site-actions" }, [
        el("button", { type: "submit", class: "btn primary", text: row ? "Save changes" : "Add" }),
        el("button", { type: "button", class: "btn quiet", text: "Cancel", onclick: () => { editing = null; adding = false; draw(); } }),
        status,
      ]),
    ]);
  }

  function unlockForm() {
    const field = el("input", { type: "password", class: "browse-page-search", "aria-label": "Your Kairos password", placeholder: "Your Kairos password", autocomplete: "current-password" });
    const go = async () => { if (await unlock(field.value)) { const then = unlockFor; unlockFor = null; field.value = ""; then && then(); } draw(); };
    setTimeout(() => field.focus(), 0);
    return el("form", { class: "browse-pw-unlock", onsubmit: (e) => { e.preventDefault(); go(); } }, [
      el("span", { text: "Enter your Kairos password to show saved passwords for five minutes." }), field,
      el("button", { type: "submit", class: "btn primary", text: "Show" }),
      el("button", { type: "button", class: "btn quiet", text: "Cancel", onclick: () => { unlockFor = null; draw(); } }),
    ]);
  }

  function rowItem(row) {
    if (editing === row.id) return el("li", { class: "browse-pw-editing" }, [editForm(row)]);
    const secret = shown.has(row.id) ? shown.get(row.id) : null;
    return el("li", {}, [
      el("div", { class: "browse-list-main static" }, [
        el("span", { class: "browse-list-title", text: `${hostOf(row.origin)}${row.username ? "  ·  " + row.username : ""}` }),
        el("span", { class: "browse-list-meta" + (secret ? " browse-pw-secret" : ""), text: secret !== null ? secret : `Last used ${when(row.last_used)}` }),
      ]),
      el("button", { type: "button", class: "btn quiet", text: secret !== null ? "Hide" : "Show", "aria-label": `${secret !== null ? "Hide" : "Show"} the password for ${hostOf(row.origin)}`,
        onclick: () => { if (secret !== null) { shown.delete(row.id); draw(); } else reveal(row); } }),
      el("button", { type: "button", class: "btn quiet", text: "Copy", "aria-label": `Copy the password for ${hostOf(row.origin)}`, onclick: () => copy(row) }),
      el("button", { type: "button", class: "btn quiet", text: "Edit", onclick: () => { editing = row.id; draw(); } }),
      el("button", { type: "button", class: "browse-icon-btn", "aria-label": `Delete the password for ${hostOf(row.origin)}`, text: "×", onclick: () => remove(row) }),
    ]);
  }

  async function importCsv() {
    const result = await b.importPasswords();
    if (!result || result.canceled) return;
    if (!result.ok) { toast(result.message || "Kairos couldn't import that file.", "error"); return; }
    toast(`Imported ${result.added} new and ${result.updated} updated passwords${result.skipped ? `; ${result.skipped} rows skipped` : ""}.${result.trashed ? " The file is in the Recycle Bin." : ""}`);
    load();
  }

  function draw() {
    if (destroyed) return;
    const head = el("div", { class: "browse-internal-head" }, [
      el("h3", { class: "browse-settings-title", text: "Passwords" }), search,
      el("button", { type: "button", class: "btn quiet", text: "Add", onclick: () => { adding = true; editing = null; draw(); } }),
      el("button", { type: "button", class: "btn quiet", text: "Import", title: "Import a CSV exported from Chrome, Edge, Opera, Firefox or a password manager", onclick: importCsv }),
      unlocked() ? el("button", { type: "button", class: "btn quiet", text: "Hide passwords", onclick: async () => { await api("/api/browse/passwords/lock", { method: "POST" }).catch(() => null); shown.clear(); unlockedUntil = null; draw(); } }) : null,
    ]);
    const parts = [head,
      el("p", { class: "browse-list-meta", text: "Saved for your Kairos account only, encrypted with your account's key. Browse offers to save a sign-in and fills it only on the exact site it was saved for." })];
    if (error) parts.push(el("p", { class: "browse-notice error", role: "alert", text: error }));
    if (unlockFor) parts.push(unlockForm());
    if (adding) parts.push(editForm(null));
    parts.push(rows.length ? el("ul", { class: "browse-list", "aria-label": "Saved passwords" }, rows.map(rowItem))
      : el("p", { class: "browse-empty", text: query ? "No saved password matches that." : "No saved passwords yet. Sign in to a site in Browse and choose Save." }));
    if (rows.length >= max) parts.push(el("p", { class: "browse-list-meta", text: `Kairos keeps up to ${max.toLocaleString()} passwords.` }));
    if (never.length) {
      parts.push(el("div", { class: "browse-site-label", text: "Never saved for" }));
      parts.push(el("ul", { class: "browse-list", "aria-label": "Sites never saved for" }, never.map((origin) => el("li", {}, [
        el("span", { class: "browse-list-main static", text: hostOf(origin) }),
        el("button", { type: "button", class: "btn quiet", text: "Remove", onclick: async () => { await api("/api/browse/passwords/never", { method: "POST", body: JSON.stringify({ url: origin, never: false }) }).catch(() => null); load(); } }),
      ]))));
    }
    box.replaceChildren(el("section", { class: "browse-settings-section", "aria-label": "Passwords" }, parts));
  }

  draw();
  load();
  return { destroy() { destroyed = true; clearTimeout(lockTimer); clearTimeout(searchTimer); shown.clear(); }, refresh: load };
}
