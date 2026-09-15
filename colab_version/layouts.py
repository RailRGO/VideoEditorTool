"""
Shared layout model — Python mirror of src/lib/types.ts.

The browser editor (LayoutState) and the Colab pipeline now speak the same
language: normalised rects (0..1), per-layer styles, background plate, card.
A layout can be saved to JSON from either side and renders identically
because colab compose.py implements the same math as render.ts.

No third-party dependencies — stdlib only.
"""
from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Union

Fit = Literal["cover", "contain"]
Shape = Literal["rect", "rounded", "circle", "pill"]


@dataclass
class LayerStyle:
    fit: Fit = "contain"
    zoom: float = 1.0
    offsetX: float = 0.0
    offsetY: float = 0.0
    mirror: bool = False
    radius: float = 0.0      # corner radius in 1080p pixels (scaled to canvas)
    shape: Shape = "rounded"
    border: float = 0.0      # border width in 1080p pixels
    borderColor: str = "#0b1220"
    opacity: float = 1.0


@dataclass
class Rect:
    x: float = 0.0
    y: float = 0.0
    w: float = 1.0
    h: float = 1.0

    def px(self, W: int, H: int):
        return (self.x * W, self.y * H, self.w * W, self.h * H)

    def overlap_pct(self, other: "Rect") -> float:
        """How much of *self* is covered by *other* (0..100)."""
        x1 = max(self.x, other.x)
        y1 = max(self.y, other.y)
        x2 = min(self.x + self.w, other.x + other.w)
        y2 = min(self.y + self.h, other.y + other.h)
        if x2 <= x1 or y2 <= y1:
            return 0.0
        area = max(1e-9, self.w * self.h)
        return (x2 - x1) * (y2 - y1) / area * 100.0


@dataclass
class BackgroundStyle:
    source: Literal["content", "camera", "full"] = "full"
    blur: float = 50.0       # blur radius in 1080p pixels
    opacity: float = 0.4
    scale: float = 1.08
    dim: float = 0.25        # 0 = full brightness, 0.8 = very dark


@dataclass
class CardStyle:
    title: str = "Full uncut reaction on Patreon"
    sub: str = "link in the description"
    accent: str = "#e879f9"
    # custom card background (data URL or file path); "" = generated gradient
    image: str = ""
    # draw the title/sub/accent bar over the custom image
    showText: bool = True
    # short-card height as a fraction of the content height (top-anchored,
    # so subtitles at the bottom stay visible)
    shortHeight: float = 0.75
    # card opacity 0..1, exact: 1 = fully opaque, 0 = no card is drawn at all
    # (the whole card — backdrop, bar, words, ring — shares this alpha)
    opacity: float = 0.96


