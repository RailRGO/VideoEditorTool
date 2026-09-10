# Reaction Video Editor — Google Colab Adaptation

This folder (`colab_version/`) takes the best parts of **both repo variants**
(root original + "diffrent variant") and repackages them as a Python pipeline
that runs inside Google Colab instead of your old PC.

## Files

| File | What it is |
|---|---|
| `video_editor_colab.ipynb` | The notebook: install → Drive → **visual editor** → render |
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
- Does **not** provide reverse-engineering of ContentID fingerprinting.

If you want full control, use the Cuts tab (silence detection + claim
ranges) or pass `custom_cuts=[(start, end), ...]` to `run_youtube_version()`.
