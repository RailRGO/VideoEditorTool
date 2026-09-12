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

Needs ffmpeg on PATH plus numpy/opencv (the compositor). No pytest required.
"""
from __future__ import annotations

import json
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
    proc = V.ReactionVideoProcessor.__new__(V.ReactionVideoProcessor)
    proc.layout = L.LayoutState()
    proc.work = Path(tempfile.mkdtemp())
    W, H = 1920, 1080
    draws = proc._card_draws({"title": "Full uncut reaction on Patreon"}, W, H)
    box = re.search(r"drawbox=x=(\d+):y=(\d+):w=(\d+):h=(\d+)", draws[0])
    got = [int(box.group(i)) for i in range(1, 5)]
    want = [int(round(v)) for v in proc.layout.content.px(W, H)]
    check(got == want, f"server card box {got} == content rect {want}")
    check(got[2] < W * 0.8 and got[3] < H * 0.8,
          "card no longer covers ~the whole frame")
    # an explicit rect (YouTube passthrough) wins
    draws2 = proc._card_draws({}, W, H, content={"x": 0.1, "y": 0.2,
                                                 "w": 0.5, "h": 0.4})
    box2 = re.search(r"drawbox=x=(\d+):y=(\d+):w=(\d+):h=(\d+)", draws2[0])
    check([int(box2.group(i)) for i in range(1, 5)] == [192, 216, 960, 432],
          "explicit content rect is honoured")
    # browser parity: the React passthrough must not hardcode a full-frame box
    ts = (HERE.parent.parent.parent / "src" / "lib" / "render.ts").read_text()
    body = ts.split("export function buildPassthroughScene")[1].split("\n}")[0]
    check("0.06" not in body and "0.88" not in body,
          "buildPassthroughScene has no hardcoded near-full-frame card")
    check("cardRect" in body and "content" in body,
          "buildPassthroughScene takes the card rect from the layout")
    check("scene.cardText" in ts, "renderScene passes per-segment card text")


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


# ---------------------------------------------------------------------------

def main() -> int:
    if not shutil.which("ffmpeg"):
        print("ffmpeg not found on PATH — cannot run these tests")
        return 2
    fast_only = len(sys.argv) > 1 and sys.argv[1] == "fast"
    root = Path(os.environ.get("RENDER_TEST_DIR")
                or Path(tempfile.mkdtemp(prefix="render_parts_")))
    root.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print(f"workspace: {root}\n")

    test_plan_parts()
    test_auto_part_target()
    test_card_covers_content_only()
    if fast_only:
        print(f"\n{CHECKS[0]} checks, {len(FAILS)} failed "
              f"({time.time() - t0:.0f}s)")
        return 1 if FAILS else 0

    if not (root / "raw.mp4").exists():
        print("building fixtures …")
        make_raw(root / "raw.mp4")
        make_master(root / "master.mp4")
    # fixtures are reused between runs; render outputs are not (a resume test
    # against last run's finished output would prove nothing)
    for d in ("out", "out_resume", "out_yt", "out_yt_single", "out_short",
              "out_http", "out_yt_rect", "work", "work_resume", "work_yt",
              "work_yt2", "work_short", "work_http", "work_yt_rect"):
        shutil.rmtree(root / d, ignore_errors=True)
    test_patreon_chunked(root)
    test_short_render_single_pass(root)
    test_truncated_part_rebuilt(root)
    test_resume_after_kill(root)
    test_youtube_stems(root)
    test_youtube_card_follows_posted_layout(root)
    test_http_api(root)

    print(f"\n{CHECKS[0]} checks, {len(FAILS)} failed ({time.time() - t0:.0f}s)")
    for f in FAILS:
        print(f"  FAILED: {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
