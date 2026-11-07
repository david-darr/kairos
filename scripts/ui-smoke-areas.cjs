// scripts/ui-smoke-areas.cjs: which UI checks cover which files (David, 2026-11-05:
// "Yes, make it"). The full ui-smoke takes about 20 minutes and each run leaves about
// 120 MB of Windows kernel memory behind until a restart, so while working, run only
// the checks for what changed:
//
//   node scripts/run-electron-test.cjs ui-smoke --changed   the areas this branch touched
//   node scripts/run-electron-test.cjs ui-smoke --list      every area and its option
//
// The full run is still the bar once before a commit or merge.
//
// Rules, in order, for each changed file (paths relative to the repo, forward slashes):
//   1. SHARED: used by every screen, so the full run.
//   2. AREAS: the first area whose pattern matches runs its checks.
//   3. Any other renderer file (static/, demo/, a UI check script) is not mapped yet,
//      so the full run, and the report names the file. Add it to an area when that happens.
//   4. Everything else (Python, the Electron main process, docs, other tests) is not
//      ui-smoke's to check; its own tests cover it.

// A run: [suite, ...options] for run-electron-test.cjs.
const SHARED = [
  /^static\/js\/(app|api|auth|icons|kairosParts|layout|brand|menuFit|leaveGuard)\.js$/,
  /^static\/css\/(style|redesign|interface|redesign-parts|redesign-overlays|redesign-motion)\.css$/,
  /^static\/(index\.html|sw\.js)$/,
  /^demo\/fixtures\.js$/,
  /^scripts\/(ui-smoke|electron-exit)\.cjs$/,
  /^scripts\/fixtures\/(?!bots-|browse-)/,
];

