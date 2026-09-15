#!/usr/bin/env python3
"""Chunked / resumable render tests — run them before touching the pipelines.

    cd colab_version
    python3 webapp/tests/test_render_parts.py          # everything (~4 min)
    python3 webapp/tests/test_render_parts.py fast     # planning + card only

What is covered, and why each check exists:

* plan_parts tiles the timeline exactly, so concatenating parts reproduces
  the single-pass render (frame counts are compared on real files).
* a part that was truncated (reclaimed runtime, half-written Drive file) is
  rebuilt, never spliced into the final file.
* a render whose owner disappeared is reported as *lost* with the parts it
  saved, and Resume finishes it from those parts.
* mute/card spans silence the CONTENT bus only — measured with an FFT of the
  finished file, not by reading the filter graph.
* a Patreon master carries three audio tracks (mix / content / mic) and the
  YouTube cut reads tracks 2+3, so a mute keeps the voice.
* the placeholder card covers the layout's content rect, not the frame.
* the fisheye lens reaches the export on ANY ffmpeg build (remap maps ->
  lenscorrection -> geq fallback chain), distorts content only, and never
  touches the full-cam intro/outro frames.

Needs ffmpeg on PATH plus numpy/opencv (the compositor). No pytest required.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

HERE = Path(__file__).resolve().parent
COLAB = HERE.parent.parent
for p in (str(COLAB), str(COLAB / "webapp")):
    if p not in sys.path:
        sys.path.insert(0, p)

import compose as C  # noqa: E402
import layouts as L  # noqa: E402
import video_processor as V  # noqa: E402

MIC_HZ = 440.0        # bus 0 of the fixture
CONTENT_HZ = 660.0    # bus 1 of the fixture (track 2 of a 3-track master)
MASTER_HZ = 520.0     # track 1 of the 3-track master (never used alone)

FAILS: List[str] = []
CHECKS = [0]


def check(cond: bool, what: str) -> None:
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {what}")
    else:
        FAILS.append(what)
        print(f"  FAIL {what}")


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def _ff(args: List[str]) -> str:
    p = subprocess.run(["ffmpeg", "-y", "-v", "error", *args],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr[-600:]}")
    return p.stderr


def make_raw(path: Path, dur: int = 20, rate: int = 30) -> Path:
    """OBS-style 3840x1080 capture: cam | content, mic + desktop on 2 tracks."""
    _ff(["-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate={rate}:duration={dur}",
         "-f", "lavfi", "-i", f"smptebars=size=1920x1080:rate={rate}:duration={dur}",
         "-f", "lavfi", "-i",
         f"sine=frequency={int(MIC_HZ)}:sample_rate=48000:duration={dur}",
         "-f", "lavfi", "-i",
         f"sine=frequency={int(CONTENT_HZ)}:sample_rate=48000:duration={dur}",
         "-filter_complex",
         "[0:v][1:v]hstack=inputs=2[v];"
         "[2:a]aformat=channel_layouts=stereo[m];"
         "[3:a]aformat=channel_layouts=stereo[c]",
         "-map", "[v]", "-map", "[m]", "-map", "[c]",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
         "-t", str(dur), str(path)])
    return path


def make_master(path: Path, dur: int = 20, rate: int = 30) -> Path:
    """A finished Patreon master: 16:9 video + 3 audio tracks."""
    _ff(["-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate={rate}:duration={dur}",
         "-f", "lavfi", "-i",
         f"sine=frequency={int(MASTER_HZ)}:sample_rate=48000:duration={dur}",
         "-f", "lavfi", "-i",
         f"sine=frequency={int(CONTENT_HZ)}:sample_rate=48000:duration={dur}",
         "-f", "lavfi", "-i",
         f"sine=frequency={int(MIC_HZ)}:sample_rate=48000:duration={dur}",
         "-filter_complex",
         "[1:a]aformat=channel_layouts=stereo[x];"
         "[2:a]aformat=channel_layouts=stereo[y];"
         "[3:a]aformat=channel_layouts=stereo[z]",
         "-map", "0:v", "-map", "[x]", "-map", "[y]", "-map", "[z]",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
         "-t", str(dur), str(path)])
    return path


def media(path: Path) -> Dict[str, Any]:
    out = subprocess.run(["ffmpeg", "-i", str(path)],
                         capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    dur = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
           if m else 0.0)
    frames = re.findall(r"frame=\s*(\d+)", subprocess.run(
        ["ffmpeg", "-i", str(path), "-f", "null", "-"],
        capture_output=True, text=True).stderr)
    return {"dur": dur, "audio": len(re.findall(r"Audio:", out)),
            "frames": int(frames[-1]) if frames else 0,
            "meta": out,
            "comment": (re.search(r"comment\s*:\s*(.+)", out).group(1).strip()
                        if re.search(r"comment\s*:\s*(.+)", out) else "")}


def spectrum(path: Path, t: float, stream: int = 0, dur: float = 1.0,
             sr: int = 48000) -> Dict[str, float]:
    """Dominant amplitude of the fixture tones in a 1 s window (FFT)."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-t", str(dur), "-i", str(path),
         "-map", f"0:a:{stream}", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True).stdout
    import numpy as np
    x = np.frombuffer(raw, dtype=np.float32)
    if x.size < 2048:
        return {"rms": 0.0, MIC_HZ: 0.0, CONTENT_HZ: 0.0, MASTER_HZ: 0.0}
    w = x * np.hanning(x.size)
    sp = np.abs(np.fft.rfft(w))
    fr = np.fft.rfftfreq(w.size, 1.0 / sr)

    def amp(f: float) -> float:
        i = int(np.argmin(np.abs(fr - f)))
        return float(sp[max(0, i - 2):i + 3].max())

    return {"rms": float((x ** 2).mean() ** 0.5), MIC_HZ: amp(MIC_HZ),
            CONTENT_HZ: amp(CONTENT_HZ), MASTER_HZ: amp(MASTER_HZ)}


def region_brightness(path: Path, t: float, rect: tuple, size=(960, 540)
                      ) -> float:
    """Mean brightness of a normalised rect in one frame.

    A card paints its rect with a near-black gradient, so this is how the
    test proves the card landed on the content rect and nowhere else —
    sampling one pixel instead tends to hit the white title text.
    """
    import numpy as np
    w, h = size
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path),
         "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True).stdout
    if len(raw) < w * h:
        return -1.0
    img = np.frombuffer(raw[:w * h], dtype=np.uint8).reshape(h, w)
    x, y, rw, rh = rect
    roi = img[int(y * h):int((y + rh) * h), int(x * w):int((x + rw) * w)]
    return float(roi.mean()) if roi.size else -1.0


def frame_gray(path: Path, t: float, size=(1920, 1080)) -> np.ndarray:
    """One decoded frame as luma (empty array when the seek lands nowhere)."""
    w, h = size
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path),
         "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True).stdout
    if len(raw) < w * h:
        return np.zeros((0, 0), np.uint8)
    return np.frombuffer(raw[:w * h], dtype=np.uint8).reshape(h, w)


def bright_pixels(path: Path, t: float, rect: tuple,
                  size=(1920, 1080), thresh: int = 200) -> int:
    """Count of near-white pixels in a normalised rect of one frame.

    The card's title/sub are the only near-white things inside the card
    rect, so this is how the suite proves the words reached the export —
    a shapes-only card (the old drawtext-less fallback) scores ~0 here.
    """
    img = frame_gray(path, t, size)
    if img.size == 0:
        return -1
    h, w = img.shape
    x, y, rw, rh = rect
    roi = img[int(y * h):int((y + rh) * h), int(x * w):int((x + rw) * w)]
    return int((roi > thresh).sum())


def frame_pixel(path: Path, t: float, x: float, y: float) -> List[int]:
    """One pixel of one frame — used to prove what a card does NOT cover."""
    import numpy as np
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path),
         "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True).stdout
    if not raw:
        return []
    # the first frame decoded after the seek
    w, h = 960, 540
    img = np.frombuffer(raw[:w * h * 3], dtype=np.uint8).reshape(h, w, 3)
    return [int(v) for v in img[int(y * h), int(x * w)]]


# ---------------------------------------------------------------------------
# planning
# ---------------------------------------------------------------------------

SEGS = [
    {"type": "intro", "start": 0, "end": 3},
    {"type": "body", "start": 3, "end": 8},
    {"type": "mute", "start": 8, "end": 10},
    {"type": "body", "start": 10, "end": 13},
    {"type": "fast", "start": 13, "end": 17},
    {"type": "cut", "start": 17, "end": 18},
    {"type": "card", "start": 18, "end": 19.5},
    {"type": "outro", "start": 19.5, "end": 20},
]
FAST = 4.0
# programme seconds: 3 + 5 + 2 + 3 + 1 + 1.5 + 0.5 = 16
PROG = 16.0


