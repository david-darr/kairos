import { api, el, toast } from "./api.js";
import { mobileOn, phone } from "./mobileShared.js";
import { openMobileSheet } from "./mobileSheet.js";
import { createVaultStore } from "./vaultStore.js";
import { icon, renderVaultBody, breadcrumb, noteMeta, propertyPills, askKairos } from "./vaultReader.js";
import { mountVaultEditor } from "./vaultEditor.js";

// Library > Vault > Map. First built 2026-09-01 as a port of the original
// Kairos kiosk's force graph (same radial-tree start and light physics,
// restyled onto the app's tokens). Library Vault Polish (2026-10-22) made
// it draw ideas, not folders: link edges are clearly visible with a
// direction tick, folder spokes are faint or hidden, nodes grow with their
// backlinks and take their `project` colour, filters narrow it, focus mode
// shows the notes around one note, and the side panel is the shared reader.

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`);
const RING = 95;
const SETTLE_TICKS = 240;
export const LINK_ALPHA = .45;

function topFolder(node) { return (node.folder || "").split("/")[0] || "Vault root"; }
function hashIndex(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % PALETTE.length;
}

function radialLayout(nodes, edges, rootId) {
  const byId = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  const childrenOf = {};
  edges.forEach((e) => {
    if (e.kind !== "contains" || !byId[e.source] || !byId[e.target]) return;
    (childrenOf[e.source] = childrenOf[e.source] || []).push(e.target);
  });
  const weightCache = {};
  function weight(id) {
    if (weightCache[id] !== undefined) return weightCache[id];
    const kids = childrenOf[id];
    const w = !kids || !kids.length ? 1 : kids.reduce((sum, c) => sum + weight(c), 0);
    weightCache[id] = w;
    return w;
  }
  function place(id, depth, a0, a1) {
    const node = byId[id];
    if (!node) return;
    const angle = (a0 + a1) / 2;
    node.x = Math.cos(angle) * depth * RING;
    node.y = Math.sin(angle) * depth * RING;
    node.vx = 0; node.vy = 0; node.fixed = false;
    const kids = (childrenOf[id] || []).slice().sort((p, q) => {
      const pn = byId[p], qn = byId[q];
      if (pn.type !== qn.type) return pn.type === "folder" ? -1 : 1;
      return pn.name.localeCompare(qn.name);
    });
    let total = 0;
    const weights = kids.map((c) => { const w = weight(c); total += w; return w; });
    let cursor = a0;
    kids.forEach((c, i) => { const slice = (a1 - a0) * (weights[i] / total); place(c, depth + 1, cursor, cursor + slice); cursor += slice; });
  }
  place(rootId, 0, 0, Math.PI * 2);
  return byId;
}

// Focus mode: rings by link distance from the focused note.
function focusLayout(nodes, hops) {
  const rings = new Map();
  for (const n of nodes) { const d = hops.get(n.id) ?? 0; if (!rings.has(d)) rings.set(d, []); rings.get(d).push(n); }
  for (const [d, ring] of rings) ring.forEach((n, i) => {
    const angle = (i / ring.length) * Math.PI * 2 + d * .5;
    n.x = Math.cos(angle) * d * 150; n.y = Math.sin(angle) * d * 150; n.vx = 0; n.vy = 0; n.fixed = false;
  });
  const byId = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  return byId;
}

export function createVaultGraph(container, { store = createVaultStore(), focus = null, depth = 1, select = null, onBrowse } = {}) {
  let sim = null; // { nodes, edges, byId } currently laid out
  let raf = null, disposed = false, settledTicks = 0, autoFit = true, drag = null, pointerDown = null;
  let selectedId = null, hoveredId = null, viewportWidth = 0, viewportHeight = 0, editor = null, peek = null, panelNote = null;
  const transform = { x: 0, y: 0, scale: 1 };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const filters = { orphans: false, hideFolders: false, hideDaily: false, projects: new Set() };
  let focusId = focus, focusDepth = Math.max(1, Math.min(3, depth || 1));
  let colorGroups = new Map();

  const canvas = el("canvas", { id: "vault-graph-canvas", "aria-label": "Vault map. Use search or the note list to open notes." });
  const panelBody = el("div", { class: "vault-panel-body" });
  const closeBtn = el("button", { class: "btn quiet", type: "button", text: "Close" });
  const resizeHandle = el("div", { class: "vault-panel-resize-handle" });
  const panel = el("div", { class: "vault-panel", role: "region", "aria-label": "Note" }, [resizeHandle, el("div", { class: "vault-panel-top" }, [closeBtn]), panelBody]);
  const search = el("input", { class: "vault-search", type: "search", placeholder: "Find a note or folder", "aria-label": "Search vault", autocomplete: "off" });
  search.dataset.pageSearch = "true";
  const searchResults = el("div", { class: "vault-search-results" });
  const counts = el("span", { class: "vault-counts", text: "Loading your map..." });
  const browseBtn = el("button", { class: "vault-mode-pill", type: "button", title: "Back to the note list" }, [icon("home"), el("span", { text: "Browse" })]);
  const fitBtn = el("button", { class: "btn quiet", type: "button", text: "Fit view" });
  const filterRow = el("div", { class: "vault-map-filters", role: "group", "aria-label": "Map filters" });
  const legend = el("div", { class: "vault-map-legend", role: "group", "aria-label": "Colour by project" });
  const focusBar = el("div", { class: "vault-focus-bar", hidden: true });
  const foldersBtn = el("button", { class: "btn quiet", type: "button", text: "All folders", title: "Open the vault's folders in the panel" });
  const toolbar = el("div", { class: "vault-toolbar" }, [browseBtn, search, fitBtn, foldersBtn]);
  const wrap = el("div", { class: "vault-graph-wrap" }, [canvas, toolbar, el("div", { class: "vault-map-controls" }, [focusBar, filterRow, legend]), searchResults, panel,
    el("div", { class: "vault-caption" }, [counts, el("span", { class: "vault-caption-hint", text: "Drag to explore · Scroll to zoom · Select to read" })])]);
  container.replaceChildren(wrap);
  // Read by the renderer checks (scripts/vault-checks.cjs).
  canvas._vaultMap = { visible: () => visibleNodes().map(n => n.id), links: () => drawnLinks, linkAlpha: LINK_ALPHA, focus: () => focusId, depth: () => focusDepth,
    positions: () => (sim?.nodes || []).slice(0, 40).map(n => [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10]), settled: () => settledTicks >= SETTLE_TICKS };
  let drawnLinks = 0;

  // -- toolbar ---------------------------------------------------------------
  browseBtn.addEventListener("click", async () => { if (await canLeave()) onBrowse?.(selectedId && store.note(selectedId) ? selectedId : null); });
  fitBtn.addEventListener("click", () => { autoFit = true; fitToView(); redraw(); });
  foldersBtn.addEventListener("click", () => { if (store.byId.has("")) selectNode(""); });
  search.addEventListener("input", () => {
    searchResults.replaceChildren();
    const query = search.value.trim().toLowerCase();
    if (!query || !store.graph) return;
    const matches = store.graph.nodes.filter((node) => node.id && node.name.toLowerCase().includes(query)).slice(0, 20);
    if (!matches.length) searchResults.append(el("div", { class: "dashboard-empty", text: "No matching notes or folders" }));
    for (const node of matches) searchResults.append(el("button", {
      type: "button", class: "vault-search-result", text: node.name,
      onclick: () => {
        searchResults.replaceChildren();
        const target = sim.byId[node.id];
        if (!target) { setFocus(node.type === "note" ? node.id : null); }
        const shown = sim.byId[node.id];
        if (shown) { autoFit = false; transform.x = -shown.x * transform.scale; transform.y = -shown.y * transform.scale; }
        selectNode(node.id);
      },
    }));
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { search.value = ""; searchResults.replaceChildren(); }
    if (event.key === "Enter") searchResults.querySelector("button")?.click();
  });

  function pill(label, active, onclick, extra = {}) {
    return el("button", { type: "button", class: "vault-map-pill" + (active ? " active" : ""), "aria-pressed": String(!!active), onclick, ...extra }, [label]);
  }
  function drawFilters() {
    filterRow.replaceChildren(
      pill("Orphans", filters.orphans, () => { filters.orphans = !filters.orphans; refilter(); }),
      pill("Hide folders", filters.hideFolders, () => { filters.hideFolders = !filters.hideFolders; refilter(); }),
      pill("Hide daily notes", filters.hideDaily, () => { filters.hideDaily = !filters.hideDaily; refilter(); }),
    );
    legend.replaceChildren(...[...colorGroups].slice(0, 10).map(([name, info]) => {
      const button = pill(name, filters.projects.has(name), () => { filters.projects.has(name) ? filters.projects.delete(name) : filters.projects.add(name); refilter(); },
        { title: info.kind === "project" ? `Project: ${name}` : `Folder: ${name}` });
      button.prepend(el("i", { class: "vault-swatch", style: `background: var(${PALETTE[info.color]})`, "aria-hidden": "true" }));
      return button;
    }));
    focusBar.hidden = !focusId;
    if (focusId) {
      const node = store.note(focusId);
      focusBar.replaceChildren(
        el("span", { class: "vault-focus-label" }, [el("small", { text: "Around" }), el("strong", { text: node?.name || focusId })]),
        el("div", { class: "vault-depth", role: "group", "aria-label": "Link depth" }, [1, 2, 3].map(d => pill(String(d), d === focusDepth, () => { focusDepth = d; relayout(); }, { "aria-label": `Depth ${d}` }))),
        el("button", { type: "button", class: "btn quiet", text: "Whole vault", onclick: () => setFocus(null) }),
      );
    }
  }
  function refilter() { drawFilters(); updateCounts(); redraw(); }

  // -- data ---------------------------------------------------------------------
  const backlinkCount = id => store.backlinks.get(id)?.length || 0;
  function groupFor(node) {
    if (node.type !== "note") return null;
    const project = node.frontmatter?.project;
    return typeof project === "string" && project ? project : topFolder(node);
  }
  function buildColorGroups() {
    const counts = new Map();
    for (const node of store.notes) { const g = groupFor(node); counts.set(g, (counts.get(g) || 0) + 1); }
    colorGroups = new Map([...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => [name, {
      count: n, color: hashIndex(name), kind: store.notes.some(x => x.frontmatter?.project === name) ? "project" : "folder" }]));
  }
  function nodeRadius(node) {
    if (node.type === "folder") return node.id === "" ? 9 : 5.5;
    return Math.min(16, 3.5 + 2.2 * Math.sqrt(backlinkCount(node.id)));
  }
  function nodeColor(node) {
    if (node.type === "folder") return token("--text-faint");
    return token(PALETTE[colorGroups.get(groupFor(node))?.color ?? hashIndex(groupFor(node))]);
  }
  function isVisible(node) {
    if (node.type === "folder") return !filters.hideFolders && !focusId && !filters.orphans && !filters.projects.size;
    if (filters.hideDaily && node.daily) return false;
    if (filters.projects.size && !filters.projects.has(groupFor(node))) return false;
    if (filters.orphans && (backlinkCount(node.id) || store.outlinks.get(node.id)?.length)) return false;
    return true;
  }
  const visibleNodes = () => sim ? sim.nodes.filter(isVisible) : [];

  function relayout() {
    if (!store.graph) return;
    const graph = store.graph;
    if (focusId && store.note(focusId)) {
      const hops = store.neighbourhood(focusId, focusDepth);
      const nodes = graph.nodes.filter(n => hops.has(n.id)).map(n => ({ ...n }));
      const keep = new Set(nodes.map(n => n.id));
      const edges = graph.edges.filter(e => e.kind === "link" && keep.has(e.source) && keep.has(e.target));
      sim = { nodes, edges, byId: focusLayout(nodes, hops) };
    } else {
      focusId = null;
      const nodes = graph.nodes.map(n => ({ ...n }));
      sim = { nodes, edges: graph.edges, byId: radialLayout(nodes, graph.edges, "") };
    }
    settledTicks = 0; autoFit = true;
    if (reducedMotion.matches) { while (settledTicks < SETTLE_TICKS) { tick(); settledTicks++; } }
    drawFilters(); updateCounts(); fitToView(); redraw();
  }

  // On a phone the peek sheet that asked for this closes; the note is just highlighted.
  function setFocus(id) { focusId = id; relayout(); if (id && !mobileOn()) selectNode(id); else if (id) { selectedId = id; redraw(); } }

  function updateCounts() {
    const shown = visibleNodes().filter(n => n.type === "note");
    const ids = new Set(shown.map(n => n.id));
    const links = sim.edges.filter(e => e.kind === "link" && ids.has(e.source) && ids.has(e.target)).length;
    counts.textContent = `${shown.length} notes · ${links} connections` + (focusId ? ` · depth ${focusDepth}` : "");
  }

  // -- physics ---------------------------------------------------------------------
  function fitToView() {
    const nodes = visibleNodes();
    if (!nodes.length || !viewportWidth || !viewportHeight) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    // The open reader panel covers the right of the canvas; fit to what is left.
    const covered = panel.classList.contains("open") && !mobileOn() ? Math.min(panel.offsetWidth + 24, viewportWidth * .6) : 0;
    const scale = Math.min((viewportWidth - covered) / (w + 160), viewportHeight / (h + 220));
    transform.scale = Math.min(1.4, Math.max(0.2, scale));
    transform.x = -((minX + maxX) / 2) * transform.scale - covered / 2;
    transform.y = -((minY + maxY) / 2) * transform.scale;
  }

  function tick() {
    const nodes = sim.nodes, byId = sim.byId;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const distSq = Math.max(dx * dx + dy * dy, 25);
        const dist = Math.sqrt(distSq);
        const force = 700 / distSq;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        if (!a.fixed) { a.vx += fx; a.vy += fy; }
        if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
      }
    }
    for (const e of sim.edges) {
      const a = byId[e.source], b = byId[e.target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const target = e.kind === "contains" ? RING : focusId ? 140 : 170;
      const k = e.kind === "contains" ? 0.03 : focusId ? 0.02 : 0.004;
      const force = (dist - target) * k;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }
    // A light pull to the centre keeps unlinked notes in focus mode on screen.
    const gravity = focusId ? 0.004 : 0;
    for (const n of nodes) {
      if (n.fixed) continue;
      n.vx = (n.vx - n.x * gravity) * 0.8; n.vy = (n.vy - n.y * gravity) * 0.8;
      n.x += n.vx; n.y += n.vy;
    }
  }

  // -- drawing ------------------------------------------------------------------------
  function draw() {
    if (!sim || disposed) return;
    const ctx = canvas.getContext("2d");
    const w = viewportWidth, h = viewportHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + transform.x, h / 2 + transform.y);
    ctx.scale(transform.scale, transform.scale);
    const visible = new Set(visibleNodes().map(n => n.id));
    const ink = token("--ink-rgb"), accent = token("--accent-rgb");
    drawnLinks = 0;
    // Folder spokes first, faint, so the links read over them.
    for (const e of sim.edges) {
      if (e.kind !== "contains" || !visible.has(e.source) || !visible.has(e.target)) continue;
      const a = sim.byId[e.source], b = sim.byId[e.target];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(${ink}, .07)`; ctx.lineWidth = 0.6 / transform.scale; ctx.stroke();
    }
    for (const e of sim.edges) {
      if (e.kind !== "link" || !visible.has(e.source) || !visible.has(e.target)) continue;
      const a = sim.byId[e.source], b = sim.byId[e.target];
      const connected = selectedId !== null && (e.source === selectedId || e.target === selectedId);
      const color = connected ? `rgba(${accent}, .85)` : `rgba(${ink}, ${LINK_ALPHA})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = color; ctx.lineWidth = (connected ? 1.6 : 1.1) / transform.scale; ctx.stroke();
      // Direction tick: a small arrowhead just short of the target node.
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len > 24) {
        const ux = dx / len, uy = dy / len, r = nodeRadius(b) + 3 / transform.scale;
        const tipX = b.x - ux * r, tipY = b.y - uy * r, size = 5 / transform.scale;
        ctx.beginPath(); ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * size - uy * size * .6, tipY - uy * size + ux * size * .6);
        ctx.lineTo(tipX - ux * size + uy * size * .6, tipY - uy * size - ux * size * .6);
        ctx.closePath(); ctx.fillStyle = color; ctx.fill();
      }
      drawnLinks++;
    }
    for (const n of sim.nodes) {
      if (!visible.has(n.id)) continue;
      const r = nodeRadius(n);
      // Folders are circles, notes triangles (as the kiosk drew them).
      ctx.beginPath();
      if (n.type === "folder") ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      else { const t = r * 1.25; ctx.moveTo(n.x, n.y - t); ctx.lineTo(n.x + t * .866, n.y + t * .5); ctx.lineTo(n.x - t * .866, n.y + t * .5); ctx.closePath(); }
      const dim = selectedId !== null && n.id !== selectedId && n.id !== hoveredId && !(store.outlinks.get(selectedId) || []).includes(n.id) && !(store.backlinks.get(selectedId) || []).includes(n.id);
      ctx.globalAlpha = dim ? .35 : n.type === "folder" ? .5 : .92;
      ctx.fillStyle = nodeColor(n); ctx.fill();
      ctx.globalAlpha = 1;
      if (n.id === selectedId || n.id === hoveredId || n.id === focusId) {
        ctx.lineWidth = 2 / transform.scale; ctx.strokeStyle = token("--text"); ctx.stroke();
      }
      const showLabel = n.id === selectedId || n.id === hoveredId || n.id === focusId
        || (n.type === "folder" ? transform.scale > 0.5 : transform.scale > 1.25 || (backlinkCount(n.id) >= 3 && transform.scale > 0.45) || (focusId && sim.nodes.length < 40));
      if (showLabel) {
        ctx.font = (n.type === "folder" ? 11 : 11) / transform.scale + "px Jost, Segoe UI, sans-serif";
        ctx.fillStyle = token(n.id === selectedId ? "--text" : "--text-dim");
        ctx.fillText(n.name, n.x + r + 3 / transform.scale, n.y + 3 / transform.scale);
      }
    }
    ctx.restore();
  }

  function animate() {
    raf = null;
    if (!sim || disposed || document.hidden) return;
    if (settledTicks < SETTLE_TICKS && !reducedMotion.matches) { tick(); settledTicks++; }
    if (autoFit) fitToView();
    draw();
    if (drag || (settledTicks < SETTLE_TICKS && !reducedMotion.matches)) raf = requestAnimationFrame(animate);
  }
  function redraw() { if (!disposed && sim && raf === null && !document.hidden) raf = requestAnimationFrame(animate); }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    viewportWidth = rect.width; viewportHeight = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    if (autoFit) fitToView();
    redraw();
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - viewportWidth / 2 - transform.x) / transform.scale, y: (clientY - rect.top - viewportHeight / 2 - transform.y) / transform.scale };
  }
  function hitTest(clientX, clientY) {
    const p = screenToWorld(clientX, clientY);
    let best = null, bestDist = Infinity;
    for (const n of visibleNodes()) {
      const r = Math.max(nodeRadius(n) + 4, (mobileOn() ? 20 : 12) / transform.scale);
      const dist = Math.hypot(n.x - p.x, n.y - p.y);
      if (dist <= r && dist < bestDist) { best = n; bestDist = dist; }
    }
    return best;
  }

  // -- the reader panel / phone peek -------------------------------------------------------
  async function selectNode(id) {
    if (!await canLeave()) return;
    editor?.destroy(); editor = null;
    selectedId = id; redraw();
    const node = store.byId.get(id);
    if (!node) return;
    if (mobileOn()) { openPeek(node); return; }
    const wasOpen = panel.classList.contains("open");
    panel.classList.add("open");
    if (!wasOpen && autoFit) { fitToView(); redraw(); }
    if (node.type === "folder") { showFolder(node); return; }
    panelBody.replaceChildren(el("div", { class: "meta", text: "Loading..." }));
    try {
      const note = await api(`/api/vault/note?path=${encodeURIComponent(node.id)}`);
      if (selectedId !== id || disposed) return;
      panelNote = note;
      showPanelNote(node, note);
    } catch {
      if (selectedId === id) panelBody.replaceChildren(el("div", { class: "meta", text: "Couldn't load this note." }));
    }
  }

  function showFolder(node) {
    const kids = store.sortedChildren(node.id);
    const index = store.folderIndex(node.id);
    panelBody.replaceChildren(el("article", { class: "vault-note vault-panel-folder" }, [
      el("header", { class: "library-vault-reader-head" }, [
        breadcrumb({ ...node, folder: node.id.split("/").slice(0, -1).join("/") }, store, { onOpen: selectNode, onFolder: id => selectNode(id) }),
        el("h2", { class: "vault-note-title", text: node.id === "" ? "Vault" : node.name }),
        el("div", { class: "vault-note-meta meta", text: `${store.countNotes(node.id)} notes` }),
      ]),
      el("div", { class: "vault-panel-children" }, kids.length ? kids.map(child => el("button", { type: "button", class: "vault-child-row", onclick: () => selectNode(child.id) }, [
        icon(child.type === "folder" ? "folder" : "note"), el("span", { text: child.name }), child.id === index?.id ? el("span", { class: "vault-row-tag", text: "Index" }) : null,
      ])) : [el("div", { class: "meta", text: "Empty folder." })]),
    ]));
  }

  function showPanelNote(node, note) {
    const actions = el("div", { class: "library-vault-reader-actions" });
    if (note.can_edit) actions.append(el("button", { type: "button", class: "btn", text: "Edit", onclick: () => editInPanel(node, note) }));
    actions.append(
      el("button", { type: "button", class: "btn quiet", text: "Open in Browse", onclick: () => onBrowse?.(node.id) }),
      el("button", { type: "button", class: "btn quiet", text: "Show around", title: "Focus the map on this note", onclick: () => setFocus(node.id) }),
      el("button", { type: "button", class: "btn quiet", text: "Ask Kairos", onclick: () => askKairos(node) }),
    );
    const body = el("div", { class: "vault-note-content library-vault-reading artifact-document vault-note-body" });
    renderVaultBody(body, note.content, { name: node.name, links: note.links, store, onOpen: id => { focusOrSelect(id); } });
    panelBody.replaceChildren(el("article", { class: "vault-note" }, [
      el("header", { class: "library-vault-reader-head" }, [
        breadcrumb(node, store, { onOpen: id => focusOrSelect(id), onFolder: id => selectNode(id) }),
        el("h2", { class: "vault-note-title" }, [el("span", { text: node.name }), el("span", { class: "vault-dirty-dot", "aria-hidden": "true" })]),
        el("div", { class: "vault-note-meta meta", text: noteMeta(node, note) }),
        propertyPills(node, { compact: true }),
        actions,
      ]),
      body,
    ]));
  }

  function focusOrSelect(id) { if (sim.byId[id]) selectNode(id); else setFocus(id); }

  function editInPanel(node, note) {
    const head = panelBody.querySelector(".library-vault-reader-head");
    head.querySelector(".library-vault-reader-actions")?.remove();
    const host = el("div", { class: "vault-editor-host" });
    panelBody.querySelector(".vault-note-body").replaceWith(host);
    editor = mountVaultEditor(host, { store, node, note, split: false,
      onDirty: dirty => panelBody.querySelector(".vault-note-title")?.classList.toggle("dirty", dirty),
      onSaved: saved => { panelNote = { ...note, ...saved }; store.load().catch(() => {}); },
      onCancel: () => { editor?.destroy(); editor = null; const id = selectedId; selectedId = null; selectNode(id); } });
  }

  function openPeek(node) {
    peek?.close();
    if (node.type === "folder") {
      const kids = store.sortedChildren(node.id).slice(0, 30);
      const body = el("div", { class: "vault-peek" }, kids.map(child => el("button", { type: "button", class: "vault-child-row", onclick: () => { peek?.close(); selectNode(child.id); } }, [icon(child.type === "folder" ? "folder" : "note"), el("span", { text: child.name })])));
      peek = openMobileSheet({ title: node.id === "" ? "Vault" : node.name, content: body, onClose: () => { peek = null; } });
      return;
    }
    const body = el("div", { class: "vault-peek" }, [
      el("div", { class: "vault-note-meta meta", text: [node.folder || "Vault root", noteMeta(node, null)].filter(Boolean).join(" · ") }),
      propertyPills(node),
      el("div", { class: "vault-peek-actions" }, [
        el("button", { type: "button", class: "btn primary", text: "Open", onclick: () => { peek?.close(); onBrowse?.(node.id); } }),
        el("button", { type: "button", class: "btn", text: "Show around", onclick: () => { peek?.close(); setFocus(node.id); } }),
      ]),
    ]);
    peek = openMobileSheet({ title: node.name, content: body, onClose: () => { peek = null; } });
  }

  closeBtn.addEventListener("click", async () => {
    if (!await canLeave()) return;
    editor?.destroy(); editor = null;
    panel.classList.remove("open"); selectedId = null; redraw();
  });

  let resizeDrag = null;
  resizeHandle.addEventListener("pointerdown", (e) => { resizeHandle.setPointerCapture(e.pointerId); resizeHandle.classList.add("dragging"); resizeDrag = { startX: e.clientX, startWidth: panel.getBoundingClientRect().width }; });
  resizeHandle.addEventListener("pointermove", (e) => { if (resizeDrag) panel.style.width = (resizeDrag.startWidth + resizeDrag.startX - e.clientX) + "px"; });
  resizeHandle.addEventListener("pointerup", () => { resizeDrag = null; resizeHandle.classList.remove("dragging"); });

  // -- pointer ------------------------------------------------------------------------------
  canvas.addEventListener("pointerdown", (e) => {
    if (!sim) return;
    autoFit = false;
    canvas.setPointerCapture(e.pointerId);
    if (!reducedMotion.matches) settledTicks = Math.min(settledTicks, 180);
    redraw();
    pointerDown = { x: e.clientX, y: e.clientY, moved: false };
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) { hit.fixed = true; drag = { node: hit }; }
    else { drag = { pan: true, startX: e.clientX, startY: e.clientY, startTX: transform.x, startTY: transform.y }; canvas.classList.add("dragging"); }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!sim) return;
    if (!drag) {
      const hit = hitTest(e.clientX, e.clientY);
      if ((hit?.id ?? null) !== hoveredId) { hoveredId = hit?.id ?? null; redraw(); }
      canvas.style.cursor = hit ? "pointer" : "grab";
      return;
    }
    if (pointerDown && (Math.abs(e.clientX - pointerDown.x) > 3 || Math.abs(e.clientY - pointerDown.y) > 3)) pointerDown.moved = true;
    if (drag.node) { const p = screenToWorld(e.clientX, e.clientY); Object.assign(drag.node, { x: p.x, y: p.y, vx: 0, vy: 0 }); if (reducedMotion.matches) draw(); }
    else if (drag.pan) { transform.x = drag.startTX + (e.clientX - drag.startX); transform.y = drag.startTY + (e.clientY - drag.startY); if (reducedMotion.matches) draw(); }
  });
  canvas.addEventListener("pointerup", () => {
    if (drag?.node) drag.node.fixed = false;
    if (pointerDown && !pointerDown.moved) { const hit = hitTest(pointerDown.x, pointerDown.y); if (hit) selectNode(hit.id); }
    drag = null; pointerDown = null; canvas.classList.remove("dragging"); redraw();
  });
  canvas.addEventListener("pointercancel", () => { if (drag?.node) drag.node.fixed = false; drag = null; pointerDown = null; canvas.classList.remove("dragging"); redraw(); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); autoFit = false;
    transform.scale = Math.min(3, Math.max(0.15, transform.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    redraw();
  }, { passive: false });

  const observer = new ResizeObserver(resizeCanvas);
  observer.observe(wrap);
  document.addEventListener("visibilitychange", redraw);
  const motionChange = () => { if (reducedMotion.matches && sim) { while (settledTicks < SETTLE_TICKS) { tick(); settledTicks++; } } redraw(); };
  reducedMotion.addEventListener("change", motionChange);
  const phoneChange = () => { if (!mobileOn()) peek?.close(); else if (panel.classList.contains("open")) { panel.classList.remove("open"); } };
  phone.addEventListener("change", phoneChange);

  async function load() {
    if (!store.graph) await store.load();
    if (disposed) return;
    buildColorGroups();
    resizeCanvas();
    relayout();
    if (focusId && store.note(focusId)) { if (!mobileOn()) selectNode(focusId); else { selectedId = focusId; redraw(); } }
    else if (select && store.note(select) && !mobileOn()) selectNode(select);
  }
  load().catch(() => { if (!disposed) counts.textContent = "Couldn't load the vault. Reopen this view to retry."; });

  async function canLeave() { return editor ? editor.canLeave() : true; }

  return {
    canLeave, store, focus: setFocus,
    destroy() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      editor?.destroy(); peek?.close();
      observer.disconnect();
      document.removeEventListener("visibilitychange", redraw);
      reducedMotion.removeEventListener("change", motionChange);
      phone.removeEventListener("change", phoneChange);
    },
  };
}
