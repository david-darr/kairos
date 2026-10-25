import { api, el, toast, iconButton } from "../api.js";
import { workspaceConfirm as confirmDialog, workspaceEmpty as emptyState, workspaceStats } from '../workspaceParts.js';
import { ICONS } from "../icons.js";
import { phoneDetails } from '../phoneRowDetails.js';

export async function render(container) {
  container.innerHTML = "";

  const wrap = el("div", { class: "view-constrained" });

  const header = el("div", { class: "view-header" }, [
    el("div", {}, [
      el("h2", { text: "Notes" }),
      el("div", { class: "sub", text: "Capture a thought. Remember the important things." }),
    ]),
  ]);

  const textInput = el("input", { placeholder: "e.g. Finish the CS 571 lab writeup", 'aria-label': 'New note' });
  const dueInput = el("input", { type: "datetime-local" });
  const addBtn = el("button", { class: "btn primary", text: "Add note" });

  const form = el("div", { class: "glass card" }, [
    el("div", { class: "form-grid" }, [
      el("div", { class: "field field-grow" }, [el("label", { text: "Note" }), textInput]),
      el("div", { class: "field" }, [el("label", { text: "Due (optional)" }), dueInput]),
      addBtn,
    ]),
  ]);
  dueInput.setAttribute('aria-label', 'Due time');
  const dueField = dueInput.parentElement;
  dueField.classList.add('notes-due-field');
  const dueToggle = el('button', { type: 'button', class: 'btn quiet workspace-phone-only notes-due-toggle', text: 'Add a due time',
    'aria-expanded': 'false', onclick: () => {
      const open = !form.classList.contains('notes-due-open');
      form.classList.toggle('notes-due-open', open); dueToggle.setAttribute('aria-expanded', String(open));
      if (open) dueInput.focus();
    } });
  form.querySelector('.form-grid').insertBefore(dueToggle, dueField);

  const list = el("div", { id: "notes-list", class: 'rd-stagger', style: "margin-top:14px;" });
  const stats = el('div', { class: 'notes-overview', hidden: false });
  list.overview = stats;
  if (window.matchMedia('(max-width: 768px)').matches) textInput.placeholder = 'Capture a thought…';
  const create = el('button', { type: 'button', class: 'btn workspace-phone-only workspace-round', 'aria-label': 'New note', onclick: () => textInput.focus() });
  create.innerHTML = ICONS.plus;
  header.append(create);
  const sort = el('select', { class: 'notes-sort', 'aria-label': 'Sort notes' }, [
    el('option', { value: 'saved', text: 'Saved order' }), el('option', { value: 'due', text: 'Due time' }),
    el('option', { value: 'title', text: 'A–Z' }),
  ]);
  sort.onchange = () => { list.sortOrder = sort.value; refresh(list, textInput); };
  header.append(sort);
  // Show the note count and offer "Clear finished" when any notes are done.
  const finishedBar = el("div", { class: "notes-finished-bar", hidden: true });
  list.finishedBar = finishedBar;

  header.append(finishedBar);  // right side of the page header, so it adds no row of its own
  {
    const heading = el('div', { class: 'notes-list-heading workspace-phone-only' }, [el('h3', { text: 'Open' })]);
    heading.append(header.querySelector('.notes-sort'));
    // On desktop the original sort remains in the header.
    const sortHome = el('span', { class: 'notes-sort-home' });
    header.append(sortHome);
    const sort = heading.querySelector('select');
    const sortButton = el('button', { type: 'button', class: 'phone-section-link notes-sort-trigger', text: 'Sort', 'aria-haspopup': 'dialog',
      onclick: () => phoneDetails('Sort notes', [sort], sortButton) });
    heading.append(sortButton);
    const phone = window.matchMedia('(max-width: 768px)');
    const placeSort = () => { if (phone.matches) heading.append(sort); else sortHome.append(sort); };
    placeSort(); phone.addEventListener('change', placeSort);
    const observer = new MutationObserver(() => { if (!wrap.isConnected) { phone.removeEventListener('change', placeSort); observer.disconnect(); } });
    // Start observing after the wrapper is attached below.
    queueMicrotask(() => observer.observe(document.body, { childList: true, subtree: true }));
    list.beforeHeading = heading;
  }
  wrap.append(header, stats, form, list);
  if (list.beforeHeading) list.before(list.beforeHeading);
  container.append(wrap);
  const onAppearance = () => {
    if (!wrap.isConnected) { document.removeEventListener("kairos:appearance", onAppearance); return; }
    refresh(list, textInput);
  };
  document.addEventListener("kairos:appearance", onAppearance);

  const submit = async () => {
    const text = textInput.value.trim();
    if (!text) { textInput.focus(); return; }
    const due = dueInput.value ? new Date(dueInput.value).toISOString() : null;
    await api("/api/notes", { method: "POST", body: JSON.stringify({ text, due_date: due }) });
    textInput.value = "";
    dueInput.value = "";
    await refresh(list, textInput);
  };
  addBtn.addEventListener("click", submit);
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  await refresh(list, textInput);
}

