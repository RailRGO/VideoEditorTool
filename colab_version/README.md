# Reaction Video Editor — Google Colab Adaptation

This folder (`colab_version/`) takes the best parts of **both repo variants**
(root original + "diffrent variant") and repackages them as a Python pipeline
that runs inside Google Colab instead of your old PC.

## Files

| File | What it is |
|---|---|
| `backend_colab.ipynb` | **The notebook to run**: a settings *form* (video, output, editor link) + a tools dropdown. No code to edit, compute side only |
| `colab_launch.py` | Everything the form triggers: deps → checkout → Drive → source → serve → link (+ `tools()` for status/tunnel/stop) |
| `video_editor_colab.ipynb` | The full notebook (kept as-is): in-cell widget editor, manual Patreon/YouTube cells, no-widget fallbacks |
| `webapp/` | Full web editor: `server.py` (runs on the VM) + `index.html` (the app, no build step) + `tests/` |
| `editor_gui.py` | In-cell widget editor (sliders + live WYSIWYG preview + sample renders) |
| `compose.py` | Frame compositor — the same math as the browser's `render.ts` |
| `layouts.py` | Shared layout model — the same rects/styles as `src/lib/types.ts` |
| `video_processor.py` | Pipeline: compose + audio mix + retouch + transcript + render |
| `make_fake_video.py` | Generates a synthetic 3840×1080 clip for testing |
| `requirements.txt` | `pip install -r requirements.txt` |

## The web app (closest to the original editor)

One cell starts a server on the Colab VM and prints a public link
(Cloudflare quick tunnel, no account needed). Open it in a normal
browser tab:

```python
from webapp.server import launch_webapp
web = launch_webapp(proc)   # -> https://....trycloudflare.com
```

You get the original app experience back — smooth playback, draggable
camera/content boxes on the stage, timeline with intro/body/cut/mute
segments, transport — while all heavy work (pixel-exact stills, audio
and video samples, full renders) runs on the Colab VM against your
real 3 GB file. Playback stays smooth via a small proxy transcode that
is generated once and cached in your output folder on Drive; if you
don't want to wait for it, the app also works in stills-only mode.

Notes: keep the cell running while you edit; the link dies with the
session (re-run for a fresh one); anyone with the link can view, so
don't share it publicly.

## The hosted editor UI (recommended for weak PCs)

The same server also powers the full React editor hosted as a static
site (root `render.yaml` — deploy once on Render, free tier is fine).
Open your site, switch the engine to **Colab**, and paste the tunnel
URL from notebook cell 3d:

- The browser previews a light proxy stream and sends your timeline,
  layout, audio, retouch and cloak settings to the notebook as one
  project file (`POST /api/job/render`).
- Patreon renders go through the WYSIWYG compositor; YouTube renders
  are a single-pass ffmpeg cut with the anti-fingerprint cloak.
- The finished MP4 downloads through the tunnel and also stays in the
  notebook's output folder. Closing the tab mid-render is safe —
  reconnect and the download is waiting in the Render tab.
- Switch sources without touching the notebook: the header lists every
  video in the source folder (`GET /api/sources`, `POST /api/source`).
- No copy-paste: set `HOSTED_EDITOR` in cell 3d once and it prints a one-click
  link that opens the site already connected (`?backend=`).
- Speech-to-text runs here too: the Polish tab's Transcribe button sends the
  intro/outro spans (`POST /api/job/transcript`, faster-whisper, word timings)
  and filler removal just works — no external transcription step.
- The Render tab's Save/Load project keeps the timeline + all settings as one
  tiny `.reaction.json`, so the edit survives closed tabs and dead sessions.

### Long renders survive a reclaimed runtime

A 3840×1080 Patreon render encodes at roughly 1.5–3 output frames per
second on Colab's 2 vCPUs — hours for a 20-minute cut, far past the
~90-minute idle reclaim. A single-pass render of a long capture simply
cannot finish, and the old code only wrote its file at the very end, so a
reclaim lost everything and the browser kept showing the last progress
number it had.