@dataclass
class LayoutState:
    cameraSide: Literal["left", "right"] = "left"
    sourceMode: Literal["split", "single"] = "split"
    # measured 1080p sizes: content 1344x756 (70%), camera 576x324 (30%)
    content: Rect = field(default_factory=lambda: Rect(0.294, 0.289, 0.70, 0.70))
    cam: Rect = field(default_factory=lambda: Rect(0.006, 0.011, 0.30, 0.30))
    bg: BackgroundStyle = field(default_factory=BackgroundStyle)
    contentStyle: LayerStyle = field(
        default_factory=lambda: LayerStyle(fit="contain", shape="rounded", radius=10)
    )
    camStyle: LayerStyle = field(
        default_factory=lambda: LayerStyle(
            fit="contain", shape="rounded", radius=20, border=3, borderColor="#0ea5e9"
        )
    )
    soloStyle: LayerStyle = field(
        default_factory=lambda: LayerStyle(fit="contain", shape="rect", zoom=1.05)
    )
    muteContentInSolo: bool = True
    contentHidden: bool = False
    fastSpeed: float = 4.0
    fastGainDb: float = -6.0
    chipmunk: bool = False
    card: CardStyle = field(default_factory=CardStyle)

    # -- (de)serialisation -------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LayoutState":
        base = asdict(default_layout())
        merged = _deep_merge(base, d or {})

        def _rect(r):
            return Rect(float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"]))

        def _style(s):
            return LayerStyle(
                fit=s.get("fit", "contain"),
                zoom=float(s.get("zoom", 1.0)),
                offsetX=float(s.get("offsetX", 0.0)),
                offsetY=float(s.get("offsetY", 0.0)),
                mirror=bool(s.get("mirror", False)),
                radius=float(s.get("radius", 0.0)),
                shape=s.get("shape", "rounded"),
                border=float(s.get("border", 0.0)),
                borderColor=s.get("borderColor", "#0b1220"),
                opacity=float(s.get("opacity", 1.0)),
            )

        bg = merged.get("bg", {})
        card = merged.get("card", {})
        return cls(
            cameraSide=merged.get("cameraSide", "left"),
            sourceMode=merged.get("sourceMode", "split"),
            content=_rect(merged.get("content", {})),
            cam=_rect(merged.get("cam", {})),
            bg=BackgroundStyle(
                source=bg.get("source", "full"),
                blur=float(bg.get("blur", 50)),
                opacity=float(bg.get("opacity", 0.4)),
                scale=float(bg.get("scale", 1.08)),
                dim=float(bg.get("dim", 0.25)),
            ),
            contentStyle=_style(merged.get("contentStyle", {})),
            camStyle=_style(merged.get("camStyle", {})),
            soloStyle=_style(merged.get("soloStyle", {})),
            muteContentInSolo=bool(merged.get("muteContentInSolo", True)),
            contentHidden=bool(merged.get("contentHidden", False)),
            fastSpeed=float(merged.get("fastSpeed", 4.0)),
            fastGainDb=float(merged.get("fastGainDb", -6.0)),
            chipmunk=bool(merged.get("chipmunk", False)),
            card=CardStyle(
                title=card.get("title", "Full uncut reaction on Patreon"),
                sub=card.get("sub", "link in the description"),
                accent=card.get("accent", "#e879f9"),
                image=str(card.get("image", "") or ""),
                showText=bool(card.get("showText", True)),
                # `or` here would turn an explicit 0 (no card at all) back
                # into the default — only a missing/None value may default
                shortHeight=(0.75 if card.get("shortHeight") is None
                             else float(card["shortHeight"])),
                opacity=(0.96 if card.get("opacity") is None
                         else float(card["opacity"])),
            ),
        )

    @classmethod
    def from_json(cls, s: Union[str, Path]) -> "LayoutState":
        p = Path(str(s))
        text = p.read_text() if p.exists() and len(str(s)) < 512 else str(s)
        # heuristic: if it looks like a path that exists, read it; else parse inline
        try:
            if p.exists():
                text = p.read_text()
        except OSError:
            text = str(s)
        return cls.from_dict(json.loads(text))

    def save(self, path: Union[str, Path]) -> str:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_json())
        return str(p)


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def default_layout() -> LayoutState:
    """Camera top-left (~30%), content bottom-right (~70%), both rounded.

    Matches the browser default exactly — the two rects do NOT overlap.
    """
    return LayoutState()


# ---------------------------------------------------------------------------
# Frame presets (mirrors LAYOUT_PRESETS in src/lib/types.ts)
# ---------------------------------------------------------------------------

@dataclass
class LayoutPreset:
    id: str
    name: str
    hint: str
    content: Rect
    cam: Rect
    camShape: Shape
    hideContent: bool


LAYOUT_PRESETS: List[LayoutPreset] = [
    LayoutPreset("hero-circle", "Hero circle", "big circle face · content blurred behind",
                 Rect(0.25, 0.25, 0.50, 0.50), Rect(0.28, 0.06, 0.44, 0.78), "circle", True),
    LayoutPreset("hero-circle-left", "Hero circle L", "big circle left · blurred content",
                 Rect(0.45, 0.20, 0.50, 0.60), Rect(0.04, 0.10, 0.42, 0.74), "circle", True),
    LayoutPreset("hero-pill", "Hero pill", "stadium face · blurred content",
                 Rect(0.20, 0.25, 0.60, 0.50), Rect(0.18, 0.22, 0.64, 0.56), "pill", True),
    LayoutPreset("hero-rect", "Hero rectangle", "large rounded face · blurred content",
                 Rect(0.60, 0.25, 0.36, 0.50), Rect(0.12, 0.08, 0.50, 0.84), "rounded", True),
    LayoutPreset("reaction-1344", "Reaction 1344+576", "content 1344x756 r10 · cam 576x324 r20",
                 Rect(0.294, 0.289, 0.70, 0.70), Rect(0.006, 0.011, 0.30, 0.30), "rounded", False),
    LayoutPreset("tl-br", "Cam TL · content BR", "your default look",
                 Rect(0.294, 0.289, 0.70, 0.70), Rect(0.006, 0.011, 0.30, 0.30), "rounded", False),
    LayoutPreset("tl-br-tight", "Cam TL · content BR (tight)", "small camera · bigger content",
                 Rect(0.29, 0.26, 0.685, 0.70), Rect(0.025, 0.04, 0.24, 0.27), "rounded", False),
    LayoutPreset("bl-tr", "Cam BL · content TR", "mirrored corners",
                 Rect(0.35, 0.045, 0.62, 0.655), Rect(0.03, 0.62, 0.30, 0.335), "rounded", False),
    LayoutPreset("overlay-br", "Content full", "camera overlaid TL",
                 Rect(0.02, 0.06, 0.96, 0.88), Rect(0.03, 0.045, 0.30, 0.335), "rounded", False),
]


