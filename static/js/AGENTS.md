# static/js/

The UI. Plain ES modules served as they are, with no build step. `app.js` boots
the shell; `api.js` holds the fetch helpers and `el()`; `views/` has one module
per tab (`views/chat.js`, `views/settings.js`, `views/tool-store.js` and so on).

## Where things are (by name prefix)

- `chat*`: the chat surface; `chatStream.js` mirrors live turns from the
  server, `chatActivity.js` draws the activity chip.
- `mobile*` and `phone*`: the phone layout. `redesign*`: the desktop redesign.
- `bots*` and `views/botsHome.js`, `views/botsShell.js`: the Bots mode (2026-10-28):
  `appModes.js` holds the three modes; `botsUi.js` the row kit; `static/css/bots.css` its tokens.
- `forge*`, `agent*`, `vault*`, `design*`, `call*`, `notch*`, `swarm*`: one
  feature each.
- `browserPane.js`: the side browser. In the desktop app its page is a native
  view drawn above the HTML, so anything shown over it must hide it.
- `vendor/`: third-party bundles, built by `scripts/build-chat-vendor.cjs` and
  `scripts/build-forge-vendor.cjs`. Do not edit by hand.

## Rules

- After any change here, run `scripts/build_site_demo.py`; the website demo is
  generated from these files.
- Follow `specs/frontend-style.md`; colours and type come from the shared
  tokens in `static/css`.
- UI checks run against the mocked backend `demo/fixtures.js`.

## Bots redesign, Phases 1 to 3

- `botsActivity.js`, `botsApprovalCards.js`, `botsApprovalModel.js`, `botsArchived.js`, `botsAttentionHost.js`.
- `botsAutomationCalendar.js`, `botsAutomationChangeCard.js`, `botsAutomationEditor.js`, `botsAutomationEvents.js`, `botsAutomationModel.js`.
- `botsAvatarEditor.js`, `botsChat.js`, `botsChatAttachments.js`, `botsChatSearch.js`, `botsComposer.js`.
- `botsConnectionsModel.js`, `botsCreate.js`, `botsCreateModel.js`, `botsDrafts.js`, `botsGallery.js`.
- `botsGrantsModel.js`, `botsIcons.js`, `botsInbox.js`, `botsInspector.js`, `botsKip.js`.
- `botsLimitReset.js`, `botsMcpPaste.js`, `botsMemoryActivityModel.js`, `botsMemoryModel.js`, `botsMessageActions.js`.
- `botsNavigation.js`, `botsNotifications.js`, `botsPanel.js`, `botsPanelHost.js`, `botsPanelSections.js`.
- `botsPatchQueue.js`, `botsProfileDiff.js`, `botsRail.js`, `botsSectionAboutYou.js`, `botsSectionConnections.js`.
- `botsSectionGrants.js`, `botsSectionKeys.js`, `botsSectionLogins.js`, `botsSectionMemory.js`, `botsSectionMemoryActivity.js`.
- `botsSectionPermissions.js`, `botsSectionRoutines.js`, `botsSectionSkillLibrary.js`, `botsSectionSkills.js`, `botsSidebarModel.js`.
- `botsSkillCommands.js`, `botsSkillRequest.js`, `botsSkillsModel.js`, `botStatus.js`, `botsThreadMenu.js`.
- `botsTranscript.js`, `views/botsAutomations.js`, `../css/bots-attention.css`, `../css/bots-automation-calendar.css`, `../css/bots-automations.css`.
- `../css/bots-avatar.css`, `../css/bots-cards.css`, `../css/bots-chat.css`, `../css/bots-composer.css`, `../css/bots-connections.css`.
- `../css/bots-create.css`, `../css/bots-grants.css`, `../css/bots-kip.css`, `../css/bots-memory-activity.css`, `../css/bots-memory.css`.
- `../css/bots-panel.css`, `../css/bots-permissions.css`, `../css/bots-shell.css`, `../css/bots-sidebar.css`, `../css/bots-skills.css`.
- `../css/bots.css`.