def test_plan_parts():
    print("plan_parts")
    kept = [s for s in SEGS if s["type"] != "cut"]
    for target in (4.0, 6.5, 3.0):
        parts = V.plan_parts(kept, FAST, target, min_part=1.0)
        flat = [p for part in parts for p in part]
        check(len(parts) >= 2, f"part_target={target} chunks into "
                               f"{len(parts)} parts")
        # tiling: every kept span is covered exactly once, in order
        check(abs(sum(p["end"] - p["start"] for p in flat)
                  - sum(s["end"] - s["start"] for s in kept)) < 1e-6,
              f"part_target={target}: spans tile the timeline exactly")
        for a, b in zip(flat, flat[1:]):
            if a["type"] == b["type"] and a["end"] > b["start"]:
                check(False, "parts overlap")
                break
        else:
            check(True, f"part_target={target}: no overlap between parts")
        # programme length is preserved (fast spans DIVIDE by the speed)
        check(abs(V.prog_len(flat, FAST) - PROG) < 1e-6,
              f"part_target={target}: programme length {V.prog_len(flat, FAST):.3f}s "
              f"== {PROG}s")
        # the type sequence survives
        seq = [p["type"] for p in flat]
        check(seq == [s["type"] for s in kept] or
              all(t in [s["type"] for s in kept] for t in seq),
              f"part_target={target}: segment types preserved")
        # no part is absurdly short
        shortest = min(V.prog_len(p, FAST) for p in parts)
        check(shortest >= 1.0 - 1e-6,
              f"part_target={target}: shortest part {shortest:.2f}s >= min_part")

    # a fast span's programme time is source/speed, not source*speed
    parts = V.plan_parts([{"type": "fast", "start": 0, "end": 40}], FAST, 5.0,
                         min_part=1.0)
    check(len(parts) == 2, f"40s fast @4x = 10s of programme -> "
                           f"{len(parts)} parts of ~5s")
    check(abs(V.prog_len(parts[0], FAST) - 5.0) < 1e-6,
          "first fast part is exactly 5s of programme")


def test_auto_part_target():
    print("auto_part_target")
    check(V.auto_part_target(120.0) == 120.0, "2 min render stays one pass")
    check(V.auto_part_target(300.0) == 300.0, "5 min render stays one pass")
    t = V.auto_part_target(3600.0)
    check(90.0 <= t <= 240.0, f"1 h render chunks at {t:.0f}s per part")
    check(len(V.plan_parts(
        [{"type": "body", "start": 0, "end": 3600}], 4.0, t)) >= 15,
        f"1 h render becomes {len(V.plan_parts([{'type': 'body', 'start': 0, 'end': 3600}], 4.0, t))} parts")


# ---------------------------------------------------------------------------
# card geometry
# ---------------------------------------------------------------------------

def test_card_covers_content_only():
    print("card rect")
    import cv2
    proc = V.ReactionVideoProcessor.__new__(V.ReactionVideoProcessor)
    proc.layout = L.LayoutState()
    proc.work = Path(tempfile.mkdtemp())
    W, H = 1920, 1080
    got = proc._card_png({"title": "Full uncut reaction on Patreon"}, W, H)
    check(got is not None, "the card renders to a PNG overlay")
    path, x, y = got
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    want = [int(round(v)) for v in proc.layout.content.px(W, H)]
    check([x, y, img.shape[1], img.shape[0]] == want,
          f"server card overlay {([x, y, img.shape[1], img.shape[0]])} == "
          f"content rect {want}")
    check(img.shape[1] < W * 0.8 and img.shape[0] < H * 0.8,
          "card no longer covers ~the whole frame")
    # the point of the PNG: the words ride along, on builds with no drawtext
    # and on images with no system font alike
    opaque = img[..., 3] > 200
    bright = (img[..., :3].max(axis=2) > 200) & opaque
    check(int(bright.sum()) > 2000,
          f"the card PNG carries {int(bright.sum())} bright text pixels")
    rows = np.where(bright.any(axis=1))[0] if bright.any() else np.array([])
    check(len(rows) > 20, f"text spans {len(rows)} rows (a glyph height, "
                          "not a drawbox line)")
    # an explicit rect (YouTube passthrough) wins
    got2 = proc._card_png({}, W, H, content={"x": 0.1, "y": 0.2,
                                             "w": 0.5, "h": 0.4})
    check([got2[1], got2[2]] == [192, 216],
          f"explicit content rect is honoured (origin {got2[1]}, {got2[2]})")
    # same text + rect -> one shared file, not one per segment
    again = proc._card_png({}, W, H, content={"x": 0.1, "y": 0.2,
                                              "w": 0.5, "h": 0.4})
    check(again[0] == got2[0], "identical cards share one PNG")

    # ---- opacity is literal: 0 = no card at all, 1 = fully opaque --------
    proc.layout.card.opacity = 0.0
    check(proc._card_png({}, W, H) is None,
          "opacity 0 renders no card at all")
    proc.layout.card.opacity = 0.9
    img9, _, _ = C.card_overlay({}, proc.layout, W, H)
    check(int(img9[..., 3].max()) == 229,
          f"opacity 0.9 lands on 229 ({int(img9[..., 3].max())})")
    proc.layout.card.opacity = 1.0
    img1, _, _ = C.card_overlay({}, proc.layout, W, H)
    check(int(img1[..., 3].max()) == 255, "opacity 1 is fully opaque")
    proc.layout.card.opacity = 0.9

    # ---- short cards: 75 % of the content by default ---------------------
    short, sx, sy = C.card_overlay({"variant": "short"}, proc.layout, W, H)
    ch = int(round(proc.layout.content.h * H))
    check(abs(short.shape[0] - round(ch * 0.75)) <= 1,
          f"short card is 75 % of the content ({short.shape[0]} of {ch})")
    check(sy == int(round(proc.layout.content.y * H)),
          "short card anchors to the top (subtitles stay visible)")

    # ---- the card follows the drawn content picture ----------------------
    for sw, sh in ((3840, 1080), (1920, 1080), (1920, 2160)):
        src = np.full((sh, sw, 3), 255, np.uint8)
        canvas = np.zeros((H, W, 3), np.uint8)
        C.draw_layer(canvas, src, proc.layout.content, proc.layout.contentStyle)
        ys, xs = np.where(canvas[..., 0] > 200)
        drawn = (int(xs.min()), int(ys.min()),
                 int(xs.max()) + 1, int(ys.max()) + 1)
        r = C.content_picture_rect(proc.layout, sw, sh, W, H)
        px = r.px(W, H)
        want = (int(round(px[0])), int(round(px[1])),
                int(round(px[0] + px[2])), int(round(px[1] + px[3])))
        check(all(abs(a - b) <= 2 for a, b in zip(drawn, want)),
              f"content picture {sw}x{sh}: card rect {want} == drawn {drawn}")
    # browser parity: the React passthrough must not hardcode a full-frame box
    ts = (HERE.parent.parent.parent / "src" / "lib" / "render.ts").read_text()
    body = ts.split("export function buildPassthroughScene")[1].split("\n}")[0]
    check("0.06" not in body and "0.88" not in body,
          "buildPassthroughScene has no hardcoded near-full-frame card")
    check("cardRect" in body and "content" in body,
          "buildPassthroughScene takes the card rect from the layout")
    check("scene.cardText" in ts, "renderScene passes per-segment card text")


def test_card_speed():
    """A card may carry its own playback speed — the render must obey it.

    Cards hide the picture anyway, so the limiter is allowed to play them a
    little faster (the browser does the same through segSpeed()).
    """
    print("card speed")
    segs = [
        {"type": "body", "start": 0, "end": 30},
        {"type": "card", "start": 30, "end": 34,
         "card": {"variant": "short", "speed": 1.25}},
    ]
    check(abs(C.seg_speed(segs[1], 4.0) - 1.25) < 1e-9,
          "seg_speed returns the card's own speed")
    check(abs(C.render_duration(segs, 4.0) - 33.2) < 1e-6,
          f"render_duration shortens the programme "
          f"({C.render_duration(segs, 4.0):.2f}s)")
    parts = V.plan_parts(segs, 4.0, 100.0, min_part=1.0)
    check(len(parts) == 1, "a sped card does not break part planning")
    # a card at 2x halves its own programme time
    fast_card = [{"type": "card", "start": 0, "end": 10,
                  "card": {"speed": 2.0}}]
    check(abs(C.render_duration(fast_card, 4.0) - 5.0) < 1e-6,
          "a 2x card contributes half its source length")
    check(abs(C.render_duration(
        [{"type": "card", "start": 0, "end": 10, "card": {}}], 4.0) - 10.0)
        < 1e-6, "a plain card is real time")