def apply_preset(layout: LayoutState, preset_id: str) -> LayoutState:
    """Return a copy of *layout* with the preset's rects/shape applied."""
    for p in LAYOUT_PRESETS:
        if p.id == preset_id:
            out = deepcopy(layout)
            out.content = deepcopy(p.content)
            out.cam = deepcopy(p.cam)
            out.contentHidden = p.hideContent
            out.camStyle.shape = p.camShape
            return out
    raise KeyError(f"unknown preset {preset_id!r} (have {[p.id for p in LAYOUT_PRESETS]})")


# ---------------------------------------------------------------------------
# Backwards compatibility: old colab preset names -> LayoutState
# ---------------------------------------------------------------------------

def old_preset_to_layout(name: str) -> LayoutState:
    """Map the first-generation colab preset names to real layouts.

    The old pipeline overlaid full-resolution halves, which is why the camera
    came out far too big and covered the content. These mappings use proper
    normalised rects instead, so preview and render finally agree.
    """
    name = (name or "diagonal").lower()
    L = default_layout()
    if name == "diagonal":
        return apply_preset(L, "tl-br")
    if name == "circle_blur":
        L = apply_preset(L, "hero-circle")
        L.bg.blur = 90
        L.bg.opacity = 0.58
        return L
    if name == "rect_blur":
        L = apply_preset(L, "hero-rect")
        L.bg.blur = 90
        L.bg.opacity = 0.55
        return L
    if name == "hero_circle":
        return apply_preset(L, "hero-circle")
    if name == "hero_plus":
        # big face + small content card kept visible
        L = apply_preset(L, "hero-rect")
        L.cam = Rect(0.04, 0.08, 0.56, 0.84)
        L.content = Rect(0.63, 0.55, 0.33, 0.37)
        L.contentHidden = False
        return L
    if name == "news":
        L.cam = Rect(0.70, 0.05, 0.26, 0.29)
        L.content = Rect(0.05, 0.25, 0.62, 0.70)
        L.contentHidden = False
        L.camStyle.shape = "rounded"
        return L
    # unknown -> default diagonal look
    return apply_preset(L, "tl-br")


# ---------------------------------------------------------------------------
# Audio / retouch / cut defaults shared by the GUI and the processor
# ---------------------------------------------------------------------------

def default_audio() -> Dict[str, Any]:
    return {
        "mic_channel": "left",   # which stereo channel is your mic
        "mic_gain_db": 0.0,
        "comp_on": True,
        "comp_threshold": -24.0,
        "comp_ratio": 4.0,
        "comp_makeup": 4.0,
        "limiter_db": -1.2,
        "content_gain_db": -1.5,
        "duck_on": True,
        "duck_threshold": -32.0,
        "duck_depth": 12.0,      # dB of attenuation while you speak
    }


def default_retouch() -> Dict[str, Any]:
    """Browser-parity keys (see src/lib/types.ts). Old keys (smooth/eyes/nose
    as 0..100 magnitudes) are still accepted by the processor."""
    return {
        "enabled": False,
        "skin": 55.0,      # 0..100 smoothing
        "detail": 45.0,    # edge preservation
        "teeth": 40.0,     # 0..100 whitening
        "eyeScale": 0.0,   # % around each iris
        "noseScale": 0.0,  # % (negative narrows)
        "feather": 45.0,   # warp/mask softness
        "smoothing": 60.0, # temporal (offline: pose carry)
        "everyN": 1,       # detect every Nth frame, carry pose between
        "manual": False,
        "manualRect": {"x": 0.3, "y": 0.1, "w": 0.4, "h": 0.55},
    }


