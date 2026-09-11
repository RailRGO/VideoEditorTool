# Reaction Studio

A reaction-video editor with two deliverables: the full uncut **Patreon** version
(composited from the raw 3840×1080 OBS capture) and the shorter **YouTube** cut
(full-frame passthrough of the finished Patreon render, with an anti-fingerprint cloak).

## Two engines, one UI

| Engine | Source | Preview | Render |
|---|---|---|---|
| **This PC** | file on your disk | full-res, local canvas | in-browser MediaRecorder (WebM) |
| **Colab** | files on the notebook side | light proxy stream | server ffmpeg (MP4), full-res original |

Weak PC? Host this UI once (static site — `render.yaml` deploys it on Render's free
tier), run the notebook, paste its tunnel URL into the app's Colab mode, and edit.
Nothing uploads from your machine: the browser sends a small project JSON and gets
the finished MP4 back. Closing the tab mid-render is safe — reconnect and the
download is waiting in the Render tab.

## Timeline editing

The timeline is a partition of the source: every second is exactly one section
(intro / lead / reaction / outro / fast / card / mute / cut), so both engines
render the same map.

- **Extend or shrink a section** — drag a block's edge: the neighbour gives up
  (or takes back) the time, so the intro can grow into the reaction and vice
  versa. Dragging the block's body moves it and pushes both neighbours.
- **Cut a part / add sections anywhere** — shift+drag on the timeline marks a
  range, then press CUT, MUTE, FFWD, CARD, INTRO, LEAD, REACT or OUTRO to make
  that range whatever you want (as many as you like). The `+` buttons add a
  quick 3–6 s section at the playhead.
- **Timeline tab (right inspector)** — selected segment (type + exact in/out
  as `1:23.5` timecodes), the full segment list, fast-forward and card
  settings, and a shortcut reference.
- **Undo/redo** — Ctrl+Z / Ctrl+Shift+Z covers the whole project: timeline
  edits *and* every layout / audio / retouch / cloak / polish setting. Quick
  follow-up changes to the same control coalesce into one step; drags and
  button actions are single steps.
- Shortcuts: `S` split at playhead, `⌫` delete selected, `←/→` one frame,
  `Shift+←/→` one second, `.` / `,` next / previous section boundary, `Esc`
  clears the range selection.

## Editing, autosave and QC

- **Autosave** — the whole edit (timeline + every setting) lands in
  localStorage ~1.5 s after it stops. Re-open the same file and a banner
  offers *Restore* / *Discard*. Manual *Save project* / *Load project* (.json)
  in the Render tab works alongside.
- **Waveforms on the timeline** — after a Polish scan, the audio lanes draw
  the real level envelope (mic lane, content lane; one mixed lane in YouTube
  mode) so you can see where the video is quiet or loud.
- **Transcript lane** — transcribe (Polish tab) or load a `.srt`/`.txt` and
  your words appear on a `script` row under the timeline: click a word to
  seek, drag to mark a range and cut/mute it like any other selection.
- **Per-card text** — a `card` section can carry its own title / subtitle /
  accent; empty fields inherit the global card from the Layout tab. Works in
  the browser render *and* the Colab render (Patreon composite and YouTube
  passthrough).
- **Upload kit (Colab render)** — the finished render is accompanied by
  `{name}_chapters.srt` (chapters at every structural boundary, in output
  time, ready to paste into the YouTube description), five 1280×720 thumbnail
  candidates, and an EBU R128 loudness report (integrated LUFS + true peak)
  with green/amber/red QC hints — all shown in the Render tab.
- **Take A/B (Polish tab)** — repeated takes list both occurrences with
  *keep 1st / keep 2nd* buttons (default: keep the last take, as before).
- **Channel-split preview (Colab)** — OBS files with two audio tracks get a
  `mix / mic / content` switch in the header; the server builds mic-only and
  content-only preview streams in the background (video is a stream copy,
  only the audio is re-derived from the original). The mic-channel setting
  from the Audio tab is applied to both the previews and the render.
- **EDL import** — the Claims tab can read back a Reaction Studio EDL
  `.txt`: the whole edit (segments + matched material) lands on the timeline
  in one undoable step.

## Develop

```bash
npm ci
npm run dev      # local UI on :5173
npm run build    # static bundle in dist/
```

## Colab backend

`colab_version/` holds the Python pipeline: WYSIWYG compositor (`compose.py`),
shared layout model (`layouts.py`), render/audio/retouch pipeline
(`video_processor.py`), the HTTP server + tunnel (`webapp/server.py`), and the
notebook (`video_editor_colab.ipynb`). See `colab_version/README.md`.
