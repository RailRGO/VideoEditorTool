# Reaction Video Editor — Google Colab Adaptation

This folder (`colab_version/`) takes the best parts of **both repo variants**
(root original + "diffrent variant") and repackages them as a Python pipeline
that runs inside Google Colab instead of your old PC.

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

## Your specific fixes applied

- **Layout:** Default preset = `diagonal`. Camera is **top-left** (30%), content **bottom-right** (70%), both rounded rectangles (`radius=28`), background full 1920x1080 with blur 50% and opacity 40%.
- **Intro/Outro:** Uncut full camera (`intro_mode=True`). Middle reaction = layout.
- **React lead-in:** You asked for 1-3 sec before layout switch (e.g., "let's go"). In `run_youtube_version` you can trim `intro_range` or manually insert a black content block; the pipeline supports adding a 2-second black overlay at the start of the reaction segment.
- **Cut disruptions:** `auto_cut_reaction()` parses `silencedetect` from ffmpeg; you can pass `custom_cuts=[(t1,t2),...]` if you already know the bad parts.
- **Face retouch:** Uses `mediapipe.solutions.face_mesh` (468 landmarks). The mask is rebuilt **every frame** from landmarks, so it never falls off when you turn your head.
- **Timeline height:** Increased to 240px (from 178px) so it doesn't sink.
- **Buttons:** Consistent `ring-white/10` hover states applied in CSS rules for both variants (see root `src/index.css` edits).

## Answers to your direct questions

**Q: Exported in WebM — will it upload to YouTube?**  
**A:** Yes. YouTube fully supports WebM (VP9 + Opus). We export both `final.mp4` (H.264) and `final.webm` (VP9/Opus). MP4 is the safer fallback if an editor rejects WebM, but YouTube accepts WebM directly.

**Q: Where is computing happening?**  
**A:** **Inside the Colab session** (your remote VM, not your old PC). If you select **GPU runtime** (Runtime → Change runtime type → GPU), face retouch and some filters will be faster, but most pipeline steps (ffmpeg, mediapipe) are CPU-bound and work fine on standard Colab CPU. Nothing runs on your local machine.

**Q: My videos are 20+ minutes and 3 GB — where does that process?**  
**A:** Temp folders (`/tmp` inside Colab) and Drive mounts. We never load a 3 GB file entirely into RAM; `ffmpeg` streams chunks, and the retouch loop reads frame-by-frame. After processing, outputs are written straight to Drive so they survive session end (Colab temp files are deleted when the session dies).

**Q: Can I upload from Drive and get output to Drive?**  
**A:** Yes — this is the intended workflow. Mount Drive, point `ReactionVideoProcessor` at `/content/drive/MyDrive/your_video.mp4`, and set `output_dir="/content/drive/MyDrive/output"`. The notebook writes results there immediately.

**Q: Session sometimes interrupts — can I resume?**  
**A:** The pipeline is stateless per run. If interrupted, just re-run the cell; `ffmpeg` will overwrite partial outputs. For very long videos you can also split at the source (e.g., process intro/outro/reaction as separate 5-minute chunks) and concatenate with `ffmpeg` at the end.

## Quick start in Colab

```python
# Cell 1 — install (run once per session)
!pip install -q numpy opencv-python mediapipe openai-whisper ffmpeg-python moviepy pydub

# Cell 2 — mount Drive
from google.colab import drive
drive.mount('/content/drive')

# Cell 3 — import and run
import sys, os
sys.path.insert(0, '/content/VideoEditorTool/colab_version')
from video_processor import ReactionVideoProcessor

proc = ReactionVideoProcessor(
    "/content/drive/MyDrive/raw/recording_3840.mp4",
    output_dir="/content/drive/MyDrive/reaction_output"
)

# Patreon (full, intro cleaned, audio mixed)
proc.run_patron_version(preset="diagonal", fix_intro=True, retouch=False)

# YouTube (reaction with cuts + retouch + alterations)
proc.run_youtube_version(preset="diagonal", auto_cut=True, retouch=True)
```

The outputs will appear in `/content/drive/MyDrive/reaction_output/` as:
- `patreon_final.mp4` + `patreon_final.webm`
- `youtube_final.mp4` + `youtube_final.webm`
- `intro_transcript.json` (Whisper text for manual edit)

## Layout variations (for your future experiments)

```python
# Circle face over fully blurred watch
proc.compose_reaction(..., preset="circle_blur")

# Big face + small content card
proc.compose_reaction(..., preset="hero_plus")

# News inset (camera top-right)
proc.compose_reaction(..., preset="news")
```

These match the presets in both source versions (`defaults.ts` / `components/Inspector.tsx`).

## Notes on fairness / ContentID

The request mentions cutting content to avoid ContentID strikes. This pipeline:
- Keeps **intro/outro uncut** (only your face — safe).
- Allows **manual / auto cut** of silent/repeated reaction segments so the video flows seamlessly.
- Applies **transformative edits** (layout, blur background, retouch, audio ducking) which are part of fair-use reaction commentary.
- Does **not** provide reverse-engineering of ContentID fingerprinting.

If you want full control, use the `auto_cut_reaction()` return value to build your own EDL, or edit `custom_cuts=[(start,end), ...]` in `run_youtube_version()`.
