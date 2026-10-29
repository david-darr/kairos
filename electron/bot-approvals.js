"use strict";
// Raising a bot's approval level (Bots Phase 3, unit U1). The page only prepares a request; this module, in the
// desktop shell's main process, shows a native prompt the page cannot draw or click, then takes the confirm,
// activate and commit steps with a secret the page never sees. Any failed or refused step revokes the request,
// so nothing is left half confirmed. Lowering a level does not come through here.

const STEPS = ["confirm", "activate", "commit"];
const MODES = { edits: "Edits", auto: "Auto", full: "Full", custom: "Custom" };
const BLURB = {
  edits: "It will change files in its own folders without asking. Running things and outside changes still ask.",
  auto: "A careful reviewer will allow safe steps. Anything it doubts still asks you.",
  full: "It will act without asking, including sending messages on its own.",
  custom: "Exact commands you approved will run. Everything else asks.",
};

function valid(request) {
  return !!request && typeof request === "object" && typeof request.request_id === "string" && request.request_id.length > 0
    && request.request_id.length <= 80 && typeof request.bot_id === "string" && request.bot_id.length > 0
    && Object.hasOwn(MODES, request.mode) && Number.isInteger(request.revision) && request.revision >= 0
    && (request.thread_id == null || typeof request.thread_id === "string");
}

function promptFor(request) {
  const where = request.thread_id ? "in this conversation" : "everywhere";
  const name = typeof request.bot_name === "string" && request.bot_name ? request.bot_name.slice(0, 60) : "this bot";
  return {
    type: "warning", buttons: ["Cancel", `Allow ${MODES[request.mode]}`], defaultId: 0, cancelId: 0, noLink: true,
    title: "Raise approval", message: `Let ${name} work at ${MODES[request.mode]} ${where}?`, detail: BLURB[request.mode],
  };
}

function createElevation({ dialog, fetch, backendUrl, secret, parent }) {
  const post = async (step, body) => {
    const response = await fetch(`${backendUrl}/api/internal/bots-approvals/${step}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Kairos-Desktop": secret }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).detail || ""; } catch { /* no body */ }
      throw new Error(typeof detail === "string" && detail ? detail : `Step ${step} failed.`);
    }
    return response.json();
  };
  return async function elevate(request) {
    if (!secret) return { ok: false, message: "This copy of Kairos cannot confirm approval changes." };
    if (!valid(request)) return { ok: false, message: "That request is not valid." };
    const body = { request_id: request.request_id, bot_id: request.bot_id, thread_id: request.thread_id ?? null,
      mode: request.mode, revision: request.revision };
    const revoke = () => post("revoke", { request_id: request.request_id }).catch(() => {});
    try {
      const answer = await dialog.showMessageBox(parent?.() || undefined, promptFor(request));
      if (!answer || answer.response !== 1) { await revoke(); return { ok: false, message: "Nothing was changed." }; }
      for (const step of STEPS) await post(step, body);
      return { ok: true };
    } catch (error) {
      await revoke();
      return { ok: false, message: error?.message || "That did not work." };
    }
  };
}

function install({ ipcMain, dialog, BrowserWindow, backendUrl, secret, fromAppWindow, fetch: fetcher = globalThis.fetch }) {
  const elevate = createElevation({ dialog, fetch: fetcher, backendUrl, secret, parent: () => BrowserWindow?.getFocusedWindow?.() });
  ipcMain.handle("bot-approvals:elevate", (event, request) => (fromAppWindow(event) ? elevate(request) : { ok: false, message: "Not allowed." }));
  return { elevate };
}

module.exports = { createElevation, install, valid, promptFor, STEPS };