So both server pipelines now go through
`ReactionVideoProcessor.render_project()`:

- **Chunked.** Anything over 5 minutes of programme is split into parts of
  ~90–240 s (Export → *Long renders* → 2 min / 4 min to override; short
  renders stay exactly one pass, with no journal and no overhead). Splits
  land on programme boundaries and slice segments rather than padding
  them, so joining the parts reproduces the single-pass timeline exactly
  — verified by comparing frame counts (480 == 480 in the test suite).
- **Journaled.** Each part lands in `reaction_output/_parts/<name>/` and is
  recorded in `manifest.json` with its measured length and byte size. A
  part is only reused when the file exists, its size matches the journal
  and it probes to its planned length, so a half-written part is rebuilt,
  never spliced into the deliverable.
- **Resumable.** The cost of a reclaimed VM is one part. Re-run the
  notebook cell: it prints what is unfinished, and either the editor's
  Export tab (**Resume render**) or `tools("resume the unfinished render")`
  finishes it from the parts on disk. `GET /api/job` reports such a render
  as `state: "lost"` with `stopped after 12m of silence with 3/21 parts
  saved — it did NOT finish`.
- **Drift-free joins.** Every part's audio is fitted to that part's
  *measured* picture length before the parts are concatenated, so joins
  cannot accumulate frame drift; the picture parts are stream-copied
  (re-encoded only if that fails) and muxed once.
- **No silent hangs.** An ffmpeg that emits no `time=` line for 15 min is
  killed with a message instead of holding the job slot forever, and the
  render refuses to start when the output folder is unwritable or
  `/content/drive` is unmounted (a watchdog aborts mid-render if the mount
  drops, and a keep-alive stat keeps it warm).
- **Honest progress.** `GET /api/job` carries `step`, `part`, `parts`,
  `eta_s`, `elapsed_s`, `age_s` and `bytes`; the Export tab shows
  `part 4 of 21 · ~12 min left`, warns when the encoder goes quiet, and
  says so plainly when the backend stops answering instead of freezing on
  the last number it saw.

### Three audio tracks on the Patreon master

A Patreon master written by this pipeline carries three audio tracks:

| track | contents |
| ----- | -------- |
| 1 | the full mix (content + mic) — what every player picks up |
| 2 | content only |
| 3 | mic only |

All three are conformed to the same segment map and gain/limited like the
mix, and the file is tagged `comment=reaction_stems=mix,content,mic`.
Nothing about playback changes: YouTube's transcoder and Patreon's player
both keep the first stream only, so a 3-track file is never the uploaded
deliverable. Its value is as the intermediate: when you cut the YouTube
version *from* that master, the passthrough reads tracks 2 and 3 instead
of the mix, so a mute or card span silences the programme and **keeps your
voice** (the old path applied `volume=0` to everything). Your master gain
and limiter are re-applied to the rebuilt mix, and the uploaded cut stays
a single track. Any other source (one mixed track) still works exactly as
before — the stems are used only when they are there. Turn them off in
Export → *Long renders* → "Also write content & mic tracks".

The source picker in the header lists the output folder as well as the raw
folder, because that is where the master you cut from lives.

### The voice changer re-voices the show, not you

Content ID matches the **programme audio** — the show you are reacting to —
not your commentary. So `voiceTarget` defaults to **content**: the voice
engine re-voices tracks 2 (the show) inside the reaction part, while your
own voice and the intro/outro stay exactly as recorded. The trade is honest
and worth stating: the show now sounds dubbed. That is the point — a dubbed
voice is not the fingerprint that was registered.