const AREAS = [
  { name: 'Browse', runs: [['ui-smoke', '--browse-only']],
    files: [/^static\/js\/(views\/browse|browseHome|browseLook|browserPane)\.js$/, /^static\/css\/browse\.css$/, /^scripts\/(browse-ui-checks\.cjs|fixtures\/browse-)/] },
  { name: 'Bots', runs: [['ui-smoke', '--bots-only']],
    files: [/^static\/js\/(bots|botStatus|botNotifications|views\/bots)/, /^static\/css\/bots/, /^scripts\/(bots-.+-checks\.cjs|fixtures\/bots-)/] },
  { name: 'Agents (bot conversations, call, village)', runs: [['ui-smoke', '--agents-call-only'], ['ui-smoke', '--agents-ecosystem-only'], ['ui-smoke', '--agents-messenger-only'], ['ui-smoke', '--agents-layout-only'], ['ui-smoke', '--agents-birth-only'], ['ui-smoke', '--agents-profile-only'], ['ui-smoke', '--agents-phone-only']],
    files: [/^static\/js\/(agent[A-Z]|agentsMessenger|ecosystem|views\/agents|sessionChat|permissionPrompt|routinesPanel|call[A-Z])/, /^static\/css\/(agent-ecosystem|agents-messages|redesign-agents)\.css$/, /^scripts\/(agents-.+-checks|ecosystem-model-checks)\.cjs$/] },
  { name: 'Design canvas', runs: [['ui-smoke', '--design-only']],
    files: [/^static\/js\/(design[A-Z]|sharedDesignCanvas|chatDesignPane|views\/design)/, /^static\/css\/design-canvas\.css$/, /^scripts\/design-canvas-checks\.cjs$/] },
  { name: 'Mascot', runs: [['ui-smoke', '--mascot-only']],
    files: [/^static\/js\/mascot\.js$/, /^static\/css\/mascot\.css$/, /^scripts\/mascot-checks\.cjs$/] },
  { name: 'Kip, appearance and Home', runs: [['ui-smoke', '--g1-only'], ['ui-smoke', '--agents-appearance-only']],
    files: [/^static\/js\/(kip|appearance|art[A-Z]|backgroundEffect|dither|views\/appearancePanel)/, /^static\/css\/(appearance|kairos-theme|redesign-welcome)\.css$/, /^scripts\/(g1|appearance|appearance-migration)-checks\.cjs$/] },
  { name: 'Home', runs: [['ui-smoke', '--home-tab-cards-only']],
    files: [/^static\/js\/(redesignHome|views\/(home|layoutPanel))\.js$/, /^static\/css\/redesign-home\.css$/, /^scripts\/(home-redesign|home-card)-checks\.cjs$/] },
  { name: 'Chat, artifacts and voice', runs: [['ui-smoke', '--g2-only'], ['ui-smoke', '--chat-references-only'], ['chat-scroll-checks'], ['ask-user-checks']],
    files: [/^static\/js\/(chat[A-Z]|redesignChat|redesignConversations|sideChat|artifact|pdfViewer|openMic|voice|speechSegments|screenCapture|sessionAttachments|slashCommands|composerKeyboard|questionPrompt|recordingReview|views\/(chat|speechPanel))/, /^static\/css\/(chat|redesign-chat|question-prompt)\.css$/, /^scripts\/(g2-.+|artifact-.+|chat-.+|speech-segments|slash-help|ask-user)-checks\.cjs$/] },
  { name: 'Library and Vault', runs: [['ui-smoke', '--g5-only']],
    files: [/^static\/js\/(vault|views\/library)/, /^static\/css\/(vault|redesign-library)\.css$/, /^scripts\/(vault|library-docs)-checks\.cjs$/] },
  { name: 'Google Drive and accounts', runs: [['ui-smoke', '--google-only']],
    files: [/^static\/js\/google(Workspace|Calendar)\.js$/, /^scripts\/google-workspace-checks\.cjs$/] },
  { name: 'Notes and Email', runs: [['ui-smoke', '--g4-only']],
    files: [/^static\/js\/views\/(notes|email)\.js$/, /^static\/css\/redesign-(notes|email)\.css$/, /^scripts\/g4-(checks|backend)\.cjs$/] },
  { name: 'Calendar', runs: [['ui-smoke', '--g4-calendar-only']],
    files: [/^static\/js\/(calendarRepeat|views\/calendar)\.js$/, /^static\/css\/redesign-calendar\.css$/, /^scripts\/lifecycle-calendar-checks\.cjs$/] },
  { name: 'Tasks, Tool Store and Cookbook', runs: [['ui-smoke', '--g6-only'], ['ui-smoke', '--a13-detail-only']],
    files: [/^static\/js\/(views\/(tasks|taskBoard|taskTriggers|tool-store|cookbook)|redesignToolStoreMobile|runHistory|runTimeline|taskActivity|skillManager|storePublish)\.js$/, /^static\/css\/redesign-(tasks|toolstore|cookbook)\.css$/, /^scripts\/(g6|a13-detail)-checks\.cjs$/] },
  { name: 'Settings', runs: [['ui-smoke', '--g7-only'], ['ui-smoke', '--a14-settings-only'], ['ui-smoke', '--g8-only']],
    files: [/^static\/js\/(settingsKit|views\/settings)/, /^static\/css\/(settings|redesign-settings)\.css$/, /^scripts\/(settings-.+|g8)-checks\.cjs$/] },
  { name: 'Forge', runs: [['ui-smoke', '--g10-only'], ['ui-smoke', '--interface-details-only']],
    files: [/^static\/js\/(forge|views\/forge)/, /^static\/css\/redesign-forge\.css$/, /^scripts\/(g10|forge.*)-checks\.cjs$/] },
  { name: 'Phone', runs: [['ui-smoke', '--mobile-only'], ['ui-smoke', '--mobile-shell-only'], ['ui-smoke', '--mobile-chrome-only'], ['mobile-tabs-checks']],
    files: [/^static\/js\/(mobile|phoneRowDetails|views\/mobileLaunch)/, /^static\/css\/(redesign-mobile|mobile-sidebar)\.css$/, /^scripts\/(mobile-.+|phone-header)-checks\.cjs$/] },
  { name: 'App shell and sidebar', runs: [['ui-smoke', '--app-shell-only'], ['ui-smoke', '--interface-only'], ['ui-smoke', '--desktop-layout-only']],
    files: [/^static\/js\/(appModes|commandPalette|shortcuts|sidebar|sidebarNav|redesignShell|notch|workspace|floatingProgress|waitNotice)/, /^static\/css\/redesign-(shell|sidebar|tabbar|workspaces)\.css$/, /^scripts\/(app-shell|app-shell-gap|interface|interface-detail|desktop-layout)-checks\.cjs$/] },
  { name: 'Usage overlay', runs: [['usage-overlay-smoke']],
    files: [/^static\/(js\/usage-overlay\.js|css\/usage-overlay\.css|usage-overlay\.html)$/, /^scripts\/usage-overlay-smoke\.cjs$/] },
  { name: 'CRM tab', runs: [['crm-smoke']],
    files: [/^tabs\/crm\//, /^scripts\/crm-smoke\.cjs$/] },
];

// Files ui-smoke draws: anything else is not its to check (rule 4).
const RENDERER = [/^static\//, /^demo\//, /^tabs\//, /^scripts\/.+-checks\.cjs$/, /^scripts\/fixtures\//];

// Returns { full: [files that need the full run], runs: [[suite, ...options]], areas: [names], skipped: [files] }.
function plan(changed) {
  const full = [], skipped = [], areas = new Set();
  for (const file of changed) {
    if (SHARED.some(re => re.test(file))) { full.push(file); continue; }
    const area = AREAS.find(a => a.files.some(re => re.test(file)));
    if (area) { areas.add(area); continue; }
    if (RENDERER.some(re => re.test(file))) full.push(file);
    else skipped.push(file);
  }
  const seen = new Set(), runs = [];
  for (const area of areas) for (const run of area.runs) {
    const key = run.join(' ');
    if (!seen.has(key)) { seen.add(key); runs.push(run); }
  }
  return { full, runs, areas: [...areas].map(a => a.name), skipped };
}

module.exports = { SHARED, AREAS, plan };
