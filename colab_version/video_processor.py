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
import re
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


_filter_cache: Dict[str, bool] = {}


def _ffmpeg_has_filter(name: str) -> bool:
    """True when this ffmpeg build ships *name* (cached per process)."""
    if name in _filter_cache:
        return _filter_cache[name]
    try:
        out = _run(["ffmpeg", "-hide_banner", "-filters"], check=False)
    except (OSError, subprocess.CalledProcessError):
        out = ""
    ok = any(
        line.strip().split()[1] == name
        for line in out.splitlines()
        if len(line.strip().split()) >= 2 and line.strip().split()[0].startswith(("T", "."))
    )
    # fallback: plain substring (covers wrapped/localised outputs)
    if not ok:
        ok = f" {name} " in out or f" {name}\n" in out
    _filter_cache[name] = ok
    return ok


def browser_audio_to_cfg(browser: Dict[str, Any]) -> Tuple[Dict[str, Any], float]:
    """Translate the React AudioState into flat mix_audio keys + master gain.

    Dropped on purpose (no offline equivalent wired): mic pan, comp
    knee/attack/release, duck attack/release/hold. Everything dropped is
    cosmetic next to threshold/ratio/depth.
    """
    mic = (browser or {}).get("mic", {})
    comp = mic.get("comp", {})
    content = (browser or {}).get("content", {})
    duck = content.get("duck", {})
    master = (browser or {}).get("master", {})
    cfg = {
        "mic_channel": mic.get("channel", "left"),
        "mic_gain_db": float(mic.get("gain", 0.0)),
        "comp_on": bool(comp.get("on", True)),
        "comp_threshold": float(comp.get("threshold", -24.0)),
        "comp_ratio": float(comp.get("ratio", 4.0)),
        "comp_makeup": float(comp.get("makeup", 4.0)),
        "limiter_db": float(mic.get("limiter", -1.2)),
        "content_gain_db": float(content.get("gain", -1.5)),
        "duck_on": bool(duck.get("on", True)),
        "duck_threshold": float(duck.get("threshold", -32.0)),
        "duck_depth": float(duck.get("depth", 12.0)),
    }
    return cfg, float(master.get("gain", 0.0))


def audio_cloak_chain(cfg: Optional[Dict[str, Any]], in_label: str,
                      out_label: str) -> Tuple[str, List[str]]:
    """ffmpeg filter_complex snippet: anti-fingerprint audio treatment.

    Tempo-preserving pitch (rubberband) -> chorus -> tilt EQ -> room echo ->
    Haas widening. Returns (snippet, warnings). Anull when disabled/empty.
    """
    c = cfg or {}
    if not c.get("on", False):
        return f"[{in_label}]anull[{out_label}]", []
    warnings: List[str] = []
    pitch = float(c.get("pitch", 0.0))
    chorus = float(c.get("chorus", 0.0))
    reverb = float(c.get("reverb", 0.0))
    tilt = float(c.get("tilt", 0.0))
    widen = float(c.get("widen", 0.0))

    cur = in_label
    parts: List[str] = []
    tag = [0]

    def nxt() -> str:
        tag[0] += 1
        return f"clk{tag[0]}"

    if abs(pitch) >= 0.05:
        if _ffmpeg_has_filter("rubberband"):
            ratio = 2.0 ** (pitch / 12.0)
            o = nxt()
            parts.append(f"[{cur}]rubberband=pitch={ratio:.5f}[{o}]")
            cur = o
        else:
            warnings.append("rubberband filter missing — pitch shift skipped")
    if chorus > 0.5:
        wet = min(0.9, (chorus / 100.0) * 0.45)
        a, b, ch, o = nxt(), nxt(), nxt(), nxt()
        parts.append(
            f"[{cur}]asplit[{a}][{b}];"
            f"[{b}]chorus=0.7:0.9:45|60:0.4|0.25:0.25|0.4:1.1|1.4[{ch}];"
            f"[{a}][{ch}]amix=inputs=2:duration=first:normalize=0:"
            f"weights=1 {wet:.3f}[{o}]"
        )
        cur = o
    if abs(tilt) >= 0.1:
        o = nxt()
        parts.append(
            f"[{cur}]bass=g={-tilt / 2.0:.2f}:f=400,"
            f"treble=g={tilt / 2.0:.2f}:f=2500[{o}]"
        )
        cur = o
    if reverb > 0.5:
        wet = min(0.9, (reverb / 100.0) * 0.35)
        a, b, ec, o = nxt(), nxt(), nxt(), nxt()
        parts.append(
            f"[{cur}]asplit[{a}][{b}];"
            f"[{b}]aecho=0.8:0.85:55|82|120:0.28|0.18|0.1[{ec}];"
            f"[{a}][{ec}]amix=inputs=2:duration=first:normalize=0:"
            f"weights=1 {wet:.3f}[{o}]"
        )
        cur = o
    if widen > 0.1:
        o = nxt()
        parts.append(f"[{cur}]adelay=0|{int(round(widen))}:all=1[{o}]")
        cur = o
    if cur == in_label:
        return f"[{in_label}]anull[{out_label}]", warnings
    parts.append(f"[{cur}]anull[{out_label}]")
    return ";".join(parts), warnings


