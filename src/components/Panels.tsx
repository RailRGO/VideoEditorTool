import { useRef, useState } from "react";
import type { Claim, LayerStyle, LayoutState, AudioState, Segment } from "../lib/types";
import { LAYOUT_PRESETS } from "../lib/types";
import { fmtTime } from "../lib/timeline";
import type { Levels } from "../lib/audio";
import type { RemoteJob } from "../lib/remote";
import { Btn, CardImagePicker, LiveText, Meter, Note, Section, Segmented, Slider, Toggle } from "./ui";
import { cn } from "../utils/cn";

/* ------------------------------------------------------------------ layout */

export function LayoutPanel({
  layout,
  setLayout,
  editLayer,
  setEditLayer,
  dims,
  fileName,
  showGuides,
  setShowGuides,
}: {
  layout: LayoutState;
  setLayout: React.Dispatch<React.SetStateAction<LayoutState>>;
  editLayer: "content" | "cam";
  setEditLayer: (k: "content" | "cam") => void;
  dims: { w: number; h: number };
  fileName: string;
  showGuides: boolean;
  setShowGuides: (v: boolean) => void;
}) {
  const isContent = editLayer === "content";
  const rect = isContent ? layout.content : layout.cam;
  const style: LayerStyle = isContent ? layout.contentStyle : layout.camStyle;

  const setRect = (patch: Partial<typeof rect>) =>
    setLayout((l) => ({
      ...l,
      [isContent ? "content" : "cam"]: { ...rect, ...patch },
    }));
  const setStyle = (patch: Partial<LayerStyle>) =>
    setLayout((l) => ({
      ...l,
      [isContent ? "contentStyle" : "camStyle"]: { ...style, ...patch },
    }));

  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

  return (
    <div className="space-y-2.5">
      <Section
        title="Source"
        right={
          <span className="font-mono text-[10px] text-slate-500">
            {dims.w}×{dims.h}
          </span>
        }
      >
        <p className="mb-2 truncate text-[11px] text-slate-400">{fileName}</p>
        <div className="space-y-2">
          <Segmented
            value={layout.sourceMode}
            onChange={(v) => setLayout((l) => ({ ...l, sourceMode: v }))}
            options={[
              { value: "split", label: "Side-by-side (3840×1080)" },
              { value: "single", label: "Single 16:9 file" },
            ]}
          />
          <Segmented
            value={layout.cameraSide}
            onChange={(v) => setLayout((l) => ({ ...l, cameraSide: v }))}
            options={[
              { value: "left", label: "Cam = left half" },
              { value: "right", label: "Cam = right half" },
            ]}
          />
          <Toggle
            label="Composition guides"
            hint="thirds + title-safe overlay"
            value={showGuides}
            onChange={setShowGuides}
          />
        </div>
      </Section>

      <Section title="Frame presets">
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                setLayout((l) => ({
                  ...l,
                  content: { ...p.content },
                  cam: { ...p.cam },
                  contentHidden: p.hideContent,
                  camStyle: {
                    ...l.camStyle,
                    shape: p.camShape,
                    ...(p.camRadius != null ? { radius: p.camRadius } : {}),
                  },
                  contentStyle: {
                    ...l.contentStyle,
                    ...(p.contentRadius != null ? { radius: p.contentRadius } : {}),
                  },
                }))
              }
              className={cn(
                "rounded-lg border border-white/10 bg-white/[0.03] p-2 text-left transition-colors hover:border-sky-400/40 hover:bg-sky-500/10",
                layout.content.x === p.content.x &&
                  layout.cam.x === p.cam.x &&
                  layout.contentHidden === p.hideContent && "border-sky-400/50 bg-sky-500/10"
              )}
            >
              <span className="block text-[11px] font-medium text-slate-200">{p.name}</span>
              <span className="block text-[9px] leading-tight text-slate-500">{p.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-2">
          <Toggle
            label="Hide the sharp content layer"
            hint="only the blurred plate stays behind you"
            value={layout.contentHidden}
            onChange={(v) => setLayout((l) => ({ ...l, contentHidden: v }))}
          />
        </div>
      </Section>

      <Section
        title="Layer"
        right={
          <Segmented
            className="w-[150px]"
            value={editLayer}
            onChange={setEditLayer}
            options={[
              { value: "content", label: "Content" },
              { value: "cam", label: "Camera" },
            ]}
          />
        }
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Slider label="X" value={rect.x} min={0} max={0.98} step={0.005} display={pct(rect.x)} onChange={(v) => setRect({ x: v })} />
          <Slider label="Y" value={rect.y} min={0} max={0.98} step={0.005} display={pct(rect.y)} onChange={(v) => setRect({ y: v })} />
          <Slider label="Width" value={rect.w} min={0.05} max={1} step={0.005} display={pct(rect.w)} onChange={(v) => setRect({ w: v })} />
          <Slider label="Height" value={rect.h} min={0.05} max={1} step={0.005} display={pct(rect.h)} onChange={(v) => setRect({ h: v })} />
        </div>
        <p className="mt-1.5 font-mono text-[10px] text-slate-500">
          {Math.round(rect.x * 1920)}, {Math.round(rect.y * 1080)} ·{" "}
          <span className="text-slate-300">
            {Math.round(rect.w * 1920)}×{Math.round(rect.h * 1080)} px @1080p
          </span>
        </p>
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Segmented
              size="sm"
              value={style.fit}
              onChange={(v) => setStyle({ fit: v })}
              options={[
                { value: "contain", label: "Fit" },
                { value: "cover", label: "Fill" },
              ]}
            />
            <Segmented
              size="sm"
              value={style.shape}
              onChange={(v) => setStyle({ shape: v })}
              options={[
                { value: "rect", label: "Rect" },
                { value: "rounded", label: "Round" },
                { value: "circle", label: "Circle" },
                { value: "pill", label: "Pill" },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Slider label="Zoom" value={style.zoom} min={1} max={2} step={0.01} display={`${style.zoom.toFixed(2)}×`} onChange={(v) => setStyle({ zoom: v })} />
            <Slider label="Corner radius" value={style.radius} min={0} max={60} step={1} display={`${style.radius}px`} onChange={(v) => setStyle({ radius: v })} />
            <Slider label="Offset X" value={style.offsetX} min={-0.5} max={0.5} step={0.005} display={pct(style.offsetX)} onChange={(v) => setStyle({ offsetX: v })} />
            <Slider label="Offset Y" value={style.offsetY} min={-0.5} max={0.5} step={0.005} display={pct(style.offsetY)} onChange={(v) => setStyle({ offsetY: v })} />
            <Slider label="Border" value={style.border} min={0} max={12} step={1} display={`${style.border}px`} onChange={(v) => setStyle({ border: v })} />
            <Slider label="Opacity" value={style.opacity} min={0.1} max={1} step={0.01} display={pct(style.opacity)} onChange={(v) => setStyle({ opacity: v })} />
          </div>
          <div className="flex gap-1.5">
            <Btn className="flex-1" onClick={() => setStyle({ mirror: !style.mirror })}>
              {style.mirror ? "Mirrored ✓" : "Mirror"}
            </Btn>
            <Btn
              className="flex-1"
              onClick={() =>
                setStyle({
                  borderColor: style.borderColor === "#0ea5e9" ? "#f43f5e" : "#0ea5e9",
                })
              }
            >
              Border colour
            </Btn>
          </div>
          <p className="text-[10px] text-slate-500">
            Tip: drag the boxes straight on the preview — they snap to the frame edges, the centre
            and the usual camera widths, so parking the camera in a corner is one movement.
          </p>
        </div>
      </Section>

      <Section title="Background plate">
        <div className="space-y-2">
          <Segmented
            value={layout.bg.source}
            onChange={(v) => setLayout((l) => ({ ...l, bg: { ...l.bg, source: v } }))}
            options={[
              { value: "full", label: "Full frame" },
              { value: "content", label: "Content" },
              { value: "camera", label: "Camera" },
            ]}
          />
          <Slider
            label="Blur"
            value={layout.bg.blur}
            min={0}
            max={120}
            step={1}
            display={`${layout.bg.blur}px`}
            onChange={(v) => setLayout((l) => ({ ...l, bg: { ...l.bg, blur: v } }))}
          />
          <Slider
            label="Opacity"
            value={layout.bg.opacity}
            min={0}
            max={1}
            step={0.01}
            display={pct(layout.bg.opacity)}
            onChange={(v) => setLayout((l) => ({ ...l, bg: { ...l.bg, opacity: v } }))}
          />
          <div className="grid grid-cols-2 gap-x-3">
            <Slider label="Scale" value={layout.bg.scale} min={1} max={1.4} step={0.01} display={`${layout.bg.scale.toFixed(2)}×`} onChange={(v) => setLayout((l) => ({ ...l, bg: { ...l.bg, scale: v } }))} />
            <Slider label="Dim" value={layout.bg.dim} min={0} max={0.8} step={0.01} display={pct(layout.bg.dim)} onChange={(v) => setLayout((l) => ({ ...l, bg: { ...l.bg, dim: v } }))} />
          </div>
        </div>
      </Section>

      <Section title="Intro / outro (camera full frame)">
        <div className="space-y-2">
          <Segmented
            value={layout.soloStyle.fit}
            onChange={(v) =>
              setLayout((l) => ({ ...l, soloStyle: { ...l.soloStyle, fit: v } }))
            }
            options={[
              { value: "contain", label: "Fit" },
              { value: "cover", label: "Fill" },
            ]}
          />
          <Slider
            label="Scale"
            value={layout.soloStyle.zoom}
            min={1}
            max={1.6}
            step={0.01}
            display={`${layout.soloStyle.zoom.toFixed(2)}×`}
            onChange={(v) => setLayout((l) => ({ ...l, soloStyle: { ...l.soloStyle, zoom: v } }))}
          />
          <Toggle
            label="Silence content audio during intro / outro"
            hint="your mic keeps playing"
            value={layout.muteContentInSolo}
            onChange={(v) => setLayout((l) => ({ ...l, muteContentInSolo: v }))}
          />
          <p className="text-[10px] text-slate-500">
            Segment type and exact in / out live in the Timeline tab on the right.
          </p>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------- audio */

export function AudioPanel({
  audio,
  setAudio,
  getLevels,
  direct = false,
  previewMixed = false,
}: {
  audio: AudioState;
  setAudio: React.Dispatch<React.SetStateAction<AudioState>>;
  getLevels: () => Levels;
  /** mixed stereo file: no mic/content split, the programme plays as-is */
  direct?: boolean;
  /** remote preview plays a mixed proxy — the split below still tunes the server render */
  previewMixed?: boolean;
}) {
  if (direct) {
    return (
      <div className="space-y-2.5">
        <Section title="Program">
          <div className="space-y-1.5">
            <Meter label="mix" get={() => getLevels().mic} />
            <p className="text-[10px] leading-relaxed text-slate-500">
              The YouTube job is cut from your finished Patreon render, so the audio is already
              mixed — it plays through the anti-fingerprint chain (see the Cloak tab).
            </p>
          </div>
        </Section>
        <Section title="Master">
          <Slider label="Output gain" value={audio.master.gain} min={-20} max={6} step={0.5} display={`${audio.master.gain.toFixed(1)} dB`} onChange={(v) => setAudio((a) => ({ ...a, master: { gain: v } }))} hint="a −1.5 dB safety limiter is always engaged last" />
        </Section>
        <Note>
          <strong className="font-semibold">Mute and card segments silence everything</strong>{" "}
          here — a mixed file can't be split back into voice and content. Cut segments are dropped
          from the render entirely.
        </Note>
      </div>
    );
  }
  const mic = audio.mic;
  const setMic = (patch: Partial<AudioState["mic"]>) =>
    setAudio((a) => ({ ...a, mic: { ...a.mic, ...patch } }));
  const setComp = (patch: Partial<AudioState["mic"]["comp"]>) =>
    setAudio((a) => ({ ...a, mic: { ...a.mic, comp: { ...a.mic.comp, ...patch } } }));
  const setDuck = (patch: Partial<AudioState["content"]["duck"]>) =>
    setAudio((a) => ({
      ...a,
      content: { ...a.content, duck: { ...a.content.duck, ...patch } },
    }));

  return (
    <div className="space-y-2.5">
      {previewMixed && (
        <Note>
          The preview stream is mixed, so what you hear is the rough blend — but every slider
          below is honoured by the server render, which mixes the real mic and content buses.
        </Note>
      )}
      <Section title="Meters">
        <div className="space-y-1.5">
          <Meter label="mic" get={() => getLevels().mic} />
          <Meter label="content" get={() => getLevels().content} />
          <div className="flex items-center justify-between pt-0.5 text-[10px] text-slate-500">
            <span>
              gain reduction{" "}
              <span className="font-mono text-amber-300">
                <LiveText get={() => `${getLevels().reduction.toFixed(1)} dB`} />
              </span>
            </span>
            <span>
              ducking{" "}
              <span className="font-mono text-teal-300">
                <LiveText get={() => (getLevels().ducking > 0.5 ? "active" : "idle")} />
              </span>
            </span>
          </div>
        </div>
      </Section>

      <Section
        title="Mic channel"
        right={
          <Segmented
            className="w-[110px]"
            value={mic.channel}
            onChange={(v) => setMic({ channel: v })}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
          />
        }
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Your OBS file carries mic on one channel and desktop audio on the other. Pick which is
          which — each is then processed on its own bus.
        </p>
        <div className="space-y-2">
          <Slider label="Gain" value={mic.gain} min={-24} max={18} step={0.5} display={`${mic.gain.toFixed(1)} dB`} onChange={(v) => setMic({ gain: v })} />
          <Slider label="Pan" value={mic.pan} min={-1} max={1} step={0.05} display={mic.pan.toFixed(2)} onChange={(v) => setMic({ pan: v })} />
        </div>
      </Section>

      <Section
        title="Compressor + limiter (mic)"
        right={
          <button
            type="button"
            onClick={() => setComp({ on: !mic.comp.on })}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              mic.comp.on
                ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                : "border-white/15 bg-white/5 text-slate-400"
            )}
          >
            {mic.comp.on ? "on" : "bypass"}
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Slider label="Threshold" value={mic.comp.threshold} min={-50} max={0} step={1} display={`${mic.comp.threshold} dB`} onChange={(v) => setComp({ threshold: v })} />
          <Slider label="Ratio" value={mic.comp.ratio} min={1} max={20} step={0.5} display={`${mic.comp.ratio}:1`} onChange={(v) => setComp({ ratio: v })} />
          <Slider label="Knee" value={mic.comp.knee} min={0} max={40} step={1} display={`${mic.comp.knee} dB`} onChange={(v) => setComp({ knee: v })} />
          <Slider label="Make-up" value={mic.comp.makeup} min={0} max={18} step={0.5} display={`${mic.comp.makeup} dB`} onChange={(v) => setComp({ makeup: v })} />
          <Slider label="Attack" value={mic.comp.attack} min={0} max={100} step={1} display={`${mic.comp.attack} ms`} onChange={(v) => setComp({ attack: v })} />
          <Slider label="Release" value={mic.comp.release} min={20} max={1000} step={10} display={`${mic.comp.release} ms`} onChange={(v) => setComp({ release: v })} />
        </div>
        <div className="mt-2">
          <Slider label="Limiter ceiling" value={mic.limiter} min={-12} max={0} step={0.5} display={`${mic.limiter} dB`} onChange={(v) => setMic({ limiter: v })} hint="hard cap on peaks, 20:1 after the compressor" />
        </div>
      </Section>

      <Section title="Content audio + side-chain ducking">
        <div className="space-y-2">
          <Slider label="Gain" value={audio.content.gain} min={-30} max={6} step={0.5} display={`${audio.content.gain.toFixed(1)} dB`} onChange={(v) => setAudio((a) => ({ ...a, content: { ...a.content, gain: v } }))} />
          <Toggle
            label="Auto-duck content while I speak"
            hint="driven by the post-compressor mic level"
            value={audio.content.duck.on}
            onChange={(v) => setDuck({ on: v })}
          />
          <div className={cn("grid grid-cols-2 gap-x-3 gap-y-2", !audio.content.duck.on && "pointer-events-none opacity-40")}>
            <Slider label="Trigger at" value={audio.content.duck.threshold} min={-60} max={-10} step={1} display={`${audio.content.duck.threshold} dB`} onChange={(v) => setDuck({ threshold: v })} />
            <Slider label="Depth" value={audio.content.duck.depth} min={0} max={30} step={1} display={`−${audio.content.duck.depth} dB`} onChange={(v) => setDuck({ depth: v })} />
            <Slider label="Attack" value={audio.content.duck.attack} min={5} max={500} step={5} display={`${audio.content.duck.attack} ms`} onChange={(v) => setDuck({ attack: v })} />
            <Slider label="Release" value={audio.content.duck.release} min={50} max={2000} step={10} display={`${audio.content.duck.release} ms`} onChange={(v) => setDuck({ release: v })} />
            <Slider label="Hold" value={audio.content.duck.hold} min={0} max={2000} step={20} display={`${audio.content.duck.hold} ms`} onChange={(v) => setDuck({ hold: v })} />
          </div>
        </div>
      </Section>

      <Section title="Master">
        <Slider label="Output gain" value={audio.master.gain} min={-20} max={6} step={0.5} display={`${audio.master.gain.toFixed(1)} dB`} onChange={(v) => setAudio((a) => ({ ...a, master: { gain: v } }))} hint="a −1.5 dB safety limiter is always engaged last" />
      </Section>
    </div>
  );
}

/* ------------------------------------------------- video (youtube mode) */

export function VideoPanel({
  fileName,
  dims,
  layout,
  setLayout,
}: {
  fileName: string;
  dims: { w: number; h: number };
  layout: LayoutState;
  setLayout: React.Dispatch<React.SetStateAction<LayoutState>>;
}) {
  return (
    <div className="space-y-2.5">
      <Section
        title="Source"
        right={
          <span className="font-mono text-[10px] text-slate-500">
            {dims.w}×{dims.h}
          </span>
        }
      >
        <p className="mb-2 truncate text-[11px] text-slate-400">{fileName}</p>
        <Note>
          <strong className="font-semibold">Full-frame passthrough.</strong> The Patreon render is
          already composed, so it goes to the output untouched — this mode only cuts, mutes,
          fast-forwards and covers parts with a card.
        </Note>
      </Section>

      <Section title="Placeholder card">
        <div className="space-y-1.5">
          <input
            value={layout.card.title}
            onChange={(e) => setLayout((l) => ({ ...l, card: { ...l.card, title: e.target.value } }))}
            placeholder="Card headline"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
          />
          <input
            value={layout.card.sub}
            onChange={(e) => setLayout((l) => ({ ...l, card: { ...l.card, sub: e.target.value } }))}
            placeholder="Card sub-line"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
          />
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={layout.card.accent}
              onChange={(e) => setLayout((l) => ({ ...l, card: { ...l.card, accent: e.target.value } }))}
              className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-black/40"
            />
            <span className="font-mono text-[10px] text-slate-500">{layout.card.accent}</span>
          </div>
          <CardImagePicker
            image={layout.card.image ?? ""}
            showText={layout.card.showText !== false}
            onImage={(v) => setLayout((l) => ({ ...l, card: { ...l.card, image: v } }))}
            onShowText={(v) => setLayout((l) => ({ ...l, card: { ...l.card, showText: v } }))}
          />
          <p className="text-[10px] leading-relaxed text-slate-500">
            Covers the content area wherever a CARD segment sits (camera corner is restored
            on top, so it never touches you), with the programme audio silenced.
          </p>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ claims */

export function ClaimsPanel({
  raw,
  setRaw,
  claims,
  timeBase,
  setTimeBase,
  onParse,
  onAction,
  onApplyAll,
  onClear,
  onCopyEDL,
  onDownloadEDL,
  onImportEDL,
  segments,
}: {
  raw: string;
  setRaw: (v: string) => void;
  claims: Claim[];
  timeBase: "source" | "render";
  setTimeBase: (v: "source" | "render") => void;
  onParse: () => void;
  onAction: (id: string, action: Claim["action"]) => void;
  onApplyAll: () => void;
  onClear: () => void;
  onCopyEDL: () => void;
  onDownloadEDL: () => void;
  /** load an EDL .txt back in — replaces the timeline (undoable) */
  onImportEDL: (f: File) => Promise<string>;
  segments: Segment[];
}) {
  const [copied, setCopied] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const edlImportRef = useRef<HTMLInputElement>(null);
  const unresolved = claims.filter((c) => c.action === "none").length;

  return (
    <div className="space-y-2.5">
      <Section title="Claimed segments">
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          In YouTube Studio → Content → the ⚠ next to your video you can see exactly which
          segment(s) were matched. Paste them here, one per line, in any of these forms:
        </p>
        <pre className="mb-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-2 text-[10px] leading-relaxed text-slate-400">
{`02:14 - 03:40  Song title
00:02:14 to 00:03:40
131 - 220`}
        </pre>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={"02:14 - 03:40  Claimed music\n12:03 - 12:47  Visual match"}
          className="w-full resize-y rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-400/50"
        />
        <div className="mt-2 flex items-center gap-2">
          <Segmented
            className="flex-1"
            value={timeBase}
            onChange={setTimeBase}
            options={[
              { value: "source", label: "Times are source" },
              { value: "render", label: "Times are uploaded" },
            ]}
          />
          <Btn variant="primary" onClick={onParse}>
            Parse
          </Btn>
        </div>
      </Section>

      {claims.length > 0 && (
        <Section
          title={`${claims.length} claim${claims.length === 1 ? "" : "s"} mapped`}
          right={
            <button
              type="button"
              onClick={onClear}
              className="text-[10px] text-slate-500 underline hover:text-slate-300"
            >
              clear
            </button>
          }
        >
          <div className="space-y-1.5">
            {claims.map((c) => (
              <div key={c.id} className="rounded-lg border border-white/10 bg-black/25 p-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-200">
                    {fmtTime(c.start)} → {fmtTime(c.end)}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {Math.round(c.end - c.start)}s
                  </span>
                </div>
                <p className="mb-1.5 truncate text-[10px] text-slate-400">{c.label}</p>
                <div className="flex gap-1">
                  {(
                    [
                      ["none", "keep"],
                      ["mute", "mute audio"],
                      ["cut", "remove"],
                    ] as [Claim["action"], string][]
                  ).map(([a, label]) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => onAction(c.id, a)}
                      className={cn(
                        "flex-1 rounded border px-1 py-1 text-[10px] font-semibold",
                        c.action === a
                          ? a === "cut"
                            ? "border-rose-400/50 bg-rose-500/25 text-rose-100"
                            : a === "mute"
                            ? "border-amber-400/50 bg-amber-500/25 text-amber-100"
                            : "border-white/25 bg-white/10 text-white"
                          : "border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/10"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <Btn variant="primary" className="flex-1" onClick={onApplyAll}>
              Apply {unresolved ? `${unresolved} pending` : "all"} to timeline
            </Btn>
          </div>
        </Section>
      )}

      <Section title="Export edit list">
        <div className="flex gap-1.5">
          <Btn
            className="flex-1"
            onClick={() => {
              onCopyEDL();
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? "Copied ✓" : "Copy EDL"}
          </Btn>
          <Btn className="flex-1" onClick={onDownloadEDL}>
            Download .txt
          </Btn>
          <Btn className="flex-1" onClick={() => edlImportRef.current?.click()}>
            Import .txt
          </Btn>
          <input
            ref={edlImportRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportEDL(f).then(setImportMsg);
              e.target.value = "";
            }}
          />
        </div>
        <p className="mt-2 font-mono text-[10px] text-slate-500">
          {segments.filter((s) => s.type === "cut").length} removed ·{" "}
          {segments.filter((s) => s.type === "mute").length} muted
        </p>
        {importMsg && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-emerald-300/90">{importMsg}</p>
        )}
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
          Import reads a Reaction Studio EDL (load the same source file first) — the whole edit
          lands on the timeline in one step. Undo (Ctrl+Z) takes it back.
        </p>
      </Section>

      <Note>
        <strong className="font-semibold">Cut version here, full version on Patreon</strong> —
        that’s exactly what this tab and the auto-cut are for. The trimmed render simply contains
        less of the source, which is the one thing that reliably changes what a fingerprint sees.
        <br />
        <br />
        If a claim still lands on the cut version:
        <br />
        <span className="ml-1">1.</span> <strong>Trim or mute the matched part</strong> — mark it
        <span className="mx-1 rounded border border-rose-400/30 bg-rose-500/15 px-1 text-[10px] text-rose-200">CUT</span>
        or
        <span className="mx-1 rounded border border-amber-400/30 bg-amber-500/15 px-1 text-[10px] text-amber-200">MUTE</span>
        above, re-render, re-upload. This is the same remedy YouTube’s own editor offers, so it
        clears the claim for good rather than temporarily.
        <br />
        <span className="ml-1">2.</span> <strong>Check the claim type.</strong> Most claims on
        reaction videos are “monetise” (revenue is shared, video stays up, no strike) — you can
        just accept those. A copyright <em>strike</em> only comes from a takedown request, which is
        a different, rarer thing.
        <br />
        <span className="ml-1">3.</span> <strong>Dispute</strong> if you have a licence or your
        commentary is genuinely transformative — the more you talk over it, the stronger that
        argument gets.
        <br />
        <span className="ml-1">4.</span> Keep the <strong>CARD</strong> segments in: they carry no
        content at all, and they’re your funnel to Patreon.
      </Note>
    </div>
  );
}

/* ------------------------------------------------------------------ export */

export function ExportPanel({
  res,
  setRes,
  fps,
  setFps,
  bitrate,
  setBitrate,
  exporting,
  progress,
  resultUrl,
  resultSize,
  fileName,
  onExport,
  onStop,
  outDur,
  removed,
  duration,
  mime,
  onSaveProject,
  onLoadProject,
  onRestoreAutosave,
  projectMsg,
  passthrough = false,
  remote = null,
  partTarget = 0,
  setPartTarget,
  stems = true,
  setStems,
  audioFadeMs = 80,
  setAudioFadeMs,
}: {
  res: 720 | 1080;
  setRes: (v: 720 | 1080) => void;
  fps: 24 | 30 | 60;
  setFps: (v: 24 | 30 | 60) => void;
  bitrate: number;
  setBitrate: (v: number) => void;
  exporting: boolean;
  progress: number;
  resultUrl: string | null;
  resultSize: number;
  fileName: string;
  onExport: () => void;
  onStop: () => void;
  outDur: number;
  removed: number;
  duration: number;
  mime: string;
  onSaveProject: () => void;
  onLoadProject: (f: File) => void;
  onRestoreAutosave?: () => void;
  projectMsg: string;
  /** YouTube: the render is a straight cut of the finished file (no resizing) */
  passthrough?: boolean;
  remote?: {
    connected: boolean;
    job: RemoteJob | null;
    error: string;
    onExport: () => void;
    onCancel: () => void;
    /** finish a stopped render from the parts already on the server */
    onResume: (key: string) => void;
    fileUrl: (name: string) => string;
  } | null;
  /** seconds of programme per server part; 0 = automatic */
  partTarget?: number;
  setPartTarget?: (v: number) => void;
  /** Patreon master: publish content-only + mic-only tracks behind the mix */
  stems?: boolean;
  setStems?: (v: boolean) => void;
  /** join-fade length in ms at cut/card/mute edges (server renders) */
  audioFadeMs?: number;
  setAudioFadeMs?: (v: number) => void;
}) {
  const job = remote?.job ?? null;
  const running = job?.state === "running";
  const projectRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2.5">
      <Section title="Project file">
        <div className="flex gap-1.5">
          <Btn className="flex-1" onClick={onSaveProject}>
            Save project
          </Btn>
          <Btn className="flex-1" onClick={() => projectRef.current?.click()}>
            Load project
          </Btn>
          {onRestoreAutosave && (
            <Btn className="flex-1" onClick={onRestoreAutosave}>
              Restore autosave
            </Btn>
          )}
          <input
            ref={projectRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLoadProject(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
          {projectMsg ||
            "The timeline and every setting as one tiny .json — keep it next to the video, it survives closed tabs and dead sessions."}
        </p>
      </Section>

      <Section title="Render">
        {passthrough ? (
          <div className="space-y-2">
            <Note>
              YouTube renders as a straight cut of your finished file at the source's own
              resolution — nothing is resized or re-timed. The only geometry change comes from the
              Frame Cloak's punch-in zoom and cover bars (Cloak tab → set zoom to 1 and bars to 0
              for a clean frame).
            </Note>
            {!remote && (
              <>
                <Segmented
                  value={String(fps)}
                  onChange={(v) => setFps(Number(v) as 24 | 30 | 60)}
                  options={[
                    { value: "24", label: "24 fps" },
                    { value: "30", label: "30 fps" },
                    { value: "60", label: "60 fps" },
                  ]}
                />
                <Slider
                  label="Video bitrate"
                  value={bitrate}
                  min={2}
                  max={40}
                  step={1}
                  display={`${bitrate} Mbps`}
                  onChange={setBitrate}
                  hint="12–20 Mbps is plenty for 1080p reaction videos"
                />
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Segmented
              value={String(res)}
              onChange={(v) => setRes(Number(v) as 720 | 1080)}
              options={[
                { value: "720", label: "1280×720" },
                { value: "1080", label: "1920×1080" },
              ]}
            />
            <Segmented
              value={String(fps)}
              onChange={(v) => setFps(Number(v) as 24 | 30 | 60)}
              options={[
                { value: "24", label: "24 fps" },
                { value: "30", label: "30 fps" },
                { value: "60", label: "60 fps" },
              ]}
            />
            <Slider
              label="Video bitrate"
              value={bitrate}
              min={2}
              max={40}
              step={1}
              display={`${bitrate} Mbps`}
              onChange={setBitrate}
              hint="12–20 Mbps is plenty for 1080p reaction videos"
            />
          </div>
        )}
      </Section>

      {remote && (
        <Section title="Long renders">
          <div className="space-y-2">
            {setPartTarget && (
              <div>
                <Segmented
                  value={String(partTarget)}
                  onChange={(v) => setPartTarget(Number(v))}
                  options={[
                    { value: "0", label: "Auto" },
                    { value: "120", label: "2 min" },
                    { value: "240", label: "4 min" },
                  ]}
                />
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                  The server renders in parts and journals each one to Drive, so a
                  reclaimed runtime costs one part instead of the whole render —
                  reconnect and press Resume. Anything under 5 min renders in a
                  single pass either way.
                </p>
              </div>
            )}
            {!passthrough && setStems && (
              <Toggle
                label="Also write content &amp; mic tracks"
                value={stems}
                onChange={setStems}
                hint="Track 1 is the full mix (what players and Patreon use);
                      tracks 2 and 3 are the isolated content and mic. The
                      YouTube cut reads those instead of the mix, so a mute or
                      card span silences the programme and keeps your voice."
              />
            )}
            {setAudioFadeMs && (
              <Slider
                label="Audio join fades"
                value={audioFadeMs}
                min={0}
                max={250}
                step={10}
                display={audioFadeMs > 0 ? `${audioFadeMs} ms` : "off"}
                onChange={setAudioFadeMs}
                hint="tiny fade in/out at every cut, card and mute edge so joins don't click"
              />
            )}
          </div>
        </Section>
      )}

      <Section title="Programme">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-lg border border-white/10 bg-black/25 p-2">
            <p className="text-[9px] uppercase tracking-wider text-slate-500">source</p>
            <p className="font-mono text-slate-200">{fmtTime(duration)}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/25 p-2">
            <p className="text-[9px] uppercase tracking-wider text-slate-500">render</p>
            <p className="font-mono text-sky-300">{fmtTime(outDur)}</p>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          {removed > 0.05
            ? `${fmtTime(removed)} of claimed/unwanted material is excluded from the render.`
            : "Nothing is removed — the render covers the whole source."}
        </p>
      </Section>

      <Section title={remote ? "Render on the server" : "Record"}>
        <div className="space-y-2">
          {remote ? (
            !remote.connected ? (
              <p className="text-[11px] leading-relaxed text-slate-400">
                Connect the Colab backend first — the render button appears here once the preview
                stream is up.
              </p>
            ) : running ? (
              <>
                <div className="h-2 overflow-hidden rounded-full bg-black/50 ring-1 ring-inset ring-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-400 transition-[width]"
                    style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                  />
                </div>
                <p className="font-mono text-[11px] text-emerald-300">
                  {((job?.progress ?? 0) * 100).toFixed(1)}%
                  {(job?.parts ?? 1) > 1
                    ? ` · part ${job?.part ?? 0} of ${job?.parts}`
                    : " · rendering on the server"}
                  {job?.step ? ` · ${job.step}` : ""}
                  {(job?.eta_s ?? 0) > 30
                    ? ` · ~${Math.ceil((job?.eta_s ?? 0) / 60)} min left`
                    : ""}
                </p>
                {(job?.age_s ?? 0) > 60 && (
                  <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-200">
                    The encoder has said nothing for {Math.round((job?.age_s ?? 0) / 60)} min.
                    Colab throttles an idle VM — move the mouse over the notebook tab to keep it
                    awake. Parts already written are safe.
                  </p>
                )}
                <p className="text-[10px] leading-relaxed text-slate-500">
                  This tab only watches — the render keeps going if you close it. Reconnect later
                  and the download will be waiting here.
                </p>
                <Btn variant="danger" className="w-full" onClick={remote.onCancel}>
                  Cancel render
                </Btn>
              </>
            ) : job && (job.resume?.saved ?? 0) > 0 && job.state !== "done" ? (
              <div className="space-y-2">
                <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-100">
                  {job.error ??
                    (job.state === "cancelled"
                      ? "Render cancelled. Nothing finished was written to the output folder."
                      : "The render stopped before it finished.")}
                </p>
                <p className="text-[10px] leading-relaxed text-slate-400">
                  {job.resume?.saved ?? 0} of {job.resume?.parts ?? 0} parts are already on the
                  server, so resuming renders only what is missing — nothing is encoded twice.
                </p>
                <div className="flex gap-1.5">
                  <Btn
                    variant="primary"
                    className="flex-1"
                    onClick={() => remote.onResume(job.resume?.key ?? "")}
                  >
                    Resume render
                  </Btn>
                  <Btn className="flex-1" onClick={remote.onExport}>
                    Start over
                  </Btn>
                </div>
              </div>
            ) : (
              <>
                {job?.state === "cancelled" && (
                  <Note>
                    Render cancelled. Nothing was written to the output folder — adjust the
                    timeline and render again.
                  </Note>
                )}
                <Btn
                  variant="primary"
                  className="w-full py-2 text-[12px]"
                  onClick={remote.onExport}
                  disabled={!duration}
                >
                  Render {fmtTime(outDur)} on Colab
                </Btn>
              </>
            )
          ) : exporting ? (
            <>
              <div className="h-2 overflow-hidden rounded-full bg-black/50 ring-1 ring-inset ring-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-400 to-violet-400 transition-[width]"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="font-mono text-[11px] text-sky-300">
                {(progress * 100).toFixed(1)}% · recording in real time
              </p>
              <Btn variant="danger" className="w-full" onClick={onStop}>
                Stop &amp; keep what’s recorded
              </Btn>
            </>
          ) : (
            <Btn variant="primary" className="w-full py-2 text-[12px]" onClick={onExport}>
              ● Render {fmtTime(outDur)} to file
            </Btn>
          )}
          {remote && remote.error && (
            <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-rose-200">
              {remote.error}
            </p>
          )}
          {remote && job?.state === "error" && (
            <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-rose-200">
              Render failed: {job.error ?? "unknown error"}
            </p>
          )}
          {remote && job?.state === "done" && job.files.mp4 && (
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2">
              <a
                href={remote.fileUrl(job.files.mp4)}
                download={job.files.mp4}
                className="block rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-2.5 py-1.5 text-center text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/30"
              >
                ↓ Download {job.files.mp4}
              </a>
              {job.files.webm && (
                <a
                  href={remote.fileUrl(job.files.webm)}
                  download={job.files.webm}
                  className="mt-1.5 block text-center text-[10px] text-emerald-300/80 underline hover:text-emerald-200"
                >
                  {job.files.webm} instead
                </a>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                H.264 + AAC in MP4 — uploads to YouTube and Patreon directly. The file also stays
                in the notebook’s output folder.
              </p>
              {(job.loudness?.integrated != null || job.loudness?.truePeak != null) && (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
                    <p className="text-[9px] uppercase tracking-wider text-slate-500">
                      loudness · EBU R128
                    </p>
                    <p
                      className={
                        "font-mono text-[12px] " +
                        (job.loudness?.integrated != null &&
                        job.loudness.integrated >= -16 &&
                        job.loudness.integrated <= -11
                          ? "text-emerald-300"
                          : "text-amber-300")
                      }
                    >
                      {job.loudness?.integrated != null
                        ? `${job.loudness.integrated.toFixed(1)} LUFS`
                        : "—"}
                    </p>
                    <p className="text-[9px] text-slate-500">target ≈ −16…−11</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
                    <p className="text-[9px] uppercase tracking-wider text-slate-500">
                      true peak
                    </p>
                    <p
                      className={
                        "font-mono text-[12px] " +
                        (job.loudness?.truePeak != null && job.loudness.truePeak > -1
                          ? "text-rose-300"
                          : "text-emerald-300")
                      }
                    >
                      {job.loudness?.truePeak != null
                        ? `${job.loudness.truePeak.toFixed(1)} dBTP`
                        : "—"}
                    </p>
                    <p className="text-[9px] text-slate-500">keep ≤ −1.0</p>
                  </div>
                </div>
              )}
              {((job.thumbs && job.thumbs.length > 0) || job.files.chapters) && (
                <div className="mt-2">
                  <p className="mb-1 text-[9px] uppercase tracking-wider text-slate-500">
                    upload kit
                  </p>
                  {job.thumbs && job.thumbs.length > 0 && (
                    <div className="grid grid-cols-3 gap-1.5">
                      {job.thumbs.map((t) => (
                        <a key={t} href={remote.fileUrl(t)} download={t} title={t}>
                          <img
                            src={remote.fileUrl(t)}
                            alt={t}
                            className="w-full rounded border border-white/10"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {job.files.chapters && (
                    <a
                      href={remote.fileUrl(job.files.chapters)}
                      download={job.files.chapters}
                      className="mt-1.5 block rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-center text-[10px] text-slate-300 hover:bg-white/10"
                    >
                      ↓ {job.files.chapters} — paste into YouTube’s “Chapters” description box
                    </a>
                  )}
                  <p className="mt-1 text-[9px] leading-relaxed text-slate-500">
                    Pick your favourite still for the thumbnail (1280×720, click to download).
                  </p>
                </div>
              )}
            </div>
          )}
          {remote && job && job.log.length > 0 && (
            <pre className="max-h-32 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
              {job.log.slice(-12).join("\n")}
            </pre>
          )}
          {!remote && (
            <>
              <p className="text-[10px] leading-relaxed text-slate-500">
                The render plays the programme once from the top and captures the composited canvas
                plus the processed audio bus, so it takes about as long as the video. Keep this tab
                visible and don’t switch spaces — browsers throttle hidden tabs.
              </p>
              <p className="font-mono text-[10px] text-slate-600">container: {mime || "unsupported"}</p>
            </>
          )}
        </div>
      </Section>

      <Section title="Where the work happens">
        {remote ? (
          <ul className="space-y-1.5 text-[11px] leading-relaxed text-slate-400">
            <li>
              <span className="text-slate-200">Preview here, render there.</span> This tab shows a
              lightweight proxy stream; the timeline, layout and audio settings you see are sent to
              the server as a project file.
            </li>
            <li>
              <span className="text-slate-200">Full quality from the original.</span> The server
              renders from the full-resolution source on its own disk — nothing uploads from your
              machine at any point.
            </li>
            <li>
              <span className="text-slate-200">MP4 straight back.</span> The finished file
              downloads through the same tunnel and also stays in the notebook’s output folder.
            </li>
          </ul>
        ) : (
          <ul className="space-y-1.5 text-[11px] leading-relaxed text-slate-400">
            <li>
              <span className="text-slate-200">All local, nothing uploaded.</span> The browser
              streams your 3 GB file straight off the disk, composites frames on a canvas and encodes
              with MediaRecorder. No server is involved at any point.
            </li>
            <li>
              <span className="text-slate-200">WebM uploads fine.</span> YouTube accepts WebM
              (VP9 + Opus) natively alongside MP4 and re-encodes everything on ingest, so there is no
              penalty for handing it a .webm.
            </li>
            <li>
              <span className="text-slate-200">Output is much smaller.</span> You render 1080p at the
              bitrate above — typically a fraction of the OBS original, so the upload is far quicker
              than re-uploading the source.
            </li>
            <li>
              <span className="text-slate-200">Chrome or Edge only.</span> Safari can neither decode
              WebM/Opus nor run the mic scanner.
            </li>
          </ul>
        )}
      </Section>

      {resultUrl && (
        <Section title="Output">
          <video src={resultUrl} controls className="mb-2 w-full rounded-lg bg-black" />
          <div className="flex items-center gap-1.5">
            <a
              href={resultUrl}
              download={`${fileName.replace(/\.[^.]+$/, "") || "reaction"}-render.webm`}
              className="flex-1 rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-2.5 py-1.5 text-center text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/30"
            >
              ↓ Download {(resultSize / 1048576).toFixed(1)} MB
            </a>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            WebM/VP9+Opus uploads to YouTube directly. If you need H.264 for your archive, drop
            the file through <span className="font-mono">ffmpeg -i in.webm -c:v libx264 -crf 18 -c:a aac out.mp4</span>.
          </p>
        </Section>
      )}
    </div>
  );
}
