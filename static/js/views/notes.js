import { api, el, toast, confirmDialog, iconButton, emptyState } from "../api.js";
import { ICONS } from "../icons.js";

export async function render(container) {
  container.innerHTML = "";

  const wrap = el("div", { class: "view-constrained" });
  wrap.dataset.mobileDock = "filter"; wrap.dataset.mobileFilterLabel = "Search notes";  // phone dock search (mobileDock.js)

  const header = el("div", { class: "view-header" }, [
    el("div", {}, [
      el("h2", { text: "Notes" }),
      el("div", { class: "sub", text: "Capture a thought. Remember the important things." }),
    ]),
  ]);

  const textInput = el("input", { placeholder: "e.g. Finish the CS 571 lab writeup" });
  textInput.dataset.mobileDock = 'create'; textInput.dataset.mobileCreateLabel = 'Add note';
  const dueInput = el("input", { type: "datetime-local" });
  const addBtn = el("button", { class: "btn primary", text: "Add note" });

  const form = el("div", { class: "glass card" }, [
    el("div", { class: "form-grid" }, [
      el("div", { class: "field field-grow" }, [el("label", { text: "Note" }), textInput]),
      el("div", { class: "field" }, [el("label", { text: "Due (optional)" }), dueInput]),
      addBtn,
    ]),
  ]);

  const list = el("div", { id: "notes-list", style: "margin-top:14px;" });
  // Redesign preview only: a bar above the list with "Clear finished". It stays
  // hidden unless the switch is on and at least one note is done (see refresh).
  const finishedBar = el("div", { class: "notes-finished-bar", hidden: true });
  list.finishedBar = finishedBar;

  header.append(finishedBar);  // right side of the page header, so it adds no row of its own
  wrap.append(header, form, list);
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

const redesignOn = () => document.documentElement.classList.contains("kairos-redesign");

// "Clear finished" (redesign preview): deletes every completed note through the
// same DELETE route the single delete uses, after the app's confirm dialog.
function drawFinishedBar(list, focusTarget, notes) {
  const bar = list.finishedBar;
  if (!bar) return;
  const done = notes.filter((n) => n.completed);
  bar.replaceChildren();
  bar.hidden = !redesignOn();
  if (bar.hidden) return;
  const count = `${notes.length} note${notes.length === 1 ? "" : "s"}` + (done.length ? ` · ${done.length} finished` : "");
  bar.append(el("span", { class: "notes-finished-count", text: count }));
  if (!done.length) return;
  const clear = el("button", { type: "button", class: "btn", text: "Clear finished" });
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
  if (!redesignOn()) return el("div", { class: "meta", text: full });
  const overdue = !note.completed && new Date(note.due_date) < new Date();
  return el("div", { class: "meta" + (overdue ? " is-overdue" : ""), text: shortDue(note.due_date), title: full });
}

async function refresh(list, focusTarget) {
  const notes = await api("/api/notes");
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
    if (redesignOn()) title.title = note.text;  // compact rows truncate; the full text stays in the tooltip
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
  }
}
