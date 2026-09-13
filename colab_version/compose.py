"""
WYSIWYG compositor — Python mirror of src/lib/render.ts.

Every layout parameter behaves exactly like the browser editor:
normalised rects, cover/contain fit, zoom, offsets, mirror, shapes
(rect/rounded/circle/pill), 1080p-authored radius/border, opacity,
background plate (source/blur/opacity/scale/dim) and the card /
lead-in / fast-forward overlays.

The GUI preview and the final render call the SAME compose_frame(),
so what you see while dragging sliders is what gets rendered.
That also fixes the old bug where the camera was composited at full
resolution and covered the content.

Dependencies: numpy, opencv (cv2). ffmpeg binary is used when present
(fast pipe encoding + audio muxing) with a cv2.VideoWriter fallback.
"""
from __future__ import annotations

import base64
import hashlib
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np

try:
    from layouts import (
        BackgroundStyle,
        CardStyle,
        LayoutState,
        LayerStyle,
        Rect,
        default_layout,
    )
except ImportError:  # package-style import
    from .layouts import (
        BackgroundStyle,
        CardStyle,
        LayoutState,
        LayerStyle,
        Rect,
        default_layout,
    )

BASE_COLOR = (12, 6, 4)  # #04060c in BGR — the app background plate


class RenderCancelled(Exception):
    """Raised to abort a render when the user cancels the running job."""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def hex_to_bgr(h: str) -> Tuple[int, int, int]:
    h = (h or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        r, g, b = 255, 255, 255
    return (b, g, r)


def shape_mask(w: int, h: int, shape: str, radius: float) -> np.ndarray:
    """Single-channel uint8 mask (255 inside) for a layer box."""
    w, h = max(1, int(w)), max(1, int(h))
    if shape == "circle":
        m = np.zeros((h, w), np.uint8)
        cv2.ellipse(m, (int(w / 2), int(h / 2)),
                    (max(1, int(w / 2)), max(1, int(h / 2))),
                    0, 0, 360, 255, -1, cv2.LINE_AA)
        return m
    rr = 0.0
    if shape == "pill":
        rr = min(w, h) / 2.0
    elif shape == "rounded":
        rr = max(0.0, min(float(radius), min(w, h) / 2.0))
    if rr <= 0.5:
        return np.full((h, w), 255, np.uint8)
    r = int(round(rr))
    m = np.zeros((h, w), np.uint8)
    cv2.rectangle(m, (r, 0), (w - r, h), 255, -1)
    cv2.rectangle(m, (0, r), (w, h - r), 255, -1)
    for cx, cy in ((r, r), (w - r - 1, r), (r, h - r - 1), (w - r - 1, h - r - 1)):
        cv2.circle(m, (max(0, cx), max(0, cy)), r, 255, -1, cv2.LINE_AA)
    return m


def _cover_resize(img: np.ndarray, dw: int, dh: int) -> np.ndarray:
    """Center-crop to aspect dw/dh, then resize to exactly dw×dh."""
    h, w = img.shape[:2]
    if w <= 0 or h <= 0 or dw <= 0 or dh <= 0:
        return np.zeros((max(1, dh), max(1, dw), 3), np.uint8)
    s_asp, d_asp = w / h, dw / dh
    if s_asp > d_asp:
        nw = int(round(h * d_asp))
        x = max(0, (w - nw) // 2)
        img = img[:, x:x + nw]
    else:
        nh = int(round(w / d_asp))
        y = max(0, (h - nh) // 2)
        img = img[y:y + nh, :]
    return cv2.resize(img, (dw, dh), interpolation=cv2.INTER_AREA)


def _contain_size(sw: int, sh: int, dw: int, dh: int) -> Tuple[int, int]:
    s = min(dw / max(1, sw), dh / max(1, sh))
    return max(1, int(round(sw * s))), max(1, int(round(sh * s)))


def seg_speed(seg: Dict[str, Any], fast_speed: float = 4.0) -> float:
    """Playback speed of one segment — mirrors segSpeed() in src/lib/timeline.ts.

    `fast` spans run at the fast-forward rate; a `card` span may carry its own
    speed in `seg["card"]["speed"]` (the card hides the picture, so it can play
    a little faster without a visible jump). Everything else runs 1x.
    """
    typ = str(seg.get("type", "body"))
    if typ == "fast":
        return max(1.05, float(fast_speed or 4.0))
    if typ == "card":
        c = seg.get("card") or {}
        try:
            sp = float(c.get("speed", 1.0) or 1.0)
        except (TypeError, ValueError):
            sp = 1.0
        return max(1.0, sp)
    return 1.0


def content_picture_rect(layout: LayoutState, src_w: int, src_h: int,
                         W: int, H: int) -> Rect:
    """Where the content half actually lands on a W×H canvas (normalised).

    Mirrors contentPicture() in src/lib/render.ts and the fit math of
    draw_layer()/fitRect(): contain keeps the source aspect (letterbox inside
    the content rect), cover fills the rect; zoom/offset then move the
    *picture*, scaled by the fitted size, exactly like the compositor does.

    The card is pinned to this rect so it covers the picture it is hiding —
    not the letterbox padding around it — in the preview and in the render.
    """
    box = layout.content
    st = layout.contentStyle
    try:
        sw, sh = max(1, int(src_w)), max(1, int(src_h))
    except (TypeError, ValueError):
        return Rect(box.x, box.y, box.w, box.h)
    w, h = box.w * W, box.h * H
    if str(getattr(st, "fit", "contain")) != "contain":
        pw, ph = w, h
    else:
        s_asp, d_asp = sw / sh, w / max(1.0, h)
        if s_asp > d_asp:
            pw, ph = w, w / s_asp
        else:
            pw, ph = h * s_asp, h
    zoom = max(0.01, float(getattr(st, "zoom", 1.0) or 1.0))
    zw, zh = pw * zoom, ph * zoom
    x = box.x * W + (w - zw) / 2 + float(getattr(st, "offsetX", 0.0) or 0.0) * pw
    y = box.y * H + (h - zh) / 2 + float(getattr(st, "offsetY", 0.0) or 0.0) * ph
    return Rect(x / W, y / H, zw / W, zh / H)


# ---------------------------------------------------------------------------
# layers
# ---------------------------------------------------------------------------

def draw_layer(canvas: np.ndarray, img: Optional[np.ndarray],
               rect: Rect, style: LayerStyle) -> None:
    """Paint one layer onto the canvas in place (mirrors drawInto)."""
    H, W = canvas.shape[:2]
    if img is None or img.size == 0:
        return
    k = H / 1080.0  # radius/border authored in 1080p px
    dx, dy, dw, dh = (int(round(v)) for v in
                      (rect.x * W, rect.y * H, rect.w * W, rect.h * H))
    if dw <= 1 or dh <= 1:
        return
    sh, sw = img.shape[:2]

    # fit
    if style.fit == "cover":
        im = _cover_resize(img, dw, dh)
        px, py = dx, dy
    else:
        fw, fh = _contain_size(sw, sh, dw, dh)
        im = cv2.resize(img, (fw, fh), interpolation=cv2.INTER_AREA)
        px, py = dx + (dw - fw) // 2, dy + (dh - fh) // 2

    # zoom + offset (offset is relative to the layer box, like the browser)
    zw, zh = max(1, int(round(im.shape[1] * style.zoom))), \
        max(1, int(round(im.shape[0] * style.zoom)))
    if (zw, zh) != (im.shape[1], im.shape[0]):
        im = cv2.resize(im, (zw, zh), interpolation=cv2.INTER_LINEAR)
    px = int(round(px + (dw if style.fit == "cover" else im.shape[1] / style.zoom
                         if style.zoom else 0) * 0))  # keep anchored
    # recenter on the zoom (mirror of the TS math: zx = dx+(dw-zw)/2 + off*dw)
    if style.fit == "cover":
        px = int(round(dx + (dw - zw) / 2 + style.offsetX * dw))
        py = int(round(dy + (dh - zh) / 2 + style.offsetY * dh))
    else:
        fw0, fh0 = _contain_size(sw, sh, dw, dh)
        px = int(round(dx + (dw - fw0) / 2 + (fw0 - zw) / 2 + style.offsetX * dw))
        py = int(round(dy + (dh - fh0) / 2 + (fh0 - zh) / 2 + style.offsetY * dh))

    if style.mirror:
        im = cv2.flip(im, 1)

    # clip against canvas
    x0, y0 = max(0, px), max(0, py)
    x1, y1 = min(W, px + zw), min(H, py + zh)
    if x1 <= x0 or y1 <= y0:
        return
    im = im[y0 - py:y1 - py, x0 - px:x1 - px]
    mask = shape_mask(zw, zh, style.shape, style.radius * k)
    mask = mask[y0 - py:y1 - py, x0 - px:x1 - px]

    alpha = (mask.astype(np.float32) / 255.0) * float(style.opacity)
    if float(style.opacity) >= 0.999 and style.shape == "rect":
        canvas[y0:y1, x0:x1] = im
    else:
        a = alpha[..., None]
        roi = canvas[y0:y1, x0:x1].astype(np.float32)
        canvas[y0:y1, x0:x1] = (roi * (1.0 - a) + im.astype(np.float32) * a
                                ).astype(np.uint8)

    # border (inset stroke, like the browser)
    bw = float(style.border) * k
    if bw >= 0.75:
        b = int(round(bw))
        outer = shape_mask(zw, zh, style.shape, style.radius * k)
        inner = np.zeros_like(outer)
        iw, ih = zw - 2 * b, zh - 2 * b
        if iw > 1 and ih > 1:
            sub = shape_mask(iw, ih, style.shape,
                             max(0.0, style.radius * k - b))
            inner[b:b + ih, b:b + iw] = sub[:ih, :iw]
        ring = cv2.subtract(outer, inner)[y0 - py:y1 - py, x0 - px:x1 - px]
        col = np.array(hex_to_bgr(style.borderColor), np.float32)
        a = (ring.astype(np.float32) / 255.0)[..., None]
        roi = canvas[y0:y1, x0:x1].astype(np.float32)
        canvas[y0:y1, x0:x1] = (roi * (1.0 - a) + col * a).astype(np.uint8)


def render_bg(canvas: np.ndarray, src: Optional[np.ndarray], bg: BackgroundStyle) -> None:
    """Blurred/dimmed full-frame backdrop (mirrors renderScene's backdrop)."""
    H, W = canvas.shape[:2]
    canvas[:] = BASE_COLOR
    if src is None or src.size == 0:
        return
    # cover at bg.scale, then center-crop to the canvas
    sw = max(8, int(round(W * bg.scale)))
    sh = max(8, int(round(H * bg.scale)))
    cov = _cover_resize(src, sw, sh)
    ox, oy = max(0, (sw - W) // 2), max(0, (sh - H) // 2)
    cov = cov[oy:oy + H, ox:ox + W]
    if cov.shape[1] != W or cov.shape[0] != H:
        cov = cv2.resize(cov, (W, H), interpolation=cv2.INTER_LINEAR)

    # downscale -> blur -> upscale (same trick as the browser: cheap big blur)
    ds = 0.34
    small = cv2.resize(cov, (max(8, int(W * ds)), max(8, int(H * ds))),
                       interpolation=cv2.INTER_AREA)
    eff = float(bg.blur) * ds * (H / 1080.0)
    if eff > 0.4:
        ks = max(3, int(round(eff)) * 2 + 1)
        small = cv2.GaussianBlur(small, (ks, ks), 0)
    # saturate 1.15 + dim (browser: brightness(1-dim) saturate(1.15))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.15, 0, 255)
    hsv[..., 2] = np.clip(hsv[..., 2] * (1.0 - float(bg.dim)), 0, 255)
    small = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    big = cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)

    op = float(np.clip(bg.opacity, 0.0, 1.0))
    if op >= 0.999:
        canvas[:] = big
    elif op > 0.001:
        canvas[:] = (canvas.astype(np.float32) * (1.0 - op) +
                     big.astype(np.float32) * op).astype(np.uint8)


# ---------------------------------------------------------------------------
# overlays (card / lead block / speed badge)
# ---------------------------------------------------------------------------

def _fit_text(text: str, max_w: int, font: int, start: float, thick: int):
    scale = start
    while scale > 0.3:
        (tw, _), _ = cv2.getTextSize(text, font, scale, thick)
        if tw <= max_w:
            break
        scale *= 0.9
    return scale


_card_img_cache: Dict[str, Optional[np.ndarray]] = {}


def _load_card_image(spec: str) -> Optional[np.ndarray]:
    """Decode a custom card background (data URL or file path) to BGR.

    Cached: the Patreon compositor calls card_overlay once per frame, and
    re-decoding a base64 photo 30×/s would be silly.
    """
    s = (spec or "").strip()
    if not s:
        return None
    key = s if len(s) < 8192 else hashlib.sha1(
        s.encode("utf-8", "ignore")).hexdigest()
    if key in _card_img_cache:
        return _card_img_cache[key]
    img = None
    try:
        if s.startswith("data:"):
            b64 = s.split(",", 1)[1] if "," in s else ""
            raw = base64.b64decode(b64)
            img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        else:
            p = Path(s)
            if p.is_file() and p.stat().st_size < 20_000_000:
                img = cv2.imread(str(p), cv2.IMREAD_COLOR)
    except Exception:
        img = None
    if img is not None and (img.size == 0 or img.ndim != 3):
        img = None
    if len(_card_img_cache) > 8:
        _card_img_cache.clear()
    _card_img_cache[key] = img
    return img


def card_overlay(card: Optional[Dict[str, Any]], layout: LayoutState,
                 W: int, H: int,
                 content: Optional[Rect] = None) -> Tuple[np.ndarray, int, int]:
    """The placeholder card as a standalone BGRA (RGBA) image.

    Same math the compositor paints inline and the browser preview draws:
    rounded gradient backdrop, accent bar, centred title/sub, accent ring —
    but as its own image, so the ffmpeg passthrough (whose filter graph has
    no cv2, and on many builds no drawtext either) can composite the exact
    card the Patreon render shows, with `overlay`, instead of approximating
    it with drawbox/drawtext.

    Returns (bgra, x0, y0); the array is empty when the rect is degenerate.

    When the card carries a custom image, the photo is the background
    (cover-fit, clipped to the card shape) and the text is drawn over a
    gentle dim — unless showText is off, which yields a photo-only card.

    A "short" card (card["variant"]) covers only the top shortHeight of the
    content rect, so subtitles at the bottom stay visible.

    *content* overrides which rect the card covers (the compositor passes the
    drawn content picture, the ffmpeg passthrough the content rect of the
    finished file); without it the layout's content rect is used.

    opacity is exact and applies to the whole card — backdrop, accent bar,
    words and ring — so 100% is fully opaque and 0% draws nothing at all.
    """
    k = H / 1080.0
    card = card or {}   # a card span with no text of its own is normal
    # per-segment override; empty fields inherit the global card
    def pick(v) -> Optional[str]:
        s = str(v).strip() if v is not None else ""
        return s or None
    title = pick(card.get("title")) or layout.card.title
    sub = pick(card.get("sub")) or layout.card.sub
    accent = pick(card.get("accent")) or layout.card.accent
    img_spec = pick(card.get("image")) or getattr(layout.card, "image", "") or ""
    show_text = card.get("showText", getattr(layout.card, "showText", True))
    show_text = False if show_text is False else True
    variant = str(card.get("variant") or "full").strip().lower()
    # explicit 0 must survive: an `or 0.9` fallback here used to resurrect a
    # card the user had turned off
    _sh = getattr(layout.card, "shortHeight", 0.75)
    short_h = max(0.2, min(1.0, 0.75 if _sh is None else float(_sh)))
    _op = getattr(layout.card, "opacity", 0.9)
    opacity = max(0.0, min(1.0, 0.9 if _op is None else float(_op)))
    if opacity <= 0.001:
        # 0 % means no card — not a 5 % ghost of one
        return np.zeros((0, 0, 4), np.uint8), 0, 0
    r = content if content is not None else layout.content
    x, y, w, h = (int(round(v)) for v in r.px(W, H))
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if variant == "short":
        # top-anchored: the bottom of the content (subtitles) stays visible
        y1 = min(y1, y0 + max(8, int(round((y1 - y0) * short_h))))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return np.zeros((0, 0, 4), np.uint8), x0, y0
    fw, fh = x1 - x0, y1 - y0
    # Use same radius/shape as content layer so card fully covers content (no corner gaps)
    content_radius = float(getattr(layout.contentStyle, "radius", 10.0))
    content_shape = getattr(layout.contentStyle, "shape", "rounded")
    if content_shape == "rect":
        radius = 0.0
    else:
        radius = min(content_radius * k, min(fw, fh) / 2.0)
    mask = shape_mask(fw, fh, content_shape, radius)

    # Colour and alpha are built separately and only joined at the end:
    # cv2's anti-aliased drawing rewrites the 4th channel of a BGRA image
    # (glyph edges punch alpha holes), which would make the text vanish
    # once the overlay is composited. Drawing into a plain BGR layer is the
    # same math draw_card always did onto the canvas.
    bg_img = _load_card_image(img_spec)
    if bg_img is not None:
        rgb = _cover_resize(bg_img, fw, fh)
        if show_text:
            # same gentle dim the browser draws so the headline stays readable
            rgb = (rgb.astype(np.float32) * 0.55 + 2.0).astype(np.uint8)
    else:
        top = np.array((26, 15, 11), np.float32)   # #0b0f1a
        bot = np.array((12, 6, 4), np.float32)     # #04060c
        t = np.linspace(0, 1, fh, dtype=np.float32)[:, None, None]
        grad = (top * (1 - t) + bot * t).astype(np.uint8)
        rgb = np.repeat(grad, fw, axis=1)

    accent_bgr = hex_to_bgr(accent)
    if bg_img is not None and not show_text:
        photo_only = True
    else:
        photo_only = False
    # bar + glyphs painted white-on-black: this mask stays fully opaque so
    # the words stay crisp while the backdrop turns translucent
    fg = np.zeros((fh, fw), np.uint8)
    if not photo_only:
        # accent bar
        bx, by = int(fw * 0.16), int(fh * 0.34)
        bar = ((bx, by), (int(fw * 0.84), int(by + max(2, 4 * k))))
        cv2.rectangle(rgb, bar[0], bar[1], accent_bgr, -1)
        cv2.rectangle(fg, bar[0], bar[1], 255, -1)
        # title + sub, centered
        font = cv2.FONT_HERSHEY_DUPLEX
        size = max(0.4, min(2.2 * k, (fw * 0.072) / 20.0))
        size = _fit_text(title, int(fw * 0.88), font, size, 2)
        (tw, th), _ = cv2.getTextSize(title, font, size, 2)
        torg = (int((fw - tw) / 2), int(fh * 0.47 + th / 2))
        cv2.putText(rgb, title, torg, font, size, (241, 245, 249), 2, cv2.LINE_AA)
        cv2.putText(fg, title, torg, font, size, 255, 2, cv2.LINE_AA)
        s2 = _fit_text(sub, int(fw * 0.88),
                       cv2.FONT_HERSHEY_SIMPLEX, size * 0.62, 1)
        (tw2, th2), _ = cv2.getTextSize(sub, cv2.FONT_HERSHEY_SIMPLEX, s2, 1)
        sorg = (int((fw - tw2) / 2), int(fh * 0.58 + th2 / 2))
        cv2.putText(rgb, sub, sorg, cv2.FONT_HERSHEY_SIMPLEX, s2,
                    (200, 210, 225), 1, cv2.LINE_AA)
        cv2.putText(fg, sub, sorg, cv2.FONT_HERSHEY_SIMPLEX, s2, 255, 1,
                    cv2.LINE_AA)
    # accent ring (2*k px inset stroke at 50%, like draw_card always drew)
    outer = shape_mask(fw, fh, content_shape, radius)
    inner = np.zeros_like(outer)
    b = max(1, int(round(2 * k)))
    if fw - 2 * b > 2 and fh - 2 * b > 2:
        ring_in = shape_mask(fw - 2 * b, fh - 2 * b, content_shape,
                             max(0.0, radius - b))
        inner[b:b + fh - 2 * b, b:b + fw - 2 * b] = ring_in
    ring = cv2.subtract(outer, inner).astype(np.float32) / 255.0 * 0.5
    rgb = (rgb.astype(np.float32) * (1 - ring[..., None]) +
           np.array(accent_bgr, np.float32) * ring[..., None]).astype(np.uint8)
    # one alpha for the whole card: exact opacity (fg no longer forced to
    # 255, which used to make 100 % mean "opaque everywhere" and any value
    # below it still look nearly solid)
    alpha = (mask.astype(np.float32) * opacity).astype(np.uint8)
    return np.dstack([rgb, alpha]), x0, y0


def draw_card(canvas: np.ndarray, layout: LayoutState,
              card: Optional[Dict[str, Any]] = None,
              content: Optional[Rect] = None) -> None:
    """Composite the placeholder card onto *canvas* at *content* (or the
    layout's content rect)."""
    H, W = canvas.shape[:2]
    img, x0, y0 = card_overlay(card, layout, W, H, content)
    if img.size == 0:
        return
    fh, fw = img.shape[:2]
    a = (img[..., 3].astype(np.float32) / 255.0)[..., None]
    roi = canvas[y0:y0 + fh, x0:x0 + fw].astype(np.float32)
    canvas[y0:y0 + fh, x0:x0 + fw] = (
        roi * (1 - a) + img[..., :3].astype(np.float32) * a).astype(np.uint8)


def vignette_overlay(W: int, H: int, amount: float) -> np.ndarray:
    """Edge darkening as a BGRA image — the exact stops render.ts fills:
    a radial gradient, transparent at min(W,H)*0.36, black at
    amount/100*0.55 alpha by max(W,H)*0.72. ffmpeg's own `vignette` filter
    is a different curve (and at the angles this used to pass, everything
    but the frame centre went black), so the passthrough composites this
    instead and the export matches the preview pixel for pixel.
    """
    a_edge = max(0.0, min(1.0, float(amount) / 100.0)) * 0.55
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt((xx - W / 2.0) ** 2 + (yy - H / 2.0) ** 2)
    r0, r1 = min(W, H) * 0.36, max(W, H) * 0.72
    t = np.clip((d - r0) / max(1e-6, r1 - r0), 0.0, 1.0)
    img = np.zeros((H, W, 4), np.uint8)
    img[..., 3] = (t * a_edge * 255.0 + 0.5).astype(np.uint8)
    return img


def write_png(path, bgra: np.ndarray) -> str:
    """Save a BGRA overlay as a PNG ffmpeg can read as an alpha input."""
    cv2.imwrite(str(path), bgra)
    return str(path)


def draw_lead_block(canvas: np.ndarray, layout: LayoutState) -> None:
    H, W = canvas.shape[:2]
    k = H / 1080.0
    x, y, w, h = (int(round(v)) for v in layout.content.px(W, H))
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    st = layout.contentStyle
    mask = shape_mask(x1 - x0, y1 - y0, st.shape, st.radius * k)
    a = (mask.astype(np.float32) / 255.0)[..., None]
    roi = canvas[y0:y1, x0:x1].astype(np.float32)
    canvas[y0:y1, x0:x1] = (roi * (1 - a)).astype(np.uint8)  # pure black block


def draw_speed_badge(canvas: np.ndarray, speed: float) -> None:
    H, W = canvas.shape[:2]
    k = H / 1080.0
    label = f"{int(speed) if float(speed) % 1 == 0 else round(speed, 1)}x >>"
    font = cv2.FONT_HERSHEY_SIMPLEX
    sc = max(0.5, 0.9 * k)
    (tw, th), _ = cv2.getTextSize(label, font, sc, 2)
    bw, bh = int(tw + 22 * k), int(34 * k)
    x, y = W - bw - int(18 * k), H - bh - int(18 * k)
    pill = shape_mask(bw, bh, "pill", 0)
    teal = np.zeros((bh, bw, 3), np.uint8)
    teal[:] = (136, 148, 13)  # ~ #0d9488
    a = (pill.astype(np.float32) / 255.0 * 0.9)[..., None]
    roi = canvas[y:y + bh, x:x + bw].astype(np.float32)
    canvas[y:y + bh, x:x + bw] = (roi * (1 - a) +
                                  teal.astype(np.float32) * a).astype(np.uint8)
    cv2.putText(canvas, label, (int(x + (bw - tw) / 2), int(y + (bh + th) / 2 - 2 * k)),
                font, sc, (255, 254, 236), 2, cv2.LINE_AA)


# ---------------------------------------------------------------------------
# scene
# ---------------------------------------------------------------------------

def split_sources(frame: np.ndarray, layout: LayoutState):
    """Return (cam, content, full) views of a source frame."""
    h, w = frame.shape[:2]
    if layout.sourceMode == "single" or w < 16:
        return frame, frame, frame
    mid = w // 2
    left, right = frame[:, :mid], frame[:, mid:]
    if layout.cameraSide == "left":
        return left, right, frame
    return right, left, frame


def compose_frame(frame: np.ndarray, layout: LayoutState,
                  mode: str = "body", W: int = 1920, H: int = 1080,
                  cam_hook: Optional[Callable[[np.ndarray], np.ndarray]] = None,
                  card: Optional[Dict[str, Any]] = None) -> np.ndarray:
    """Compose one output frame. *mode* is solo|body|cut|fast|card|lead."""
    canvas = np.zeros((H, W, 3), np.uint8)
    canvas[:] = BASE_COLOR
    if mode == "cut":
        return canvas
    cam, content, full = split_sources(frame, layout)
    if cam_hook is not None and mode != "cut":
        try:
            cam = cam_hook(cam)
        except Exception:
            pass
    bg_src = {"content": content, "camera": cam}.get(layout.bg.source, full)
    render_bg(canvas, bg_src, layout.bg)

    if mode == "solo":
        draw_layer(canvas, cam, Rect(0, 0, 1, 1), layout.soloStyle)
    elif mode == "card":
        # placeholder first, camera on top: the card covers the content 100%
        # yet can never touch the camera, even when the rects overlap.
        # The card is pinned to where the content *picture* lands (fit/zoom/
        # offset), so it can't spill onto the letterbox padding around it.
        if content is not None and getattr(content, "size", 0):
            ch_, cw_ = content.shape[:2]
            picture = content_picture_rect(layout, cw_, ch_, W, H)
        else:
            picture = None
        draw_card(canvas, layout, card, picture)
        draw_layer(canvas, cam, layout.cam, layout.camStyle)
    elif mode == "lead":
        draw_layer(canvas, cam, layout.cam, layout.camStyle)
        draw_lead_block(canvas, layout)
    else:  # body / fast
        if not layout.contentHidden:
            draw_layer(canvas, content, layout.content, layout.contentStyle)
        draw_layer(canvas, cam, layout.cam, layout.camStyle)
        if mode == "fast":
            draw_speed_badge(canvas, layout.fastSpeed)
    return canvas


# ---------------------------------------------------------------------------
# probing + fast single-frame extraction (powers the live preview)
# ---------------------------------------------------------------------------

_cap_cache: Dict[str, Any] = {}


def probe_video(path: str) -> Dict[str, Any]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise FileNotFoundError(f"cannot open video: {path}")
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    dur = n / fps if fps and n else 0.0
    return {"width": w, "height": h, "fps": fps,
            "frames": n, "duration": dur, "path": str(path)}


def extract_frame(path: str, t: float) -> Optional[np.ndarray]:
    """Grab one frame near *t* seconds (cached capture for scrubbing)."""
    key = str(path)
    cap = _cap_cache.get(key)
    if cap is None:
        cap = cv2.VideoCapture(key)
        if not cap.isOpened():
            return None
        _cap_cache[key] = cap
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(t)) * 1000.0)
    ok, frame = cap.read()
    if not ok:
        # retry once from the start (some files seek poorly from cache)
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(t)) * 1000.0)
        ok, frame = cap.read()
    return frame if ok else None


