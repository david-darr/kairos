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
only 2D cast characters and a stage only 3D ones. 3D shots preview live with
three.js: the app page maps its bare module name with one inline import map,
allowed by its hash in the page's Content-Security-Policy only (`static/index.html`,
`core/middleware.py`, `core/three_vendor.py`). A computer whose browser cannot draw
WebGL shows them as stand-in cards and says why.

### Tracks and clips (step 3)

The beats stay the main picture track. Overlay tracks (lanes above the beats)
hold text, image and shape clips, drawn over the beats in track order and under
the captions (`static/motion/overlay.js`, inside `drawFrame(t)`); audio tracks
(lanes under the narration) hold sound clips from the person's own uploaded
files (Assets > Sounds; decoded by FFmpeg into 48 kHz WAV, never fetched),
mixed into the soundtrack. A clip has a start, an in and out (its own time), an
opacity or volume and fades; a picture clip has a box as shares of the frame.
On the timeline: + Text, + Shape, Add track, drag a clip along its lane or onto
another lane of its kind, drag either edge to trim, S splits at the playhead,
Delete removes (Ripple closes the gap on its track), and each lane's head has
Hide (Mute), Lock and Remove. The inspector's Clip tab edits every field
(`static/js/studioClipForm.js`); the selected clip is outlined on the preview.
The schema, its checks and the `video_edit` clip operations are in
`core/video_tracks.py`; a video without tracks is stored exactly as before.

### Ask Kairos (step 4)

Ask Kairos sends a request with the selection (the beat or clip, the work area,
the playhead and what is on screen there) and any comments pinned on the
preview (C turns on comment mode; a click pins one at that place and moment).
The account's own model connection reads the whole timeline as JSON, the
person's changes since its last turn and the comments, and answers with
`video_edit` operations, applied through the store's checks as one version
(`core/video_agent.py`). More than five changed items wait as a dry run the
person applies or discards; each applied request has its own "Undo Kairos's
change" (item by item; anything the person changed again is left). Locked
tracks cannot change and the agent cannot unlock them. Open in chat still opens
a linked chat with the request as a draft.

Rendering uses the existing video API and FFmpeg on this computer. Studio
never installs it. Job IDs are kept in device storage and reconciled with
server jobs and render files when returning to a project. Completed MP4s,
contact sheets and WAV soundtracks are recovered from disk after a restart.
Active jobs are owned by the backend and do not survive a backend restart.
Publishing is outside this tab.

Open in chat (in Ask Kairos) opens a chat owned by the signed-in person and
linked to this video, with the request as an editable draft. It does not send
the draft. Video/design content marks the linked chat as untrusted through the
tab API. Ask Kairos itself goes through `/api/videos/<id>/agent/ask`, which
fences the video's content as data and changes the video only through the
validated `video_edit` operations.

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
a dark base, the phone stack, the scene form's edits with undo and redo, the
3D preview under the app page's real policy, tracks and clips (add, drag along
and between lanes, trim both edges, split, lock, hide, ripple delete, undo, a
sound and an image), and Ask Kairos (a comment pin, an applied run and its
undo, a dry run applied after a look, the changes since its last turn). Its MP4 fixture is the repository's existing
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
