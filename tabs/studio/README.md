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
The last 30 edits can be undone and redone in this renderer session; typing in
one field or dragging one slider counts as one step.
Project versions refresh every three seconds when there are no local edits.

### Editor layout (Content Studio Editor build spec, steps 1 and 2)

Docked panes in Kairos's own tokens (`static/css/studio-editor.css`): Beats,
Assets and Ask Kairos on the left; the preview with safe-area guides (the
engine's copy area and, when narrated, the caption band) and the transport in
the middle; Beat, Project, Render and History on the right; the timeline
underneath. The splitters resize the panes (drag, arrow keys, double-click to
reset) and the sizes, the open tabs, snapping and guides are remembered per
person on this device (`kairos:studio-editor:v1:<username>`). At 760 px and
below the same parts stack: preview, a timeline strip, the inspector, the list.

The timeline (`static/js/studioTimeline.js`, maths in
`static/js/studioEditorModel.js`) draws a ruler with zoom (buttons, the
slider, = and -, Ctrl + wheel, Fit), a playhead you drag (snapping to beat
edges, chapters, the playhead and the work area; Shift turns it off), the beats
as clips sized by their real length, chapter markers, the narration lane (each
spoken line's peak levels from `GET /api/tab-studio/videos/<id>/waveform`,
read from its cached audio; caption spans before that) and the music lane (the
bed's level as the mix ducks it, read only). Drag a clip to reorder; drag its
right edge to change its bars in half steps (narrated beats are as long as
their line). Press ? in the editor for the keyboard shortcuts.

A scene beat's setting, shot, characters on screen (position, view,
expression, action, facing, head turn, who speaks) and props are a form
(`static/js/studioSceneForm.js`), no longer raw JSON. A Pack B stage beat's set,
shot, pedestal, 3D characters (position, expression, action, facing, who speaks,
a reaction), stand-in people, glossy props and labels over heads are a form too
(`static/js/studioStageForm.js`); Project > 3D picks three.js or, when installed,
Blender. Project > Cast pins the account's characters to a version; a scene shows
only 2D cast characters and a stage only 3D ones.

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

## Content

The Content button beside Videos opens the Content Studio team's screens
(`static/js/studioContent.js`, logic in `studioContentModel.js`, styles in
`static/css/studio-content.css`; the routes are `/api/content-studio/`). With no
channels it explains the team and offers the Bots template and Add a channel.
Otherwise: Approvals (approve, edit, reject with a note, redraft; approving only
marks a post approved, Prepare post comes with the Kairos Browser; Approve all
once batch approval is on), the Pipeline board (an approved YouTube post can be
posted through your own Google project from its details), Channels (registered by
you, never created by Kairos; each with a look, aspect and voice notes; platform
warnings show at the top until resolved; the YouTube analytics and posting
connections), the Scoreboard with pending decisions (including new niches the
Researcher proposes) and the team settings (score weights, batch approval), and
the weekly Report with a CSV import for platform analytics.

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
node scripts/test_studio_editor_model.cjs
node scripts/run-electron-test.cjs studio-checks
node scripts/test_studio_content_model.cjs
node scripts/run-electron-test.cjs studio-content-checks
```

The Electron script launches the real app shell against a synthetic local
backend. It uses the machine-wide `data/electron.lock`, blocks outside
requests, records writes, and saves screenshots under `data/ui-review`.
It covers projects, setup guidance, preview pixels, editing and inline
validation, reorder and undo, playback/aspects, render progress/downloads,
history confirmation, chat cards, recovery, deep links, labels and phone
targets at 1440 and 390 pixels, and the editor: docked panes, timeline zoom,
playhead drag and snapping, clip selection, drag to reorder and edge trim,
every shortcut through real DevTools input, pane sizes kept across a reload,
a dark base, the phone stack, and the scene form's edits with undo and redo. Its MP4 fixture is the repository's existing
demo film, not output produced by the fixture's mock render queue.

## Limits to review

The shared video API has no conditional PUT. Studio serializes its own saves
and pauses version refresh during local edits, but simultaneous model edits
or edits in another window can still overwrite a version. Both remain in
server history. Review this interaction before editing in multiple windows.

A chat card can show a first-frame preview without Studio being on. Render
discovery uses the tab's authenticated helper route, so an off or never-on
Studio tab cannot supply its inline MP4 button until it is enabled.

## Characters (Pack A)

Content > Characters lists the account's characters for the Flat 2D style pack, each version with
its reference sheet and status. New character starts from Kairos's own round, square or triangle
design; New version changes colours, accessory or name (any change is a new version, older ones stay).
Make sheet renders the sheet in the desktop app and sends it to Approvals, where only the person
approves or rejects it (`/api/characters`, routes/character_routes.py). A video can only render a
cast version that is approved. The beat editor has a `scene` kind with its own form.