def invalidate_cache(path: Optional[str] = None) -> None:
    if path is None:
        for c in _cap_cache.values():
            try:
                c.release()
            except Exception:
                pass
        _cap_cache.clear()
    else:
        c = _cap_cache.pop(str(path), None)
        if c is not None:
            try:
                c.release()
            except Exception:
                pass


def preview(path: str, t: float, layout: Optional[LayoutState] = None,
            mode: str = "body", width: int = 960,
            cam_hook=None) -> Optional[np.ndarray]:
    """Compose a small preview frame — what the GUI shows on every tweak."""
    layout = layout or default_layout()
    frame = extract_frame(path, t)
    if frame is None:
        return None
    W = int(width)
    H = int(round(width * 9 / 16))
    return compose_frame(frame, layout, mode=mode, W=W, H=H, cam_hook=cam_hook)


def to_jpeg(img: np.ndarray, quality: int = 72) -> bytes:
    ok, buf = cv2.imencode(".jpg", img,
                           [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buf.tobytes()


# ---------------------------------------------------------------------------
# timeline helpers
# ---------------------------------------------------------------------------

Segment = Dict[str, Any]  # {type, start, end}


def build_segments(duration: float, intro_end: float = 8.0,
                   outro_start: Optional[float] = None,
                   drops: Optional[List[Tuple[float, float]]] = None,
                   claims: Optional[List[Tuple[float, float, str]]] = None,
                   lead_in: float = 0.0, black: float = 0.0) -> List[Segment]:
    """Build a normalised segment list (mirrors the browser timeline).

    *drops* are (start, end) spans removed entirely (silences, disruptions).
    *claims* are (start, end, action) with action in {cut, mute}.
    """
    duration = max(0.5, float(duration))
    ie = float(np.clip(intro_end, 0, duration))
    os_ = duration + float(outro_start) if outro_start is not None and float(outro_start) <= 0 \
        else (float(outro_start) if outro_start is not None else duration)
    os_ = float(np.clip(os_, ie, duration))

    cuts: List[Tuple[float, float]] = list(drops or [])
    mutes: List[Tuple[float, float]] = []
    for s, e, a in (claims or []):
        (cuts if a == "cut" else mutes).append((float(s), float(e)))

    # base spans with their scene types
    spans: List[Tuple[float, float, str]] = []
    if ie > 0:
        spans.append((0.0, ie, "intro"))
    body_s, body_e = ie, os_
    if lead_in > 0 and black > 0 and body_e - body_s > lead_in + black + 1:
        # lead-in block: black content for `black` s at the reaction start
        spans.append((body_s, body_s + black, "lead"))
        spans.append((body_s + black, body_e, "body"))
    elif body_e > body_s:
        spans.append((body_s, body_e, "body"))
    if os_ < duration:
        spans.append((os_, duration, "outro"))

    # carve cuts/mutes out of the spans
    def carve(spans, s, e, typ):
        out = []
        for a, b, t in spans:
            if e <= a or s >= b:
                out.append((a, b, t))
                continue
            if s > a:
                out.append((a, min(s, b), t))
            out.append((max(s, a), min(e, b), typ))
            if e < b:
                out.append((max(e, a), b, t))
        return out

    for s, e in cuts:
        spans = carve(spans, s, e, "cut")
    for s, e in mutes:
        # mute only applies to body-ish spans (intro/outro already mute content)
        spans = carve(spans, s, e, "mute")
    # merge neighbours of the same type
    spans.sort()
    merged: List[Segment] = []
    for a, b, t in spans:
        if b - a < 1e-3:
            continue
        if merged and merged[-1]["type"] == t and abs(merged[-1]["end"] - a) < 1e-3:
            merged[-1]["end"] = b
        else:
            merged.append({"type": t, "start": a, "end": b})
    return merged


def render_duration(segments: List[Segment], fast_speed: float = 4.0) -> float:
    """Programme seconds — every segment divided by its own playback speed.

    Mirrors outDuration()/segSpeed() in src/lib/timeline.ts: fast spans use
    fastSpeed, a card may carry its own speed, everything else is 1x.
    """
    total = 0.0
    for s in segments:
        if s["type"] == "cut":
            continue
        ln = s["end"] - s["start"]
        total += ln / max(1e-6, seg_speed(s, fast_speed))
    return total


# ---------------------------------------------------------------------------
# full render (same compositor => preview == output)
# ---------------------------------------------------------------------------

def _has_nvenc() -> bool:
    if not has_ffmpeg():
        return False
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                             capture_output=True, text=True, check=False)
        txt = (out.stdout or "") + (out.stderr or "")
        return "h264_nvenc" in txt
    except Exception:
        return False


def _open_writer(path: str, W: int, H: int, fps: float,
                 crf: int = 23, preset: str = "fast"):
    """Prefer an ffmpeg rawvideo pipe; fall back to cv2.VideoWriter.

    If a T4 GPU is present (h264_nvenc encoder exists), use it — ~5-10x
    faster than libx264 and actually fills the GPU RAM Colab warns about.
    """
    if has_ffmpeg():
        use_nvenc = _has_nvenc()
        if use_nvenc:
            # nvenc: p4 ~ medium, vbr_hq + cq = quality-controlled VBR
            cmd = ["ffmpeg", "-y", "-v", "error",
                   "-f", "rawvideo", "-pix_fmt", "bgr24",
                   "-s", f"{W}x{H}", "-r", f"{fps:.3f}", "-i", "-",
                   "-an", "-c:v", "h264_nvenc", "-preset", "p4",
                   "-rc", "vbr_hq", "-cq", str(int(crf)), "-b:v", "0", "-maxrate", "8M", "-bufsize", "16M",
                   "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart", str(path)]
        else:
            cmd = ["ffmpeg", "-y", "-v", "error",
                   "-f", "rawvideo", "-pix_fmt", "bgr24",
                   "-s", f"{W}x{H}", "-r", f"{fps:.3f}", "-i", "-",
                   "-an", "-c:v", "libx264", "-preset", preset,
                   "-crf", str(int(crf)), "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart", str(path)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        return ("pipe", proc)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    vw = cv2.VideoWriter(str(path), fourcc, fps, (W, H))
    if not vw.isOpened():
        raise RuntimeError(f"cannot open writer for {path}")
    return ("cv2", vw)


def render_video(input_path: str, output_path: str,
                 layout: Optional[LayoutState] = None,
                 segments: Optional[List[Segment]] = None,
                 fps: Optional[float] = None,
                 crf: int = 23, preset: str = "fast",
                 width: int = 1920, height: int = 1080,
                 progress_cb: Optional[Callable[[int, int], None]] = None,
                 cancel_check: Optional[Callable[[], bool]] = None,
                 cam_hook=None) -> Dict[str, Any]:
    """Render the full programme through compose_frame().

    Returns {path, frames, fps, duration}. Audio is NOT included here —
    mux it afterwards (see video_processor.mix_and_mux) so the same
    segment map can conform both streams.

    *cancel_check* is polled per frame; when it returns True the render
    aborts by raising RenderCancelled (the writer is closed first).
    """
    layout = layout or default_layout()
    info = probe_video(input_path)
    fps = float(fps or info["fps"] or 30.0)
    duration = info["duration"] or 0.0
    if segments is None:
        segments = [{"type": "body", "start": 0.0, "end": duration}]
    segments = sorted(segments, key=lambda s: s["start"])

    # output frame -> (source time, mode, per-segment card text)
    plan: List[Tuple[float, str, Optional[Dict[str, Any]]]] = []
    for s in segments:
        typ = s.get("type", "body")
        if typ == "cut":
            continue
        # per-segment speed: fast spans AND cards that carry their own speed
        factor = seg_speed({"type": typ, "card": s.get("card")},
                           layout.fastSpeed)
        n = max(1, int(round((s["end"] - s["start"]) * fps / factor)))
        mode = {"intro": "solo", "outro": "solo", "mute": "body"}.get(typ, typ)
        seg_card = s.get("card") if typ == "card" else None
        for i in range(n):
            plan.append((s["start"] + (i + 0.5) * factor / fps, mode, seg_card))
    total = len(plan)
    if total == 0:
        raise ValueError("nothing to render — all segments are cut?")

    W, H = int(width), int(height)
    kind, writer = _open_writer(output_path, W, H, fps, crf, preset)
    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise FileNotFoundError(input_path)

    src_fps = info["fps"] or fps
    cur_t = -1.0
    frame = None
    cancelled = False
    try:
        for idx, (st, mode, seg_card) in enumerate(plan):
            if cancel_check is not None and cancel_check():
                cancelled = True
                break
            # sequential read: advance until we pass the wanted timestamp
            if st < cur_t - 1e-3:
                cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, st) * 1000.0)
                cur_t = st
            while True:
                pos = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                if pos >= st - 0.5 / src_fps or pos < cur_t - 1.0:
                    break
                ok, f = cap.read()
                if not ok:
                    break
                frame, cur_t = f, pos
                if cur_t >= st - 0.5 / src_fps:
                    break
            if frame is None:
                ok, f = cap.read()
                if ok:
                    frame = f
            if frame is None:
                break
            out = compose_frame(frame, layout, mode=mode, W=W, H=H,
                                cam_hook=cam_hook, card=seg_card)
            if kind == "pipe":
                try:
                    writer.stdin.write(out.tobytes())
                except BrokenPipeError:
                    break
            else:
                writer.write(out)
            if progress_cb and (idx % 30 == 0 or idx == total - 1):
                progress_cb(idx + 1, total)
    finally:
        cap.release()
        if kind == "pipe":
            try:
                writer.stdin.close()
            except Exception:
                pass
            writer.wait()
        else:
            writer.release()

    if cancelled:
        # don't leave a half-written output file behind
        try:
            Path(output_path).unlink(missing_ok=True)
        except OSError:
            pass
        raise RenderCancelled("render cancelled by user")

    out_dur = total / fps
    return {"path": str(output_path), "frames": total, "fps": fps,
            "duration": out_dur}
