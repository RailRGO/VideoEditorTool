"""
Reaction Video Processor — Google Colab / Local Python
================================================================
Combines best of both repo variants, now with a WYSIWYG pipeline:

* Layouts are shared with the browser editor (see layouts.py) — the same
  normalised rects, shapes, radius, borders, background plate.
* compose.py renders frames with the exact same math as render.ts, so the
  GUI preview and the final file are pixel-identical. This also fixes the
  old bug where the camera was overlaid at full resolution and covered
  the content.
* Audio (compressor / limiter / ducking) is conformed to the SAME segment
  map as the video, so cuts never desync A/V.

Quick start in Colab (see README + notebook):
  from video_processor import ReactionVideoProcessor
  proc = ReactionVideoProcessor("/content/drive/MyDrive/raw/recording.mp4",
                                output_dir="/content/drive/MyDrive/output")
  proc.preview(t=30, mode="body")          # numpy frame, WYSIWYG
  proc.run_patron_version()                # full uncut + cleaned intro/outro
  proc.run_youtube_version(auto_cut=True)  # cut-down reaction version

Interactive visual editing (recommended):
  from editor_gui import launch_editor
  editor = launch_editor(proc)   # sliders + live preview + sample renders
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import layouts as L
    import compose as C
except ImportError:  # package-style import
    from . import layouts as L
    from . import compose as C

try:
    import whisper
except ImportError:
    whisper = None
try:
    import mediapipe as mp
except ImportError:
    mp = None

OUTPUT_W, OUTPUT_H = 1920, 1080

# Old preset names still accepted -> mapped to real layouts (see layouts.py).
PRESETS = {
    "diagonal": "tl-br",
    "circle_blur": "hero-circle",
    "rect_blur": "hero-rect",
    "hero_circle": "hero-circle",
    "hero_plus": "hero-rect",
    "news": "news",
}


def _run(cmd, check=True):
    """Run once, return combined output (old helper ran the command twice)."""
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if check and p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, cmd, p.stdout, p.stderr)
    return (p.stdout or "") + (p.stderr or "")


def _has(cmd: str) -> bool:
    return shutil.which(cmd) is not None


# ===========================================================================
class ReactionVideoProcessor:
    def __init__(self, input_path, work_dir=None, output_dir=None,
                 layout: Optional[L.LayoutState] = None):
        self.input = Path(input_path)
        if not self.input.exists():
            raise FileNotFoundError(str(self.input))
        self.work = Path(work_dir) if work_dir else Path(tempfile.mkdtemp(prefix="react_"))
        self.work.mkdir(parents=True, exist_ok=True)
        self.out = Path(output_dir) if output_dir else self.work / "output"
        self.out.mkdir(parents=True, exist_ok=True)

        self.info = C.probe_video(str(self.input))
        self.is_side_by_side = self.info["width"] >= 3000 and self.info["height"] >= 900
        self.layout: L.LayoutState = layout or L.old_preset_to_layout("diagonal")
        self.layout.sourceMode = "split" if self.is_side_by_side else "single"
        self.audio_cfg: Dict[str, Any] = L.default_audio()
        self.retouch_cfg: Dict[str, Any] = L.default_retouch()
        self.cuts_cfg: Dict[str, Any] = L.default_cuts()

        self.cam_path = self.work / "cam.mp4"
        self.content_path = self.work / "content.mp4"
        self._mesh = None  # lazy mediapipe FaceMesh

        print(f"Loaded: {self.input.name}  "
              f"{self.info['width']}x{self.info['height']} @ "
              f"{self.info['fps']:.1f}fps, {self.info['duration']:.1f}s  "
              f"({'split 3840' if self.is_side_by_side else 'single 16:9'})")

    # ------------------------------------------------------------------ io
    @property
    def duration(self) -> float:
        return float(self.info.get("duration") or 0.0)

    def set_layout(self, layout: L.LayoutState) -> None:
        self.layout = layout

    def save_layout(self, path=None) -> str:
        return self.layout.save(path or (self.out / "layout.json"))

    def load_layout(self, path) -> L.LayoutState:
        self.layout = L.LayoutState.from_json(path)
        return self.layout

    # ------------------------------------------------------------- preview
    def preview_frame(self, t: Optional[float] = None, mode: str = "body",
                      width: int = 960,
                      layout: Optional[L.LayoutState] = None) -> np.ndarray:
        """One composed frame (BGR) — identical math to the final render."""
        layout = layout or self.layout
        if t is None:
            t = min(30.0, self.duration / 2 or 5.0)
        hook = self._cam_hook() if self.retouch_cfg.get("enabled") else None
        fr = C.preview(str(self.input), t, layout, mode=mode, width=width,
                       cam_hook=hook)
        if fr is None:
            raise RuntimeError("could not extract a frame (file unreadable?)")
        return fr

    def preview_jpeg(self, t=None, mode="body", width=960,
                     layout=None, quality=75) -> bytes:
        return C.to_jpeg(self.preview_frame(t, mode, width, layout),
                         quality=quality)

    def show_preview(self, t=None, mode="body", width=960, layout=None):
        """Display the preview inline in a notebook (no widgets needed)."""
        from IPython.display import Image, display
        display(Image(data=self.preview_jpeg(t, mode, width, layout)))

    def contact_sheet(self, times=(5, 30, 120, 300), mode="body", width=480,
                      layout=None) -> np.ndarray:
        """Grid of previews at several timestamps — check a look quickly."""
        import cv2
        layout = layout or self.layout
        hook = self._cam_hook() if self.retouch_cfg.get("enabled") else None
        tiles = []
        for t in times:
            fr = C.preview(str(self.input), min(t, max(0, self.duration - 1)),
                           layout, mode=mode, width=width, cam_hook=hook)
            if fr is None:
                continue
            cv2.putText(fr, f"{t:.0f}s", (10, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
            tiles.append(fr)
        if not tiles:
            raise RuntimeError("no frames extracted")
        cols = 2
        rows = (len(tiles) + cols - 1) // cols
        h, w = tiles[0].shape[:2]
        sheet = np.zeros((rows * h, cols * w, 3), np.uint8)
        for i, tl in enumerate(tiles):
            sheet[(i // cols) * h:(i // cols) * h + h,
                  (i % cols) * w:(i % cols) * w + w] = tl
        return sheet

    # ------------------------------------------------------- source split
    def _detect_side_by_side(self) -> bool:
        return self.is_side_by_side

    def split_input(self):
        """Split 3840x1080 into cam/content halves (kept for compatibility).

        The render path no longer needs this — compose works on halves in
        memory — but it is still handy for standalone retouch/analysis.
        """
        if not _has("ffmpeg"):
            raise RuntimeError("ffmpeg not found (needed for split_input)")
        if self.is_side_by_side:
            _run(["ffmpeg", "-y", "-i", str(self.input), "-filter_complex",
                  "[0:v]crop=w=1920:h=1080:x=0:y=0[cam];"
                  "[0:v]crop=w=1920:h=1080:x=1920:y=0[content]",
                  "-map", "[cam]", "-c:v", "libx264", "-preset", "fast",
                  "-crf", "18", str(self.cam_path),
                  "-map", "[content]", "-c:v", "libx264", "-preset", "fast",
                  "-crf", "18", str(self.content_path)], check=False)
        else:
            shutil.copy(str(self.input), str(self.cam_path))
            shutil.copy(str(self.input), str(self.content_path))
        return str(self.cam_path), str(self.content_path)

    # -------------------------------------------------------------- compose
    def compose_reaction(self, cam_path=None, content_path=None,
                         output_path=None, preset="diagonal",
                         intro_mode=False,
                         layout: Optional[L.LayoutState] = None,
                         segments: Optional[List[Dict[str, Any]]] = None,
                         crf: int = 18) -> str:
        """Render composited VIDEO (no audio) through the WYSIWYG compositor.

        Backward-compatible signature: old calls with preset= / intro_mode=
        keep working, but now honour real rects/sizes instead of overlaying
        full-resolution halves.
        """
        layout = layout or (L.old_preset_to_layout(preset) if preset else self.layout)
        layout.sourceMode = "split" if self.is_side_by_side else "single"
        if segments is None:
            if intro_mode:
                segments = [{"type": "intro", "start": 0.0, "end": self.duration}]
            else:
                segments = [{"type": "body", "start": 0.0, "end": self.duration}]
        out = Path(output_path) if output_path else self.work / "reaction_video.mp4"
        hook = self._cam_hook() if self.retouch_cfg.get("enabled") else None

        def cb(done, total):
            if done == total or done % 600 == 0:
                print(f"  compose {done}/{total} frames ({done / total * 100:.0f}%)")

        res = C.render_video(str(self.input), str(out), layout=layout,
                             segments=segments, crf=crf, progress_cb=cb,
                             cam_hook=hook)
        print(f"Composed {res['frames']} frames -> {out}")
        return str(out)

    # ---------------------------------------------------------------- audio
    def mix_audio(self, input_path=None, mic_channel=0, content_channel=1,
                  output_path=None, compressor=True, limiter=True, duck=True,
                  segments: Optional[List[Dict[str, Any]]] = None,
                  fast_speed: float = 4.0) -> str:
        """Mix mic + content buses, conformed to the same segment map as video.

        *segments*: cut spans are dropped, fast spans get atempo, mute spans
        silence the CONTENT bus only (your mic stays). When None, the whole
        file is mixed (legacy behaviour).
        """
        if not _has("ffmpeg"):
            raise RuntimeError("ffmpeg not found (needed for mix_audio)")
        src = input_path or str(self.input)
        dst = Path(output_path) if output_path else self.out / "mixed_audio.wav"
        cfg = self.audio_cfg
        if isinstance(mic_channel, str):
            mic_channel = 0 if mic_channel == "left" else 1
        if isinstance(content_channel, str):
            content_channel = 0 if content_channel == "left" else 1

        mic_wav = self.work / "mic.wav"
        content_wav = self.work / "content.wav"
        _run(["ffmpeg", "-y", "-i", src,
              "-map_channel", f"0.1.{mic_channel}", "-c:a", "pcm_s16le", str(mic_wav),
              "-map_channel", f"0.1.{content_channel}", "-c:a", "pcm_s16le", str(content_wav)],
             check=False)

        mic_proc = self.work / "mic_proc.wav"
        parts = []
        if compressor and cfg.get("comp_on", True):
            parts.append(
                f"acompressor=threshold={cfg.get('comp_threshold', -24)}dB:"
                f"ratio={cfg.get('comp_ratio', 4)}:attack=12:release=180:"
                f"makeup={cfg.get('comp_makeup', 4)}")
        if cfg.get("mic_gain_db"):
            parts.append(f"volume={float(cfg['mic_gain_db']):.1f}dB")
        if limiter:
            parts.append(f"alimiter=limit={cfg.get('limiter_db', -1.2)}dB:attack=5:release=50")
        if parts:
            _run(["ffmpeg", "-y", "-i", str(mic_wav), "-af", ",".join(parts),
                  str(mic_proc)], check=False)
        else:
            shutil.copy(str(mic_wav), str(mic_proc))

        content_proc = self.work / "content_proc.wav"
        if duck and cfg.get("duck_on", True):
            _run(["ffmpeg", "-y", "-i", str(content_wav), "-i", str(mic_proc),
                  "-filter_complex",
                  f"[1:a]asplit[sc][mix];[0:a][sc]sidechaincompress="
                  f"threshold={cfg.get('duck_threshold', -32)}dB:ratio=4:"
                  f"level={cfg.get('duck_depth', 12)}:attack=0.06:release=0.42[aout]",
                  "-map", "[aout]", "-c:a", "pcm_s16le", str(content_proc)], check=False)
        else:
            shutil.copy(str(content_wav), str(content_proc))
        if cfg.get("content_gain_db"):
            tmp = self.work / "content_g.wav"
            _run(["ffmpeg", "-y", "-i", str(content_proc), "-af",
                  f"volume={float(cfg['content_gain_db']):.1f}dB", str(tmp)], check=False)
            tmp.replace(content_proc)

        mic_final = self._conform_bus(mic_proc, segments, fast_speed, mute_to_zero=False,
                                      tag="mic")
        content_final = self._conform_bus(content_proc, segments, fast_speed,
                                          mute_to_zero=True, tag="content")
        _run(["ffmpeg", "-y", "-i", str(mic_final), "-i", str(content_final),
              "-filter_complex", "amix=inputs=2:duration=longest:dropout_transition=0.2[out]",
              "-map", "[out]", "-c:a", "pcm_s16le", str(dst)], check=False)
        print(f"Mixed audio -> {dst}")
        return str(dst)

    def _conform_bus(self, wav: Path, segments, fast_speed, mute_to_zero, tag) -> Path:
        """Cut/drop/speed one audio bus identically to the video timeline."""
        if not segments:
            return wav
        kept = [s for s in segments if s.get("type") != "cut"]
        if not kept:
            raise ValueError("all segments are cut — nothing to mix")
        # single untouched span -> no work (unless it is a mute on content)
        if len(kept) == 1 and kept[0].get("type") not in ("fast", "mute"):
            if not (mute_to_zero and kept[0].get("type") == "mute"):
                return wav
        n = len(kept)
        outs, chain = [], []
        chain.append(f"[0:a]asplit={n}" + "".join(f"[s{i}]" for i in range(n)))
        for i, s in enumerate(kept):
            f = [f"atrim=start={s['start']:.3f}:end={s['end']:.3f}",
                 "asetpts=PTS-STARTPTS"]
            if s.get("type") == "fast":
                f.append(f"atempo={float(fast_speed):.3f}")
            if mute_to_zero and s.get("type") == "mute":
                f.append("volume=0")
            outs.append(f"[b{i}]")
            chain.append(f"[s{i}]{','.join(f)}[b{i}]")
        chain.append(f"{''.join(outs)}concat=n={n}:v=0:a=1[out]")
        out = self.work / f"{tag}_conform.wav"
        _run(["ffmpeg", "-y", "-i", str(wav), "-filter_complex", ";".join(chain),
              "-map", "[out]", "-c:a", "pcm_s16le", str(out)], check=False)
        return out

    # ------------------------------------------------------------ mux/export
    def mux(self, video_path, audio_path, out_mp4, webm=True) -> Dict[str, str]:
        if not _has("ffmpeg"):
            print("ffmpeg missing — keeping silent video only.")
            return {"mp4": str(video_path)}
        out_mp4 = Path(out_mp4)
        _run(["ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_path),
              "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
              str(out_mp4)], check=False)
        result = {"mp4": str(out_mp4)}
        if webm:
            wb = out_mp4.with_suffix(".webm")
            _run(["ffmpeg", "-y", "-i", str(out_mp4), "-c:v", "libvpx-vp9",
                  "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "5",
                  "-c:a", "libopus", "-b:a", "128k", str(wb)], check=False)
            result["webm"] = str(wb)
        return result

    # --------------------------------------------------------------- retouch
    def _mesh_get(self):
        if mp is None:
            raise ImportError("mediapipe not installed (pip install mediapipe)")
        if self._mesh is None:
            self._mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False, max_num_faces=1, refine_landmarks=True,
                min_detection_confidence=0.5, min_tracking_confidence=0.5)
        return self._mesh

    @staticmethod
    def apply_retouch_frame(frame_bgr: np.ndarray, mesh,
                            smooth=35.0, teeth=40.0, eyes=35.0) -> np.ndarray:
        """Retouch one BGR frame in place-ish (mask rebuilt every frame)."""
        import cv2
        frame = frame_bgr
        h, w = frame.shape[:2]
        try:
            res = mesh.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        except Exception:
            return frame
        if not res.multi_face_landmarks:
            return frame
        lm = res.multi_face_landmarks[0].landmark
        xs = [p.x * w for p in lm]
        ys = [p.y * h for p in lm]
        x1, y1 = max(0, int(min(xs))), max(0, int(min(ys)))
        x2, y2 = min(w - 1, int(max(xs))), min(h - 1, int(max(ys)))
        if smooth > 0 and x2 > x1 and y2 > y1:
            roi = frame[y1:y2, x1:x2]
            if roi.size > 0:
                k = max(5, int(smooth) // 3 * 2 + 1)
                frame[y1:y2, x1:x2] = cv2.bilateralFilter(
                    roi, k, smooth * 2, smooth)
        if eyes > 0:
            try:
                s = 1.0 + (eyes / 100.0) * 0.45
                for idx in (33, 362):
                    cx, cy = int(lm[idx].x * w), int(lm[idx].y * h)
                    half = 26
                    ex1, ey1 = max(0, cx - half), max(0, cy - half)
                    ex2, ey2 = min(w, cx + half), min(h, cy + half)
                    eye = frame[ey1:ey2, ex1:ex2]
                    if eye.size == 0:
                        continue
                    big = cv2.resize(eye, (max(1, int(eye.shape[1] * s)),
                                           max(1, int(eye.shape[0] * s))),
                                     interpolation=cv2.INTER_CUBIC)
                    bh = min(ey2 - ey1, big.shape[0])
                    bw = min(ex2 - ex1, big.shape[1])
                    frame[ey1:ey1 + bh, ex1:ex1 + bw] = big[:bh, :bw]
            except Exception:
                pass
        if teeth > 0:
            try:
                pts = [(int(lm[i].x * w), int(lm[i].y * h))
                       for i in (61, 291, 200, 0, 17, 403, 167)]
                mx1 = max(0, min(p[0] for p in pts))
                mx2 = min(w - 1, max(p[0] for p in pts))
                my1 = max(0, min(p[1] for p in pts))
                my2 = min(h - 1, max(p[1] for p in pts))
                mouth = frame[my1:my2, mx1:mx2]
                if mouth.size > 0:
                    hsv = cv2.cvtColor(mouth, cv2.COLOR_BGR2HSV)
                    hsv[:, :, 2] = np.clip(
                        hsv[:, :, 2].astype(np.int16) + teeth * 3, 0, 255).astype(np.uint8)
                    hsv[:, :, 1] = np.clip(
                        hsv[:, :, 1].astype(np.int16) - teeth * 2, 0, 255).astype(np.uint8)
                    white = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
                    b = float(teeth) / 100.0
                    frame[my1:my2, mx1:mx2] = (
                        (1 - b) * frame[my1:my2, mx1:mx2].astype(np.float32) +
                        b * white.astype(np.float32)).astype(np.uint8)
            except Exception:
                pass
        return frame

    def _cam_hook(self):
        """Build the per-frame camera hook used by preview AND render."""
        cfg = self.retouch_cfg
        if not cfg.get("enabled"):
            return None
        mesh = self._mesh_get()
        smooth, teeth, eyes = cfg.get("smooth", 35), cfg.get("teeth", 40), cfg.get("eyes", 35)

        def hook(cam_img: np.ndarray) -> np.ndarray:
            return self.apply_retouch_frame(cam_img.copy(), mesh, smooth, teeth, eyes)

        return hook

    def retouch_video(self, input_path=None, output_path=None,
                      smooth=30, teeth=30, nose=30, eyes=30):
        """Standalone whole-file retouch (kept for compatibility)."""
        import cv2
        if mp is None:
            raise ImportError("mediapipe required (pip install mediapipe)")
        src = str(input_path or self.input)
        dst = str(output_path or (self.out / "retouched.mp4"))
        mesh = self._mesh_get()
        cap = cv2.VideoCapture(src)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        vw = cv2.VideoWriter(dst, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        i = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            vw.write(self.apply_retouch_frame(frame, mesh, smooth, teeth, eyes))
            i += 1
            if i % 200 == 0:
                print(f"  retouch frame {i}")
        cap.release()
        vw.release()
        print(f"Retouch -> {dst}")
        return dst

    # -------------------------------------------------------- silence / cuts
    def auto_cut_reaction(self, input_path=None, silence_db=-40.0,
                          min_silence_sec=2.0):
        """Return [(keep_start, keep_end)] after dropping silent spans."""
        if not _has("ffmpeg"):
            raise RuntimeError("ffmpeg not found (needed for auto_cut)")
        src = str(input_path or self.input)
        out = _run(["ffmpeg", "-i", src, "-af",
                    f"silencedetect=noise={silence_db}dB:d={min_silence_sec}",
                    "-f", "null", "-"], check=False)
        starts, ends = [], []
        for line in out.splitlines():
            if "silence_start:" in line:
                try:
                    starts.append(float(line.split("silence_start:")[1].split()[0]))
                except ValueError:
                    pass
            elif "silence_end:" in line:
                try:
                    ends.append(float(line.split("silence_end:")[1].split()[0]))
                except ValueError:
                    pass
        try:
            total = float(_run(["ffprobe", "-v", "error", "-show_entries",
                                "format=duration", "-of", "csv=p=0", src]).strip() or 0)
        except Exception:
            total = self.duration
        keep, last = [], 0.0
        for s, e in zip(starts, ends):
            if s > last + 0.5:
                keep.append((last, s))
            last = max(last, e)
        if last < total - 0.5:
            keep.append((last, total))
        print(f"Auto-cut: {len(starts)} silence regions, {len(keep)} keep segments.")
        return keep

    @staticmethod
    def keeps_to_drops(keep, total):
        drops, last = [], 0.0
        for s, e in sorted(keep):
            if s > last + 1e-3:
                drops.append((last, s))
            last = max(last, e)
        if last < total - 1e-3:
            drops.append((last, total))
        return drops

    def detect_content_start(self, threshold_db=-35.0, min_len=1.0,
                             window=(0, 300)) -> Optional[float]:
        """First sustained content-bus energy — i.e. where the reaction starts."""
        if not _has("ffmpeg"):
            return None
        tmp = self.work / "content_scan.wav"
        _run(["ffmpeg", "-y", "-ss", str(window[0]), "-t",
              str(window[1] - window[0]), "-i", str(self.input),
              "-map_channel", "0.1.1", "-c:a", "pcm_s16le", str(tmp)], check=False)
        out = _run(["ffmpeg", "-i", str(tmp), "-af",
                    f"silencedetect=noise={threshold_db}dB:d={min_len}",
                    "-f", "null", "-"], check=False)
        first_end = None
        for line in out.splitlines():
            if "silence_end:" in line:
                try:
                    first_end = float(line.split("silence_end:")[1].split()[0])
                    break
                except ValueError:
                    pass
        if first_end is None:
            return None
        return window[0] + first_end

    # ------------------------------------------------------------- transcript
    def fix_transcript_intro_outro(self, input_path=None,
                                   intro_range=(0, 60), outro_range=(1200, 1260)):
        if whisper is None:
            raise ImportError("openai-whisper not installed")
        src = str(input_path or self.input)
        model = whisper.load_model("base")
        clip = self.work / "intro.wav"
        _run(["ffmpeg", "-y", "-ss", str(intro_range[0]), "-t",
              str(intro_range[1] - intro_range[0]), "-i", src, "-vn",
              "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(clip)],
             check=False)
        result = model.transcribe(str(clip), language="en", word_timestamps=True)
        out = self.out / "intro_transcript.json"
        out.write_text(json.dumps(result, indent=2))
        print("Intro transcript saved to", out)
        return str(out)

    # ------------------------------------------------- segment map + render
    def build_timeline(self, intro_end=None, outro_start=None,
                       drops=None, claims=None,
                       lead_in=None, black=None) -> List[Dict[str, Any]]:
        c = self.cuts_cfg
        ie = self.duration if intro_end is None else intro_end
        if intro_end is None:
            ie = c.get("intro_end", 8.0)
        os_ = c.get("outro_start", -12.0) if outro_start is None else outro_start
        return C.build_segments(
            self.duration, intro_end=ie, outro_start=os_,
            drops=drops or [], claims=claims or list(c.get("claims", [])),
            lead_in=c.get("lead_in", 2.0) if lead_in is None else lead_in,
            black=c.get("black", 1.5) if black is None else black)

    def render_with_layout(self, name: str,
                           layout: Optional[L.LayoutState] = None,
                           segments: Optional[List[Dict[str, Any]]] = None,
                           crf: int = 18, webm: bool = True) -> Dict[str, str]:
        """Full render: composed video + conformed audio + mux (+ webm)."""
        layout = layout or self.layout
        segments = segments or self.build_timeline()
        print(f"Timeline: {len(segments)} segments, "
              f"render {C.render_duration(segments, layout.fastSpeed):.1f}s "
              f"(source {self.duration:.1f}s)")
        for s in segments:
            print(f"  {s['type']:6s} {s['start']:8.1f} -> {s['end']:8.1f}")

        video_nc = self.work / f"{name}_video.mp4"
        self.compose_reaction(output_path=str(video_nc), layout=layout,
                              segments=segments, crf=crf)
        audio = self.mix_audio(output_path=str(self.work / f"{name}_mix.wav"),
                               segments=segments, fast_speed=layout.fastSpeed)
        outs = self.mux(video_nc, audio, self.out / f"{name}.mp4", webm=webm)
        print("Done:")
        for k, v in outs.items():
            print(f"  {k}: {v}")
        return outs

    def render_sample(self, t_center: float, seconds: float = 10.0,
                      mode: str = "body",
                      layout: Optional[L.LayoutState] = None,
                      name: str = "sample") -> Dict[str, str]:
        """Render a short clip around *t_center* — the WYSIWYG proof.

        Uses the real pipeline (compose + mix + mux), so if the sample
        looks/sounds right, the full render will too.
        """
        layout = layout or self.layout
        t0 = max(0.0, t_center - seconds / 2)
        t1 = min(self.duration, t0 + seconds)
        seg_type = {"solo": "intro", "lead": "lead", "card": "card",
                    "fast": "fast"}.get(mode, "body")
        segments = [{"type": seg_type, "start": t0, "end": t1}]
        return self.render_with_layout(name, layout=layout, segments=segments,
                                       crf=20, webm=False)

    # ------------------------------------------------------- legacy runners
    def run_patron_version(self, intro_range=(0, 45), outro_range=(1250, 1290),
                           preset="diagonal", retouch=False, fix_intro=True,
                           layout: Optional[L.LayoutState] = None) -> str:
        """Full uncut reaction, intro/outro in full-cam, transcript for cleanup."""
        print("=== PATREON VERSION ===")
        layout = layout or (L.old_preset_to_layout(preset) if preset else self.layout)
        self.layout = layout
        if fix_intro:
            try:
                self.fix_transcript_intro_outro(intro_range=intro_range,
                                                outro_range=outro_range)
            except Exception as e:
                print(f"  (transcript skipped: {e})")
        if retouch:
            self.retouch_cfg["enabled"] = True
        segments = self.build_timeline(intro_end=intro_range[1],
                                       outro_start=outro_range[0] - self.duration
                                       if outro_range[0] > 0 else outro_range[0])
        outs = self.render_with_layout("patreon_final", layout=layout,
                                       segments=segments)
        return outs.get("mp4", "")

    def run_youtube_version(self, preset="diagonal", auto_cut=True, retouch=True,
                            intro_range=(0, 45), outro_range=(1250, 1290),
                            custom_cuts=None, claims=None,
                            layout: Optional[L.LayoutState] = None) -> str:
        """Cut-down reaction: silence drops + claims + retouch + layout."""
        print("=== YOUTUBE VERSION ===")
        layout = layout or (L.old_preset_to_layout(preset) if preset else self.layout)
        self.layout = layout
        drops: List[Tuple[float, float]] = list(custom_cuts or [])
        if auto_cut:
            keep = self.auto_cut_reaction(
                silence_db=self.cuts_cfg.get("silence_db", -40.0),
                min_silence_sec=self.cuts_cfg.get("min_silence", 2.0))
            # only cut silences inside the reaction body, never intro/outro
            ie, os_ = intro_range[1], min(outro_range[0], self.duration)
            for d in self.keeps_to_drops(keep, self.duration):
                s, e = max(d[0], ie), min(d[1], os_)
                if e - s > 0.3:
                    drops.append((s, e))
            print(f"  body drops from silence: {len(drops)}")
        if retouch:
            self.retouch_cfg["enabled"] = True
        segments = self.build_timeline(
            intro_end=intro_range[1],
            outro_start=outro_range[0] - self.duration if outro_range[0] > 0 else outro_range[0],
            drops=drops, claims=claims or [])
        outs = self.render_with_layout("youtube_final", layout=layout,
                                       segments=segments)
        return outs.get("mp4", "")
