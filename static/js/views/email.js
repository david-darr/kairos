import { api, el, toast, iconButton } from "../api.js";
import { workspaceConfirm as confirmDialog, workspaceEmpty as emptyState, workspaceStats } from '../workspaceParts.js';
import { ICONS } from "../icons.js";
import { createMascot } from '../mascot.js';
import { phoneDetails } from '../phoneRowDetails.js';

export async function render(container) {
  container.innerHTML = "";

  const wrap = el("div", { class: "view-constrained email-view" });

  const header = el("div", { class: "view-header" }, [
    el("div", {}, [
      el("h2", { text: "Email" }),
      el("div", { class: "sub", text: "The messages worth your attention, in one place." }),
    ]),
  ]);

  const emailInput = el("input", { placeholder: "you@example.com" });
  const passInput = el("input", { type: "password", placeholder: "Password / app password" });
  const imapHost = el("input", { placeholder: "imap.example.com" });
  const imapPort = el("input", { type: "number", value: "993" });
  const smtpHost = el("input", { placeholder: "smtp.example.com" });
  const smtpPort = el("input", { type: "number", value: "465" });
  const addBtn = el("button", { class: "btn", text: "Add Account" });

  // Was six placeholder-only inputs crammed into one wrapping flex row
  // (audit 2026-09-03) — now real labeled fields grouped into rows.
  const form = el("details", { class: "disclosure-panel" }, [
    el("summary", { text: "+ Connect an account" }),
    el("div", { class: "form-grid", style: "margin-bottom:12px;" }, [
      el("div", { class: "field field-grow" }, [el("label", { text: "Email address" }), emailInput]),
      el("div", { class: "field field-grow" }, [el("label", { text: "Password" }), passInput]),
    ]),
    el("div", { class: "form-grid" }, [
      el("div", { class: "field field-grow" }, [el("label", { text: "IMAP host" }), imapHost]),
      el("div", { class: "field field-sm" }, [el("label", { text: "Port" }), imapPort]),
      el("div", { class: "field field-grow" }, [el("label", { text: "SMTP host" }), smtpHost]),
      el("div", { class: "field field-sm" }, [el("label", { text: "Port" }), smtpPort]),
      addBtn,
    ]),
  ]);
  const list = el("div", { id: "email-accounts-list", class: 'rd-stagger', style: "margin-top:14px;" });
  const triage = el("div", { id: "email-triage", class: 'rd-stagger', style: "margin-top:14px;" });
  wrap.append(header, triage, form, list);
  container.append(wrap);
  const accounts = el('button', { type: 'button', class: 'btn email-accounts-trigger', 'aria-label': 'Accounts', text: 'Accounts', onclick: () => {
  if (window.matchMedia('(max-width: 768px)').matches) { phoneDetails('Email accounts', [form, list], accounts); return; }
  form.open = !form.open; if (form.open) emailInput.focus();
  } });
  accounts.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="9" r="3.5"/><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"/></svg>'); header.append(accounts);
  refreshTriage(triage);

  addBtn.addEventListener("click", async () => {
    // Was a silent `return` on incomplete input — the button just did
    // nothing with no explanation (audit 2026-09-03).
    if (!emailInput.value.trim() || !passInput.value || !imapHost.value.trim() || !smtpHost.value.trim()) {
      toast("Fill in email, password, and both host fields first", "error");
      return;
    }
    await api("/api/email/accounts", {
      method: "POST",
      body: JSON.stringify({
        email: emailInput.value.trim(),
        password: passInput.value,
        imap_host: imapHost.value.trim(),
        imap_port: parseInt(imapPort.value, 10) || 993,
        smtp_host: smtpHost.value.trim(),
        smtp_port: parseInt(smtpPort.value, 10) || 465,
      }),
    });
    emailInput.value = ""; passInput.value = ""; imapHost.value = ""; smtpHost.value = "";
    await refresh(list, emailInput);
    toast("Account added", "success");
  });

  await refresh(list, emailInput);
}

