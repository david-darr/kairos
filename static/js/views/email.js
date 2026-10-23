import { api, el, toast, confirmDialog, iconButton, emptyState } from "../api.js";
import { ICONS } from "../icons.js";

export async function render(container) {
  container.innerHTML = "";

  const wrap = el("div", { class: "view-constrained email-view" });
  wrap.dataset.mobileDock = "filter"; wrap.dataset.mobileFilterLabel = "Search mail and accounts";  // phone dock search (mobileDock.js)

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

  form.querySelector('summary').dataset.mobileDock = 'create';
  form.querySelector('summary').dataset.mobileCreateLabel = 'Connect an email account';
  const list = el("div", { id: "email-accounts-list", style: "margin-top:14px;" });
  const triage = el("div", { id: "email-triage", style: "margin-top:14px;" });
  const sending = el("div", { id: "email-sending", style: "margin-top:14px;" });
  wrap.append(header, triage, sending, form, list);
  container.append(wrap);
  refreshTriage(triage);
  refreshSending(sending, form);

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
    refreshSending(sending, form);
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
  if (data.error) {
    body.push(el("div", { class: "meta", style: "color:var(--danger);", text: data.error }));
  }
  if (!data.items || data.items.length === 0) {
    body.push(el("div", { class: "meta", style: "margin-top:8px;", text:
      data.generated_at ? "Nothing important in the last day." : "No results yet — run it to see what's worth your attention." }));
  } else {
    for (const it of data.items) {
      // Class hooks and the sender's initial are for the redesign look; the
      // initial stays hidden (redesign-email.css) unless the redesign preview is on.
      body.push(el("div", { class: "email-item", "data-mobile-row": "", style: "padding:9px 0;border-top:1px solid var(--border);" }, [
        el("span", { class: "email-item-avatar", "aria-hidden": "true", text: (String(it.from || "").match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase() }),
        el("div", { class: "email-item-body" }, [
          el("div", { class: "title", style: "font-size:12.5px;", text: it.subject || "(no subject)" }),
          el("div", { class: "meta email-item-from", style: "margin-top:2px;", text: `${it.from || ""}${it.date ? " · " + it.date : ""}` }),
          el("div", { class: "meta email-item-reason", style: "margin-top:3px;color:var(--accent);", text: it.reason || "" }),
        ]),
      ]));
    }
  }

  host.appendChild(el("div", { class: "glass bracket card email-triage-card" }, [
    el("div", { class: "card-row", style: "justify-content:space-between;align-items:flex-start;" }, [
      el("div", {}, [
        el("div", { class: "title", text: "Important today" }),
        el("div", { class: "meta", style: "margin-top:3px;", text: when }),
      ]),
      runBtn,
    ]),
    ...body,
  ]));
}

// Every address agents can send from (send_email). Google accounts are signed
// in through the same flow as Library, so people find them where they look
// for email. Admin only, like Google itself; hidden for everyone else.
async function refreshSending(host, form) {
  let data;
  try { data = await api("/api/email/sending-accounts"); }
  catch (_) { host.replaceChildren(); return; }
  if (!host.isConnected) return;
  const { signIn, onSignInHost } = await import("../googleWorkspace.js");
  const again = () => refreshSending(host, form);
  const openLibrary = () => import("../app.js").then(m => m.switchTab("library", { section: "google" }));

  const rows = data.accounts.map(account => {
    const google = account.via === "Google";
    const allow = el("button", { type: "button", class: "btn", text: "Allow sending" });
    allow.addEventListener("click", async () => {
      try {
        await signIn(allow, "Allow sending", next => {
          if (!(next.accounts || []).find(a => a.id === account.id)?.can_send_email) return false;
          toast(`${account.email} can now send email`, "success"); again(); return true;
        });
      } catch (e) { toast(e.message || "Google sign-in failed", "error"); }
    });
    allow.disabled = !onSignInHost();
    allow.title = `Sign in again as ${account.email} and approve sending email`;
    return el("div", { class: "email-sending-row", "data-mobile-row": "" }, [
      el("div", { class: "email-sending-address" }, [
        el("div", { class: "title", text: account.email }),
        el("div", { class: "meta", text: google
          ? (account.can_send ? "Google · can send" : "Google · needs permission to send")
          : "Email tab account · can send" }),
      ]),
      google && !account.can_send ? allow : null,
    ]);
  });

  const addGoogle = el("button", { type: "button", class: "btn primary", text: data.google_configured ? "Add Google account" : "Set up Google" });
  addGoogle.addEventListener("click", async () => {
    if (!data.google_configured) { openLibrary(); return; }
    const before = data.accounts.filter(a => a.via === "Google").length;
    try {
      await signIn(addGoogle, "Add Google account", next => {
        if ((next.accounts || []).length <= before) return false;
        toast("Google account added", "success"); again(); return true;
      });
    } catch (e) { toast(e.message || "Google sign-in failed", "error"); }
  });
  addGoogle.disabled = data.google_configured && !onSignInHost();
  if (addGoogle.disabled) addGoogle.title = "Open Kairos on the computer it runs on to sign in to Google";
  const addOther = el("button", { type: "button", class: "btn", text: "Add another provider", onclick: () => {
    form.open = true; form.querySelector("input")?.focus();
  }});

  host.replaceChildren(el("div", { class: "glass bracket card email-sending-card" }, [
    el("div", { class: "card-row", style: "justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;" }, [
      el("div", {}, [
        el("div", { class: "title", text: "Sending accounts" }),
        el("div", { class: "meta", style: "margin-top:3px;", text: "Addresses your agents can send email from. Gmail and Google Workspace sign in with Google; other providers use the form below." }),
      ]),
      el("div", { class: "card-row", style: "gap:6px;flex-wrap:wrap;" }, [addGoogle, addOther]),
    ]),
    ...(rows.length ? rows : [el("div", { class: "meta", style: "margin-top:8px;", text: "No sending accounts yet." })]),
    data.google_configured ? null : el("div", { class: "meta", style: "margin-top:8px;", text: "Google needs a one-time OAuth client setup in Library first." }),
  ]));
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