| engine | what it needs | what it does |
| ------ | ------------- | ------------ |
| **Built-in morph** (default) | nothing — numpy + ffmpeg | resample + phase-vocoder vocal-tract warp + vibrato/breath/tilt, ~10× realtime on the Colab **CPU**. No model, no download, no torch, no GPU |
| **RVC** | `rvc-python` + a `.pth` | real neural conversion. Give a path, an `https://` URL or `hf:owner/repo/file.pth` and the notebook fetches it into `~/react_voices` (or `REACT_VOICE_DIR`); `pip install rvc-python` is attempted once on first use |
| **Basic FX** | nothing | the plain ffmpeg pitch/formant/robot presets |

Details worth knowing:

- The morph is **duration-exact** by construction (resample, then stretch
  back), so a re-voiced bus can never push the picture out of sync, and a
  silence gate keeps pauses where the source had them — a mute span stays
  silent instead of droning on.
- Silent runs are measured (`volumedetect`) and skipped, so mute/card spans
  cost nothing and come back bit-clean.
- `morphSeed` picks the character: the same seed sounds the same on every
  render, a different seed is a different voice from the same preset — which
  is what stops two uploads of one episode sharing a fingerprint.
- `voiceTarget = both` gives the mic its own character (`voicePresetMic`,
  `morphSeedMic`); empty means "same as the content".
- RVC on a CPU-only runtime is slow (minutes per minute of audio). The
  built-in morph is the same job at ~10× realtime, which is why it is the
  default.
- With a source that has one mixed track there is nothing to separate: the
  engine re-voices that track, your voice included, and the log says so.
  Load the Patreon master (three tracks) to keep your own voice natural.

### No GPU? The Colab CPU does the work

Every encoder choice is smoke-tested with a real one-frame encode before it
is picked (`compose.nvenc_available`), because *every* static ffmpeg build
lists `h264_nvenc` while a GPU-less runtime dies opening it with
`Cannot load libcuda.so.1`. And if the GPU goes away mid-render — driver
hiccup, CUDA OOM, the session's GPU being reclaimed — the failing pass is
re-run on `libx264` instead of costing the whole export (it used to fail on
part 6 of 6, after an hour of work). `REACT_GPU=0` forces the CPU encoder.

The preview proxy does the same (GPU attempt, then CPU), and tries its audio
plans in order — all tracks mixed, first track, silent — so a three-track
master still previews with sound. If a build does fail, the browser now
stays connected and offers **Rebuild preview stream** (`POST
/api/proxy/retry`) instead of leaving the play button dead until the notebook
was restarted.

### The placeholder card covers the content, not the frame

A card span used to be drawn as a near-full-frame box (0.06/0.16/0.88/0.68)
in the YouTube passthrough and on the server, which buried the camera
corner — the one thing viewers are there for. It now covers the layout's
**content rect**, i.e. the same rect the compositor covered when it made
the file you are cutting, so the camera stays visible. (The Patreon
compositor already did this, which is why the preview and the render
disagreed.) A card segment with no text of its own no longer crashes the
Patreon compositor either — it inherits the global card.

The card is drawn by the compositor itself (`compose.card_overlay`) and
composited into the passthrough as a PNG with ffmpeg's `overlay` — not
with `drawtext`. Static and pip-bundled ffmpeg builds ship no drawtext,
and minimal images ship no TTF, which is how cards used to export as a
black box with a lone accent line and no words; `overlay` is in every
build, and a PNG means the YouTube card is pixel-for-pixel the Patreon
card and the browser preview. For the same reason the cloak's vignette
is the preview's radial gradient as a PNG overlay instead of ffmpeg's
`vignette` filter, whose cos-power falloff (at the angles this used to
pass: ~PI/2) blacked out everything but the frame centre. Cover bars and
the frame border run once over the joined programme and skip card spans
via `enable=`, exactly like the preview does.

### Every effect ships OFF, and the overlay image lands in the composite

