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

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

try:
    import layouts as L
    import compose as C
except ImportError:  # package-style import
    from . import layouts as L
    from . import compose as C

RenderCancelled = C.RenderCancelled

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

def _backup_existing(p: Path) -> Optional[Path]:
    """On Drive, overwriting a file can move old version to trash. Backup instead."""
    try:
        pp = Path(p)
        if pp.exists() and pp.is_file():
            # rename existing to _prev_timestamp to avoid trash
            bak = pp.with_name(f"{pp.stem}_prev_{int(time.time())}{pp.suffix}")
            pp.rename(bak)
            return bak
    except Exception:
        pass
    return None

def _restore_backup(bak: Optional[Path], target: Path) -> None:
    if bak and bak.exists():
        try:
            # if target was deleted (cancel), restore backup
            if not target.exists():
                bak.rename(target)
        except Exception:
            pass



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


def _voice_changer_filters(cfg: Optional[Dict[str, Any]]) -> Tuple[List[str], List[str]]:
    """Return (filters, warnings) for complete voice changer.
    Uses rubberband with formant shifted for timbre change, plus optional robot effects.
    """
    c = cfg or {}
    if not c.get("voiceChanger", False):
        return [], []
    warnings: List[str] = []
    preset = str(c.get("voicePreset", "anon") or "anon").lower()
    strength = max(0.0, min(100.0, float(c.get("voiceStrength", 70.0)))) / 100.0
    extra_pitch = float(c.get("voicePitch", 0.0))
    if strength < 0.01:
        return [], []

    # map preset to base pitch
    base_pitch = 0.0
    formant_shift = True
    robot = False
    if preset == "deep":
        base_pitch = -3.5
    elif preset == "high":
        base_pitch = 4.5
    elif preset == "robot":
        base_pitch = 0.0
        robot = True
    elif preset == "custom":
        base_pitch = extra_pitch
    else:  # anon
        base_pitch = -2.2

    eff_pitch = (base_pitch + extra_pitch) * strength
    # if both pitch and formant shift are wanted, use rubberband with formant=shifted
    # This is the CapCut-like complete voice changer: changes timbre, not just pitch
    filters: List[str] = []
    if abs(eff_pitch) >= 0.05:
        if _ffmpeg_has_filter("rubberband"):
            ratio = 2.0 ** (eff_pitch / 12.0)
            # formant shifted makes voice unrecognizable (changes timbre)
            # Use high quality: transients=smooth, detector=compound
            if formant_shift:
                filters.append(f"rubberband=pitch={ratio:.5f}:formant=shifted:transients=smooth:detector=compound")
            else:
                filters.append(f"rubberband=pitch={ratio:.5f}:formant=preserved")
        else:
            # fallback: asetrate trick shifts formant + pitch together
            # e.g., pitch -2 semitones => rate 0.89, then atempo to restore duration
            ratio = 2.0 ** (eff_pitch / 12.0)
            # asetrate changes both pitch and speed, so we need atempo to fix duration
            # asetrate=44100*ratio, aresample back, then atempo=1/ratio
            # This preserves duration but shifts formant
            filters.append(f"asetrate=44100*{ratio:.5f}")
            filters.append(f"aresample=44100")
            # atempo chain for 1/ratio
            inv = 1.0 / max(0.1, ratio)
            for af in _atempo_chain(inv):
                filters.append(af)
            warnings.append("rubberband missing — using asetrate fallback for voice changer")

    # extra formant EQ for more transformation
    if preset == "deep":
        # boost low, cut high
        filters.append(f"equalizer=f=200:t=h:width=200:g={2*strength:.1f}")
        filters.append(f"equalizer=f=3000:t=h:width=800:g={-2*strength:.1f}")
    elif preset == "high":
        filters.append(f"equalizer=f=300:t=h:width=200:g={-2*strength:.1f}")
        filters.append(f"equalizer=f=3000:t=h:width=1000:g={2*strength:.1f}")
    elif preset == "anon":
        # slight telephone-like filtering plus pitch already
        filters.append(f"highpass=f={80 + 120*strength:.0f}")
        filters.append(f"lowpass=f={8000 - 3000*strength:.0f}")

    if robot:
        # robot: ring modulation + distortion + echo
        # tremolo for metallic, aecho for robot repeat, acrusher for bit reduction
        if _ffmpeg_has_filter("tremolo"):
            filters.append(f"tremolo=f=30:d={0.6*strength:.2f}")
        if _ffmpeg_has_filter("aecho"):
            filters.append(f"aecho=0.8:0.9:15|25:0.4|0.3")
        if _ffmpeg_has_filter("acrusher"):
            filters.append(f"acrusher=level_in=1:level_out=1:bits={max(4, int(12 - 6*strength))}:mode=log:aa=1")
        else:
            # fallback distortion via waveshaper-like overdrive using aevalsrc? Use volume + alimiter
            filters.append(f"acontrast=33")

    return filters, warnings


