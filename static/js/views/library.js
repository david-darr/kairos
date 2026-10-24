import { api, el, toast } from "../api.js";
import { workspaceConfirm as confirmDialog, redesignOn, workspaceEmpty as emptyState } from '../workspaceParts.js';
import { segmented } from '../kairosParts.js';
import { ICONS } from "../icons.js";
import { createVaultExplorer } from "../vaultExplorer.js";
import { createVaultGraph } from "../vaultGraph.js";
import { createVaultStore } from "../vaultStore.js";
import { renderGoogleWorkspace } from "../googleWorkspace.js";
import { registerLeaveGuard } from "../leaveGuard.js";

// Library tab (Phase 7, David's ask 2026-09-01 "let's move on to the next
// stage") — real document storage + bounded keyword search, deliberately
// scoped far lighter than Odysseus's own documents/RAG system (Chroma
// vector DB, embeddings, PDF/Office extraction, versioning). See
// services/documents_service.py's module docstring for the full reasoning.

let activeSection = "documents";
let activeVaultView = null;
let docGuard = null;
const phoneLibrary = () => redesignOn() && window.matchMedia('(max-width: 768px)').matches;

export async function render(container, tabId, options = {}) {
  const unguard = registerLeaveGuard(async () => {
    if (activeVaultView?.canLeave && !await activeVaultView.canLeave()) return false;
    if (docGuard && !await docGuard()) return false;
    // An open design with an unsent message, chips or unsaved token changes (views/design.js).
    if (designModule?.canLeaveDesign && !await designModule.canLeaveDesign()) return false;
    return true;
  });
  if (["all", "vault", "documents", "google", "designs"].includes(options.section)) activeSection = options.section;
  else if (phoneLibrary() && activeSection === 'documents') activeSection = 'all';
  if (activeSection === 'all' && !phoneLibrary()) activeSection = 'documents';
  if (activeSection === "designs" && options.designId) await renderDesign(container, options.designId, options);
  else if (activeSection === "designs") await renderDesigns(container);
  else if (activeSection === "vault") renderVault(container, options.vaultPath || null);
  else if (activeSection === "google") renderGoogle(container);
  else if (activeSection === 'all') await renderAll(container);
  else await renderList(container);
  return () => { unguard(); docGuard = null; disposeVault(); closeDesignPage(); };
}

let designModule = null;
function closeDesignPage() { designModule?.closeDesign(); }

function disposeVault() {
  activeVaultView?.destroy();
  activeVaultView = null;
  closeDesignPage();
}

// One design, full page inside Library (David, 2026-10-22: the Design tab
// merged into Library). Its back button returns to Library > Designs.
async function renderDesign(container, designId, options = {}) {
  disposeVault();
  activeSection = "designs";
  designModule = await import("./design.js");
  await designModule.openDesignPage(container, designId, options);
}