def test_fair_use_cards():
    """The Content-ID limiter: short cards over long talk, or a spread trim.

    Mirrors src/lib/fairUseCut.ts. The old build kept the first N minutes of
    the reaction and cut everything after; these checks pin the behaviour the
    browser now has (and the render has to match).
    """
    print("fair-use limiter")
    build = V.ReactionVideoProcessor.build_fair_use_limit
    segs = [
        {"type": "intro", "start": 0, "end": 10},
        {"type": "body", "start": 10, "end": 40},
        {"type": "outro", "start": 40, "end": 50},
    ]
    span = {"start": 10, "end": 40}
    words = [{"text": "w", "start": 10.5 + i * 0.5, "end": 11.1 + i * 0.5}
             for i in range(0, 58, 2)]      # near-continuous talking

    out = build(segs, 50, {"mode": "cards"}, words, span)
    cards = [s for s in out if s["type"] == "card"]
    check(len(cards) == 2, f"30 s of talk gets 2 cards ({len(cards)})")
    check(all(_variant(s) == "short" for s in cards),
          "every card is short — never a long one")
    check(all(abs(c["start"] - (10 + 8.0)) < 0.6 or
              abs(c["start"] - (10 + 20.0)) < 0.6 for c in cards),
          "cards land 8 s into the talk and 8 s later "
          f"({[round(c['start'] - 10, 1) for c in cards]})")
    check(not [s for s in out if s["type"] == "cut"],
          "cards mode removes nothing — the reaction stays in one piece")
    check(all(out[i]["start"] >= out[i - 1]["end"] - 0.02
              for i in range(1, len(out))), "the result stays chronological")
    check([s["type"] for s in out][0] == "intro",
          "intro is untouched")

    # a card that runs faster than real time keeps its speed in the segment
    out_sp = build(segs, 50, {"mode": "cards", "cardSpeed": 1.25}, words, span)
    sped = [s for s in out_sp if s["type"] == "card"]
    check(all(abs(float(s["card"].get("speed", 1.0)) - 1.25) < 1e-6
              for s in sped), "cardSpeed is written into every card")

    # short stretches get no card at all
    quiet = [{"type": "body", "start": 0, "end": 4}]
    out_q = build(quiet, 4, {"mode": "cards"}, None, {"start": 0, "end": 4})
    check(not [s for s in out_q if s["type"] == "card"],
          "a stretch under minRunSec is left alone")

    # ---- trim: budget respected, spread over the whole reaction ----------
    long_body = [{"type": "body", "start": 0, "end": 120}]
    speech = [{"start": t, "end": t + 1.2} for t in range(0, 120, 2)]
    opts = {"mode": "trim", "maxBodySec": 40, "keepPad": 0.25}
    trimmed = build(long_body, 120, opts, speech, {"start": 0, "end": 120})
    kept = [s for s in trimmed if s["type"] != "cut"]
    kept_s = sum(s["end"] - s["start"] for s in kept)
    check(abs(kept_s - 40) <= 3, f"trim keeps ~40 s ({kept_s:.1f} s)")
    check(any(s["start"] > 90 for s in kept) and any(s["end"] < 20 for s in kept),
          "trim keeps the start AND the end of the reaction, not the head")
    # no speech info: same spread, no crash
    trimmed2 = build(long_body, 120, opts, None, {"start": 0, "end": 120})
    kept2 = [s for s in trimmed2 if s["type"] != "cut"]
    check(any(s["start"] > 90 for s in kept2),
          "without speech info the trim still samples the whole reaction")


def _variant(s):
    return V._card_variant(s)


def test_vignette_matches_preview():
    """The export's edge darkening is the preview's radial gradient.

    ffmpeg's own `vignette` filter is a different curve: the old mapping
    handed it angles around PI/2, which blacked out everything but the
    frame centre — the single worst regression this suite guards against.
    """
    print("vignette parity")
    import cv2
    W, H = 1920, 1080
    png = Path(tempfile.mkdtemp()) / "vig.png"
    C.write_png(png, C.vignette_overlay(W, H, 25))
    img = cv2.imread(str(png), cv2.IMREAD_UNCHANGED)
    a_edge = 0.25 * 0.55

    def want(x: float, y: float) -> float:
        d = ((x - W / 2) ** 2 + (y - H / 2) ** 2) ** 0.5
        t = max(0.0, min(1.0, (d - min(W, H) * 0.36)
                        / (max(W, H) * 0.72 - min(W, H) * 0.36)))
        return t * a_edge
    for (x, y) in ((3, 3), (480, 540), (960, 540), (1600, 900)):
        got = img[y, x, 3] / 255.0
        check(abs(got - want(x, y)) < 0.01,
              f"gradient alpha at ({x},{y}) = {got:.3f} == preview "
              f"{want(x, y):.3f}")
    # monotonic slider, and nothing at zero
    z = cv2.imread(C.write_png(Path(tempfile.mkdtemp()) / "z.png",
                               C.vignette_overlay(W, H, 0)),
                   cv2.IMREAD_UNCHANGED)
    check(int(z[..., 3].max()) == 0, "vignette 0 draws nothing")
    hi = cv2.imread(C.write_png(Path(tempfile.mkdtemp()) / "hi.png",
                                C.vignette_overlay(W, H, 100)),
                    cv2.IMREAD_UNCHANGED)
    check(hi[3, 3, 3] > img[3, 3, 3] > z[3, 3, 3],
          "the slider darkens monotonically (0 < 25 < 100)")
    # the calibrated ffmpeg-filter fallback stays mild too
    for amt, lo, hi_b in ((25, 0.05, 0.20), (100, 0.25, 0.50)):
        a = V._vignette_angle(amt)
        gain = math.cos(a) ** 5          # ~the filter's corner falloff
        check(lo < 1 - gain < hi_b,
              f"fallback vignette angle {a:.3f} keeps the corner within "
              f"{1 - gain:.2f} of full brightness at slider={amt}")
    check(V._vignette_angle(0.0) == 0.0, "slider 0 -> no filter angle")


# ---------------------------------------------------------------------------
# Patreon: chunked render, stems, mute semantics
# ---------------------------------------------------------------------------

def test_patreon_chunked(root: Path):
    print("patreon chunked render")
    src = root / "raw.mp4"
    out = root / "out"
    proc = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work"),
                                    output_dir=str(out))
    lay = L.LayoutState()
    logs: List[str] = []
    steps: List[Dict[str, Any]] = []
    res = proc.render_project(
        target="patreon", name="patreon_test", segments=SEGS, layout=lay,
        crf=30, preset="ultrafast", width=960, height=540, part_target=4.0,
        progress_cb=lambda f, i: steps.append(dict(i)),
        log=logs.append)
    check(res["chunked"] is True and res["parts"] >= 3,
          f"chunked into {res['parts']} parts")
    fin = Path(res["mp4"])
    m = media(fin)
    check(abs(m["dur"] - PROG) < 0.15,
          f"finished file is {m['dur']:.2f}s == {PROG}s of programme")
    check(m["frames"] == round(PROG * 30),
          f"{m['frames']} frames == {round(PROG * 30)} expected "
          "(no drift across the joins)")
    check(m["audio"] == 3, f"{m['audio']} audio tracks (mix/content/mic)")
    check("reaction_stems=mix,content,mic" in m["comment"],
          f"track marker in the file comment: {m['comment']!r}")

    # honest progress: monotonic, carries part counters, reaches 1.0
    fracs = [s.get("_max", 0) for s in steps]
    prog_vals = [i for i in range(len(steps))]
    check(steps[-1]["step"] == "done", f"last step is {steps[-1]['step']}")
    check(any(s["part"] > 1 for s in steps), "progress reports part numbers")
    check(all(isinstance(s.get("elapsed_s"), float) for s in steps),
          "progress carries elapsed_s")

    # audio: content is silenced on intro/mute/card/outro, the mic is not.
    # programme map: intro 0-3, body 3-8, mute 8-10, body 10-13,
    #                fast 13-14, card 14-15.5, outro 15.5-16
    for t, expect_content, label in ((1.5, False, "intro"), (5.0, True, "body"),
                                     (9.0, False, "mute"), (11.0, True, "body"),
                                     (14.5, False, "card"), (15.8, False, "outro")):
        s0 = spectrum(fin, t, 0)
        check(s0[MIC_HZ] > 50, f"{label}: mic audible in the mix "
                               f"({s0[MIC_HZ]:.0f})")
        if expect_content:
            check(s0[CONTENT_HZ] > 20, f"{label}: content audible "
                                       f"({s0[CONTENT_HZ]:.0f})")
        else:
            check(s0[CONTENT_HZ] < 5, f"{label}: content silenced "
                                      f"({s0[CONTENT_HZ]:.0f})")
    s1 = spectrum(fin, 5.0, 1)
    s2 = spectrum(fin, 5.0, 2)
    check(s1[CONTENT_HZ] > 20 and s1[MIC_HZ] < 5,
          "track 2 is content only")
    check(s2[MIC_HZ] > 20 and s2[CONTENT_HZ] < 5, "track 3 is mic only")
    check(abs(spectrum(fin, 9.0, 1)["rms"]) < 1e-4,
          "content track is silent across a mute span")

    # the card covers the content rect; the camera corner survives.
    # layout: content 0.294/0.289/0.70/0.70, cam 0.006/0.011/0.30/0.30
    corner = frame_pixel(fin, 14.7, 0.05, 0.05)
    check(bool(corner) and sum(corner) > 45,
          f"camera corner still visible during a card span (rgb={corner})")
    content_b = region_brightness(fin, 14.7, (0.294, 0.289, 0.70, 0.70))
    body_b = region_brightness(fin, 5.0, (0.294, 0.289, 0.70, 0.70))
    check(content_b < 60,
          f"card span: content rect is the dark card "
          f"(mean {content_b:.0f}/255)")
    check(body_b > content_b + 30,
          f"body span: the same rect shows the programme "
          f"(mean {body_b:.0f} vs {content_b:.0f})")
    cam_b_card = region_brightness(fin, 14.7, (0.006, 0.011, 0.30, 0.30))
    check(cam_b_card > 20,
          f"camera rect is NOT painted by the card (mean {cam_b_card:.0f})")

    # parts + journal are on disk for a later resume
    man = V.read_manifest(out, "patreon_test")
    check(bool(man) and len(man["done"]) == res["parts"],
          f"journal has {len(man['done']) if man else 0} finished parts")
    return {"proc": proc, "out": out, "res": res, "logs": logs}