def _video_cloak_filters(cfg: Optional[Dict[str, Any]], W: int, H: int) -> List[str]:
    """Raw vf list for the frame cloak (shared by snippet + per-segment use)."""
    c = cfg or {}
    if not c.get("on", False):
        return []
    zoom = max(1.0, min(1.2, float(c.get("zoom", 1.0))))
    bars = max(0.0, min(12.0, float(c.get("bars", 0.0))))
    border = max(0.0, min(24.0, float(c.get("border", 0.0))))
    border_color = str(c.get("borderColor", "#0ea5e9")).lstrip("#") or "0ea5e9"
    saturate = float(c.get("saturate", 100.0)) / 100.0
    contrast = float(c.get("contrast", 100.0)) / 100.0
    brightness = (float(c.get("brightness", 100.0)) - 100.0) / 100.0
    hue = float(c.get("hue", 0.0))
    grain = float(c.get("grain", 0.0))
    vignette = float(c.get("vignette", 0.0))

    f: List[str] = []
    if zoom > 1.001:
        f.append(f"scale=iw*{zoom:.4f}:-2:flags=lanczos")
        f.append(f"crop=trunc(iw/{zoom:.4f}/2)*2:trunc(ih/{zoom:.4f}/2)*2")
        f.append(f"scale={W}:{H}")
    if abs(saturate - 1.0) > 0.005 or abs(contrast - 1.0) > 0.005 \
            or abs(brightness) > 0.005:
        f.append(f"eq=saturation={saturate:.3f}:contrast={contrast:.3f}:"
                 f"brightness={brightness:.3f}")
    if abs(hue) > 0.5:
        f.append(f"hue=h={hue:.1f}")
    if grain > 0.5:
        f.append(f"noise=alls={min(30, grain / 100.0 * 14.0):.1f}:allf=t")
    if vignette > 0.5:
        angle = (3.14159 / 2.0) - (vignette / 100.0) * (3.14159 / 2.0 - 3.14159 / 7.0)
        f.append(f"vignette=a={angle:.4f}")
    if bars > 0.05:
        bh = max(1, int(round(H * bars / 100.0)))
        f.append(f"drawbox=y=0:w=iw:h={bh}:c=black:t=fill")
        f.append(f"drawbox=y=ih-{bh}:w=iw:h={bh}:c=black:t=fill")
    if border > 0.5:
        bw = max(1, int(round(border * H / 1080.0)))
        o = bw // 2
        f.append(f"drawbox=x={o}:y={o}:w=iw-{2 * o}:h=ih-{2 * o}:"
                 f"c=0x{border_color}:t={bw}")
    return f


def video_cloak_chain(cfg: Optional[Dict[str, Any]], in_label: str,
                      out_label: str, W: int, H: int) -> str:
    """ffmpeg filter_complex snippet: anti-fingerprint frame treatment.

    Punch-in zoom -> colour -> grain -> vignette -> cover bars -> frame.
    Null when disabled.
    """
    f = _video_cloak_filters(cfg, W, H)
    if not f:
        return f"[{in_label}]null[{out_label}]"
    return f"[{in_label}]{','.join(f)}[{out_label}]"


def _atempo_chain(factor: float) -> List[str]:
    """atempo only spans 0.5..2.0 — chain it for wider ranges."""
    factor = max(0.125, min(16.0, float(factor)))
    out: List[str] = []
    while factor > 2.0 + 1e-6:
        out.append("atempo=2.0")
        factor /= 2.0
    while factor < 0.5 - 1e-6:
        out.append("atempo=0.5")
        factor /= 0.5
    out.append(f"atempo={factor:.4f}")
    return out


def _drawtext_font(bold: bool = True) -> Optional[str]:
    """Find a DejaVu/Liberation TTF for drawtext (None = draw shapes only)."""
    names = (("DejaVuSans-Bold", "DejaVuSans") if bold
             else ("DejaVuSans", "LiberationSans-Regular"))
    roots = ["/usr/share/fonts", "/usr/local/share/fonts",
             str(Path.home() / ".fonts")]
    for root in roots:
        for name in names:
            for p in Path(root).rglob(f"{name}.ttf"):
                return str(p)
    return None


# ---------------------------------------------------------------------------
# browser-parity retouch (cf. src/lib/retouch.ts): skin / teeth / eye+nose warps
# MediaPipe FaceMesh (refine_landmarks=True) exposes the same 478-point
# topology as the browser FaceLandmarker, so the indices match one-to-one.
# ---------------------------------------------------------------------------

FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
]
INNER_LIP = [
    78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14,
    87, 178, 88, 95,
]
IRIS_R = 468
IRIS_L = 473
NOSE_TIP = 1


def _pose_from_landmarks(lm: np.ndarray, w: int, h: int) -> Dict[str, Any]:
    """lm: (478, 2) normalised -> pose in pixels (mirrors poseFromLandmarks)."""
    pts = lm[:, :2] * np.array([w, h], np.float32)
    oval = pts[FACE_OVAL]
    lip = pts[INNER_LIP]
    eye_l = pts[IRIS_L]
    eye_r = pts[IRIS_R]
    nose = pts[NOSE_TIP]
    span = float(np.linalg.norm(pts[263] - pts[33]))
    return {
        "oval": oval, "lip": lip, "eyeL": eye_l, "eyeR": eye_r, "nose": nose,
        "eyeRadius": max(6.0, span * 0.32),
        "noseRadius": max(8.0, span * 0.42),
        "box": (float(oval[:, 0].min()), float(oval[:, 1].min()),
                float(oval[:, 0].max()), float(oval[:, 1].max())),
    }