function libraryChrome(container, current) {
  container.dataset.librarySection = current;
  const header = el("div", { class: "view-header" }, [
    el("div", {}, [
      el("h2", { text: "Library" }),
      el("div", { class: "sub", text: current === "vault"
        ? "Browse and read the notes in your connected Vault."
        : current === "google" ? "Your connected Google Drive, Sheets, and Forms."
        : current === "designs" ? "Every design: open one to change it, comment on it, or export it."
        : "A home for your references, drafts, and ideas worth keeping." }),
    ]),
  ]);
  if (redesignOn()) {
    const change = async id => {
      if (id === current) return;
      if (activeVaultView?.canLeave && !await activeVaultView.canLeave()) return;
      if (id === 'all') await renderAll(container);
      else if (id === 'vault') renderVault(container);
      else if (id === 'designs') await renderDesigns(container);
      else if (id === 'google') renderGoogle(container);
      else await renderList(container);
    };
    const sections = [{ value: 'vault', text: 'Vault' }, { value: 'documents', text: 'Files' }, { value: 'designs', text: 'Designs' }];
    const control = segmented({ label: 'Library section',
      value: current === 'google' ? 'documents' : current,
      options: sections, onChange: change });
    [...control.querySelectorAll('button')].forEach((button, index) => { button.dataset.librarySection = sections[index].value; });
    const tabs = el('div', { class: 'library-section-nav' }, [control, el('button', { type: 'button', class: 'btn library-drive-link', text: 'Google Drive',
        'data-library-section': 'google',
        'aria-pressed': String(current === 'google'), onclick: () => change('google') })]);
    const chips = el('nav', { class: 'library-phone-sections workspace-phone-only', 'aria-label': 'Library sections' });
    for (const [id, text] of [['all', 'All'], ['vault', 'Vault'], ['designs', 'Designs'], ['documents', 'Documents'], ['google', 'Drive']]) {
      chips.append(el('button', { type: 'button', class: 'btn', text, 'data-library-section': id, 'aria-pressed': String(current === id), onclick: () => change(id) }));
    }
    tabs.append(chips);
    return [header, tabs];
  }
  const tabs = el("div", { class: "segmented-tabs library-tabs", role: "group", "aria-label": "Library section" });
  for (const [id, label] of [["documents", "Documents & files"], ["vault", "Vault"], ["google", "Google Drive"], ["designs", "Designs"]]) {
    const button = el("button", { type: "button", class: "segmented-tab" + (id === current ? " active" : ""),
      text: label, 'data-library-section': id, "aria-pressed": id === current ? "true" : "false" });
    button.addEventListener("click", async () => {
      if (id === current) return;
      if (activeVaultView?.canLeave && !await activeVaultView.canLeave()) return;
      if (id === "vault") renderVault(container);
      else if (id === "designs") await renderDesigns(container);
      else if (id === "google") renderGoogle(container);
      else await renderList(container);
    });
    tabs.append(button);
  }
  return [header, tabs];
}