// Redesign preview: a short due label ("Today 6:23 PM", "Wed 9:00 AM", "Oct 30"); the full date stays in the title.
function shortDue(iso) {
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// "Clear finished" deletes every completed note through the
// same DELETE route the single delete uses, after the app's confirm dialog.
function drawFinishedBar(list, focusTarget, notes) {
  const bar = list.finishedBar;
  if (!bar) return;
  const done = notes.filter((n) => n.completed);
  bar.replaceChildren();
  bar.hidden = false;
  const count = `${notes.length} note${notes.length === 1 ? "" : "s"}` + (done.length ? ` · ${done.length} finished` : "");
  bar.append(el("span", { class: "notes-finished-count", text: count }));
  if (!done.length) return;
  const clear = el("button", { type: "button", class: "btn", text: "Clear finished", 'aria-label': 'Clear finished' });
  clear.insertAdjacentHTML('afterbegin', ICONS.trash);
  clear.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Clear finished notes?",
      message: `Delete ${done.length} finished note${done.length === 1 ? "" : "s"}? This can't be undone.`,
      confirmLabel: "Clear finished",
    });
    if (!ok) return;
    clear.disabled = true;
    const results = await Promise.allSettled(done.map((n) => api(`/api/notes/${n.id}`, { method: "DELETE" })));
    const failed = results.filter((r) => r.status === "rejected").length;
    const removed = done.length - failed;
    await refresh(list, focusTarget);
    if (failed) toast(`Deleted ${removed} of ${done.length} finished notes. ${failed} could not be deleted.`, "error");
    else toast(`Deleted ${removed} finished note${removed === 1 ? "" : "s"}`, "success");
  });
  bar.append(clear);
}

function dueNode(note, dueText) {
  const full = `Due ${dueText}`;

  const overdue = !note.completed && new Date(note.due_date) < new Date();
  return el("div", { class: "meta" + (overdue ? " is-overdue" : ""), text: shortDue(note.due_date), title: full });
}

async function refresh(list, focusTarget) {
  const notes = await api("/api/notes");
  if (list.sortOrder === 'due') notes.sort((a, b) => (a.due_date ? new Date(a.due_date).getTime() : Infinity) - (b.due_date ? new Date(b.due_date).getTime() : Infinity));
  if (list.sortOrder === 'title') notes.sort((a, b) => a.text.localeCompare(b.text));
  if (list.overview) list.overview.hidden = false;
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() + 7);
  list.overview?.replaceChildren(workspaceStats([
    { label: 'Finished', value: notes.filter(n => n.completed).length },
    { label: 'Due this week', value: notes.filter(n => !n.completed && n.due_date && new Date(n.due_date) >= now && new Date(n.due_date) < end).length },
  ]));
  list.innerHTML = "";
  drawFinishedBar(list, focusTarget, notes);
  if (notes.length === 0) {
    list.appendChild(emptyState({
      icon: ICONS.notes,
      title: "No notes yet",
      hint: "Track priorities, todos, and reminders here. Anything with a due date also shows up on your Calendar.",
      actionLabel: "Add your first note",
      onAction: () => focusTarget && focusTarget.focus(),
    }));
    return;
  }
  for (const note of notes) {
    const checkbox = el("input", { type: "checkbox", "aria-label": "Complete: " + note.text });
    checkbox.checked = note.completed;
    checkbox.addEventListener("change", async () => {
      // The strike draws (or clears) at once; the list reloads after it has
      // played, so the change is seen rather than snapped (style.css .note-title).
      title.classList.remove("is-settled");
      title.classList.toggle("is-done", checkbox.checked);
      const played = new Promise((resolve) => setTimeout(resolve, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320));
      await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ completed: checkbox.checked }) });
      await played;
      await refresh(list, focusTarget);
    });

    const title = el("div", { class: "title note-title" + (note.completed ? " is-done is-settled" : ""), text: note.text });
    title.title = note.text;  // compact rows truncate; the full text stays in the tooltip
    const dueText = note.due_date ? new Date(note.due_date).toLocaleString() : null;
    const delBtn = iconButton(ICONS.trash, "Delete note", async () => {
      const ok = await confirmDialog({
        title: "Delete this note?",
        message: `"${note.text}" will be permanently deleted.`,
        confirmLabel: "Delete note",
      });
      if (!ok) return;
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
      await refresh(list, focusTarget);
      toast("Note deleted", "success");
    }, { danger: true });

    const card = el("div", { class: "glass bracket card has-row-actions", "data-mobile-row": "" }, [
      el("div", { class: "card-row" }, [
        el("div", { class: "card-row", style: "gap:10px;" }, [
          checkbox,
          el("div", {}, [
            title,
            dueText ? dueNode(note, dueText) : null,
          ]),
        ]),
        el("div", { class: "row-actions" }, [delBtn]),
      ]),
    ]);
    list.appendChild(card);
    const actions = card.querySelector('.row-actions');
    const open = el('button', { type: 'button', class: 'workspace-phone-only note-open', text: note.text, 'aria-label': `Note details: ${note.text}`, 'aria-haspopup': 'dialog',
      onclick: () => phoneDetails('Note', [actions], open, note.text) });
    title.replaceChildren(el('span', { class: 'note-desktop-text', text: note.text }), open);
    if (!dueText) title.after(el('div', { class: 'meta workspace-phone-only', text: 'No date' }));
    // Desktop clamps a very long note to a few lines; this reaches the rest (syncNoteMore shows it only when text is cut).
    const more = el('button', { type: 'button', class: 'btn quiet note-more', text: 'Show more', 'aria-expanded': 'false', hidden: true, onclick: () => {
      const expanded = card.classList.toggle('is-expanded');
      more.textContent = expanded ? 'Show less' : 'Show more'; more.setAttribute('aria-expanded', String(expanded));
    } });
    title.parentElement.append(more);
  }
  if (!list.clampObserver) list.clampObserver = new ResizeObserver(() => syncNoteMore(list));
  list.clampObserver.observe(list);
  requestAnimationFrame(() => syncNoteMore(list));
}

function syncNoteMore(list) {
  for (const card of list.querySelectorAll(':scope > .card:not(.is-expanded)')) {
    const title = card.querySelector('.note-title'), more = card.querySelector('.note-more');
    if (title && more) more.hidden = title.scrollHeight <= title.clientHeight + 1;
  }
}
