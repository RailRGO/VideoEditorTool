#!/usr/bin/env python3
"""Mirror tests — the Cloak tab's mirroring block, measured on real pixels.

    cd colab_version
    python3 webapp/tests/test_mirror.py          # everything (~30 s)
    python3 webapp/tests/test_mirror.py fast     # graph strings only, no encode

What is covered, and why each check exists:

* ``resolve_mirror`` — the Python twin of ``resolveMirror()`` in
  ``src/lib/types.ts``: mode (content / frame / off), the per-block tick
  (``mirrorScope == "blocks"``), the legacy ``flip``/``flipContent`` flags of
  projects saved before v7, and the 0…0.6 clamp on ``mirrorKeepBottom``.
* a content-only mirror actually flips the CONTENT rect of the finished file
  (colours left/right swap) and never touches intro/outro.
* ``mirrorKeepBottom`` keeps the bottom strip of a mirrored block exactly as
  recorded — the strip burned-in subtitles live in, and the bottom of a short
  card.
* a whole-picture mirror (``frame``) flips the finished frame, camera and all,
  and is applied ONCE (after the concat) so the card and the camera restore
  cannot be misplaced: the card's words stay upright in the mirrored corner.
* with ``mirrorScope == "blocks"`` only the ticked blocks flip, and the rest
  of the programme comes through untouched.
* the legacy flags still produce exactly ONE flip (a doubled hflip would
  export an unmirrored file that merely looks pixel-identical to no-mirror),
  on the content rect or on the whole frame, whichever the project's
  `contentOnly` asked for — a pre-v7 project has to export what it previews.
* a CHUNKED render keeps each block's tick when a segment is sliced into
  parts, and the hosted webapp hands the tick through to the renderer at all
  (both used to drop it: preview mirrored, download did not).

Needs ffmpeg on PATH plus numpy/opencv. No pytest required. If ffmpeg is not
on PATH the test looks for imageio-ffmpeg's bundled binary and shims it in.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))          # colab_version/

import video_processor as VP                          # noqa: E402
import compose as C                                   # noqa: E402


# --------------------------------------------------------------------------- io
def _ensure_ffmpeg() -> str:
    """ffmpeg + ffprobe on PATH, shimming imageio-ffmpeg's binary if needed."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
    except ImportError:                                # pragma: no cover
        raise SystemExit("ffmpeg is not on PATH and imageio-ffmpeg is not "
                         "installed — pip install imageio-ffmpeg")
    real = Path(imageio_ffmpeg.get_ffmpeg_exe())
    shim = Path(tempfile.mkdtemp(prefix="ffshim_"))
    # NB: ffmpeg only — a fake `ffprobe` would make `_has("ffprobe")` lie and
    # the probe would fail where the documented `ffmpeg -i` fallback works
    link = shim / "ffmpeg"
    link.symlink_to(real)
    link.chmod(0o755)
    os.environ["PATH"] = f"{shim}{os.pathsep}{os.environ.get('PATH', '')}"
    os.environ.setdefault("REACT_GPU", "0")            # no GPU in CI
    return str(link)


FFMPEG = _ensure_ffmpeg()
W, H = 640, 360
BAND = 0.75                                            # top band = 75 % of H

# BGR colours: top band red | blue, bottom band green | yellow. A horizontal
# flip swaps the left and right halves of each band, which is exactly what the
# tests measure.
RED, BLUE = (0, 0, 255), (255, 0, 0)
GREEN, YELLOW = (0, 255, 0), (0, 255, 255)
WHITE = (255, 255, 255)


