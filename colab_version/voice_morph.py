"""Built-in voice morph — the "no models, no downloads, no GPU" voice changer.

Why this exists
---------------
The YouTube cut has to survive Content ID. The matcher fingerprints the
*programme audio*, so the single strongest move is to re-voice the CONTENT
bus: the dialogue stops sounding like the original recording, while your own
mic keeps its natural sound (nobody wants their reaction voice chipmunked).

RVC does that with a neural net, but it needs torch + fairseq + a trained
``.pth`` character model — a heavy install that routinely breaks on a
Colab runtime, and on a GPU-less runtime it crawls. This module is the
zero-setup answer:

* **numpy only** (ffmpeg is used purely to decode/encode the wav),
* **CPU**, roughly 1-3x realtime for a full episode,
* **deterministic** — the same seed produces the same "person" every render,
  so re-rendering a project never changes the voice,
* **exact duration** — a single phase-vocoder pass, so A/V can never drift.

How it changes a voice (this is what defeats the fingerprint)
------------------------------------------------------------
One analysis/synthesis pass with independent *pitch* and *formant* factors:

    formant f  -> the read rate of the phase vocoder (moves the whole
                  spectral envelope: the vocal tract, i.e. WHO is speaking)
    pitch p    -> the synthesis hop (moves the harmonics only)
    duration   -> n_out = n_in / p, so p = 1 keeps the timeline exact

On top of that: pitch vibrato + slow random drift (kills the stable harmonic
grid a matcher locks onto), spectral tilt, low/high pass, a band-vocoder
"robot" voice, breath noise, and per-channel decorrelation for width.

A pitch shift alone is easy to fingerprint-match (Shazam-style matchers are
transposition tolerant). Moving the FORMANTS is what makes it a different
vocal tract — and the drift/vibrato/tilt/breath layers remove the rest of
the stable structure.

CLI (handy in a notebook cell)::

    python3 voice_morph.py in.wav out.wav --preset incognito --strength 85
    python3 voice_morph.py --list
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# characters
# ---------------------------------------------------------------------------
# Every preset is a *person*, not a knob: pitch (semitones, harmonics only),
# formant (ratio, vocal tract), vibrato/drift (instability), tilt (brighter
# or darker), lp/hp (band), robot (band-vocoder vocoder), breath (air),
# spread (L/R decorrelation). `strength` in the UI scales all of it 0..1.

PRESETS: Dict[str, Dict[str, float]] = {
    # the default: still perfectly intelligible, unmistakably another person
    "incognito": dict(label="Incognito", pitch=-2.6, formant=0.85, vibRate=5.1,
                      vibDepth=0.022, drift=0.030, tilt=-1.2, lp=12500.0,
                      hp=95.0, robot=0.0, breath=0.035, spread=0.35),
    # big low narrator
    "deep": dict(label="Deep", pitch=-5.2, formant=0.78, vibRate=4.3,
                 vibDepth=0.018, drift=0.022, tilt=-2.6, lp=9800.0, hp=72.0,
                 robot=0.0, breath=0.020, spread=0.25),
    # small bright character (cartoon sidekick energy)
    "bright": dict(label="Bright", pitch=4.6, formant=1.17, vibRate=6.1,
                   vibDepth=0.0225, drift=0.026, tilt=1.9, lp=15200.0,
                   hp=135.0, robot=0.0, breath=0.050, spread=0.40),
    # machine: band vocoder over a neutral morph
    "robot": dict(label="Robot", pitch=-0.6, formant=0.97, vibRate=0.9,
                  vibDepth=0.004, drift=0.004, tilt=0.6, lp=8200.0, hp=155.0,
                  robot=0.85, breath=0.0, spread=0.15),
    # not-a-voice: extreme tract + wobble
    "alien": dict(label="Alien", pitch=3.1, formant=0.63, vibRate=7.3,
                  vibDepth=0.075, drift=0.055, tilt=2.6, lp=11200.0, hp=115.0,
                  robot=0.18, breath=0.075, spread=0.70),
    # broadcast-y: subtle, stays closest to the original performance
    "warm": dict(label="Warm", pitch=-1.2, formant=0.94, vibRate=4.7,
                 vibDepth=0.014, drift=0.012, tilt=0.9, lp=13800.0, hp=82.0,
                 robot=0.0, breath=0.015, spread=0.20),
    # lo-fi intercom: mostly the band, cheap and very different
    "radio": dict(label="Radio", pitch=-0.8, formant=1.02, vibRate=3.1,
                  vibDepth=0.010, drift=0.008, tilt=0.0, lp=3400.0, hp=320.0,
                  robot=0.05, breath=0.010, spread=0.10),
    # neutral carrier for the manual sliders: voicePitch moves the harmonics
    # only (the "pitch shift" every editor has), formant stays put unless the
    # morphFormant override says otherwise
    "custom": dict(label="Manual", pitch=0.0, formant=1.0, vibRate=4.5,
                   vibDepth=0.014, drift=0.010, tilt=0.0, lp=17000.0, hp=60.0,
                   robot=0.0, breath=0.010, spread=0.20),
}

DEFAULT_PRESET = "incognito"

# below this fraction of the channel peak a phase-vocoder frame counts as
# silent: no instantaneous frequency to measure there (see _pvoc)
SILENCE_REL = 1e-4

# how far one frame's spectral envelope may be re-shaped, and how much of the
# previous frame's correction is carried over (see _pvoc)
ENV_WARP_CLAMP = 2.5
ENV_RATIO_SMOOTH = 0.7


def preset_names() -> List[str]:
    return list(PRESETS.keys())


def preset_label(name: str) -> str:
    p = PRESETS.get(str(name or "").lower())
    return str((p or {}).get("label") or name or DEFAULT_PRESET)


def plan_for(cfg: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """Resolve a voice-changer config into concrete morph parameters.

    Accepts the flat audio-cloak dict the editor sends (``morphPreset``,
    ``morphStrength``, ``morphSeed``, plus the legacy ``voiceStrength`` /
    ``voicePitch`` so an existing project keeps behaving).
    """
    c = dict(cfg or {})
    name = str(c.get("morphPreset") or c.get("voicePreset")
               or DEFAULT_PRESET).lower()
    base = dict(PRESETS.get(name) or PRESETS[DEFAULT_PRESET])
    strength = float(c.get("morphStrength", c.get("voiceStrength", 85.0)))
    strength = max(0.0, min(100.0, strength)) / 100.0
    seed = int(c.get("morphSeed", 0) or 0)

    # "custom" (Manual) rides the legacy pitch slider; the characters keep
    # their own pitch and only take the slider as a trim
    extra_pitch = float(c.get("voicePitch", 0.0) or 0.0)
    if name == "custom":
        base["pitch"] = extra_pitch
    elif abs(extra_pitch) > 1e-6:
        base["pitch"] = float(base["pitch"]) + extra_pitch
    # explicit formant override (the UI exposes it as "vocal tract"); 0 means
    # "not set" — the preset's own tract wins
    mf = c.get("morphFormant")
    try:
        mf = float(mf) if mf is not None else 0.0
    except (TypeError, ValueError):
        mf = 0.0
    if 0.4 <= mf <= 2.5 and abs(mf - 1.0) > 1e-3:
        base["formant"] = mf

    rng = np.random.default_rng(abs(seed) % 100003)
    jitter = 1.0 + 0.06 * (float(rng.random()) - 0.5)      # ±3%
    plan = {
        "pitch": float(base["pitch"]) * strength,
        "formant": 1.0 + (float(base["formant"]) - 1.0) * strength,
        "vibRate": float(base["vibRate"]) * jitter,
        "vibDepth": float(base["vibDepth"]) * strength,
        "drift": float(base["drift"]) * strength,
        "tilt": float(base["tilt"]) * strength,
        "lp": float(base["lp"]),
        "hp": float(base["hp"]),
        "robot": float(base["robot"]) * strength,
        "breath": float(base["breath"]) * strength,
        "spread": float(base["spread"]) * strength,
        # per-seed vocal-tract bumps, in dB — the seed is what makes two
        # renders of the same episode sound like two different guests
        "tract": 3.5 * strength,
        "wet": 1.0 if strength >= 0.999 else max(0.0, strength),
        "seed": float(seed),
        "preset": name,
        "strength": strength,
    }
    # formant/pitch sanity: keep the vocal tract inside a usable range
    plan["formant"] = float(max(0.5, min(2.0, plan["formant"])))
    plan["pitch"] = float(max(-12.0, min(12.0, plan["pitch"])))
    return plan


# ---------------------------------------------------------------------------
# wav I/O (stdlib only — ffmpeg is used for anything that is not a wav)
# ---------------------------------------------------------------------------

def _read_wav(path: Path) -> Tuple[np.ndarray, int]:
    """-> (float64 (n, ch) in [-1, 1], sample_rate)."""
    with wave.open(str(path), "rb") as w:
        ch = int(w.getnchannels())
        sw = int(w.getsampwidth())
        sr = int(w.getframerate())
        n = int(w.getnframes())
        raw = w.readframes(max(0, n))
    if not raw:
        return np.zeros((0, ch), dtype=np.float64), sr
    if sw == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sw == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    elif sw == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.uint32)
        v = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)).astype(np.int32)
        v = np.where(v & 0x800000, v - (1 << 24), v)
        a = v.astype(np.float64) / 8388608.0
    else:
        raise ValueError(f"unsupported wav sample width: {sw} bytes")
    a = a[: (len(a) // ch) * ch].reshape(-1, ch)
    return a, sr


def _write_wav(path: Path, data: np.ndarray, sr: int) -> None:
    d = np.clip(np.asarray(data, dtype=np.float64), -1.0, 1.0)
    if d.ndim == 1:
        d = d[:, None]
    pcm = np.round(d * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(int(pcm.shape[1]))
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def _ffmpeg() -> str:
    for name in ("ffmpeg",):
        p = shutil.which(name)
        if p:
            return p
    raise RuntimeError("ffmpeg not found — needed to decode/encode audio")


def decode_to_wav(src: Path, dst: Path, sr: int = 0) -> Path:
    """Any media file -> stereo (or native) wav via ffmpeg."""
    cmd = [_ffmpeg(), "-y", "-v", "error", "-i", str(src)]
    if sr:
        cmd += ["-ar", str(sr)]
    cmd += ["-c:a", "pcm_s16le", str(dst)]
    subprocess.run(cmd, check=True)
    return dst


def read_audio(path: Path) -> Tuple[np.ndarray, int]:
    p = Path(path)
    if p.suffix.lower() == ".wav":
        try:
            return _read_wav(p)
        except Exception:
            pass  # exotic wav (float/extensible) — let ffmpeg decode it
    tmp = p.with_suffix(".decode.wav")
    try:
        decode_to_wav(p, tmp)
        data, sr = _read_wav(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    return data, sr


# ---------------------------------------------------------------------------
# the morph
# ---------------------------------------------------------------------------

def _hann(n: int) -> np.ndarray:
    return np.hanning(n + 1)[:-1].astype(np.float64)


def _resample(x: np.ndarray, r: float) -> np.ndarray:
    """Rate conversion: every frequency (harmonics AND formants) x *r*.

    Output length is ``len(x) / r`` — the classic "play it back at another
    sample rate" move, which is why it shifts the spectral envelope too
    (a phase vocoder can never do that on its own). *r* < 1 gets an FFT
    brick-wall lowpass first so nothing aliases back into the voice band,
    then a windowed-sinc LUT does the fractional delay. Pure numpy: scipy is
    not a dependency on a bare Colab runtime and a per-sample loop would cost
    more than the rest of the morph.
    """
    n = int(len(x))
    r = float(r)
    if n < 8 or abs(r - 1.0) < 1e-6:
        return x.astype(np.float64, copy=True)
    y = np.asarray(x, dtype=np.float64)
    if r < 1.0:
        m = len(y)
        S = np.fft.rfft(y)
        f = np.fft.rfftfreq(m)                 # cycles/sample, 0..0.5
        keep = f <= 0.5 * r * 0.98
        S = S * keep
        if m % 2 == 0 and len(S):
            S[-1] *= 0.5                       # halved nyquist bin
        y = np.fft.irfft(S, n=m)
    m = max(2, int(round(n / r)))
    if m < 2:
        return np.zeros(max(1, m), dtype=np.float64)
    y = np.concatenate([y, np.zeros(8, dtype=np.float64)])
    taps = 32                              # windowed-sinc LUT: 32 taps x
    frac_levels = 256                      # 256 fractional delays
    k = np.arange(-(taps // 2) + 1, taps // 2 + 1, dtype=np.float64)
    t = (np.arange(frac_levels, dtype=np.float64) / frac_levels)[:, None]
    d = t - k[None, :]
    beta = 8.0
    span = float(taps)
    w = np.where(np.abs(d) <= span / 2.0,
                 np.i0(beta * np.sqrt(np.maximum(
                     0.0, 1.0 - (2.0 * d / span) ** 2))) / np.i0(beta),
                 0.0)
    h = np.sinc(d) * w
    h = h / (np.sum(h, axis=1, keepdims=True) + 1e-12)
    pos = np.arange(m, dtype=np.float64) * r
    base = np.floor(pos).astype(np.int64)
    fr = ((pos - base) * frac_levels).astype(np.int64)
    fr = np.clip(fr, 0, frac_levels - 1)
    idx = base[:, None] + k.astype(np.int64)[None, :]
    np.clip(idx, 0, len(y) - 1, out=idx)
    return np.einsum("ij,ij->i", y[idx], h[fr])


def _cepstral_envelope(mag: np.ndarray, lifter: int,
                       smooth_bins: int = 41) -> np.ndarray:
    """Smooth spectral envelope of one frame (real cepstrum, low quefrency).

    The lifter cut decides what counts as "envelope": quefrency bin *k*
    corresponds to a ripple of period nb/k bins, so keeping k < ~40 keeps the
    broad vocal-tract shape and throws away the harmonic comb. A moving
    average over the result takes out what is left of the comb — the envelope
    is only ever used as a ratio, and ripple in a ratio is audible as
    phasiness.
    """
    nb = len(mag)
    c = np.fft.irfft(np.log(np.maximum(mag, 1e-10)), n=2 * (nb - 1))
    lif = max(2, min(lifter, nb // 2))
    keep = np.zeros(len(c), dtype=np.float64)
    keep[:lif] = 1.0
    keep[-(lif - 1):] = 1.0
    env = np.fft.rfft(c * keep, n=2 * (nb - 1))[:nb]
    env = np.exp(np.clip(env.real, -12.0, 12.0))
    k = int(smooth_bins)
    if k > 1 and nb > k:
        if k % 2 == 0:
            k += 1
        env = np.convolve(env, np.ones(k) / k, mode="same")
    return np.maximum(env, 1e-9)


def _detrend_log_env(env: np.ndarray, active: np.ndarray) -> np.ndarray:
    """Divide the source tilt out of the envelope, keeping the bumps.

    A cepstral envelope of a voice carries the SOURCE (harmonics fall off with
    1/k, so the estimate slopes down several dB per octave) as well as the
    FILTER (the formant bumps). Warping the two together is what makes a
    naive formant shift go wrong: over a falling slope an upward warp cuts
    below the formant and boosts above it, so the second formant overtakes
    the first and the character comes out inverted. Fit the slope over the
    signal-bearing bins, divide it out, warp the bumps, and the ratio that
    reaches the spectrum is the formant move and nothing else. Any tilt the
    character actually wants is applied separately by the gain curve.
    """
    nb = len(env)
    idx = np.arange(nb, dtype=np.float64)
    if not np.any(active):
        return env
    lo = int(np.argmax(active))
    hi = nb - 1 - int(np.argmax(active[::-1]))
    if hi - lo < 8:
        return env
    xs = idx[lo:hi + 1]
    ys = np.log(np.maximum(env[lo:hi + 1], 1e-12))
    slope, icept = np.polyfit(xs, ys, 1)
    resid = ys - (slope * xs + icept)
    keep = np.abs(resid) < 2.5 * (float(np.std(resid)) + 1e-9)
    if int(np.sum(keep)) > 8:
        slope, icept = np.polyfit(xs[keep], ys[keep], 1)
    tilt = np.exp(slope * idx)
    return env / np.maximum(tilt, 1e-12)


def _warp_env(env: np.ndarray, scale: float) -> np.ndarray:
    """Resample the envelope along frequency: the formant shift proper.

    ``scale > 1`` moves every resonance UP by that factor: the result at bin
    *k* reads the envelope from ``k / scale``, so a bump that sat at 700 Hz
    comes out at 700 * scale Hz. Getting this the wrong way round is the
    classic formant-shift bug — the character becomes its own opposite and
    the envelope correction that is supposed to cancel a pitch shift runs
    away instead (verified in webapp/tests/test_voice_morph.py).
    """
    scale = float(scale)
    if abs(scale - 1.0) < 1e-4 or scale <= 0.0:
        return env
    nb = len(env)
    axis = np.arange(nb, dtype=np.float64)
    return np.interp(axis / scale, axis, env, left=env[0], right=env[-1])


def _pvoc(x: np.ndarray, stretch: float, *,
          vib: Optional[np.ndarray] = None,
          gain_curve: Optional[np.ndarray] = None,
          env_scale: float = 1.0,
          lifter: int = 40) -> np.ndarray:
    """Phase-coherent time stretch: output length = stretch * len(x).

    Frequencies are preserved — the accumulator advances by ``Ha * f_inst``,
    where ``f_inst`` is the instantaneous frequency measured between analysis
    frames, so re-timing never moves pitch. Two extras make it the morph's
    workhorse:

    ``env_scale``  warps the *cepstral spectral envelope* of every frame along
                   the frequency axis while the harmonic fine structure stays
                   put. That is a genuine formant shift, and it is the only
                   way to get pitch, formant and duration right at the same
                   time: resampling moves everything, stretching moves
                   nothing, envelope warping moves the tract alone.
    ``vib``        per-frame pitch multiplier applied to the synthesis
                   accumulator. It has to live there: modulating the read rate
                   instead is cancelled exactly by the instantaneous-frequency
                   correction, so the pitch never moves and all you get is a
                   warped time base.
    """
    n = int(len(x))
    if n == 0:
        return x.astype(np.float64, copy=True)
    stretch = float(min(8.0, max(0.125, stretch)))
    nfft = 4096 if n >= 8192 else (2048 if n >= 2048 else 512)
    while nfft > 2 * n:
        nfft //= 2
    nfft = int(max(256, nfft))
    H = max(64, nfft // 4)
    Ha = int(min(4 * H, max(16, int(round(H / stretch)))))
    win = _hann(nfft)
    pad = np.concatenate([np.zeros(nfft, dtype=np.float64),
                          np.asarray(x, dtype=np.float64),
                          np.zeros(nfft * 2, dtype=np.float64)])
    want = int(round(n * stretch))
    nframes = max(1, int(math.ceil(want / float(Ha))) + 1)
    freqs = np.fft.rfftfreq(nfft) * 2.0 * math.pi
    adv = H * freqs
    rate = 1.0 / stretch
    nb = nfft // 2 + 1
    prev_pha = np.zeros(nb, dtype=np.float64)
    acc_pha = np.zeros(nb, dtype=np.float64)
    frame_ref = max(1e-9, float(np.abs(x).max())) * (float(nfft) / 4.0)
    total = nframes * Ha + nfft
    out = np.zeros(total, dtype=np.float64)
    # overlap-add normalisation for THIS synthesis hop: hann^2 only sums to a
    # constant at its own 75% overlap, and a fixed divisor leaves the output
    # tens of dB quiet (and wobbly) whenever Ha != H. Measure the real sum.
    wsum = np.zeros(total, dtype=np.float64)
    w2 = win * win
    for o in range(0, total, Ha):
        e = min(total, o + nfft)
        wsum[o:e] += w2[:e - o]
    np.maximum(wsum, 1e-3, out=wsum)
    warp = abs(float(env_scale) - 1.0) > 1e-4
    prev_ratio: Optional[np.ndarray] = None
    first = True
    max_pos = float(len(pad) - nfft)
    pos = float(nfft)
    for i in range(nframes):
        p0 = int(math.floor(pos))
        if p0 < 0:
            p0 = 0
        p1 = min(p0 + 1, int(max_pos))
        fr = pos - p0
        seg = pad[p0:p0 + nfft] * (1.0 - fr) + pad[p1:p1 + nfft] * fr
        if len(seg) < nfft:
            seg = np.concatenate([seg, np.zeros(nfft - len(seg))])
        pos = min(max_pos, pos + H * rate)
        S = np.fft.rfft(seg * win)
        mag = np.abs(S)
        pha = np.angle(S)
        # A frame with nothing in it has no phase to measure, so the
        # instantaneous frequency of the previous frame would be carried
        # forward and the accumulator would keep singing the last pitch
        # through the silence — a mute span would come out as a drone. Hold
        # the accumulator instead: the magnitudes are zero, the frame is
        # silent, and the phase is ready again when the voice returns.
        frame_peak = float(mag.max()) if mag.size else 0.0
        silent = frame_peak <= SILENCE_REL * frame_ref
        if frame_peak > frame_ref:
            frame_ref = frame_peak
        if first:
            acc_pha = pha.copy()
            first = False
        elif not silent:
            d = pha - prev_pha - adv * rate
            d = (d + math.pi) % (2.0 * math.pi) - math.pi
            inst = freqs + d / float(H)
            pitch_mod = 1.0
            if vib is not None and i < len(vib):
                pitch_mod = min(2.0, max(0.5, float(vib[i])))
            acc_pha = acc_pha + Ha * inst * pitch_mod
        if not silent:
            prev_pha = pha
        if warp:
            # The envelope estimate is only trustworthy where there is signal:
            # in a damped voice the bins above the last harmonic sit on the
            # numerical floor, and a ratio computed there is noise (it comes
            # out as a boost that lifts a second formant over the first). So
            # the ratio is measured on the signal-bearing bins and carried
            # flat above them, then kept inside a sane range.
            env = _cepstral_envelope(mag, lifter)
            peak = float(mag.max())
            floor = peak * 1e-3                     # -60 dB
            active = np.maximum.accumulate(mag[::-1])[::-1] > floor
            shape = _detrend_log_env(env, active)
            ratio = _warp_env(shape, float(env_scale)) / np.maximum(shape, 1e-9)
            ratio = np.clip(ratio, 1.0 / ENV_WARP_CLAMP, ENV_WARP_CLAMP)
            # bins with no signal in them get no make-up gain: the envelope
            # estimate down there is the numerical floor, and a clamped ratio
            # on a floor-sized magnitude still adds tens of dB of hiss
            ratio = np.where(active, ratio, 1.0)
            # a vocal tract does not change from one 90 ms frame to the next,
            # but the estimate does (it rides the harmonic pattern, so vibrato
            # alone can make it flap). Smoothing the ratio over time keeps the
            # character steady and removes the warble it would otherwise add.
            if prev_ratio is not None and len(prev_ratio) == len(ratio):
                ratio = ENV_RATIO_SMOOTH * prev_ratio \
                    + (1.0 - ENV_RATIO_SMOOTH) * ratio
            prev_ratio = ratio
            mag = mag * ratio
        if gain_curve is not None:
            mag = mag * gain_curve
        frame = np.fft.irfft(mag * np.exp(1j * acc_pha), n=nfft) * win
        o = i * Ha
        out[o:o + nfft] += frame
    res = (out / wsum)[nfft:nfft + max(0, want)]
    if len(res) < want:
        res = np.concatenate([res, np.zeros(want - len(res))])
    return res


def _lfo(n_frames: int, plan: Dict[str, float], sr: int, Ha: int,
         seed: float, flip: float = 1.0) -> np.ndarray:
    """Per-frame pitch multiplier (1.0 = steady): vibrato + slow drift.

    Applied to the synthesis accumulator, so it bends the pitch of everything
    in the frame — harmonics and formants together — which is what a real
    larynx does. Two incommensurate sine rates read as natural wobble rather
    than a synth, and the drift term is a mean-removed random walk so the
    voice wanders without ever running away in tune.
    """
    depth = float(plan.get("vibDepth", 0.0)) * flip
    drift = float(plan.get("drift", 0.0))
    if depth <= 0.0 and drift <= 0.0:
        return np.ones(n_frames, dtype=np.float64)
    t = (np.arange(n_frames, dtype=np.float64) * Ha) / float(sr)
    rng = np.random.default_rng(int(abs(seed) * 977) % 100003)
    rate = float(plan.get("vibRate", 5.0))
    ph = float(rng.random()) * 2.0 * math.pi
    out = np.ones(n_frames, dtype=np.float64)
    if depth:
        # two incommensurate rates read as natural wobble, not a synth
        out += depth * (np.sin(2.0 * math.pi * rate * t + ph)
                        + 0.45 * np.sin(2.0 * math.pi * rate * 0.37 * t + 2.0 * ph))
    if drift:
        w = np.cumsum(rng.standard_normal(n_frames))
        if len(w) > 1:
            w = w - np.linspace(w[0], w[-1], len(w))     # no runaway ramp
            w = w / (np.max(np.abs(w)) + 1e-9)
        out += drift * w
    return out


def _tilt_curve(nfft: int, sr: int, tilt_db: float, lp: float, hp: float,
                ) -> np.ndarray:
    """Static per-bin gain: dB/octave tilt plus soft low/high shelves."""
    f = np.fft.rfftfreq(nfft, d=1.0 / sr)
    g = np.ones(len(f), dtype=np.float64)
    if abs(tilt_db) > 1e-3:
        with np.errstate(divide="ignore"):
            oct_ = np.log2(np.maximum(f, 20.0) / 1000.0)
        g *= 10.0 ** (tilt_db * oct_ / 20.0)
    if lp and lp < sr * 0.49:
        g /= np.sqrt(1.0 + (f / lp) ** 4)
    if hp and hp > 1.0:
        g /= np.sqrt(1.0 + (hp / np.maximum(f, 1e-6)) ** 4)
    return np.clip(g, 0.0, 4.0)


def _tract_curve(nfft: int, sr: int, seed: float, depth_db: float = 3.5,
                 ) -> np.ndarray:
    """A per-seed random vocal tract: smooth ±depth_db bumps over the bins.

    This is what makes the *seed* mean something. Pitch and formant move the
    whole envelope; a real different speaker also has different formant
    bandwidths and resonances, so each seed gets its own gentle, log-spaced
    spectral shape. Deterministic, and free (one curve per render).
    """
    nb = len(np.fft.rfftfreq(nfft, d=1.0 / sr))
    if depth_db <= 0.01 or nb < 16:
        return np.ones(nb, dtype=np.float64)
    rng = np.random.default_rng(int(abs(seed) * 7919) % 100003)
    anchors = 9
    lo, hi = 120.0, max(400.0, sr * 0.36)
    pts = np.linspace(math.log(lo), math.log(hi), anchors)
    vals = rng.standard_normal(anchors)
    vals = vals - vals.mean()
    vals = vals / (np.max(np.abs(vals)) + 1e-9)
    f = np.maximum(np.fft.rfftfreq(nfft, d=1.0 / sr), 1.0)
    lf = np.clip(np.log(f), pts[0], pts[-1])
    shape = np.interp(lf, pts, vals)
    return 10.0 ** (depth_db * shape / 20.0)


def _smooth_env(x: np.ndarray, sr: int, ms: float) -> np.ndarray:
    n = max(1, int(sr * ms / 1000.0))
    k = np.ones(n, dtype=np.float64) / n
    return np.convolve(np.abs(x), k, mode="same")


def _bandpass(x: np.ndarray, sr: int, fc: float, q: float) -> np.ndarray:
    """Zero-phase Gaussian bandpass (FFT domain) — no scipy, no recursion.

    Only numpy is available on a bare Colab runtime, and a per-sample biquad
    loop would cost more than the whole rest of the morph, so the band is a
    spectral mask: identical result, ~100x faster.
    """
    n = len(x)
    if n < 8:
        return np.zeros_like(x)
    f = np.fft.rfftfreq(n, d=1.0 / sr)
    sigma = max(1.0, fc / (2.0 * max(0.5, q)))
    mask = np.exp(-0.5 * ((f - fc) / sigma) ** 2)
    return np.fft.irfft(np.fft.rfft(x) * mask, n=n)


def _robot_band(x: np.ndarray, sr: int, amount: float, seed: float) -> np.ndarray:
    """Band-vocoder robot: three resonant bands re-excited by sine carriers.

    Cheap, deterministic, and completely destroys the harmonic fine structure
    a fingerprint hashes — while the syllable rhythm (what makes speech
    intelligible) survives in the band envelopes.
    """
    if amount <= 0.01:
        return np.zeros_like(x)
    n = len(x)
    t = np.arange(n, dtype=np.float64) / float(sr)
    rng = np.random.default_rng(int(abs(seed) * 31) % 100003)
    out = np.zeros(n, dtype=np.float64)
    base = 110.0 * (1.0 + 0.12 * (float(rng.random()) - 0.5))
    for k, (cf, q, amp) in enumerate(((1.0, 14.0, 1.00),
                                      (2.7, 18.0, 0.55),
                                      (5.1, 22.0, 0.30))):
        fc = base * cf
        y = _bandpass(x, sr, fc, q)
        env = _smooth_env(y, sr, 12.0)
        car = np.sin(2.0 * math.pi * fc * t + k)
        out += amp * env * car
    peak = float(np.max(np.abs(out))) or 1.0
    ref = float(np.max(np.abs(x))) or 1.0
    out *= ref / peak
    return amount * out


def _breath(x: np.ndarray, sr: int, amount: float, seed: float) -> np.ndarray:
    """Envelope-shaped noise: the air a real voice has (and a fingerprint
    does not expect to move)."""
    if amount <= 0.005:
        return np.zeros_like(x)
    rng = np.random.default_rng(int(abs(seed) * 131) % 100003)
    nz = rng.standard_normal(len(x))
    # pink-ish: 3-sample moving average rolls off the very top
    k = np.array([0.25, 0.5, 0.25])
    nz = np.convolve(nz, k, mode="same")
    env = _smooth_env(x, sr, 25.0)
    env = env / (float(np.max(env)) + 1e-9)
    ref = float(np.max(np.abs(x))) or 1.0
    return amount * nz * env * ref


def morph_channel(x: np.ndarray, sr: int, plan: Dict[str, float],
                  seed: float, flip: float = 1.0) -> np.ndarray:
    """Morph one channel. Duration in == duration out, sample for sample.

    Two passes, because one cannot do both jobs (see :func:`_pvoc`)::

        resample by pr          pitch AND formant x pr, length n / pr
        stretch pr, env x f/pr  length back to n, pitch stays, tract -> f

        => pitch = pr, formant = f, duration = n   (always exact)
    """
    n = int(len(x))
    if n < 64:
        return x.astype(np.float64, copy=True)
    f = max(0.5, min(2.0, float(plan.get("formant", 1.0))))
    pr = float(2.0 ** (float(plan.get("pitch", 0.0)) / 12.0))
    pr = max(0.5, min(2.0, pr))
    wet = np.asarray(x, dtype=np.float64)
    if abs(pr - 1.0) > 1e-4:
        wet = _resample(wet, pr)
    m = max(1, len(wet))
    stretch = float(n) / float(m)
    nfft = 4096 if m >= 8192 else (2048 if m >= 2048 else 512)
    while nfft > 2 * m:
        nfft //= 2
    nfft = int(max(256, nfft))
    Ha = max(16, int(round((nfft // 4) / stretch)))
    nframes = int(math.ceil(n / float(Ha))) + 2
    vib = _lfo(nframes, plan, sr, Ha, seed, flip=flip)
    curve = _tilt_curve(nfft, sr, float(plan["tilt"]),
                        float(plan["lp"]), float(plan["hp"]))
    curve = curve * _tract_curve(nfft, sr, seed,
                                 depth_db=float(plan.get("tract", 3.5)))
    # the resample already moved the tract by pr; put it where the character
    # wants it (and skip the cepstral work entirely when nothing would move)
    wet = _pvoc(wet, stretch, vib=vib, gain_curve=curve, env_scale=f / pr)
    if len(wet) < n:
        wet = np.concatenate([wet, np.zeros(n - len(wet))])
    wet = wet[:n]
    wet += _breath(wet, sr, float(plan["breath"]), seed)
    rob = float(plan["robot"])
    if rob > 0.01:
        wet = (1.0 - rob) * wet + _robot_band(wet, sr, rob, seed)
    w = float(plan.get("wet", 1.0))
    if w < 0.999:
        # equal-power dry/wet so a low strength never sounds hollow
        wet = math.sqrt(max(0.0, w)) * wet + math.sqrt(max(0.0, 1.0 - w)) \
            * np.asarray(x, dtype=np.float64)
    return wet


def _silence_gate(out: np.ndarray, ref: np.ndarray, sr: int,
                  thresh_db: float = -54.0, attack_ms: float = 6.0,
                  release_ms: float = 60.0) -> np.ndarray:
    """Put the pauses back where the source had them.

    The morph is a resample plus a time stretch, so a pause in the input
    lands in a different place in the output — and a stretched pause is a
    *shortened* pause, which means voiced audio would otherwise run on into
    a span the mix expects to be silent. That is not a detail: mute/card
    spans are how a reaction video hides a claimed clip, and a voice engine
    that drones through them puts the very audio the user silenced back into
    the upload. So the output is gated by the SOURCE envelope, mapped onto
    the output timeline by the same ratio the morph used, with a short attack
    (no clipped consonant) and a longer release (no buzzing tail).
    """
    n = min(len(out), len(ref))
    if n < 64:
        return out
    peak = float(np.max(np.abs(ref[:n])))
    if peak <= 1e-7:
        out[:n] = 0.0                      # the source is silent: so is this
        return out
    ratio = float(len(out)) / float(n)     # output samples per input sample
    env = _smooth_env(ref[:n], sr, 12.0)
    env = env / peak
    gate_in = (env > 10.0 ** (thresh_db / 20.0)).astype(np.float64)
    g = np.zeros(len(out), dtype=np.float64)
    m = max(1, int(round(n * ratio)))
    if m > 1:
        idx = np.linspace(0.0, float(n - 1), m)
        g[:m] = np.interp(idx, np.arange(n, dtype=np.float64), gate_in)
    if len(g) > m:
        g[m:] = gate_in[-1] if n else 0.0
    # One-pole follower. The pole depends on the direction (a short attack so
    # no consonant is clipped, a longer release so no buzz), and it runs in
    # blocks that carry their level across — over a whole song a single
    # cumulative exponent drifts into the 1e3 range, where float64 spacing is
    # coarser than one sample's step and the decay silently stops happening.
    #
    # Inside a block, y[i] = max(open_level_from_the_carry,
    #                            level_from_the_last_opening_in_this_block),
    # which is exactly the recursion y = g + (y-g)*exp(-1/tau) unrolled.
    a = max(1.0, attack_ms * sr / 1000.0)
    r = max(a, release_ms * sr / 1000.0)
    decay = np.exp(-1.0 / np.where(g > 0.0, a, r))
    blk = 2048
    carry = 0.0                            # open level entering the block
    ar = np.arange(len(g), dtype=np.float64)
    for s0 in range(0, len(g), blk):
        e = min(len(g), s0 + blk)
        m = e - s0
        gs = g[s0:e]
        dc = decay[s0:e]
        # the carried level, decayed with this block's poles
        cd = np.concatenate([[1.0], np.cumprod(dc[:-1])]) if m > 1 else \
            np.ones(1)
        yc = carry * cd
        # the last opening inside the block: log-domain, re-anchored so the
        # numbers stay near zero and the exp never overflows
        ld = np.log(np.maximum(dc, 1e-12))
        cs = np.cumsum(ld)
        cs = cs - cs[-1]                   # every value <= 0
        ys = np.maximum.accumulate(np.where(gs > 0.0, ar[s0:e] - s0, -1.0))
        anchor = np.take(cs, np.clip(ys, 0, m - 1).astype(np.int64))
        yb = np.exp(np.clip(cs - anchor, -700.0, 0.0))
        yb = np.where(ys < 0.0, 0.0, yb)   # nothing has opened in this block
        y = np.maximum(yc, yb)
        carry = float(y[-1])
        g[s0:e] = np.clip(y, 0.0, 1.0)
    out[:n] = out[:n] * g[:n]
    return out


def _match_level(out: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Keep the bus where it was: same RMS, safe peak."""
    r = float(np.sqrt(np.mean(np.square(ref)))) if ref.size else 0.0
    o = float(np.sqrt(np.mean(np.square(out)))) if out.size else 0.0
    if r > 1e-7 and o > 1e-7:
        out = out * min(4.0, max(0.25, r / o))
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.985:
        out = out * (0.985 / peak)
    return out