// The phone overview joins existing sources; unavailable sources stay absent.
async function renderAll(container) {
  disposeVault(); activeSection = 'all';
  const [header, tabs] = libraryChrome(container, 'all');
  const search = el('input', { 'data-page-search': 'true', type: 'search', class: 'library-overview-search', placeholder: 'Search documents, notes, designs…', 'aria-label': 'Search library' });
  const vault = el('div');
  const recent = el('div', { class: 'library-recent-list rd-stagger' });
  const picker = el('input', { type: 'file', accept: '.md,.txt', hidden: true, 'aria-label': 'Upload a document' });
  picker.addEventListener('change', async () => {
    const file = picker.files[0]; picker.value = '';
    if (!file) return;
    try {
      const doc = await api('/api/documents/import', { method: 'POST', body: JSON.stringify({ filename: file.name, content: await file.text() }) });
      if (wrap.isConnected) await renderEditor(container, doc.id);
      toast(`Imported ${file.name}`, 'success');
    } catch (error) { toast(`Import failed: ${error.message}`, 'error'); }
  });
  const upload = el('button', { type: 'button', class: 'btn workspace-round', 'aria-label': 'Upload a document', onclick: () => picker.click() });
  upload.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>'; header.append(upload);
  const wrap = el('div', { class: 'view-constrained library-overview' }, [header, picker, search, tabs, vault, el('h3', { text: 'Recent' }), recent]);
  container.replaceChildren(wrap);
  const media = window.matchMedia('(max-width: 768px)');
  const restoreDocuments = () => { if (wrap.isConnected && !phoneLibrary()) renderList(container); };
  media.addEventListener('change', restoreDocuments);
  document.addEventListener('kairos:appearance', restoreDocuments);
  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) {
      media.removeEventListener('change', restoreDocuments);
      document.removeEventListener('kairos:appearance', restoreDocuments);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const sources = await Promise.allSettled([api('/api/documents'), api('/api/designs'), api('/api/vault/graph')]);
  if (!wrap.isConnected) return;
  const value = index => sources[index].status === 'fulfilled' ? sources[index].value : null;
  const docs = value(0) || [], designs = value(1) || [], graph = value(2);
  const notes = (graph?.nodes || []).filter(n => n.type !== 'folder');
  if (graph) {
    const map = el('span', { class: 'vault-overview-map', 'aria-hidden': 'true' });
    const links = (graph.edges || []).filter(edge => edge.kind === 'link');
    const ids = [...new Set(links.flatMap(edge => [edge.source, edge.target]))].slice(0, 6);
    const points = new Map(ids.map((id, i) => [id, [28 + (i % 3) * 48, 24 + Math.floor(i / 3) * 48]]));
    // Only draw links returned by the vault; positions are decorative.
    map.innerHTML = `<svg viewBox="0 0 160 100" width="160" height="100">${links.filter(edge => points.has(edge.source) && points.has(edge.target)).map(edge => {
      const [x1, y1] = points.get(edge.source), [x2, y2] = points.get(edge.target);
      return `<path d="M${x1} ${y1}L${x2} ${y2}"/>`;
    }).join('')}${ids.map((id, i) => { const [cx, cy] = points.get(id); return `<circle cx="${cx}" cy="${cy}" r="${i % 2 ? 6 : 9}"/>`; }).join('')}</svg>`;
    vault.append(el('button', { type: 'button', class: 'vault-overview-card', onclick: () => renderVault(container) }, [
      el('span', { class: 'vault-overview-copy' }, [el('small', { text: 'Vault' }), el('strong', { text: `${notes.length} notes` }), el('span', { text: 'Explore your notes' })]), map,
    ]));
  }
  const items = [
    ...docs.map(d => ({ name: d.title, kind: 'MD', meta: 'Document', time: d.updated_at || 0, open: () => renderEditor(container, d.id) })),
    ...designs.map(d => ({ name: d.title, kind: 'DSN', meta: `Design · ${d.boards} boards`, time: d.updated || 0, open: () => renderDesign(container, d.id) })),
    ...notes.map(n => ({ name: n.name || n.id, kind: 'MD', meta: 'Vault', time: n.mtime || 0, open: () => renderVault(container, n.id) })),
  ].sort((a, b) => b.time - a.time);
  const draw = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = items.filter(item => item.name.toLocaleLowerCase().includes(query)).slice(0, query ? 50 : 8);
    recent.replaceChildren(...matches.map(item => el('button', { type: 'button', class: 'library-recent-row', onclick: item.open }, [
      el('span', { class: 'library-file-kind', text: item.kind }), el('span', {}, [el('strong', { text: item.name }), el('small', { text: item.meta })]),
    ])));
    if (!matches.length) recent.append(emptyState({ title: query ? 'No matches' : 'Your library starts here', hint: query ? 'Try another title.' : 'Save your first document.',
      actionLabel: query ? 'Clear search' : 'New document', onAction: () => query ? (search.value = '', draw()) : renderList(container) }));
  };
  search.addEventListener('input', draw); draw();
}

// Library > Designs (the Design canvas): every design, the home for designs.
async function renderDesigns(container) {
  disposeVault();
  activeSection = "designs";
  const [header, tabs] = libraryChrome(container, "designs");
  const host = el("div", { class: "design-home" });
  container.replaceChildren(header, tabs, host);
  designModule = await import("./design.js");
  await designModule.renderDesignList(host);
  if (redesignOn()) {
    const back = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round', text: '‹', 'aria-label': 'Back to Library', onclick: () => renderAll(container) });
    const create = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round', 'aria-label': 'New design', onclick: () => host.querySelector('.design-home-actions > .primary')?.click() });
    create.innerHTML = ICONS.plus;
    header.append(back, create);
    header.classList.add('library-designs-header');
  }
}

function renderGoogle(container) {
  disposeVault();
  activeSection = "google";
  const [header, tabs] = libraryChrome(container, "google");
  renderGoogleWorkspace(container, header, tabs);
}

function renderVault(container, open = null) {
  disposeVault();
  activeSection = "vault";
  container.replaceChildren();
  const [header, tabs] = libraryChrome(container, "vault");
  // Library Vault Polish (2026-10-22): one header. Home and Map are pills in
  // the Vault's own sidebar head, and both modes share one loaded vault.
  const host = el("div", { class: "library-vault-host" });
  container.append(el("div", { class: "library-vault-page" }, [header, tabs, host]));
  const store = createVaultStore();
  const browse = (path = null) => {
    disposeVault();
    host.dataset.mode = "browse";
    activeVaultView = createVaultExplorer(host, { store, open: path, onMap: (focus, depth, select) => map(focus, depth, select) });
  };
  const map = (focus = null, depth = 1, select = null) => {
    disposeVault();
    host.dataset.mode = "map";
    activeVaultView = createVaultGraph(host, { store, focus, depth, select, onBrowse: path => browse(path) });
  };
  browse(open);
}