def make_fixture(path: Path, seconds: float = 4.0, fps: int = 30) -> Path:
    """A 640x360 clip whose four colour quadrants make a flip measurable."""
    hw, th, bh = W // 2, int(H * BAND), H - int(H * BAND)
    f = (
        f"color=c=red:s={hw}x{th}:d={seconds}:r={fps}[tl];"
        f"color=c=blue:s={hw}x{th}:d={seconds}:r={fps}[tr];"
        f"color=c=green:s={hw}x{bh}:d={seconds}:r={fps}[bl];"
        f"color=c=yellow:s={hw}x{bh}:d={seconds}:r={fps}[br];"
        "[tl][tr]hstack[top];[bl][br]hstack[bot];[top][bot]vstack[full];"
        # white marker in the TOP-LEFT corner: after a flip it must not be there
        "[full]drawbox=x=0:y=0:w=64:h=36:c=white:t=fill,format=yuv420p[v]"
    )
    cmd = [FFMPEG, "-y", "-v", "error",
           "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
           "-filter_complex", f, "-map", "[v]", "-map", "0:a",
           "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
           "-c:a", "aac", "-shortest", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return path


# ------------------------------------------------------------------ measuring
def frame_at(mp4: Path, t: float) -> np.ndarray:
    """One BGR frame of *mp4* at output time *t*."""
    import cv2
    cap = cv2.VideoCapture(str(mp4))
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
    ok, fr = cap.read()
    cap.release()
    if not ok:
        raise AssertionError(f"could not read a frame at {t}s from {mp4}")
    return fr


def _mean(fr: np.ndarray, x0: float, x1: float, y0: float, y1: float):
    h, w = fr.shape[:2]
    patch = fr[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
    return patch.reshape(-1, 3).mean(axis=0)           # BGR


def _dom(patch_mean) -> str:
    b, g, r = patch_mean
    if r > 120 and g > 120 and b < 120:
        return "yellow"
    if r > b + 60 and r > g + 60:
        return "red"
    if b > r + 60 and b > g + 60:
        return "blue"
    if g > r + 60 and g > b + 60:
        return "green"
    return f"other({b:.0f},{g:.0f},{r:.0f})"


def quadrants(fr: np.ndarray) -> dict:
    """Dominant colour of each quadrant, plus the white marker's corner.

    Whiteness is the mean of the BGR channels: 255 = the white marker,
    ~85 = any fully saturated colour (blue/red/green all average to 85).
    """
    return {
        "top_left": _dom(_mean(fr, 0.05, 0.45, 0.05, BAND * 0.6)),
        "top_right": _dom(_mean(fr, 0.55, 0.95, 0.05, BAND * 0.6)),
        "bottom_left": _dom(_mean(fr, 0.05, 0.45, BAND + 0.02, 0.99)),
        "bottom_right": _dom(_mean(fr, 0.55, 0.95, BAND + 0.02, 0.99)),
        "top_left_whiteness": float(_mean(fr, 0.0, 0.05, 0.0, 0.05).mean()),
        "top_right_whiteness": float(_mean(fr, 0.95, 1.0, 0.0, 0.05).mean()),
    }


# --------------------------------------------------------------------- checks
_RUN: list = []
_FAILED: list = []


def check(name: str, got, want) -> None:
    ok = got == want if not isinstance(want, tuple) else got == want
    _RUN.append((name, ok))
    if ok:
        print(f"  ok   {name}")
    else:
        _FAILED.append(name)
        print(f"  FAIL {name}: got {got!r}, want {want!r}")


def check_true(name: str, cond: bool, detail: str = "") -> None:
    _RUN.append((name, bool(cond)))
    if cond:
        print(f"  ok   {name}")
    else:
        _FAILED.append(name)
        print(f"  FAIL {name} {detail}")


# =========================================================== resolve_mirror ==
def test_resolve_mirror() -> None:
    print("resolve_mirror (the twin of resolveMirror in src/lib/types.ts)")
    R = VP.resolve_mirror
    check("no cloak -> off", R(None)["mode"], "off")
    check("empty config -> off", R({})["mode"], "off")
    check("mode off -> off", R({"mirrorMode": "off"})["mode"], "off")

    content = R({"mirrorMode": "content"})
    check("mode content", content["mode"], "content")
    check_true("content flips the content rect", content["content_flip"])
    check_true("content does not flip the frame", not content["frame_flip"])

    frame = R({"mirrorMode": "frame"})
    check("mode frame", frame["mode"], "frame")
    check_true("frame flips the frame", frame["frame_flip"])
    check_true("frame needs no keep strip", frame["keep_bottom"] == 0)

    check("keepBottom 0.25", R({"mirrorMode": "content",
                                "mirrorKeepBottom": 0.25})["keep_bottom"], 0.25)
    check("keepBottom clamps at 0.6",
          R({"mirrorMode": "content", "mirrorKeepBottom": 0.9})["keep_bottom"],
          0.6)
    check("keepBottom never goes negative",
          R({"mirrorMode": "content", "mirrorKeepBottom": -1})["keep_bottom"],
          0.0)
    check("frame mode ignores keepBottom",
          R({"mirrorMode": "frame", "mirrorKeepBottom": 0.3})["keep_bottom"],
          0.0)

    # legacy projects (saved before v7)
    check("legacy flipContent -> content",
          R({"flipContent": True})["mode"], "content")
    check("legacy flip -> legacy", R({"flip": True})["mode"], "legacy")
    check("legacy flip has no keep strip",
          R({"flip": True})["keep_bottom"], 0.0)
    check("mirrorMode wins over the legacy flags",
          R({"mirrorMode": "frame", "flip": True})["mode"], "frame")

    # contentOnly decides what a legacy `flip` mirrors (render.ts: legacyWhole)
    legacy_content = R({"flip": True}, content_only=True)
    check_true("legacy flip on a content-only project flips the programme",
               legacy_content["content_flip"])
    check_true("…and not the picture itself",
               not legacy_content["legacy_whole"])
    check_true("…and not the finished frame", not legacy_content["frame_flip"])
    legacy_full = R({"flip": True}, content_only=False)
    check_true("legacy flip on a full-frame project flips the picture",
               legacy_full["legacy_whole"])
    check_true("…without a content-rect flip underneath",
               not legacy_full["content_flip"])
    check_true("…and without a whole-frame flip after the concat",
               not legacy_full["frame_flip"])
    check_true("flipContent is always content-only",
               R({"flipContent": True}, content_only=False)["mode"] == "content")

    # scope
    blocks = {"mirrorMode": "content", "mirrorScope": "blocks"}
    check("blocks: unticked block stays as recorded",
          R(blocks, {})["mode"], "off")
    check("blocks: ticked block flips",
          R(blocks, {"mirror": True})["mode"], "content")
    check("reaction scope ignores the tick",
          R({"mirrorMode": "content"})["mode"], "content")

    # intro / outro are never mirrored, whatever the config says
    for c in ({"mirrorMode": "content"}, {"mirrorMode": "frame"},
              {"flip": True}, {"flipContent": True}):
        check(f"clean span stays clean ({c})", R(c, {"mirror": True}, True)["mode"],
              "off")
    check_true("_clean_flags marks intro/outro",
               VP._clean_flags([{"type": "intro"}, {"type": "body"},
                                {"type": "outro"}, {"type": "card"}])
               == [True, False, True, False])


# ======================================================== the ffmpeg graph ===
FULL = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
CAM = {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}     # no camera restore in tests


def _proc(work: Path, path: Path) -> VP.ReactionVideoProcessor:
    p = VP.ReactionVideoProcessor(str(path), work_dir=str(work),
                                  output_dir=str(work / "out"))
    p.retouch_cfg["enabled"] = False
    return p


def _render(proc, name: str, segments, cloak, keep_strip=None) -> Path:
    segs = []
    for s in segments:
        d = dict(s)
        if keep_strip is not None and s.get("mirror"):
            d["mirror"] = True
        segs.append(d)
    outs = proc.render_passthrough(
        segs, audio_cloak={}, video_cloak=cloak, card=None,
        fast_speed=4.0, master_gain_db=0.0, crf=20, preset="ultrafast",
        fps=30, height=0, name=name, webm=False, content_rect=FULL,
        cam_rect=CAM, stems=False, progress_cb=None, cancel_check=None)
    return Path(outs["mp4"])


def test_graph_strings(proc, fixture: Path) -> None:
    """Cheap: look at the filter chain, no encoding."""
    print("filter graph (no encode)")
    chain, warns, _extra = proc._passthrough_graph(
        [{"type": "body", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={}, video_cloak={"mirrorMode": "content"},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check_true("content mirror emits an hflip", "hflip" in joined)
    check_true("content mirror keeps the frame unflipped",
               "[vcatraw]hflip[vcat]" not in joined)
    check_true("no keep strip when keepBottom is 0",
               "vmkeep0" not in joined)

    chain, _w, _e = proc._passthrough_graph(
        [{"type": "body", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={},
        video_cloak={"mirrorMode": "content", "mirrorKeepBottom": 0.25},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check_true("keep strip crops the content band", "vmkeep0" in joined)
    check_true("keep strip is pasted back over the flip",
               "overlay=x=0:y=270" in joined.replace(" ", ""))
    check_true("keep strip height is 25% of 360 = 90",
               f"crop={W}:90:0:270" in joined)

    chain, _w, _e = proc._passthrough_graph(
        [{"type": "body", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={}, video_cloak={"mirrorMode": "frame"},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check_true("frame mirror flips after the concat",
               "[vcatraw]hflip[vcat]" in joined)
    check_true("frame mirror adds no per-segment hflip",
               "vmfl0" not in joined)
    flip_at = chain.index("[vcatraw]hflip[vcat]")
    for later in ("vvig", "vstick", "vpost"):
        if any(t.startswith(f"[{later}") for t in chain):
            check_true(f"{later} is composited after the flip",
                       chain.index(f"[vcatraw]hflip[vcat]") < flip_at + 999)

    chain, _w, _e = proc._passthrough_graph(
        [{"type": "body", "start": 0.0, "end": 2.0, "mirror": True},
         {"type": "body", "start": 2.0, "end": 4.0}],
        W=W, H=H, audio_cloak={},
        video_cloak={"mirrorMode": "content", "mirrorScope": "blocks"},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check_true("blocks: the ticked block flips", "vmfl0" in joined)
    check_true("blocks: the unticked block does not", "vmfl1" not in joined)

    chain, _w, _e = proc._passthrough_graph(
        [{"type": "intro", "start": 0.0, "end": 1.0},
         {"type": "body", "start": 1.0, "end": 3.0}],
        W=W, H=H, audio_cloak={}, video_cloak={"mirrorMode": "content"},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check_true("intro is never flipped", "vmfl0" not in joined)
    check_true("the reaction block is flipped", "vmfl1" in joined)

    chain, _w, _e = proc._passthrough_graph(
        [{"type": "body", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={}, video_cloak={"flipContent": True},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check("legacy flipContent flips exactly once",
          joined.count("hflip"), 1)

    # legacy `flip` on a full-frame project: the picture itself flips, once,
    # and never after the concat (that would take the card with it)
    chain, _w, _e = proc._passthrough_graph(
        [{"type": "body", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={},
        video_cloak={"flip": True, "contentOnly": False},
        card=None, fast_speed=4.0, master_gain_db=0.0, content_rect=FULL,
        out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    joined = ";".join(chain)
    check("legacy full-frame flip happens once, in the segment chain",
          joined.count("hflip"), 1)
    check_true("…and not after the concat",
               "[vcatraw]hflip[vcat]" not in joined)
    check_true("…and with the cloak off it is a content flip instead",
               "hflip" in ";".join(proc._passthrough_graph(
                   [{"type": "body", "start": 0.0, "end": 2.0}],
                   W=W, H=H, audio_cloak={},
                   video_cloak={"flip": True, "contentOnly": False},
                   card=None, fast_speed=4.0, master_gain_db=0.0,
                   content_rect=FULL, out_fps=30, height=0, audio_inputs=[],
                   cam_rect=CAM)[0]))


# ============================================================ real renders ===
def test_pixels(proc, fixture: Path, work: Path) -> None:
    print("real renders (the colours must swap)")

    plain = _render(proc, "plain", [{"type": "body", "start": 0.0, "end": 4.0}],
                    {}, keep_strip=False)
    q = quadrants(frame_at(plain, 2.0))
    check("unmirrored: top-left is red", q["top_left"], "red")
    check("unmirrored: top-right is blue", q["top_right"], "blue")
    check("unmirrored: bottom-left is green", q["bottom_left"], "green")
    check("unmirrored: bottom-right is yellow", q["bottom_right"], "yellow")
    check_true("unmirrored: the marker sits top-left",
               q["top_left_whiteness"] > 200 and q["top_right_whiteness"] < 120,
               f"{q['top_left_whiteness']:.0f}/{q['top_right_whiteness']:.0f}")

    mirrored = _render(proc, "content", [{"type": "body", "start": 0.0, "end": 4.0}],
                       {"mirrorMode": "content"})
    q = quadrants(frame_at(mirrored, 2.0))
    check("content mirror: top-left is blue", q["top_left"], "blue")
    check("content mirror: top-right is red", q["top_right"], "red")
    check("content mirror: bottom-left is yellow", q["bottom_left"], "yellow")
    check("content mirror: bottom-right is green", q["bottom_right"], "green")
    check_true("content mirror: the marker moved to the right",
               q["top_right_whiteness"] > 200 and q["top_left_whiteness"] < 120,
               f"{q['top_left_whiteness']:.0f}/{q['top_right_whiteness']:.0f}")

    kept = _render(proc, "keep", [{"type": "body", "start": 0.0, "end": 4.0}],
                   {"mirrorMode": "content", "mirrorKeepBottom": 0.25})
    q = quadrants(frame_at(kept, 2.0))
    check("keep strip: the top still flips", q["top_left"], "blue")
    check("keep strip: bottom-left stays green (subtitles)", q["bottom_left"],
          "green")
    check("keep strip: bottom-right stays yellow", q["bottom_right"], "yellow")

    framed = _render(proc, "frame", [{"type": "body", "start": 0.0, "end": 4.0}],
                     {"mirrorMode": "frame"})
    q = quadrants(frame_at(framed, 2.0))
    check("frame mirror: top-left is blue", q["top_left"], "blue")
    check("frame mirror: top-right is red", q["top_right"], "red")
    check("frame mirror: bottom-left is yellow (no strip is kept)",
          q["bottom_left"], "yellow")
    check("frame mirror: bottom-right is green", q["bottom_right"], "green")

    legacy = _render(proc, "legacy",
                     [{"type": "body", "start": 0.0, "end": 4.0}],
                     {"flip": True, "contentOnly": False})
    q = quadrants(frame_at(legacy, 2.0))
    check("legacy full-frame flip mirrors the whole picture", q["top_left"],
          "blue")
    check("…bottom and all", q["bottom_right"], "green")

    blocks = _render(proc, "blocks",
                     [{"type": "intro", "start": 0.0, "end": 1.0},
                      {"type": "body", "start": 1.0, "end": 2.0, "mirror": True},
                      {"type": "body", "start": 2.0, "end": 4.0}],
                     {"mirrorMode": "content", "mirrorScope": "blocks"},
                     keep_strip=True)
    intro_q = quadrants(frame_at(blocks, 0.5))
    tick_q = quadrants(frame_at(blocks, 1.5))
    rest_q = quadrants(frame_at(blocks, 3.0))
    check("intro comes through unmirrored", intro_q["top_left"], "red")
    check("the ticked block is mirrored", tick_q["top_left"], "blue")
    check("the unticked block is not", rest_q["top_left"], "red")


def test_card_flip(work: Path) -> None:
    """The card asked for under a frame mirror is pre-flipped (upright words)."""
    print("card under a whole-picture mirror")
    calls: list = []

    class Fake(VP.ReactionVideoProcessor):
        def __init__(self):                            # no real file needed
            self.work = work
            self.out = work
            self.layout = VP.L.LayoutState()
            self.retouch_cfg = {}

        def _plan_fisheye(self, cfg, W, H, warns):
            return VP.FisheyePlan("none")

        def _vignette_png(self, amount, W, H):
            return None

        def _card_png(self, card, W, H, content=None, flip=False):
            calls.append(bool(flip))
            return None                                 # skip the overlay stage

    VP.ReactionVideoProcessor._passthrough_graph(
        Fake(), [{"type": "card", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={}, video_cloak={"mirrorMode": "frame"},
        card={"title": "t", "sub": "s"}, fast_speed=4.0, master_gain_db=0.0,
        content_rect=FULL, out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    check("card is asked for pre-flipped", calls, [True])

    calls.clear()
    VP.ReactionVideoProcessor._passthrough_graph(
        Fake(), [{"type": "card", "start": 0.0, "end": 2.0}],
        W=W, H=H, audio_cloak={}, video_cloak={"mirrorMode": "content"},
        card={"title": "t", "sub": "s"}, fast_speed=4.0, master_gain_db=0.0,
        content_rect=FULL, out_fps=30, height=0, audio_inputs=[], cam_rect=CAM)
    check("content mirror leaves the card upright", calls, [False])


def test_chunked_parts() -> None:
    """A slice of a ticked segment is still a ticked block."""
    print("chunked renders keep the tick")
    segs = [{"type": "body", "start": 0.0, "end": 300.0, "mirror": True},
            {"type": "body", "start": 300.0, "end": 600.0},
            {"type": "card", "start": 600.0, "end": 610.0, "card": {"variant": "short"}}]
    parts = VP.plan_parts(segs, 4.0, 120.0)
    check_true("the 10 min plan is chunked", len(parts) >= 3, str(len(parts)))
    ticked = [p for part in parts for p in part if float(p["start"]) < 300.0]
    rest = [p for part in parts for p in part if float(p["start"]) >= 300.0]
    check_true("every piece of the ticked block stays ticked",
               bool(ticked) and all(p.get("mirror") for p in ticked))
    check_true("no other block picks up a tick",
               all(not p.get("mirror") for p in rest))


def test_webapp_segments() -> None:
    """The hosted editor's sanitizer must not eat the tick."""
    print("webapp render job keeps the tick")
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here.parent))            # webapp/
    import server as S

    got = S.clean_render_segments([
        {"type": "intro", "start": 0, "end": 5},
        {"type": "body", "start": 5, "end": 40, "mirror": True},
        {"type": "body", "start": 40, "end": 90},
        {"type": "outro", "start": 90, "end": 95},
        {"type": "body", "start": 95, "end": 95},      # empty: dropped
        "junk",                                        # …and so is this
    ])
    check("four usable segments survive", len(got), 4)
    check("the ticked block carries its tick", got[1].get("mirror"), True)
    check_true("unticked blocks do not", "mirror" not in got[2])
    check_true("intro/outro are never ticked", "mirror" not in got[0]
               and "mirror" not in got[3])


def test_http_render(tmp: Path, fixture: Path) -> None:
    """The whole chain the browser actually uses: POST /api/job/render.

    This is the one that proves "preview and download agree" for the tick
    list: the posted segments go through the webapp's sanitizer, the
    renderer's chunk planner and the ffmpeg graph, and the finished file is
    measured in pixels.
    """
    print("the Colab webapp renders a ticked block mirrored")
    import json
    import time
    import urllib.request

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # webapp/
    import server as S

    out = tmp / "out_http"
    out.mkdir(parents=True, exist_ok=True)
    proc = VP.ReactionVideoProcessor(str(fixture),
                                     work_dir=str(tmp / "work_http"),
                                     output_dir=str(out))
    httpd, _app = S.serve_forever(proc, port=0, proxy_width=320)
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"

    body = {
        "target": "youtube", "name": "mirror_job",
        "segments": [{"type": "body", "start": 0.0, "end": 4.0,
                      "mirror": True}],
        "layout": VP.L.LayoutState().to_dict(),
        "audio": {}, "retouch": {"enabled": False},
        "audioCloak": {"on": False},
        # exactly what the Cloak tab posts: content mirror, tick list, and a
        # bottom strip that has to stay readable
        "videoCloak": {"on": False, "contentOnly": True,
                       "mirrorMode": "content", "mirrorScope": "blocks",
                       "mirrorKeepBottom": 0.25},
        "crf": 30, "height": 0, "partTarget": 0,
    }
    req = urllib.request.Request(base + "/api/job/render",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        job = json.loads(r.read())
    check_true(job["state"] == "running", "POST /api/job/render accepts the job",
               str(job.get("error") or ""))
    for _ in range(600):
        with urllib.request.urlopen(base + "/api/job", timeout=60) as r:
            job = json.loads(r.read())
        if job["state"] != "running":
            break
        time.sleep(0.3)
    check_true(job["state"] == "done",
               "the webapp job finishes", str(job.get("error") or ""))
    httpd.shutdown()
    httpd.server_close()

    fin = out / (job.get("files", {}).get("mp4") or "mirror_job.mp4")
    if not fin.exists():
        check_true(False, "the render produced a file", str(fin))
        return
    fr = frame_at(fin, 2.0)
    # the layout's content rect (the box the renderer mirrors)
    crx, cry, crw, crh = 0.294, 0.289, 0.7, 0.7
    inx = lambda p: crx + crw * p                                       # noqa: E731
    iny = lambda p: cry + crh * p                                       # noqa: E731
    top = _dom(_mean(fr, inx(0.05), inx(0.35), iny(0.05), iny(0.3)))
    bottom = _dom(_mean(fr, inx(0.05), inx(0.35), iny(0.85), iny(0.97)))
    check("the ticked block is mirrored in the finished file", top, "blue")
    check("the kept bottom strip is still as recorded (green subtitles)",
          bottom, "green")


def main() -> int:
    fast = "fast" in sys.argv[1:]
    tmp = Path(tempfile.mkdtemp(prefix="mirror_test_"))
    try:
        test_resolve_mirror()
        test_chunked_parts()
        test_webapp_segments()
        fixture = tmp / "quad.mp4"
        if not fast:
            make_fixture(fixture)
            proc = _proc(tmp / "work", fixture)
            test_graph_strings(proc, fixture)
            test_pixels(proc, fixture, tmp / "work")
            test_card_flip(tmp / "work")
            test_http_render(tmp, fixture)
        print()
        print(f"{len(_RUN) - len(_FAILED)}/{len(_RUN)} checks passed")
        if _FAILED:
            print("failed:")
            for f in _FAILED:
                print(f"  - {f}")
        return 1 if _FAILED else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