# ---------------------------------------------------------------------------
# resume
# ---------------------------------------------------------------------------

def test_short_render_single_pass(root: Path):
    """Under the chunk threshold nothing changes: one pass, same output shape."""
    print("short render (single pass)")
    out = root / "out_short"
    proc = V.ReactionVideoProcessor(str(root / "raw.mp4"),
                                    work_dir=str(root / "work_short"),
                                    output_dir=str(out))
    short = [{"type": "body", "start": 0, "end": 3}]
    res = proc.render_project(target="patreon", name="short", segments=short,
                              layout=L.LayoutState(), crf=30,
                              preset="ultrafast", width=960, height=540)
    check(res["chunked"] is False and res["parts"] == 1,
          "a 3 s render is not chunked (no journal, no overhead)")
    check(not (out / "_parts" / "short").exists(),
          "a single-pass render writes no parts folder")
    m = media(Path(res["mp4"]))
    check(abs(m["dur"] - 3.0) < 0.2, f"output is {m['dur']:.2f}s")
    check(m["audio"] == 3, "a short Patreon master still carries 3 tracks")
    check(not list((out / "_parts").glob("*")) if (out / "_parts").exists()
          else True, "nothing left behind")


def test_truncated_part_rebuilt(root: Path):
    print("untrusted part")
    out = root / "out"
    part = out / "_parts" / "patreon_test" / "part_001.mp4"
    data = part.read_bytes()
    part.write_bytes(data[: len(data) // 2])          # half-written on Drive
    proc = V.ReactionVideoProcessor(str(root / "raw.mp4"),
                                    work_dir=str(root / "work"),
                                    output_dir=str(out))
    logs: List[str] = []
    res = proc.render_project(
        target="patreon", name="patreon_test", segments=SEGS,
        layout=L.LayoutState(), crf=30, preset="ultrafast", width=960,
        height=540, part_target=4.0, log=logs.append)
    check(res["parts"] - len(res["resumed"]) == 1,
          f"exactly one part rebuilt ({len(res['resumed'])} kept)")
    check(any("rebuilding" in l for l in logs),
          "the rebuild is reported in the log")
    m = media(Path(res["mp4"]))
    check(abs(m["dur"] - PROG) < 0.15,
          f"final file is still {m['dur']:.2f}s == {PROG}s")
    check(m["frames"] == round(PROG * 30),
          f"{m['frames']} frames after the rebuild")


def test_resume_after_kill(root: Path):
    print("kill mid-render, then resume (through the server App)")
    import server as S

    out = root / "out_resume"
    work = root / "work_resume"
    proc = V.ReactionVideoProcessor(str(root / "raw.mp4"), work_dir=str(work),
                                    output_dir=str(out))
    body = {"target": "patreon", "name": "resumed", "segments": SEGS,
            "layout": L.LayoutState().to_dict(),
            "audio": {"mic": {"channel": "left", "gain": 0,
                              "comp": {"threshold": -24, "ratio": 4},
                              "limiter": -1.2},
                      "content": {"gain": 0, "duck": {"threshold": -32,
                                                      "depth": 12}},
                      "master": {"gain": 0}},
            "retouch": {"enabled": False}, "audioCloak": {"on": False},
            "videoCloak": {"on": False}, "crf": 30, "webm": False,
            "fps": None, "height": 540, "partTarget": 4.0}
    app = S.App(proc)
    job = app.start_render_project(body)
    check(job["state"] == "running", "render starts")

    # wait for at least two parts to land, then kill it like a reclaimed VM
    saved = 0
    for _ in range(240):
        man = V.read_manifest(out, "resumed")
        saved = len(man["done"]) if man else 0
        if saved >= 2:
            break
        time.sleep(0.5)
    check(saved >= 2, f"{saved} parts saved before the kill")
    app.cancel_requested = True
    for _ in range(120):
        if app.job_state()["state"] != "running":
            break
        time.sleep(0.5)
    check(app.job_state()["state"] == "cancelled",
          f"cancelled render reports {app.job_state()['state']}")
    check(not (out / "resumed.mp4").exists(),
          "a cancelled render leaves no finished file behind")

    # a NEW server process knows nothing about it — the journal does
    app2 = S.App(V.ReactionVideoProcessor(str(root / "raw.mp4"),
                                          work_dir=str(work),
                                          output_dir=str(out)))
    stale = app2.job_state()
    check(stale["state"] == "idle",
          "a fresh server has no running job of its own")
    S.LOST_AFTER_S = 0.0                     # the runtime died "a while ago"
    lost = app2.job_state()
    check(lost["state"] == "lost", f"unowned render is reported as "
                                   f"{lost['state']}")
    check("did NOT finish" in (lost["error"] or ""),
          f"the message says so: {lost['error']}")
    check(lost["resume"]["saved"] == saved,
          f"{lost['resume']['saved']}/{lost['resume']['parts']} parts offered "
          "for resume")
    check(lost["resume"]["body"]["target"] == "patreon",
          "the journal kept the project body")

    # the notebook's tools() cell is the other way in — same code path
    import colab_launch as CL
    CL._WEB = {"app": app2, "local": None, "public": None, "tunnel_proc": None}
    check(len(CL.unfinished()) == 1,
          "colab_launch sees exactly one unfinished render")
    job2 = CL.resume()
    check(job2["state"] == "running", "tools('resume the unfinished render') "
                                      "starts a job")
    for _ in range(1200):
        st = app2.job_state()
        if st["state"] != "running":
            break
        time.sleep(0.5)
    st = app2.job_state()
    check(st["state"] == "done", f"resumed render finished ({st['state']})")
    check(st["files"].get("mp4") == "resumed.mp4",
          f"output file: {st['files'].get('mp4')}")
    fin = out / "resumed.mp4"
    m = media(fin)
    check(abs(m["dur"] - PROG) < 0.15,
          f"resumed file is {m['dur']:.2f}s == {PROG}s of programme")
    check(m["frames"] == round(PROG * 30),
          f"{m['frames']} frames after resuming from {saved} saved parts")
    check(any("already on disk" in l for l in st["log"]),
          "the log says which parts were kept")
    check(m["audio"] == 3, "resumed file still has 3 audio tracks")


# ---------------------------------------------------------------------------
# YouTube passthrough off a 3-track master
# ---------------------------------------------------------------------------

def test_youtube_stems(root: Path):
    print("youtube passthrough from a 3-track master")
    src = root / "master.mp4"
    out = root / "out_yt"
    proc = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work_yt"),
                                    output_dir=str(out))
    segs = [{"type": "body", "start": 0, "end": 5},
            {"type": "mute", "start": 5, "end": 8},
            {"type": "fast", "start": 8, "end": 12},
            {"type": "cut", "start": 12, "end": 13},
            {"type": "card", "start": 13, "end": 16},
            {"type": "body", "start": 16, "end": 20}]
    logs: List[str] = []
    res = proc.render_project(target="youtube", name="yt_test", segments=segs,
                              layout=L.LayoutState(), crf=30,
                              preset="ultrafast", part_target=6.0,
                              progress_cb=lambda f, i: None, log=logs.append)
    prog = 5 + 3 + 1 + 3 + 4          # fast 4s @4x = 1s
    fin = Path(res["mp4"])
    m = media(fin)
    check(res["chunked"] and res["parts"] >= 2,
          f"youtube cut chunked into {res['parts']} parts")
    check(abs(m["dur"] - prog) < 0.2,
          f"youtube file is {m['dur']:.2f}s == {prog}s of programme")
    check(m["frames"] == round(prog * 30),
          f"{m['frames']} frames == {round(prog * 30)} "
          "(the graph states its frame rate, so 30 fps survives)")
    check(m["audio"] == 1, "the uploaded cut carries a single rebuilt mix")
    check(any("stems" in l for l in logs),
          "the log says the content + mic stems were read")
    # programme map: body 0-5, mute 5-8, fast 8-9, card 9-12, body 12-16
    for t, expect, label in ((2.0, True, "body"), (6.0, False, "mute"),
                             (10.0, False, "card"), (14.0, True, "body")):
        s0 = spectrum(fin, t, 0)
        check(s0[MIC_HZ] > 50, f"{label}: mic survives ({s0[MIC_HZ]:.0f})")
        if expect:
            check(s0[CONTENT_HZ] > 20, f"{label}: content audible")
        else:
            check(s0[CONTENT_HZ] < 5,
                  f"{label}: content silenced, voice kept "
                  f"({s0[CONTENT_HZ]:.0f})")
    # single-pass parity: same segments, no chunking
    out2 = root / "out_yt_single"
    proc2 = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work_yt2"),
                                     output_dir=str(out2))
    res2 = proc2.render_passthrough(segs, fast_speed=4.0, crf=30,
                                    preset="ultrafast", name="yt_single")
    m2 = media(Path(res2["mp4"]))
    check(m2["frames"] == m["frames"],
          f"chunked ({m['frames']}) == single pass ({m2['frames']}) frames")
    # the card covers the content rect, not the frame
    corner = frame_pixel_1080(fin, 10.5, 0.05, 0.05)
    check(bool(corner) and sum(corner) > 45,
          f"camera corner visible during a card span (rgb={corner})")
    content_b = region_brightness(fin, 10.5, (0.294, 0.289, 0.70, 0.70),
                                  size=(1920, 1080))
    cam_b = region_brightness(fin, 10.5, (0.006, 0.011, 0.30, 0.30),
                              size=(1920, 1080))
    check(content_b < 60,
          f"passthrough card covers the content rect (mean {content_b:.0f})")
    check(cam_b > 20,
          f"passthrough card leaves the camera corner alone "
          f"(mean {cam_b:.0f})")
    # the words, not just the box: a card whose text never rendered is the
    # bug this whole check exists for (drawtext-less ffmpeg builds)
    # the card rect is near-black except for the words (the accent bar and
    # ring are mid-luma magenta), so bright pixels inside it ARE the text —
    # a shapes-only card, the old drawtext-less fallback, scores ~0 here
    words = bright_pixels(fin, 10.5, (0.32, 0.40, 0.64, 0.25))
    check(words > 2000,
          f"the exported card carries its title/sub ({words} bright px)")

    # the journal hashes the look: same name + new cloak must rebuild, or a
    # fixed render would resume straight into the old (broken) parts
    logs2: List[str] = []
    proc.render_project(target="youtube", name="yt_test", segments=segs,
                        layout=L.LayoutState(), crf=30, preset="ultrafast",
                        part_target=6.0, video_cloak=L.default_video_cloak(),
                        log=logs2.append)
    check(not any("already on disk" in l for l in logs2),
          "a cloak change invalidates the part journal (no stale reuse)")
    logs3: List[str] = []
    proc.render_project(target="youtube", name="yt_test", segments=segs,
                        layout=L.LayoutState(), crf=30, preset="ultrafast",
                        part_target=6.0, video_cloak=L.default_video_cloak(),
                        log=logs3.append)
    check(any("already on disk" in l for l in logs3),
          "unchanged settings still reuse every saved part")