function section(title, description, icon, body) {
  const glyph = el("span", { class: "library-section-icon", "aria-hidden": "true" });
  glyph.innerHTML = ICONS[icon];
  const count = el("span", { class: "library-count", text: "0" });
  const summary = el("summary", { class: "library-section-summary" }, [
    glyph,
    el("span", { class: "library-section-copy" }, [
      el("strong", { text: title }), el("small", { text: description }),
    ]),
    count,
    el("span", { class: "library-chevron", "aria-hidden": "true", text: "›" }),
  ]);
  return { node: el("details", { class: "library-section", open: true }, [summary, body]), count };
}

function fileSize(size) {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function renderList(container) {
  disposeVault();
  activeSection = "documents";
  container.innerHTML = "";
  const [header, tabs] = libraryChrome(container, "documents");

  const searchInput = el("input", { placeholder: "Search documents and chat files...", style: "flex:1;" });
  searchInput.dataset.pageSearch = 'true'; searchInput.setAttribute('aria-label', 'Search documents and chat files');
  const newBtn = el("button", { class: "btn primary", text: "+ New document" });
  // Plain file input + FileReader (David's ask 2026-09-01) — works
  // identically in the Electron shell and the plain-HTTP web-access path,
  // so import is no longer gated behind window.jarvis (see skillManager.js's
  // matching change and the real "null" bug it fixed there).
  const fileInput = el("input", { type: "file", accept: ".md,.txt", style: "display:none;" });
  const importBtn = el("button", { class: "btn library-import", text: "Import from File...", onclick: () => fileInput.click() });
  const importStatus = el("span", { class: "meta" });

  const toolbar = el("div", { class: "glass card" }, [
    el("div", { class: "card-row", style: "gap:8px;" }, [searchInput, newBtn, importBtn, fileInput]),
    el("div", { style: "margin-top:6px;" }, [importStatus]),
  ]);
  toolbar.classList.add('library-document-toolbar');
  if (redesignOn()) {
    const upload = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round', 'aria-label': 'Upload a document', onclick: () => fileInput.click() });
    upload.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>'; header.append(upload);
  }

  const grid = el("div", { id: "library-grid", class: "document-grid rd-stagger" });
  const chatFiles = el("div", { class: "library-chat-files rd-stagger" });
  const documentsSection = section("Documents", "Notes and drafts saved to your Library", "notes", grid);
  const filesSection = section("Files by chat", "Attachments and files created in conversations", "chats", chatFiles);
  const openChats = new Set();

  const wrap = el("div", { class: "view-constrained library-view" }, [header, tabs, toolbar, documentsSection.node, filesSection.node]);
  container.append(wrap);

  newBtn.addEventListener("click", async () => {
    const doc = await api("/api/documents", { method: "POST", body: JSON.stringify({ title: "Untitled", content: "" }) });
    await renderEditor(container, doc.id);
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    const content = await file.text();
    importStatus.textContent = `Importing ${file.name}…`;
    try {
      const doc = await api("/api/documents/import", { method: "POST", body: JSON.stringify({ filename: file.name, content }) });
      importStatus.textContent = "";
      await renderEditor(container, doc.id);
      toast(`Imported ${file.name}`, "success");
    } catch (e) {
      importStatus.textContent = "";
      toast(`Import failed: ${e.message}`, "error");
    }
  });

  let searchDebounce = null;
  let searchVersion = 0;
  const refresh = async (query) => {
    const version = ++searchVersion;
    const current = () => version === searchVersion && wrap.isConnected;
    await Promise.all([
      refreshGrid(grid, container, query, documentsSection, current),
      refreshChatFileGroups(chatFiles, query, filesSection, openChats, current),
    ]);
  };
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refresh(searchInput.value.trim()), 200);
  });

  await refresh("");
}

