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
- **Cards cover the content, exactly** — the placeholder is pinned to the
  *drawn* content picture (fit + zoom + offset), so it can neither overrun the
  picture nor leave a gap at its right/bottom edge; in YouTube mode it covers
  the same content rect the file was composed with. Opacity is literal: 100 %
  is fully opaque, 0 % draws no card at all (default 96 %), and backdrop,
  accent bar, words and ring share that one alpha. Short cards cover the top
  75 % of the content by default, so subtitles stay visible.
- **Fair-use limiter** — *Short cards (cut nothing)* keeps every second of the
  reaction and lays short cards over the long talking stretches (8 s of talking
  → 4 s card, repeating; a 30 s stretch gets cards at 8–12 s and 20–24 s), and
  the card may play a little faster to claw back time. *Trim to limit* is the
  only tool that drops footage: it splits the reaction into equal windows and
  keeps the most speech-dense moment of each, so start, middle and end survive
  instead of the reaction being truncated after the first N minutes. Either way
  the limiter only ever inserts short cards.
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
npx tsc --noEmit # type check
```

Preview/render tests (no ffmpeg, no browser, a couple of seconds):

```bash
npm test                                 # geometry + audio graph + export panel
node src/__tests__/render_geometry.test.mjs   # card, mirror, limiter geometry
node src/__tests__/audio_engine.test.mjs      # attach/detach/attach audio graph
```

Opt-in real-browser check for the preview audio mix (needs Playwright, a
Chromium and the dev server — it drives the app, forces the failed `play()`
that detaches the graph, and checks the mix rebuilds on the same
context/source node instead of throwing `already connected previously to a
different MediaElementSourceNode`):

```bash
npm i -D playwright && npx playwright install chromium
npm run dev
node src/__tests__/browser_mix_check.mjs http://localhost:5173/ ./clip.webm
```

Pipeline tests — the planning, card and limiter parts run anywhere, the
render parts need ffmpeg, numpy and opencv:

```bash
cd colab_version
python3 webapp/tests/test_render_parts.py fast   # math only, <1 s
python3 webapp/tests/test_render_parts.py        # chunked/resumable renders, stems, cards
python3 webapp/tests/parity_browser_vs_colab.py  # browser == Colab (needs node + esbuild)
```

## Colab backend

`colab_version/` holds the Python pipeline: WYSIWYG compositor (`compose.py`),
shared layout model (`layouts.py`), render/audio/retouch pipeline
(`video_processor.py`), the HTTP server + tunnel (`webapp/server.py`), and two
notebooks: `backend_colab.ipynb` (the one to run — just a settings form: your
clip, output folder and editor URL; the logic is folded away in
`colab_launch.py`) and `video_editor_colab.ipynb` (same, plus the in-cell editor
GUI and manual render cells). See `colab_version/README.md`.

The Cloak tab's voice changer targets the **content** bus by default: the
show gets re-voiced (that is the audio Content ID fingerprints) while your
commentary and the intro/outro stay natural. The **Everyone** target is the
CapCut-style move — every voice in the reaction part (yours and the show's)
comes out as the same new character voice. The default engine is built in
(`colab_version/voice_morph.py`) — numpy and ffmpeg only, no model file, no
download, ~10× realtime on the Colab CPU, duration-exact so A/V can never
drift. RVC character voices are an opt-in engine: paste a path, an `https://`
URL or `hf:owner/repo/file.pth` and the notebook fetches it.

**Keep the audio under cards** (Cloak tab) is a tick of its own, independent
of the voice changer: on, card sections stop muting and the programme plays
on through every card — re-voiced exactly the same way, or left as recorded;
off, a card silences it like it always did (mute sections silence either
way; cut parts, intro and outro are never altered — only the reaction part
is). **Mirroring** flips the watched programme content-only, so the camera
and the card text stay readable and intro/outro stay exactly as recorded —
and a **short card is never mirrored**: the strip it leaves visible, where
burned-in subtitles live, comes through unflipped in the preview and in the
render alike. The re-voiced bus is cached on Drive
(`output/voice_cache/`, keyed by the audio + voice settings, pruned to the
newest 8 entries), so a re-render with the same voice settings pulls it from
there instead of running the engine again. Encoder choices are smoke-tested,
and a GPU that dies mid-render re-runs the pass on `libx264` rather than
failing the export — the pin is a *failure* pin: the next render re-tests
the GPU automatically (a user-set `REACT_GPU=0` is never overridden), and
`/api/state` → `encoder` plus `tools("link + status")` say which encoder is
active. The preview proxy falls back the same way and can be rebuilt from
the UI (`POST /api/proxy/retry`).

Server renders are chunked and journaled, so a runtime that gets reclaimed
mid-render costs one part instead of the whole encode — the editor's Export
tab (or `tools("resume the unfinished render")`) finishes it from the parts
on Drive. Patreon masters carry the content and mic buses as audio tracks 2
and 3 behind the mix, which is what lets the YouTube cut silence the
programme and keep your voice.
