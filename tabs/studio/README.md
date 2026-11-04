# Studio

Studio is a shipped folder tab, discovered and offered in Tool Store > Tabs
by the same loader as CRM. Turn it on there. Open a project at
`#/studio/<video-id>` or use a Video card in chat.

The home screen lists the signed-in person's visible videos. Start with a
brief in a new chat, a three-beat blank project in the default visible look,
or a design. Design conversion reads the first heading and local image from
each board in board order, copies images into the video store, and closes
with an end beat. A failed copy removes the incomplete new project.

The editor uses `/static/motion/engine.js`, the same engine as rendering.
Look variables and self-hosted font-face rules come from the same design
system helpers as the render player. Nothing is loaded from outside Kairos.
Preview remounts after 250 ms; saving waits 500 ms and serializes writes.
The last 30 edits can be undone and redone in this renderer session.
Move buttons and Alt + Up/Down provide keyboard alternatives to dragging.
Project versions refresh every three seconds when there are no local edits.

Rendering uses the existing video API and FFmpeg on this computer. Studio
never installs it. Job IDs are kept in device storage and reconciled with
server jobs and render files when returning to a project. Completed MP4s,
contact sheets and WAV soundtracks are recovered from disk after a restart.
Active jobs are owned by the backend and do not survive a backend restart.
Publishing is outside this tab.

Ask Kairos opens a chat owned by the signed-in person and linked to this
video, with the request as an editable draft. It does not send the draft.
Video/design content marks the linked chat as untrusted through the tab API.
The tab does not invoke model tools or bypass their permission gate.

## Integration prerequisite

The current stable tab API has no video/design store methods. The proposed
additive bridge is in `tab-api.patch`, pending permission to edit
`core/tab_api.py`. Without that bridge Studio's helper routes cannot run.
It adds narrowly scoped, user-authorized access to look tokens, design source
and assets, video resources, creation/copy/save, and chat linking. Video CRUD
and rendering continue to use the existing `/api/videos` contract.

## Checks

```
.venv\Scripts\python.exe -B -X utf8 scripts\test_studio_tab.py
.venv\Scripts\python.exe -B -X utf8 scripts\test_video.py
.venv\Scripts\python.exe -B -X utf8 scripts\test_crm.py
.venv\Scripts\python.exe -B -X utf8 scripts\test_tabs.py
.venv\Scripts\python.exe -B -X utf8 scripts\test_tab_boundaries.py
node --check tabs/studio/view.js
node --check static/js/chatContent.js
node --check static/js/app.js
node --check scripts/studio-checks.cjs
node scripts/studio-checks.cjs
```

The Electron script launches the real app shell against a synthetic local
backend. It uses the machine-wide `data/electron.lock`, blocks outside
requests, records writes, and saves screenshots under `data/ui-review`.
It covers projects, setup guidance, preview pixels, editing and inline
validation, reorder and undo, playback/aspects, render progress/downloads,
history confirmation, chat cards, recovery, deep links, labels and phone
targets at 1440 and 390 pixels. Its MP4 fixture is the repository's existing
demo film, not output produced by the fixture's mock render queue.

## Limits to review

The shared video API has no conditional PUT. Studio serializes its own saves
and pauses version refresh during local edits, but simultaneous model edits
or edits in another window can still overwrite a version. Both remain in
server history. Review this interaction before editing in multiple windows.

A chat card can show a first-frame preview without Studio being on. Render
discovery uses the tab's authenticated helper route, so an off or never-on
Studio tab cannot supply its inline MP4 button until it is enabled.