def _pose_from_box(box: Dict[str, Any], w: int, h: int) -> Dict[str, Any]:
    """Manual pose from a fractional face box (mirrors poseFromBox)."""
    x = float(box.get("x", 0.3)) * w
    y = float(box.get("y", 0.1)) * h
    bw = float(box.get("w", 0.4)) * w
    bh = float(box.get("h", 0.55)) * h
    a = np.linspace(0, 2 * np.pi, 36, endpoint=False)
    oval = np.stack([x + bw / 2 + np.cos(a) * bw / 2,
                     y + bh / 2 + np.sin(a) * bh / 2], axis=1)
    a2 = np.linspace(0, 2 * np.pi, 20, endpoint=False)
    lip = np.stack([x + bw / 2 + np.cos(a2) * bw * 0.4 / 2,
                    y + bh * 0.72 + np.sin(a2) * bh * 0.16 / 2], axis=1)
    span = bw * 0.72
    return {
        "oval": oval.astype(np.float32), "lip": lip.astype(np.float32),
        "eyeL": np.array([x + bw * 0.32, y + bh * 0.42], np.float32),
        "eyeR": np.array([x + bw * 0.68, y + bh * 0.42], np.float32),
        "nose": np.array([x + bw * 0.5, y + bh * 0.6], np.float32),
        "eyeRadius": max(6.0, span * 0.32),
        "noseRadius": max(8.0, span * 0.42),
        "box": (x, y, x + bw, y + bh),
    }


def _soft_poly_mask(h: int, w: int, pts: np.ndarray, feather_px: float) -> np.ndarray:
    import cv2
    mask = np.zeros((h, w), np.uint8)
    cv2.fillPoly(mask, [pts.astype(np.int32)], 255)
    if feather_px > 1.0:
        mask = cv2.GaussianBlur(mask, (0, 0), max(0.8, feather_px / 2.5))
    return mask.astype(np.float32) / 255.0


def _skin_selection_bgr(img: np.ndarray) -> np.ndarray:
    """Conservative skin-tone test (BGR) — keeps smoothing off hair/walls."""
    b = img[:, :, 0].astype(np.int16)
    g = img[:, :, 1].astype(np.int16)
    r = img[:, :, 2].astype(np.int16)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    return (r > 60) & (g > 30) & (b > 15) & ((mx - mn) > 12) & \
        (r > g + 8) & (r > b + 8)


