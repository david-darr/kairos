// The old "New agent" dialog, retired (Bots Phase 1, unit U4). Creation lives in
// botsCreate.js; this export stays so an older import keeps working, and opens
// the same dialog the Bots screens open.
import { openNewBot } from './botsPanelHost.js';

export async function openCreateAgent(options = {}) {
  return openNewBot(options);
}