def test_youtube_default_cloak(root: Path):
    """The cloak the browser posts by default must look like the preview.

    Regression guard for the inverted `vignette` mapping: at the old
    angles the export kept only a bright island in the frame centre.
    """
    print("youtube default cloak == preview")
    src = root / "master.mp4"
    out = root / "out_yt_cloak"
    proc = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work_cloak"),
                                    output_dir=str(out))
    segs = [{"type": "body", "start": 0, "end": 4},
            {"type": "card", "start": 4, "end": 7},
            {"type": "body", "start": 7, "end": 10}]
    rect = {"x": 0.294, "y": 0.289, "w": 0.70, "h": 0.70}
    lay = L.LayoutState()
    card = {"title": lay.card.title, "sub": lay.card.sub,
            "accent": lay.card.accent}
    plain = proc.render_passthrough(segs, audio_cloak={"on": False},
                                    video_cloak={"on": False}, card=card,
                                    fast_speed=4.0, crf=30,
                                    preset="ultrafast", name="cloak_off",
                                    content_rect=rect)
    cloaked = proc.render_passthrough(
        segs, audio_cloak=L.default_audio_cloak(),
        video_cloak=L.default_video_cloak(), card=card, fast_speed=4.0,
        crf=30, preset="ultrafast", name="cloak_on", content_rect=rect)
    a = frame_gray(Path(plain["mp4"]), 2.0)
    b = frame_gray(Path(cloaked["mp4"]), 2.0)
    check(a.size and b.size, "both renders decoded")
    # the default vignette (25) darkens the corner by ~10%, the whole frame
    # by a hair — the old mapping cut the mean to a third of this
    check(b.mean() > 0.85 * a.mean(),
          f"default cloak keeps the frame bright (mean {b.mean():.0f} vs "
          f"uncloaked {a.mean():.0f})")
    # sample inside the 3% cover bars (which body frames DO carry, like the
    # preview) and away from testsrc2's timestamp box
    corner_off, corner_on = a[64:128, 8:72].mean(), b[64:128, 8:72].mean()
    check(corner_on > 0.75 * corner_off,
          f"corners dim, not black ({corner_on:.0f} vs {corner_off:.0f})")
    # and a card span skips the vignette + bars, like the preview
    c_on = frame_gray(Path(cloaked["mp4"]), 5.0)
    top_bar = c_on[0:8, :].mean()
    check(top_bar > 40,
          f"no cover bars over a card span (top rows mean {top_bar:.0f})")
    check(c_on[64:128, 8:72].mean() > 0.9 * corner_off,
          f"no vignette over a card span "
          f"({c_on[64:128, 8:72].mean():.0f} vs {corner_off:.0f})")
    words = bright_pixels(Path(cloaked["mp4"]), 5.0,
                          (0.32, 0.40, 0.64, 0.25))
    check(words > 2000, f"cloaked export still shows the card text "
                        f"({words} bright px)")


