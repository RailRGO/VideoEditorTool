"""
Interactive visual editor for the Colab pipeline (ipywidgets).

Instead of guessing parameters in a single cell, you get sliders for every
layout / retouch / cut / audio parameter with a LIVE preview that updates
on every tweak — rendered by the same compositor as the final file, so the
preview IS the output (WYSIWYG). A 10-second sample render proves it with
motion + mixed audio before you commit to a full 20-minute render.

Usage (in the notebook):
    from editor_gui import launch_editor
    editor = launch_editor(proc)

Then use the Render tab, or from a later cell:
    proc.run_youtube_version(layout=editor.layout)   # uses your tuned layout
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import layouts as L
    import compose as C
except ImportError:
    from . import layouts as L
    from . import compose as C

try:
    import ipywidgets as widgets
    from IPython.display import Audio, Image as IPImage, Video, display
    _WIDGETS = True
except ImportError:
    widgets = None  # type: ignore
    _WIDGETS = False


def _need_widgets():
    if not _WIDGETS:
        raise ImportError(
            "ipywidgets is not installed. In Colab run:\n"
            "  !pip install -q ipywidgets\n"
            "then Runtime -> Restart session and re-run.")


def parse_claims(text: str, duration: float) -> List[Tuple[float, float, str]]:
    """Parse claim lines: '02:14 - 03:40 cut Some label' / '131-220 mute'."""
    def ts(s: str) -> Optional[float]:
        s = s.strip()
        if re.fullmatch(r"\d+(\.\d+)?", s):
            return float(s)
        parts = s.split(":")
        try:
            nums = [float(p) for p in parts]
        except ValueError:
            return None
        mul = 1.0
        total = 0.0
        for n in reversed(nums):
            total += n * mul
            mul *= 60
        return total

    claims = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(
            r"(?P<a>[\d:.]+)\s*(?:-|to|–|—)\s*(?P<b>[\d:.]+)\s*(?P<rest>.*)$",
            line, re.IGNORECASE)
        if not m:
            continue
        a, b = ts(m.group("a")), ts(m.group("b"))
        if a is None or b is None:
            continue
        rest = m.group("rest").strip().lower()
        action = "cut" if rest.startswith("cut") else (
            "mute" if rest.startswith("mute") else "cut")
        a = max(0.0, min(a, duration))
        b = max(0.0, min(b, duration))
        if b - a > 0.2:
            claims.append((a, b, action))
    return claims


def fmt_time(s: float) -> str:
    s = max(0, float(s))
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


# ===========================================================================
class ReactionEditor:
    """The full visual editor. Create via launch_editor(proc)."""

    def __init__(self, proc, preview_width: int = 854):
        _need_widgets()
        self.proc = proc
        self.layout: L.LayoutState = proc.layout
        self.t = min(30.0, (proc.duration / 2) if proc.duration else 5.0)
        self.mode = "body"
        self.preview_width = preview_width
        self.drops: List[Tuple[float, float]] = []
        self.claims: List[Tuple[float, float, str]] = []
        self._timer: Optional[threading.Timer] = None
        self._building = True

        self._build_widgets()
        self._building = False
        self.refresh()

    # ------------------------------------------------------------- building
    def _slider(self, desc, vmin, vmax, step, get, set_, width="340px",
                fmt="{:.2f}", live=True):
        w = widgets.FloatSlider(value=float(get()), min=vmin, max=vmax,
                                step=step, description=desc,
                                continuous_update=live,
                                layout=widgets.Layout(width=width),
                                readout_format=".3f" if step < 0.01 else ".2f")
        lbl = widgets.Label(value=fmt.format(float(get())),
                            layout=widgets.Layout(width="64px"))

        def on_change(ch):
            set_(float(ch["new"]))
            lbl.value = fmt.format(float(ch["new"]))
            self.refresh_soon()

        w.observe(on_change, "value")
        box = widgets.HBox([w, lbl])
        # keep a handle so preset-apply can push values back into widgets
        box._slider, box._label, box._get, box._fmt = w, lbl, get, fmt  # type: ignore
        self._binds.append(box)
        return box

    def _sync_widgets(self):
        """Push current layout values back into all sliders (after preset)."""
        self._building = True
        try:
            for box in self._binds:
                v = float(box._get())
                box._slider.unobserve_all()
                box._slider.value = v
                box._label.value = box._fmt.format(v)
                # re-arm: observe again via stored closure is tricky; instead
                # rebuild observation by triggering refresh wiring below
                def _mk(b):
                    def on_change(ch, b=b):
                        # find matching setter through layout path is complex;
                        # sliders are re-created on preset apply instead
                        pass
                    return on_change
        finally:
            self._building = False

    def _build_widgets(self):
        self._binds: List[Any] = []
        dur = max(1.0, self.proc.duration)

        # ---- shared preview ------------------------------------------------
        self.img = widgets.Image(format="jpg", width=self.preview_width)
        self.info_lbl = widgets.HTML()
        self.warn_lbl = widgets.HTML()
        self.time_slider = widgets.FloatSlider(
            value=self.t, min=0, max=dur, step=0.5, description="Time (s)",
            continuous_update=False, layout=widgets.Layout(width="420px"))
        self.time_slider.observe(self._on_time, "value")
        self.mode_dd = widgets.Dropdown(
            options=[("Reaction (body)", "body"), ("Intro/Outro (solo)", "solo"),
                     ("Card", "card"), ("Lead-in (black block)", "lead"),
                     ("Fast-forward look", "fast")],
            value="body", description="Scene:")
        self.mode_dd.observe(self._on_mode, "value")
        self.pw_dd = widgets.Dropdown(options=[640, 854, 960, 1280],
                                      value=self.preview_width,
                                      description="Preview px:")
        self.pw_dd.observe(self._on_pw, "value")
        step_bar = widgets.HBox([
            widgets.Button(description="−5s", layout=widgets.Layout(width="52px")),
            widgets.Button(description="−1s", layout=widgets.Layout(width="52px")),
            widgets.Button(description="+1s", layout=widgets.Layout(width="52px")),
            widgets.Button(description="+5s", layout=widgets.Layout(width="52px")),
        ])
        for b, d in zip(step_bar.children, (-5, -1, 1, 5)):
            b.on_click(lambda _, d=d: self._nudge(d))
        self.sheet_btn = widgets.Button(description="Contact sheet (4 frames)")
        self.sheet_btn.on_click(lambda _: self._contact_sheet())
        self.sheet_out = widgets.Output()

        preview_tab = widgets.VBox([
            self.img, self.info_lbl, self.warn_lbl,
            widgets.HBox([self.time_slider, self.mode_dd]),
            widgets.HBox([step_bar, self.pw_dd, self.sheet_btn]),
            self.sheet_out,
        ])

        # ---- layout --------------------------------------------------------
        lay = self.layout
        preset_names = [(f"{p.name} — {p.hint}", p.id) for p in L.LAYOUT_PRESETS]
        self.preset_dd = widgets.Dropdown(options=preset_names, value="tl-br",
                                          description="Preset:",
                                          layout=widgets.Layout(width="340px"))
        apply_preset = widgets.Button(description="Apply preset",
                                      button_style="primary")
        apply_preset.on_click(lambda _: self._apply_preset())

        def rect_sliders(title, get_rect):
            items = [widgets.HTML(f"<b>{title}</b>")]
            for key, label in (("x", "X"), ("y", "Y"), ("w", "Width"), ("h", "Height")):
                items.append(self._slider(
                    label, 0.0, 1.0, 0.005,
                    lambda k=key: getattr(get_rect(), k),
                    lambda v, k=key: setattr(get_rect(), k, v),
                    fmt="{:.1%}"))
            return widgets.VBox(items)

        def style_sliders(title, get_style, with_shape=True):
            items = [widgets.HTML(f"<b>{title}</b>")]
            st = get_style()
            if with_shape:
                dd = widgets.Dropdown(options=["rect", "rounded", "circle", "pill"],
                                      value=st.shape, description="Shape:")
                dd.observe(lambda ch: (setattr(get_style(), "shape", ch["new"]),
                                       self.refresh_soon()), "value")
                fit = widgets.Dropdown(options=["contain", "cover"],
                                       value=st.fit, description="Fit:")
                fit.observe(lambda ch: (setattr(get_style(), "fit", ch["new"]),
                                        self.refresh_soon()), "value")
                mir = widgets.Checkbox(value=st.mirror, description="Mirror")
                mir.observe(lambda ch: (setattr(get_style(), "mirror", ch["new"]),
                                        self.refresh_soon()), "value")
                items += [widgets.HBox([dd, fit, mir])]
            items += [
                self._slider("Radius", 0, 60, 1,
                             lambda: get_style().radius,
                             lambda v: setattr(get_style(), "radius", v), fmt="{:.0f}px"),
                self._slider("Border", 0, 12, 1,
                             lambda: get_style().border,
                             lambda v: setattr(get_style(), "border", v), fmt="{:.0f}px"),
                self._slider("Zoom", 1, 2, 0.01,
                             lambda: get_style().zoom,
                             lambda v: setattr(get_style(), "zoom", v), fmt="{:.2f}×"),
                self._slider("Opacity", 0.1, 1, 0.01,
                             lambda: get_style().opacity,
                             lambda v: setattr(get_style(), "opacity", v), fmt="{:.0%}"),
                self._slider("Offset X", -0.5, 0.5, 0.005,
                             lambda: get_style().offsetX,
                             lambda v: setattr(get_style(), "offsetX", v)),
                self._slider("Offset Y", -0.5, 0.5, 0.005,
                             lambda: get_style().offsetY,
                             lambda v: setattr(get_style(), "offsetY", v)),
            ]
            return widgets.VBox(items)

        bg_src = widgets.Dropdown(options=["full", "content", "camera"],
                                  value=lay.bg.source, description="BG src:")
        bg_src.observe(lambda ch: (setattr(lay.bg, "source", ch["new"]),
                                   self.refresh_soon()), "value")
        bg_box = widgets.VBox([
            widgets.HTML("<b>Background plate</b>"), bg_src,
            self._slider("Blur", 0, 120, 1, lambda: lay.bg.blur,
                         lambda v: setattr(lay.bg, "blur", v), fmt="{:.0f}px"),
            self._slider("Opacity", 0, 1, 0.01, lambda: lay.bg.opacity,
                         lambda v: setattr(lay.bg, "opacity", v), fmt="{:.0%}"),
            self._slider("Scale", 1, 1.4, 0.01, lambda: lay.bg.scale,
                         lambda v: setattr(lay.bg, "scale", v), fmt="{:.2f}×"),
            self._slider("Dim", 0, 0.8, 0.01, lambda: lay.bg.dim,
                         lambda v: setattr(lay.bg, "dim", v), fmt="{:.0%}"),
        ])

        hide_content = widgets.Checkbox(value=lay.contentHidden,
                                        description="Hide sharp content (face + blur only)")
        hide_content.observe(lambda ch: (setattr(lay, "contentHidden", ch["new"]),
                                         self.refresh_soon()), "value")
        mute_solo = widgets.Checkbox(value=lay.muteContentInSolo,
                                     description="Mute content audio in intro/outro")
        mute_solo.observe(lambda ch: (setattr(lay, "muteContentInSolo", ch["new"]),
                                      self.refresh_soon()), "value")
        cam_side = widgets.Dropdown(options=["left", "right"],
                                    value=lay.cameraSide, description="Cam half:")
        cam_side.observe(lambda ch: (setattr(lay, "cameraSide", ch["new"]),
                                     self.refresh_soon()), "value")
        src_mode = widgets.Dropdown(options=["split", "single"],
                                    value=lay.sourceMode, description="Source:")
        src_mode.observe(lambda ch: (setattr(lay, "sourceMode", ch["new"]),
                                     self.refresh_soon()), "value")
        # keep handles so preset-apply can update them
        self._hide_content, self._cam_side = hide_content, cam_side
        self._shape_boxes: List[Tuple[Any, Any]] = []

        solo_box = widgets.VBox([
            widgets.HTML("<b>Intro / outro full-cam</b>"),
            self._slider("Scale", 1, 1.6, 0.01, lambda: lay.soloStyle.zoom,
                         lambda v: setattr(lay.soloStyle, "zoom", v), fmt="{:.2f}×"),
        ])

        # ---- card ----------------------------------------------------------
        def card_text(desc, key, placeholder=""):
            w = widgets.Text(value=str(getattr(lay.card, key, "") or ""),
                             description=desc, placeholder=placeholder,
                             layout=widgets.Layout(width="340px"))

            def on_change(ch):
                setattr(lay.card, key, str(ch["new"]))
                self.refresh_soon()

            w.observe(on_change, "value")
            return w

        card_show = widgets.Checkbox(value=bool(getattr(lay.card, "showText", True)),
                                     description="Draw title + subtitle")
        card_show.observe(lambda ch: (setattr(lay.card, "showText", bool(ch["new"])),
                                      self.refresh_soon()), "value")
        card_box = widgets.VBox([
            widgets.HTML("<b>Card (Patreon placeholder)</b>"),
            # 0 % hides the card completely, 100 % is fully opaque
            self._slider("Opacity", 0.0, 1.0, 0.01,
                         lambda: getattr(lay.card, "opacity", 0.9),
                         lambda v: setattr(lay.card, "opacity", v), fmt="{:.0%}"),
            self._slider("Short height", 0.3, 1.0, 0.01,
                         lambda: getattr(lay.card, "shortHeight", 0.75),
                         lambda v: setattr(lay.card, "shortHeight", v), fmt="{:.0%}"),
            card_text("Title", "title", "Full uncut reaction on Patreon"),
            card_text("Sub", "sub", "link in the description"),
            card_text("Accent", "accent", "#e879f9"),
            card_text("Image", "image", "custom background URL"),
            card_show,
            widgets.HTML("<i>Short cards cover the top of the content only "
                         "(subtitles stay visible). The card is pinned to the "
                         "content picture — fit/zoom/offset included.</i>"),
        ])

        layout_tab = widgets.VBox([
            widgets.HBox([self.preset_dd, apply_preset]),
            widgets.HTML("<i>Tip: drag any slider and watch the Preview tab — "
                         "it renders the exact output pixels.</i>"),
            widgets.HBox([rect_sliders("Camera rect", lambda: lay.cam),
                          rect_sliders("Content rect", lambda: lay.content)]),
            widgets.HBox([style_sliders("Camera style", lambda: lay.camStyle),
                          style_sliders("Content style", lambda: lay.contentStyle)]),
            widgets.HBox([bg_box, widgets.VBox([solo_box, hide_content,
                                                 mute_solo, cam_side, src_mode])]),
            card_box,
        ])

        # ---- retouch -------------------------------------------------------
        rc = self.proc.retouch_cfg
        self.rt_on = widgets.Checkbox(value=bool(rc.get("enabled")),
                                      description="Enable face retouch (preview + render)")
        self.rt_on.observe(lambda ch: (rc.__setitem__("enabled", ch["new"]),
                                       self.refresh_soon()), "value")
        self.rt_msg = widgets.HTML()
        # NOTE: retouch_cfg is initialised with the browser-parity keys
        # (skin / eyeScale / noseScale / detail / feather), so write THOSE —
        # the legacy smooth/eyes keys would be ignored by _cam_hook().
        retouch_tab = widgets.VBox([
            self.rt_on,
            self._slider("Smooth (skin)", 0, 100, 1, lambda: rc.get("skin", 55),
                         lambda v: rc.__setitem__("skin", v), fmt="{:.0f}%"),
            self._slider("Keep detail", 0, 100, 1, lambda: rc.get("detail", 45),
                         lambda v: rc.__setitem__("detail", v), fmt="{:.0f}%"),
            self._slider("Teeth", 0, 100, 1, lambda: rc.get("teeth", 40),
                         lambda v: rc.__setitem__("teeth", v), fmt="{:.0f}%"),
            self._slider("Eye size", -30, 45, 1, lambda: rc.get("eyeScale", 0),
                         lambda v: rc.__setitem__("eyeScale", v), fmt="{:.0f}%"),
            self._slider("Nose width", -40, 20, 1, lambda: rc.get("noseScale", 0),
                         lambda v: rc.__setitem__("noseScale", v), fmt="{:.0f}%"),
            widgets.HTML("<i>Mask is rebuilt from face landmarks every frame, "
                         "so it never slides off. Full-render cost: roughly "
                         "2–4× slower than without retouch.</i>"),
            self.rt_msg,
        ])

        # ---- cuts ----------------------------------------------------------
        cc = self.proc.cuts_cfg
        self.cuts_box = widgets.VBox([
            widgets.HTML("<b>Intro / outro / lead-in</b>"),
            self._slider("Intro (s)", 0, 120, 0.5, lambda: cc.get("intro_end", 8),
                         lambda v: cc.__setitem__("intro_end", v), fmt="{:.1f}s"),
            self._slider("Outro last (s)", 0, 120, 0.5,
                         lambda: abs(cc.get("outro_start", -12)),
                         lambda v: cc.__setitem__("outro_start", -abs(v)), fmt="{:.1f}s"),
            self._slider("Lead-in (s)", 0, 6, 0.25, lambda: cc.get("lead_in", 2),
                         lambda v: cc.__setitem__("lead_in", v), fmt="{:.2f}s"),
            self._slider("Black block (s)", 0, 6, 0.25, lambda: cc.get("black", 1.5),
                         lambda v: cc.__setitem__("black", v), fmt="{:.2f}s"),
            widgets.HTML("<b>Silence auto-cut (reaction body only)</b>"),
            self._slider("Silence dB", -60, -20, 1, lambda: cc.get("silence_db", -40),
                         lambda v: cc.__setitem__("silence_db", v), fmt="{:.0f} dB"),
            self._slider("Min silence (s)", 0.5, 10, 0.5,
                         lambda: cc.get("min_silence", 2),
                         lambda v: cc.__setitem__("min_silence", v), fmt="{:.1f}s"),
        ])
        scan_btn = widgets.Button(description="Detect silences",
                                  button_style="primary")
        scan_btn.on_click(lambda _: self._detect_silences())
        clear_btn = widgets.Button(description="Clear drops")
        clear_btn.on_click(lambda _: (self.drops.clear(), self.refresh()))
        cs_btn = widgets.Button(description="Find content start")
        cs_btn.on_click(lambda _: self._find_content_start())
        self.claims_area = widgets.Textarea(
            value="", placeholder="02:14 - 03:40 cut claimed music\n12:03 - 12:47 mute",
            layout=widgets.Layout(width="420px", height="80px"))
        parse_btn = widgets.Button(description="Parse claims")
        parse_btn.on_click(lambda _: self._parse_claims())
        self.timeline_html = widgets.HTML()
        self.cuts_out = widgets.Output()
        cuts_tab = widgets.VBox([
            self.cuts_box,
            widgets.HBox([scan_btn, clear_btn, cs_btn]),
            widgets.HTML("<b>Claims (YouTube Studio → time ranges to cut/mute)</b>"),
            widgets.HBox([self.claims_area, parse_btn]),
            self.timeline_html, self.cuts_out,
        ])

        # ---- audio ---------------------------------------------------------
        ac = self.proc.audio_cfg
        ch_dd = widgets.Dropdown(options=["left", "right"],
                                 value=ac.get("mic_channel", "left"),
                                 description="Mic ch:")
        ch_dd.observe(lambda ch: (ac.__setitem__("mic_channel", ch["new"]),
                                  self.refresh_soon()), "value")
        comp_on = widgets.Checkbox(value=ac.get("comp_on", True),
                                   description="Compressor on")
        comp_on.observe(lambda ch: (ac.__setitem__("comp_on", ch["new"]),
                                    self.refresh_soon()), "value")
        duck_on = widgets.Checkbox(value=ac.get("duck_on", True),
                                   description="Duck content while I speak")
        duck_on.observe(lambda ch: (ac.__setitem__("duck_on", ch["new"]),
                                    self.refresh_soon()), "value")
        audio_tab = widgets.VBox([
            widgets.HTML("<b>Mic bus</b>"), ch_dd, comp_on,
            self._slider("Mic gain", -12, 12, 0.5, lambda: ac.get("mic_gain_db", 0),
                         lambda v: ac.__setitem__("mic_gain_db", v), fmt="{:+.1f} dB"),
            self._slider("Comp thr", -50, 0, 1, lambda: ac.get("comp_threshold", -24),
                         lambda v: ac.__setitem__("comp_threshold", v), fmt="{:.0f} dB"),
            self._slider("Comp ratio", 1, 20, 0.5, lambda: ac.get("comp_ratio", 4),
                         lambda v: ac.__setitem__("comp_ratio", v), fmt="{:.1f}:1"),
            self._slider("Makeup", 0, 18, 0.5, lambda: ac.get("comp_makeup", 4),
                         lambda v: ac.__setitem__("comp_makeup", v), fmt="{:+.1f} dB"),
            self._slider("Limiter", -12, 0, 0.5, lambda: ac.get("limiter_db", -1.2),
                         lambda v: ac.__setitem__("limiter_db", v), fmt="{:.1f} dB"),
            widgets.HTML("<b>Content bus</b>"), duck_on,
            self._slider("Content gain", -20, 6, 0.5,
                         lambda: ac.get("content_gain_db", -1.5),
                         lambda v: ac.__setitem__("content_gain_db", v), fmt="{:+.1f} dB"),
            self._slider("Duck thr", -60, -10, 1, lambda: ac.get("duck_threshold", -32),
                         lambda v: ac.__setitem__("duck_threshold", v), fmt="{:.0f} dB"),
            self._slider("Duck depth", 0, 30, 1, lambda: ac.get("duck_depth", 12),
                         lambda v: ac.__setitem__("duck_depth", v), fmt="−{:.0f} dB"),
        ])
        self.audio_sample_btn = widgets.Button(description="▶ 10s audio sample at playhead")
        self.audio_sample_btn.on_click(lambda _: self._audio_sample())
        self.audio_out = widgets.Output()
        audio_tab.children = tuple(audio_tab.children) + (
            self.audio_sample_btn, self.audio_out)

        # ---- export --------------------------------------------------------
        self.name_txt = widgets.Text(value="youtube_final", description="Name:")
        self.crf_slider = widgets.IntSlider(value=23, min=16, max=28, step=1,
                                            description="CRF (quality)")
        self.webm_chk = widgets.Checkbox(value=True, description="Also WebM (VP9)")
        self.sample_btn = widgets.Button(description="🎬 Render 12s sample at playhead",
                                         button_style="primary")
        self.sample_btn.on_click(lambda _: self._render_sample())
        self.full_btn = widgets.Button(description="⬤ RENDER FULL VIDEO",
                                       button_style="danger")
        self.full_btn.on_click(lambda _: self._render_full())
        self.progress = widgets.IntProgress(value=0, max=100, description="Render:")
        self.layout_path = widgets.Text(
            value=str(Path(self.proc.out) / "layout.json"), description="Layout:",
            layout=widgets.Layout(width="420px"))
        save_btn = widgets.Button(description="Save layout")
        save_btn.on_click(lambda _: self._save_layout())
        load_btn = widgets.Button(description="Load layout")
        load_btn.on_click(lambda _: self._load_layout())
        self.export_out = widgets.Output()
        export_tab = widgets.VBox([
            widgets.HTML("<b>Sample first, full render second.</b> The sample uses "
                         "the real pipeline (compose + mix + mux), so if it looks "
                         "and sounds right, the full file will too."),
            self.name_txt, self.crf_slider, self.webm_chk,
            widgets.HBox([self.sample_btn, self.full_btn]),
            self.progress,
            widgets.HBox([self.layout_path, save_btn, load_btn]),
            self.export_out,
        ])

        self.tabs = widgets.Tab(children=[preview_tab, layout_tab, retouch_tab,
                                          cuts_tab, audio_tab, export_tab])
        for i, title in enumerate(["1 · Preview", "2 · Layout", "3 · Retouch",
                                   "4 · Cuts", "5 · Audio", "6 · Render"]):
            self.tabs.set_title(i, title)

    # ---------------------------------------------------------------- events
    def _on_time(self, ch):
        self.t = float(ch["new"])
        self.refresh()

    def _on_mode(self, ch):
        self.mode = ch["new"]
        self.refresh()

    def _on_pw(self, ch):
        self.preview_width = int(ch["new"])
        self.img.width = self.preview_width
        self.refresh()

    def _nudge(self, d):
        self.time_slider.value = max(
            0.0, min(self.proc.duration, self.time_slider.value + d))

    def refresh_soon(self, delay: float = 0.08):
        if self._building:
            return
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(delay, self._refresh_threadsafe)
        self._timer.daemon = True
        self._timer.start()

    def _refresh_threadsafe(self):
        # ipywidgets trait updates from a timer thread are generally OK;
        # keep it defensive so a failed refresh never kills the UI.
        try:
            self.refresh()
        except Exception as e:
            self.warn_lbl.value = f"<span style='color:#f87171'>Preview error: {e}</span>"

    def _apply_preset(self):
        pid = self.preset_dd.value
        new = L.apply_preset(self.layout, pid)
        # mutate in place so proc.layout stays the same object
        self.layout.content = new.content
        self.layout.cam = new.cam
        self.layout.contentHidden = new.contentHidden
        self.layout.camStyle.shape = new.camStyle.shape
        self.proc.layout = self.layout
        # rebuild the whole UI so every slider shows the preset values
        self._build_widgets()
        self.refresh()
        # re-display: swap children of the container if shown
        if hasattr(self, "_container"):
            self._container.children = [self.tabs]

    # ---------------------------------------------------------------- refresh
    def segments(self) -> List[Dict[str, Any]]:
        cc = self.proc.cuts_cfg
        claims = list(self.claims) + list(cc.get("claims", []))
        return C.build_segments(
            self.proc.duration, intro_end=cc.get("intro_end", 8.0),
            outro_start=cc.get("outro_start", -12.0),
            drops=list(self.drops), claims=claims,
            lead_in=cc.get("lead_in", 2.0), black=cc.get("black", 1.5))

    def refresh(self):
        if self._building:
            return
        lay = self.layout
        try:
            hook = None
            if self.proc.retouch_cfg.get("enabled"):
                try:
                    hook = self.proc._cam_hook()
                    self.rt_msg.value = ""
                except ImportError as e:
                    self.rt_msg.value = (f"<span style='color:#fbbf24'>{e}</span>")
            fr = C.preview(str(self.proc.input), self.t, lay, mode=self.mode,
                           width=self.preview_width, cam_hook=hook)
            if fr is not None:
                self.img.value = C.to_jpeg(fr, quality=72)
        except Exception as e:
            self.warn_lbl.value = f"<span style='color:#f87171'>Preview error: {e}</span>"
            return

        ov1 = lay.cam.overlap_pct(lay.content)
        ov2 = lay.content.overlap_pct(lay.cam)
        if not lay.contentHidden and max(ov1, ov2) > 0.5:
            self.warn_lbl.value = (
                f"<span style='color:#fbbf24'>⚠ Camera covers {ov1:.1f}% of the "
                f"content frame — shrink the camera or move it to a free corner.</span>")
        else:
            self.warn_lbl.value = ("<span style='color:#6ee7b7'>✓ No overlap — "
                                   "camera and content are cleanly separated.</span>")

        try:
            segs = self.segments()
            rd = C.render_duration(segs, lay.fastSpeed)
            self.info_lbl.value = (
                f"<code>t={fmt_time(self.t)} · scene={self.mode} · "
                f"source {fmt_time(self.proc.duration)} → "
                f"render {fmt_time(rd)} · {len(segs)} segments · "
                f"{len(self.drops)} drops · {len(self.claims)} claims</code>")
            rows = "".join(
                f"<tr><td><code>{s['type']}</code></td>"
                f"<td><code>{fmt_time(s['start'])} → {fmt_time(s['end'])}</code></td></tr>"
                for s in segs[:24])
            more = "" if len(segs) <= 24 else f"<tr><td colspan=2>… +{len(segs) - 24} more</td></tr>"
            self.timeline_html.value = (
                f"<b>Timeline</b> (render {fmt_time(rd)} from "
                f"{fmt_time(self.proc.duration)} source):"
                f"<table>{rows}{more}</table>")
        except Exception:
            pass

    # --------------------------------------------------------------- actions
    def _contact_sheet(self):
        self.sheet_out.clear_output()
        with self.sheet_out:
            try:
                import numpy as np
                dur = self.proc.duration
                times = [dur * f for f in (0.03, 0.3, 0.6, 0.92)] if dur > 8 else [1, 2, 3, 4]
                sheet = self.proc.contact_sheet(times=times, mode=self.mode, width=480)
                display(IPImage(data=C.to_jpeg(sheet, quality=70)))
                print("frames at", ", ".join(fmt_time(t) for t in times))
            except Exception as e:
                print("contact sheet failed:", e)

    def _detect_silences(self):
        self.cuts_out.clear_output()
        with self.cuts_out:
            try:
                cc = self.proc.cuts_cfg
                keep = self.proc.auto_cut_reaction(
                    silence_db=cc.get("silence_db", -40.0),
                    min_silence_sec=cc.get("min_silence", 2.0))
                ie = cc.get("intro_end", 8.0)
                os_ = self.proc.duration + cc.get("outro_start", -12.0)
                drops = []
                for d in self.proc.keeps_to_drops(keep, self.proc.duration):
                    s, e = max(d[0], ie), min(d[1], os_)
                    if e - s > 0.3:
                        drops.append((round(s, 2), round(e, 2)))
                self.drops = drops
                print(f"Found {len(drops)} droppable silence spans (body only):")
                for s, e in drops[:30]:
                    print(f"  {fmt_time(s)} → {fmt_time(e)}")
                if len(drops) > 30:
                    print(f"  … +{len(drops) - 30} more")
                self.refresh()
            except Exception as e:
                print("detection failed:", e)

    def _find_content_start(self):
        self.cuts_out.clear_output()
        with self.cuts_out:
            try:
                t = self.proc.detect_content_start()
                if t is None:
                    print("Could not detect content start (no clear silence→sound edge).")
                else:
                    print(f"Content audio starts at ~{fmt_time(t)} ({t:.1f}s).")
                    print(f"Suggestion: set Intro to {max(0, t - 2):.0f}s so your "
                          f"'let's go' + 1–2s of black lead into it.")
            except Exception as e:
                print("detection failed:", e)

    def _parse_claims(self):
        self.claims = parse_claims(self.claims_area.value, self.proc.duration)
        self.cuts_out.clear_output()
        with self.cuts_out:
            print(f"Parsed {len(self.claims)} claims:")
            for s, e, a in self.claims:
                print(f"  {fmt_time(s)} → {fmt_time(e)}  {a.upper()}")
        self.refresh()

    def _audio_sample(self):
        self.audio_out.clear_output()
        with self.audio_out:
            try:
                import subprocess as sp
                t0 = max(0.0, self.t - 5)
                clip = self.proc.work / "audio_sample_src.mp4"
                print(f"Trimming {fmt_time(t0)} → {fmt_time(t0 + 10)} …")
                sp.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t0:.1f}",
                        "-t", "10", "-i", str(self.proc.input),
                        "-c", "copy", str(clip)], check=True)
                out = self.proc.mix_audio(input_path=str(clip),
                                          output_path=str(self.proc.work / "audio_sample.wav"))
                display(Audio(filename=out))
                print("↑ mixed mic (compressed/limited) + ducked content.")
            except Exception as e:
                print("audio sample failed:", e)

    def _render_sample(self):
        self.export_out.clear_output()
        with self.export_out:
            try:
                print(f"Rendering 12s sample at {fmt_time(self.t)} ({self.mode}) …")
                outs = self.proc.render_sample(
                    self.t, seconds=12.0, mode=self.mode, layout=self.layout,
                    name=f"{self.name_txt.value}_sample")
                mp4 = outs["mp4"]
                size = Path(mp4).stat().st_size / 1e6
                print(f"Sample ready: {mp4} ({size:.1f} MB)")
                display(Video(filename=mp4, embed=True, width=720))
            except Exception as e:
                print("sample render failed:", e)

    def _render_full(self):
        self.export_out.clear_output()
        with self.export_out:
            try:
                segs = self.segments()
                total = [1]

                def cb(done, n):
                    total[0] = n
                    self.progress.value = int(done / max(1, n) * 90)

                self.progress.value = 2
                name = self.name_txt.value.strip() or "output"
                print(f"FULL RENDER '{name}': {len(segs)} segments …")
                video_nc = self.proc.work / f"{name}_video.mp4"
                self.proc.compose_reaction(output_path=str(video_nc),
                                           layout=self.layout, segments=segs,
                                           crf=int(self.crf_slider.value))
                self.progress.value = 92
                print("Video done — mixing audio …")
                audio = self.proc.mix_audio(
                    output_path=str(self.proc.work / f"{name}_mix.wav"),
                    segments=segs, fast_speed=self.layout.fastSpeed)
                self.progress.value = 96
                outs = self.proc.mux(video_nc, audio,
                                     self.proc.out / f"{name}.mp4",
                                     webm=bool(self.webm_chk.value))
                self.progress.value = 100
                for k, v in outs.items():
                    try:
                        size = Path(v).stat().st_size / 1e6
                    except OSError:
                        size = 0
                    print(f"  {k}: {v} ({size:.1f} MB)")
                print("✓ Done — files are in your output folder (Drive survives "
                      "session end).")
            except Exception as e:
                print("render failed:", e)
            finally:
                self._timer = None

    def _save_layout(self):
        self.export_out.clear_output()
        with self.export_out:
            try:
                p = self.proc.layout.save(self.layout_path.value.strip())
                print(f"Layout saved → {p}")
            except Exception as e:
                print("save failed:", e)

    def _load_layout(self):
        self.export_out.clear_output()
        with self.export_out:
            try:
                self.proc.load_layout(self.layout_path.value.strip())
                self.layout = self.proc.layout
                self._build_widgets()
                self.refresh()
                if hasattr(self, "_container"):
                    self._container.children = [self.tabs]
                print("Layout loaded and UI rebuilt.")
            except Exception as e:
                print("load failed:", e)

    # ------------------------------------------------------------------ show
    def show(self):
        _need_widgets()
        self._container = widgets.VBox([self.tabs])
        display(self._container)
        return self


def launch_editor(proc, preview_width: int = 854) -> "ReactionEditor":
    """Create + display the visual editor for an existing processor."""
    return ReactionEditor(proc, preview_width=preview_width).show()


def quick_preview(proc, t: float = 30.0, mode: str = "body", width: int = 960):
    """One-line inline preview without widgets (for restricted runtimes)."""
    proc.show_preview(t=t, mode=mode, width=width)
