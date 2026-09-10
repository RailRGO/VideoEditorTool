import type { AudioCloak, VideoCloak } from "../lib/types";
import { Note, Section, Slider } from "./ui";

export default function CloakPanel({
  audio,
  setAudio,
  video,
  setVideo,
}: {
  audio: AudioCloak;
  setAudio: React.Dispatch<React.SetStateAction<AudioCloak>>;
  video: VideoCloak;
  setVideo: React.Dispatch<React.SetStateAction<VideoCloak>>;
}) {
  const setA = (p: Partial<AudioCloak>) => setAudio((c) => ({ ...c, ...p }));
  const setV = (p: Partial<VideoCloak>) => setVideo((c) => ({ ...c, ...p }));

  return (
    <div className="space-y-2.5">
      <Section
        title="Voice cloak"
        right={
          <button
            type="button"
            onClick={() => setA({ on: !audio.on })}
            className={
              audio.on
                ? "rounded border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-200"
                : "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400"
            }
          >
            {audio.on ? "on" : "bypass"}
          </button>
        }
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Treats the whole mixed programme — you and the content voices together. Everything here
          keeps the duration untouched.
        </p>
        <div className="space-y-2">
          <Slider
            label="Pitch shift"
            value={audio.pitch}
            min={-2}
            max={2}
            step={0.1}
            display={`${audio.pitch > 0 ? "+" : ""}${audio.pitch.toFixed(1)} st`}
            onChange={(v) => setA({ pitch: v })}
            hint="±1 semitone ≈ ±6%. The single strongest weapon against audio fingerprints"
          />
          <Slider
            label="Chorus movement"
            value={audio.chorus}
            min={0}
            max={100}
            step={1}
            display={`${audio.chorus}%`}
            onChange={(v) => setA({ chorus: v })}
            hint="constantly wobbles the spectrum so stable features never line up"
          />
          <Slider
            label="Room reverb"
            value={audio.reverb}
            min={0}
            max={100}
            step={1}
            display={`${audio.reverb}%`}
            onChange={(v) => setA({ reverb: v })}
            hint="smears transients and onsets the matcher locks onto"
          />
          <div className="grid grid-cols-2 gap-x-3">
            <Slider
              label="Tone tilt"
              value={audio.tilt}
              min={-6}
              max={6}
              step={0.5}
              display={`${audio.tilt > 0 ? "+" : ""}${audio.tilt.toFixed(1)} dB`}
              onChange={(v) => setA({ tilt: v })}
              hint="bright ↔ dark"
            />
            <Slider
              label="Stereo widen"
              value={audio.widen}
              min={0}
              max={15}
              step={0.5}
              display={`${audio.widen.toFixed(1)} ms`}
              onChange={(v) => setA({ widen: v })}
              hint="Haas delay on the right channel"
            />
          </div>
        </div>
      </Section>

      <Section
        title="Frame cloak"
        right={
          <button
            type="button"
            onClick={() => setV({ on: !video.on })}
            className={
              video.on
                ? "rounded border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-200"
                : "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400"
            }
          >
            {video.on ? "on" : "bypass"}
          </button>
        }
      >
        <div className="space-y-2">
          <Slider
            label="Punch-in zoom"
            value={video.zoom}
            min={1}
            max={1.12}
            step={0.005}
            display={`${Math.round((video.zoom - 1) * 1000) / 10}%`}
            onChange={(v) => setV({ zoom: v })}
            hint="crops away edge pixels that fingerprints rely on"
          />
          <Slider
            label="Cover bars"
            value={video.bars}
            min={0}
            max={10}
            step={0.5}
            display={`${video.bars.toFixed(1)}%`}
            onChange={(v) => setV({ bars: v })}
            hint="black strips top + bottom, each this tall"
          />
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Slider
                label="Inset frame"
                value={video.border}
                min={0}
                max={12}
                step={1}
                display={video.border ? `${video.border}px` : "off"}
                onChange={(v) => setV({ border: v })}
              />
            </div>
            <input
              type="color"
              value={video.borderColor}
              onChange={(e) => setV({ borderColor: e.target.value })}
              className="mt-4 h-7 w-10 shrink-0 cursor-pointer rounded border border-white/10 bg-black/40"
              title="Frame colour"
            />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Slider label="Saturation" value={video.saturate} min={50} max={150} step={1} display={`${video.saturate}%`} onChange={(v) => setV({ saturate: v })} />
            <Slider label="Contrast" value={video.contrast} min={50} max={150} step={1} display={`${video.contrast}%`} onChange={(v) => setV({ contrast: v })} />
            <Slider label="Brightness" value={video.brightness} min={70} max={130} step={1} display={`${video.brightness}%`} onChange={(v) => setV({ brightness: v })} />
            <Slider label="Hue rotate" value={video.hue} min={-30} max={30} step={1} display={`${video.hue > 0 ? "+" : ""}${video.hue}°`} onChange={(v) => setV({ hue: v })} />
            <Slider label="Film grain" value={video.grain} min={0} max={100} step={1} display={`${video.grain}%`} onChange={(v) => setV({ grain: v })} hint="animated, crawls every frame" />
            <Slider label="Vignette" value={video.vignette} min={0} max={100} step={1} display={`${video.vignette}%`} onChange={(v) => setV({ vignette: v })} hint="darkens the corners" />
          </div>
        </div>
      </Section>

      <Section title="How to use it">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Start gentle and check after upload — these are a starting point, push further only where
          claims actually land. Preview before rendering: pitch and chorus are audible, zoom and
          bars are visible. Small values already move the needle; large values annoy viewers faster
          than they fool matchers.
        </p>
      </Section>

      <Note tone="warn">
        <strong className="font-semibold">Honest caveat.</strong> This lowers fingerprint-match
        confidence — it does not guarantee a claim-free upload. Fingerprinting keeps getting better
        at seeing through pitch, EQ and crops. The only reliable remedy for a claimed stretch is
        still to <strong>cut it, mute it, or cover it with a card</strong> — then re-upload.
      </Note>
    </div>
  );
}
