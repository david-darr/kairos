// static/js/browseHome.js — Browse's home screen (Speed Dial), shown in any
// tab with no page (David, 2026-11-03: "a proper home browser screen, kind of
// like operagx ... allowing users to customize this screen").
//
// - A search box (Google by default), Speed Dial tiles, a "+" tile and a
//   Suggestions row from history.
// - Tiles are the pinned sites, the same list as the sidebar's grid. Each
//   shows a picture of the site taken locally when it was last visited
//   (electron/browser-tabs.js captureTile); until then, its name on a colour
//   from the name. Right-click a tile to rename it, change its address,
//   refresh its picture or remove it; drag to reorder.
// - Customize: background (the Kairos background, a colour, or a picture of
//   the person's own, kept on this computer), dimming, tile size, and
//   whether the search box and Suggestions show.
// The native page view is hidden while this shows, so ordinary HTML menus
// and panels work here. Titles and addresses are text; pictures are data:
// images the main process produced or the person picked.

import { el } from "./api.js";

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const isPicture = (src) => typeof src === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(src);
// A steady colour per site name, from a small palette of mid tones that keep
// white text readable.
const TILE_COLOURS = ["#9a4b2f", "#2f6e8a", "#5b4a9a", "#2f7a55", "#8a3f6e", "#7a6224", "#3f5a8a", "#8a4a2f"];
function colourFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_COLOURS[h % TILE_COLOURS.length];
}

// A picked background picture, scaled down so the store keeps a sensible
// size: at most 2560 px wide, JPEG.
function shrinkPicture(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2560 / img.naturalWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That picture couldn't be read.")); };
    img.src = url;
  });
}