def audio_cloak_chain(cfg: Optional[Dict[str, Any]], in_label: str,
                      out_label: str, tag: str = "clk") -> Tuple[str, List[str]]:
    """ffmpeg filter_complex snippet: anti-fingerprint audio treatment.

    Tempo-preserving pitch (rubberband) -> chorus -> tilt EQ -> room echo ->
    Haas widening. Returns (snippet, warnings). Anull when disabled/empty.

    The voice changer is NOT part of this chain: it must touch the mic bus
    alone (an RVC model / formant shift over the content voices would turn
    the show into chipmunks), so the caller applies it there first.

    *tag* namespaces the internal labels so several instances can coexist
    in one filter_complex (one per reaction run — intro/outro stay clean).
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
    tagc = [0]

    def nxt() -> str:
        tagc[0] += 1
        return f"{tag}{tagc[0]}"

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


# ---------------------------------------------------------------------------
# clean vs reaction runs — intro/outro are exported EXACTLY as they are
# ---------------------------------------------------------------------------
# The user's rule: no effect of any kind may touch the intro or the outro —
# no video disguise, no audio cloak, no voice changer, not even the global
# speed tweak. Everything disguising lives in the reaction part only.

CLEAN_TYPES = ("intro", "outro")


def _clean_flags(kept: List[Dict[str, Any]]) -> List[bool]:
    """Per segment: True = must pass through untouched (intro/outro)."""
    return [str(s.get("type", "body")) in CLEAN_TYPES for s in kept]


def _passthrough_runs(kept: List[Dict[str, Any]], fast_speed: float,
                      global_speed: float
                      ) -> Tuple[List[Dict[str, Any]], List[Tuple[float, float]], float]:
    """Split *kept* into contiguous clean / reaction runs on the OUTPUT
    timeline.

    Returns (runs, out_off, total):
      * runs    — [{\"clean\": bool, \"idxs\": [segment indices], \"a\": out_start, \"b\": out_end}]
      * out_off — per segment (out_start, out_end) in programme seconds
      * total   — total programme seconds

    The cloak's global speed tweak multiplies reaction speeds only — clean
    spans always play at their own (segment) speed, i.e. untouched.
    """
    gs = max(0.5, min(2.0, float(global_speed or 1.0)))
    clean = _clean_flags(kept)
    eff: List[float] = []
    for i, s in enumerate(kept):
        e = C.seg_speed(s, float(fast_speed))
        if not clean[i]:
            e *= gs
        eff.append(e)
    out_off: List[Tuple[float, float]] = []
    t = 0.0
    for i, s in enumerate(kept):
        d = (float(s["end"]) - float(s["start"])) / max(1e-6, eff[i])
        out_off.append((t, t + d))
        t += d
    runs: List[Dict[str, Any]] = []
    for i, s in enumerate(kept):
        if runs and runs[-1]["clean"] == clean[i] and \
                runs[-1]["idxs"][-1] == i - 1:
            runs[-1]["idxs"].append(i)
            runs[-1]["b"] = out_off[i][1]
        else:
            runs.append({"clean": clean[i], "idxs": [i],
                         "a": out_off[i][0], "b": out_off[i][1]})
    return runs, out_off, t


def _voice_mode(cfg: Optional[Dict[str, Any]]) -> str:
    """'off' | 'morph' | 'rvc' | 'fx' — the voice changer flavour requested.

    "morph" (the built-in numpy engine) is the default: it needs no model
    file, no download and no GPU, so a project that just ticks the box gets
    an engine that actually runs on whatever runtime the user has.
    """
    c = cfg or {}
    if not c.get("voiceChanger", False):
        return "off"
    mode = str(c.get("voiceMode", "morph") or "morph").lower()
    if mode == "rvc":
        return "rvc"
    if mode == "fx":
        return "fx"
    return "morph"


# ---------------------------------------------------------------------------
# the voice engine: which bus gets re-voiced, and by what
# ---------------------------------------------------------------------------
# Content ID fingerprints the PROGRAMME audio, so the bus that matters most is
# the CONTENT one: re-voice the show and the matcher has nothing to grab,
# while your own commentary keeps its natural sound. The mic-only behaviour
# this started with is still available (voiceTarget = "mic"), and "both" is
# there for the single-mixed-track case.
#
# Two engines, no third option to install:
#   morph — built-in, numpy + ffmpeg only, ~10x realtime on a Colab CPU, no
#           model files and no downloads (voice_morph.py)
#   rvc   — a real neural conversion when rvc-python and a .pth are present;
#           a URL / hf:repo/file model is fetched into the cache for you

VOICE_TARGETS = ("mic", "content", "both")
_RVC_CACHE: Dict[Tuple[str, str], Any] = {}
_VOICE_CACHE = Path(os.environ.get(
    "REACT_VOICE_DIR",
    "/content/drive/MyDrive/react_voices"
    if Path("/content/drive/MyDrive").is_dir()
    else str(Path.home() / ".cache" / "reaction_studio" / "voices")))


def _voice_targets(cfg: Optional[Dict[str, Any]]) -> set:
    """Which buses the voice changer covers: {} / {"mic"} / {"content"} /
    {"mic", "content"}.

    A project saved before *voiceTarget* existed gets the old behaviour
    (mic only), so loading an old file never silently re-voices the show.
    """
    c = cfg or {}
    if not c.get("voiceChanger", False):
        return set()
    t = str(c.get("voiceTarget", "mic") or "mic").strip().lower()
    if t == "both":
        return {"mic", "content"}
    if t == "content":
        return {"content"}
    return {"mic"}


def _voice_engine(cfg: Optional[Dict[str, Any]], bus: str) -> str:
    """'none' | 'morph' | 'fx' | 'rvc' — how *bus* gets re-voiced."""
    if bus not in _voice_targets(cfg):
        return "none"
    c = cfg or {}
    mode = str(c.get("voiceMode", "morph") or "morph").strip().lower()
    if mode == "morph":
        return "morph"
    if mode == "fx":
        return "fx"
    # rvc — but a model spec that asks for the built-in engine (or one that
    # cannot be resolved) drops back to morph instead of failing the export
    spec = str(c.get("rvcModel", "") or "").strip()
    if spec.lower().startswith("builtin") or spec.lower().startswith("morph"):
        return "morph"
    return "rvc"


def _voice_cfg_for(cfg: Optional[Dict[str, Any]], bus: str) -> Dict[str, Any]:
    """The config one bus is processed with.

    "both" would otherwise push the same character onto the show and onto the
    commentator; *voicePresetMic* lets the mic keep a different one (it
    defaults to the same preset, so nothing changes unless it is set).
    """
    c = dict(cfg or {})
    if bus == "mic" and str(c.get("voiceTarget", "") or "").lower() == "both":
        alt = str(c.get("voicePresetMic", "") or "").strip()
        if alt:
            c["morphPreset"] = alt
            c["voicePreset"] = alt
        seed = c.get("morphSeedMic", None)
        if seed not in (None, ""):
            try:
                c["morphSeed"] = int(seed)
            except (TypeError, ValueError):
                pass
    return c


def _rvc_model_path(spec: str) -> Optional[Path]:
    """Resolve an RVC model spec to a local .pth (fetching it if needed).

    Accepted: a path on the notebook, an http(s) URL, or ``hf:repo/file``
    (resolved through huggingface_hub when it is installed, otherwise through
    the public resolve URL). Downloads are cached in *_VOICE_CACHE*, so a
    model is fetched once per Drive, not once per render. Returns None for an
    empty spec or the ``builtin:``/``morph:`` aliases.
    """
    raw = str(spec or "").strip()
    if not raw:
        return None
    low = raw.lower()
    if low.startswith("builtin") or low.startswith("morph"):
        return None
    p = Path(raw).expanduser()
    if p.is_file():
        return p
    _VOICE_CACHE.mkdir(parents=True, exist_ok=True)
    if low.startswith(("http://", "https://")):
        url = raw
        name = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(urlparse(url).path).name) \
            or "voice.pth"
    elif low.startswith("hf:"):
        rest = raw[3:]
        repo, _, fname = rest.partition("/")
        # a repo id alone is not enough: "hf:owner/repo" would otherwise
        # resolve to .../owner/resolve/main/repo and download an HTML error
        # page into the voice cache
        if not fname or "/" not in repo:
            raise RuntimeError(
                f"hf: model specs need a file name — got {raw!r}, want "
                f"hf:owner/repo/voice.pth")
        name = re.sub(r"[^A-Za-z0-9_.-]+", "_", fname)
        url = f"https://huggingface.co/{repo}/resolve/main/{fname}"
    else:
        # a bare name: look in the cache, then next to the notebook
        for cand in (_VOICE_CACHE / p.name, Path.cwd() / p.name,
                     Path("/content") / p.name):
            if cand.is_file():
                return cand
        raise RuntimeError(
            f"voice model {raw!r} was not found. Put the .pth on the notebook "
            f"and give its full path, paste an https:// or hf:owner/repo/file "
            f"URL, or switch the engine to the built-in morph voice (no model "
            f"needed). Looked in: {p}, {_VOICE_CACHE / p.name}")
    return _fetch_voice_file(url, name, min_bytes=100_000,
                             what="an RVC model (a .pth is tens of MB)")


def _fetch_voice_file(url: str, name: str, min_bytes: int = 100_000,
                      what: str = "voice file") -> Path:
    """Download *url* into the voice cache (once) and return the local path."""
    dst = _VOICE_CACHE / name
    if dst.is_file() and dst.stat().st_size > min_bytes:
        return dst
    _VOICE_CACHE.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + f".{os.getpid()}.part")
    import urllib.request
    print(f"  voice: downloading {url} -> {dst}")
    try:
        with urllib.request.urlopen(url, timeout=180) as r, \
                open(tmp, "wb") as fh:
            shutil.copyfileobj(r, fh, 1 << 20)
        got = tmp.stat().st_size
        if got < min_bytes:
            raise RuntimeError(
                f"{url} returned {got} bytes — that is not {what}. Check the "
                f"URL (a Hugging Face file needs "
                f"hf:owner/repo/file, and a private repo will not resolve), "
                f"or use the built-in morph voice, which needs no model.")
    except RuntimeError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001 — reported with the fix
        tmp.unlink(missing_ok=True)
        raise RuntimeError(
            f"could not download the voice model from {url}: {e}") from e
    tmp.replace(dst)
    return dst


def _rvc_index_path(spec: str) -> str:
    """Resolve the optional .index companion (path / URL / hf:), or ""."""
    raw = str(spec or "").strip()
    if not raw:
        return ""
    p = Path(raw).expanduser()
    if p.is_file():
        return str(p)
    low = raw.lower()
    try:
        if low.startswith(("http://", "https://")):
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_",
                          Path(urlparse(raw).path).name) or "voice.index"
            return str(_fetch_voice_file(raw, name, min_bytes=1024,
                                         what="an RVC index"))
        if low.startswith("hf:"):
            repo, _, fname = raw[3:].partition("/")
            if not fname or "/" not in repo:
                raise RuntimeError(
                    f"hf: index specs need a file name — got {raw!r}, want "
                    f"hf:owner/repo/voice.index")
            url = (f"https://huggingface.co/{repo}/resolve/main/{fname}")
            return str(_fetch_voice_file(
                url, re.sub(r"[^A-Za-z0-9_.-]+", "_", fname),
                min_bytes=1024, what="an RVC index"))
    except RuntimeError as e:
        # an index is an optional refinement — never fail the render over it
        print(f"  (voice: skipping the .index — {e})")
        return ""
    for cand in (_VOICE_CACHE / p.name, Path.cwd() / p.name,
                 Path("/content") / p.name):
        if cand.is_file():
            return str(cand)
    print(f"  (voice: .index {raw!r} not found — continuing without it)")
    return ""


def _rvc_pick_device() -> str:
    """cuda when it can actually be used, else cpu (checked, not guessed)."""
    try:
        import torch  # noqa: F401
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _rvc_get(model: str, device: str):
    """Load (and cache) an RVC inference session for *model* on *device*."""
    key = (str(model), device)
    hit = _RVC_CACHE.get(key)
    if hit is not None:
        return hit
    from rvc_python.infer import RVCInfer  # noqa: deferred — heavy import
    sess = RVCInfer(device=device, model_path=str(model))
    _RVC_CACHE[key] = sess
    return sess


def _rvc_convert_file(sess: Any, src: Path, dst: Path,
                      cfg: Dict[str, Any]) -> None:
    """Run one wav through the RVC session (tolerant of API drift)."""
    transpose = int(round(float(cfg.get("rvcTranspose", 0) or 0)))
    index_rate = max(0.0, min(1.0, float(cfg.get("rvcIndexRate", 0.5) or 0.0)))
    method = str(cfg.get("rvcMethod", "rmvpe") or "rmvpe").lower()
    index = _rvc_index_path(cfg.get("rvcIndex", ""))
    if index:
        try:
            setattr(sess, "index_path", index)
        except Exception:
            pass
    variants = (
        dict(input=str(src), output=str(dst), f0_up_key=transpose,
             index_rate=index_rate, method=method),
        dict(input=str(src), output=str(dst), transpose=transpose,
             index_rate=index_rate, method=method),
        dict(input_path=str(src), output_path=str(dst), f0_up_key=transpose,
             index_rate=index_rate, f0_method=method),
    )
    last: Optional[Exception] = None
    for kw in variants:
        try:
            sess.infer_file(**kw)
            if Path(dst).is_file() and dst.stat().st_size > 1000:
                return
        except TypeError as e:
            last = e
            continue
        except Exception as e:  # noqa: BLE001 — surfaced by the caller
            raise RuntimeError(f"RVC inference failed on {src.name}: {e}") from e
    raise RuntimeError(f"RVC inference produced nothing for {src.name}"
                       + (f" ({last})" if last else ""))


def _run_is_silent(proc: "ReactionVideoProcessor", wav: Path,
                   run: Dict[str, Any], thresh_db: float = -60.0) -> bool:
    """True when a run carries no audio worth converting.

    A mute or card span silences the CONTENT bus, and pushing silence through
    a voice converter is pure waste (minutes per part on a CPU) — it would
    also lay a breath/noise floor exactly where the mix expects digital
    silence. Measured with volumedetect, never assumed from the segment map.
    """
    try:
        out = proc._ff(["ffmpeg", "-hide_banner", "-v", "info",
                        "-ss", f"{run['a']:.3f}",
                        "-t", f"{max(0.05, run['b'] - run['a']):.3f}",
                        "-i", str(wav), "-map", "0:a", "-af", "volumedetect",
                        "-f", "null", "-"], "voice: level check")
    except RuntimeError:
        return False
    m = re.findall(r"max_volume:\s*(-?[\d.]+)\s*dB", out)
    if not m:
        return False
    return float(m[-1]) <= thresh_db


def _voice_runs_splice(proc: "ReactionVideoProcessor", wav: Path,
                       runs: List[Dict[str, Any]], tag: str,
                       convert: Callable[[Path, Path, Dict[str, Any]], None],
                       skip_silent: bool = False) -> Path:
    """Re-voice the reaction runs of *wav*, leaving everything else alone.

    *convert(dry, wet, run)* does the actual work (RVC session, morph, …).
    Clean runs (intro/outro) are copied bit-for-bit, silent runs are copied
    as well when *skip_silent*, and the runs are stitched back in order, so
    the result is exactly as long as the input — the A/V alignment the whole
    passthrough design depends on.
    """
    work = proc.work
    parts: List[Path] = []
    whole = proc._media_duration(str(wav))
    for r, run in enumerate(runs):
        seg_wav = work / f"{tag}_run{r:02d}.wav"
        if run["clean"]:
            # untouched copy of the clean run (intro/outro stay as-is)
            if run["a"] <= 0.001 and run["b"] >= whole - 0.001:
                parts.append(wav)   # the only run — no extraction needed
            else:
                proc._ff(["ffmpeg", "-y", "-v", "error", "-i", str(wav),
                          "-ss", f"{run['a']:.3f}", "-to", f"{run['b']:.3f}",
                          "-c:a", "pcm_s16le", str(seg_wav)],
                         f"voice: clean run {r + 1}")
                parts.append(seg_wav)
            continue
        if skip_silent and _run_is_silent(proc, wav, run):
            proc._ff(["ffmpeg", "-y", "-v", "error", "-i", str(wav),
                      "-ss", f"{run['a']:.3f}", "-to", f"{run['b']:.3f}",
                      "-c:a", "pcm_s16le", str(seg_wav)],
                     f"voice: silent run {r + 1}")
            parts.append(seg_wav)
            print(f"  voice: run {r + 1} is silent (muted span) — passed "
                  f"through instead of converted")
            continue
        dry = work / f"{tag}_react{r:02d}.wav"
        wet = work / f"{tag}_react{r:02d}_wet.wav"
        proc._ff(["ffmpeg", "-y", "-v", "error", "-i", str(wav),
                  "-ss", f"{run['a']:.3f}", "-to", f"{run['b']:.3f}",
                  "-c:a", "pcm_s16le", str(dry)], f"voice: extract run {r + 1}")
        convert(dry, wet, run)
        # a converter can drift a few ms — fit it back onto the run length
        parts.append(proc._fit_audio(wet, run["b"] - run["a"],
                                     f"voice run {r + 1}"))
    if len(parts) == 1 and parts[0] == wav:
        return wav
    out = work / f"{tag}_voice.wav"
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for p_ in parts:
        cmd += ["-i", str(p_)]
    cmd += ["-filter_complex",
            "".join(f"[{i}:a]" for i in range(len(parts)))
            + f"concat=n={len(parts)}:v=0:a=1[vout]",
            "-map", "[vout]", "-c:a", "pcm_s16le", str(out)]
    proc._ff(cmd, "voice: join runs")
    return out


def _rvc_ensure_installed() -> str:
    """Import rvc-python, trying a one-shot install when it is missing.

    Returns a note for the log ("" when it was already importable) and never
    raises: the caller decides whether a missing rvc-python is fatal, and the
    built-in morph is always there as the fallback. Set
    REACT_RVC_AUTOINSTALL=0 to keep the runtime's packages untouched.
    """
    try:
        import rvc_python  # noqa: F401
        return ""
    except ImportError:
        pass
    if os.environ.get("REACT_RVC_AUTOINSTALL", "1") == "0":
        return " (rvc-python missing — auto-install disabled)"
    print("  voice: rvc-python is not installed — trying  pip install "
          "rvc-python  once (set REACT_RVC_AUTOINSTALL=0 to skip)")
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                        "--disable-pip-version-check", "rvc-python"],
                       check=False, timeout=1800)
        import rvc_python  # noqa: F401  # noqa: F811
        return (" (rvc-python was installed just now — if inference fails, "
                "restart the runtime so torch/fairseq settle)")
    except Exception as e:  # noqa: BLE001
        return f" (rvc-python could not be installed: {e})"


def _voice_rvc_runs(proc: "ReactionVideoProcessor", wav: Path,
                    runs: List[Dict[str, Any]], cfg: Dict[str, Any],
                    tag: str = "rvc") -> Path:
    """Replace the reaction runs of *wav* with their RVC conversion."""
    model_path = _rvc_model_path(str(cfg.get("rvcModel", "") or ""))
    if model_path is None:
        raise RuntimeError(
            "the voice changer is set to RVC but no model was given — paste a "
            "path, an https:// URL or hf:owner/repo/file.pth, or switch the "
            "engine to the built-in morph voice, which needs no model at all")
    note = _rvc_ensure_installed()
    try:
        import rvc_python  # noqa: F401
    except ImportError as e:
        hint = note or " — run  %pip install rvc-python  in the notebook"
        raise RuntimeError(
            "the voice changer is set to an RVC character voice but "
            f"rvc-python is not usable{hint}; or switch the engine to the "
            "built-in morph voice, which needs no install and no model "
            "file") from e
    device = _rvc_pick_device()
    print(f"  voice: RVC model {model_path.name} on {device} "
          f"(transpose {cfg.get('rvcTranspose', 0)}, method "
          f"{cfg.get('rvcMethod', 'rmvpe')}){note}")
    sess = _rvc_get(str(model_path), device)

    def convert(dry: Path, wet: Path, _run: Dict[str, Any]) -> None:
        _rvc_convert_file(sess, dry, wet, cfg)

    return _voice_runs_splice(proc, wav, runs, tag, convert, skip_silent=True)


def _voice_morph_runs(proc: "ReactionVideoProcessor", wav: Path,
                      runs: List[Dict[str, Any]], cfg: Dict[str, Any],
                      tag: str = "morph") -> Path:
    """Replace the reaction runs of *wav* with the built-in morph voice.

    numpy + ffmpeg only: no torch, no model files, no downloads, ~10x realtime
    on a Colab CPU — the engine that still works when the runtime has no GPU.
    """
    import voice_morph as VM
    plan = VM.plan_for(cfg)
    print(f"  voice: built-in morph '{VM.preset_label(plan['preset'])}' on cpu "
          f"(pitch {plan['pitch']:+.1f} st, formant {plan['formant']:.2f}, "
          f"strength {plan['strength'] * 100:.0f}%, seed {int(plan['seed'])})")

    def convert(dry: Path, wet: Path, _run: Dict[str, Any]) -> None:
        VM.morph_file(dry, wet, cfg)

    return _voice_runs_splice(proc, wav, runs, tag, convert, skip_silent=True)


def _voice_apply(proc: "ReactionVideoProcessor", wav: Path,
                 runs: List[Dict[str, Any]], cfg: Optional[Dict[str, Any]],
                 bus: str, tag: str) -> Path:
    """Run *bus* through whichever engine the config asks for."""
    c = _voice_cfg_for(cfg, bus)
    engine = _voice_engine(cfg, bus)
    if engine == "morph":
        return _voice_morph_runs(proc, wav, runs, c, tag=tag)
    if engine == "rvc":
        return _voice_rvc_runs(proc, wav, runs, c, tag=tag)
    if engine == "fx":
        return proc._voice_fx_wav(wav, runs, c, tag=tag)
    return wav


def _vignette_angle(amount: float) -> float:
    """ffmpeg `vignette` lens angle for a 0..100 slider, matched to the
    corner darkening of the browser's radial gradient.

    ffmpeg's vignette is a cos-power falloff normalised to the frame
    corner: at a=PI/2 the corners are pure black and a=1.3 blacks out
    everything but the centre (the old mapping went *backwards* from
    PI/2, so even the default 25 looked like a maxed-out vignette). The
    gradient the preview fills darkens the corner by amount/100*0.55*0.72,
    and a ~= 0.45*sqrt(v/100) lands the filter's corner gain on that.
    Only a fallback — the passthrough composes the gradient itself as a
    PNG overlay, so export and preview match exactly.
    """
    v = max(0.0, min(100.0, float(amount)))
    return 0.45 * (v / 100.0) ** 0.5


def _fisheye_vfilter(amount: float) -> Optional[str]:
    """Map 0..100 fisheye amount to ffmpeg lenscorrection filter
    (FFmpeg 7.0+). Negative k1 creates barrel (fisheye) distortion.
    Returns None if disabled.
    """
    a = max(0.0, min(100.0, float(amount or 0.0)))
    if a < 0.5:
        return None
    # 0..100 -> k1 -0.02..-0.5, k2 similar but smaller for natural falloff
    # Use cx=0.5 cy=0.5 center
    k1 = -0.02 - (a / 100.0) * 0.48  # -0.02 .. -0.50
    k2 = k1 * 0.35  # secondary
    return f"lenscorrection=k1={k1:.3f}:k2={k2:.3f}:cx=0.5:cy=0.5"


def _fisheye_exp(amount: float) -> float:
    """The radial exponent the browser grid uses (drawFisheyeGrid in
    render.ts): exp = 1 + amount/100 * 1.8."""
    return 1.0 + (max(0.0, min(100.0, float(amount or 0.0))) / 100.0) * 1.8


def _fisheye_coords(amount: float, W: int, H: int
                    ) -> Tuple[np.ndarray, np.ndarray]:
    """(xmap, ymap) uint16 arrays for ffmpeg's `remap` filter: for every
    output pixel, the source pixel the browser's fisheye grid samples.

    r_src = min(1, r/rmax)^exp * rmax with rmax the half diagonal — the
    exact math of render.ts (corners pinned, centre bulged). Out-of-range
    values are clamped to the frame: `remap` paints anything outside as
    black, and the mapping never actually leaves the frame.
    """
    exp = _fisheye_exp(amount)
    hw, hh = W / 2.0, H / 2.0
    rmax = float(np.hypot(hw, hh))
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    dx, dy = xx - hw, yy - hh
    ro = np.hypot(dx, dy)
    rn = np.clip(ro / max(1e-6, rmax), 0.0, 1.0)
    rsrc = np.power(rn, exp) * rmax
    s = np.where(ro > 0.001, rsrc / np.maximum(ro, 0.001), 0.0)
    xmap = np.clip(hw + dx * s, 0, W - 1).round().astype(np.uint16)
    ymap = np.clip(hh + dy * s, 0, H - 1).round().astype(np.uint16)
    return xmap, ymap


def _fisheye_geq(amount: float, W: int, H: int) -> Optional[str]:
    """The same remap written as pure `geq` expressions — the last-resort
    backend for builds without `remap` or `lenscorrection`. It is an mexpr
    evaluation per pixel per plane, so it is SLOW (a few fps at 1080p);
    only used when nothing better is available.
    """
    a = max(0.0, min(100.0, float(amount or 0.0)))
    if a < 0.5:
        return None
    exp = _fisheye_exp(a)
    hw, hh = W / 2.0, H / 2.0
    rmax = float(np.hypot(hw, hh))

    def coord(axis: str, other: str) -> str:
        c = hw if axis == "X" else hh
        co = hh if axis == "X" else hw
        r = (f"(({axis}-{c:.4f})*({axis}-{c:.4f})"
             f"+({other}-{co:.4f})*({other}-{co:.4f}))")
        rn = f"min(1,sqrt({r})/{rmax:.4f})"
        s = (f"(pow({rn},{exp:.4f})*{rmax:.4f})"
             f"/max(0.001,sqrt({r}))")
        return f"{c:.4f}+({axis}-{c:.4f})*{s}"

    xs, ys = coord("X", "Y"), coord("Y", "X")
    return f"geq=lum='p({xs},{ys})':cb='p({xs},{ys})':cr='p({xs},{ys})'"


class FisheyePlan:
    """How the fisheye will actually be applied in an ffmpeg graph.

    * kind "remap": two 16-bit x/y maps ride in as single-frame PNG inputs
      (like the card / vignette stills) and a `remap` stage is spliced in.
      Exact preview math (pixel-verified against render.ts), fast, and
      available on every FFmpeg since 3.1 — this is the default.
    * kind "filter": a plain in-chain filter string — `lenscorrection`
      (FFmpeg 7+) or the slow `geq` fallback.
    * kind "none": disabled, or no usable backend (the caller already has
      a warning about that).

    The preview canvas always draws the fisheye, so silently falling back
    to "none" is exactly the "shows in preview, missing from export" bug —
    the plan tries every backend before giving up.
    """

    def __init__(self, kind: str = "none", filter_str: str = "",
                 map_x: Optional[Path] = None, map_y: Optional[Path] = None,
                 note: str = ""):
        self.kind = kind
        self.filter_str = filter_str
        self.map_x = map_x
        self.map_y = map_y
        self.note = note


def _video_cloak_split(cfg: Optional[Dict[str, Any]], W: int, H: int,
                       fisheye: Optional[str] = None
                       ) -> Tuple[List[str], List[str]]:
    """(filters before the vignette overlay, filters after it).

    The browser draws its vignette over the colour/grain and under the
    cover bars + frame, so the passthrough graph inserts the gradient PNG
    between these two halves.

    When contentOnly is True (default), zoom/blur/eq/hue/grain/flipContent/rotate
    are NOT applied full-frame here — they are applied only to the content rect
    in _passthrough_graph via _content_cloak_filters. This preserves camera.

    The fisheye is deliberately NOT decided here. It has to be chosen per
    segment (intro/outro stay clean) and per ffmpeg build (remap maps /
    lenscorrection / geq — see _plan_fisheye), so the caller passes the
    resolved filter string (or None); when given, it lands in `pre` at the
    end of the legacy full-frame chain.
    """
    c = cfg or {}
    # even if on=False, a standalone fisheye still counts as "active"
    has_on = bool(c.get("on", False))
    if not has_on and not fisheye:
        return [], []
    content_only = bool(c.get("contentOnly", True))
    zoom = max(1.0, min(1.2, float(c.get("zoom", 1.0)))) if has_on else 1.0
    bars = max(0.0, min(12.0, float(c.get("bars", 0.0)))) if has_on else 0.0
    border = max(0.0, min(24.0, float(c.get("border", 0.0)))) if has_on else 0.0
    border_color = str(c.get("borderColor", "#0ea5e9")).lstrip("#") or "0ea5e9"
    saturate = float(c.get("saturate", 100.0)) / 100.0 if has_on else 1.0
    contrast = float(c.get("contrast", 100.0)) / 100.0 if has_on else 1.0
    brightness = (float(c.get("brightness", 100.0)) - 100.0) / 100.0 if has_on else 0.0
    hue = float(c.get("hue", 0.0)) if has_on else 0.0
    grain = float(c.get("grain", 0.0)) if has_on else 0.0
    blur = float(c.get("blur", 0.0)) if has_on else 0.0
    rotate = float(c.get("rotate", 0.0)) if has_on else 0.0

    pre: List[str] = []
    post: List[str] = []

    if not content_only:
        # legacy full-frame path: zoom/eq/fisheye land here, and a legacy
        # `flip` is applied once to the finished programme after the concat
        # (see _passthrough_graph) — a content-rect mirror rides per segment.
        # The fisheye, when the caller resolved one, lands here.
        if abs(rotate) > 0.05:
            pre.append(f"rotate={rotate}*PI/180:fillcolor=black")
        if zoom > 1.001:
            pre.append(f"scale=iw*{zoom:.4f}:-2:flags=lanczos")
            pre.append(f"crop=trunc(iw/{zoom:.4f}/2)*2:trunc(ih/{zoom:.4f}/2)*2")
            pre.append(f"scale={W}:{H}")
        if abs(saturate - 1.0) > 0.005 or abs(contrast - 1.0) > 0.005 \
                or abs(brightness) > 0.005:
            pre.append(f"eq=saturation={saturate:.3f}:contrast={contrast:.3f}:"
                       f"brightness={brightness:.3f}")
        if abs(hue) > 0.5:
            pre.append(f"hue=h={hue:.1f}")
        if blur > 0.05:
            pre.append(f"gblur=sigma={min(3.0, blur):.2f}")
        if grain > 0.5:
            pre.append(f"noise=alls={min(30, grain / 100.0 * 14.0):.1f}:allf=t")
        if fisheye:
            pre.append(fisheye)

    if bars > 0.05:
        bh = max(1, int(round(H * bars / 100.0)))
        post.append(f"drawbox=y=0:w=iw:h={bh}:c=black:t=fill")
        post.append(f"drawbox=y=ih-{bh}:w=iw:h={bh}:c=black:t=fill")
    if border > 0.5:
        bw = max(1, int(round(border * H / 1080.0)))
        o = bw // 2
        post.append(f"drawbox=x={o}:y={o}:w=iw-{2 * o}:h=ih-{2 * o}:"
                    f"c=0x{border_color}:t={bw}")
    return pre, post


def resolve_mirror(video_cloak: Optional[Dict[str, Any]],
                   seg: Optional[Dict[str, Any]] = None,
                   clean: bool = False,
                   content_only: bool = True) -> Dict[str, Any]:
    """Python twin of resolveMirror() in src/lib/types.ts.

    Returns {mode, keep_bottom, content_flip, frame_flip}. *clean* spans
    (intro/outro) are never mirrored — the rule the whole cloak follows:
    your full-cam solo is exported exactly as recorded.

    * mode "content" → only the watched programme is flipped (camera and the
      card text stay readable),
    * mode "frame"   → the whole picture, camera included,
    * mode "legacy"  → a project saved before v7 (`flip` / `flipContent`):
      whole frame when contentOnly is off, content rect otherwise.
    * mirrorScope "blocks" means only the segments carrying `mirror: true`
      flip — the tick list the Cloak tab shows.

    *content_only* is the project's `videoCloak.contentOnly`: a legacy `flip`
    on the old full-frame path flips the WHOLE frame in the browser, so it has
    to flip the whole frame here too (the twin of `legacyWhole`).
    """
    off = {"mode": "off", "keep_bottom": 0.0, "content_flip": False,
           "frame_flip": False, "legacy_whole": False}
    if clean:
        return off
    c = video_cloak or {}
    raw = c.get("mirrorMode")
    if raw in ("off", "content", "frame"):
        mode = str(raw)
    elif c.get("flipContent"):
        mode = "content"
    elif c.get("flip"):
        mode = "legacy"
    else:
        mode = "off"
    if mode == "off":
        return off
    if str(c.get("mirrorScope") or "reaction").lower() == "blocks" \
            and not (seg or {}).get("mirror"):
        return off
    kb = 0.0
    if mode == "content":
        try:
            kb = max(0.0, min(0.6, float(c.get("mirrorKeepBottom") or 0.0)))
        except (TypeError, ValueError):
            kb = 0.0
    if mode == "legacy":
        # pre-v7 `flip`: the whole frame on the legacy (contentOnly=false)
        # path, the content rect everywhere else — bit-for-bit what render.ts
        # does. `legacy_whole` flips the segment's own picture (before the
        # card and the camera restore are drawn), NOT the finished frame:
        # that is the order the browser canvas uses.
        return {"mode": mode, "keep_bottom": 0.0,
                "content_flip": bool(content_only),
                "frame_flip": False,
                "legacy_whole": not content_only}
    return {"mode": mode, "keep_bottom": kb,
            "content_flip": mode == "content",
            "frame_flip": mode == "frame",
            "legacy_whole": False}


def _content_cloak_filters(cfg: Optional[Dict[str, Any]], W: int, H: int,
                           content_rect: Optional[Dict[str, float]] = None,
                           mirror: Optional[Dict[str, Any]] = None) -> List[str]:
    """Filters that apply ONLY to the content area when contentOnly=True.

    The fisheye is NOT part of this list: it is a per-segment stage (the
    `remap` filter with its map inputs, or an in-chain filter on other
    builds) that _passthrough_graph splices in AFTER these — so intro/outro
    can skip it while body/mute/fast/card keep it.

    The content mirror is NOT part of this list either when a bottom strip
    has to stay readable (`mirrorKeepBottom`): that needs a crop + hflip +
    overlay, which the caller builds (see _passthrough_graph). With no strip
    kept, a plain hflip is all it takes and it lands here.
    """
    c = cfg or {}
    has_on = bool(c.get("on", False))
    mir = mirror
    if mir is None:
        flip_content = bool(c.get("flipContent") or c.get("flip")) if has_on else False
        keep_bottom = 0.0
    else:
        flip_content = bool(mir.get("content_flip"))
        keep_bottom = float(mir.get("keep_bottom") or 0.0)
    if not has_on or not c.get("contentOnly", True):
        if not flip_content:
            return []
    zoom = max(1.0, min(1.2, float(c.get("zoom", 1.0)))) if has_on else 1.0
    saturate = float(c.get("saturate", 100.0)) / 100.0 if has_on else 1.0
    contrast = float(c.get("contrast", 100.0)) / 100.0 if has_on else 1.0
    brightness = (float(c.get("brightness", 100.0)) - 100.0) / 100.0 if has_on else 0.0
    hue = float(c.get("hue", 0.0)) if has_on else 0.0
    grain = float(c.get("grain", 0.0)) if has_on else 0.0
    blur = float(c.get("blur", 0.0)) if has_on else 0.0
    rotate = float(c.get("rotate", 0.0)) if has_on else 0.0

    f: List[str] = []
    if flip_content and keep_bottom <= 0.001:
        # the whole content area flips; with a strip kept, the caller does
        # the crop + hflip + overlay instead
        f.append("hflip")
    if abs(rotate) > 0.05:
        f.append(f"rotate={rotate}*PI/180:fillcolor=black")
    if zoom > 1.001:
        f.append(f"scale=iw*{zoom:.4f}:ih*{zoom:.4f}:flags=lanczos")
        f.append(f"crop=trunc(iw/{zoom:.4f}/2)*2:trunc(ih/{zoom:.4f}/2)*2")
    if abs(saturate - 1.0) > 0.005 or abs(contrast - 1.0) > 0.005 \
            or abs(brightness) > 0.005:
        f.append(f"eq=saturation={saturate:.3f}:contrast={contrast:.3f}:"
                 f"brightness={brightness:.3f}")
    if abs(hue) > 0.5:
        f.append(f"hue=h={hue:.1f}")
    if blur > 0.05:
        f.append(f"gblur=sigma={min(3.0, blur):.2f}")
    if grain > 0.5:
        f.append(f"noise=alls={min(30, grain / 100.0 * 14.0):.1f}:allf=t")
    return f


def _video_cloak_filters(cfg: Optional[Dict[str, Any]], W: int, H: int) -> List[str]:
    """Raw vf list for the frame cloak (shared by snippet + per-segment use).

    Stands on its own (no overlay input to hang a gradient PNG on), so the
    vignette here is the calibrated `vignette` filter rather than the exact
    browser gradient the passthrough graph composites.

    The fisheye here can only use the in-chain filter backends
    (lenscorrection / geq) — the remap backend needs map inputs this
    snippet has nowhere to declare.
    """
    c = cfg or {}
    has_on = bool(c.get("on", False))
    has_fisheye = bool(c.get("fisheye", False)) and float(c.get("fisheyeAmount", 0.0)) > 0.5
    if not has_on and not has_fisheye:
        return []
    # no mirror here: mirroring is always content-only, which needs the
    # content rect the graph has and this snippet doesn't
    pre, post = _video_cloak_split(c, W, H, fisheye=None)
    f = list(pre)
    if has_on and float(c.get("vignette", 0.0)) > 0.5:
        f.append(f"vignette=a={_vignette_angle(c.get('vignette', 0.0)):.4f}")
    f.extend(post)
    if has_fisheye:
        if _ffmpeg_has_filter("lenscorrection"):
            f.append(_fisheye_vfilter(c.get("fisheyeAmount", 35)))
        elif _ffmpeg_has_filter("geq"):
            f.append(_fisheye_geq(c.get("fisheyeAmount", 35), W, H))
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


def _fade_filters(out_dur: float, fade_s: float, fade_in: bool = True,
                  fade_out: bool = True) -> List[str]:
    """afade pair for one conformed audio span (empty when pointless).

    *out_dur* is the span's OUTPUT seconds (after atempo); the fade is
    clamped to half of it so short spans can't go negative.
    """
    f = max(0.0, min(float(fade_s or 0.0), max(0.0, float(out_dur)) / 2.0))
    if f < 0.015:
        return []
    out = []
    if fade_in:
        out.append(f"afade=t=in:st=0:d={f:.3f}")
    if fade_out:
        out.append(f"afade=t=out:st={max(0.0, float(out_dur) - f):.3f}:d={f:.3f}")
    return out


def _fade_edges(spans: List[Dict[str, Any]], i: int,
                states: List[Any]) -> Tuple[bool, bool]:
    """(fade_in, fade_out) for spans[i]: skip the dip where the join is
    source-continuous with an identical state, so only real cuts,
    card/mute edges and speed changes get smoothed."""
    a = float(spans[i]["start"])
    b = float(spans[i]["end"])
    fade_in, fade_out = True, True
    if i > 0 and states[i - 1] == states[i] and \
            abs(float(spans[i - 1]["end"]) - a) < 0.02:
        fade_in = False
    if i + 1 < len(spans) and states[i + 1] == states[i] and \
            abs(b - float(spans[i + 1]["start"])) < 0.02:
        fade_out = False
    return fade_in, fade_out


def _card_variant(s: Dict[str, Any]) -> str:
    """A card span's size variant ("full" unless stored as short)."""
    c = s.get("card") or {}
    return "short" if str(c.get("variant") or "").strip().lower() == "short" \
        else "full"


def _card_sig(s: Dict[str, Any]) -> Tuple[str, float]:
    """Card merge key: variant + playback speed.

    Two adjacent card spans only merge when they look and run the same way —
    the Python twin of sameVariant() in src/lib/timeline.ts.
    """
    c = s.get("card") or {}
    try:
        sp = round(float(c.get("speed", 1.0) or 1.0), 3)
    except (TypeError, ValueError):
        sp = 1.0
    return (_card_variant(s), sp)


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
# chunked / resumable renders
#
# A 3840x1080 Patreon render on Colab's 2 vCPUs runs at roughly 1.5-3 output
# frames per second, i.e. hours — longer than the ~90 min idle reclaim, so a
# single-pass render of a long capture can never finish. Rendering the
# timeline in parts fixes that: every finished part is journalled to disk, so
# a reclaimed runtime costs one part instead of the whole render.
# ---------------------------------------------------------------------------

PARTS_DIRNAME = "_parts"
MANIFEST_NAME = "manifest.json"
# a part whose picture probes outside this tolerance of its planned length is
# treated as half-written (reclaimed mid-encode) and rebuilt
PART_TOL_S = 0.5


def prog_len(segments: List[Dict[str, Any]], fast_speed: float = 4.0) -> float:
    """Programme (output) seconds covered by *segments*."""
    return C.render_duration(segments, float(fast_speed))


def plan_parts(kept: List[Dict[str, Any]], fast_speed: float,
               part_target: float, min_part: float = 20.0
               ) -> List[List[Dict[str, Any]]]:
    """Split a segment list into parts of ~*part_target* programme seconds.

    Splits always land on frame boundaries of the *programme*, and a segment
    is sliced rather than padded, so concatenating the parts reproduces the
    unchunked plan exactly: trim/atrim ranges tile [start, end) with no gap
    and no overlap. A trailing part shorter than *min_part* is folded back
    into the previous one (tiny tails are pure overhead).
    """
    if part_target <= 0:
        raise ValueError("part_target must be > 0")
    parts: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    cur_len = 0.0

    def close() -> None:
        nonlocal cur, cur_len
        if cur:
            parts.append(cur)
            cur, cur_len = [], 0.0

    for s in kept:
        typ = str(s.get("type", "body"))
        a, b = float(s["start"]), float(s["end"])
        # programme seconds per source second — a fast span's (or a sped-up
        # card's) programme time is its source time DIVIDED by its speed
        rate = 1.0 / max(1e-6, C.seg_speed(s, float(fast_speed)))
        # `mirror` rides along: a chunked render slices segments, and the
        # tick has to survive the slice or the parts lose the mirror
        base = {k: s[k] for k in ("type", "card", "mirror") if k in s}
        while b - a > 1e-6:
            take = b - a
            room = part_target - cur_len
            if take * rate > room and room > 1e-6:
                take = room / rate
            piece = dict(base)
            piece["start"], piece["end"] = a, a + take
            cur.append(piece)
            cur_len += take * rate
            a += take
            if cur_len >= part_target - 1e-6:
                close()
    close()
    if len(parts) > 1 and prog_len(parts[-1], fast_speed) < min_part:
        parts[-2].extend(parts[-1])
        parts.pop()
    return [p for p in parts if p]


def auto_part_target(total_prog: float, lo: float = 90.0, hi: float = 240.0,
                     min_parts: int = 1) -> float:
    """Pick a part length: short renders stay one pass, long ones chunk.

    Nothing under 5 min of programme is chunked at all — one pass is both
    faster and simpler, and those renders fit inside a runtime easily.
    """
    if total_prog <= 300.0:
        return max(1.0, total_prog)
    target = max(lo, min(hi, total_prog / max(min_parts, 1)))
    return min(target, max(lo, total_prog / 2.0))


def parts_dir(out_dir: Path, key: str) -> Path:
    return Path(out_dir) / PARTS_DIRNAME / key


def read_manifest(out_dir: Path, key: str) -> Optional[Dict[str, Any]]:
    p = parts_dir(out_dir, key) / MANIFEST_NAME
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_manifest(out_dir: Path, key: str, man: Dict[str, Any]) -> None:
    d = parts_dir(out_dir, key)
    d.mkdir(parents=True, exist_ok=True)
    man["updated"] = time.time()
    tmp = d / (MANIFEST_NAME + ".tmp")
    tmp.write_text(json.dumps(man, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    tmp.replace(d / MANIFEST_NAME)


def list_journals(out_dir: Path) -> List[Dict[str, Any]]:
    """Every render journal on disk, newest first (drives Resume)."""
    root = Path(out_dir) / PARTS_DIRNAME
    out: List[Dict[str, Any]] = []
    try:
        for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime,
                        reverse=True):
            man = read_manifest(out_dir, d.name)
            if man:
                man.setdefault("key", d.name)
                out.append(man)
    except OSError:
        return []
    return out


class StallTimeout(RuntimeError):
    """An encoder went quiet for longer than the stall budget."""


class RenderPaused(RuntimeError):
    """A time budget stopped the render between parts — resumable."""


class _EncoderRun:
    """Run ffmpeg while reporting progress and killing stalls.

    ffmpeg only writes progress lines to stderr, so a render that hangs on a
    Drive hiccup looks exactly like a slow render. Anything that stops
    emitting a `time=` line for *stall_min* minutes is killed with a clear
    message instead of holding the job slot forever.
    """

    def __init__(self, cmd: List[str], total: float, what: str,
                 progress_cb=None, cancel_check=None, stall_min: float = 30.0,
                 out_path: Optional[Path] = None,
                 heartbeat: Optional[Callable[[], None]] = None):
        self.cmd = cmd
        self.total = max(1e-6, float(total))
        self.what = what
        self.progress_cb = progress_cb
        self.cancel_check = cancel_check
        self.stall_min = float(stall_min)
        self.out_path = out_path
        self.heartbeat = heartbeat
        self.last = time.time()
        self.last_t = 0.0
        self.tail: List[str] = []

    def run(self) -> None:
        p = subprocess.Popen(self.cmd, stderr=subprocess.STDOUT,
                             stdout=subprocess.PIPE, text=True, bufsize=1)
        assert p.stdout is not None
        try:
            for line in p.stdout:
                self.tail.append(line)
                if len(self.tail) > 60:
                    self.tail.pop(0)
                self.last = time.time()
                m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
                if m:
                    t = (int(m.group(1)) * 3600 + int(m.group(2)) * 60
                         + float(m.group(3)))
                    self.last_t = max(self.last_t, t)
                    if self.progress_cb:
                        self.progress_cb(min(t, self.total), self.total)
                if self.cancel_check is not None and self.cancel_check():
                    _kill_proc(p)
                    self._discard()
                    raise RenderCancelled("render cancelled by user")
                if (self.stall_min > 0 and
                        time.time() - self.last > self.stall_min * 60.0):
                    _kill_proc(p)
                    self._discard()
                    raise StallTimeout(
                        f"{self.what}: ffmpeg produced no output for "
                        f"{self.stall_min:.0f} min — stopped at "
                        f"{self.last_t:.0f}s of {self.total:.0f}s. "
                        "Usually the Drive mount went away or the runtime ran "
                        "out of CPU; the finished parts are kept, so resume "
                        "to continue.")
                if self.heartbeat is not None:
                    self.heartbeat()
        finally:
            p.wait()
        if self.cancel_check is not None and self.cancel_check():
            self._discard()
            raise RenderCancelled("render cancelled by user")
        if p.returncode != 0:
            raise RuntimeError(f"{self.what} failed:\n" + "".join(self.tail)[-2000:])

    def _discard(self) -> None:
        if self.out_path is not None:
            try:
                Path(self.out_path).unlink(missing_ok=True)
            except OSError:
                pass


def _kill_proc(p: "subprocess.Popen") -> None:
    try:
        p.kill()
    except OSError:
        pass
    try:
        p.wait(timeout=15)
    except Exception:  # noqa: BLE001
        pass


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
        # Try GPU first (float16 is ~3-4x faster on T4, uses GPU RAM)
        # Colab warning "GPU runtime but not utilizing GPU" comes from
        # ffmpeg running CPU-only + whisper falling back to CPU.
        # We explicitly try cuda, then auto, then cpu.
        last_exc = None
        for kwargs in (
            {"device": "cuda", "compute_type": "float16"},
            {"device": "cuda", "compute_type": "int8_float16"},
            {"device": "auto"},
        ):
            try:
                _FW_MODELS[name] = WhisperModel(name, **kwargs)
                dev = getattr(_FW_MODELS[name], "model", None)
                print(f"  whisper {name} loaded on {kwargs.get('device')} ({kwargs.get('compute_type','default')})")
                break
            except Exception as e:
                last_exc = e
                continue
        else:
            try:
                _FW_MODELS[name] = WhisperModel(name, device="cpu", compute_type="int8")
                print(f"  whisper {name} loaded on cpu (int8) — GPU not available: {last_exc}")
            except Exception as e:
                raise RuntimeError(f"Could not load whisper model {name}: {e}") from e
    return _FW_MODELS[name]


def _has_encoder(name: str) -> bool:
    """True if ffmpeg lists *name* as an encoder (cached)."""
    key = f"enc:{name}"
    if key in _filter_cache:
        return _filter_cache[key]
    try:
        out = _run(["ffmpeg", "-hide_banner", "-encoders"], check=False)
        ok = f" {name} " in out or f"\n {name}" in out or f" {name}\n" in out
        # also substring fallback
        if not ok:
            ok = name in out
    except Exception:
        ok = False
    _filter_cache[key] = ok
    return ok


def _pick_video_encoder(prefer_gpu: bool = True) -> Tuple[str, List[str]]:
    """Choose best available h264 encoder: nvenc if GPU, else libx264.

    Returns (encoder_name, extra_global_args). Using nvenc gives ~5-10x
    speedup on T4 — but only when it can actually open: the check runs a
    real one-frame smoke encode (see compose.nvenc_available), because
    every static ffmpeg *lists* h264_nvenc while a GPU-less runtime dies
    with "Cannot load libcuda.so.1" the moment the encoder is opened.
    """
    if prefer_gpu and C.nvenc_available():
        return "h264_nvenc", []
    return "libx264", []


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
        # processed (not conformed) buses, shared between chunked-render parts
        self._bus_cache: Dict[str, Any] = {}
        # set by mix_audio(stems=True): {"mix","content","mic"} wav paths
        self.last_stems: Dict[str, str] = {}

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
                      "-crf", "23", str(self.cam_path),
                      "-map", "[content]", "-c:v", "libx264", "-preset", "fast",
                      "-crf", "23", str(self.content_path)], "input split")
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
                         crf: int = 23, fps: Optional[float] = None,
                         width: int = 1920, height: int = 1080,
                         cancel_check=None) -> str:
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
                             cancel_check=cancel_check,
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

    def _bus_signature(self, src: str, mic_channel=None,
                       content_channel=None) -> str:
        """Identity of the processed buses (so parts can share one pass).

        Only the knobs that actually reach the bus wavs are hashed; a part
        render reuses them, a changed gain/duck/channel does not.
        """
        cfg = self.audio_cfg
        keys = ("mic_channel", "mic_gain_db", "comp_on", "comp_threshold",
                "comp_ratio", "comp_makeup", "limiter_db", "duck_on",
                "duck_threshold", "duck_depth", "content_gain_db")
        raw = (src + "|" + "|".join(f"{k}={cfg.get(k)}" for k in keys)
               + f"|ov={mic_channel}/{content_channel}")
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]

    def _prepare_buses(self, src: str, compressor: bool, limiter: bool,
                       duck: bool, cancel_check=None,
                       reuse: bool = False, mic_channel=None,
                       content_channel=None) -> Tuple[Path, Path]:
        """mic + content bus wavs, processed but NOT conformed to segments."""
        sig = self._bus_signature(src, mic_channel, content_channel) \
            if reuse else ""
        cached = getattr(self, "_bus_cache", None)
        if reuse and cached and cached.get("sig") == sig:
            mic_proc, content_proc = cached["mic"], cached["content"]
            if mic_proc.exists() and content_proc.exists():
                return mic_proc, content_proc

        cfg = self.audio_cfg
        mic_wav = self.work / "mic.wav"
        content_wav = self.work / "content.wav"
        self._extract_bus(src, mic_wav, "mic", mic_channel)
        if cancel_check is not None and cancel_check():
            raise RenderCancelled("render cancelled by user")
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
            # sidechaincompress stops ~1 s before the end of a long bus (it
            # waits on the sidechain), which silently truncated the ducked
            # programme — pad back to the length of the longest bus.
            pad = max(self._media_duration(str(content_wav)),
                      self._media_duration(str(mic_proc)))
            tail = f",apad=whole_dur={pad:.3f}" if pad > 0 else ""
            self._ff(["ffmpeg", "-y", "-i", str(content_wav), "-i", str(mic_proc),
                      "-filter_complex",
                      f"[0:a][1:a]sidechaincompress="
                      f"threshold={cfg.get('duck_threshold', -32)}dB:ratio={ratio:.1f}:"
                      f"attack=0.06:release=0.42{tail}[aout]",
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
        if reuse:
            self._bus_cache = {"sig": sig, "mic": mic_proc,
                               "content": content_proc}
        return mic_proc, content_proc

    def mix_audio(self, input_path=None, mic_channel=None, content_channel=None,
                  output_path=None, compressor=True, limiter=True, duck=True,
                  segments: Optional[List[Dict[str, Any]]] = None,
                  fast_speed: float = 4.0, mute_solo: bool = True,
                  master_gain_db: float = 0.0,
                  cancel_check=None, stems: bool = False,
                  reuse_buses: bool = False, fade_s: float = 0.08) -> str:
        """Mix mic + content buses, conformed to the same segment map as video.

        *segments*: cut spans are dropped, fast spans get atempo, mute/card
        spans silence the CONTENT bus only (your mic stays). When None, the
        whole file is mixed (legacy behaviour). *mute_solo* also silences the
        content bus during intro/outro (browser parity: muteContentInSolo).

        *stems* additionally writes the content-only and mic-only buses next
        to the mix (see self.last_stems) so the mux can publish them as extra
        audio tracks. *reuse_buses* shares the bus extraction/processing
        between the parts of a chunked render.

        Works with both OBS audio layouts (2 tracks or 1 stereo track) and
        with ffmpeg 7+, where the old `-map_channel` option no longer exists.
        """
        if not _has("ffmpeg"):
            raise RuntimeError("ffmpeg not found (needed for mix_audio)")
        src = str(input_path or self.input)
        dst = Path(output_path) if output_path else self.out / "mixed_audio.wav"
        cfg = self.audio_cfg
        self.last_stems = {}

        mic_proc, content_proc = self._prepare_buses(
            src, compressor, limiter, duck, cancel_check=cancel_check,
            reuse=reuse_buses, mic_channel=mic_channel,
            content_channel=content_channel)

        mic_final = self._conform_bus(mic_proc, segments, fast_speed, mute_to_zero=False,
                                      tag="mic", cancel_check=cancel_check,
                                      fade_s=fade_s)
        content_final = self._conform_bus(content_proc, segments, fast_speed,
                                          mute_to_zero=True, tag="content",
                                          mute_solo=mute_solo,
                                          cancel_check=cancel_check,
                                          fade_s=fade_s)
        tail = (f"aformat=channel_layouts=stereo,"
                f"volume={float(master_gain_db):.1f}dB,"
                "alimiter=limit=-1.5dB:attack=5:release=50")
        self._ff(["ffmpeg", "-y", "-i", str(mic_final), "-i", str(content_final),
                  "-filter_complex",
                  "amix=inputs=2:duration=longest:dropout_transition=0.2[m];"
                  f"[m]{tail}[out]",
                  "-map", "[out]", "-c:a", "pcm_s16le", str(dst)], "final mix")
        if stems:
            # tracks 2 + 3 of the Patreon master: the same conformed buses,
            # gain/limited like the mix, so a later YouTube cut can silence
            # the content and keep the voice without re-rendering Patreon.
            for tag, wav in (("content", content_final), ("mic", mic_final)):
                out = dst.with_name(f"{dst.stem}_{tag}.wav")
                self._ff(["ffmpeg", "-y", "-i", str(wav), "-af",
                          f"aformat=channel_layouts=stereo,"
                          f"volume={float(master_gain_db):.1f}dB,"
                          "alimiter=limit=-1.5dB:attack=5:release=50",
                          "-c:a", "pcm_s16le", str(out)], f"{tag} stem")
                self.last_stems[tag] = str(out)
            self.last_stems["mix"] = str(dst)
        print(f"Mixed audio -> {dst}"
              + (f" (+{len(self.last_stems) - 1} stems)" if stems else ""))
        return str(dst)

    def _conform_bus(self, wav: Path, segments, fast_speed, mute_to_zero, tag,
                     mute_solo: bool = False, cancel_check=None,
                     fade_s: float = 0.08) -> Path:
        """Cut/drop/speed one audio bus identically to the video timeline.

        Small fades smooth every real join (cuts, card/mute edges, speed
        changes); source-continuous joins with identical state are left
        alone so speech never dips mid-word.
        """
        if not segments:
            return wav
        kept = [s for s in segments if s.get("type") != "cut"]
        if not kept:
            raise ValueError("all segments are cut — nothing to mix")
        mute_types = {"mute", "card"} | ({"intro", "outro"} if mute_solo else set())
        states = [((s.get("type") in mute_types and bool(mute_to_zero)),
                   C.seg_speed(s, float(fast_speed)))
                  for s in kept]
        # single untouched span -> no work (unless it mutes this bus)
        if (len(kept) == 1 and kept[0].get("type") not in ({"fast"} | mute_types)
                and C.seg_speed(kept[0], float(fast_speed)) <= 1.001):
            return wav
        n = len(kept)
        outs, chain = [], []
        chain.append(f"[0:a]asplit={n}" + "".join(f"[s{i}]" for i in range(n)))
        for i, s in enumerate(kept):
            if cancel_check is not None and cancel_check():
                raise RenderCancelled("render cancelled by user")
            f = [f"atrim=start={s['start']:.3f}:end={s['end']:.3f}",
                 "asetpts=PTS-STARTPTS"]
            spd = C.seg_speed(s, float(fast_speed))
            if spd > 1.001:
                # atempo only spans 0.5..2.0 — chain it (the default 4x speed
                # would otherwise fail the whole Patreon audio conform).
                # A card that carries its own speed is conformed the same way.
                f.extend(_atempo_chain(spd))
            if mute_to_zero and s.get("type") in mute_types:
                f.append("volume=0")
            dur = float(s["end"]) - float(s["start"])
            if spd > 1.001:
                dur = dur / max(0.125, spd)
            fi, fo = _fade_edges(kept, i, states)
            f.extend(_fade_filters(dur, fade_s, fi, fo))
            outs.append(f"[b{i}]")
            chain.append(f"[s{i}]{','.join(f)}[b{i}]")
        chain.append(f"{''.join(outs)}concat=n={n}:v=0:a=1[out]")
        out = self.work / f"{tag}_conform.wav"
        self._ff(["ffmpeg", "-y", "-i", str(wav), "-filter_complex", ";".join(chain),
                  "-map", "[out]", "-c:a", "pcm_s16le", str(out)],
                 f"{tag} timeline conform")
        return out

    # ------------------------------------------------------------ mux/export
    def mux(self, video_path, audio_path, out_mp4, webm=True,
            stems: Optional[Dict[str, str]] = None,
            video_dur: Optional[float] = None) -> Dict[str, str]:
        """Mux picture + mix into the deliverable.

        *stems* ({"content": wav, "mic": wav}) publishes the two buses as
        extra audio tracks behind the mix: track 1 is the full programme
        (what every player picks up), tracks 2/3 are the isolated content and
        mic so the Patreon -> YouTube step can silence one without a
        re-render. The mux stops on the *picture* duration — the old
        `-shortest` truncated the video by however much the ducked bus ended
        up short.
        """
        if not _has("ffmpeg"):
            print("ffmpeg missing — keeping silent video only.")
            return {"mp4": str(video_path)}
        out_mp4 = Path(out_mp4)
        _backup_existing(out_mp4)
        dur = float(video_dur) if video_dur else \
            self._media_duration(str(video_path))
        cmd = ["ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_path)]
        names = [("mix (content + mic)", "mix")]
        for tag in ("content", "mic"):
            p = (stems or {}).get(tag)
            if p and Path(p).exists():
                cmd += ["-i", str(p)]
                names.append((f"{tag} only", tag))
        cmd += ["-map", "0:v"]
        for i in range(len(names)):
            cmd += ["-map", f"{i + 1}:a"]
        cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]
        for i, (title, tag) in enumerate(names):
            cmd += [f"-metadata:s:a:{i}", f"title={title}"]
            cmd += [f"-disposition:a:{i}", "default" if i == 0 else "0"]
        if len(names) > 1:
            # mp4 only round-trips a fixed set of format-level keys, so the
            # machine-readable marker rides in `comment`
            cmd += ["-metadata", "comment=reaction_stems="
                    + ",".join(t for _, t in names),
                    "-metadata", "title=Reaction master "
                                 f"({len(names)} audio tracks)"]
        if dur > 0:
            cmd += ["-t", f"{dur:.3f}"]
        cmd += ["-movflags", "+faststart", str(out_mp4)]
        self._ff(cmd, "mux")
        result = {"mp4": str(out_mp4)}
        if len(names) > 1:
            result["stems"] = ",".join(t for _, t in names)
        if webm:
            wb = out_mp4.with_suffix(".webm")
            self._ff(["ffmpeg", "-y", "-i", str(out_mp4), "-c:v", "libvpx-vp9",
                      "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "5",
                      "-c:a", "libopus", "-b:a", "128k", str(wb)], "webm transcode")
            result["webm"] = str(wb)
        return result

    # ------------------------------------------- passthrough (YouTube) render
    # ------------------------------------------------- passthrough (YouTube)
    def _passthrough_streams(self, stems: Optional[bool] = None
                             ) -> Tuple[List[str], bool]:
        """Which audio streams of the source to read, and whether they are
        separate buses.

        A Patreon master rendered with stems carries three tracks: 1 = the
        mix, 2 = content only, 3 = mic only. Reading 2 + 3 lets a mute/card
        span silence the programme while your voice stays — the whole point
        of publishing the stems. Any other source is a single mixed track.
        """
        n = len(self._probe_audio(str(self.input)))
        use = n >= 3 if stems is None else bool(stems)
        if use and n >= 3:
            return ["0:a:1", "0:a:2"], True
        return ["0:a"], False

    def _fisheye_maps(self, amount: float, W: int, H: int) -> Tuple[Path, Path]:
        """The fisheye's 16-bit grayscale x/y map PNGs for `remap`, cached
        per (amount, size) — identical maps are one pair of files for the
        whole render (and for every part of a chunked render)."""
        key = (round(float(amount), 1), int(W), int(H))
        cache: Dict[Any, Tuple[Path, Path]] = \
            self.__dict__.setdefault("_fish_map_cache", {})
        hit = cache.get(key)
        if hit and hit[0].is_file() and hit[1].is_file():
            return hit
        import cv2
        xmap, ymap = _fisheye_coords(key[0], key[1], key[2])
        x = self.work / f"fish_x_{key[0]}_{key[1]}x{key[2]}.png"
        y = self.work / f"fish_y_{key[0]}_{key[1]}x{key[2]}.png"
        cv2.imwrite(str(x), xmap)
        cv2.imwrite(str(y), ymap)
        cache[key] = (x, y)
        return x, y

    def _plan_fisheye(self, cfg: Optional[Dict[str, Any]], W: int, H: int,
                      warns: List[str]) -> FisheyePlan:
        """Pick the fisheye backend this ffmpeg build actually has.

        The preview canvas always draws the fisheye, so a backend the build
        lacks must be worked around, not silently skipped (that is exactly
        the "shows in preview, missing from export" bug). Order: remap maps
        (exact preview math, fast, FFmpeg 3.1+) -> lenscorrection (7.0+) ->
        geq (works everywhere, much slower) -> give up with a warning.

        *W*/*H* are the dimensions the lens applies to (the content crop in
        contentOnly mode, the whole frame otherwise) — the remap maps are
        built at exactly that size.
        """
        c = cfg or {}
        if not (c.get("fisheye", False)
                and float(c.get("fisheyeAmount", 0.0)) > 0.5):
            return FisheyePlan("none")
        amt = float(c.get("fisheyeAmount", 35.0))
        if _ffmpeg_has_filter("remap"):
            try:
                x, y = self._fisheye_maps(amt, W, H)
                return FisheyePlan("remap", map_x=x, map_y=y,
                                   note="fisheye via remap maps "
                                        "(pixel-exact preview math)")
            except Exception as e:  # no cv2, disk full, ...
                warns.append(f"remap maps failed ({e}) — "
                             "trying another fisheye backend")
        if _ffmpeg_has_filter("lenscorrection"):
            return FisheyePlan("filter", _fisheye_vfilter(amt),
                               note="fisheye via lenscorrection")
        if _ffmpeg_has_filter("geq"):
            f = _fisheye_geq(amt, W, H)
            if f:
                warns.append("ffmpeg lacks remap and lenscorrection — the "
                             "geq fisheye fallback is much slower")
                return FisheyePlan("filter", f)
        warns.append("fisheye skipped in the export: this ffmpeg build has "
                     "no remap, lenscorrection or geq filter")
        return FisheyePlan("none")

    def _passthrough_graph(self, kept: List[Dict[str, Any]], *, W: int, H: int,
                           audio_cloak, video_cloak, card, fast_speed,
                           master_gain_db, content_rect, out_fps, height,
                           audio_inputs: List[str],
                           cam_rect: Optional[Dict[str, float]] = None,
                           audio_fade_s: float = 0.08,
                           sticker: Optional[Dict[str, Any]] = None,
                           bus_overrides: Optional[Dict[int, Path]] = None
                           ) -> Tuple[List[str], List[str], List[Path]]:
        """filter_complex for one (part of a) passthrough render.

        Both streams are conformed from the same segment list, so A/V can
        never desync. With two *audio_inputs* the first is the content bus
        (silenced on mute/card) and the second the mic (never silenced).

        INTRO / OUTRO STAY CLEAN: every disguise — video cloak, fisheye,
        mirror, cover bars, border, vignette, sticker, audio cloak, voice
        changer, even the global speed tweak — is applied ONLY to reaction
        spans (body/lead/mute/fast/card). Intro and outro segments pass
        through bit-neutral (trim only), both video and audio.

        *audio_inputs* may be empty: the graph is then video-only (the
        chunked path builds the audio separately and muxes it at the end).

        *bus_overrides* maps a bus index (0 = content, 1 = mic) to a
        pre-conformed wav on the OUTPUT timeline with the voice engine
        already applied to its reaction runs. An overridden bus is read from
        that file with a plain trim — no atempo, no fades, no mute, they are
        all baked in — which is how a re-voiced bus stays frame-accurate.

        *sticker* overlays a user image (subscribe button & co.) on the
        reaction spans: {on, src, x, y, w, opacity} — see _sticker_png.

        When video_cloak contentOnly=True (default), zoom/blur/eq/hue/grain/
        flipContent/rotate affect ONLY the content rect — camera stays clean
        (`flip` is a legacy alias of flipContent: no whole-frame mirror).
        That fixes \"reaction cuts video up/down, black lines, camera cropped\".

        Card spans cover the content rect 100% and then paste the camera
        corner back on top (cropped from the same trimmed base), so the card
        can never touch the camera whatever the two rects do — the ffmpeg
        twin of the browser preview's snapshot/restore.

        The fisheye is a reaction-part effect: it is spliced into
        body/lead/mute/fast/card spans and deliberately SKIPPED on
        intro/outro — in the finished file those are full-cam solo, so the
        lens would bulge the camera instead of the content (the preview
        does the same). The backend is picked per build by _plan_fisheye
        (remap maps -> lenscorrection -> geq), so the effect can never be
        silently missing from the export just because a filter is absent.

        Returns (chain, warnings, extra_inputs): the card, the vignette
        gradient and the fisheye maps arrive as single-frame PNG stills the
        caller must add to the command as plain inputs (`overlay` repeats
        their one frame for the whole base; `remap` keeps its last map
        frame too), because neither drawtext nor ffmpeg's own vignette
        filter reproduces what the browser preview draws.
        """
        n = len(kept)
        chain: List[str] = [
            f"[0:v]split={n}" + "".join(f"[vin{i}]" for i in range(n))
        ]
        vouts: List[str] = []
        warns: List[str] = []
        inputs: List[Path] = []

        def input_index(p: Path) -> int:
            if p not in inputs:
                inputs.append(p)
            return inputs.index(p) + 1      # input 0 is the source

        vc = video_cloak or {}
        # Resolve content rect in pixels FIRST — the fisheye's remap maps
        # must be exactly the crop size (contentOnly mode) or the frame
        # size (legacy full-frame mode).
        cr = content_rect or {}
        try:
            crx = float(cr.get("x", 0.294))
            cry = float(cr.get("y", 0.289))
            crw = float(cr.get("w", 0.7))
            crh = float(cr.get("h", 0.7))
        except Exception:
            crx, cry, crw, crh = 0.294, 0.289, 0.7, 0.7
        cx = int(round(W * crx))
        cy = int(round(H * cry))
        cw = int(round(W * crw))
        ch = int(round(H * crh))
        # clamp
        cx = max(0, min(W - 1, cx))
        cy = max(0, min(H - 1, cy))
        cw = max(1, min(W - cx, cw))
        ch = max(1, min(H - cy, ch))
        content_only_mode = bool(vc.get("contentOnly", True))
        # the fisheye backend for this render (one plan; spliced per
        # segment below, skipped on intro/outro)
        fe_plan = self._plan_fisheye(
            vc, cw if content_only_mode else W, ch if content_only_mode else H,
            warns)
        if fe_plan.note:
            warns.append(fe_plan.note)
        # Mirror (Cloak tab → Mirroring), resolved per segment BEFORE the
        # filters: it needs the crop + overlay path even when the frame
        # cloak itself is switched off. Intro/outro always resolve to "off".
        clean = _clean_flags(kept)
        # The browser draws the mirror with `scene.cloak ?? EMPTY_CLOAK`, and
        # EMPTY_CLOAK is contentOnly — so with the frame cloak switched off a
        # legacy `flip` mirrors the content rect, not the whole frame. Only a
        # live cloak (or a resolved fisheye) makes contentOnly meaningful.
        cloak_active = bool(vc.get("on", False)) or fe_plan.kind != "none"
        mirror_of = [resolve_mirror(vc, s, clean[i],
                                    content_only_mode if cloak_active else True)
                     for i, s in enumerate(kept)]
        any_frame_flip = any(m["frame_flip"] for m in mirror_of)
        pre, post = _video_cloak_split(vc, W, H)
        content_filters = _content_cloak_filters(vc, W, H, content_rect)
        is_content_only = content_only_mode and (
            bool(vc.get("on", False)) or fe_plan.kind != "none"
            or any(m["content_flip"] for m in mirror_of))
        # camera corner, restored on top of card spans (see docstring).
        # All rects below are in unflipped coordinates: the full-frame
        # mirror (flip) is applied once to the finished programme after
        # the concat, so it can never misplace the card, the content
        # cloak or the camera restore.
        kr = cam_rect or {}
        try:
            krx = float(kr.get("x", 0.006))
            kry = float(kr.get("y", 0.011))
            krw = float(kr.get("w", 0.30))
            krh = float(kr.get("h", 0.30))
        except Exception:
            krx, kry, krw, krh = 0.006, 0.011, 0.30, 0.30
        kcx = max(0, min(W - 1, int(round(W * krx))))
        kcy = max(0, min(H - 1, int(round(H * kry))))
        kcw = max(1, min(W - kcx, int(round(W * krw))))
        kch = max(1, min(H - kcy, int(round(H * krh))))
        cam_ok = kcw > 1 and kch > 1

        want_vig = bool((video_cloak or {}).get("on", False)) and \
            float((video_cloak or {}).get("vignette", 0.0)) > 0.5
        vig_png: Optional[Path] = None
        if want_vig:
            if _ffmpeg_has_filter("overlay"):
                vig_png = self._vignette_png(
                    float(video_cloak.get("vignette", 0.0)), W, H)
            else:
                warns.append("overlay filter missing — vignette skipped")
        # global speed tweak from video cloak (breaks fingerprint) — it is a
        # reaction-only effect: intro/outro always play untouched at 1.00
        global_speed = float((video_cloak or {}).get("speed", 1.0) or 1.0)
        global_speed = max(0.5, min(2.0, global_speed))

        def mirror_stage(label: str, i: int, mir: Dict[str, Any]) -> str:
            """hflip a content-sized frame; keep the bottom strip readable.

            The strip is `mirrorKeepBottom` of the content height, counted
            from the bottom: a short card already shows the bottom quarter of
            the programme, and that is exactly where burned-in subtitles sit
            — flipping it would flip the words. Everything else about the
            block (the camera in the corner, the card text drawn later) stays
            readable, which is the promise of a content-only mirror.
            """
            if mir.get("mode") != "content":
                # "legacy" (flip/flipContent) rides inside the content
                # filters, and "frame" flips the whole picture after the
                # concat — neither has a strip to keep
                return label
            flipped = f"vmfl{i}"
            kb = int(round(ch * float(mir.get("keep_bottom") or 0.0)))
            if kb <= 0:
                chain.append(f"[{label}]hflip[{flipped}]")
                return flipped
            # TWO consumers of the same crop (the flip and the strip that is
            # pasted back), so the crop has to be split first — an ffmpeg
            # filtergraph label can only be read once
            a, b, keep = f"vmspa{i}", f"vmspb{i}", f"vmkeep{i}"
            out_l = f"vmmix{i}"
            chain.append(f"[{label}]split=2[{a}][{b}]")
            chain.append(f"[{a}]hflip[{flipped}]")
            chain.append(f"[{b}]crop={cw}:{kb}:0:{ch - kb}[{keep}]")
            chain.append(f"[{flipped}][{keep}]"
                         f"overlay=x=0:y={ch - kb}:format=auto[{out_l}]")
            return out_l

        for i, s in enumerate(kept):
            typ = s.get("type", "body")
            a, b = float(s["start"]), float(s["end"])
            # reaction-part effects: intro/outro are full-cam solo in the
            # finished file and must come through EXACTLY as recorded —
            # no lens, no cloak, no mirror, no speed tweak
            fe = None if clean[i] else fe_plan
            # fast spans AND cards that carry their own speed; the cloak's
            # global speed tweak multiplies on top (reaction spans only)
            eff_speed = C.seg_speed(s, float(fast_speed)) * \
                (1.0 if clean[i] else global_speed)
            if abs(eff_speed - 1.0) > 0.001:
                base_vf = f"trim=start={a:.3f}:end={b:.3f}," \
                          f"setpts=(PTS-STARTPTS)/{eff_speed:.6f}"
            else:
                base_vf = f"trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS"
            if pre and not clean[i]:
                base_vf += "," + ",".join(pre)
            mir = mirror_of[i]
            if mir.get("legacy_whole") and not clean[i]:
                # pre-v7 `flip` on the legacy full-frame path: the picture
                # itself flips, then the card and the camera restore are
                # drawn on top — exactly what the browser canvas does
                base_vf += ",hflip"

            want_camfix = (typ == "card" and cam_ok
                           and _ffmpeg_has_filter("overlay"))
            # this block's mirror: mode, per-block tick and the keep-bottom
            # strip are already resolved (intro/outro came back "off")
            content_mirror = bool(mir["content_flip"])
            # the content-only pipeline is what can keep a mirrored block's
            # bottom strip readable — take it whenever the mirror needs it,
            # even with the frame cloak itself switched off
            use_content_pipe = (not clean[i]) and is_content_only and \
                (bool(content_filters) or fe is not None or content_mirror)
            # fallback for a contentOnly=False project: mirror the content
            # rect on its own, exactly the way flip/flipContent always did
            want_mirror = ((not use_content_pipe) and content_mirror
                           and _ffmpeg_has_filter("overlay"))

            if use_content_pipe:
                # Split trimmed frame into base and content crop
                tmp_label = f"vtmp{i}"
                chain.append(f"[vin{i}]{base_vf}[{tmp_label}]")
                # base stays full frame
                base_label = f"vbase{i}"
                content_src_label = f"vcsrc{i}"
                if want_camfix:
                    cam_src_label = f"vcamsrc{i}"
                    chain.append(f"[{tmp_label}]split=3[{base_label}][{content_src_label}][{cam_src_label}]")
                else:
                    chain.append(f"[{tmp_label}]split=2[{base_label}][{content_src_label}]")
                # content crop + filters (unflipped coordinates throughout)
                crop_vf = f"crop={cw}:{ch}:{cx}:{cy}"
                cf = list(content_filters)
                content_filt_label = f"vcf{i}"
                if fe is not None and fe.kind == "remap":
                    # the fisheye as a `remap` stage: the rest of the
                    # content cloak first, then the pixel-exact remap. The
                    # maps are the crop size, so the output is already
                    # cw x ch — no extra scale.
                    chain.append(f"[{content_src_label}]{crop_vf}"
                                 + ("," + ",".join(cf) if cf else "")
                                 + f"[vpre{i}]")
                    chain.append(f"[vpre{i}][{input_index(fe.map_x)}:v]"
                                 f"[{input_index(fe.map_y)}:v]"
                                 f"remap[{content_filt_label}]")
                else:
                    if fe is not None and fe.kind == "filter":
                        cf.append(fe.filter_str)
                    # ensure final size matches content rect
                    cf_vf = ",".join([crop_vf] + cf + [f"scale={cw}:{ch}:flags=lanczos"])
                    chain.append(f"[{content_src_label}]{cf_vf}[{content_filt_label}]")
                # mirror the content crop (keeps the bottom strip readable)
                content_filt_label = mirror_stage(content_filt_label, i, mir)
                # overlay filtered content back onto base
                ov_x = cx
                ov_y = cy
                cloaked_label = f"vp{i}"
                chain.append(f"[{base_label}][{content_filt_label}]overlay=x={ov_x}:y={ov_y}:format=auto[{cloaked_label}]")
                cur = cloaked_label
            else:
                cur = f"vp{i}"
                vf = base_vf
                if fe is not None and fe.kind == "filter":
                    vf += "," + fe.filter_str
                if fe is not None and fe.kind == "remap":
                    # legacy full-frame path: run trim/speed/cloak, then
                    # remap the whole frame (maps are frame-sized)
                    mid = f"vpre{i}"
                    chain.append(f"[vin{i}]{vf}[{mid}]")
                    chain.append(f"[{mid}][{input_index(fe.map_x)}:v]"
                                 f"[{input_index(fe.map_y)}:v]"
                                 f"remap[{cur}]")
                else:
                    chain.append(f"[vin{i}]{vf}[{cur}]")
                if want_mirror:
                    # mirror just the content rect, like the content-only path
                    mbase, msrc, mfl = f"vmbase{i}", f"vmsrc{i}", f"vmf{i}"
                    chain.append(f"[{cur}]split=2[{mbase}][{msrc}]")
                    chain.append(f"[{msrc}]crop={cw}:{ch}:{cx}:{cy},hflip,"
                                 f"scale={cw}:{ch}:flags=lanczos[{mfl}]")
                    mcur = f"vm{i}"
                    chain.append(f"[{mbase}][{mfl}]overlay=x={cx}:y={cy}:"
                                 f"format=auto[{mcur}]")
                    # keep-bottom strip: crop it off the UNFLIPPED base and
                    # paste it back over the flipped content (subtitles)
                    kb = int(round(ch * float(mir.get("keep_bottom") or 0.0)))
                    if kb > 0:
                        keep = f"vmkb{i}"
                        chain.append(f"[{cur}]crop={cw}:{kb}:{cx}:"
                                     f"{cy + ch - kb}[{keep}]")
                        kn = f"vmk{i}"
                        chain.append(f"[{mcur}][{keep}]overlay=x={cx}:"
                                     f"y={cy + ch - kb}:format=auto[{kn}]")
                        mcur = kn
                    cur = mcur
                if want_camfix:
                    # a second tap of the trimmed base feeds the camera restore
                    cam_src_label = f"vpcamsrc{i}"
                    card_branch = f"vpcard{i}"
                    chain.append(f"[{cur}]split=2[{card_branch}][{cam_src_label}]")
                    cur = card_branch

            if typ == "card":
                # a whole-picture mirror flips this overlay too, so the card
                # is drawn pre-flipped at its unflipped spot: after the hflip
                # it lands where the browser draws it, with upright words
                png = self._card_png({**(card or {}), **(s.get("card") or {})},
                                     W, H, content=content_rect,
                                     flip=bool(mir["frame_flip"]))
                if png is not None and _ffmpeg_has_filter("overlay"):
                    path, ox, oy = png
                    nxt = f"vo{i}"
                    chain.append(f"[{cur}][{input_index(path)}:v]"
                                 f"overlay=x={ox}:y={oy}:format=auto[{nxt}]")
                    cur = nxt
                    if want_camfix:
                        # paste the camera corner back on top of the card —
                        # full content cover, camera never touched
                        chain.append(f"[{cam_src_label}]crop={kcw}:{kch}:{kcx}:{kcy}[cam{i}]")
                        fixed = f"vfix{i}"
                        chain.append(f"[{cur}][cam{i}]overlay=x={kcx}:y={kcy}:format=auto[{fixed}]")
                        cur = fixed
                else:
                    warns.append("overlay filter missing — card skipped")
            chain.append(f"[{cur}]setsar=1[v{i}]")
            vouts.append(f"[v{i}]")
        chain.append(f"{''.join(vouts)}concat=n={n}:v=1:a=0[vcatraw]")
        # Whole-picture mirror (mode "frame"): the finished programme flips,
        # camera included. Done here, once, on the concatenated picture — the
        # card, the content cloak and the camera restore above are all placed
        # in unflipped coordinates, so an early flip could never move them
        # into a corner they were not authored for. The vignette, the bars /
        # frame and the sticker below are composited AFTER this, exactly the
        # order the browser canvas draws them in.
        if any_frame_flip:
            chain.append("[vcatraw]hflip[vcat]")
        else:
            chain.append("[vcatraw]null[vcat]")

        # Programme-time map of the finished file. The cloak's speed tweak
        # already lives in the per-segment eff speeds above, so the runs
        # here walk the SAME speeds — video and audio can't disagree.
        runs, out_off, _total_out = _passthrough_runs(
            kept, float(fast_speed), global_speed)

        def _terms(pred) -> str:
            return "+".join(
                f"gte(t,{out_off[i][0]:.3f})*lt(t,{out_off[i][1]:.3f})"
                for i, s in enumerate(kept) if pred(i, s))

        # reaction spans minus card spans: where vignette / bars / border go
        # (cards draw their own look, and intro/outro get NOTHING)
        react_nocard = _terms(
            lambda i, s: (not clean[i]) and s.get("type", "body") != "card")
        # every reaction span: where the sticker may sit
        react = _terms(lambda i, s: not clean[i])
        en_react_nocard = f":enable='{react_nocard}'" if react_nocard else ""
        en_react = f":enable='{react}'" if react else ""

        cur = "vcat"
        if vig_png is not None and en_react_nocard:
            nxt = "vvig"
            chain.append(f"[{cur}][{input_index(vig_png)}:v]"
                         f"overlay=x=0:y=0:format=auto{en_react_nocard}[{nxt}]")
            cur = nxt
        if post and en_react_nocard:
            nxt = "vpost"
            chain.append(f"[{cur}]"
                         + (",".join(f"{p}{en_react_nocard}" for p in post))
                         + f"[{nxt}]")
            cur = nxt
        # user sticker image (subscribe / like / …) — reaction spans only,
        # intro/outro stay clean like everything else
        st = sticker or {}
        if st.get("on", False) and en_react and _ffmpeg_has_filter("overlay"):
            sp = self._sticker_png(st, W, H)
            if sp is not None:
                spath, sx, sy, _sw, _sh = sp
                nxt = "vstick"
                chain.append(f"[{cur}][{input_index(spath)}:v]"
                             f"overlay=x={sx}:y={sy}:format=auto"
                             f"{en_react}[{nxt}]")
                cur = nxt
            elif str(st.get("src") or "").strip():
                warns.append(f"sticker image not found / unreadable: "
                             f"{st.get('src')!r} — skipped")

        # ---- audio: same segment map, cloaked ONLY in the reaction runs ---
        # Each bus is trimmed per segment (source time), grouped into clean /
        # reaction runs, the voice changer rides the mic bus alone inside
        # reaction runs, and the audio cloak touches reaction runs only —
        # intro/outro leave this graph exactly as they entered it.
        if audio_inputs:
            ovr = dict(bus_overrides or {})
            stems = len(audio_inputs) > 1
            mic_idx = 1 if stems else 0
            targets = _voice_targets(audio_cloak)
            # The in-graph presets are the "fx" engine: they may only touch a
            # bus that (a) the user asked for and (b) was not already
            # re-voiced offline. Both halves matter — morph/RVC run before the
            # graph over the whole programme, and a leftover rubberband pass
            # on the mic bus shifts YOUR voice too, which is exactly what
            # voiceTarget="content" promises not to do.
            vfx_bus = {j for j in ({mic_idx} if stems else {0}) if j not in ovr}
            vfx: List[str] = []
            if targets:
                if _voice_mode(audio_cloak) == "fx" and vfx_bus:
                    vfx, vwarns = _voice_changer_filters(audio_cloak)
                    warns.extend(vwarns)
                if not stems:
                    # one mixed track: the engine still runs (the caller
                    # re-voices that track), but content and commentary cannot
                    # be told apart any more
                    warns.append("voice changer without stems: this source has "
                                 "one mixed track, so it re-voices the "
                                 "programme AND your voice together — load a "
                                 "Patreon master with stems to keep your own "
                                 "voice natural")
            states_per_bus = [[
                ((s.get("type", "body") in ("mute", "card") and j == 0),
                 C.seg_speed(s, float(fast_speed))
                 * (1.0 if clean[i] else global_speed))
                for i, s in enumerate(kept)]
                for j in range(len(audio_inputs))]
            emitted: set = set()
            for r, run in enumerate(runs):
                bus_labels: List[str] = []
                for j, spec in enumerate(audio_inputs):
                    if j in ovr:
                        # a bus that was re-voiced offline: it already sits on
                        # the OUTPUT timeline with its fades, atempo and mute
                        # spans baked in, so all that is left is the trim
                        rl = f"jr{j}r{r}"
                        chain.append(
                            f"[{input_index(ovr[j])}:a]"
                            f"atrim=start={run['a']:.3f}:end={run['b']:.3f},"
                            f"asetpts=PTS-STARTPTS[{rl}]")
                        bus_labels.append(rl)
                        continue
                    outs: List[str] = []
                    for i in run["idxs"]:
                        if (j, i) in emitted:
                            outs.append(f"[j{j}b{i}]")
                            continue
                        emitted.add((j, i))
                        s = kept[i]
                        typ = s.get("type", "body")
                        a, b = float(s["start"]), float(s["end"])
                        eff = C.seg_speed(s, float(fast_speed)) * \
                            (1.0 if clean[i] else global_speed)
                        af = f"atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS"
                        if abs(eff - 1.0) > 0.001:
                            af += "," + ",".join(_atempo_chain(eff))
                        if typ in ("mute", "card") and j == 0:
                            af += ",volume=0"
                        fi, fo = _fade_edges(kept, i, states_per_bus[j])
                        fz = _fade_filters((b - a) / max(0.125, eff),
                                           audio_fade_s, fi, fo)
                        if fz:
                            af += "," + ",".join(fz)
                        chain.append(f"[{spec}]{af}[j{j}b{i}]")
                        outs.append(f"[j{j}b{i}]")
                    if len(outs) == 1:
                        bus_labels.append(outs[0][1:-1])
                    else:
                        rl = f"jr{j}r{r}"
                        chain.append(f"{''.join(outs)}"
                                     f"concat=n={len(outs)}:v=0:a=1[{rl}]")
                        bus_labels.append(rl)
                # the ffmpeg presets, in-graph: reaction runs only, and only
                # on a bus that was not already re-voiced offline
                if vfx and not run["clean"]:
                    for j in sorted(vfx_bus):
                        if j in ovr or j >= len(bus_labels):
                            continue
                        vl = f"jvr{r}b{j}"
                        chain.append(f"[{bus_labels[j]}]{','.join(vfx)}[{vl}]")
                        bus_labels[j] = vl
                if len(bus_labels) > 1:
                    ml = f"jmr{r}"
                    chain.append(
                        "".join(f"[{b_}]" for b_ in bus_labels)
                        + f"amix=inputs={len(bus_labels)}:duration=longest:"
                          f"dropout_transition=0.2[{ml}]")
                    mix_l = ml
                else:
                    mix_l = bus_labels[0]
                if run["clean"]:
                    # intro/outro: NOTHING — straight through
                    chain.append(f"[{mix_l}]anull[rr{r}]")
                else:
                    snip, cw_ = audio_cloak_chain(audio_cloak, mix_l,
                                                  f"rr{r}", tag=f"clk{r}x")
                    chain.append(snip)
                    warns.extend(cw_)
            nruns = len(runs)
            chain.append("".join(f"[rr{r}]" for r in range(nruns))
                         + f"concat=n={nruns}:v=0:a=1[aall]")
            chain.append(
                f"[aall]volume={float(master_gain_db):.1f}dB,"
                "alimiter=limit=-1.5dB:attack=5:release=50,"
                "aformat=channel_layouts=stereo[aout]"
            )

        vtail = f"[{cur}]"
        if out_fps and float(out_fps) > 0:
            chain.append(f"[{cur}]fps={float(out_fps):.6f}[vfps]")
            vtail = "[vfps]"
        if height and int(height) not in (0, H):
            chain.append(f"{vtail}scale=-2:{int(height)}[vout]")
        else:
            chain.append(f"{vtail}null[vout]")
        return chain, warns, inputs

    def _passthrough_cmd(self, chain: List[str], out: Path, crf: int,
                         preset: str,
                         inputs: Optional[List[Path]] = None,
                         with_audio: bool = True,
                         prefer_gpu: bool = True) -> List[str]:
        cmd = ["ffmpeg", "-y", "-v", "info", "-i", str(self.input)]
        # still-image inputs for the overlay PNGs (card / vignette) and, when
        # an RVC voice is active, the pre-conformed mic wav. One frame each
        # for the PNGs, on purpose: `overlay` repeats the last secondary
        # frame (repeatlast=1) for the rest of the base, while -loop 1 would
        # feed frames forever and the graph would never reach EOF.
        for p in (inputs or []):
            cmd += ["-i", str(p)]
        # GPU encoder only when it passes a real smoke encode (see
        # compose.nvenc_available) — a GPU-less runtime falls back to
        # libx264 instead of dying mid-render on "Cannot load libcuda.so.1"
        enc, _ = _pick_video_encoder(prefer_gpu=prefer_gpu)
        if enc == "h264_nvenc":
            vcodec = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr_hq",
                      "-cq", str(int(crf)), "-b:v", "0", "-maxrate", "8M", "-bufsize", "16M"]
        else:
            vcodec = ["-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)), "-maxrate", "8M", "-bufsize", "16M"]
        maps = ["-map", "[vout]"]
        audio_enc: List[str] = []
        if with_audio:
            maps += ["-map", "[aout]"]
            audio_enc = ["-c:a", "aac", "-b:a", "192k"]
        else:
            audio_enc = ["-an"]
        cmd += ["-filter_complex", ";".join(chain)] + maps + vcodec + [
                "-pix_fmt", "yuv420p"] + audio_enc + [
                "-movflags", "+faststart", str(out)]
        return cmd

    def _run_encode_cpu_fallback(self, build: Callable[[bool], List[str]],
                                 out: Path, total: float, what: str,
                                 progress_cb=None, cancel_check=None,
                                 stall_min: float = 30.0,
                                 heartbeat: Optional[Callable[[], None]] = None
                                 ) -> None:
        """Encode, retrying once on the CPU if the GPU pass dies.

        The encoder is smoke-tested before it is picked, but a paid runtime
        can still lose its GPU mid-session (driver hiccup, CUDA OOM, the
        session's GPU being reclaimed). Without this, that one failure costs
        the whole render — often at part 6/6, after an hour of work. Now the
        command is rebuilt with prefer_gpu=False and run again, which is the
        "no GPU? use the Colab CPU" behaviour the render should always have.
        """
        gpu_first = C.nvenc_available(verbose=False)
        try:
            _EncoderRun(build(gpu_first), total, what, progress_cb=progress_cb,
                        cancel_check=cancel_check, stall_min=stall_min,
                        out_path=out, heartbeat=heartbeat).run()
            return
        except Exception as e:  # noqa: BLE001 — the retry decides if it is fatal
            msg = str(e)
            if not gpu_first:
                raise   # the CPU encoder already failed: nothing left to try
            if not any(k in msg.lower() for k in
                       ("cuda", "nvenc", "nvidia", "gpu", "device", "driver",
                        "cannot load", "nvenc")):
                raise   # a genuine error (bad filter graph, cancel, stall…)
            print(f"  {what}: the GPU encoder failed "
                  f"({msg.splitlines()[0][:160]}) — re-running this pass on "
                  f"the CPU encoder (libx264)")
            if out.exists():
                out.unlink(missing_ok=True)
            C.force_cpu_encode(why=f"{what} hit a GPU error")
            _EncoderRun(build(False), total, what + " (cpu)",
                        progress_cb=progress_cb, cancel_check=cancel_check,
                        stall_min=stall_min, out_path=out,
                        heartbeat=heartbeat).run()

    def render_passthrough(
        self,
        segments: List[Dict[str, Any]],
        audio_cloak: Optional[Dict[str, Any]] = None,
        video_cloak: Optional[Dict[str, Any]] = None,
        card: Optional[Dict[str, Any]] = None,
        fast_speed: float = 4.0,
        master_gain_db: float = 0.0,
        crf: int = 23,
        preset: str = "fast",
        fps: Optional[float] = None,
        height: int = 0,
        name: str = "youtube_final",
        webm: bool = False,
        progress_cb=None,
        cancel_check=None,
        content_rect: Optional[Dict[str, float]] = None,
        cam_rect: Optional[Dict[str, float]] = None,
        stems: Optional[bool] = None,
        stall_min: float = 30.0,
        audio_fade_s: float = 0.08,
        sticker: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """YouTube cut as ONE ffmpeg pass: no compositing, full-frame source.

        cuts are dropped, fast spans sped (atempo + setpts), mute/card spans
        silence the programme (content bus only when the source carries
        stems), card spans cover the *content rect* — the same rect the
        Patreon compositor covered when it made this file — and then paste
        the *cam rect* back on top, so the camera corner stays visible
        whatever the two rects do. Every disguise (video + audio cloak,
        voice changer, sticker, speed tweak) applies to the REACTION spans
        only — intro and outro pass through untouched. A/V can never
        desync: both streams come from the same segment list in one command.
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
        total = prog_len(kept, fast_speed)
        src_fps = float(self.info.get("fps") or 0.0)
        out_fps = float(fps) if fps else src_fps
        audio_inputs, used_stems = self._passthrough_streams(stems)
        if used_stems:
            print("  passthrough: reading the content + mic stems (tracks 2/3)")
        # The voice engine runs BEFORE the graph: each targeted bus is
        # conformed to the output timeline, its reaction runs are re-voiced
        # (built-in morph or RVC), and the finished wav rides into the
        # one-pass graph in place of that bus — so the picture and the voice
        # come out of the same segment map and can never drift apart.
        bus_overrides: Dict[int, Path] = {}
        vtargets = _voice_targets(audio_cloak)
        if vtargets and _voice_mode(audio_cloak) in ("rvc", "morph"):
            if used_stems:
                gs = max(0.5, min(2.0, float(
                    (video_cloak or {}).get("speed", 1.0) or 1.0)))
                runs, _off, _tot = _passthrough_runs(kept, fast_speed, gs)
                for bus, idx in (("content", 0), ("mic", 1)):
                    if bus not in vtargets:
                        continue
                    wav = self._conform_passthrough_bus(
                        kept, fast_speed, gs, audio_fade_s, audio_inputs[idx],
                        mute_in_card=(bus == "content"))
                    bus_overrides[idx] = _voice_apply(
                        self, wav, runs, audio_cloak, bus,
                        tag=f"pt_{bus}")
            else:
                # one mixed track: the content bus IS the programme, so the
                # voice engine covers it (and your voice with it)
                gs = max(0.5, min(2.0, float(
                    (video_cloak or {}).get("speed", 1.0) or 1.0)))
                runs, _off, _tot = _passthrough_runs(kept, fast_speed, gs)
                wav = self._conform_passthrough_bus(
                    kept, fast_speed, gs, audio_fade_s, audio_inputs[0])
                bus_overrides[0] = _voice_apply(self, wav, runs, audio_cloak,
                                                "content", tag="pt_mix")
                print("  (voice: this source has one mixed track, so the "
                      "voice engine covers the programme AND your voice — "
                      "load a Patreon master with stems to split them)")
        chain, warns, extra = self._passthrough_graph(
            kept, W=W, H=H, audio_cloak=audio_cloak, video_cloak=video_cloak,
            card=card, fast_speed=fast_speed, master_gain_db=master_gain_db,
            content_rect=content_rect, out_fps=out_fps, height=height,
            audio_inputs=audio_inputs, cam_rect=cam_rect,
            audio_fade_s=audio_fade_s, sticker=sticker,
            bus_overrides=bus_overrides)
        for w in warns:
            print(f"  (cloak: {w})")

        out = self.out / f"{name}.mp4"
        _backup_existing(out)
        self._run_encode_cpu_fallback(
            lambda gpu: self._passthrough_cmd(chain, out, crf, preset, extra,
                                              prefer_gpu=gpu),
            out, total, "passthrough render", progress_cb=progress_cb,
            cancel_check=cancel_check, stall_min=stall_min)
        result = {"mp4": str(out)}
        if used_stems:
            result["stems"] = "content+mic"
        if webm:
            result["webm"] = self._to_webm(out)
        print(f"Passthrough {total:.1f}s -> {out}")
        return result

    def _card_png(self, card: Dict[str, Any], W: int, H: int,
                  content: Optional[Dict[str, float]] = None,
                  flip: bool = False
                  ) -> Optional[Tuple[Path, int, int]]:
        """The placeholder card as a PNG overlay: (path, x, y).

        drawtext needs a freetype-enabled ffmpeg *and* a system TTF, and
        static / pip-bundled builds ship neither — which is how card spans
        used to export as a black box with a lone accent line and no words.
        The compositor's own card (rounded gradient, accent bar, title/sub —
        the one the Patreon render and the browser preview draw) is rendered
        to a PNG here and composited with `overlay`, which every ffmpeg
        build has. Identical cards share one file.

        *flip* pre-mirrors the card horizontally: under a whole-picture
        mirror the finished frame is flipped, and this keeps the exported
        title/sub upright in the mirrored corner (what the browser draws).
        """
        r = content or {}
        try:
            lay = self.layout.content
            dflt = {"x": lay.x, "y": lay.y, "w": lay.w, "h": lay.h}
        except AttributeError:
            dflt = {"x": 0.294, "y": 0.289, "w": 0.70, "h": 0.70}
        rect = (round(float(r.get("x", dflt["x"])), 4),
                round(float(r.get("y", dflt["y"])), 4),
                round(float(r.get("w", dflt["w"])), 4),
                round(float(r.get("h", dflt["h"])), 4))
        g = card or {}
        # field-by-field fallback to this run's layout, exactly like the
        # browser (segment card ?? layout.card) — so a global opacity of 0
        # or a tuned shortHeight reaches the exported PNG too
        try:
            d = self.layout.card
        except AttributeError:
            d = L.CardStyle()
        title = str(g.get("title") or d.title)
        sub = str(g.get("sub") or d.sub)
        accent = str(g.get("accent") or d.accent)
        img_spec = str(g.get("image") or getattr(d, "image", "") or "")
        show_text = g.get("showText", getattr(d, "showText", True))
        show_text = False if show_text is False else True
        img_hash = (hashlib.sha1(img_spec.encode("utf-8", "ignore")).hexdigest()[:12]
                    if img_spec else "")
        variant = str(g.get("variant") or "full").strip().lower()
        variant = variant if variant == "short" else "full"
        # exact card geometry/alpha, straight from the merged card dict (the
        # caller merges the project's global card with the segment's own)
        raw_short = g.get("shortHeight", getattr(d, "shortHeight", 0.75))
        short_h = 0.75 if raw_short is None else float(raw_short)
        short_h = max(0.2, min(1.0, short_h))
        raw_opac = g.get("opacity", getattr(d, "opacity", 0.9))
        opac = 0.9 if raw_opac is None else float(raw_opac)
        opac = max(0.0, min(1.0, opac))   # 0 = a card the user switched off
        key = (title, sub, accent, img_hash, show_text, variant,
               round(short_h, 4), round(opac, 4), W, H, rect, bool(flip))
        cache: Dict[Any, Tuple[Path, int, int]] = \
            self.__dict__.setdefault("_card_png_cache", {})
        hit = cache.get(key)
        if hit and hit[0].is_file():
            return hit
        lay = L.LayoutState()
        lay.content = L.Rect(*rect)
        lay.card = L.CardStyle(title=title, sub=sub, accent=accent,
                               image=img_spec, showText=show_text,
                               shortHeight=short_h, opacity=opac)
        img, x0, y0 = C.card_overlay({"variant": variant}, lay, W, H)
        if img.size == 0:
            return None
        if flip:
            img = np.ascontiguousarray(img[:, ::-1])
        digest = hashlib.sha1(repr(key).encode()).hexdigest()[:10]
        path = self.work / f"card_{digest}_{W}x{H}.png"
        C.write_png(path, img)
        cache[key] = (path, x0, y0)
        return cache[key]

    def _vignette_png(self, amount: float, W: int, H: int) -> Optional[Path]:
        """The browser's radial vignette gradient as a full-frame PNG."""
        cache: Dict[Any, Path] = self.__dict__.setdefault("_vig_png_cache", {})
        key = (round(float(amount), 2), W, H)
        path = cache.get(key)
        if path and path.is_file():
            return path
        path = self.work / f"vignette_{key[0]:g}_{W}x{H}.png"
        C.write_png(path, C.vignette_overlay(W, H, amount))
        cache[key] = path
        return path

    def _sticker_png(self, sticker: Dict[str, Any], W: int, H: int
                     ) -> Optional[Tuple[Path, int, int, int, int]]:
        """The user's overlay image (subscribe / like / …) as a PNG + pos.

        Returns (path, x, y, w, h) in frame pixels, or None when there is
        nothing usable. *sticker* keys: src (data URL / http(s) / file path,
        a bare name resolves inside the output dir), x / y normalised
        top-left position, w width as a fraction of the frame width,
        opacity 0..1. Transparent PNGs keep their alpha; the opacity slider
        multiplies it.
        """
        import base64 as _b64
        src = str(sticker.get("src") or "").strip()
        if not src:
            return None
        try:
            x = max(0.0, min(1.0, float(sticker.get("x", 0.72))))
            y = max(0.0, min(1.0, float(sticker.get("y", 0.04))))
            w = max(0.02, min(1.0, float(sticker.get("w", 0.18))))
            opac = max(0.0, min(1.0, float(sticker.get("opacity", 1.0))))
        except (TypeError, ValueError):
            return None
        if opac <= 0.004:
            return None
        cache: Dict[Any, Tuple[Path, int, int, int, int]] = \
            self.__dict__.setdefault("_sticker_png_cache", {})
        src_hash = hashlib.sha1(src.encode("utf-8", "ignore")).hexdigest()[:12]
        key = (src_hash, round(x, 4), round(y, 4), round(w, 4),
               round(opac, 3), W, H)
        hit = cache.get(key)
        if hit and hit[0].is_file():
            return hit
        import cv2  # module scope has no cv2 — import it here, like fisheye
        img = None
        try:
            if src.startswith("data:"):
                b64 = src.split(",", 1)[1] if "," in src else ""
                raw = _b64.b64decode(b64)
                img = cv2.imdecode(np.frombuffer(raw, np.uint8),
                                   cv2.IMREAD_UNCHANGED)
            elif src.startswith(("http://", "https://")):
                import urllib.request
                with urllib.request.urlopen(src, timeout=30) as r:
                    raw = r.read(20_000_000)
                img = cv2.imdecode(np.frombuffer(raw, np.uint8),
                                   cv2.IMREAD_UNCHANGED)
            else:
                p = Path(src)
                if not p.is_absolute():
                    p = self.out / p.name    # bare name = uploaded asset
                if p.is_file() and p.stat().st_size < 30_000_000:
                    img = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        except Exception:
            img = None
        if img is None or getattr(img, "size", 0) == 0:
            return None
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
        elif img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        else:
            img = img.astype(np.uint8, copy=True)
        if opac < 0.999:
            img[:, :, 3] = (img[:, :, 3].astype(np.float32)
                            * opac).astype(np.uint8)
        dw = max(8, min(W, int(round(W * w))))
        sh, sw = img.shape[:2]
        dh = max(8, min(H, int(round(dw * sh / max(1, sw)))))
        if (dw, dh) != (sw, sh):
            img = cv2.resize(img, (dw, dh), interpolation=cv2.INTER_AREA)
        px = max(0, min(W - dw, int(round(x * W))))
        py = max(0, min(H - dh, int(round(y * H))))
        digest = hashlib.sha1(repr(key).encode()).hexdigest()[:10]
        path = self.work / f"sticker_{digest}_{W}x{H}.png"
        C.write_png(path, img)
        cache[key] = (path, px, py, dw, dh)
        return cache[key]

    # ------------------------------------------- chunked / resumable render
    def _fit_audio(self, wav: Path, dur: float, tag: str = "") -> Path:
        """Pad/trim an audio part to exactly *dur* seconds.

        Every part's audio is fitted to that part's measured picture length,
        which is what keeps joins from drifting frame by frame.
        """
        if dur <= 0:
            return wav
        got = self._media_duration(str(wav))
        if got > 0 and abs(got - dur) < 0.02:
            return wav
        out = wav.with_name(f"{wav.stem}_fit.wav")
        self._ff(["ffmpeg", "-y", "-i", str(wav), "-af",
                  f"apad=whole_dur={dur:.3f}", "-t", f"{dur:.3f}",
                  "-c:a", "pcm_s16le", str(out)], f"fit {tag or wav.name}")
        return out

    def _concat_video(self, parts: List[Path], out: Path, crf: int = 23,
                      preset: str = "fast", what: str = "concat") -> Path:
        """Join picture parts: stream-copy first, re-encode if that fails."""
        lst = out.with_name(out.stem + "_list.txt")
        lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts),
                       encoding="utf-8")
        try:
            self._ff(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                      "-i", str(lst), "-c", "copy", "-movflags", "+faststart",
                      str(out)], what)
            return out
        except RuntimeError as e:
            print(f"  ({what}: stream copy failed, re-encoding — {str(e)[:120]})")
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for p_ in parts:
            cmd += ["-i", str(p_)]
        n = len(parts)
        enc, _ = _pick_video_encoder(prefer_gpu=True)
        if enc == "h264_nvenc":
            vcodec = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr_hq",
                      "-cq", str(int(crf)), "-b:v", "0", "-maxrate", "8M", "-bufsize", "16M"]
        else:
            vcodec = ["-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)), "-maxrate", "8M", "-bufsize", "16M"]
        cmd += ["-filter_complex",
                "".join(f"[{i}:v]" for i in range(n))
                + f"concat=n={n}:v=1:a=0[v]",
                "-map", "[v]"] + vcodec + ["-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(out)]
        self._ff(cmd, what + " (re-encode)")
        return out

    def _concat_audio(self, parts: List[Path], out: Path,
                      what: str = "concat audio") -> Path:
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for p_ in parts:
            cmd += ["-i", str(p_)]
        n = len(parts)
        cmd += ["-filter_complex",
                "".join(f"[{i}:a]" for i in range(n))
                + f"concat=n={n}:v=0:a=1[out]",
                "-map", "[out]", "-c:a", "pcm_s16le", str(out)]
        self._ff(cmd, what)
        return out

    def _conform_passthrough_bus(self, kept: List[Dict[str, Any]],
                                 fast_speed: float, global_speed: float,
                                 fade_s: float, spec: str,
                                 mute_in_card: bool = False,
                                 tag: str = "pt_bus") -> Path:
        """Conform one audio bus to the OUTPUT timeline (single pass).

        Exact twin of the in-graph per-segment audio math (trim → atempo →
        edge fades → concat, cloak speed tweak on reaction spans only), so a
        voice engine can work in programme time and the result can ride back
        into the graph with output-time trims. *mute_in_card* silences the
        mute/card spans — the content bus does that in the graph, and an
        overridden bus never reaches that branch, so it has to happen here
        (it is also what lets the converter skip those runs entirely).
        """
        clean = _clean_flags(kept)
        gs = max(0.5, min(2.0, float(global_speed or 1.0)))
        # the fade logic has to see the same per-segment "is this bus muted"
        # flag the graph uses, or a mute span's edges fade in the wrong place
        states = [((mute_in_card and s.get("type", "body") in ("mute", "card")),
                   C.seg_speed(s, float(fast_speed))
                   * (1.0 if clean[i] else gs))
                  for i, s in enumerate(kept)]
        chain: List[str] = []
        outs: List[str] = []
        for i, s in enumerate(kept):
            a, b = float(s["start"]), float(s["end"])
            eff = C.seg_speed(s, float(fast_speed)) * \
                (1.0 if clean[i] else gs)
            af = f"atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS"
            if abs(eff - 1.0) > 0.001:
                af += "," + ",".join(_atempo_chain(eff))
            if mute_in_card and s.get("type", "body") in ("mute", "card"):
                af += ",volume=0"
            fi, fo = _fade_edges(kept, i, states)
            fz = _fade_filters((b - a) / max(0.125, eff), fade_s, fi, fo)
            if fz:
                af += "," + ",".join(fz)
            chain.append(f"[{spec}]{af}[m{i}]")
            outs.append(f"[m{i}]")
        n = len(kept)
        chain.append("".join(outs) + f"concat=n={n}:v=0:a=1[aout]")
        out = self.work / f"{tag}_conform.wav"
        self._ff(["ffmpeg", "-y", "-v", "error", "-i", str(self.input),
                  "-filter_complex", ";".join(chain),
                  "-map", "[aout]", "-c:a", "pcm_s16le", str(out)],
                 f"voice: conform {tag} bus")
        return out

    def _conform_passthrough_mic(self, kept: List[Dict[str, Any]],
                                 fast_speed: float, global_speed: float,
                                 fade_s: float, mic_spec: str) -> Path:
        """Back-compat wrapper: conform the mic bus (never silenced)."""
        return self._conform_passthrough_bus(kept, fast_speed, global_speed,
                                             fade_s, mic_spec,
                                             tag="pt_mic")

    def _voice_fx_wav(self, wav: Path, runs: List[Dict[str, Any]],
                      cfg: Dict[str, Any], tag: str = "vfx") -> Path:
        """Apply the ffmpeg voice-changer presets to the reaction runs of
        *wav* (clean runs pass through), one ffmpeg pass."""
        vfx, warns = _voice_changer_filters(cfg)
        for w in warns:
            print(f"  (voice: {w})")
        if not vfx:
            return wav
        chain: List[str] = [f"[0:a]asplit={len(runs)}"
                            + "".join(f"[vs{r}]" for r in range(len(runs)))]
        for r, run in enumerate(runs):
            seg_l = f"vseg{r}"
            chain.append(f"[vs{r}]atrim=start={run['a']:.3f}:"
                         f"end={run['b']:.3f},asetpts=PTS-STARTPTS[{seg_l}]")
            if run["clean"]:
                chain.append(f"[{seg_l}]anull[vv{r}]")
            else:
                chain.append(f"[{seg_l}]{','.join(vfx)}[vv{r}]")
        chain.append("".join(f"[vv{r}]" for r in range(len(runs)))
                     + f"concat=n={len(runs)}:v=0:a=1[vout]")
        out = self.work / f"{tag}_voice.wav"
        self._ff(["ffmpeg", "-y", "-v", "error", "-i", str(wav),
                  "-filter_complex", ";".join(chain),
                  "-map", "[vout]", "-c:a", "pcm_s16le", str(out)],
                 "voice: reaction runs")
        return out

    def _final_youtube_audio(self, kept: List[Dict[str, Any]],
                             fast_speed: float, global_speed: float,
                             audio_cloak: Optional[Dict[str, Any]],
                             master_gain_db: float,
                             content_wav: Optional[Path], mic_wav: Path,
                             out: Path) -> Path:
        """The finished YouTube mix, assembled once over the whole programme.

        The buses arrive already conformed to the output timeline (same
        math as the video parts). This stage then:
          1. voice engine — on whichever buses voiceTarget selects
             (content / mic / both), reaction runs only: morph = the built-in
             numpy voice, rvc = a character model, fx = the ffmpeg presets.
             Content ID fingerprints the programme audio, so "content" is the
             bus that matters; your own voice stays natural by default,
          2. mixes the buses,
          3. anti-fingerprint cloak — reaction runs only,
          4. master gain + limiter everywhere (safety, not a disguise).
        Intro/outro runs pass through stages 1-3 completely untouched.
        """
        runs, _off, total = _passthrough_runs(kept, fast_speed, global_speed)
        vmode = _voice_mode(audio_cloak)
        targets = _voice_targets(audio_cloak)
        mic_v = mic_wav
        con_v = content_wav
        if targets and vmode in ("rvc", "morph"):
            if "content" in targets:
                if con_v is not None:
                    con_v = _voice_apply(self, con_v, runs, audio_cloak,
                                         "content", tag="fin_content")
                else:
                    # no stems: the one mixed track is the programme
                    mic_v = _voice_apply(self, mic_wav, runs, audio_cloak,
                                         "content", tag="fin_mix")
                    print("  (voice: no stems — the voice engine covers the "
                          "mixed track, your voice included)")
            if "mic" in targets and con_v is not None:
                mic_v = _voice_apply(self, mic_wav, runs, audio_cloak,
                                     "mic", tag="fin_mic")
        elif targets and vmode == "fx":
            if "mic" in targets or con_v is None:
                mic_v = self._voice_fx_wav(mic_wav, runs, audio_cloak or {})
            if "content" in targets and con_v is not None:
                con_v = self._voice_fx_wav(con_v, runs, audio_cloak or {},
                                           tag="cfx")
            if con_v is None:
                print("  (voice: no stems — the voice changer covers the "
                      "mixed track, content audio included)")

        chain: List[str] = []
        inputs: List[Path] = []
        if con_v is not None:
            inputs.append(Path(con_v))
        inputs.append(Path(mic_v))
        nbus = len(inputs)
        warned_mix_cloak = False
        for r, run in enumerate(runs):
            bus_labels: List[str] = []
            for k in range(nbus):
                bl = f"kr{k}r{r}"
                chain.append(f"[{k}:a]atrim=start={run['a']:.3f}:"
                             f"end={run['b']:.3f},asetpts=PTS-STARTPTS[{bl}]")
                bus_labels.append(bl)
            if nbus > 1:
                ml = f"mr{r}"
                chain.append("".join(f"[{b_}]" for b_ in bus_labels)
                             + f"amix=inputs={nbus}:duration=longest:"
                               f"dropout_transition=0.2[{ml}]")
                mix_l = ml
            else:
                mix_l = bus_labels[0]
            if run["clean"]:
                chain.append(f"[{mix_l}]anull[rr{r}]")
            else:
                snip, warns = audio_cloak_chain(audio_cloak, mix_l,
                                                f"rr{r}", tag=f"f{r}c")
                chain.append(snip)
                for w in warns:
                    if not warned_mix_cloak:
                        print(f"  (cloak: {w})")
                        warned_mix_cloak = True
        chain.append("".join(f"[rr{r}]" for r in range(len(runs)))
                     + f"concat=n={len(runs)}:v=0:a=1[aall]")
        chain.append(f"[aall]volume={float(master_gain_db):.1f}dB,"
                     "alimiter=limit=-1.5dB:attack=5:release=50,"
                     "aformat=channel_layouts=stereo[aout]")
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for p in inputs:
            cmd += ["-i", str(p)]
        cmd += ["-filter_complex", ";".join(chain),
                "-map", "[aout]", "-c:a", "pcm_s16le", str(out)]
        self._ff(cmd, "youtube final audio")
        fitted = self._fit_audio(out, total, "final mix")
        if fitted != out:
            fitted.replace(out)
        return out

    def render_project(self, *, target: str, name: str,
                       segments: List[Dict[str, Any]],
                       layout: Optional[L.LayoutState] = None,
                       audio: Optional[Dict[str, Any]] = None,
                       retouch: Optional[Dict[str, Any]] = None,
                       audio_cloak: Optional[Dict[str, Any]] = None,
                       video_cloak: Optional[Dict[str, Any]] = None,
                       card: Optional[Dict[str, Any]] = None,
                       fast_speed: float = 4.0, master_gain_db: float = 0.0,
                       crf: int = 23, preset: str = "fast",
                       fps: Optional[float] = None, height: int = 0,
                       width: int = 1920, webm: bool = False,
                       stems: Optional[bool] = None,
                       part_target: float = 0.0, min_part: float = 20.0,
                       stall_min: float = 30.0, budget_min: float = 0.0,
                       progress_cb=None, cancel_check=None,
                       log: Optional[Callable[[str], None]] = None,
                       resume_body: Optional[Dict[str, Any]] = None,
                       audio_fade_s: float = 0.08,
                       sticker: Optional[Dict[str, Any]] = None
                       ) -> Dict[str, Any]:
        """Render a whole project, in parts, with a journal on disk.

        Short renders (< 5 min of programme) take exactly one pass — the old
        path, no overhead. Longer ones are split into parts of roughly
        *part_target* seconds; each finished part is written to
        `<out>/_parts/<name>/` and recorded in manifest.json, so a runtime
        that gets reclaimed mid-render costs one part instead of everything.
        Re-running with the same project reuses every part that is still on
        disk and probes to its planned length.

        *progress_cb(frac, info)* — info carries step/part/parts/eta_s/
        elapsed_s/age_s/bytes so the UI can be honest about what is happening.
        """
        say = log or (lambda m: None)
        target = "youtube" if str(target).lower().startswith("you") else "patreon"
        kept = sorted([s for s in (segments or []) if s.get("type") != "cut"],
                      key=lambda s: float(s["start"]))
        if not kept:
            raise ValueError("empty timeline — nothing to render")
        fast = float(fast_speed or 4.0)
        total_prog = prog_len(kept, fast)
        if not part_target or float(part_target) <= 0:
            part_target = auto_part_target(total_prog)
        part_target = float(part_target)
        parts = plan_parts(kept, fast, part_target, min_part) \
            if part_target < total_prog - 1e-6 else [kept]

        started = time.time()
        state = {"step": "starting", "part": 0, "parts": len(parts),
                 "eta_s": 0.0, "elapsed_s": 0.0, "age_s": 0.0, "bytes": 0,
                 "reused": []}

        def report(frac: float, **kw) -> None:
            # never walk backwards: the UI reads a falling bar as a stall
            frac = max(frac, state.get("_max", 0.0))
            state["_max"] = frac
            state.update(kw)
            state["elapsed_s"] = time.time() - started
            state["age_s"] = time.time() - state.get("_beat", started)
            if progress_cb:
                progress_cb(max(0.0, min(1.0, frac)), dict(state))

        state["_beat"] = started
        report(0.0)

        def beat() -> None:
            state["_beat"] = time.time()

        def out_bytes() -> int:
            try:
                return sum(f.stat().st_size for f in self.out.rglob("*")
                           if f.is_file())
            except OSError:
                return 0

        # ---- single pass: short renders keep the old, simple path ----------
        if len(parts) <= 1:
            say(f"one pass ({total_prog:.0f}s of programme — under the 5 min "
                "chunk threshold)")
            # same default as the chunked path: a Patreon master carries the
            # content/mic tracks whether or not it needed chunking
            single_stems = (False if target == "youtube"
                            else (True if stems is None else bool(stems)))
            report(0.02, step="rendering")
            if target == "youtube":
                rect = None
                camrect = None
                if layout is not None:
                    rect = {"x": layout.content.x, "y": layout.content.y,
                            "w": layout.content.w, "h": layout.content.h}
                    camrect = {"x": layout.cam.x, "y": layout.cam.y,
                               "w": layout.cam.w, "h": layout.cam.h}
                outs = self.render_passthrough(
                    kept, audio_cloak=audio_cloak, video_cloak=video_cloak,
                    card=card, fast_speed=fast, master_gain_db=master_gain_db,
                    crf=crf, preset=preset, fps=fps, height=height, name=name,
                    webm=webm, content_rect=rect, cam_rect=camrect, stems=stems,
                    audio_fade_s=audio_fade_s, sticker=sticker,
                    stall_min=stall_min, cancel_check=cancel_check,
                    progress_cb=lambda d, t: (beat(), report(
                        0.05 + 0.9 * d / max(1e-6, t),
                        step="encoding", part=1, parts=1))[0])
            else:
                lay = layout or self.layout
                # only the compositor consumes the layout as engine state; a
                # passthrough just borrows its content rect for the card
                if layout is not None and target == "patreon":
                    self.layout = lay
                if audio is not None:
                    self.audio_cfg.update(audio)
                if isinstance(retouch, dict):
                    self.retouch_cfg.update(retouch)
                video_nc = self.work / f"{name}_video.mp4"
                hook = (self._cam_hook()
                        if self.retouch_cfg.get("enabled") else None)
                C.render_video(str(self.input), str(video_nc), layout=lay,
                               segments=kept, crf=crf,
                               progress_cb=lambda d, t: (beat(), report(
                                   0.05 + 0.8 * d / max(1, t),
                                   step="compositing", part=1, parts=1))[0],
                               cancel_check=cancel_check, cam_hook=hook,
                               fps=fps, width=int(width),
                               height=int(height) or 1080)
                report(0.86, step="mixing audio")
                beat()
                mix = self.mix_audio(
                    output_path=str(self.work / f"{name}_mix.wav"),
                    segments=kept, fast_speed=fast,
                    mute_solo=bool(lay.muteContentInSolo),
                    master_gain_db=master_gain_db,
                    cancel_check=cancel_check, stems=single_stems,
                    fade_s=audio_fade_s)
                st = dict(self.last_stems) if single_stems else None
                report(0.95, step="muxing")
                beat()
                dur = self._media_duration(str(video_nc))
                outs = self.mux(video_nc, mix, self.out / f"{name}.mp4",
                                webm=webm, stems=st, video_dur=dur)
            report(1.0, step="done", part=1, parts=1, bytes=out_bytes())
            return {"mp4": outs["mp4"], **({"webm": outs["webm"]}
                                           if outs.get("webm") else {}),
                    "parts": 1, "resumed": [], "chunked": False}

        # ---- chunked: journal, reuse what is already on disk ---------------
        key = re.sub(r"[^A-Za-z0-9_.-]+", "_", name) or "render"
        pdir = parts_dir(self.out, key)
        pdir.mkdir(parents=True, exist_ok=True)
        plan_json = json.dumps(
            [[round(float(s["start"]), 3), round(float(s["end"]), 3),
              str(s.get("type", "body"))] for p_ in parts for s in p_])
        # Two different things: Patreon *writes* the content/mic stems as
        # extra tracks (it builds both buses anyway); YouTube only *reads*
        # them off a Patreon master (see _passthrough_streams) and publishes
        # a single rebuilt mix, because YouTube keeps the first track only.
        write_stems = (False if target == "youtube"
                       else (True if stems is None else bool(stems)))
        want_stems = write_stems
        # engine state first: the journal signature below hashes what the
        # parts will look/sound like, so it must see the final config
        if audio is not None:
            self.audio_cfg.update(audio)
        if isinstance(retouch, dict):
            self.retouch_cfg.update(retouch)
        lay = layout or self.layout
        if layout is not None and target == "patreon":
            self.layout = lay
        rect = {"x": lay.content.x, "y": lay.content.y,
                "w": lay.content.w, "h": lay.content.h}
        camrect = {"x": lay.cam.x, "y": lay.cam.y,
                   "w": lay.cam.w, "h": lay.cam.h}
        hook = (self._cam_hook() if target == "patreon"
                and self.retouch_cfg.get("enabled") else None)
        pt_streams, pt_used = self._passthrough_streams(stems)
        if target == "youtube" and pt_used:
            say("reading the content + mic stems (tracks 2/3) — mute and "
                "card spans silence the programme, your voice stays")
        # What the parts look like is part of a part's identity: reusing a
        # part rendered with a different cloak/card/layout would ship the
        # old look under the new settings (and hid exactly this regression
        # once — a fixed render resumed straight into the broken parts).
        if target == "youtube":
            look_src: List[Any] = [video_cloak, card, rect, master_gain_db,
                                   sticker]
        else:
            look_src = [lay.to_dict() if lay is not None else None,
                        dict(self.audio_cfg), dict(self.retouch_cfg),
                        master_gain_db]
        look = hashlib.sha1(json.dumps(
            look_src, sort_keys=True, default=str).encode()).hexdigest()[:12]
        # av3: youtube parts now journal the raw content/mic buses (video
        # stays effect-free audio-wise; the cloak/voice join runs once at
        # the end) — old journals with one mixed wav per part must rebuild
        sig = hashlib.sha1(
            (str(self.input) + target + plan_json + f"{fast}|{crf}|{fps}|"
             f"{height}|{width}|stems={want_stems}|av3|look={look}").encode()
        ).hexdigest()[:16]
        man = read_manifest(self.out, key)
        done: Dict[int, Dict[str, Any]] = {}
        if man and man.get("sig") == sig and man.get("parts") == len(parts):
            for rec in man.get("done", []):
                i = int(rec.get("i", -1))
                if not (0 <= i < len(parts)):
                    continue
                if not rec.get("v"):
                    continue
                if target == "youtube":
                    # av3 layout: video-only parts + the raw buses (content /
                    # mic when the source has stems, else one mixed wav);
                    # cloak + voice run once at the join
                    if pt_used:
                        if not rec.get("ac") or not rec.get("am"):
                            continue   # journalled before av3 — rebuild
                        need = [pdir / str(rec["v"]), pdir / str(rec["ac"]),
                                pdir / str(rec["am"])]
                    else:
                        if not rec.get("a"):
                            continue
                        need = [pdir / str(rec["v"]), pdir / str(rec["a"])]
                else:
                    if not rec.get("a"):
                        continue
                    need = [pdir / str(rec["v"]), pdir / str(rec["a"])]
                    if want_stems:
                        if not rec.get("ac") or not rec.get("am"):
                            continue   # journalled without stems — rebuild
                        need += [pdir / str(rec["ac"]), pdir / str(rec["am"])]
                if not all(f.is_file() for f in need):
                    continue
                # a part that was reclaimed mid-encode is shorter than its
                # plan says — rebuild it rather than splicing it in
                size = need[0].stat().st_size
                got = self._media_duration(str(need[0]))
                if int(rec.get("bytes", -1)) != size:
                    say(f"  part {i + 1} is {size} bytes, journal says "
                        f"{rec.get('bytes')} — rebuilding")
                    continue
                if got <= 0 or abs(got - float(rec.get("dur", 0))) > PART_TOL_S:
                    say(f"  part {i + 1} is {got:.1f}s, plan says "
                        f"{float(rec.get('dur', 0)):.1f}s — rebuilding")
                    continue
                done[i] = rec
        else:
            for f in pdir.iterdir():
                if f.is_file():
                    f.unlink(missing_ok=True)
        man = {"key": key, "sig": sig, "target": target, "parts": len(parts),
               "part_target": part_target, "total_prog": total_prog,
               "created": (man or {}).get("created", time.time()),
               "input": str(self.input), "plan": plan_json,
               "stems": want_stems, "done": [done[i] for i in sorted(done)],
               # the exact project that produced these parts, so Resume can
               # re-post it verbatim (the caller's own shape wins)
               "body": dict(resume_body) if resume_body else
               {"target": target, "name": name, "segments": segments,
                "fast": fast, "crf": crf, "fps": fps, "height": height,
                "width": width,
                "layout": layout.to_dict() if layout is not None else None,
                "audio": audio}}
        write_manifest(self.out, key, man)

        reused = sorted(done)
        if reused:
            say(f"{len(reused)}/{len(parts)} parts already on disk — kept "
                f"({', '.join(str(i + 1) for i in reused[:8])}"
                f"{' …' if len(reused) > 8 else ''})")
            state["reused"] = [i + 1 for i in reused]
        else:
            say(f"{len(parts)} parts of ~{part_target:.0f}s "
                f"({total_prog:.0f}s of programme)")

        done_prog = [prog_len(parts[i], fast) for i in sorted(done)]
        prog_before = [0.0] * len(parts)
        acc = 0.0
        for i in range(len(parts)):
            prog_before[i] = acc
            acc += prog_len(parts[i], fast)

        for i, part in enumerate(parts):
            if cancel_check is not None and cancel_check():
                raise RenderCancelled("render cancelled by user")
            if budget_min and time.time() - started > budget_min * 60.0:
                write_manifest(self.out, key, man)
                raise RenderPaused(
                    f"time budget reached after {len(done)}/{len(parts)} "
                    "parts — the rest is resumable")
            pn = prog_len(part, fast)
            if i in done:
                report((prog_before[i] + pn) / total_prog,
                       step="cached", part=i + 1, parts=len(parts),
                       bytes=out_bytes())
                continue
            say(f"part {i + 1}/{len(parts)}: {part[0]['start']:.1f}"
                f"→{part[-1]['end']:.1f}s ({pn:.0f}s of programme)")
            vp = pdir / f"part_{i:03d}.mp4"
            report(prog_before[i] / total_prog, step="encoding",
                   part=i + 1, parts=len(parts), bytes=out_bytes())

            def cb(d, t, i=i):
                beat()
                # picture tops out at 95% of the part; audio gets the rest
                frac = (prog_before[i] + pn * min(0.95, d / max(1, t))) \
                    / total_prog
                report(frac, step="encoding", part=i + 1, parts=len(parts))

            if target == "youtube":
                # video-only parts: the disguise audio (cloak + voice) runs
                # once at the join over the whole programme, so its reverb
                # tails are never chopped at a part boundary and the intro/
                # outro cleanness is decided in exactly one place. Skipping
                # the audio encode here also makes the parts finish faster.
                chain, warns, extra = self._passthrough_graph(
                    part, W=int(self.info.get("width") or 1920),
                    H=int(self.info.get("height") or 1080),
                    audio_cloak=audio_cloak, video_cloak=video_cloak,
                    card=card, fast_speed=fast, master_gain_db=master_gain_db,
                    content_rect=rect, out_fps=(float(fps) if fps else
                                                float(self.info.get("fps") or 0)),
                    height=height, audio_inputs=[], cam_rect=camrect,
                    audio_fade_s=audio_fade_s, sticker=sticker)
                for w in warns:
                    say(f"  (cloak: {w})")
                self._run_encode_cpu_fallback(
                    lambda gpu, _chain=chain, _vp=vp: self._passthrough_cmd(
                        _chain, _vp, crf, preset, extra, with_audio=False,
                        prefer_gpu=gpu),
                    vp, pn, f"part {i + 1}/{len(parts)}", progress_cb=cb,
                    cancel_check=cancel_check, stall_min=stall_min,
                    heartbeat=beat)
                report((prog_before[i] + pn * 0.97) / total_prog,
                       step="audio", part=i + 1, parts=len(parts))
                beat()
                # raw conformed buses, journalled per part: with stems the
                # content and mic wavs stay separate so the join can run the
                # voice changer on the mic alone
                gspeed = max(0.5, min(2.0, float(
                    (video_cloak or {}).get("speed", 1.0) or 1.0)))
                achain, alabels = self._part_audio_chain(
                    part, fast, fade_s=audio_fade_s, global_speed=gspeed)
                label_field = {"cout": "ac", "mout": "am", "aout": "a"}
                label_file = {"cout": "c", "mout": "m", "aout": "a"}
                acmd = ["ffmpeg", "-y", "-v", "error", "-i", str(self.input),
                        "-filter_complex", achain]
                rec: Dict[str, Any] = {"i": i, "v": vp.name}
                for label in alabels:
                    wavname = f"part_{i:03d}_{label_file[label]}.wav"
                    acmd += ["-map", f"[{label}]", "-c:a", "pcm_s16le",
                             str(pdir / wavname)]
                    rec[label_field[label]] = wavname
                self._ff(acmd, f"part {i + 1} audio")
            else:
                C.render_video(str(self.input), str(vp), layout=lay,
                               segments=part, crf=crf, progress_cb=cb,
                               cancel_check=cancel_check, cam_hook=hook,
                               fps=fps, width=int(width),
                               height=int(height) or 1080)
                report((prog_before[i] + pn * 0.9) / total_prog,
                       step="audio", part=i + 1, parts=len(parts))
                beat()
                mix = self.mix_audio(
                    output_path=str(pdir / f"part_{i:03d}.wav"),
                    segments=part, fast_speed=fast,
                    mute_solo=bool(lay.muteContentInSolo),
                    master_gain_db=master_gain_db, cancel_check=cancel_check,
                    stems=want_stems, reuse_buses=True,
                    fade_s=audio_fade_s)
                rec = {"i": i, "v": vp.name, "a": Path(mix).name}
                if want_stems:
                    rec["ac"] = Path(self.last_stems["content"]).name
                    rec["am"] = Path(self.last_stems["mic"]).name

            # fit this part's audio to its own measured picture length, so
            # joins never accumulate drift
            vdur = self._media_duration(str(vp))
            rec["dur"] = round(vdur or pn, 3)
            for tag in ("a", "ac", "am"):
                if rec.get(tag):
                    fitted = self._fit_audio(pdir / rec[tag], rec["dur"], tag)
                    if fitted.name != rec[tag]:
                        fitted.replace(pdir / rec[tag])
            rec["bytes"] = vp.stat().st_size if vp.exists() else 0
            done[i] = rec
            man["done"] = [done[k] for k in sorted(done)]
            write_manifest(self.out, key, man)
            say(f"part {i + 1}/{len(parts)} saved "
                f"({rec['dur']:.1f}s, {rec['bytes'] / 1e6:.0f} MB)")
            report((prog_before[i] + pn) / total_prog, step="saved",
                   part=i + 1, parts=len(parts), bytes=out_bytes())

        # ---- join + mux ----------------------------------------------------
        say(f"joining {len(parts)} parts …")
        report(0.97, step="joining", part=len(parts), parts=len(parts))
        beat()
        vparts = [pdir / done[i]["v"] for i in range(len(parts))]
        video_all = self.out / f"{name}.video.mp4"
        self._concat_video(vparts, video_all, crf=crf, preset=preset,
                           what=f"join {name} video")
        if target == "youtube":
            # parts carry the raw conformed buses; voice changer + cloak +
            # master happen once here over the whole programme — reaction
            # runs only, intro/outro pass through untouched
            gspeed = max(0.5, min(2.0, float(
                (video_cloak or {}).get("speed", 1.0) or 1.0)))
            if pt_used:
                say("joining the buses: voice changer on the mic, cloak on "
                    "the reaction part …")
                content_all = self._concat_audio(
                    [pdir / done[i]["ac"] for i in range(len(parts))],
                    self.work / f"{name}_content.wav", "join content bus")
                mic_all = self._concat_audio(
                    [pdir / done[i]["am"] for i in range(len(parts))],
                    self.work / f"{name}_mic.wav", "join mic bus")
                mix_all = self._final_youtube_audio(
                    kept, fast, gspeed, audio_cloak, master_gain_db,
                    content_all, mic_all,
                    self.work / f"{name}_mix_final.wav")
            else:
                mix_raw = self._concat_audio(
                    [pdir / done[i]["a"] for i in range(len(parts))],
                    self.work / f"{name}_mix.wav")
                mix_all = self._final_youtube_audio(
                    kept, fast, gspeed, audio_cloak, master_gain_db,
                    None, mix_raw, self.work / f"{name}_mix_final.wav")
        else:
            mix_all = self._concat_audio([pdir / done[i]["a"]
                                          for i in range(len(parts))],
                                         self.work / f"{name}_mix.wav")
        st = None
        if want_stems:
            st = {}
            for tag, field in (("content", "ac"), ("mic", "am")):
                st[tag] = str(self._concat_audio(
                    [pdir / done[i][field] for i in range(len(parts))],
                    self.work / f"{name}_{tag}.wav", f"join {tag}"))
        report(0.99, step="muxing")
        beat()
        vdur = self._media_duration(str(video_all))
        outs = self.mux(video_all, mix_all, self.out / f"{name}.mp4",
                        webm=webm, stems=st, video_dur=vdur)
        video_all.unlink(missing_ok=True)
        man["done"] = [done[k] for k in sorted(done)]
        man["finished"] = time.time()
        man["output"] = outs["mp4"]
        write_manifest(self.out, key, man)
        size = Path(outs["mp4"]).stat().st_size
        say(f"done: {outs['mp4']} ({size / 1e6:.0f} MB) — parts kept in "
            f"{pdir.relative_to(self.out)} in case you want to re-join")
        report(1.0, step="done", part=len(parts), parts=len(parts),
               bytes=size)
        return {"mp4": outs["mp4"],
                **({"webm": outs["webm"]} if outs.get("webm") else {}),
                **({"stems": outs["stems"]} if outs.get("stems") else {}),
                "parts": len(parts), "resumed": [i + 1 for i in reused],
                "chunked": True}

    def _part_audio_chain(self, part: List[Dict[str, Any]],
                          fast_speed: float, fade_s: float = 0.08,
                          global_speed: float = 1.0
                          ) -> Tuple[str, List[str]]:
        """Audio for one passthrough part (YouTube path).

        Same conform math as the single-pass graph: stems are read
        separately when the source has them, mute/card silences the content
        bus only, the cloak's global speed tweak rides reaction spans only
        (intro/outro stay untouched). Returns (chain, out_labels): with
        stems the buses leave UNMIXED ([cout], [mout]) so the join stage
        can run the voice changer on the mic alone; otherwise one [aout].
        """
        inputs, used = self._passthrough_streams(None)
        n = len(part)
        gs = max(0.5, min(2.0, float(global_speed or 1.0)))
        clean = _clean_flags(part)
        chain: List[str] = []
        cats: List[str] = []
        for j, spec in enumerate(inputs):
            outs = []
            chain.append(f"[{spec}]asplit={n}"
                         + "".join(f"[j{j}s{i}]" for i in range(n)))
            states = [((s.get("type", "body") in ("mute", "card") and j == 0),
                       C.seg_speed(s, float(fast_speed))
                       * (1.0 if clean[i] else gs))
                      for i, s in enumerate(part)]
            for i, s in enumerate(part):
                typ = s.get("type", "body")
                a, b = float(s["start"]), float(s["end"])
                af = f"atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS"
                eff = C.seg_speed(s, float(fast_speed)) * \
                    (1.0 if clean[i] else gs)
                if eff > 1.001:
                    af += "," + ",".join(_atempo_chain(eff))
                if typ in ("mute", "card") and j == 0:
                    af += ",volume=0"
                fi, fo = _fade_edges(part, i, states)
                fz = _fade_filters((b - a) / max(0.125, eff), fade_s, fi, fo)
                if fz:
                    af += "," + ",".join(fz)
                chain.append(f"[j{j}s{i}]{af}[j{j}b{i}]")
                outs.append(f"[j{j}b{i}]")
            chain.append(f"{''.join(outs)}concat=n={n}:v=0:a=1[cat{j}]")
            cats.append(f"[cat{j}]")
        if len(cats) > 1:
            chain.append(f"[{cats[0][1:-1]}]aformat=channel_layouts=stereo[cout]")
            chain.append(f"[{cats[1][1:-1]}]aformat=channel_layouts=stereo[mout]")
            return ";".join(chain), ["cout", "mout"]
        chain.append(f"[{cats[0][1:-1]}]aformat=channel_layouts=stereo[aout]")
        return ";".join(chain), ["aout"]

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

    # ------------------------------------------------- transcript → card+cut
    @staticmethod
    def speech_regions_from_words(words, pad=0.25, merge_gap=0.8):
        """Word list -> merged speech regions (pad + merge)."""
        if not words:
            return []
        ws = sorted(words, key=lambda w: float(w.get("start", 0)))
        expanded = []
        for w in ws:
            try:
                a = max(0.0, float(w["start"]) - pad)
                b = float(w["end"]) + pad
            except Exception:
                continue
            if b - a > 0.02:
                expanded.append([a, b])
        if not expanded:
            return []
        expanded.sort(key=lambda x: x[0])
        merged = [expanded[0][:]]
        for a, b in expanded[1:]:
            if a - merged[-1][1] <= merge_gap:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        return [(float(a), float(b)) for a, b in merged if b - a > 0.05]

    @staticmethod
    def build_transcript_cut(segments, words, duration, opts=None, body_span=None):
        """YouTube-style: speech stays, long silences -> card + cut, plus breaker every maxSpeech.

        Mirrors src/lib/transcriptCut.ts. Breaker inserts card over content for breakerDuration
        when continuous mic speech exceeds maxSpeech, keeping voice (card silences content bus only).
        """
        if not words or duration <= 0:
            return segments
        o = opts or {}
        min_silence = float(o.get("minSilence", o.get("min_silence", 1.0)))
        card_dur = float(o.get("cardDuration", o.get("card_duration", 3.0)))
        min_gap = float(o.get("minGap", o.get("min_gap", 0.25)))
        tiny_action = str(o.get("tinyAction", o.get("tiny_action", "keep")))
        pad = float(o.get("pad", 0.25))
        merge_gap = float(o.get("mergeGap", o.get("merge_gap", 0.8)))
        max_speech = float(o.get("maxSpeech", o.get("max_speech", 30.0)))
        breaker_dur = float(o.get("breakerDuration", o.get("breaker_duration", 3.0)))
        breaker_action = str(o.get("breakerAction", o.get("breaker_action", "card")))
        breaker_variant = str(o.get("breakerVariant", o.get("breaker_variant", "short")))

        speech = ReactionVideoProcessor.speech_regions_from_words(words, pad, merge_gap)
        rewrite_types = {"body", "lead", "mute", "fast", "card"}
        body_segs = [s for s in (segments or []) if s.get("type") in rewrite_types]
        if body_span:
            span_start = float(body_span.get("start", 0))
            span_end = float(body_span.get("end", duration))
        else:
            span_start = float(body_segs[0]["start"]) if body_segs else 0.0
            span_end = float(body_segs[-1]["end"]) if body_segs else float(duration)

        clipped = []
        for a, b in speech:
            a = max(a, span_start)
            b = min(b, span_end)
            if b - a > 0.02:
                clipped.append((a, b))
        clipped.sort(key=lambda x: x[0])

        # Breaker: split long speech into body + breaker card
        breaker_regions = []
        if max_speech > 1 and breaker_dur > 0:
            new_clipped = []
            for a, b in clipped:
                cur = a
                while cur < b - 0.01:
                    be = min(b, cur + max_speech)
                    new_clipped.append((cur, be))
                    cur = be
                    if cur < b - 0.01:
                        br_end = min(b, cur + breaker_dur)
                        if br_end - cur > 0.05:
                            breaker_regions.append((cur, br_end))
                            cur = br_end
            clipped = new_clipped

        def emit_gap(gs, ge):
            dur = ge - gs
            if dur < 1e-6:
                return []
            if dur < min_gap:
                return [{"type": "body", "start": gs, "end": ge}]
            if dur < min_silence:
                if tiny_action == "keep":
                    return [{"type": "body", "start": gs, "end": ge}]
                if tiny_action == "fast":
                    return [{"type": "fast", "start": gs, "end": ge}]
                return [{"type": "mute", "start": gs, "end": ge}]
            if dur <= card_dur:
                return [{"type": "card", "start": gs, "end": ge}]
            return [
                {"type": "card", "start": gs, "end": gs + card_dur},
                {"type": "cut", "start": gs + card_dur, "end": ge},
            ]

        out = []
        segs = sorted(segments or [], key=lambda s: float(s.get("start", 0)))
        for s in segs:
            typ = str(s.get("type", "body"))
            if typ not in rewrite_types:
                out.append(dict(s))
                continue
            ss = float(s["start"]); se = float(s["end"])
            if se <= span_start or ss >= span_end:
                out.append(dict(s)); continue
            seg_start = max(ss, span_start); seg_end = min(se, span_end)
            if seg_end - seg_start <= 0.02:
                continue
            # gather overlapping speech and breakers
            pieces = []
            for a,b in clipped:
                if b > seg_start + 0.01 and a < seg_end - 0.01:
                    pieces.append((max(a, seg_start), min(b, seg_end), False))
            for a,b in breaker_regions:
                if b > seg_start + 0.01 and a < seg_end - 0.01:
                    pieces.append((max(a, seg_start), min(b, seg_end), True))
            pieces.sort(key=lambda x: x[0])
            if not pieces:
                out.extend(emit_gap(seg_start, seg_end))
                continue
            cursor = seg_start
            for a,b,is_br in pieces:
                if a - cursor > 0.02:
                    out.extend(emit_gap(cursor, a))
                if is_br:
                    btyp = breaker_action if breaker_action in ("card", "cut") else "card"
                    bout = {"type": btyp, "start": a, "end": b}
                    if btyp == "card" and breaker_variant == "short":
                        bout["card"] = {"variant": "short"}
                    out.append(bout)
                else:
                    out.append({"type": "body", "start": max(cursor, a), "end": b})
                cursor = max(cursor, b)
            if seg_end - cursor > 0.02:
                out.extend(emit_gap(cursor, seg_end))
        out.sort(key=lambda s: s["start"])
        tidy = []
        for s in out:
            if tidy and tidy[-1]["type"] == s["type"] and abs(tidy[-1]["end"] - s["start"]) < 0.02 and (s["type"] != "card" or _card_sig(tidy[-1]) == _card_sig(s)):
                tidy[-1]["end"] = max(tidy[-1]["end"], s["end"])
            else:
                tidy.append(dict(s))
        return [s for s in tidy if s["end"] - s["start"] > 0.08 and s["end"] <= duration + 0.05]

    @staticmethod
    def build_fair_use_limit(segments, duration, opts=None, words=None, body_span=None,
                             detection_regions=None, fast_speed=4.0):
        """Content-ID limiter — mirrors src/lib/fairUseCut.ts.

        Two modes (opts["mode"]):

        * "cards" (the default): **nothing is cut**. Every long stretch of
          talking gets a card of ``cardSec`` seconds after ``everySec``
          seconds of speech, so a 30 s stretch with the defaults (8 s / 4 s)
          gets cards at 8-12 s and 20-24 s. Content ID never sees an
          uninterrupted run of the programme, and the reaction stays in one
          piece. Every card is SHORT (the limiter never places a tall card)
          and may carry a playback ``cardSpeed`` — the card hides the picture,
          so it can run a little faster without a visible jump.
        * "trim": keep the most speech-dense ``maxBodySec`` of the reaction.
          Buckets are picked by score but **spread over the whole reaction**
          (a candidate has to be at least 6 s away from an already-kept one),
          then kept in chronological order — not "the first N minutes", which
          is what a flat audio score used to produce. What is dropped becomes
          a cut, or a ``cardDuration`` card pointer in front of one
          ("removedAction": "card").
        """
        o = opts or {}
        mode = str(o.get("mode", "cards") or "cards").strip().lower()
        if mode not in ("cards", "trim"):
            mode = "cards"
        every_sec = max(1.5, float(o.get("everySec", o.get("every_sec", 8.0)) or 8.0))
        card_sec = max(0.5, float(o.get("cardSec", o.get("card_sec", 4.0)) or 4.0))
        card_speed = max(1.0, float(o.get("cardSpeed", o.get("card_speed", 1.0)) or 1.0))
        min_run = max(0.0, float(o.get("minRunSec", o.get("min_run_sec", 6.0)) or 0.0))
        # every card the limiter inserts is short, whatever an old project
        # stored: the bottom of the content (subtitles) has to stay visible
        variant = "short"
        max_body = float(o.get("maxBodySec", o.get("max_body_sec", 600)))
        removed_action = str(o.get("removedAction", o.get("removed_action", "cut")))
        card_dur = float(o.get("cardDuration", o.get("card_duration", 3.0)))
        bucket_sec = float(o.get("bucketSec", o.get("bucket_sec", 1.0)))
        keep_pad = float(o.get("keepPad", o.get("keep_pad", 0.5)))
        fast = float(fast_speed or 4.0)

        rewrite_types = {"body", "lead", "mute", "fast"}
        coverable = rewrite_types | {"card"}
        segs = sorted(segments or [], key=lambda x: float(x.get("start", 0)))
        rewriteable = [s for s in segs if str(s.get("type", "body")) in rewrite_types]
        if body_span:
            span_start = float(body_span.get("start", 0))
            span_end = float(body_span.get("end", duration))
        else:
            span_start = float(rewriteable[0]["start"]) if rewriteable else 0.0
            span_end = float(rewriteable[-1]["end"]) if rewriteable else float(duration)

        def _spd(s) -> float:
            return max(1e-6, C.seg_speed(s, fast))

        def _prog(s, a, b) -> float:
            return max(0.0, b - a) / _spd(s)

        def _kept_prog(only_rewriteable=False) -> float:
            total = 0.0
            for s in segs:
                typ = str(s.get("type", "body"))
                if typ == "cut":
                    continue
                if only_rewriteable and typ not in rewrite_types:
                    continue
                a = max(float(s["start"]), span_start)
                b = min(float(s["end"]), span_end)
                if b - a > 0.001:
                    total += _prog(s, a, b)
            return total

        original = _kept_prog(False)

        # ---- speech: transcript words, else the audio scan -----------------
        speech = []
        if words and len(words):
            first = words[0]
            if isinstance(first, dict) and "text" in first:
                speech = ReactionVideoProcessor.speech_regions_from_words(words, 0.25, 0.8)
            else:
                for r in words:
                    if isinstance(r, dict):
                        a, b = float(r.get("start", 0)), float(r.get("end", 0))
                    else:
                        a, b = float(r[0]), float(r[1])
                    if b > a:
                        speech.append((a, b))
        elif detection_regions:
            for r in detection_regions:
                if isinstance(r, dict):
                    a, b = float(r.get("start", 0)), float(r.get("end", 0))
                else:
                    a, b = float(r[0]), float(r[1])
                if b > a:
                    speech.append((a, b))
        speech = sorted(speech, key=lambda x: x[0])

        def _card_payload() -> Dict[str, Any]:
            payload: Dict[str, Any] = {"variant": "short"}
            if card_speed > 1.0001:
                payload["speed"] = round(card_speed, 4)
            return payload

        def _tidy(out):
            out = sorted(out, key=lambda x: float(x["start"]))
            tidy = []
            for s in out:
                if (tidy and tidy[-1]["type"] == s["type"]
                        and abs(tidy[-1]["end"] - s["start"]) < 0.02
                        and (s["type"] != "card"
                             or _card_sig(tidy[-1]) == _card_sig(s))):
                    tidy[-1]["end"] = max(tidy[-1]["end"], s["end"])
                else:
                    tidy.append(dict(s))
            return [s for s in tidy
                    if s["end"] - s["start"] > 0.08 and s["end"] <= duration + 0.05]

        # ================================ cards =============================
        if mode == "cards":
            runs = []
            if speech:
                clipped = sorted((max(a, span_start), min(b, span_end))
                                 for a, b in speech
                                 if min(b, span_end) - max(a, span_start) > 0.05)
                for a, b in clipped:
                    if runs and a - runs[-1][1] <= 1.0:
                        runs[-1][1] = max(runs[-1][1], b)
                    else:
                        runs.append([a, b])
                runs = [r for r in runs if r[1] - r[0] >= min_run]
            else:
                # no speech info: treat every long kept stretch as talk
                for s in segs:
                    if str(s.get("type", "body")) not in coverable:
                        continue
                    a = max(float(s["start"]), span_start)
                    b = min(float(s["end"]), span_end)
                    if b - a >= every_sec + card_sec:
                        runs.append([a, b])
            by_start = [(float(s["start"]), float(s["end"]), str(s.get("type", "body")))
                        for s in segs]

            def _type_at(t: float) -> str:
                for a, b, ty in by_start:
                    if a <= t < b:
                        return ty
                return "body"

            intervals = []
            for a0, b0 in runs:
                cursor = a0
                while cursor + every_sec < b0 - 1.0:
                    a = cursor + every_sec
                    b = min(b0 - 0.5, a + card_sec)
                    if b - a < min(1.0, card_sec * 0.5):
                        break
                    if _type_at(a) in coverable:
                        intervals.append((a, b))
                    cursor = a + card_sec

            out = []
            for s in segs:
                typ = str(s.get("type", "body"))
                if typ not in coverable:
                    out.append(dict(s))
                    continue
                ss = max(float(s["start"]), span_start)
                se = min(float(s["end"]), span_end)
                if se <= ss:
                    out.append(dict(s))
                    continue
                hits = [(a, b) for a, b in intervals
                        if b > ss + 0.02 and a < se - 0.02]
                hits.sort(key=lambda x: x[0])
                cursor = ss
                for a, b in hits:
                    a = max(a, ss)
                    b = min(b, se)
                    if a - cursor > 0.02:
                        out.append({"type": typ, "start": cursor, "end": a})
                    out.append({"type": "card", "start": a, "end": b,
                                "card": _card_payload()})
                    cursor = max(cursor, b)
                if se - cursor > 0.02:
                    out.append({"type": typ, "start": cursor, "end": se})
            return _tidy(out)

        # ================================= trim =============================
        rewrite_prog = _kept_prog(True)
        if original <= max_body + 0.01 or rewrite_prog <= 0.01:
            return segments
        rewrite_budget = max(0.0, max_body - max(0.0, original - rewrite_prog))

        def _score(a, b) -> float:
            sc = 0.0
            for sa, sb in speech:
                if sb <= a:
                    continue
                if sa >= b:
                    break
                ov = min(sb, b) - max(sa, a)
                if ov > 0:
                    sc += ov
            return sc

        # buckets cover ONLY rewriteable footage — cards/cuts are holes
        buckets = []  # (start, end, score, type)
        for s in rewriteable:
            ss = max(float(s["start"]), span_start)
            se = min(float(s["end"]), span_end)
            t = ss
            while t < se - 0.01:
                be = min(t + bucket_sec, se)
                buckets.append((t, be, _score(t, be) if speech else 0.0,
                                str(s.get("type", "body"))))
                t = be
        if not buckets:
            return segments

        prog_per_bucket = rewrite_prog / len(buckets)
        # Each kept island carries its context padding, and that padding is
        # real programme time — it comes out of the budget, or "limit to
        # 10 min" lands well past the limit once there is more than one
        # island (the browser mirror does the same).
        pad = max(0.0, min(keep_pad, bucket_sec))
        per_island = prog_per_bucket + 2.0 * pad
        target = max(0, min(len(buckets),
                            int(round(rewrite_budget / max(1e-6, per_island)))))

        # Windows: split the footage into `target` equal slots and keep the
        # best bucket of each. The keeps land all over the reaction — start,
        # middle and end all survive — instead of piling up at the front,
        # which is what score order with an "earliest first" tie-break used to
        # do (a flat audio scan kept the first N minutes and cut the rest).
        keep_set = set()
        nb = len(buckets)
        for w in range(target):
            a = (w * nb) // target
            b = max(a + 1, ((w + 1) * nb) // target)
            best = -1
            for i in range(a, min(b, nb)):
                if not speech:
                    best = i          # no scores to compare — one sample/window
                    break
                if best < 0 or buckets[i][2] > buckets[best][2]:
                    best = i
            if best >= 0:
                keep_set.add(best)

        kept_intervals = []  # [start, end, type]
        for i in sorted(keep_set):
            bs, be, _, ty = buckets[i]
            if (kept_intervals and abs(kept_intervals[-1][1] - bs) < 0.05
                    and kept_intervals[-1][2] == ty):
                kept_intervals[-1][1] = be
            else:
                kept_intervals.append([bs, be, ty])

        padded = [[max(span_start, a - pad), min(span_end, b + pad), ty]
                  for a, b, ty in kept_intervals]
        merged = []
        for a, b, ty in padded:
            if merged and a - merged[-1][1] <= 0.05 and merged[-1][2] == ty:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b, ty])

        def _emit_removed(fr, to):
            if to - fr <= 0.02:
                return []
            if removed_action == "card" and to - fr > card_dur:
                return [{"type": "card", "start": fr, "end": fr + card_dur,
                         "card": _card_payload()},
                        {"type": "cut", "start": fr + card_dur, "end": to}]
            if removed_action == "card":
                # a short pointer card, never an unlabelled card of any length
                return [{"type": "card", "start": fr, "end": to,
                         "card": _card_payload()}]
            return [{"type": removed_action, "start": fr, "end": to}]

        out = []
        for s in segs:
            typ = str(s.get("type", "body"))
            if typ not in rewrite_types:
                out.append(dict(s))
                continue
            ss, se = float(s["start"]), float(s["end"])
            if se <= span_start or ss >= span_end:
                out.append(dict(s))
                continue
            ss = max(ss, span_start)
            se = min(se, span_end)
            cursor = ss
            for a, b, ty in merged:
                if b <= cursor + 0.02 or a >= se - 0.02:
                    continue
                a, b = max(a, cursor), min(b, se)
                if b - a <= 0.02:
                    continue
                if a - cursor > 0.02:
                    out.extend(_emit_removed(cursor, a))
                out.append({"type": typ, "start": a, "end": b})
                cursor = max(cursor, b)
            if se - cursor > 0.02:
                out.extend(_emit_removed(cursor, se))
        return _tidy(out)



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
                         progress_cb=None, cancel_check=None) -> Dict[str, Any]:
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
            if cancel_check is not None and cancel_check():
                raise RenderCancelled("transcription cancelled by user")
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
                           crf: int = 23, webm: bool = True,
                           stems: bool = False) -> Dict[str, str]:
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
                               segments=segments, fast_speed=layout.fastSpeed,
                               stems=stems)
        outs = self.mux(video_nc, audio, self.out / f"{name}.mp4", webm=webm,
                        stems=dict(self.last_stems) if stems else None)
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
                           layout: Optional[L.LayoutState] = None,
                           stems: bool = True) -> str:
        """Full uncut reaction, intro/outro in full-cam, transcript for cleanup.

        *stems* publishes the content-only and mic-only buses as audio tracks
        2 and 3 behind the mix (track 1 stays the full programme, so every
        player behaves exactly as before). A later YouTube cut can then read
        those tracks and silence the content without losing your voice.
        """
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
                                       segments=segments, stems=stems)
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