async function refreshChatFileGroups(host, query, section, openChats, current) {
  const groups = await api("/api/chat/files/library");
  if (!current()) return;
  host.replaceChildren();
  const wanted = query.toLowerCase();
  let shown = 0;
  for (const group of groups) {
    const files = group.files.filter(file => !wanted
      || group.title.toLowerCase().includes(wanted) || file.name.toLowerCase().includes(wanted));
    if (!files.length) continue;
    shown += files.length;
    const list = el("div", { class: "library-file-list" });
    for (const file of files) {
      const label = file.origin === "attachment" ? "Sent to chat"
        : file.origin === "created" ? "Created by model" : "Generated";
      const kind = file.name.includes(".") ? file.name.split(".").pop().slice(0, 5).toUpperCase() : "FILE";
      const card = el("button", { type: "button", class: "library-file-row document-card", title: file.name,
        disabled: !file.exists,
        onclick: async () => {
          const { switchTab } = await import("../app.js");
          await switchTab("chat", { sessionId: group.session_id });
          const { openArtifact } = await import("../chatContent.js");
          await openArtifact(group.session_id, file.url, file.name, null);
        } }, [
        el("span", { class: "library-file-kind", "aria-hidden": "true", text: kind }),
        el("span", { class: "library-file-copy" }, [
          el("strong", { text: file.name }),
          el("small", { text: file.exists ? [label, fileSize(file.size)].filter(Boolean).join(" · ") : `${label} · No longer available` }),
        ]),
        el("span", { class: "library-row-arrow", "aria-hidden": "true", text: "→" }),
      ]);
      list.append(card);
    }
    const chat = el("details", { class: "library-chat-group", open: !!wanted || openChats.has(group.session_id) }, [
      el("summary", { class: "library-chat-summary", title: group.title }, [
        el("span", { class: "library-chat-title library-chat-heading", text: group.title }),
        el("span", { class: "library-count", text: String(files.length) }),
        el("span", { class: "library-chevron", "aria-hidden": "true", text: "›" }),
      ]),
      list,
    ]);
    chat.addEventListener("toggle", () => {
      if (wanted) return;
      if (chat.open) openChats.add(group.session_id);
      else openChats.delete(group.session_id);
    });
    host.append(chat);
  }
  section.count.textContent = String(shown);
  if (wanted && shown) section.node.open = true;
  if (!shown) host.append(redesignOn() ? emptyState({ title: query ? 'No chat files match' : 'No chat files yet',
    hint: 'Files sent to or created in chats will appear here.', actionLabel: 'Open chats',
    onAction: () => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'chat' } })) })
    : el("div", { class: "library-empty", text: query ? "No chat files match this search." : "Files sent to or created in chats will appear here." }));
}

async function refreshGrid(grid, container, query, section, current) {
  const results = query
    ? await api(`/api/documents/search?q=${encodeURIComponent(query)}`)
    : (await api("/api/documents")).map((d) => ({ ...d, snippet: null }));
  if (!current()) return;
  grid.replaceChildren();
  section.count.textContent = String(results.length);
  if (query && results.length) section.node.open = true;

  if (results.length === 0) {
    // Grid is a CSS grid — span the empty state across all columns so it
    // centers on the page rather than sitting in the first cell.
    const empty = query
      ? emptyState({ icon: ICONS.search, title: "No documents match", hint: `No documents match "${query}". Chat files are listed below.` })
      : emptyState({
          icon: ICONS.library,
          title: "No documents yet",
          hint: "Keep reference material here — notes, specs, drafts. You can pull any document straight into a chat from the composer's + menu.",
          actionLabel: "Create a document",
          onAction: async () => {
            const doc = await api("/api/documents", { method: "POST", body: JSON.stringify({ title: "Untitled", content: "" }) });
            await renderEditor(container, doc.id);
          },
        });
    empty.style.gridColumn = "1 / -1";
    grid.appendChild(empty);
    return;
  }

  for (const item of results) {
    const meta = query
      ? (item.snippet || "Title match")
      : `Updated ${new Date(item.updated_at * 1000).toLocaleDateString()}`;
    const card = el("button", {
      type: "button", class: "library-document-card document-card", title: item.title,
      onclick: () => renderEditor(container, item.id),
    }, [
      el("span", { class: "library-document-icon", "aria-hidden": "true", text: "▤" }),
      el("span", { class: "library-document-copy" }, [
        el("strong", { text: item.title }),
        el("small", { text: meta }),
      ]),
      el("span", { class: "library-row-arrow", "aria-hidden": "true", text: "→" }),
    ]);
    grid.appendChild(card);
  }
}