export function mountHome(host, { b, go }) {
  let state = { settings: null, pinned: [], suggestions: [] };
  let menu = null, editing = null, adding = false, customizing = false, dragId = null, note = "", destroyed = false;

  const backdrop = el("div", { class: "browse-home-backdrop", "aria-hidden": "true" });
  const dim = el("div", { class: "browse-home-dim", "aria-hidden": "true" });
  const search = el("input", { type: "search", class: "browse-home-search-input", "aria-label": "Search Google or type an address",
    placeholder: "Search Google or type an address", autocomplete: "off", spellcheck: "false" });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(search.value); } });
  const body = el("div", { class: "browse-home-body" });
  const panel = el("aside", { class: "browse-home-customize", "aria-label": "Customize home", hidden: true });
  const gear = el("button", { type: "button", class: "browse-home-gear", "aria-label": "Customize home", "aria-expanded": "false", title: "Customize",
    text: "⚙", onclick: () => { customizing = !customizing; draw(); } });
  const root = el("div", { class: "browse-home" }, [backdrop, dim, gear, body, panel]);
  host.append(root);
  const onDocClick = (e) => { if (menu && !e.target.closest(".browse-home-menu")) { menu = null; draw(); } };
  document.addEventListener("click", onDocClick);

  async function load() {
    try { state = await b.home(); } catch { note = "The home screen couldn't load."; }
    if (!destroyed) draw();
  }
  async function save(change) {
    const result = await b.setHome({ ...state.settings, ...change });
    if (result && result.settings) state.settings = result.settings;
    draw();
  }

  function tile(p) {
    const name = p.title || hostOf(p.url);
    const face = isPicture(p.thumb)
      ? el("img", { class: "browse-dial-picture", src: p.thumb, alt: "" })
      : el("span", { class: "browse-dial-letter", style: `background:${colourFor(hostOf(p.url) || name)}`, text: name });
    const node = el("div", { class: "browse-dial" + (dragId === p.id ? " dragging" : ""), draggable: "true", "data-pin": String(p.id) }, [
      el("button", { type: "button", class: "browse-dial-open", title: p.url, "aria-label": `Open ${name}`, onclick: () => go(p.url) }, [face]),
      el("span", { class: "browse-dial-name", text: name }),
    ]);
    node.addEventListener("contextmenu", (e) => { e.preventDefault(); menu = { id: p.id, x: e.clientX, y: e.clientY }; draw(); });
    node.addEventListener("dragstart", (e) => { dragId = p.id; e.dataTransfer.effectAllowed = "move"; });
    node.addEventListener("dragover", (e) => { if (dragId !== null) e.preventDefault(); });
    node.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (dragId === null || dragId === p.id) return;
      const ids = state.pinned.map((x) => x.id).filter((id) => id !== dragId);
      ids.splice(ids.indexOf(p.id), 0, dragId);
      dragId = null;
      await b.orderPinned(ids);
      load();
    });
    node.addEventListener("dragend", () => { dragId = null; });
    return node;
  }

  function tileMenu() {
    const p = state.pinned.find((x) => x.id === menu.id);
    if (!p) return null;
    const rect = root.getBoundingClientRect();
    const item = (label, fn) => el("button", { type: "button", role: "menuitem", text: label, onclick: async () => { menu = null; await fn(); } });
    return el("div", { class: "browse-home-menu", role: "menu", style: `left:${Math.min(menu.x - rect.left, rect.width - 200)}px;top:${Math.min(menu.y - rect.top, rect.height - 180)}px` }, [
      item("Open in a new tab", () => b.open(p.url)),
      item("Rename", () => { editing = { id: p.id, url: p.url, title: p.title || "", field: "title" }; draw(); }),
      item("Change address", () => { editing = { id: p.id, url: p.url, title: p.title || "", field: "url" }; draw(); }),
      item("Refresh picture", async () => { await b.clearPinThumb(p.id); note = "The picture updates the next time you open the site."; load(); }),
      item("Remove", async () => { await b.unpinSite(p.id); load(); }),
    ]);
  }

  function siteForm({ title, url, submitLabel, onSubmit, focus }) {
    const name = el("input", { type: "text", "aria-label": "Name", placeholder: "Name", value: title });
    const address = el("input", { type: "text", "aria-label": "Address", placeholder: "example.com", value: url, spellcheck: "false" });
    const error = el("span", { class: "browse-home-error", role: "status" });
    const form = el("form", { class: "browse-home-form", onsubmit: async (e) => {
      e.preventDefault();
      let target = address.value.trim();
      if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
      const ok = await onSubmit(target, name.value.trim());
      if (!ok) error.textContent = "That address can't be used.";
    } }, [
      el("label", {}, [el("span", { text: "Name" }), name]),
      el("label", {}, [el("span", { text: "Address" }), address]),
      error,
      el("div", { class: "browse-home-form-actions" }, [
        el("button", { type: "button", class: "btn quiet", text: "Cancel", onclick: () => { editing = null; adding = false; draw(); } }),
        el("button", { type: "submit", class: "btn primary", text: submitLabel }),
      ]),
    ]);
    requestAnimationFrame(() => (focus === "title" ? name : address).focus());
    return form;
  }

  function customizePanel() {
    const s = state.settings;
    const radio = (value, label) => el("label", { class: "browse-home-choice" }, [
      el("input", { type: "radio", name: "browse-home-bg", value, checked: s.background === value, onchange: () => save({ background: value }) }),
      el("span", { text: label })]);
    const colour = el("input", { type: "color", "aria-label": "Background colour", value: s.color, onchange: (e) => save({ background: "color", color: e.target.value }) });
    const picture = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", "aria-label": "Choose a background picture", onchange: async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try { save({ background: "image", image: await shrinkPicture(file) }); } catch (err) { note = err.message; draw(); }
    } });
    const sizes = ["small", "medium", "large"].map((size) => el("button", { type: "button", class: "segmented-tab" + (s.tileSize === size ? " active" : ""),
      "aria-pressed": String(s.tileSize === size), text: size[0].toUpperCase() + size.slice(1), onclick: () => save({ tileSize: size }) }));
    const toggle = (key, label) => el("label", { class: "browse-home-choice" }, [
      el("input", { type: "checkbox", checked: s[key], onchange: (e) => save({ [key]: e.target.checked }) }), el("span", { text: label })]);
    return [
      el("div", { class: "browse-home-customize-head" }, [el("strong", { text: "Customize" }),
        el("button", { type: "button", class: "btn quiet", text: "Done", onclick: () => { customizing = false; draw(); } })]),
      el("div", { class: "browse-home-label", text: "Background" }),
      radio("kairos", "Kairos background"),
      el("div", { class: "browse-home-row" }, [radio("color", "Colour"), colour]),
      el("div", { class: "browse-home-row" }, [radio("image", "My picture"), picture]),
      el("label", { class: "browse-home-slider" }, [el("span", { text: "Dim the background" }),
        el("input", { type: "range", min: "0", max: "0.9", step: "0.05", value: String(s.dim), "aria-label": "Dim the background", onchange: (e) => save({ dim: Number(e.target.value) }) })]),
      el("div", { class: "browse-home-label", text: "Tiles" }),
      el("div", { class: "segmented-tabs", role: "group", "aria-label": "Tile size" }, sizes),
      el("div", { class: "browse-home-label", text: "Show" }),
      toggle("search", "Search box"),
      toggle("suggestions", "Suggestions"),
    ];
  }

  function draw() {
    if (destroyed || !state.settings) return;
    const s = state.settings;
    backdrop.style.background = s.background === "color" ? s.color : "";
    backdrop.style.backgroundImage = s.background === "image" && isPicture(s.image) ? `url("${s.image}")` : "";
    dim.style.opacity = s.background === "kairos" ? "0" : String(s.dim);
    root.dataset.tiles = s.tileSize;
    root.dataset.background = s.background;
    gear.setAttribute("aria-expanded", String(customizing));
    panel.hidden = !customizing;
    if (customizing) panel.replaceChildren(...customizePanel());

    const parts = [];
    if (s.search) parts.push(el("div", { class: "browse-home-search" }, [el("span", { class: "browse-home-g", "aria-hidden": "true", text: "G" }), search]));
    if (editing) {
      parts.push(siteForm({ title: editing.title, url: editing.url, submitLabel: "Save", focus: editing.field,
        onSubmit: async (url, title) => { const r = await b.editPin(editing.id, url, title || hostOf(url)); if (!r || !r.ok) return false; editing = null; load(); return true; } }));
    } else if (adding) {
      parts.push(siteForm({ title: "", url: "", submitLabel: "Add", focus: "url",
        onSubmit: async (url, title) => { const r = await b.pinSite(url, title || hostOf(url)); if (!r || !r.ok) return false; adding = false; load(); return true; } }));
    }
    parts.push(el("div", { class: "browse-dials", role: "list", "aria-label": "Speed Dial" }, [
      ...state.pinned.map(tile),
      el("div", { class: "browse-dial" }, [
        el("button", { type: "button", class: "browse-dial-open browse-dial-add", "aria-label": "Add a site", text: "+", onclick: () => { adding = true; editing = null; draw(); } }),
        el("span", { class: "browse-dial-name", text: "" }),
      ]),
    ]));
    if (s.suggestions && state.suggestions.length) {
      parts.push(el("div", { class: "browse-home-label browse-home-suggest-label", text: "Suggestions" }));
      parts.push(el("div", { class: "browse-dials browse-suggestions", role: "list", "aria-label": "Suggestions" }, state.suggestions.slice(0, 6).map((sg) => {
        const name = sg.title || hostOf(sg.url);
        return el("div", { class: "browse-dial" }, [
          el("button", { type: "button", class: "browse-dial-open", title: sg.url, "aria-label": `Open ${name}`, onclick: () => go(sg.url) },
            [el("span", { class: "browse-dial-letter", style: `background:${colourFor(hostOf(sg.url))}`, text: hostOf(sg.url) })]),
          el("span", { class: "browse-dial-name" }, [el("span", { text: name }),
            el("button", { type: "button", class: "browse-dial-pin", "aria-label": `Pin ${name}`, title: "Add to Speed Dial", text: "+",
              onclick: async () => { await b.pinSite(sg.url, name); load(); } })]),
        ]);
      })));
    }
    if (note) parts.push(el("p", { class: "browse-home-note", role: "status", text: note }));
    if (menu) { const m = tileMenu(); if (m) parts.push(m); }
    body.replaceChildren(...parts);
  }

  load();
  return {
    refresh: load,
    focusSearch() { if (state.settings && state.settings.search) search.focus(); },
    destroy() { destroyed = true; document.removeEventListener("click", onDocClick); root.remove(); },
  };
}