A fresh project changes nothing: the frame cloak, the audio cloak, the voice
changer, the mirror, the retouch and the sticker are all off until a box is
ticked (the Colab-side defaults in `layouts.py` match the browser's). The
card's opacity default is 97 % and the stretch played under a fair-use card
runs at 1.55×.

The **sticker / overlay image** (Cloak tab — subscribe button, like reminder,
logo) is painted last on the reaction part only, and now in *both*
deliverables. It used to exist only in the YouTube passthrough: the Patreon
composite — which is what the overview shows and what most people upload to
Patreon — ignored it completely, so the panel could show the uploaded
thumbnail while the preview and the render drew nothing. The compositor
(`compose.draw_sticker`) and the passthrough (`_sticker_png`) share one
geometry: x/y is the normalised top-left corner, w the width as a fraction of
the frame, the height follows the image's own aspect, everything clamps to
the frame, and intro/outro (mode `solo`) stay clean. A bare file name
resolves inside the output folder, which is where `/api/upload` puts it, so
the browser, the pre-render preview and the server render agree. The sticker
is part of a part's cache signature: change the image or its position and the
affected parts are rebuilt rather than reused.

**Troubleshooting the tunnel link.** The printed URL is reachability-
checked before it's shown, so if you see one, it works. If the launch
instead reports that no tunnel could be verified, it has *already* tried,
in order: Cloudflare quick tunnel (QUIC) → Cloudflare (HTTP/2) →
ssh→localhost.run on port 443 → ssh on port 22 — each verified from the
outside before it is offered. Colab blocks different egress paths at
different times, which is exactly why the launcher walks the list. If
*all* of them fail:
1. Just re-run the cell — you get a fresh tunnel and edge; re-running
   is safe (the server and your layout/cuts/state are kept).
2. `Runtime → Restart session`, then run cells 1→3c again.
3. Fall back to the in-cell editor (no tunnel needed):
   `from editor_gui import launch_editor; launch_editor(proc)`.
4. To fully stop the server + tunnel and free the port:
   `from webapp.server import stop_webapp; stop_webapp()`.

If the log says **cloudflared download failed**, the session's network
blocked GitHub releases — the error tells you the exact `!curl` command
to download it manually; then re-run the cell (a previously downloaded,
working binary is re-used and never re-downloaded, and broken/partial
binaries are detected and re-fetched automatically).

If you previously hit `OSError: [Errno 98] Address already in use` from
re-running the cell, that can't happen anymore — the second run reuses
the live server instead of trying to bind the port again.

## The in-cell visual editor

No more guessing parameters in a single cell. After creating `proc`,
run one line:

```python
from editor_gui import launch_editor
editor = launch_editor(proc)
```

You get 6 tabs. **Every slider updates a live preview instantly**,
rendered by the *same* compositor as the final file — what you see is
literally what gets rendered (verified: preview vs. rendered frame differ
only by video-compression noise).

| Tab | What you tweak, live |
|---|---|
| 1 · Preview | Scrub time, pick scene (reaction / solo / card / lead-in / fast), contact sheet |
| 2 · Layout | Preset + camera/content rects, shapes, radius, borders, zoom, offsets, background blur/opacity/dim — with an **overlap warning** if the camera covers the content |
| 3 · Retouch | Face smoothing / teeth / eyes, previewed on your actual frame |
| 4 · Cuts | Intro/outro, lead-in + black block, silence auto-cut, YouTube claim ranges, timeline + render-duration estimate |
| 5 · Audio | Mic channel/gain, compressor, limiter, content gain, ducking + an audible **10s audio sample** |
| 6 · Render | **12s sample render at the playhead first** (video + mixed audio, playable in the notebook), then full render with progress bar; save/load `layout.json` to Drive |

Recommended workflow: tune → sample → watch the sample → full render.
The Patreon/YouTube notebook cells automatically pick up your tuned
`editor.layout`, drops and claims.

No-widget fallback (if ipywidgets ever misbehaves):

```python
proc.show_preview(t=90, mode="body")                    # still frame, inline
outs = proc.render_sample(t_center=90, seconds=12)      # playable clip
```

## What was combined

| Feature | Source | What it does |
|---|---|---|
| Layout presets (diagonal / blur / hero / news) | diffrent variant (`defaults.ts`) | Camera top-left, content bottom-right, rounded rectangles |
| Composite engine (`compose.ts`) | diffrent variant | Background blur 50% / opacity 40%, PIP cards |
| Beauty stack (smooth/teeth/nose/eyes) | diffrent variant (`beauty.ts`) | MediaPipe face mesh tracking + per-frame filters |
| Audio engine (compressor / limiter / duck) | diffrent variant (`audio.ts`) | 2-track OBS splitting, sidechain ducking, limiter |
| AutoCut / silence / repeat detection | root (`AutoCut.tsx`, `disrupt.ts`) | Find silent/repeated segments for seamless cuts |
| Polish / transcript fix | root (`polish.ts`) | Whisper transcription, filler/repeat detection |
| Timeline / EDL / stages | root (`Timeline.tsx`, `render.ts`) | Scene-based intro (full cam) / reaction (PIP) / outro |

## Fixed: "camera too big, covering the content"

The first Colab version overlaid the camera half at **full resolution**,
ignoring all size/position parameters — that was your bug. The new
`compose.py` honours real normalised rects, so the default look is now:

- **Layout:** Camera **top-left** (~30%), content **bottom-right** (~70%),
  both rounded rectangles, zero overlap (the editor warns you if you
  create any), background full-frame with blur 50 / opacity 40%.
- **Intro/Outro:** Full-camera, uncut. Middle reaction = layout.
- **React lead-in:** 1–3 s of your "let's go" + a black content block
  before the video starts (tunable in the Cuts tab).
- **Cut disruptions:** silence auto-cut inside the reaction body only,
  plus YouTube claim ranges (`cut` or `mute`) — video and audio are cut
  with the **same segment map**, so they can never desync.
- **Face retouch:** MediaPipe face mesh (468 landmarks), mask rebuilt
  **every frame**, so it never falls off when you turn your head.
- **Audio that survives ffmpeg 7:** the old `-map_channel` option no
  longer exists in ffmpeg 7+, and OBS can record mic/desktop either as
  2 audio tracks or as left/right channels of 1 stereo track. The mixer
  now auto-detects your layout and routes the buses accordingly — the
  "Mic ch left/right" switch works for both.

## Answers to your direct questions

**Q: Exported in WebM — will it upload to YouTube?**
**A:** Yes. YouTube fully supports WebM (VP9 + Opus). We export both
`final.mp4` (H.264) and `final.webm` (VP9/Opus). MP4 is the safer fallback
if an editor rejects WebM, but YouTube accepts WebM directly.

**Q: Where is computing happening?**
**A:** **Inside the Colab session** (your remote VM, not your old PC). If
you select **GPU runtime** (Runtime → Change runtime type → GPU), face
retouch and some filters will be faster, but most pipeline steps (ffmpeg,
mediapipe) are CPU-bound and work fine on standard Colab CPU. Nothing runs
on your local machine.

**Q: My videos are 20+ minutes and 3 GB — where does that process?**
**A:** Temp folders (`/tmp` inside Colab) and Drive mounts. We never load a
3 GB file entirely into RAM; frames stream through OpenCV/ffmpeg one by
one, and outputs are written straight to Drive so they survive session end
(Colab temp files are deleted when the session dies).

**Q: Can I upload from Drive and get output to Drive?**
**A:** Yes — this is the intended workflow. Mount Drive, point
`ReactionVideoProcessor` at `/content/drive/MyDrive/your_video.mp4`, and
set `output_dir="/content/drive/MyDrive/output"`. The notebook writes
results there immediately.

**Q: Session sometimes interrupts — can I resume?**
**A:** The pipeline is stateless per run. If interrupted, just re-run the
cell; `ffmpeg` will overwrite partial outputs. Save your `layout.json` to
Drive so your tuning survives too. For very long videos you can also split
at the source (e.g., process intro/outro/reaction as separate 5-minute
chunks) and concatenate with `ffmpeg` at the end.

## Quick start in Colab

Open **`backend_colab.ipynb`**. It is two collapsed *form* cells, not code:

1. **Settings** — `VIDEO` (a folder → newest clip, or one clip file), `OUTPUT`,
   `EDITOR` (your hosted UI), `BRANCH`, `UPDATE_CODE`. Run it once; the output is
   the link to open. Change only the fields, never the cells — the fields also
   remember what you typed (they are saved with the notebook copy in Drive).
2. **Tools** — one dropdown: reprint the link + status (proxy/render progress,
   where the files are), renew a dead tunnel, stop the server, or fall back to
   the in-cell editor if Colab blocks every tunnel.

Defaults live in `colab_launch.py` (`DEFAULTS`), so the notebook itself never has
to change when your Drive layout does. The steps below are that same path by hand,
plus what `video_editor_colab.ipynb` adds: the in-cell widget editor, manual
Patreon/YouTube renders and the fallbacks.

```python
# Cell 1 — install (run once per session)
!pip install -q numpy opencv-python mediapipe openai-whisper ffmpeg-python moviepy pydub ipywidgets

# Cell 2 — mount Drive
from google.colab import drive
drive.mount('/content/drive')

# Cell 3 — import
import sys
sys.path.insert(0, '/content/VideoEditorTool/colab_version')
from video_processor import ReactionVideoProcessor

proc = ReactionVideoProcessor(
    "/content/drive/MyDrive/raw/recording_3840.mp4",
    output_dir="/content/drive/MyDrive/reaction_output"
)

# Cell 4 — VISUAL EDITOR (tune everything with live preview)
from editor_gui import launch_editor
editor = launch_editor(proc)

# ...then render a sample from the GUI, watch it, then full render...
# ...or straight from code (picks up the editor's layout/drops/claims):
proc.run_patron_version()
proc.run_youtube_version()
```

The outputs will appear in `/content/drive/MyDrive/reaction_output/` as:
- `patreon_final.mp4` + `patreon_final.webm`
- `youtube_final.mp4` + `youtube_final.webm`
- `intro_transcript.json` (Whisper text for manual edit)
- `layout.json` (your saved look, if you save it from the GUI)

## Layout variations (for your future experiments)

In the editor's Layout tab, or from code:

```python
import layouts as L
proc.layout = L.apply_preset(proc.layout, "hero-circle")  # big circle face, blurred content
proc.layout = L.apply_preset(proc.layout, "hero-rect")    # large rounded face, blurred content
proc.layout = L.apply_preset(proc.layout, "tl-br-tight")  # small camera, bigger content
proc.show_preview(t=90)                                   # check it instantly
```

Old preset names (`diagonal`, `circle_blur`, `rect_blur`, `hero_circle`,
`hero_plus`, `news`) still work in `compose_reaction(preset=...)` and
`run_*_version(preset=...)` — they now map to real sized rects.

## Notes on fairness / ContentID

The request mentions cutting content to avoid ContentID strikes. This pipeline:
- Keeps **intro/outro uncut** (only your face — safe).
- Allows **manual / auto cut** of silent/repeated reaction segments so the video flows seamlessly.
- Applies **transformative edits** (layout, blur background, retouch, audio ducking) which are part of fair-use reaction commentary.
- Re-voices the **programme audio** on request (Cloak → Voice changer,
  target *Content*): a dubbed voice is a different signal, so the audio
  fingerprint of the show no longer matches. See "The voice changer
  re-voices the show, not you" above.
- Does **not** provide reverse-engineering of ContentID fingerprinting, and
  none of this is a claim that an upload becomes unmatchable: video
  fingerprinting, manual claims and the rights holder's own policies all
  still apply.

If you want full control, use the Cuts tab (silence detection + claim
ranges) or pass `custom_cuts=[(start, end), ...]` to `run_youtube_version()`.