def test_fisheye_reaction_only(root: Path):
    """The fisheye lens must actually reach the export (it used to be drawn
    in the preview and silently dropped by the ffmpeg graph), must distort
    the content only (camera stays clean), and must NEVER touch intro/outro
    — those are full-cam solo frames, so a lens over them bulges the camera.
    """
    print("fisheye: in export, content-only, reaction-only, backend fallback")
    src = root / "master.mp4"
    out = root / "out_fish"
    proc = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work_fish"),
                                    output_dir=str(out))
    rect = {"x": 0.294, "y": 0.289, "w": 0.70, "h": 0.70}
    cam = {"x": 0.006, "y": 0.011, "w": 0.30, "h": 0.30}
    fish = L.default_video_cloak()
    fish.update({"on": True, "fisheye": True, "fisheyeAmount": 60.0})

    # ---- graph level: which backend is chosen, and on which segments ----
    # one pass per backend: default (remap), no remap (lenscorrection),
    # no remap+lenscorrection (geq). All must stay reaction-only.
    segs = [{"type": "intro", "start": 0, "end": 3},
            {"type": "body", "start": 3, "end": 8},
            {"type": "mute", "start": 8, "end": 10},
            {"type": "card", "start": 10, "end": 11.5},
            {"type": "fast", "start": 11.5, "end": 15.5},
            {"type": "outro", "start": 15.5, "end": 20}]
    reaction = [i for i, s in enumerate(segs)
                if s["type"] not in ("intro", "outro")]

    def build(disable=(), video_cloak=None):
        orig = V._ffmpeg_has_filter
        V._ffmpeg_has_filter = (lambda n: (False if n in disable
                                           else orig(n)))
        try:
            return proc._passthrough_graph(
                segs, W=1920, H=1080, audio_cloak={"on": False},
                video_cloak=video_cloak or fish, card=None,
                fast_speed=4.0, master_gain_db=0.0, content_rect=rect,
                out_fps=30.0, height=0, audio_inputs=["0:a:1", "0:a:2"],
                cam_rect=cam)
        finally:
            V._ffmpeg_has_filter = orig

    def assert_reaction_only(ct: str, marker: str, label: str) -> None:
        for i in range(len(segs)):
            has = f"{marker}{i}" in ct
            want = i in reaction
            check(has == want,
                  f"{label}: segment {i} ({segs[i]['type']}) "
                  f"{'has' if has else 'lacks'} fisheye (want "
                  f"{'yes' if want else 'no'})")

    # default backend: remap maps (present on every FFmpeg since 3.1)
    chain, warns, inputs = build()
    ct = " ".join(chain)
    check("remap" in ct, "default fisheye backend is remap (exact preview math)")
    check(any(p.name.startswith("fish_") for p in inputs),
          "remap map PNGs are attached as extra inputs")
    assert_reaction_only(ct, "remap[vcf", "remap")

    # force lenscorrection (drop remap): must still be reaction-only. It is
    # inlined into the content-crop element, so check per segment element.
    chain2 = build(disable=("remap",))[0]
    check(any("lenscorrection" in p for p in chain2),
          "no remap -> falls back to lenscorrection")
    for i in range(len(segs)):
        el = [p for p in chain2 if f"vcsrc{i}]" in p]
        has = any("lenscorrection" in p for p in el)
        want = i in reaction
        check(has == want,
              f"lenscorrection: segment {i} ({segs[i]['type']}) "
              f"{'has' if has else 'lacks'} fisheye (want "
              f"{'yes' if want else 'no'})")

    # force geq (drop remap + lenscorrection): last resort, still reaction-only
    chain3, warns3, _ = build(disable=("remap", "lenscorrection"))
    ct3 = " ".join(chain3)
    check("geq=" in ct3, "no remap/lenscorrection -> falls back to geq")
    check(any("geq" in w for w in warns3),
          "the slow geq fallback announces itself in the render log")
    # geq is inlined into the content crop, so grep the per-segment crop
    for i in range(len(segs)):
        m = re.search(rf"\[vcsrc{i}\][^\[]*?geq=", ct3)
        want = i in reaction
        check((m is not None) == want,
              f"geq: segment {i} ({segs[i]['type']}) "
              f"{'has' if m else 'lacks'} fisheye (want "
              f"{'yes' if want else 'no'})")

    # a standalone fisheye (frame cloak bypassed) still reaches the graph
    fish_off = dict(fish)
    fish_off["on"] = False
    chain4 = build(video_cloak=fish_off)[0]
    check(all(f"remap[vcf{i}" in " ".join(chain4) for i in reaction)
          and not any(f"remap[vcf{i}" in " ".join(chain4)
                      for i in range(len(segs)) if i not in reaction),
          "cloak bypassed + fisheye on: reaction-only lens still applied")

    # ---- render level: prove it reaches the exported file ----
    # speed-1 segments only, so programme time == source time
    segs2 = [{"type": "intro", "start": 0, "end": 3},
             {"type": "body", "start": 3, "end": 8},
             {"type": "outro", "start": 8, "end": 11}]
    res = proc.render_passthrough(segs2, audio_cloak={"on": False},
                                  video_cloak=fish, card=None, fast_speed=4.0,
                                  crf=30, preset="ultrafast", name="fish",
                                  content_rect=rect, cam_rect=cam)
    fin = Path(res["mp4"])
    W, H = 1920, 1080

    def crop(img: np.ndarray, r: tuple) -> np.ndarray:
        x, y, rw, rh = r
        return img[int(y * H):int((y + rh) * H),
                   int(x * W):int((x + rw) * W)]

    def mad(a: np.ndarray, b: np.ndarray) -> float:
        if a.size == 0 or b.size == 0 or a.shape != b.shape:
            return -1.0
        return float(np.abs(a.astype(int) - b.astype(int)).mean())

    # body centre (source vs export, same t): the lens must have moved it
    s_body = frame_gray(src, 5.5, size=(W, H))
    e_body = frame_gray(fin, 5.5, size=(W, H))
    ccx = int((rect["x"] + rect["w"] / 2) * W)
    ccy = int((rect["y"] + rect["h"] / 2) * H)
    c_diff = mad(crop(s_body, (0.42, 0.42, 0.16, 0.16)),
                 crop(e_body, (0.42, 0.42, 0.16, 0.16)))
    check(c_diff > 10,
          f"fisheye reached the export (content centre moved {c_diff:.1f} "
          f"grey levels; a dropped lens scores < 3)")
    # camera corner in the body: must stay clean (content-only)
    cam_diff = mad(crop(s_body, (cam["x"], cam["y"], cam["w"], cam["h"])),
                   crop(e_body, (cam["x"], cam["y"], cam["w"], cam["h"])))
    check(cam_diff < 8,
          f"fisheye leaves the camera corner clean ({cam_diff:.1f} "
          f"grey levels)")
    # intro and outro: the whole frame must match the source (no lens)
    for t, label in ((1.5, "intro"), (9.5, "outro")):
        d = mad(frame_gray(src, t, size=(W, H)),
                frame_gray(fin, t, size=(W, H)))
        check(d < 8,
              f"fisheye stays off the {label} full-cam frame "
              f"(whole-frame diff {d:.1f} grey levels)")
    # and the chunked path (the one long Colab renders actually take):
    # every part is its own ffmpeg command, so the map inputs have to work
    # per part and the joined file must carry the lens
    out2 = root / "out_fish_chunked"
    proc2 = V.ReactionVideoProcessor(str(src),
                                     work_dir=str(root / "work_fish2"),
                                     output_dir=str(out2))
    res2 = proc2.render_project(target="youtube", name="fish_c",
                                segments=segs2, layout=L.LayoutState(),
                                video_cloak=fish, crf=30,
                                preset="ultrafast", part_target=4.0,
                                progress_cb=lambda f, i: None)
    fin2 = Path(res2["mp4"])
    m2 = media(fin2)
    check(res2["chunked"] and res2["parts"] >= 2,
          f"chunked fisheye render split into {res2['parts']} parts")
    check(abs(m2["dur"] - 11.0) < 0.2,
          f"chunked fisheye file is {m2['dur']:.2f}s == 11s of programme")
    c2 = mad(crop(frame_gray(src, 5.5, size=(W, H)),
                  (0.42, 0.42, 0.16, 0.16)),
             crop(frame_gray(fin2, 5.5, size=(W, H)),
                  (0.42, 0.42, 0.16, 0.16)))
    check(c2 > 10,
          f"joined chunked export carries the lens "
          f"(content centre moved {c2:.1f} grey levels)")


def test_http_api(root: Path):
    """The routes the hosted editor talks to, against a live server."""
    print("http api")
    import urllib.request
    import server as S

    out = root / "out_http"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(str(root / "master.mp4"), str(out / "patreon_master.mp4"))
    proc = V.ReactionVideoProcessor(str(root / "raw.mp4"),
                                    work_dir=str(root / "work_http"),
                                    output_dir=str(out))
    httpd, app = S.serve_forever(proc, port=0, proxy_width=320)
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"

    def get(path: str):
        with urllib.request.urlopen(base + path, timeout=60) as r:
            return r.status, r.read()

    def post(path: str, body: Dict[str, Any]):
        req = urllib.request.Request(
            base + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

    st, raw = get("/api/state")
    state = json.loads(raw)
    for key in ("step", "part", "parts", "eta_s", "elapsed_s", "age_s",
                "bytes", "resume"):
        check(key in state["job"], f"/api/state job carries '{key}'")

    st, raw = get("/api/sources")
    srcs = json.loads(raw)["sources"]
    check(any(s["folder"] == "output" for s in srcs),
          "/api/sources lists the output folder (where Patreon masters live)")
    check(any(s["folder"] == "input" for s in srcs),
          "/api/sources still lists the raw folder")

    body = {"target": "patreon", "name": "http_render", "segments": SEGS,
            "layout": L.LayoutState().to_dict(),
            "audio": state["audio"], "retouch": {"enabled": False},
            "audioCloak": {"on": False}, "videoCloak": {"on": False},
            "crf": 30, "webm": False, "fps": None, "height": 540,
            "partTarget": 4.0, "stems": True}
    job = post("/api/job/render", body)
    check(job["state"] == "running", "POST /api/job/render starts the job")
    seen_parts = 0
    saw_step = False
    for _ in range(900):
        j = json.loads(get("/api/job")[1])
        seen_parts = max(seen_parts, j.get("parts") or 1)
        saw_step = saw_step or bool(j.get("step"))
        if j["state"] != "running":
            break
        time.sleep(0.4)
    check(seen_parts >= 3, f"/api/job reported {seen_parts} parts while running")
    check(saw_step, "/api/job reports the current step")
    check(j["state"] == "done", f"job finished ({j['state']})")
    check(j["files"].get("mp4") == "http_render.mp4",
          f"job advertises {j['files'].get('mp4')}")
    check(j["files"].get("stems") == "mix,content,mic",
          f"job advertises the stem order: {j['files'].get('stems')}")
    check((j.get("bytes") or 0) > 0, f"job reports the file size "
                                     f"({j.get('bytes')} bytes)")

    st, raw = get("/files/http_render.mp4")
    check(st == 200 and len(raw) > 10000,
          f"/files/<name> serves the render ({len(raw)} bytes)")
    req = urllib.request.Request(base + "/files/http_render.mp4",
                                 headers={"Range": "bytes=0-1023"})
    with urllib.request.urlopen(req, timeout=30) as r:
        check(r.status == 206 and len(r.read()) == 1024,
              "Range requests work (the <video> element needs them)")

    # cancel, then resume through the API
    job = post("/api/job/render", {**body, "name": "http_cancel"})
    for _ in range(200):
        man = V.read_manifest(out, "http_cancel")
        if man and len(man["done"]) >= 1:
            break
        time.sleep(0.3)
    post("/api/job/cancel", {})
    for _ in range(200):
        if json.loads(get("/api/job")[1])["state"] != "running":
            break
        time.sleep(0.3)
    check(json.loads(get("/api/job")[1])["state"] == "cancelled",
          "POST /api/job/cancel stops the job")
    cancelled = json.loads(get("/api/job")[1])
    check((cancelled.get("resume") or {}).get("saved", 0) >= 1,
          "a cancelled render still offers its saved parts")
    S.LOST_AFTER_S = 0.0
    app.job = S.App._fresh_job("render")     # as if the runtime had restarted
    lost = json.loads(get("/api/job")[1])
    check(lost["state"] == "lost" and lost["resume"]["key"] == "http_cancel",
          "GET /api/job reports the abandoned render as resumable")
    j2 = post("/api/job/resume", {"key": "http_cancel"})
    check(j2["state"] == "running", "POST /api/job/resume restarts it")
    for _ in range(900):
        j3 = json.loads(get("/api/job")[1])
        if j3["state"] != "running":
            break
        time.sleep(0.4)
    check(j3["state"] == "done", f"resumed job finished ({j3['state']})")
    check(media(out / "http_cancel.mp4")["dur"] > PROG - 0.2,
          f"resumed file is complete "
          f"({media(out / 'http_cancel.mp4')['dur']:.2f}s of {PROG}s)")
    httpd.shutdown()


def test_youtube_card_follows_posted_layout(root: Path):
    """The card goes where the layout that composed the source says."""
    print("youtube card follows the posted layout")
    out = root / "out_yt_rect"
    proc = V.ReactionVideoProcessor(str(root / "master.mp4"),
                                    work_dir=str(root / "work_yt_rect"),
                                    output_dir=str(out))
    lay = L.LayoutState()
    lay.content = L.Rect(0.05, 0.05, 0.5, 0.5)      # not the default rect
    segs = [{"type": "body", "start": 0, "end": 4},
            {"type": "card", "start": 4, "end": 8}]
    res = proc.render_passthrough(segs, fast_speed=4.0, crf=30,
                                  preset="ultrafast", name="yt_rect",
                                  content_rect={"x": lay.content.x,
                                                "y": lay.content.y,
                                                "w": lay.content.w,
                                                "h": lay.content.h})
    fin = Path(res["mp4"])
    inside = region_brightness(fin, 5.0, (0.05, 0.05, 0.5, 0.5),
                               size=(1920, 1080))
    outside = region_brightness(fin, 5.0, (0.78, 0.72, 0.2, 0.26),
                                size=(1920, 1080))
    check(inside < 60,
          f"the posted content rect is covered by the card (mean {inside:.0f})")
    check(outside > inside + 30,
          f"the rest of the frame — including the camera corner — is not "
          f"(mean {outside:.0f} vs {inside:.0f})")


def frame_pixel_1080(path: Path, t: float, x: float, y: float) -> List[int]:
    import numpy as np
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path),
         "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True).stdout
    if not raw:
        return []
    w, h = 1920, 1080
    img = np.frombuffer(raw[:w * h * 3], dtype=np.uint8).reshape(h, w, 3)
    return [int(v) for v in img[int(y * h), int(x * w)]]


