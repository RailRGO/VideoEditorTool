import { layoutPresets } from "../lib/defaults";
import { formatTimecode } from "../lib/format";
import type {
  AssemblyOptions,
  AssemblyReport,
  AudioSettings,
  BeautySettings,
  CameraShape,
  Corner,
  InspectorTab,
  LayoutSettings,
  ProgramLook,
} from "../types";
import { cn } from "../utils/cn";
import { Field, PanelCard, Segmented, Slider, Toggle } from "./widgets";

const tabs: { id: InspectorTab; label: string }[] = [
  { id: "layout", label: "Layout" },
  { id: "audio", label: "Audio" },
  { id: "auto", label: "Auto" },
  { id: "edit", label: "Edit" },
  { id: "export", label: "Export" },
];

export function Inspector({
  tab,
  onTab,
  layout,
  setLayout,
  audio,
  setAudio,
  intro,
  outro,
  setIntro,
  setOutro,
  onLift,
  onMute,
  onKeep,
  onApplyKeeps,
  onClearCuts,
  selection,
  cutCount,
  muteCount,
  keepCount,
  programDuration,
  sourceBytes,
  loadError,
  assembly,
  beauty,
  setBeauty,
  faceLocked,
  faceError,
}: {
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  layout: LayoutSettings;
  setLayout: (patch: Partial<LayoutSettings>) => void;
  audio: AudioSettings;
  setAudio: (patch: Partial<AudioSettings> | ((a: AudioSettings) => AudioSettings)) => void;
  intro: number;
  outro: number;
  setIntro: (n: number) => void;
  setOutro: (n: number) => void;
  onLift: () => void;
  onMute: (track: "mic" | "content") => void;
  onKeep: () => void;
  onApplyKeeps: () => void;
  onClearCuts: () => void;
  selection: { start: number; end: number } | null;
  cutCount: number;
  muteCount: number;
  keepCount: number;
  programDuration: number;
  sourceBytes: number;
  loadError: string | null;
  assembly: {
    scanning: boolean;
    progress: number;
    report: AssemblyReport | null;
    options: AssemblyOptions;
    setOptions: (p: Partial<AssemblyOptions>) => void;
    onScan: () => void;
    onApply: () => void;
    hasMedia: boolean;
  };
  beauty: BeautySettings;
  setBeauty: (patch: Partial<BeautySettings> | ((b: BeautySettings) => BeautySettings)) => void;
  faceLocked: boolean;
  faceError: string | null;
}) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-white/5 bg-[#0c0f16]">
      <div className="grid grid-cols-5 border-b border-white/5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={cn(
              "px-0.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.1em]",
              tab === t.id ? "text-amber-200" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {tab === "layout" && (
          <>
            <PanelCard title="Presets">
              <div className="grid grid-cols-2 gap-1.5">
                {layoutPresets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setLayout(p.values)}
                    className="rounded-xl border border-white/6 bg-black/20 px-2.5 py-2 text-left hover:border-amber-200/30"
                  >
                    <div className="text-xs font-medium text-zinc-200">{p.name}</div>
                    <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">{p.hint}</div>
                  </button>
                 ))}
               </div>
             </PanelCard>
             <PanelCard title="Look">
               <Segmented
                 value={layout.look}
                 onChange={(v) => setLayout({ look: v as ProgramLook })}
                 options={[
                   { id: "cards", label: "Cards" },
                   { id: "blurStage", label: "Blur stage" },
                   { id: "hero", label: "Hero face" },
                 ]}
               />
               <div className="h-2" />
               <Segmented
                 value={layout.cameraShape}
                 onChange={(v) => setLayout({ cameraShape: v as CameraShape })}
                 options={[
                   { id: "rounded", label: "Rounded" },
                   { id: "circle", label: "Circle" },
                 ]}
               />
               <Toggle
                 label="Show sharp content card"
                 checked={layout.showContentCard}
                 onChange={(v) => setLayout({ showContentCard: v })}
               />
             </PanelCard>
             <PanelCard title="Program canvas">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Output is 1920×1080. Reaction layout uses a blurred full-frame bed under the 70/30 stack. Intro and outro go camera-full.
              </p>
              <Field label="Content size" value={`${Math.round(layout.contentScale * 100)}%`}>
                <Slider
                  tone="teal"
                  min={0.45}
                  max={0.92}
                  value={layout.contentScale}
                  onChange={(v) => setLayout({ contentScale: v })}
                />
              </Field>
              <Field label="Camera size" value={`${Math.round(layout.cameraScale * 100)}%`}>
                <Slider
                  min={0.16}
                  max={0.88}
                  value={layout.cameraScale}
                  onChange={(v) => setLayout({ cameraScale: v })}
                />
              </Field>
              <Field label="Camera corner">
                <Segmented
                  value={layout.cameraCorner}
                  onChange={(v) => setLayout({ cameraCorner: v as Corner })}
                  options={[
                    { id: "bottom-right", label: "BR" },
                    { id: "bottom-left", label: "BL" },
                    { id: "top-right", label: "TR" },
                    { id: "top-left", label: "TL" },
                  ]}
                />
              </Field>
              <Field label="Margin" value={`${Math.round(layout.cameraMargin)}px`}>
                <Slider
                  min={8}
                  max={80}
                  step={1}
                  value={layout.cameraMargin}
                  onChange={(v) => setLayout({ cameraMargin: v })}
                />
              </Field>
              <Field label="Content X" value={layout.contentX.toFixed(2)}>
                <Slider
                  tone="teal"
                  min={0}
                  max={1}
                  value={layout.contentX}
                  onChange={(v) => setLayout({ contentX: v })}
                />
              </Field>
              <Field label="Content Y" value={layout.contentY.toFixed(2)}>
                <Slider
                  tone="teal"
                  min={0}
                  max={1}
                  value={layout.contentY}
                  onChange={(v) => setLayout({ contentY: v })}
                />
              </Field>
            </PanelCard>
            <PanelCard title="Background bed">
              <Field label="Blur" value={`${Math.round(layout.bgBlur * 100)}%`}>
                <Slider min={0} max={1} value={layout.bgBlur} onChange={(v) => setLayout({ bgBlur: v })} />
              </Field>
              <Field label="Opacity" value={`${Math.round(layout.bgOpacity * 100)}%`}>
                <Slider min={0.1} max={0.85} value={layout.bgOpacity} onChange={(v) => setLayout({ bgOpacity: v })} />
              </Field>
              <Field label="Vignette" value={`${Math.round(layout.vignette * 100)}%`}>
                <Slider min={0} max={0.8} value={layout.vignette} onChange={(v) => setLayout({ vignette: v })} />
              </Field>
              <Field label="Camera radius" value={`${Math.round(layout.cameraRadius)}`}>
                <Slider min={0} max={56} step={1} value={layout.cameraRadius} onChange={(v) => setLayout({ cameraRadius: v })} />
              </Field>
              <Field label="Content radius" value={`${Math.round(layout.contentRadius)}`}>
                <Slider
                  tone="teal"
                  min={0}
                  max={56}
                  step={1}
                  value={layout.contentRadius}
                  onChange={(v) => setLayout({ contentRadius: v })}
                />
              </Field>
              <Field label="Camera border" value={`${layout.cameraBorder.toFixed(0)}px`}>
                <Slider min={0} max={8} step={1} value={layout.cameraBorder} onChange={(v) => setLayout({ cameraBorder: v })} />
              </Field>
            </PanelCard>
            <PanelCard title="Program stages">
              <Field label="Intro (camera full)" value={`${intro.toFixed(1)}s`}>
                <Slider min={0} max={30} step={0.1} value={intro} onChange={setIntro} />
              </Field>
              <Field label="Outro (camera full)" value={`${outro.toFixed(1)}s`}>
                <Slider min={0} max={30} step={0.1} value={outro} onChange={setOutro} />
              </Field>
            </PanelCard>
            <PanelCard title="Face retouch">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                MediaPipe face mesh with tracking hold so the mask stays on when you turn or blink. First use downloads a model.
              </p>
              <div className="flex items-center justify-between text-[11px]">
                <span className={faceLocked ? "text-teal-300" : "text-zinc-500"}>
                  {faceLocked ? "Face locked" : "No lock yet — play the camera"}
                </span>
                <Toggle
                  compact
                  checked={beauty.enabled}
                  onChange={(v) => setBeauty({ enabled: v })}
                />
              </div>
              {faceError ? <p className="text-[11px] text-rose-300">{faceError}</p> : null}
              <Field label="Skin smooth" value={`${Math.round(beauty.smooth * 100)}%`}>
                <Slider min={0} max={1} value={beauty.smooth} onChange={(v) => setBeauty({ smooth: v })} />
              </Field>
              <Field label="Teeth white" value={`${Math.round(beauty.teeth * 100)}%`}>
                <Slider min={0} max={1} value={beauty.teeth} onChange={(v) => setBeauty({ teeth: v })} />
              </Field>
              <Field label="Smaller nose" value={`${Math.round(beauty.nose * 100)}%`}>
                <Slider min={0} max={1} value={beauty.nose} onChange={(v) => setBeauty({ nose: v })} />
              </Field>
              <Field label="Bigger eyes" value={`${Math.round(beauty.eyes * 100)}%`}>
                <Slider min={0} max={1} value={beauty.eyes} onChange={(v) => setBeauty({ eyes: v })} />
              </Field>
            </PanelCard>
          </>
        )}

        {tab === "audio" && (
          <>
            <PanelCard title="Stems">
              <Toggle
                label="Swap L/R (mic ↔ content)"
                checked={audio.swapChannels}
                onChange={(v) => setAudio({ swapChannels: v })}
              />
              <Field label="Mic gain" value={`${audio.micGain.toFixed(2)}`}>
                <Slider
                  tone="mic"
                  min={0}
                  max={2.5}
                  value={audio.micGain}
                  onChange={(v) => setAudio({ micGain: v })}
                />
              </Field>
              <Field label="Content gain" value={`${audio.contentGain.toFixed(2)}`}>
                <Slider
                  tone="teal"
                  min={0}
                  max={2}
                  value={audio.contentGain}
                  onChange={(v) => setAudio({ contentGain: v })}
                />
              </Field>
              <Field label="Master" value={`${audio.masterGain.toFixed(2)}`}>
                <Slider min={0} max={1.2} value={audio.masterGain} onChange={(v) => setAudio({ masterGain: v })} />
              </Field>
            </PanelCard>
            <PanelCard
              title="Mic compressor"
              action={
                <Toggle
                  compact
                  checked={audio.compressor.enabled}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, compressor: { ...a.compressor, enabled: v } }))
                  }
                />
              }
            >
              <Field label="Threshold" value={`${audio.compressor.threshold.toFixed(1)} dB`}>
                <Slider
                  tone="mic"
                  min={-60}
                  max={0}
                  step={0.5}
                  value={audio.compressor.threshold}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, compressor: { ...a.compressor, threshold: v } }))
                  }
                />
              </Field>
              <Field label="Ratio" value={`${audio.compressor.ratio.toFixed(1)}:1`}>
                <Slider
                  tone="mic"
                  min={1}
                  max={12}
                  step={0.1}
                  value={audio.compressor.ratio}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, compressor: { ...a.compressor, ratio: v } }))
                  }
                />
              </Field>
              <Field label="Attack" value={`${Math.round(audio.compressor.attack * 1000)} ms`}>
                <Slider
                  tone="mic"
                  min={0.001}
                  max={0.08}
                  step={0.001}
                  value={audio.compressor.attack}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, compressor: { ...a.compressor, attack: v } }))
                  }
                />
              </Field>
              <Field label="Release" value={`${Math.round(audio.compressor.release * 1000)} ms`}>
                <Slider
                  tone="mic"
                  min={0.04}
                  max={0.6}
                  step={0.01}
                  value={audio.compressor.release}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, compressor: { ...a.compressor, release: v } }))
                  }
                />
              </Field>
              <Field label="Makeup" value={`${audio.compressor.makeup.toFixed(1)} dB`}>
                <Slider
                  tone="mic"
                  min={0}
                  max={12}
                  step={0.1}
                  value={audio.compressor.makeup}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, compressor: { ...a.compressor, makeup: v } }))
                  }
                />
              </Field>
            </PanelCard>
            <PanelCard title="Mic limiter">
              <Toggle
                label="Catch peaks before mix"
                checked={audio.limiter.enabled}
                onChange={(v) => setAudio((a) => ({ ...a, limiter: { ...a.limiter, enabled: v } }))}
              />
              <Field label="Ceiling" value={`${audio.limiter.threshold.toFixed(1)} dB`}>
                <Slider
                  tone="mic"
                  min={-8}
                  max={0}
                  step={0.1}
                  value={audio.limiter.threshold}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, limiter: { ...a.limiter, threshold: v } }))
                  }
                />
              </Field>
            </PanelCard>
            <PanelCard title="Content ducking">
              <Toggle
                label="Lower content while you speak"
                checked={audio.ducking.enabled}
                onChange={(v) => setAudio((a) => ({ ...a, ducking: { ...a.ducking, enabled: v } }))}
              />
              <Field label="Mic open threshold" value={`${audio.ducking.threshold.toFixed(0)} dB`}>
                <Slider
                  min={-60}
                  max={-8}
                  step={1}
                  value={audio.ducking.threshold}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, ducking: { ...a.ducking, threshold: v } }))
                  }
                />
              </Field>
              <Field label="Depth" value={`-${audio.ducking.depth.toFixed(0)} dB`}>
                <Slider
                  tone="teal"
                  min={3}
                  max={24}
                  step={1}
                  value={audio.ducking.depth}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, ducking: { ...a.ducking, depth: v } }))
                  }
                />
              </Field>
              <Field label="Attack" value={`${Math.round(audio.ducking.attack * 1000)} ms`}>
                <Slider
                  min={0.01}
                  max={0.2}
                  step={0.01}
                  value={audio.ducking.attack}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, ducking: { ...a.ducking, attack: v } }))
                  }
                />
              </Field>
              <Field label="Release" value={`${Math.round(audio.ducking.release * 1000)} ms`}>
                <Slider
                  min={0.05}
                  max={1.2}
                  step={0.01}
                  value={audio.ducking.release}
                  onChange={(v) =>
                    setAudio((a) => ({ ...a, ducking: { ...a.ducking, release: v } }))
                  }
                />
              </Field>
            </PanelCard>
          </>
        )}

        {tab === "auto" && (
          <>
            <PanelCard title="Patreon master">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Scan mic vs content audio, keep the last intro take, tighten dead air, switch layout just before the watch starts, black the content card for a beat, then leave the reaction intact except buffering/rewinds.
              </p>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                This is voice-activity editing, not a word transcript. Isolated retries and long pauses go; ums inside a sentence stay.
              </p>
              <button
                type="button"
                disabled={!assembly.hasMedia || assembly.scanning}
                onClick={assembly.onScan}
                className="w-full rounded-xl bg-amber-200 px-3 py-2.5 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {assembly.scanning
                  ? `Scanning… ${Math.round(assembly.progress * 100)}%`
                  : "Scan recording"}
              </button>
              {assembly.scanning ? (
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-amber-200" style={{ width: `${Math.round(assembly.progress * 100)}%` }} />
                </div>
              ) : null}
            </PanelCard>
            <PanelCard title="Behavior">
              <Toggle
                label="Keep last intro take"
                checked={assembly.options.keepLastIntroTake}
                onChange={(v) => assembly.setOptions({ keepLastIntroTake: v })}
              />
              <Toggle
                label="Drop false starts"
                checked={assembly.options.dropFalseStarts}
                onChange={(v) => assembly.setOptions({ dropFalseStarts: v })}
              />
              <Toggle
                label="Tighten intro/outro pauses"
                checked={assembly.options.tightenPauses}
                onChange={(v) => assembly.setOptions({ tightenPauses: v })}
              />
              <Toggle
                label="Cut stalls & rewinds"
                checked={assembly.options.cutStalls}
                onChange={(v) => assembly.setOptions({ cutStalls: v })}
              />
              <Toggle
                label="Clean outro takes"
                checked={assembly.options.cleanOutro}
                onChange={(v) => assembly.setOptions({ cleanOutro: v })}
              />
              <Field label="Black hold before content" value={`${assembly.options.blackHold.toFixed(1)}s`}>
                <Slider
                  min={1}
                  max={3}
                  step={0.1}
                  value={assembly.options.blackHold}
                  onChange={(v) => assembly.setOptions({ blackHold: v })}
                />
              </Field>
              <Field label="Pause keep" value={`${Math.round(assembly.options.pauseKeep * 1000)} ms`}>
                <Slider
                  min={0.08}
                  max={0.45}
                  step={0.02}
                  value={assembly.options.pauseKeep}
                  onChange={(v) => assembly.setOptions({ pauseKeep: v })}
                />
              </Field>
              <Field label="Stall if content silent" value={`${assembly.options.stallMin.toFixed(2)}s`}>
                <Slider
                  min={0.4}
                  max={2}
                  step={0.05}
                  value={assembly.options.stallMin}
                  onChange={(v) => assembly.setOptions({ stallMin: v })}
                />
              </Field>
              <Field label="Scan speed" value={`${assembly.options.scanRate.toFixed(0)}×`}>
                <Slider
                  min={2}
                  max={8}
                  step={1}
                  value={assembly.options.scanRate}
                  onChange={(v) => assembly.setOptions({ scanRate: v })}
                />
              </Field>
            </PanelCard>
            {assembly.report ? (
              <PanelCard title="Scan report">
                <ul className="space-y-1.5 text-[11px] leading-relaxed text-zinc-400">
                  <li>
                    Content start{" "}
                    {assembly.report.contentOnset != null
                      ? formatTimecode(assembly.report.contentOnset)
                      : "not found"}
                  </li>
                  <li>
                    Layout switch {formatTimecode(assembly.report.markers.layoutSwitch)} · black until{" "}
                    {formatTimecode(assembly.report.markers.contentReveal)}
                  </li>
                  <li>
                    Intro takes {assembly.report.introTakes.length} · outro takes {assembly.report.outroTakes.length}
                  </li>
                  <li>Stalls/rewinds {assembly.report.stalls.length} · cuts {assembly.report.cuts.length}</li>
                </ul>
                {assembly.report.notes.map((n) => (
                  <p key={n} className="text-[11px] leading-relaxed text-zinc-500">
                    {n}
                  </p>
                ))}
                <button
                  type="button"
                  onClick={assembly.onApply}
                  disabled={!assembly.report.cuts.length && !assembly.report.contentOnset}
                  className="w-full rounded-xl bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
                >
                  Build Patreon program
                </button>
              </PanelCard>
            ) : null}
          </>
        )}

        {tab === "edit" && (
          <>
            <PanelCard title="Protected bookends">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Intro and outro stay camera-full and cannot be lifted. Set their lengths on Layout. Cuts only apply to the reaction body in between.
              </p>
              <div className="font-mono text-[11px] text-zinc-400">
                Intro {intro.toFixed(1)}s · Outro {outro.toFixed(1)}s
              </div>
            </PanelCard>
            <PanelCard title="YouTube cut">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Shift-drag ranges you want to keep in the middle, then build the short program. Everything else in the body is dropped. Useful for a teaser while the full cut lives on Patreon — not a way to make clips “unclaimable.”
              </p>
              <div className="font-mono text-xs text-zinc-300">
                {selection
                  ? `${selection.start.toFixed(2)}s → ${selection.end.toFixed(2)}s`
                  : "No selection"}
              </div>
              <div className="grid grid-cols-1 gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={onKeep}
                  disabled={!selection}
                  className="rounded-xl bg-teal-300 px-3 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
                >
                  Keep selection in body
                </button>
                <button
                  type="button"
                  onClick={onApplyKeeps}
                  disabled={keepCount === 0}
                  className="rounded-xl bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
                >
                  Build cut from keeps
                </button>
                <button
                  type="button"
                  onClick={onLift}
                  disabled={!selection}
                  className="rounded-xl border border-white/10 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40"
                >
                  Lift selection (body only)
                </button>
                <button
                  type="button"
                  onClick={() => onMute("content")}
                  disabled={!selection}
                  className="rounded-xl border border-white/10 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40"
                >
                  Mute content in selection
                </button>
                <button
                  type="button"
                  onClick={() => onMute("mic")}
                  disabled={!selection}
                  className="rounded-xl border border-white/10 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40"
                >
                  Mute mic in selection
                </button>
                <button
                  type="button"
                  onClick={onClearCuts}
                  className="rounded-xl border border-white/10 px-3 py-2 text-sm text-zinc-400"
                >
                  Clear cuts & keeps
                </button>
              </div>
              <div className="pt-1 text-[11px] text-zinc-500">
                {keepCount} keeps · {cutCount} lifts · {muteCount} mutes
              </div>
            </PanelCard>
          </>
        )}

        {tab === "export" && (
          <>
            <PanelCard title="Where it renders">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Everything runs in this browser tab on your machine. The OBS file is not uploaded anywhere. Chrome decodes each frame (GPU if the codec allows), Twinframe draws a 1920×1080 canvas, and MediaRecorder writes a new file in real time.
              </p>
              <ul className="space-y-1.5 text-[12px] text-zinc-400">
                <li>Program length {programDuration ? `${Math.round(programDuration / 60)} min` : "—"} ≈ same time to export</li>
                <li>3GB+ sources stream from disk — they are not fully loaded into JS</li>
                <li>Keep this tab visible; background tabs get throttled</li>
                <li>Prefer OBS MP4 (H.264). MKV / HEVC often will not play in Chrome</li>
              </ul>
              {sourceBytes > 1.5 * 1024 * 1024 * 1024 ? (
                <p className="text-[11px] leading-relaxed text-amber-200/80">
                  This source is over 1.5 GB. Preview may hitch on 3840×1080. Export still plays the program at 1× — a 20 minute cut takes about 20 minutes.
                </p>
              ) : null}
              {loadError ? <p className="text-[11px] text-rose-300">{loadError}</p> : null}
            </PanelCard>
            <PanelCard title="YouTube and WebM">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Yes — YouTube accepts WebM (VP8/VP9 + Opus). After upload they re-encode it. Chrome cannot reliably export H.264 MP4 from MediaRecorder, so Twinframe writes WebM. If a tool later needs MP4, transcode the export in HandBrake.
              </p>
            </PanelCard>
            <PanelCard title="Claims">
              <p className="text-[11px] leading-relaxed text-zinc-500">
                A shorter YouTube version is a normal teaser for Patreon. It does not make the clip safe from claims. Content ID can still match what remains.
              </p>
            </PanelCard>
          </>
        )}
      </div>
    </aside>
  );
}
