#!/usr/bin/env python3
"""Voice morph + voice-bus targeting tests.

    cd colab_version
    python3 webapp/tests/test_voice_morph.py

What is covered, and why each check exists:

* the morph is EXACTLY duration preserving — a re-voiced content bus must
  never push the picture out of sync (this is the whole reason it is a
  phase-vocoder pass and not an asetrate/atempo chain).
* pitch and formant are independent: `pitch` moves the harmonics, `formant`
  moves the spectral envelope (the vocal tract). Measured on a synthetic
  voiced signal, not by reading the code.
* deterministic per seed (a re-render never changes the character) and
  different across seeds (two uploads of the same episode do not share one
  fingerprint).
* strength 0 = passthrough, so the slider's ends are honest.
* it runs on CPU at a sane multiple of realtime (no torch, no GPU).
* file round trip through ffmpeg keeps the sample count.
* the voice engine reaches the right BUS: content / mic / both, and the
  built-in morph works without stems while RVC keeps demanding them.
* a GPU-less runtime never picks h264_nvenc (the bug that killed a render
  on part 6 and killed the preview proxy with it).
* voiceKeepCardAudio keeps the re-voiced audio playing under card spans
  (single-pass AND chunked renders) while mute spans still silence and
  intro/outro stay exactly as recorded.
* the re-voiced bus is saved to the Drive voice_cache and pulled from there
  on a re-render with the same voice settings (bit-identical, bounded size).

Needs ffmpeg on PATH plus numpy. No pytest required.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

HERE = Path(__file__).resolve().parent
COLAB = HERE.parent.parent
for p in (str(COLAB), str(COLAB / "webapp")):
    if p not in sys.path:
        sys.path.insert(0, p)

import compose as C  # noqa: E402
import layouts as L  # noqa: E402
import video_processor as V  # noqa: E402
import voice_morph as M  # noqa: E402

FAILS: List[str] = []
CHECKS = [0]


def check(cond: bool, what: str) -> None:
    CHECKS[0] += 1
    if cond:
        print(f"  ok   {what}")
    else:
        FAILS.append(what)
        print(f"  FAIL {what}")


def _ff(args: List[str]) -> str:
    p = subprocess.run(["ffmpeg", "-y", "-v", "error", *args],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(args)}\n{p.stderr[-800:]}")
    return p.stderr


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def voiced(sr: int = 44100, secs: float = 3.0, f0: float = 120.0,
           vowel_hz: float = 700.0, seed: int = 7) -> np.ndarray:
    """Synthetic 'speech': a vibrating glottal source through a formant.

    Harmonics land at n*f0, the spectral envelope peaks at vowel_hz — so the
    two things the morph claims to control independently are measurable.
    """
    n = int(sr * secs)
    t = np.arange(n) / sr
    rng = np.random.default_rng(seed)
    f0t = f0 * (1.0 + 0.012 * np.sin(2 * math.pi * 4.7 * t)) \
        * (1.0 + 0.006 * np.cumsum(rng.standard_normal(n)) / n)
    pha = 2 * math.pi * np.cumsum(f0t) / sr
    src = np.zeros(n)
    for k in range(1, 26):
        src += np.sin(k * pha) / (k ** 1.1)
    f = np.fft.rfftfreq(n, d=1.0 / sr)
    env = np.exp(-0.5 * ((f - vowel_hz) / (vowel_hz * 0.30)) ** 2) \
        + 0.55 * np.exp(-0.5 * ((f - vowel_hz * 1.75) / (vowel_hz * 0.22)) ** 2)
    env *= np.exp(-f / 9000.0)
    out = np.fft.irfft(np.fft.rfft(src) * env, n=n)
    # syllable rhythm
    out *= 0.55 + 0.45 * np.abs(np.sin(2 * math.pi * 2.3 * t))
    return out / (np.max(np.abs(out)) + 1e-9) * 0.7


def write_wav(path: Path, data: np.ndarray, sr: int = 44100) -> None:
    if data.ndim == 1:
        data = data[:, None]
    pcm = np.clip(data, -1, 1)
    pcm = np.round(pcm * 32767).astype("<i2")
    import wave
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def read_wav(path: Path) -> tuple:
    import wave
    with wave.open(str(path), "rb") as w:
        ch, sr, n = w.getnchannels(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    return a.reshape(-1, ch), sr


def peak_hz(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    n = len(x)
    f = np.fft.rfftfreq(n, d=1.0 / sr)
    mag = np.abs(np.fft.rfft(x * np.hanning(n)))
    band = (f >= lo) & (f <= hi)
    return float(f[band][int(np.argmax(mag[band]))])


def f0_hz(x: np.ndarray, sr: int, lo: float = 50.0, hi: float = 500.0) -> float:
    """Fundamental by autocorrelation over the strongest frames.

    A plain spectral peak is useless here: the fixture is a harmonic stack and
    the morphed version spreads energy over many partials.
    """
    frame = int(sr * 0.04)                      # 40 ms
    hop = int(sr * 0.02)
    lag_lo, lag_hi = int(sr / hi), int(sr / lo)
    acc = np.zeros(lag_hi + 1, dtype=np.float64)
    used = 0
    for s0 in range(0, max(1, len(x) - frame), hop):
        seg = x[s0:s0 + frame]
        if len(seg) < frame:
            break
        if float(np.sqrt(np.mean(seg ** 2))) < 0.02:
            continue
        seg = seg - seg.mean()
        c = np.correlate(seg, seg, mode="full")[len(seg) - 1:]
        if len(c) <= lag_hi:
            continue
        acc += c[:lag_hi + 1] / (c[0] + 1e-12)
        used += 1
    if not used:
        return 0.0
    window = acc[lag_lo:lag_hi + 1]
    lag = int(lag_lo + int(np.argmax(window)))
    return float(sr / max(1, lag))


def envelope_peak(x: np.ndarray, sr: int, lo: float = 200.0,
                  hi: float = 4000.0) -> float:
    """Where the vocal tract resonates: peak of the smoothed magnitude spectrum.

    A ~150 Hz moving average flattens the harmonic comb, so what is left is
    the spectral envelope — the thing a formant shift must move and a pitch
    shift must not. (A spectral *centroid* is useless here: the fixture's
    harmonics decay with 1/k, so moving energy around the band drags the
    centroid with it.)
    """
    n = len(x)
    f = np.fft.rfftfreq(n, d=1.0 / sr)
    mag = np.abs(np.fft.rfft(x * np.hanning(n)))
    k = max(9, int(n / sr * 150))
    if k % 2 == 0:
        k += 1
    sm = np.convolve(mag, np.ones(k) / k, mode="same")
    band = (f >= lo) & (f <= hi)
    return float(f[band][int(np.argmax(sm[band]))])


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

def test_duration_exact():
    print("duration")
    sr = 44100
    x = voiced(sr, 3.0)
    for preset in ("incognito", "deep", "bright", "robot", "alien"):
        plan = M.plan_for({"morphPreset": preset, "morphStrength": 100,
                           "morphSeed": 3})
        y = M.morph_channel(x, sr, plan, seed=3.0)
        check(len(y) == len(x),
              f"{preset}: output is exactly {len(x)} samples "
              f"(got {len(y)}, Δ {len(y) - len(x)})")


def test_pitch_and_formant_are_independent():
    print("pitch / formant")
    sr = 44100
    x = voiced(sr, 3.0, f0=120.0, vowel_hz=700.0)
    f0_in = f0_hz(x, sr)
    env_in = envelope_peak(x, sr)
    check(abs(f0_in - 120.0) < 8.0, f"the fixture's f0 measures {f0_in:.0f} Hz")

    def morph(cfg: Dict[str, Any]) -> np.ndarray:
        return M.morph_channel(x, sr, M.plan_for(cfg), seed=1.0)

    # --- pitch: the harmonics move, the tract and the length do not --------
    y = morph({"morphPreset": "custom", "morphStrength": 100,
               "morphFormant": 1.0, "voicePitch": 7.0})
    f0_up = f0_hz(y, sr)
    check(abs(f0_up / f0_in - 2 ** (7 / 12)) < 0.06,
          f"pitch +7 st moves f0 {f0_in:.0f}→{f0_up:.0f} Hz "
          f"(ratio {f0_up / f0_in:.3f}, want {2 ** (7 / 12):.3f})")
    check(len(y) == len(x), "pitch shift keeps the sample count")

    y2 = morph({"morphPreset": "custom", "morphStrength": 100,
                "morphFormant": 1.0, "voicePitch": -5.0})
    f0_dn = f0_hz(y2, sr)
    check(abs(f0_dn / f0_in - 2 ** (-5 / 12)) < 0.06,
          f"pitch −5 st moves f0 {f0_in:.0f}→{f0_dn:.0f} Hz "
          f"(ratio {f0_dn / f0_in:.3f}, want {2 ** (-5 / 12):.3f})")

    # --- formant: the tract moves, f0 does not ---------------------------
    # measured as the shift of the first formant bump (F1 = 700 Hz in the
    # fixture). Vibrato is switched off for these numbers on purpose: pitch
    # modulation puts ±4 Hz sidebands on every partial, which a smoothed
    # spectrum reads as a several-dB level lift — a real effect, but it has
    # nothing to do with where the formant sits.
    def bump_hz(v: np.ndarray, lo: float = 300.0, hi: float = 1100.0) -> float:
        n = len(v)
        f = np.fft.rfftfreq(n, d=1.0 / sr)
        mag = np.abs(np.fft.rfft(v * np.hanning(n)))
        k = max(9, int(n / sr * 150))
        k += (k % 2 == 0)
        sm = np.convolve(mag, np.ones(k) / k, mode="same")
        band = (f >= lo) & (f <= hi)
        return float(f[band][int(np.argmax(sm[band]))])

    def steady(cfg: Dict[str, Any]) -> np.ndarray:
        plan = M.plan_for(cfg)
        plan["vibDepth"] = 0.0
        plan["drift"] = 0.0
        return M.morph_channel(x, sr, plan, seed=1.0)

    def band_db(v: np.ndarray, lo: float, hi: float) -> float:
        n = len(v)
        f = np.fft.rfftfreq(n, d=1.0 / sr)
        mag = np.abs(np.fft.rfft(v * np.hanning(n)))
        b = (f >= lo) & (f <= hi)
        return float(10 * np.log10(np.mean(mag[b] ** 2) + 1e-18))

    # an upward tract shift moves energy from below the formant to above it;
    # on this fixture the 1.25 shift is bigger than one 150 Hz smoothing
    # window, so the direction is measured as a tilt, not as an argmax (the
    # fixture's second formant sits right where the energy lands)
    tilt_in = band_db(x, 1000, 2000) - band_db(x, 300, 600)
    f1_in = bump_hz(x)
    y3 = steady({"morphPreset": "custom", "morphStrength": 100,
                 "morphFormant": 1.25, "voicePitch": 0.0})
    f0_f = f0_hz(y3, sr)
    tilt_up = band_db(y3, 1000, 2000) - band_db(y3, 300, 600)
    check(abs(f0_f - f0_in) / f0_in < 0.06,
          f"formant 1.25 leaves f0 alone ({f0_in:.0f}→{f0_f:.0f} Hz)")
    check(tilt_up > tilt_in + 3.0,
          f"formant 1.25 lifts the tract ({tilt_in:+.1f}→{tilt_up:+.1f} dB "
          f"of 1-2 kHz over 300-600 Hz)")
    check(len(y3) == len(x), "formant shift keeps the sample count")

    y4 = steady({"morphPreset": "custom", "morphStrength": 100,
                 "morphFormant": 0.80, "voicePitch": 0.0})
    f1_dn, f0_d = bump_hz(y4), f0_hz(y4, sr)
    check(abs(f0_d - f0_in) / f0_in < 0.06,
          f"formant 0.80 leaves f0 alone ({f0_in:.0f}→{f0_d:.0f} Hz)")
    check(f1_dn < f1_in * 0.90,
          f"formant 0.80 drops the first formant ({f1_in:.0f}→{f1_dn:.0f} Hz)")

    y5 = steady({"morphPreset": "custom", "morphStrength": 100,
                 "morphFormant": 1.0, "voicePitch": 0.0})
    check(abs(bump_hz(y5) - f1_in) / f1_in < 0.04,
          f"formant 1.00 leaves the tract alone ({f1_in:.0f}→{bump_hz(y5):.0f} Hz)")

    # --- vibrato: wobbles the pitch, does not move the tract -------------
    vib = M.morph_channel(x, sr, M.plan_for(
        {"morphPreset": "custom", "morphStrength": 100, "morphFormant": 1.0,
         "voicePitch": 0.0}), seed=1.0)
    f0s = [f0_hz(vib[i:i + sr // 10], sr) for i in range(0, len(vib) - sr // 10,
                                                         sr // 20)]
    wobble = float(np.std(f0s))
    check(wobble > 0.3,
          f"vibrato actually wobbles the pitch (σ {wobble:.2f} Hz over "
          f"{len(f0s)} windows)")
    check(abs(float(np.mean(f0s)) - f0_in) / f0_in < 0.05,
          f"the wobble stays centred on the target f0 "
          f"({float(np.mean(f0s)):.1f} vs {f0_in:.1f} Hz)")
    check(not np.any(np.isnan(vib)) and float(np.max(np.abs(vib))) < 1.0,
          "vibrato output stays finite and inside full scale")

    # --- what the shipped characters do to a voice -----------------------
    for preset, lo in (("deep", True), ("bright", False)):
        p = M.plan_for({"morphPreset": preset, "morphStrength": 100,
                        "morphSeed": 1})
        p["vibDepth"] = 0.0
        p["drift"] = 0.0
        y6 = M.morph_channel(x, sr, p, seed=1.0)
        f6, b6 = f0_hz(y6, sr), bump_hz(y6)
        want_f0 = f0_in * 2 ** (p["pitch"] / 12.0)
        ok_f0 = abs(f6 - want_f0) / want_f0 < 0.08
        ok_len = len(y6) == len(x)
        ok_env = (b6 < f1_in * 0.95) if lo else (b6 > f1_in * 1.05)
        check(ok_f0 and ok_len and ok_env,
              f"{preset}: f0 {f0_in:.0f}→{f6:.0f} Hz (want {want_f0:.0f}), "
              f"F1 {f1_in:.0f}→{b6:.0f} Hz — a different vocal tract")


def test_deterministic_and_seed_sensitive():
    print("determinism")
    sr = 44100
    x = voiced(sr, 2.0)
    cfg = {"morphPreset": "incognito", "morphStrength": 90}
    a = M.morph_channel(x, sr, M.plan_for({**cfg, "morphSeed": 11}), seed=11.0)
    b = M.morph_channel(x, sr, M.plan_for({**cfg, "morphSeed": 11}), seed=11.0)
    check(float(np.max(np.abs(a - b))) < 1e-9,
          "same seed → bit-identical output (a re-render never re-casts)")
    c = M.morph_channel(x, sr, M.plan_for({**cfg, "morphSeed": 12}), seed=12.0)
    check(float(np.max(np.abs(a - c))) > 1e-4,
          "different seed → different voice (per-upload variation)")

    def log_spec(v: np.ndarray) -> np.ndarray:
        n = len(v)
        f = np.fft.rfftfreq(n, d=1 / sr)
        mag = np.abs(np.fft.rfft(v * np.hanning(n))) + 1e-9
        k = 513
        sm = np.convolve(mag, np.ones(k) / k, mode="same")
        band = (f >= 150) & (f <= 6000)
        ls = 20 * np.log10(sm[band])
        return ls - ls.mean()

    d_spec = float(np.sqrt(np.mean((log_spec(a) - log_spec(c)) ** 2)))
    check(d_spec > 0.5,
          f"different seed → different vocal tract ({d_spec:.2f} dB rms "
          f"between the two spectral envelopes)")
    same = float(np.sqrt(np.mean((log_spec(a) - log_spec(b)) ** 2)))
    check(same < 1e-6, f"same seed → identical spectral envelope ({same:.2e})")
    d = M.morph_channel(x, sr, M.plan_for({**cfg, "morphSeed": 11}), seed=11.0)
    check(float(np.max(np.abs(a - d))) < 1e-9, "plan_for is stable")


def test_strength_zero_is_passthrough():
    print("strength")
    sr = 44100
    x = voiced(sr, 1.5)
    plan = M.plan_for({"morphPreset": "incognito", "morphStrength": 0})
    check(plan["wet"] < 1e-6 and abs(plan["pitch"]) < 1e-9
          and abs(plan["formant"] - 1.0) < 1e-9,
          "strength 0 plans a pure dry passthrough")
    y = M.morph_channel(x, sr, plan, seed=5.0)
    check(not np.any(np.isnan(y)) and np.max(np.abs(y)) < 1.0,
          f"strength 0 output is finite and in range (peak "
          f"{np.max(np.abs(y)):.3f})")
    check(float(np.max(np.abs(x - y))) < 0.35,
          "strength 0 stays close to the source (dry path)")
    full = M.plan_for({"morphPreset": "incognito", "morphStrength": 100})
    y2 = M.morph_channel(x, sr, full, seed=5.0)
    check(float(np.sqrt(np.mean((y - y2) ** 2))) > 1e-3,
          "strength 0 and strength 100 are audibly different")


def test_speed_on_cpu():
    print("speed")
    sr = 44100
    x = np.stack([voiced(sr, 20.0), voiced(sr, 20.0, seed=9)], axis=1)
    plan = M.plan_for({"morphPreset": "incognito", "morphStrength": 100,
                       "morphSeed": 1})
    t0 = time.time()
    y = M.morph(x, sr, plan)
    el = time.time() - t0
    rt = 20.0 / max(1e-6, el)
    check(rt > 3.0,
          f"20 s of stereo morphed in {el:.1f} s on cpu = {rt:.1f}x realtime")
    check(y.shape == x.shape, f"stereo shape preserved {x.shape} → {y.shape}")
    check(not np.any(np.isnan(y)), "no NaN in the stereo output")
    rms_in = float(np.sqrt(np.mean(x ** 2)))
    rms_out = float(np.sqrt(np.mean(y ** 2)))
    check(abs(20 * math.log10(rms_out / max(1e-9, rms_in))) < 3.0,
          f"loudness held: {rms_in:.4f} → {rms_out:.4f} rms "
          f"({20 * math.log10(rms_out / max(1e-9, rms_in)):+.1f} dB)")


def test_file_roundtrip():
    print("file round trip")
    if not shutil.which("ffmpeg"):
        print("  (skipped — no ffmpeg)")
        return
    tmp = Path(tempfile.mkdtemp(prefix="voice_morph_"))
    try:
        sr = 44100
        src = tmp / "in.wav"
        x = np.stack([voiced(sr, 4.0), voiced(sr, 4.0, f0=150.0)], axis=1)
        write_wav(src, x, sr)
        dst = tmp / "out.wav"
        M.morph_file(src, dst, {"morphPreset": "deep", "morphStrength": 85,
                                "morphSeed": 4})
        y, sr2 = read_wav(dst)
        check(sr2 == sr, f"sample rate kept ({sr2})")
        check(y.shape[0] == x.shape[0],
              f"wav sample count kept ({x.shape[0]} → {y.shape[0]})")
        # non-wav input (ffmpeg decode)
        m4a = tmp / "in.m4a"
        _ff(["-i", str(src), "-c:a", "aac", "-b:a", "128k", str(m4a)])
        dst2 = tmp / "out2.wav"
        M.morph_file(m4a, dst2, {"morphPreset": "bright",
                                 "morphStrength": 80})
        y2, _ = read_wav(dst2)
        dur_in = x.shape[0] / sr
        dur_out = y2.shape[0] / max(1, int(read_wav(dst2)[1]))
        check(abs(dur_out - dur_in) < 0.05,
              f"m4a → wav keeps the duration ({dur_in:.3f}s → {dur_out:.3f}s)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_preset_table():
    print("presets")
    names = M.preset_names()
    check(len(names) >= 6, f"{len(names)} built-in characters available")
    for n in names:
        p = M.plan_for({"morphPreset": n, "morphStrength": 100,
                        "morphSeed": 0})
        ok = (0.5 <= p["formant"] <= 2.0 and -12 <= p["pitch"] <= 12
              and not math.isnan(p["vibDepth"]))
        check(ok, f"{n}: plan stays in range (pitch {p['pitch']:+.1f} st, "
                  f"formant {p['formant']:.2f})")


def test_target_and_mode_helpers():
    print("targeting")
    cases = [
        (None, set()),
        ({}, set()),
        ({"voiceChanger": False, "voiceTarget": "content"}, set()),
        ({"voiceChanger": True, "voiceTarget": "content"}, {"content"}),
        ({"voiceChanger": True, "voiceTarget": "mic"}, {"mic"}),
        ({"voiceChanger": True, "voiceTarget": "both"}, {"mic", "content"}),
        # legacy projects: no voiceTarget key == the old mic-only behaviour
        ({"voiceChanger": True}, {"mic"}),
    ]
    for cfg, want in cases:
        got = V._voice_targets(cfg)
        check(got == want, f"_voice_targets({cfg}) → {sorted(got) or 'off'}")
    check(V._voice_mode({"voiceChanger": True, "voiceMode": "morph"}) == "morph",
          "voiceMode morph is recognised")
    check(V._voice_mode({"voiceChanger": True, "voiceMode": "rvc"}) == "rvc",
          "voiceMode rvc still recognised")
    check(V._voice_mode({"voiceChanger": True, "voiceMode": "fx"}) == "fx",
          "voiceMode fx still recognised")
    check(V._voice_mode({"voiceChanger": True}) == "morph",
          "the default engine is the built-in morph (no downloads, no gpu)")


def _master(path: Path, dur: int = 8, rate: int = 30) -> Path:
    """A 3-track Patreon master: 1 = mix, 2 = content, 3 = mic."""
    mic = path.parent / "_mic.wav"
    con = path.parent / "_con.wav"
    mix = path.parent / "_mix.wav"
    _ff(["-f", "lavfi", "-i",
         f"sine=frequency=440:sample_rate=44100:duration={dur}",
         "-c:a", "pcm_s16le", str(mic)])
    _ff(["-f", "lavfi", "-i",
         f"sine=frequency=660:sample_rate=44100:duration={dur}",
         "-c:a", "pcm_s16le", str(con)])
    _ff(["-i", str(mic), "-i", str(con), "-filter_complex",
         "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]",
         "-map", "[a]", "-c:a", "pcm_s16le", str(mix)])
    _ff(["-f", "lavfi", "-i",
         f"testsrc=size=640x360:rate={rate}:duration={dur}",
         "-i", str(mix), "-i", str(con), "-i", str(mic),
         "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
         "-c:a", "aac", "-b:a", "96k", "-shortest", str(path)])
    return path


def _segments(dur: float) -> List[Dict[str, Any]]:
    return [
        {"id": "i", "type": "intro", "start": 0.0, "end": 1.0},
        {"id": "b", "type": "body", "start": 1.0, "end": dur - 1.0},
        {"id": "m", "type": "mute", "start": dur - 1.0, "end": dur},
    ]


def _spectrum(path: Path, t: float, stream: int, dur: float = 0.5) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{t}", "-t", f"{dur}",
         "-i", str(path), "-map", f"0:a:{stream}", "-ac", "1", "-ar", "22050",
         "-f", "f32le", "-"], capture_output=True)
    a = np.frombuffer(raw.stdout, dtype="<f4")
    return a


def _dominant(a: np.ndarray) -> float:
    """The loudest partial of a sample buffer (0.0 when there is nothing)."""
    if len(a) < 512:
        return 0.0
    f = np.fft.rfftfreq(len(a), d=1 / 22050)
    mag = np.abs(np.fft.rfft(a * np.hanning(len(a))))
    band = (f > 80) & (f < 6000)
    if not band.any():
        return 0.0
    return float(f[band][int(np.argmax(mag[band]))])


def test_render_morphs_the_content_bus():
    """End to end: a real passthrough render, morphed content, natural mic."""
    print("render: built-in morph on the content bus")
    if not shutil.which("ffmpeg"):
        print("  (skipped — no ffmpeg)")
        return
    tmp = Path(tempfile.mkdtemp(prefix="voice_render_"))
    try:
        import layouts as L
        src = _master(tmp / "master.mp4", dur=8)
        proc = V.ReactionVideoProcessor(str(src), work_dir=str(tmp / "work"),
                                        output_dir=str(tmp / "out"))
        segs = _segments(8.0)
        cloak = dict(L.default_audio_cloak())
        cloak.update({"on": False, "voiceChanger": True, "voiceMode": "morph",
                      "voiceTarget": "content", "morphPreset": "deep",
                      "morphStrength": 100, "morphSeed": 2})

        # -- the bus level: exactly what the render feeds the graph ----------
        gs = 1.0
        runs, _off, _tot = V._passthrough_runs(segs, 4.0, gs)
        con = proc._conform_passthrough_bus(segs, 4.0, gs, 0.08, "0:a:1",
                                            silence_types=("mute", "card"),
                                            tag="t_con")
        mic = proc._conform_passthrough_bus(segs, 4.0, gs, 0.08, "0:a:2",
                                            tag="t_mic")
        check(abs(proc._media_duration(str(con)) - 8.0) < 0.05,
              f"the conformed content bus is on the output timeline "
              f"({proc._media_duration(str(con)):.2f}s of 8.00s)")
        con_v = V._voice_apply(proc, con, runs, cloak, "content", tag="t_cv")
        mic_v = V._voice_apply(proc, mic, runs, cloak, "mic", tag="t_mv")
        check(con_v != con, "the content bus came back re-voiced")
        check(mic_v == mic, "the mic bus was left alone (voiceTarget=content)")
        a0 = _read_wav(con, 3.0, 0.5)
        a1 = _read_wav(con_v, 3.0, 0.5)
        check(abs(len(a1) - len(a0)) <= 32,
              f"the morphed bus is sample-accurate ({len(a1)} vs {len(a0)})")
        d0, d1 = _dominant(a0), _dominant(a1)
        check(abs(d0 - 660) < 40, f"the content bus carries its 660 Hz tone "
                                  f"({d0:.0f} Hz)")
        check(abs(d1 - 660) > 40, f"after the morph the content tone moved "
                                  f"({d0:.0f} → {d1:.0f} Hz)")
        # the mute span: silenced BEFORE the morph, so the converter skipped it
        z0 = _read_wav(con, 7.6, 0.3)
        z1 = _read_wav(con_v, 7.6, 0.3)
        check(float(np.max(np.abs(z0))) < 0.01,
              "the mute span is silent on the conformed content bus")
        check(float(np.max(np.abs(z1))) < 0.01,
              "the morph leaves the mute span silent (no breath floor)")

        # -- the full render -------------------------------------------------
        base = proc.render_passthrough(
            segs, audio_cloak=dict(cloak, voiceChanger=False), name="base")
        got = proc.render_passthrough(segs, audio_cloak=cloak, name="morphed")
        bd = proc._media_duration(base["mp4"])
        gd = proc._media_duration(got["mp4"])
        check(abs(bd - gd) < 0.2,
              f"the morphed render is the same length "
              f"({bd:.2f}s vs {gd:.2f}s) — A/V stays aligned")
        check(Path(base["mp4"]).stat().st_size > 10_000
              and Path(got["mp4"]).stat().st_size > 10_000,
              "both renders produced a real file")
        mb = _spectrum(base["mp4"], 3.0, 0)
        mg = _spectrum(got["mp4"], 3.0, 0)
        check(len(mb) > 1000 and len(mg) > 1000,
              "both renders carry audio in the reaction part")
        # the published mix carries content(660) + mic(440): the content half
        # must move, so the spectrum above 500 Hz has to change shape
        fb, fg = _band_energy(mb), _band_energy(mg)
        check(fb and fg and abs(10 * math.log10(fg / max(fb, 1e-12))) > 1.0,
              f"the published audio changed above 500 Hz "
              f"({10 * math.log10(fg / max(fb, 1e-12)):+.1f} dB) — the content "
              f"bus was re-voiced, not just re-gained")
        # The mute span silences the CONTENT bus; the mic is never silenced
        # (that is the whole point of a mute span — your voice carries on over
        # a card). So the check is that the mute span looks exactly as quiet
        # as the baseline render's, i.e. no content leaked back in.
        late = max(0.1, gd - 0.4)
        zb = _spectrum(base["mp4"], late, 0, dur=0.3)
        zg = _spectrum(got["mp4"], late, 0, dur=0.3)
        rb = float(np.sqrt(np.mean(zb ** 2))) if len(zb) else -1.0
        rg = float(np.sqrt(np.mean(zg ** 2))) if len(zg) else -1.0
        check(rb > 0 and abs(rg - rb) / rb < 0.15,
              f"the mute span is as quiet as the baseline "
              f"({rg:.4f} vs {rb:.4f} rms) — no content audio leaked past it")
        # and the mic must still be the mic in the reaction part: the morph
        # targets the content bus, so a rubberband/pitch stage left over on
        # the mic bus would show up as the 440 Hz tone having moved
        micb = _spectrum(base["mp4"], 3.0, 0, dur=0.5)
        micg = _spectrum(got["mp4"], 3.0, 0, dur=0.5)
        fb = _band_energy(micb, 425.0, 455.0)
        fg = _band_energy(micg, 425.0, 455.0)
        check(fb > 0 and fg > 0.5 * fb,
              f"the mic keeps its own 440 Hz tone through the render "
              f"({10 * math.log10(fg / max(fb, 1e-12)):+.1f} dB vs baseline)")

        # -- a source with one mixed track still gets morphed ----------------
        mono = tmp / "single.mp4"
        _ff(["-f", "lavfi", "-i",
             "testsrc=size=640x360:rate=30:duration=8",
             "-f", "lavfi", "-i",
             "sine=frequency=660:sample_rate=44100:duration=8",
             "-map", "0:v", "-map", "1:a", "-c:v", "libx264",
             "-preset", "ultrafast", "-crf", "30", "-c:a", "aac",
             "-shortest", str(mono)])
        proc2 = V.ReactionVideoProcessor(str(mono), work_dir=str(tmp / "w2"),
                                         output_dir=str(tmp / "o2"))
        one = proc2.render_passthrough(segs, audio_cloak=cloak, name="single")
        check(abs(proc2._media_duration(one["mp4"]) - 8.0) < 0.2,
              "a single-track source renders too (the mixed track is the "
              "programme)")
        m1 = _spectrum(one["mp4"], 3.0, 0)
        check(abs(_dominant(m1) - 660) > 40,
              f"the single mixed track was re-voiced ({_dominant(m1):.0f} Hz)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _read_wav(path: Path, t: float, dur: float = 0.5) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{t}", "-t", f"{dur}",
         "-i", str(path), "-ac", "1", "-ar", "22050", "-f", "f32le", "-"],
        capture_output=True)
    return np.frombuffer(raw.stdout, dtype="<f4")


def _band_energy(a: np.ndarray, lo: float = 500.0, hi: float = 8000.0) -> float:
    if len(a) < 512:
        return 0.0
    f = np.fft.rfftfreq(len(a), d=1 / 22050)
    mag = np.abs(np.fft.rfft(a * np.hanning(len(a))))
    band = (f >= lo) & (f <= hi)
    return float(np.sum(mag[band] ** 2)) if band.any() else 0.0


def test_keep_card_audio_flag():
    print("keep-card-audio flag")
    check(V._voice_keep_card_audio(None) is False,
          "off by default — cards keep muting")
    check(V._voice_keep_card_audio(
        {"voiceChanger": False, "voiceKeepCardAudio": True,
         "voiceTarget": "content"}) is False,
        "the flag alone does nothing — the voice changer must be on")
    check(V._voice_keep_card_audio(
        {"voiceChanger": True, "voiceKeepCardAudio": True,
         "voiceTarget": "content"}) is True,
        "voice changer on the content bus + flag → cards keep the audio")
    check(V._voice_keep_card_audio(
        {"voiceChanger": True, "voiceKeepCardAudio": True,
         "voiceTarget": "both"}) is True,
        "the everyone-same-voice target also keeps the card audio")
    check(V._voice_keep_card_audio(
        {"voiceChanger": True, "voiceKeepCardAudio": True,
         "voiceTarget": "mic"}) is False,
        "mic-only leaves the programme unaltered — cards keep muting it")
    check(V._voice_keep_card_audio(
        {"voiceChanger": True, "voiceKeepCardAudio": True}) is False,
        "legacy project (no voiceTarget = mic-only) keeps muting cards")
    check(V._voice_keep_card_audio({"voiceChanger": True,
                                    "voiceTarget": "content"}) is False,
        "voice changer without the flag still mutes cards (old behaviour)")


def _card_segments() -> List[Dict[str, Any]]:
    return [
        {"id": "i", "type": "intro", "start": 0.0, "end": 1.0},
        {"id": "b", "type": "body", "start": 1.0, "end": 4.0},
        {"id": "c", "type": "card", "start": 4.0, "end": 6.0},
        {"id": "m", "type": "mute", "start": 6.0, "end": 7.0},
        {"id": "o", "type": "outro", "start": 7.0, "end": 8.0},
    ]


def test_cards_keep_the_revoiced_audio():
    """voiceKeepCardAudio: the whole altered audio plays through the cards.

    Cards normally mute the programme (they hide a claimed stretch); once the
    voice changer re-voices it there is nothing left to hide, so with the
    flag on the re-voiced audio keeps playing. Mute spans still silence, and
    intro/outro are never altered — only the reaction part is.
    """
    print("render: cards keep the re-voiced audio")
    if not shutil.which("ffmpeg"):
        print("  (skipped — no ffmpeg)")
        return
    tmp = Path(tempfile.mkdtemp(prefix="voice_card_"))
    try:
        src = _master(tmp / "master.mp4", dur=8)
        proc = V.ReactionVideoProcessor(str(src), work_dir=str(tmp / "work"),
                                        output_dir=str(tmp / "out"))
        segs = _card_segments()
        cloak = dict(L.default_audio_cloak())
        cloak.update({"on": False, "voiceChanger": True, "voiceMode": "morph",
                      "voiceTarget": "content", "morphPreset": "deep",
                      "morphStrength": 100, "morphSeed": 2})

        # -- the bus level: the silence set is the knob ----------------------
        con_m = proc._conform_passthrough_bus(segs, 4.0, 1.0, 0.08, "0:a:1",
                                              silence_types=("mute", "card"),
                                              tag="kc_m")
        con_k = proc._conform_passthrough_bus(segs, 4.0, 1.0, 0.08, "0:a:1",
                                              silence_types=("mute",),
                                              tag="kc_k")
        check(_band_energy(_read_wav(con_m, 4.5, 1.0)) < 1e-4,
              "as before: the conformed content bus is silent in a card span")
        check(_band_energy(_read_wav(con_k, 4.5, 1.0)) > 1.0,
              "flag on: the conformed content bus keeps playing in the card")
        check(_band_energy(_read_wav(con_k, 6.4, 0.4)) < 1e-4,
              "flag on or off: a MUTE span still silences the content bus")

        # -- full renders -----------------------------------------------------
        muted = proc.render_passthrough(
            segs, audio_cloak=dict(cloak, voiceKeepCardAudio=False),
            name="cards_muted")
        kept = proc.render_passthrough(
            segs, audio_cloak=dict(cloak, voiceKeepCardAudio=True),
            name="cards_kept")
        md = proc._media_duration(muted["mp4"])
        kd = proc._media_duration(kept["mp4"])
        check(abs(md - kd) < 0.2,
              f"both renders are the same length ({md:.2f}s vs {kd:.2f}s)")
        card_m = _band_energy(_spectrum(muted["mp4"], 4.5, 0, dur=1.0))
        card_k = _band_energy(_spectrum(kept["mp4"], 4.5, 0, dur=1.0))
        check(card_k > 10.0 * max(card_m, 1e-9),
              f"the card span carries the altered audio when the flag is on "
              f"(card energy {card_m:.2g} → {card_k:.2g} above 500 Hz)")
        mute_m = _band_energy(_spectrum(muted["mp4"], 6.4, 0, dur=0.4))
        mute_k = _band_energy(_spectrum(kept["mp4"], 6.4, 0, dur=0.4))
        check(mute_k < max(2.0 * mute_m, 1e-6),
              f"the mute span stays silent either way "
              f"({mute_m:.2g} vs {mute_k:.2g})")
        body_k = _band_energy(_spectrum(kept["mp4"], 2.0, 0, dur=0.8))
        check(body_k > 10.0 * max(card_m, 1e-9),
              "the reaction body carries the re-voiced content as always")
        # intro/outro pass through untouched: identical energy in both renders
        intro_m = _band_energy(_spectrum(muted["mp4"], 0.3, 0, dur=0.5),
                               lo=400.0)
        intro_k = _band_energy(_spectrum(kept["mp4"], 0.3, 0, dur=0.5),
                               lo=400.0)
        check(intro_m > 0 and abs(intro_k - intro_m) / intro_m < 0.15,
              f"the intro is exactly as recorded either way "
              f"({intro_m:.2g} vs {intro_k:.2g})")
        outro_m = _band_energy(_spectrum(muted["mp4"], 7.3, 0, dur=0.5),
                               lo=400.0)
        outro_k = _band_energy(_spectrum(kept["mp4"], 7.3, 0, dur=0.5),
                               lo=400.0)
        check(outro_m > 0 and abs(outro_k - outro_m) / outro_m < 0.15,
              f"the outro is exactly as recorded either way "
              f"({outro_m:.2g} vs {outro_k:.2g})")

        # -- the same flag through the chunked render path --------------------
        chunk = proc.render_project(
            target="youtube", name="chunk_cards_kept", segments=segs,
            audio_cloak=dict(cloak, voiceKeepCardAudio=True),
            part_target=2.0, min_part=1.0)
        check(bool(chunk.get("chunked")),
              "the 8 s programme really rendered in parts")
        cchunk = _band_energy(_spectrum(chunk["mp4"], 4.5, 0, dur=1.0))
        mchunk = _band_energy(_spectrum(chunk["mp4"], 6.4, 0, dur=0.4))
        check(cchunk > 10.0 * max(card_m, 1e-9),
              f"chunked render: the card span keeps the altered audio "
              f"({cchunk:.2g} above 500 Hz)")
        check(mchunk < max(2.0 * mute_m, 1e-6),
              f"chunked render: the mute span still silences ({mchunk:.2g})")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_voice_cache_on_drive():
    """The re-voiced bus is saved on Drive and pulled from there on re-render:
    same audio + same voice settings = cache hit; any knob change = re-run."""
    print("voice cache on Drive")
    if not shutil.which("ffmpeg"):
        print("  (skipped — no ffmpeg)")
        return
    tmp = Path(tempfile.mkdtemp(prefix="voice_cache_"))
    try:
        src = _master(tmp / "master.mp4", dur=8)
        proc = V.ReactionVideoProcessor(str(src), work_dir=str(tmp / "work"),
                                        output_dir=str(tmp / "out"))
        segs = _segments(8.0)
        cloak = dict(L.default_audio_cloak())
        cloak.update({"on": False, "voiceChanger": True, "voiceMode": "morph",
                      "voiceTarget": "content", "morphPreset": "deep",
                      "morphStrength": 100, "morphSeed": 5})
        runs, _off, _tot = V._passthrough_runs(segs, 4.0, 1.0)
        con = proc._conform_passthrough_bus(segs, 4.0, 1.0, 0.08, "0:a:1",
                                            silence_types=("mute", "card"),
                                            tag="cache_con")
        cache = proc.out / "voice_cache"

        v1 = V._voice_apply(proc, con, runs, cloak, "content", tag="c1")
        hits = sorted(cache.glob("content_*.wav"))
        check(len(hits) == 1,
              f"the re-voiced bus was saved on Drive ({[h.name for h in hits]})")
        cached = hits[0]
        mtime = cached.stat().st_mtime

        def md5(p: Path) -> str:
            return hashlib.md5(p.read_bytes()).hexdigest()

        h1 = md5(v1)
        v2 = V._voice_apply(proc, con, runs, cloak, "content", tag="c2")
        check(v2 == cached, "the second call pulls the bus from the Drive cache")
        check(abs(cached.stat().st_mtime - mtime) < 1e-6,
              "the cache entry was not rewritten (the engine did not re-run)")
        check(md5(v2) == h1, "the cached bus is bit-identical to the first run")

        cloak2 = dict(cloak, morphSeed=6)
        V._voice_apply(proc, con, runs, cloak2, "content", tag="c3")
        check(len(sorted(cache.glob("content_*.wav"))) == 2,
              "a different voice setting stores its own entry (no collision)")

        # pruning keeps the Drive folder bounded
        now = time.time()
        for i in range(14):
            junk = cache / f"content_junk{i:02d}.wav"
            junk.write_bytes(b"x")
            os.utime(junk, (now - 1000 + i, now - 1000 + i))
        V._prune_voice_cache(cache)
        left = sorted(cache.glob("*.wav"))
        check(len(left) <= V._VOICE_CACHE_KEEP,
              f"pruning keeps the newest {V._VOICE_CACHE_KEEP} entries "
              f"({len(left)} left)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_preview_proxy_survives_no_gpu():
    """The play button must work on a runtime with no GPU at all.

    Two separate bugs used to kill it: the proxy picked h264_nvenc because
    every static ffmpeg *lists* that encoder (a GPU-less runtime then dies on
    "Cannot load libcuda.so.1"), and a multi-track source built an invalid
    `amix=inputs=N` graph. Either one left proxy.error set, the browser threw
    it, and no video src was ever attached — pressing space did nothing.
    """
    print("preview proxy")
    if not shutil.which("ffmpeg"):
        print("  (skipped — no ffmpeg)")
        return
    import urllib.request
    import webapp.server as S

    tmp = Path(tempfile.mkdtemp(prefix="voice_proxy_"))
    try:
        src = tmp / "three_tracks.mp4"
        _ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=3",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
             "-f", "lavfi", "-i", "sine=frequency=660:duration=3",
             "-f", "lavfi", "-i", "anoisesrc=duration=3",
             "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a",
             "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
             "-c:a", "aac", "-b:a", "64k", "-shortest", str(src)])
        proc = V.ReactionVideoProcessor(str(src), work_dir=str(tmp / "work"),
                                        output_dir=str(tmp / "out"))
        proc._probe_audio = lambda _s: ["a0", "a1", "a2"]   # 3-track master
        real = C.nvenc_available
        try:
            # claim a GPU that is not there: the first attempt must fail and
            # the second (libx264) must still deliver a playable proxy
            C.nvenc_available = lambda verbose=True: True
            st: Dict[str, Any] = {"ready": False, "progress": 0.0, "error": None}
            out = S.ensure_proxy(proc, 240, st)
            check(out.is_file() and out.stat().st_size > 10_000,
                  f"a lying GPU probe still produced a proxy "
                  f"({out.stat().st_size} bytes) — the CPU retry worked")
            check(st.get("error") is None and st.get("ready") is True,
                  f"proxy status is ready with no error ({st.get('error')})")
            d = proc._media_duration(str(out))
            check(abs(d - 3.0) < 0.4, f"the proxy is the right length ({d:.2f}s)")
        finally:
            C.nvenc_available = real

        # and the retry route has to clear a stale error
        httpd, app = S.serve_forever(proc, port=0, proxy_width=240)
        port = httpd.server_address[1]
        base = f"http://127.0.0.1:{port}"
        try:
            # let the worker that serve_forever just started finish first, so
            # the retry is tested on its own and not against a race
            for _ in range(60):
                if app.proxy_status.get("ready") or app.proxy_status.get("error"):
                    break
                time.sleep(0.5)
            app.proxy_status.update(ready=False, progress=0.0,
                                    error="Cannot load libcuda.so.1")
            req = urllib.request.Request(base + "/api/proxy/retry", data=b"{}",
                                         method="POST",
                                         headers={"Content-Type":
                                                  "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode("utf-8"))
            check(j.get("ok") is True, "POST /api/proxy/retry answers ok")
            check((j.get("proxy") or {}).get("error") is None,
                  "the retry clears the error the browser threw")
            ready = False
            for _ in range(40):
                with urllib.request.urlopen(base + "/api/state",
                                            timeout=60) as r:
                    stt = json.loads(r.read().decode("utf-8"))
                px = stt.get("proxy") or {}
                if px.get("ready"):
                    ready = True
                    break
                if px.get("error"):
                    break
                time.sleep(0.5)
            check(ready, "the rebuilt proxy becomes ready (the play button "
                         "gets a src again)")
        finally:
            httpd.shutdown()
            httpd.server_close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_model_spec_resolution():
    """The RVC model field has to be forgiving — path, URL, hf:, or nothing."""
    print("model specs")
    check(V._rvc_model_path("") is None, "an empty spec is not an error here")
    check(V._rvc_model_path("builtin:morph") is None,
          "'builtin:morph' means 'use the built-in engine'")
    check(V._rvc_model_path("morph:deep") is None,
          "'morph:…' means the same thing")
    tmp = Path(tempfile.mkdtemp(prefix="voice_model_"))
    try:
        real = tmp / "voice.pth"
        real.write_bytes(b"x" * 200_000)
        check(V._rvc_model_path(str(real)) == real,
              "a local path resolves to itself")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    try:
        V._rvc_model_path(str(Path(tempfile.gettempdir()) / "definitely_absent"))
        check(False, "a missing model raises with the fix in the message")
    except RuntimeError as e:
        check("built-in morph" in str(e) and "hf:" in str(e),
              "the missing-model error names both ways out")
    try:
        V._rvc_model_path("hf:owner/repo")
        check(False, "an hf: spec without a file name raises")
    except RuntimeError as e:
        check("file name" in str(e), "…and says it needs hf:owner/repo/file")


def test_no_gpu_never_picks_nvenc():
    print("encoder choice")
    ok = C.nvenc_available(verbose=False)
    enc, _ = V._pick_video_encoder(prefer_gpu=True)
    if ok:
        check(enc == "h264_nvenc", "a verified GPU picks h264_nvenc")
    else:
        check(enc == "libx264",
              "no usable GPU → libx264 (cpu), never 'Cannot load libcuda.so.1'")
    enc2, _ = V._pick_video_encoder(prefer_gpu=False)
    check(enc2 == "libx264", "prefer_gpu=False forces the cpu encoder")
    # the server's preview proxy must use the same verified verdict
    srv = (COLAB / "webapp" / "server.py").read_text(encoding="utf-8")
    check("_ffmpeg_has_encoder(\"h264_nvenc\")" not in srv,
          "server.py no longer trusts a bare encoder listing for the proxy")
    check("nvenc_available" in srv,
          "server.py asks compose.nvenc_available() (real smoke encode)")


def main() -> int:
    print("voice morph tests\n---------------")
    t0 = time.time()
    test_preset_table()
    test_duration_exact()
    test_pitch_and_formant_are_independent()
    test_deterministic_and_seed_sensitive()
    test_strength_zero_is_passthrough()
    test_speed_on_cpu()
    test_file_roundtrip()
    test_target_and_mode_helpers()
    test_no_gpu_never_picks_nvenc()
    test_preview_proxy_survives_no_gpu()
    test_model_spec_resolution()
    test_keep_card_audio_flag()
    test_render_morphs_the_content_bus()
    test_cards_keep_the_revoiced_audio()
    test_voice_cache_on_drive()
    print(f"\n{CHECKS[0]} checks, {len(FAILS)} failed ({time.time() - t0:.0f}s)")
    for f in FAILS:
        print(f"  FAILED: {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