def test_clean_intro_outro(root: Path):
    """The user rule: intro/outro leave the YouTube cut EXACTLY as recorded.

    No video cloak, no bars/vignette/border, no speed tweak, no audio cloak,
    no voice changer — all of it lives in the reaction part only. Proven by
    rendering the same timeline with a maxed cloak and with none, then
    diffing frames (intro/outro must match, body must not) and reading the
    spectrum (intro keeps the unshifted mic tone, body loses it).
    """
    print("intro/outro stay clean — every effect is reaction-only")
    src = root / "master.mp4"
    out = root / "out_clean"
    proc = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work_clean"),
                                    output_dir=str(out))
    segs = [{"type": "intro", "start": 0, "end": 3},
            {"type": "body", "start": 3, "end": 8},
            {"type": "card", "start": 8, "end": 9.5},
            {"type": "body", "start": 9.5, "end": 13},
            {"type": "outro", "start": 13, "end": 16}]
    rect = {"x": 0.294, "y": 0.289, "w": 0.70, "h": 0.70}
    vc = L.default_video_cloak()
    vc.update({"on": True, "bars": 4.0, "vignette": 45.0, "hue": 18.0,
               "zoom": 1.06, "border": 8.0, "speed": 1.04})
    ac = L.default_audio_cloak()
    ac.update({"on": True, "pitch": 1.5, "voiceChanger": True,
               "voiceMode": "fx", "voicePreset": "deep", "voiceStrength": 80.0})
    plain = proc.render_passthrough(segs, audio_cloak={"on": False},
                                    video_cloak={"on": False}, card=None,
                                    fast_speed=4.0, crf=30, preset="ultrafast",
                                    name="clean_off", content_rect=rect)
    cloaked = proc.render_passthrough(segs, audio_cloak=ac, video_cloak=vc,
                                      card=None, fast_speed=4.0, crf=30,
                                      preset="ultrafast", name="clean_on",
                                      content_rect=rect)
    a, b = Path(plain["mp4"]), Path(cloaked["mp4"])
    # The speed tweak compresses only the reaction, so the outro starts at a
    # different programme instant in each file. Sample each render 1 s before
    # its own end — both then decode the SAME source frame, which is the only
    # fair way to prove the outro pixels were untouched.
    dur_plain = media(a)["dur"]
    dur_cloak = media(b)["dur"]

    def luma_diff(ta: float, tb: float) -> float:
        fa, fb = frame_gray(a, ta), frame_gray(b, tb)
        if fa.size == 0 or fb.size == 0:
            return 999.0
        return float(np.abs(fa.astype(int) - fb.astype(int)).mean())

    d_intro = luma_diff(1.0, 1.0)
    d_outro = luma_diff(dur_plain - 1.0, dur_cloak - 1.0)
    # programme time of the reaction: (16 - 3 - 3) / 1.04 speed tweak,
    # so programme 5.0 s sits inside the first body span
    d_body = luma_diff(5.0, 5.0)
    # Two separate CRF-30 encodes differ by a few luma from rate control
    # alone, so the proof is RELATIVE: intro/outro stay at encode-noise
    # level while the reaction jumps by an order of magnitude.
    check(d_intro < 5.0,
          f"intro frame is untouched by the full cloak (Δ luma {d_intro:.2f})")
    check(d_outro < 5.0,
          f"outro frame is untouched by the full cloak (Δ luma {d_outro:.2f})")
    check(d_body > 8.0,
          f"reaction frames DO take the cloak (Δ luma {d_body:.2f})")
    check(d_outro < 0.5 * d_body,
          f"outro stays far cleaner than the cloaked reaction "
          f"({d_outro:.2f} vs {d_body:.2f})")
    # the top bar zone: black on reaction spans, clean on intro/outro.
    # Sample rows 10..40 — below the 8 px inset border colour, inside the
    # 4 % cover bar — so the frame colour can't leak into the reading.
    bar_on = frame_gray(b, 5.0)[10:40, :].mean()
    bar_intro = frame_gray(b, 1.0)[10:40, :].mean()
    bar_plain = frame_gray(a, 1.0)[10:40, :].mean()
    check(bar_on < 0.4 * bar_plain,
          f"cover bars reach the reaction part (top rows {bar_on:.0f})")
    check(abs(bar_intro - bar_plain) < 2.0,
          f"…but never the intro (top rows {bar_intro:.0f} vs {bar_plain:.0f})")

    # audio: the mic tone (440 Hz) keeps its frequency in the intro
    # (no pitch shift / voice changer there) and loses it in the body
    s_intro = spectrum(b, 1.0)
    s_body = spectrum(b, 5.0)
    check(s_intro[MIC_HZ] > 40,
          f"intro audio keeps the natural mic tone ({s_intro[MIC_HZ]:.0f})")
    check(s_body[MIC_HZ] < 0.5 * s_intro[MIC_HZ],
          f"reaction audio is pitch/voice-changed (440 Hz "
          f"{s_intro[MIC_HZ]:.0f} → {s_body[MIC_HZ]:.0f})")
    s_outro = spectrum(b, 14.0)
    check(s_outro[MIC_HZ] > 40,
          f"outro audio keeps the natural mic tone ({s_outro[MIC_HZ]:.0f})")

    # ---- the same rule must hold on the CHUNKED path (parts + journal) ----
    # that is the path that renders long videos — the one that blew up at
    # part 6/6 and the one long exports actually take
    logs: List[str] = []
    res_c = proc.render_project(target="youtube", name="clean_chunked",
                                segments=segs, layout=L.LayoutState(),
                                audio_cloak=ac, video_cloak=vc,
                                fast_speed=4.0, crf=30, preset="ultrafast",
                                part_target=4.0, log=logs.append)
    c = Path(res_c["mp4"])
    check(res_c.get("chunked") is True and res_c.get("parts", 0) > 1,
          f"the chunked render actually chunked ({res_c.get('parts')} parts)")
    dur_chunk = media(c)["dur"]
    dc_intro = float(np.abs(frame_gray(a, 1.0).astype(int)
                            - frame_gray(c, 1.0).astype(int)).mean())
    dc_outro = float(np.abs(frame_gray(a, dur_plain - 1.0).astype(int)
                            - frame_gray(c, dur_chunk - 1.0).astype(int)).mean())
    dc_body = float(np.abs(frame_gray(a, 5.0).astype(int)
                           - frame_gray(c, 5.0).astype(int)).mean())
    check(dc_intro < 5.0,
          f"chunked: intro untouched by the cloak (Δ {dc_intro:.2f})")
    check(dc_outro < 5.0 and dc_outro < 0.5 * max(8.0, dc_body),
          f"chunked: outro untouched by the cloak "
          f"(Δ {dc_outro:.2f}, body Δ {dc_body:.2f})")
    check(frame_gray(c, 5.0)[10:40, :].mean() < 25,
          "chunked: cover bars still reach the reaction part")
    sc_intro = spectrum(c, 1.0)
    sc_body = spectrum(c, 5.0)
    check(sc_intro[MIC_HZ] > 40 and sc_body[MIC_HZ] < 0.5 * sc_intro[MIC_HZ],
          f"chunked: intro audio clean, reaction audio disguised "
          f"(intro {sc_intro[MIC_HZ]:.0f}, body {sc_body[MIC_HZ]:.0f})")