def default_audio_cloak() -> Dict[str, Any]:
    return {
        "on": True,
        "pitch": 0.5,    # semitones, tempo-preserving
        "chorus": 25.0,  # 0..100
        "reverb": 18.0,  # 0..100
        "tilt": 2.0,     # dB, positive = brighter
        "widen": 6.0,    # ms Haas delay on right channel
        # voice changer — reaction part only; *which bus* is voiceTarget
        "voiceChanger": False,
        # content: re-voice the PROGRAMME (that is what Content ID
        # fingerprints) and keep your own commentary natural
        "voiceTarget": "content",   # content | mic | both
        # morph = the built-in numpy voice (no model, no download, cpu-fast),
        # rvc = a neural character voice, fx = the plain ffmpeg presets
        "voiceMode": "morph",
        "voicePreset": "anon",  # fx presets: anon|deep|high|robot|custom
        "voiceStrength": 70.0,  # 0..100 intensity (fx mode)
        "voicePitch": 0.0,      # extra pitch shift for custom preset, semitones
        # built-in morph characters (voiceMode == "morph")
        "morphPreset": "incognito",  # incognito|deep|bright|robot|alien|warm|radio|custom
        "morphStrength": 85.0,       # 0..100
        "morphSeed": 0,              # same seed = same voice on every render
        "morphFormant": 1.0,         # 0.5..2.0 vocal-tract override (1 = preset)
        "voicePresetMic": "",        # 2nd character for the mic when target=both
        "morphSeedMic": "",          # 2nd seed for the mic when target=both
        # while the voice changer is on, card sections keep the (re-voiced)
        # audio playing instead of silencing it — mute spans still silence
        "voiceKeepCardAudio": False,
        # RVC character voice settings (voiceMode == "rvc")
        "rvcModel": "",         # path, https:// URL or hf:owner/repo/file.pth
        "rvcIndex": "",         # optional path to the .index file
        "rvcTranspose": 0,      # semitones (-24..24)
        "rvcIndexRate": 0.5,    # 0..1 similarity to the training voice
        "rvcMethod": "rmvpe",   # pitch extraction: rmvpe|pm|crepe
    }


def default_sticker() -> Dict[str, Any]:
    """User overlay image (subscribe / like / …) on the YouTube cut.

    Drawn on the reaction part only — intro/outro stay clean like every
    other effect. x/y = normalised top-left position, w = width as a
    fraction of the frame width (height follows the image aspect),
    opacity 0..1.
    """
    return {
        "on": False,
        "src": "",        # data URL / http(s) / file path (bare name = uploaded asset)
        "x": 0.72,
        "y": 0.04,
        "w": 0.18,
        "opacity": 1.0,
    }


def default_video_cloak() -> Dict[str, Any]:
    return {
        "on": True,
        "zoom": 1.0,
        "bars": 0.0,       # % of height, top + bottom — 0 by default to avoid black lines
        "border": 0.0,     # px @1080p
        "borderColor": "#0ea5e9",
        "saturate": 100.0,
        "contrast": 100.0,
        "brightness": 100.0,
        "hue": 0.0,
        "grain": 0.0,
        "vignette": 0.0,
        "flip": False,     # horizontal mirror full frame — strongest Content ID evasion
        "flipContent": False,  # mirror only content area — keeps camera readable
        "blur": 0.0,       # subtle blur px
        "rotate": 0.0,     # degrees -5..5
        "speed": 1.0,      # global playback speed tweak 0.95..1.05
        "contentOnly": True,  # when true, zoom/blur/rotate/hue/sat/cont/bri/grain/flipContent affect only content rect
        "fisheye": False,  # fisheye lens on the content of reaction parts only (intro/outro stay clean), off by default
        "fisheyeAmount": 35.0,  # 0..100 intensity of fisheye
    }


def default_cuts() -> Dict[str, Any]:
    return {
        "intro_end": 8.0,      # seconds of full-cam intro
        "outro_start": -12.0,  # <=0 means "duration + value" (last 12 s)
        "lead_in": 2.0,        # your "let's go" kept before the switch
        "black": 1.5,          # black content block before content starts
        "silence_db": -40.0,
        "min_silence": 2.0,
        "claims": [],          # [(start, end, action)] action in cut|mute
    }