def _edge_fade(out: np.ndarray, sr: int, ms: float = 4.0) -> np.ndarray:
    n = min(len(out), int(sr * ms / 1000.0))
    if n > 1:
        ramp = np.linspace(0.0, 1.0, n)
        out[:n] *= ramp[:, None] if out.ndim == 2 else ramp
        out[-n:] *= ramp[::-1][:, None] if out.ndim == 2 else ramp[::-1]
    return out


def morph(data: np.ndarray, sr: int, plan: Dict[str, float],
          progress: Optional[Callable[[float], None]] = None) -> np.ndarray:
    """Morph (n, ch) float audio. Returns the same shape and length."""
    d = np.asarray(data, dtype=np.float64)
    if d.ndim == 1:
        d = d[:, None]
    n, ch = d.shape
    out = np.zeros_like(d)
    spread = float(plan.get("spread", 0.0))
    for c in range(ch):
        # channel 0 gets the reference wobble; the others are progressively
        # decorrelated (no delay, so the timeline stays sample-exact)
        flip = 1.0 if c == 0 else (1.0 - spread * (float(c) / max(1, ch - 1)))
        out[:, c] = morph_channel(d[:, c], sr, plan,
                                  float(plan.get("seed", 0.0)) + 17.0 * c,
                                  flip=flip)
        out[:, c] = _match_level(out[:, c], d[:, c])
        out[:, c] = _silence_gate(out[:, c], d[:, c], sr)
        if progress is not None:
            progress((c + 1) / float(ch))
    out = _edge_fade(out, sr)
    if out.shape[1] == 1 and np.asarray(data).ndim == 1:
        return out[:, 0]
    return out


