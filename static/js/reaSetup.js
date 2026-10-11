import { api, toast, confirmDialog } from "./api.js";

// REA is a local npm package. Fetch and execute it only after a clear choice.
export async function addReaIntegration() {
  const status = await api("/api/integrations/rea/status");
  if (!status.ready) {
    toast(status.reason, "error");
    return null;
  }
  const accepted = await confirmDialog({
    title: "Add REA?",
    message: `Kairos will download and run ${status.package} on this computer through npx. ` +
      `Detected Node.js ${status.node} and npm ${status.npm}. REA's local MCP tools can inspect files and ` +
      "applications you choose in a chat. Some analysis types need separate software. Later new or changed tools are reviewed in Tool Store.",
    confirmLabel: "Download and add REA",
    danger: false,
  });
  if (!accepted) return null;
  return api("/api/integrations/rea", { method: "POST" });
}