// "Show the messages it deems important, daily" (David's ask 2026-09-06).
// Reads the stored result of the 05:50 Triage Email task rather than scoring
// on every tab open — that keeps a model call off the page load, and "daily"
// is what was asked for. The button forces a fresh pass when you want one.
async function refreshTriage(host) {
  host.innerHTML = "";
  let data;
  try {
    data = await api("/api/email/triage");
  } catch (_) {
    return; // triage is additive; never let it break the accounts view
  }

  const runBtn = el("button", { class: "btn", text: "Refresh now", onclick: async () => {
    runBtn.disabled = true;
    runBtn.textContent = "Reading your inbox…";
    try {
      const res = await api("/api/email/triage/run", { method: "POST" });
      toast(res.summary || "Triage complete", "success");
      await refreshTriage(host);
    } catch (e) {
      toast(`Triage failed: ${e.message}`, "error");
      runBtn.disabled = false;
      runBtn.textContent = "Refresh now";
    }
  }});

  const when = data.generated_at
    ? `Last checked ${new Date(data.generated_at * 1000).toLocaleString()} · ${data.scanned} unread scanned`
    : "Runs automatically each morning at 5:50. Nothing checked yet.";

  const body = [];
  if (data.generated_at) body.push(workspaceStats([
    { label: 'Unread scanned', value: data.scanned ?? 0 },
    { label: 'Important', value: data.items?.length || 0 },
  ]));
  if (data.error) {
    body.push(el("div", { class: "meta", style: "color:var(--danger);", text: data.error }));
  }
  if (!data.items || data.items.length === 0) {
    body.push(emptyState({ title: data.generated_at ? 'Nothing needs your attention' : 'Your inbox, with room to think',
      hint: data.generated_at ? 'Nothing important in the last day.' : 'Run triage to see what needs you.',
      actionLabel: 'Refresh now', onAction: () => runBtn.click() }));
  } else {
    for (const it of data.items) {
      // Class hooks and the sender's initial are for the redesign look; the
      // initial stays hidden (redesign-email.css) unless the redesign preview is on.
      body.push(el("div", { class: "email-item", "data-mobile-row": "", style: "padding:9px 0;border-top:1px solid var(--border);" }, [
        el("span", { class: "email-item-avatar", "aria-hidden": "true", text: (String(it.from || "").match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase() }),
        el("div", { class: "email-item-body" }, [
          el("div", { class: "title", style: "font-size:12.5px;", text: it.subject || "(no subject)" }),
          el("div", { class: "meta email-item-from", style: "margin-top:2px;" }, [
            el('span', { text: it.from || '' }),
            it.date ? el('time', { class: 'email-item-time', text: it.date }) : null,
          ]),
          el("div", { class: "meta email-item-reason", style: "margin-top:3px;color:var(--accent);", text: it.reason || "" }),
        ]),
      ]));
    }
  }

  const card = el("div", { class: "glass bracket card email-triage-card" }, [
    el("div", { class: "card-row", style: "justify-content:space-between;align-items:flex-start;" }, [
      el("div", {}, [
        el("div", { class: "title", text: "Important today" }),
        el("div", { class: "meta", style: "margin-top:3px;", text: when }),
      ]),
      runBtn,
    ]),
    ...body,
  ]);
  const summary = el('div', { class: 'email-summary' });
  const heading = card.firstElementChild;
  const stats = body.find(node => node.classList.contains('workspace-stats'));
  if (document.documentElement.dataset.mascot !== 'off') heading.prepend(el('span', { class: 'workspace-phone-only', 'aria-hidden': 'true' }, [createMascot({ state: 'done', size: 40, decorative: true })]));
  const needs = el('section', { class: 'email-needs-list' });
  const title = el('h3', { class: 'workspace-phone-only', text: 'Needs you' });
  const phone = window.matchMedia('(max-width: 768px)');
  const place = () => {
    if (phone.matches) {
      summary.replaceChildren(heading, ...(stats ? [stats] : []));
      needs.replaceChildren(...body.filter(node => node !== stats));
      card.replaceChildren(summary, title, needs);
    } else card.replaceChildren(heading, ...body);
  };
  place(); phone.addEventListener('change', place);
  const observer = new MutationObserver(() => {
    if (!card.isConnected) { phone.removeEventListener('change', place); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  host.appendChild(card);
}

async function refresh(list, focusTarget) {
  const accounts = await api("/api/email/accounts");
  list.innerHTML = "";
  if (accounts.length === 0) {
    list.appendChild(emptyState({
      icon: ICONS.email,
      title: "No accounts connected",
      hint: "Connect an IMAP/SMTP account above. Once connected, your Daily Brief can summarize unread mail and flag anything important.",
      actionLabel: "Connect an account",
      onAction: () => { if (focusTarget) { focusTarget.closest("details").open = true; focusTarget.focus(); } },
    }));
    return;
  }
  for (const account of accounts) {
    const statusEl = el("span", { class: "meta", text: "" });
    const testBtn = el("button", { class: "btn", text: "Test connection", onclick: async () => {
      testBtn.disabled = true;
      statusEl.textContent = "Testing…";
      try {
        const result = await api(`/api/email/accounts/${account.id}/test`, { method: "POST" });
        statusEl.textContent = `IMAP: ${result.imap ? "OK" : "failed"} · SMTP: ${result.smtp ? "OK" : "failed"}`;
        const bothOk = result.imap && result.smtp;
        toast(
          bothOk ? `${account.email} connected successfully` : `${account.email}: ${result.imap_error || result.smtp_error || "connection problem"}`,
          bothOk ? "success" : "error",
        );
      } catch (e) {
        statusEl.textContent = "Test failed";
        toast(`Test failed: ${e.message}`, "error");
      } finally {
        testBtn.disabled = false;
      }
    }});

    const delBtn = iconButton(ICONS.trash, "Remove account", async () => {
      const ok = await confirmDialog({
        title: "Remove this account?",
        message: `${account.email} will be disconnected and its stored credentials deleted. Your mail itself isn't touched.`,
        confirmLabel: "Remove account",
      });
      if (!ok) return;
      await api(`/api/email/accounts/${account.id}`, { method: "DELETE" });
      await refresh(list, focusTarget);
      toast("Account removed", "success");
    }, { danger: true });

    const card = el("div", { class: "glass bracket card has-row-actions email-account", "data-mobile-row": "" }, [
      el("div", { class: "card-row" }, [
        el("div", {}, [
          el("div", { class: "title", text: account.email }),
          el("div", { class: "meta", text: `${account.imap_host} / ${account.smtp_host}` }),
          statusEl,
        ]),
        el("div", { class: "card-row", style: "gap:6px;" }, [testBtn, el("div", { class: "row-actions" }, [delBtn])]),
      ]),
    ]);
    list.appendChild(card);
  }
}