async function renderEditor(container, docId) {
  const doc = await api(`/api/documents/${docId}`);
  container.innerHTML = "";

  const backBtn = el("button", { class: "btn library-editor-back", text: "← Back to Library" });
  const titleInput = el("input", { style: "flex:1;font-size:15px;", value: doc.title });
  const saveStatus = el("span", { class: "meta" });
  const saveBtn = el("button", { class: "btn", text: "Save" });
  const delBtn = el("button", { class: "btn danger", text: "Delete" });

  const header = el("div", { class: "view-header library-editor-toolbar" }, [
    el("div", { class: "card-row", style: "flex:1;gap:10px;" }, [backBtn, titleInput]),
    el("div", { class: "card-row", style: "gap:8px;" }, [saveStatus, saveBtn, delBtn]),
  ]);

  const contentArea = el("textarea", {
    style: "flex:1;width:100%;min-height:340px;resize:none;font-family:inherit;font-size:13.5px;line-height:1.6;margin-top:14px;",
    text: doc.content,
  });
  contentArea.value = doc.content; // el() sets textContent via "text", but a <textarea>'s live value needs .value too

  const phoneHeader = el('div', { class: 'view-header workspace-phone-only' }, [
    el('div', {}, [el('h2', { text: 'Library' })]),
    el('button', { type: 'button', class: 'btn workspace-round', text: '‹', 'aria-label': 'Back to Library', onclick: () => backBtn.click() }),
  ]);
  container.append(el("div", { class: "view-constrained library-editor rd-push-in" }, [phoneHeader, header, contentArea]));

  // Unsaved-changes guard (audit 2026-09-03) — leaving the editor used to
  // silently discard everything typed since the last save.
  const isDirty = () => titleInput.value !== doc.title || contentArea.value !== doc.content;
  const markSaved = () => { doc.title = titleInput.value; doc.content = contentArea.value; };
  const confirmLeave = async () => !isDirty() || await confirmDialog({
    title: "Discard unsaved changes?",
    message: `"${titleInput.value.trim() || "Untitled"}" has changes you haven't saved yet.`,
    confirmLabel: "Discard changes",
  });
  docGuard = () => (contentArea.isConnected ? confirmLeave() : true);

  backBtn.addEventListener("click", async () => {
    if (!await confirmLeave()) return;
    renderList(container);
  });

  const save = async () => {
    saveBtn.disabled = true;
    saveStatus.textContent = "Saving…";
    try {
      await api(`/api/documents/${docId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: titleInput.value.trim() || "Untitled", content: contentArea.value }),
      });
      markSaved();
      // Was a permanent "Saved." string that never cleared — now a toast
      // plus a status line that fades on the next edit.
      saveStatus.textContent = "All changes saved";
      toast("Document saved", "success");
    } finally {
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener("click", save);

  // Ctrl+S / Cmd+S saves, matching every real editor.
  contentArea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  });
  const clearStatus = () => { if (saveStatus.textContent) saveStatus.textContent = ""; };
  contentArea.addEventListener("input", clearStatus);
  titleInput.addEventListener("input", clearStatus);

  delBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete this document?",
      message: `"${doc.title || "Untitled"}" will be permanently deleted. This can't be undone.`,
      confirmLabel: "Delete document",
    });
    if (!ok) return;
    await api(`/api/documents/${docId}`, { method: "DELETE" });
    await renderList(container);
    toast("Document deleted", "success");
  });
}