def _retouch_skin(img: np.ndarray, pose: Dict[str, Any], amount: float,
                  detail: float, feather01: float) -> np.ndarray:
    """Edge-preserving smoothing: blurred copy blended through the oval mask,
    high-frequency detail partially re-added (hair/brows stay crisp)."""
    import cv2
    if amount <= 0:
        return img
    h, w = img.shape[:2]
    soft = max(2.0, feather01 * max(w, h) * 0.06)
    mask = _soft_poly_mask(h, w, pose["oval"], soft)
    x0, y0, x1, y1 = [int(v) for v in pose["box"]]
    x0, y0 = max(0, x0 - int(soft)), max(0, y0 - int(soft))
    x1, y1 = min(w, x1 + int(soft)), min(h, y1 + int(soft))
    if x1 <= x0 or y1 <= y0:
        return img
    small = cv2.resize(img, (max(4, w // 3), max(4, h // 3)),
                       interpolation=cv2.INTER_LINEAR)
    small = cv2.GaussianBlur(small, (0, 0), max(0.6, (amount / 100.0) * 2.4))
    blur = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    f = img.astype(np.float32)
    b = blur.astype(np.float32)
    target = b + (f - b) * min(1.0, detail / 100.0)
    a = (mask * min(1.0, amount / 100.0))[y0:y1, x0:x1]
    skin = _skin_selection_bgr(img)[y0:y1, x0:x1]
    a = np.where(skin, a, 0.0)[..., None]
    img[y0:y1, x0:x1] = (f[y0:y1, x0:x1] * (1 - a) + target[y0:y1, x0:x1] * a
                         ).astype(np.uint8)
    return img


def _retouch_teeth(img: np.ndarray, pose: Dict[str, Any], amount: float,
                   feather01: float) -> np.ndarray:
    """Whiten bright low-saturation pixels inside the inner-lip polygon."""
    import cv2
    if amount <= 0:
        return img
    h, w = img.shape[:2]
    soft = max(1.5, feather01 * 22.0)
    mask = _soft_poly_mask(h, w, pose["lip"], soft)
    f = img.astype(np.float32)
    b, g, r = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 1, (mx - mn) / np.maximum(mx, 1), 0)
    toothy = np.clip((lum - 55) / 90.0, 0, 1) * (1 - np.clip(sat / 0.42, 0, 1))
    a = mask * (amount / 100.0) * toothy
    tgt = np.clip(lum * 1.14 + 26, 0, 255)
    f[:, :, 0] += a * (tgt * 0.97 - b)
    f[:, :, 1] += a * (tgt * 0.995 - g)
    f[:, :, 2] += a * (tgt - r)
    return np.clip(f, 0, 255).astype(np.uint8)


def _radial_warp(img: np.ndarray, cx: float, cy: float, radius: float,
                 scale: float, feather01: float) -> np.ndarray:
    """Magnify (>1) or pinch (<1) around a point, cosine falloff, no seam."""
    import cv2
    if abs(scale - 1) < 0.005 or radius < 2:
        return img
    h, w = img.shape[:2]
    reach = radius * (1 + max(0.0, feather01) * 1.2)
    x0, x1 = max(0, int(cx - reach)), min(w, int(cx + reach) + 1)
    y0, y1 = max(0, int(cy - reach)), min(h, int(cy + reach) + 1)
    if x1 <= x0 or y1 <= y0:
        return img
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    t = np.ones_like(d)
    mid = (d > radius) & (d <= reach)
    t[mid] = np.cos((d[mid] - radius) / max(1e-6, reach - radius) * np.pi / 2)
    t[d > reach] = 0
    mag = np.maximum(1 + (scale - 1) * t, 1e-3)
    map_x = (cx + (xs - cx) / mag - x0).astype(np.float32)
    map_y = (cy + (ys - cy) / mag - y0).astype(np.float32)
    patch = img[y0:y1, x0:x1]
    warped = cv2.remap(patch, map_x, map_y, cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_REPLICATE)
    a = t[..., None]
    img[y0:y1, x0:x1] = (warped * a + patch * (1 - a)).astype(np.uint8)
    return img


def _apply_retouch_browser(img: np.ndarray, lm: Optional[np.ndarray],
                           cfg: Dict[str, Any],
                           manual_box: Dict[str, Any]) -> np.ndarray:
    """Full browser-parity stack on a BGR image. *lm* is (478, 2) normalised
    or None (manual mode derives the pose from the box instead)."""
    h, w = img.shape[:2]
    if cfg.get("manual"):
        pose = _pose_from_box(manual_box or {}, w, h)
    elif lm is not None and len(lm) >= 400:
        pose = _pose_from_landmarks(np.asarray(lm, np.float32), w, h)
    else:
        return img
    feather01 = float(cfg.get("feather", 45.0)) / 100.0
    img = _retouch_skin(img, pose, float(cfg.get("skin", 0.0)),
                        float(cfg.get("detail", 45.0)), feather01)
    img = _retouch_teeth(img, pose, float(cfg.get("teeth", 0.0)), feather01)
    eye = float(cfg.get("eyeScale", 0.0))
    if abs(eye) > 0.05:
        s = 1 + eye / 100.0
        for pt in (pose["eyeL"], pose["eyeR"]):
            img = _radial_warp(img, float(pt[0]), float(pt[1]),
                                 pose["eyeRadius"], s, feather01)
    nose = float(cfg.get("noseScale", 0.0))
    if abs(nose) > 0.05:
        img = _radial_warp(img, float(pose["nose"][0]), float(pose["nose"][1]),
                             pose["noseRadius"], 1 + nose / 100.0, feather01)
    return img


# ---------------------------------------------------------------------------
# speech-to-text backends (faster-whisper preferred, openai-whisper fallback)
# ---------------------------------------------------------------------------

_FW_MODELS: Dict[str, Any] = {}


def _pick_stt_backend() -> str:
    try:
        import faster_whisper  # noqa: F401
        return "faster-whisper"
    except ImportError:
        pass
    if whisper is not None:
        return "openai-whisper"
    raise ImportError("no speech engine installed "
                      "(pip install faster-whisper or openai-whisper)")


def _fw_model(name: str):
    if name not in _FW_MODELS:
        from faster_whisper import WhisperModel
        try:
            _FW_MODELS[name] = WhisperModel(name, device="auto")
        except Exception:
            _FW_MODELS[name] = WhisperModel(name, device="cpu",
                                            compute_type="int8")
    return _FW_MODELS[name]


def _stt_words(backend: str, model: str, wav: str,
               lang_arg: Optional[str]) -> Tuple[List[Tuple[float, float, str]],
                                                 Optional[str]]:
    """Transcribe one 16 kHz mono clip -> ([(start, end, text)], lang)."""
    out: List[Tuple[float, float, str]] = []
    if backend == "faster-whisper":
        segments, info = _fw_model(model).transcribe(
            wav, language=lang_arg, word_timestamps=True)
        for seg in segments:
            for w in getattr(seg, "words", None) or []:
                t = (w.word or "").strip()
                if t:
                    out.append((float(w.start), float(w.end), t))
        return out, getattr(info, "language", None)
    ow = whisper.load_model(model if model != "small" else "base")
    res = ow.transcribe(wav, language=lang_arg or None, word_timestamps=True)
    for seg in res.get("segments", []):
        for w in seg.get("words", []) or []:
            t = (w.get("word") or w.get("text") or "").strip()
            if t and w.get("start") is not None:
                out.append((float(w["start"]), float(w.get("end", w["start"])), t))
    return out, res.get("language")


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
        self._audio_cache: Dict[str, List[Dict[str, Any]]] = {}

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
            self._ff(["ffmpeg", "-y", "-i", str(self.input), "-filter_complex",
                      "[0:v]crop=w=1920:h=1080:x=0:y=0[cam];"
                      "[0:v]crop=w=1920:h=1080:x=1920:y=0[content]",
                      "-map", "[cam]", "-c:v", "libx264", "-preset", "fast",
                      "-crf", "18", str(self.cam_path),
                      "-map", "[content]", "-c:v", "libx264", "-preset", "fast",
                      "-crf", "18", str(self.content_path)], "input split")
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
                         crf: int = 18, fps: Optional[float] = None,
                         width: int = 1920, height: int = 1080) -> str:
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
                             cam_hook=hook, fps=fps, width=width, height=height)
        print(f"Composed {res['frames']} frames -> {out}")
        return str(out)

    # ---------------------------------------------------------------- audio
    def _probe_audio(self, src: str) -> List[Dict[str, Any]]:
        """List audio streams: [{index, channels}]. Cached per path.

        Uses ffprobe when present, otherwise parses `ffmpeg -i` (which every
        ffmpeg, including pip-bundled static builds, supports).
        """
        if src in self._audio_cache:
            return self._audio_cache[src]
        streams: List[Dict[str, Any]] = []
        if _has("ffprobe"):
            try:
                out = _run(["ffprobe", "-v", "error", "-select_streams", "a",
                            "-show_entries", "stream=index,channels",
                            "-of", "csv=p=0", src])
                for line in out.splitlines():
                    parts = line.strip().split(",")
                    if len(parts) >= 2:
                        streams.append({"index": int(parts[0]),
                                        "channels": int(parts[1])})
            except Exception:
                streams = []
        if not streams:
            out = _run(["ffmpeg", "-i", src], check=False)
            for line in out.splitlines():
                m = re.search(r"Stream #\d+:(\d+).*?Audio:", line)
                if not m:
                    continue
                ch = 2
                if ", mono," in line:
                    ch = 1
                else:
                    m2 = re.search(r", (\d+) channels,", line)
                    if m2:
                        ch = int(m2.group(1))
                streams.append({"index": int(m.group(1)), "channels": ch})
        self._audio_cache[src] = streams
        return streams

    def _resolve_bus(self, src: str, which: str,
                     override=None) -> Tuple[str, int]:
        """Resolve the mic/content bus to ('stream', i) or ('channel', n).

        Handles both OBS layouts: 2 audio tracks (2 streams) and 1 stereo
        track (mic=left, desktop=right). `override` accepts 0/1 or
        'left'/'right'; None falls back to audio_cfg for mic and to the
        *other* source for content.
        """
        streams = self._probe_audio(src)
        n_streams = len(streams)
        two_sources = n_streams >= 2 or (n_streams == 1 and
                                         streams[0]["channels"] >= 2)
        if override is None:
            if which == "mic":
                idx = 0 if self.audio_cfg.get("mic_channel", "left") == "left" else 1
            else:
                mic_idx = 0 if self.audio_cfg.get("mic_channel", "left") == "left" else 1
                idx = 1 - mic_idx
        elif isinstance(override, str):
            idx = 0 if override == "left" else 1
        else:
            idx = int(override)
        if not two_sources:
            idx = 0
        if n_streams >= 2:
            return ("stream", min(idx, n_streams - 1))
        return ("channel", min(idx, 1))

    def _extract_bus(self, src: str, out: Path, which: str,
                     override=None, ss: Optional[float] = None,
                     t: Optional[float] = None) -> Path:
        """Extract one bus (mic/content) as mono PCM. Raises on failure."""
        kind, idx = self._resolve_bus(src, which, override)
        cmd = ["ffmpeg", "-y"]
        if ss is not None:
            cmd += ["-ss", f"{ss:.2f}"]
        if t is not None:
            cmd += ["-t", f"{t:.2f}"]
        cmd += ["-i", src]
        if kind == "stream":
            cmd += ["-map", f"0:a:{idx}", "-ac", "1"]
        else:
            cmd += ["-map", "0:a:0", "-af", f"pan=mono|c0=c{idx}"]
        cmd += ["-c:a", "pcm_s16le", str(out)]
        p = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if p.returncode != 0 or not out.exists():
            tail = (p.stderr or "")[-800:]
            raise RuntimeError(f"{which} bus extraction failed "
                               f"({kind} {idx}):\n{tail}")
        return out

    def _media_duration(self, src: str) -> float:
        if _has("ffprobe"):
            try:
                return float(_run(["ffprobe", "-v", "error", "-show_entries",
                                   "format=duration", "-of", "csv=p=0",
                                   src]).strip() or 0)
            except Exception:
                pass
        out = _run(["ffmpeg", "-i", src], check=False)
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        return self.duration if str(src) == str(self.input) else 0.0

    def _ff(self, cmd, what: str):
        """Run ffmpeg, raising a readable error (with log tail) on failure."""
        p = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if p.returncode != 0:
            tail = (p.stderr or "")[-800:]
            raise RuntimeError(f"{what} failed:\n{tail}")
        return (p.stdout or "") + (p.stderr or "")

    def mix_audio(self, input_path=None, mic_channel=None, content_channel=None,
                  output_path=None, compressor=True, limiter=True, duck=True,
                  segments: Optional[List[Dict[str, Any]]] = None,
                  fast_speed: float = 4.0, mute_solo: bool = True,
                  master_gain_db: float = 0.0) -> str:
        """Mix mic + content buses, conformed to the same segment map as video.

        *segments*: cut spans are dropped, fast spans get atempo, mute/card
        spans silence the CONTENT bus only (your mic stays). When None, the
        whole file is mixed (legacy behaviour). *mute_solo* also silences the
        content bus during intro/outro (browser parity: muteContentInSolo).

        Works with both OBS audio layouts (2 tracks or 1 stereo track) and
        with ffmpeg 7+, where the old `-map_channel` option no longer exists.
        """
        if not _has("ffmpeg"):
            raise RuntimeError("ffmpeg not found (needed for mix_audio)")
        src = str(input_path or self.input)
        dst = Path(output_path) if output_path else self.out / "mixed_audio.wav"
        cfg = self.audio_cfg

        mic_wav = self.work / "mic.wav"
        content_wav = self.work / "content.wav"
        self._extract_bus(src, mic_wav, "mic", mic_channel)
        self._extract_bus(src, content_wav, "content", content_channel)

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
            self._ff(["ffmpeg", "-y", "-i", str(mic_wav), "-af", ",".join(parts),
                      str(mic_proc)], "mic processing")
        else:
            shutil.copy(str(mic_wav), str(mic_proc))

        content_proc = self.work / "content_proc.wav"
        if duck and cfg.get("duck_on", True):
            # sidechaincompress has no "level" knob; depth is driven by the
            # ratio (12 dB -> 4:1, 30 dB -> 10:1).
            depth = float(cfg.get("duck_depth", 12))
            ratio = min(20.0, max(1.5, depth / 3.0))
            self._ff(["ffmpeg", "-y", "-i", str(content_wav), "-i", str(mic_proc),
                      "-filter_complex",
                      f"[0:a][1:a]sidechaincompress="
                      f"threshold={cfg.get('duck_threshold', -32)}dB:ratio={ratio:.1f}:"
                      f"attack=0.06:release=0.42[aout]",
                      "-map", "[aout]", "-c:a", "pcm_s16le", str(content_proc)],
                     "content ducking")
        else:
            shutil.copy(str(content_wav), str(content_proc))
        if cfg.get("content_gain_db"):
            tmp = self.work / "content_g.wav"
            self._ff(["ffmpeg", "-y", "-i", str(content_proc), "-af",
                      f"volume={float(cfg['content_gain_db']):.1f}dB", str(tmp)],
                     "content gain")
            tmp.replace(content_proc)

        mic_final = self._conform_bus(mic_proc, segments, fast_speed, mute_to_zero=False,
                                      tag="mic")
        content_final = self._conform_bus(content_proc, segments, fast_speed,
                                          mute_to_zero=True, tag="content",
                                          mute_solo=mute_solo)
        self._ff(["ffmpeg", "-y", "-i", str(mic_final), "-i", str(content_final),
                  "-filter_complex",
                  "amix=inputs=2:duration=longest:dropout_transition=0.2[m];"
                  f"[m]aformat=channel_layouts=stereo,"
                  f"volume={float(master_gain_db):.1f}dB,"
                  "alimiter=limit=-1.5dB:attack=5:release=50[out]",
                  "-map", "[out]", "-c:a", "pcm_s16le", str(dst)], "final mix")
        print(f"Mixed audio -> {dst}")
        return str(dst)

    def _conform_bus(self, wav: Path, segments, fast_speed, mute_to_zero, tag,
                     mute_solo: bool = False) -> Path:
        """Cut/drop/speed one audio bus identically to the video timeline."""
        if not segments:
            return wav
        kept = [s for s in segments if s.get("type") != "cut"]
        if not kept:
            raise ValueError("all segments are cut — nothing to mix")
        mute_types = {"mute", "card"} | ({"intro", "outro"} if mute_solo else set())
        # single untouched span -> no work (unless it mutes this bus)
        if len(kept) == 1 and kept[0].get("type") not in ({"fast"} | mute_types):
            return wav
        n = len(kept)
        outs, chain = [], []
        chain.append(f"[0:a]asplit={n}" + "".join(f"[s{i}]" for i in range(n)))
        for i, s in enumerate(kept):
            f = [f"atrim=start={s['start']:.3f}:end={s['end']:.3f}",
                 "asetpts=PTS-STARTPTS"]
            if s.get("type") == "fast":
                f.append(f"atempo={float(fast_speed):.3f}")
            if mute_to_zero and s.get("type") in mute_types:
                f.append("volume=0")
            outs.append(f"[b{i}]")
            chain.append(f"[s{i}]{','.join(f)}[b{i}]")
        chain.append(f"{''.join(outs)}concat=n={n}:v=0:a=1[out]")
        out = self.work / f"{tag}_conform.wav"
        self._ff(["ffmpeg", "-y", "-i", str(wav), "-filter_complex", ";".join(chain),
                  "-map", "[out]", "-c:a", "pcm_s16le", str(out)],
                 f"{tag} timeline conform")
        return out

    # ------------------------------------------------------------ mux/export
    def mux(self, video_path, audio_path, out_mp4, webm=True) -> Dict[str, str]:
        if not _has("ffmpeg"):
            print("ffmpeg missing — keeping silent video only.")
            return {"mp4": str(video_path)}
        out_mp4 = Path(out_mp4)
        self._ff(["ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_path),
                  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                  str(out_mp4)], "mux")
        result = {"mp4": str(out_mp4)}
        if webm:
            wb = out_mp4.with_suffix(".webm")
            self._ff(["ffmpeg", "-y", "-i", str(out_mp4), "-c:v", "libvpx-vp9",
                      "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "5",
                      "-c:a", "libopus", "-b:a", "128k", str(wb)], "webm transcode")
            result["webm"] = str(wb)
        return result

    # ------------------------------------------- passthrough (YouTube) render
    def render_passthrough(
        self,
        segments: List[Dict[str, Any]],
        audio_cloak: Optional[Dict[str, Any]] = None,
        video_cloak: Optional[Dict[str, Any]] = None,
        card: Optional[Dict[str, Any]] = None,
        fast_speed: float = 4.0,
        master_gain_db: float = 0.0,
        crf: int = 18,
        preset: str = "fast",
        fps: Optional[float] = None,
        height: int = 0,
        name: str = "youtube_final",
        webm: bool = False,
        progress_cb=None,
    ) -> Dict[str, str]:
        """YouTube cut as ONE ffmpeg pass: no compositing, full-frame source.

        cuts are dropped, fast spans sped (atempo + setpts), mute/card spans
        silence the whole mixed programme, card spans get a full-frame card,
        everything else takes the cloak. A/V can never desync — both streams
        are conformed from the same segment list in one command.
        """
        if not _has("ffmpeg"):
            raise RuntimeError("ffmpeg not found (needed for render_passthrough)")
        kept = sorted(
            [s for s in (segments or []) if s.get("type") != "cut"],
            key=lambda s: s["start"],
        )
        if not kept:
            raise ValueError("nothing to render — all segments are cut?")
        W = int(self.info.get("width") or 1920)
        H = int(self.info.get("height") or 1080)
        total = C.render_duration(
            [{"type": s.get("type", "body"), "start": s["start"], "end": s["end"]}
             for s in kept],
            fast_speed,
        )

        n = len(kept)
        vparts: List[str] = [
            f"[0:v]split={n}" + "".join(f"[vin{i}]" for i in range(n))
        ]
        aparts: List[str] = [
            f"[0:a]asplit={n}" + "".join(f"[ain{i}]" for i in range(n))
        ]
        vouts, aouts = [], []
        cloak_vf = _video_cloak_filters(video_cloak, W, H)
        for i, s in enumerate(kept):
            typ = s.get("type", "body")
            a, b = float(s["start"]), float(s["end"])
            if typ == "fast":
                vf = f"trim=start={a:.3f}:end={b:.3f}," \
                     f"setpts=(PTS-STARTPTS)/{float(fast_speed):.4f}"
                af = f"atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS," \
                     + ",".join(_atempo_chain(fast_speed))
            else:
                vf = f"trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS"
                af = f"atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS"
            if typ in ("mute", "card"):
                af += ",volume=0"
            if typ == "card":
                # per-segment override; empty fields inherit the global card
                vf += "," + ",".join(
                    self._card_draws({**(card or {}), **(s.get("card") or {})},
                                     W, H, suffix=f"_{i}")
                )
            elif cloak_vf:
                vf += "," + ",".join(cloak_vf)
            vf += ",setsar=1"
            vparts.append(f"[vin{i}]{vf}[v{i}]")
            aparts.append(f"[ain{i}]{af}[a{i}]")
            vouts.append(f"[v{i}]")
            aouts.append(f"[a{i}]")
        vparts.append(f"{''.join(vouts)}concat=n={n}:v=1:a=0[vcat]")
        aouts_s = f"{''.join(aouts)}concat=n={n}:v=0:a=1[acat]"
        chain = vparts + aparts + [aouts_s]
        clk, cloak_warn = audio_cloak_chain(audio_cloak, "acat", "acl")
        chain.append(clk)
        for w in cloak_warn:
            print(f"  (cloak: {w})")
        chain.append(
            f"[acl]volume={float(master_gain_db):.1f}dB,"
            "alimiter=limit=-1.5dB:attack=5:release=50,"
            "aformat=channel_layouts=stereo[aout]"
        )
        vtail = "[vcat]"
        if fps:
            chain.append(f"[vcat]fps={float(fps):.3f}[vfps]")
            vtail = "[vfps]"
        if height and int(height) not in (0, H):
            chain.append(f"{vtail}scale=-2:{int(height)}[vout]")
        else:
            chain.append(f"{vtail}null[vout]")

        out = self.out / f"{name}.mp4"
        cmd = ["ffmpeg", "-y", "-v", "info", "-i", str(self.input),
               "-filter_complex", ";".join(chain),
               "-map", "[vout]", "-map", "[aout]",
               "-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)),
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", str(out)]
        p = subprocess.Popen(cmd, stderr=subprocess.STDOUT, stdout=subprocess.PIPE,
                             text=True, bufsize=1)
        assert p.stdout is not None
        tail: List[str] = []
        for line in p.stdout:
            tail.append(line)
            if len(tail) > 60:
                tail.pop(0)
            m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
            if m and progress_cb:
                t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                progress_cb(min(t, total), total)
        p.wait()
        if p.returncode != 0 or not out.exists():
            raise RuntimeError("passthrough render failed:\n" + "".join(tail)[-2000:])
        if progress_cb:
            progress_cb(total, total)
        result = {"mp4": str(out)}
        if webm:
            result["webm"] = self._to_webm(out)
        print(f"Passthrough {total:.1f}s -> {out}")
        return result

    def _card_draws(self, card: Dict[str, Any], W: int, H: int,
                    suffix: str = "") -> List[str]:
        """Full-frame placeholder card as drawbox/drawtext filters."""
        title = str(card.get("title", "Full uncut reaction on Patreon"))
        sub = str(card.get("sub", "link in the description"))
        accent = str(card.get("accent", "#e879f9")).lstrip("#") or "e879f9"
        x = int(round(W * 0.06))
        y = int(round(H * 0.16))
        cw = int(round(W * 0.88))
        ch = int(round(H * 0.68))
        draws = [f"drawbox=x={x}:y={y}:w={cw}:h={ch}:c=black@0.94:t=fill",
                 f"drawbox=x={x}:y={y}:w={cw}:h={ch}:c=0x{accent}80:t=2"]
        bar_h = max(2, int(round(4 * H / 1080)))
        draws.append(f"drawbox=x={x + int(cw * 0.16)}:y={y + int(ch * 0.34)}:"
                     f"w={int(cw * 0.68)}:h={bar_h}:c=0x{accent}:t=fill")
        font = _drawtext_font(bold=True)
        # static/minimal ffmpeg builds sometimes ship without drawtext —
        # the card still renders (shapes only) instead of failing the job
        if font and _ffmpeg_has_filter("drawtext") and (title.strip() or sub.strip()):
            tf = self.work / f"card_title{suffix}.txt"
            sf = self.work / f"card_sub{suffix}.txt"
            tf.write_text(title, encoding="utf-8")
            sf.write_text(sub, encoding="utf-8")
            fs = min(58 * H / 1080, cw * 0.072)
            fs2 = max(10, fs * 0.62)
            yt = y + int(ch * 0.47)
            ys = y + int(ch * 0.58)
            draws.append(
                f"drawtext=fontfile='{font}':textfile='{tf}':"
                f"fontsize={fs:.0f}:fontcolor=white:"
                f"x={x}+({cw}-text_w)/2:y={yt}-text_h/2")
            draws.append(
                f"drawtext=fontfile='{font}':textfile='{sf}':"
                f"fontsize={fs2:.0f}:fontcolor=0xE2E8F0:"
                f"x={x}+({cw}-text_w)/2:y={ys}-text_h/2")
        return draws

    def _to_webm(self, mp4: Path) -> str:
        wb = Path(mp4).with_suffix(".webm")
        self._ff(["ffmpeg", "-y", "-i", str(mp4), "-c:v", "libvpx-vp9",
                  "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "5",
                  "-c:a", "libopus", "-b:a", "128k", str(wb)], "webm transcode")
        return str(wb)

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
        """Build the per-frame camera hook used by preview AND render.

        Browser-style configs (skin/eyeScale/noseScale keys, sent by the new
        UI) take the browser-parity path; legacy configs (smooth/eyes) keep
        the original behaviour so the old GUIs are unaffected.
        """
        cfg = self.retouch_cfg or {}
        if not cfg.get("enabled"):
            return None
        if "skin" not in cfg and "eyeScale" not in cfg and "noseScale" not in cfg:
            mesh = self._mesh_get()
            smooth = cfg.get("smooth", 35)
            teeth = cfg.get("teeth", 40)
            eyes = cfg.get("eyes", 35)

            def legacy_hook(cam_img: np.ndarray) -> np.ndarray:
                return self.apply_retouch_frame(cam_img.copy(), mesh, smooth,
                                                teeth, eyes)

            return legacy_hook

        mesh = None if cfg.get("manual") else self._mesh_get()
        every = max(1, int(cfg.get("everyN", 1) or 1))
        box = cfg.get("manualRect") or {}
        state = {"n": 0, "lm": None}

        def hook(cam_img: np.ndarray) -> np.ndarray:
            import cv2
            img = cam_img.copy()
            lm = None
            if not cfg.get("manual"):
                state["n"] += 1
                if state["lm"] is None or (state["n"] - 1) % every == 0:
                    # detect on a small copy — much faster, same topology
                    h0, w0 = img.shape[:2]
                    sc = min(1.0, 640.0 / max(w0, h0))
                    small = (img if sc >= 1.0 else
                             cv2.resize(img, (int(w0 * sc), int(h0 * sc)),
                                        interpolation=cv2.INTER_LINEAR))
                    try:
                        res = mesh.process(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
                    except Exception:
                        res = None
                    fl = (res.multi_face_landmarks[0]
                          if res is not None and res.multi_face_landmarks else None)
                    if fl is not None and len(fl.landmark) >= 400:
                        state["lm"] = np.array([(p.x, p.y) for p in fl.landmark],
                                               np.float32)
                lm = state["lm"]
                if lm is None:
                    return img
            try:
                return _apply_retouch_browser(img, lm, cfg, box)
            except Exception:
                return img

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
        total = self._media_duration(src) or self.duration
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
        try:
            self._extract_bus(str(self.input), tmp, "content",
                              ss=window[0], t=window[1] - window[0])
        except RuntimeError:
            return None
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
    def transcribe_spans(self, spans: List[Dict[str, Any]], lang: str = "auto",
                         model: str = "small", bus: str = "mic",
                         progress_cb=None) -> Dict[str, Any]:
        """Speech-to-text with word timings over selected spans (intro/outro).

        faster-whisper is preferred (fast on GPU, good Russian), openai-whisper
        is the fallback. Each span is read from the *bus* (your mic by default,
        so content audio doesn't pollute the words) as 16 kHz mono. Returns
        {"words": [{start, end, text}], "lang": ...} with absolute source times.
        """
        clean = []
        for s in spans or []:
            a = max(0.0, float(s.get("start", 0.0)))
            b = min(self.duration, float(s.get("end", 0.0)))
            if b - a > 0.5:
                clean.append((a, b))
        if not clean:
            raise ValueError("no speech spans to transcribe")
        total = sum(b - a for a, b in clean)
        if total > 1800:
            raise ValueError(f"{total / 60:.0f} min of speech is too much — "
                             "transcribe the intro/outro only")
        lang_arg = None if str(lang or "auto").lower() in ("auto", "") else str(lang)
        backend = _pick_stt_backend()
        print(f"Transcribing {len(clean)} span(s), {total:.0f}s "
              f"({backend}, lang={lang_arg or 'auto'}) …")
        words: List[Dict[str, Any]] = []
        detected = lang_arg
        done = 0.0
        for i, (a, b) in enumerate(clean):
            wav = self.work / f"trx_{i}.wav"
            try:
                self._extract_bus(str(self.input), wav, bus, ss=a, t=b - a)
                # whisper wants 16 kHz mono — resample in place when needed
                tmp = self.work / f"trx_{i}_16k.wav"
                self._ff(["ffmpeg", "-y", "-i", str(wav), "-vn", "-ac", "1",
                          "-ar", "16000", "-c:a", "pcm_s16le", str(tmp)],
                         "transcript resample")
                tmp.replace(wav)
            except RuntimeError:
                # bus extraction failed (odd audio layout?) — plain mix fallback
                self._ff(["ffmpeg", "-y", "-ss", f"{a:.2f}", "-t", f"{b - a:.2f}",
                          "-i", str(self.input), "-vn", "-ac", "1", "-ar", "16000",
                          "-c:a", "pcm_s16le", str(wav)], "transcript clip")
            seg_words, seg_lang = _stt_words(backend, model, str(wav), lang_arg)
            for w in seg_words:
                words.append({"start": round(w[0] + a, 2),
                              "end": round(w[1] + a, 2), "text": w[2]})
            detected = detected or seg_lang
            done += b - a
            if progress_cb:
                progress_cb(done, total)
            try:
                wav.unlink()
            except OSError:
                pass
        words.sort(key=lambda w: w["start"])
        print(f"Transcribed {len(words)} words ({detected or 'unknown lang'}).")
        return {"words": words, "lang": detected or (lang_arg or "auto")}

    def fix_transcript_intro_outro(self, input_path=None,
                                   intro_range=(0, 60), outro_range=(1200, 1260)):
        if whisper is None:
            raise ImportError("openai-whisper not installed")
        src = str(input_path or self.input)
        model = whisper.load_model("base")
        clip = self.work / "intro.wav"
        self._ff(["ffmpeg", "-y", "-ss", str(intro_range[0]), "-t",
                  str(intro_range[1] - intro_range[0]), "-i", src, "-vn",
                  "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(clip)],
                 "transcript clip")
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