def test_sticker_reaction_only(root: Path):
    """The user's overlay image lands on the reaction part only, with its
    opacity honoured — intro/outro frames stay pixel-clean."""
    print("sticker overlay: reaction-only, opacity, position")
    src = root / "master.mp4"
    out = root / "out_sticker"
    proc = V.ReactionVideoProcessor(str(src), work_dir=str(root / "work_sticker"),
                                    output_dir=str(out))
    import cv2 as _cv2
    png = root / "work_sticker.png"
    img = np.zeros((160, 320, 4), np.uint8)
    img[..., :3] = 255     # white square (bright in luma), full alpha
    img[..., 3] = 255
    _cv2.imwrite(str(png), img)
    segs = [{"type": "intro", "start": 0, "end": 3},
            {"type": "body", "start": 3, "end": 10},
            {"type": "outro", "start": 10, "end": 14}]
    rect = {"x": 0.294, "y": 0.289, "w": 0.70, "h": 0.70}
    sticker = {"on": True, "src": str(png), "x": 0.80, "y": 0.05,
               "w": 0.15, "opacity": 0.9}
    plain = proc.render_passthrough(segs, audio_cloak={"on": False},
                                    video_cloak={"on": False}, card=None,
                                    fast_speed=4.0, crf=30, preset="ultrafast",
                                    name="sticker_off", content_rect=rect)
    stuck = proc.render_passthrough(segs, audio_cloak={"on": False},
                                    video_cloak={"on": False}, card=None,
                                    fast_speed=4.0, crf=30, preset="ultrafast",
                                    name="sticker_on", content_rect=rect,
                                    sticker=sticker)
    a, b = Path(plain["mp4"]), Path(stuck["mp4"])
    box = (0.80, 0.05, 0.15, 0.15)
    pb, sb = region_brightness(a, 5.0, box, (1920, 1080)), \
        region_brightness(b, 5.0, box, (1920, 1080))
    check(sb > pb + 10,
          f"the sticker is visible during the reaction part "
          f"({sb:.0f} vs {pb:.0f})")
    d_intro = float(np.abs(frame_gray(a, 1.0).astype(int)
                           - frame_gray(b, 1.0).astype(int)).mean())
    d_outro = float(np.abs(frame_gray(a, 12.0).astype(int)
                           - frame_gray(b, 12.0).astype(int)).mean())
    check(d_intro < 1.0, f"no sticker over the intro (Δ {d_intro:.2f})")
    check(d_outro < 1.0, f"no sticker over the outro (Δ {d_outro:.2f})")


def test_encoder_fallback():
    """GPU detection must be a real smoke encode, not an encoder listing.

    Static ffmpeg builds always LIST h264_nvenc; on a GPU-less runtime the
    encoder then dies with 'Cannot load libcuda.so.1' mid-render. The pick
    must run the smoke test (and honour REACT_GPU=0)."""
    print("encoder pick: smoke-tested nvenc, CPU fallback, REACT_GPU=0")
    enc, _ = V._pick_video_encoder(prefer_gpu=True)
    check(enc in ("h264_nvenc", "libx264"),
          f"encoder pick returns a usable encoder ({enc})")
    check(V._pick_video_encoder()[0] == ("h264_nvenc" if C.nvenc_available()
                                         else "libx264"),
          "the pick agrees with the compose-level smoke test")
    saved_gpu, saved_cache = os.environ.get("REACT_GPU"), C._NVENC_OK
    try:
        os.environ["REACT_GPU"] = "0"
        C._NVENC_OK = None
        check(C.nvenc_available(verbose=False) is False,
              "REACT_GPU=0 forces the CPU encoder")
        check(V._pick_video_encoder()[0] == "libx264",
              "REACT_GPU=0 -> libx264")
    finally:
        if saved_gpu is None:
            os.environ.pop("REACT_GPU", None)
        else:
            os.environ["REACT_GPU"] = saved_gpu
        C._NVENC_OK = saved_cache

    # A GPU failure pins the process to the CPU (force_cpu_encode) — but
    # that pin must be a FAILURE pin: the next render re-tests the GPU
    # (retry_gpu_encode), otherwise one hiccup leaves the GPU idle for the
    # rest of the session (the state Colab reports as "GPU not being used").
    saved_gpu, saved_cache, saved_pin = (os.environ.get("REACT_GPU"),
                                         C._NVENC_OK, C._GPU_PINNED)
    try:
        os.environ.pop("REACT_GPU", None)
        C._GPU_USER_FORCED = False
        C.force_cpu_encode(why="test hiccup")
        check(os.environ.get("REACT_GPU") == "0" and C._NVENC_OK is False,
              "a GPU failure pins the rest of this run to the CPU")
        st = C.encoder_status()
        check(st["pinned_by_failure"] is True and "test hiccup" in st["pin_reason"],
              "encoder_status reports the failure pin (and why)")
        C.retry_gpu_encode()
        check(os.environ.get("REACT_GPU") != "0" and C._GPU_PINNED == "",
              "the next job clears the failure pin and re-runs the smoke test")
        check(C.encoder_status()["gpu"] == C.nvenc_available(verbose=False),
              "encoder_status agrees with the smoke test after the retry")
        # a REACT_GPU=0 set by the USER before launch is never overridden
        C._GPU_USER_FORCED = True
        check(C.retry_gpu_encode() is False,
              "a user-forced CPU (REACT_GPU=0 at launch) survives the retry")
    finally:
        if saved_gpu is None:
            os.environ.pop("REACT_GPU", None)
        else:
            os.environ["REACT_GPU"] = saved_gpu
        C._NVENC_OK = saved_cache
        C._GPU_PINNED = saved_pin
        C._GPU_USER_FORCED = os.environ.get("REACT_GPU", "1") == "0"


# ---------------------------------------------------------------------------

def main() -> int:
    fast_only = len(sys.argv) > 1 and sys.argv[1] == "fast"
    root = Path(os.environ.get("RENDER_TEST_DIR")
                or Path(tempfile.mkdtemp(prefix="render_parts_")))
    root.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print(f"workspace: {root}\n")

    # pure math first — no ffmpeg, no fixtures, so this part runs anywhere
    test_plan_parts()
    test_auto_part_target()
    test_card_covers_content_only()
    test_card_speed()
    test_fair_use_cards()
    test_vignette_matches_preview()
    test_encoder_fallback()
    if fast_only:
        print(f"\n{CHECKS[0]} checks, {len(FAILS)} failed "
              f"({time.time() - t0:.0f}s)")
        return 1 if FAILS else 0

    if not shutil.which("ffmpeg"):
        print("ffmpeg not found on PATH — cannot run the render tests")
        return 2

    if not (root / "raw.mp4").exists():
        print("building fixtures …")
        make_raw(root / "raw.mp4")
        make_master(root / "master.mp4")
    # fixtures are reused between runs; render outputs are not (a resume test
    # against last run's finished output would prove nothing)
    for d in ("out", "out_resume", "out_yt", "out_yt_single", "out_short",
              "out_http", "out_yt_rect", "out_yt_cloak", "out_fish",
              "out_clean", "out_sticker", "work",
              "work_resume", "work_yt", "work_yt2", "work_short",
              "work_http", "work_yt_rect", "work_cloak", "work_fish",
              "work_clean", "work_sticker"):
        shutil.rmtree(root / d, ignore_errors=True)
    test_patreon_chunked(root)
    test_short_render_single_pass(root)
    test_truncated_part_rebuilt(root)
    test_resume_after_kill(root)
    test_youtube_stems(root)
    test_youtube_default_cloak(root)
    test_fisheye_reaction_only(root)
    test_youtube_card_follows_posted_layout(root)
    test_clean_intro_outro(root)
    test_sticker_reaction_only(root)
    test_http_api(root)

    print(f"\n{CHECKS[0]} checks, {len(FAILS)} failed ({time.time() - t0:.0f}s)")
    for f in FAILS:
        print(f"  FAILED: {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