def morph_file(src: Path, dst: Path, cfg: Optional[Dict[str, Any]] = None,
               progress: Optional[Callable[[float], None]] = None) -> Path:
    """src (wav/m4a/mp4/…) -> dst .wav with the morphed voice, same length."""
    src, dst = Path(src), Path(dst)
    plan = plan_for(cfg)
    data, sr = read_audio(src)
    if data.size == 0:
        _write_wav(dst, np.zeros((1, 1)), sr or 44100)
        return dst
    t0 = None
    if os.environ.get("REACT_MORPH_TIMING"):
        import time as _t
        t0 = _t.time()
    out = morph(data, sr, plan, progress=progress)
    if out.shape[0] != data.shape[0]:        # never let it drift
        fix = np.zeros_like(data)
        m = min(fix.shape[0], out.shape[0])
        fix[:m] = out[:m]
        out = fix
    _write_wav(dst, out, sr)
    if t0 is not None:
        import time as _t
        secs = data.shape[0] / float(sr)
        el = _t.time() - t0
        print(f"  voice morph: {secs:.0f}s of audio in {el:.1f}s "
              f"({secs / max(1e-6, el):.1f}x realtime, cpu)")
    return dst


# ---------------------------------------------------------------------------

def _cli(argv: Sequence[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src", nargs="?", help="input audio/video file")
    ap.add_argument("dst", nargs="?", help="output .wav")
    ap.add_argument("--preset", default=DEFAULT_PRESET,
                    help="|".join(preset_names()))
    ap.add_argument("--strength", type=float, default=85.0, help="0..100")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--list", action="store_true", help="print the presets")
    a = ap.parse_args(list(argv))
    if a.list or not a.src:
        for k, v in PRESETS.items():
            print(f"{k:10s} {v['label']:10s} pitch {v['pitch']:+.1f} st  "
                  f"formant {v['formant']:.2f}")
        return 0
    if not a.dst:
        a.dst = str(Path(a.src).with_suffix("")) + ".morph.wav"
    cfg = {"morphPreset": a.preset, "morphStrength": a.strength,
           "morphSeed": a.seed}
    morph_file(Path(a.src), Path(a.dst), cfg)
    print(f"{a.dst}  ({preset_label(a.preset)}, {a.strength:.0f}%, "
          f"seed {a.seed})")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
