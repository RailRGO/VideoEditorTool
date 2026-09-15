import { useRef, useState } from "react";
import {
  MIRROR_MODE_META,
  SEGMENT_META,
  type AudioCloak,
  type MirrorMode,
  type MirrorScope,
  type Segment,
  type Sticker,
  type VideoCloak,
} from "../lib/types";
import { fmtTime } from "../lib/timeline";
import type { RemoteClient } from "../lib/remote";
import { Btn, Note, Section, Segmented, Slider } from "./ui";
import { cn } from "../utils/cn";

/** the built-in morph characters (colab_version/voice_morph.py PRESETS) */
const MORPH_PRESETS = [
  { value: "incognito", label: "Incognito", hint: "the default: still clear, unmistakably someone else" },
  { value: "deep", label: "Deep", hint: "big low narrator" },
  { value: "bright", label: "Bright", hint: "small bright character" },
  { value: "warm", label: "Warm", hint: "broadcast-y, closest to the original performance" },
  { value: "radio", label: "Radio", hint: "lo-fi intercom band" },
  { value: "robot", label: "Robot", hint: "machine voice" },
  { value: "alien", label: "Alien", hint: "not a voice at all — extreme tract + wobble" },
  { value: "custom", label: "Manual", hint: "neutral carrier for the sliders below" },
] as const;

export default function CloakPanel({
  audio,
  setAudio,
  video,
  setVideo,
  sticker,
  setSticker,
  remote,
  segments,
  onToggleMirror,
  onSetAllMirror,
  onSeek,
}: {
  audio: AudioCloak;
  setAudio: React.Dispatch<React.SetStateAction<AudioCloak>>;
  video: VideoCloak;
  setVideo: React.Dispatch<React.SetStateAction<VideoCloak>>;
  sticker: Sticker;
  setSticker: React.Dispatch<React.SetStateAction<Sticker>>;
  /** present when the Colab backend is connected (uploads + RVC) */
  remote: RemoteClient | null;
  /** the current timeline — drives the per-block mirror ticks */
  segments: Segment[];
  onToggleMirror: (id: string) => void;
  onSetAllMirror: (on: boolean) => void;
  /** move the playhead (used by "preview a reaction block") */
  onSeek: (t: number) => void;
}) {
  const setA = (p: Partial<AudioCloak>) => setAudio((c) => ({ ...c, ...p }));
  const setV = (p: Partial<VideoCloak>) => setVideo((c) => ({ ...c, ...p }));
  const setS = (p: Partial<Sticker>) => setSticker((c) => ({ ...c, ...p }));
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploadErr, setUploadErr] = useState("");
  const [uploading, setUploading] = useState(false);

  /** where the browser can actually SEE the sticker (preview URL) */
  const previewSrc = (() => {
    const src = sticker.src || "";
    if (!src) return "";
    if (src.startsWith("data:") || src.startsWith("blob:") || src.startsWith("http")) return src;
    return remote ? remote.fileUrl(src) : "";
  })();

  /* ------------------------------------------------------------ mirroring */
  const mirrorMode: MirrorMode = video.mirrorMode ?? "off";
  const mirrorScope: MirrorScope = video.mirrorScope ?? "reaction";
  const clean = (s: Segment) => s.type === "intro" || s.type === "outro";
  const tickable = segments.filter((s) => !clean(s));
  const ticked = tickable.filter((s) => s.mirror).length;
  /** a reaction block to jump to, so the effect can actually be seen */
  const firstReaction = tickable.find((s) => s.type === "body" || s.type === "lead");

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    setUploadErr("");
    if (remote) {
      // Colab mode: push the image to the notebook — the renderer reads it there
      setUploading(true);
      try {
        const up = await remote.uploadAsset(file);
        setS({ src: up.name, on: true });
      } catch (e) {
        setUploadErr(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    } else {
      // local mode: keep the image in the browser (object URL for preview,
      // data URL so it survives inside saved projects)
      const rd = new FileReader();
      rd.onload = () => setS({ src: String(rd.result || ""), on: true });
      rd.readAsDataURL(file);
    }
  };

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
          Treats the mixed programme of the <b>reaction part only</b> — your intro and outro are
          exported exactly as recorded. Everything here keeps the duration untouched.
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
        title="Voice changer — reaction part only"
        right={
          <button
            type="button"
            onClick={() => setA({ voiceChanger: !audio.voiceChanger })}
            className={
              audio.voiceChanger
                ? "rounded border border-fuchsia-400/40 bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-fuchsia-200"
                : "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400"
            }
          >
            {audio.voiceChanger ? "on" : "off"}
          </button>
        }
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Content ID fingerprints the <b>programme audio</b>, so by default this re-voices the{" "}
          <b>content</b> track and leaves your own commentary untouched — the show comes out
          sounding dubbed, which is exactly what stops a match. Pick{" "}
          <b>Everyone</b> for the CapCut-style move: every voice in the reaction part (yours and
          the show&apos;s) comes out as the <b>same new character voice</b>. Your intro/outro
          always stay clean. Splitting the two needs the Patreon master with stems; a single mixed
          track gets re-voiced as one piece.
        </p>
        <Segmented
          value={audio.voiceTarget ?? "content"}
          options={[
            { value: "content", label: "Content (the show)" },
            { value: "mic", label: "My mic" },
            { value: "both", label: "Everyone" },
          ]}
          onChange={(t) => setA({ voiceTarget: t })}
        />
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-black/25 p-2">
          <input
            type="checkbox"
            checked={!!audio.voiceKeepCardAudio}
            onChange={(e) => setA({ voiceKeepCardAudio: e.target.checked })}
            className="mt-0.5 accent-fuchsia-400"
          />
          <span className="text-[10px] leading-relaxed text-slate-400">
            <b className="text-slate-200">Keep the audio under cards</b> — with the voice changed,
            card sections don&apos;t need muting: the whole altered audio keeps playing through
            every card. Mute sections still silence; cut parts, intro and outro are never altered
            (only the reaction part is).
          </span>
        </label>
        <Segmented
          value={audio.voiceMode ?? "morph"}
          options={[
            { value: "morph", label: "Built-in morph · no setup" },
            { value: "rvc", label: "AI character (RVC)" },
            { value: "fx", label: "Basic FX" },
          ]}
          onChange={(m) => setA({ voiceMode: m })}
        />
        {(audio.voiceMode ?? "morph") === "morph" ? (
          <div className="mt-2 space-y-2">
            <p className="text-[10px] leading-relaxed text-slate-400">
              The default engine, written into the Colab backend: resampling + a phase-vocoder
              vocal-tract warp + vibrato, breath and tilt. <b>Nothing to install, no model file, no
              download</b> — it runs about 10× faster than realtime on the Colab CPU, so it works on
              a free runtime with no GPU at all.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MORPH_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  title={p.hint}
                  onClick={() => setA({ morphPreset: p.value })}
                  className={
                    (audio.morphPreset ?? "incognito") === p.value
                      ? "rounded border border-fuchsia-400/40 bg-fuchsia-500/15 px-2 py-1 text-[11px] font-semibold text-fuchsia-100"
                      : "rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Slider
              label="Strength"
              value={audio.morphStrength ?? 85}
              min={0}
              max={100}
              step={1}
              display={`${Math.round(audio.morphStrength ?? 85)}%`}
              onChange={(v) => setA({ morphStrength: v })}
              hint="0% = untouched, 100% = the full character. Around 70–90% is the sweet spot for a dub that still sounds human"
            />
            <Slider
              label="Vocal tract"
              value={Math.round((audio.morphFormant ?? 1) * 100)}
              min={50}
              max={200}
              step={1}
              display={`${((audio.morphFormant ?? 1) * 100).toFixed(0)}%`}
              onChange={(v) => setA({ morphFormant: v / 100 })}
              hint="formant shift without touching the pitch: under 100% = bigger throat, over = smaller. 100% = the preset's own"
            />
            <Slider
              label="Character seed"
              value={audio.morphSeed ?? 0}
              min={0}
              max={9999}
              step={1}
              display={`#${audio.morphSeed ?? 0}`}
              onChange={(v) => setA({ morphSeed: Math.round(v) })}
              hint="a different seed is a different voice from the same preset — same seed on every render keeps one character across all your videos"
            />
            {(audio.voiceTarget ?? "content") === "both" && (
              <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-2">
                <span className="block text-[10px] uppercase tracking-wide text-slate-500">
                  Second character for your mic (optional)
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {MORPH_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      title={p.hint}
                      onClick={() => setA({ voicePresetMic: p.value })}
                      className={
                        (audio.voicePresetMic ?? "") === p.value
                          ? "rounded border border-sky-400/40 bg-sky-500/15 px-2 py-1 text-[11px] font-semibold text-sky-100"
                          : "rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                      }
                    >
                      {p.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setA({ voicePresetMic: "" })}
                    className="rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    same as content
                  </button>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                    Mic seed (optional)
                  </span>
                  <input
                    type="number"
                    value={String(audio.morphSeedMic ?? "")}
                    onChange={(e) => setA({ morphSeedMic: e.target.value })}
                    placeholder="same as content"
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
                  />
                </label>
              </div>
            )}
            <Note>
              The morph runs on the export backend in one pass over the whole programme — a few
              seconds per minute of video, no GPU, no torch, no model file. The re-voiced audio is
              saved on Drive (<code>output/voice_cache</code>): a re-render with the same voice
              settings pulls it from there instead of running the engine again — so you can tweak
              cards or mirroring and re-export without paying for the voice a second time.
            </Note>
          </div>
        ) : (audio.voiceMode ?? "morph") === "rvc" ? (
          <div className="mt-2 space-y-2">
            <p className="text-[10px] leading-relaxed text-slate-400">
              Real neural voice conversion with an RVC model (<code>.pth</code> + optional{" "}
              <code>.index</code>) — a different person speaking, not a pitch trick. Give a path, an{" "}
              <code>https://</code> URL or <code>hf:owner/repo/file.pth</code> and the notebook
              fetches it into its voice cache for you (<code>rvc-python</code> installs itself the
              first time). Leave it empty — or write <code>builtin:morph</code> — to use the
              built-in engine instead.
            </p>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Model — path, https URL or hf:repo/file.pth
              </span>
              <input
                type="text"
                value={audio.rvcModel ?? ""}
                onChange={(e) => setA({ rvcModel: e.target.value })}
                placeholder="/content/drive/MyDrive/voices/someone.pth"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Index file (.index) — optional, sharper likeness
              </span>
              <input
                type="text"
                value={audio.rvcIndex ?? ""}
                onChange={(e) => setA({ rvcIndex: e.target.value })}
                placeholder="/content/drive/MyDrive/voices/someone.index"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
                spellCheck={false}
              />
            </label>
            <Slider
              label="Transpose"
              value={audio.rvcTranspose ?? 0}
              min={-12}
              max={12}
              step={1}
              display={`${(audio.rvcTranspose ?? 0) > 0 ? "+" : ""}${audio.rvcTranspose ?? 0} st`}
              onChange={(v) => setA({ rvcTranspose: v })}
              hint="match the character to the source range: male→female ≈ +12, female→male ≈ −12"
            />
            <Slider
              label="Index rate"
              value={Math.round((audio.rvcIndexRate ?? 0.5) * 100)}
              min={0}
              max={100}
              step={1}
              display={`${Math.round((audio.rvcIndexRate ?? 0.5) * 100)}%`}
              onChange={(v) => setA({ rvcIndexRate: v / 100 })}
              hint="how much of the character's timbre to pull from the .index"
            />
            <div>
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Pitch detection
              </span>
              <Segmented
                value={audio.rvcMethod ?? "rmvpe"}
                size="sm"
                options={[
                  { value: "rmvpe", label: "rmvpe · robust" },
                  { value: "crepe", label: "crepe · clean" },
                  { value: "pm", label: "pm · fast" },
                ]}
                onChange={(m) => setA({ rvcMethod: m })}
              />
            </div>
            <p className="text-[10px] text-amber-300/70">
              RVC is GPU-hungry: on a CPU-only runtime one minute of audio can take several minutes.
              If you hit that, switch the engine to <b>Built-in morph</b> — it is the same re-voicing
              job at ~10× realtime, with no install and no model.
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {(["anon", "deep", "high", "robot", "custom"] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setA({ voicePreset: preset })}
                  className={
                    audio.voicePreset === preset
                      ? "rounded border border-fuchsia-400/40 bg-fuchsia-500/15 px-2 py-1 text-[11px] font-semibold text-fuchsia-100"
                      : "rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                  }
                >
                  {preset === "anon"
                    ? "Anon"
                    : preset === "deep"
                    ? "Deep"
                    : preset === "high"
                    ? "High"
                    : preset === "robot"
                    ? "Robot"
                    : "Custom"}
                </button>
              ))}
            </div>
            <Slider
              label="Strength"
              value={audio.voiceStrength}
              min={0}
              max={100}
              step={1}
              display={`${audio.voiceStrength}%`}
              onChange={(v) => setA({ voiceStrength: v })}
              hint="how much to transform — 100% = full change"
            />
            {audio.voicePreset === "custom" && (
              <Slider
                label="Custom pitch"
                value={audio.voicePitch}
                min={-6}
                max={6}
                step={0.5}
                display={`${audio.voicePitch > 0 ? "+" : ""}${audio.voicePitch.toFixed(1)} st`}
                onChange={(v) => setA({ voicePitch: v })}
                hint="extra pitch shift for custom preset"
              />
            )}
            <p className="text-[10px] text-amber-300/70">
              Plain ffmpeg pitch/formant tricks — fast, but a determined matcher can still see
              through them. The built-in morph is strictly better at the same cost.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Sticker / overlay image"
        right={
          <button
            type="button"
            onClick={() => setS({ on: !sticker.on })}
            className={
              sticker.on
                ? "rounded border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-200"
                : "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400"
            }
          >
            {sticker.on ? "on" : "off"}
          </button>
        }
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          A transparent image (subscribe, like, your logo…) placed in a free corner of the frame.
          Shown during the <b>reaction part only</b> — never over intro/outro.
        </p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            <Btn variant="primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : remote ? "Upload image to notebook" : "Choose image"}
            </Btn>
            {sticker.src && (
              <Btn onClick={() => setS({ src: "" })} title="Remove the image">
                Clear
              </Btn>
            )}
            {previewSrc && (
              <img
                src={previewSrc}
                alt="sticker preview"
                className="h-9 max-w-[72px] rounded border border-white/10 bg-[repeating-conic-gradient(#1e293b_0%_25%,#0f172a_0%_50%)] bg-[length:12px_12px] object-contain"
              />
            )}
          </div>
          {uploadErr && <p className="text-[10px] text-rose-300">{uploadErr}</p>}
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              {remote
                ? "Image on the notebook (uploaded name or a Drive path)"
                : "Image source"}
            </span>
            <input
              type="text"
              value={sticker.src}
              onChange={(e) => setS({ src: e.target.value })}
              placeholder={remote ? "subscribe.png or /content/drive/MyDrive/img/sub.png" : ""}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-sky-400/50"
              spellCheck={false}
            />
          </label>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Slider
              label="Position X"
              value={Math.round(sticker.x * 100)}
              min={0}
              max={100}
              step={1}
              display={`${Math.round(sticker.x * 100)}%`}
              onChange={(v) => setS({ x: v / 100 })}
              hint="left edge of the image"
            />
            <Slider
              label="Position Y"
              value={Math.round(sticker.y * 100)}
              min={0}
              max={100}
              step={1}
              display={`${Math.round(sticker.y * 100)}%`}
              onChange={(v) => setS({ y: v / 100 })}
              hint="top edge of the image"
            />
            <Slider
              label="Size"
              value={Math.round(sticker.w * 100)}
              min={2}
              max={60}
              step={1}
              display={`${Math.round(sticker.w * 100)}% of width`}
              onChange={(v) => setS({ w: v / 100 })}
              hint="height follows the image's own aspect"
            />
            <Slider
              label="Opacity"
              value={Math.round(sticker.opacity * 100)}
              min={0}
              max={100}
              step={1}
              display={`${Math.round(sticker.opacity * 100)}%`}
              onChange={(v) => setS({ opacity: v / 100 })}
              hint="for a subtle watermark pull it down to ~60%"
            />
          </div>
        </div>
      </Section>

      <Section
        title="Mirroring (anti-Content ID)"
        right={
          <span className="font-mono text-[10px] text-slate-500">
            {mirrorMode === "off"
              ? "off"
              : mirrorMode === "frame"
              ? "whole picture"
              : "content only"}
            {mirrorMode !== "off" && mirrorScope === "blocks" && ` · ${ticked} blocks`}
          </span>
        }
      >
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Flipping the watched programme is the strongest single anti-fingerprint move — it
          destroys frame hashes while everything else stays the same length. Intro and outro are
          never mirrored (they stay exactly as recorded, like every disguise here).
        </p>
        <div className="space-y-2">
          <Segmented
            value={mirrorMode}
            options={[
              { value: "off", label: "Off" },
              { value: "content", label: "Content only" },
              { value: "frame", label: "Whole picture" },
            ]}
            onChange={(m) =>
              // the legacy flags are cleared so the mode is the only truth
              setV({ mirrorMode: m, flip: false, flipContent: false })
            }
          />
          <p className="text-[10px] leading-relaxed text-slate-500">
            {MIRROR_MODE_META[mirrorMode].hint}
          </p>

          <div>
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Which blocks
            </span>
            <Segmented
              value={mirrorScope}
              options={[
                { value: "reaction", label: "Reaction part" },
                { value: "blocks", label: "Only the blocks I tick" },
              ]}
              onChange={(s) => setV({ mirrorScope: s })}
            />
          </div>

          {mirrorMode === "content" && (
            <Slider
              label="Keep the bottom as recorded"
              value={Math.round((video.mirrorKeepBottom ?? 0) * 100)}
              min={0}
              max={60}
              step={5}
              display={
                (video.mirrorKeepBottom ?? 0) > 0
                  ? `bottom ${Math.round((video.mirrorKeepBottom ?? 0) * 100)}%`
                  : "mirror everything"
              }
              onChange={(v) => setV({ mirrorKeepBottom: v / 100 })}
              hint="the strip that stays readable — subtitles and burned-in captions live down there, and a short card already shows the bottom 25%"
            />
          )}

          {mirrorScope === "blocks" && (
            <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Blocks</span>
                <span className="font-mono text-[10px] text-sky-300">
                  {ticked}/{tickable.length}
                </span>
                <button
                  type="button"
                  onClick={() => onSetAllMirror(true)}
                  className="ml-auto rounded border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-100 hover:bg-sky-500/25"
                >
                  Tick all reaction
                </button>
                <button
                  type="button"
                  onClick={() => onSetAllMirror(false)}
                  className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-white/10"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-0.5">
                {segments.length === 0 && (
                  <p className="px-1 py-1 text-[10px] text-slate-500">No timeline yet.</p>
                )}
                {segments.map((s) => {
                  const locked = clean(s);
                  const on = !!s.mirror && !locked;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={locked}
                      title={
                        locked
                          ? "Intro / outro stay exactly as recorded — never mirrored"
                          : on
                          ? "Mirrored — click to leave this block as recorded"
                          : "As recorded — click to mirror this block"
                      }
                      onClick={() => onToggleMirror(s.id)}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left",
                        on
                          ? "border-sky-400/40 bg-sky-500/15"
                          : "border-white/10 bg-black/25 hover:border-white/25",
                        locked && "cursor-not-allowed opacity-40"
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1 py-[1px] text-[9px] font-bold uppercase",
                          SEGMENT_META[s.type].chip
                        )}
                      >
                        {SEGMENT_META[s.type].short}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400">
                        {fmtTime(s.start, true)}–{fmtTime(s.end, true)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-[10px] font-semibold",
                          locked ? "text-slate-600" : on ? "text-sky-200" : "text-slate-600"
                        )}
                      >
                        {locked ? "clean" : on ? "mirrored" : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 px-1 text-[10px] leading-relaxed text-slate-500">
                Rebuilding the timeline (auto-cut, polish, fair-use) creates new blocks and clears
                the ticks — re-tick them here when you are happy with the cut.
              </p>
            </div>
          )}

          <Note>
            {mirrorMode === "off"
              ? "Pick a mode, then scrub the reaction part to see it. The ffmpeg render applies exactly the same flip."
              : mirrorScope === "blocks" && ticked === 0
              ? "No block is ticked yet — nothing will be mirrored. Tick the blocks above, or switch to “Reaction part”."
              : "Preview follows the export: the mirror lands on the reaction spans only, and card text is redrawn unflipped over a mirrored frame."}
          </Note>
          {mirrorMode !== "off" && firstReaction && (
            <Btn
              className="w-full"
              onClick={() => onSeek(firstReaction.start + (firstReaction.end - firstReaction.start) / 2)}
            >
              Jump to a reaction block to see it
            </Btn>
          )}
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
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Reaction part only — intro and outro frames pass through untouched.
        </p>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setV({ contentOnly: !video.contentOnly })} className={video.contentOnly ? "rounded border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] font-semibold text-emerald-100" : "rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] font-semibold text-slate-400"}>{video.contentOnly ? "Content-only ON" : "Content-only OFF"}</button>
            <span className="text-[10px] text-slate-500 pt-1">When ON, zoom/blur/hue affect only content, camera stays clean (fixes black bars/crop)</span>
          </div>
          <Slider
            label="Punch-in zoom"
            value={video.zoom}
            min={1}
            max={1.12}
            step={0.005}
            display={`${Math.round((video.zoom - 1) * 1000) / 10}%`}
            onChange={(v) => setV({ zoom: v })}
            hint={video.contentOnly ? "zooms only content rect" : "crops away edge pixels that fingerprints rely on"}
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
            <Slider label="Subtle blur" value={video.blur} min={0} max={3} step={0.1} display={video.blur ? `${video.blur.toFixed(1)}px` : "off"} onChange={(v) => setV({ blur: v })} hint="breaks pixel hashes, keep low" />
            <Slider label="Rotate" value={video.rotate} min={-5} max={5} step={0.25} display={`${video.rotate > 0 ? "+" : ""}${video.rotate.toFixed(2)}°`} onChange={(v) => setV({ rotate: v })} hint="slight tilt adds black edges" />
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
            Mirroring lives in its own <b>Mirroring</b> section above, with the per-block ticks and
            the subtitle-safe strip.
          </p>
          <div className="mt-3 rounded border border-violet-400/20 bg-violet-500/10 p-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-violet-200">Fisheye lens (content only)</span>
              <button type="button" onClick={() => setV({ fisheye: !video.fisheye })} className={video.fisheye ? "rounded border border-violet-400/40 bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-100" : "rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400"}>{video.fisheye ? "on" : "off"}</button>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">Distorts content area like a fisheye lens — strong anti-ContentID, camera stays clean. Applies to the reaction parts only — intro/outro (full-cam) stay untouched. Off by default.</p>
            {video.fisheye && (
              <div className="mt-2">
                <Slider label="Fisheye strength" value={video.fisheyeAmount} min={0} max={100} step={1} display={`${video.fisheyeAmount}%`} onChange={(v) => setV({ fisheyeAmount: v })} hint="higher = more bulge distortion, breaks frame hash" />
              </div>
            )}
          </div>
          <div className="mt-2">
            <Slider label="Global speed tweak" value={video.speed} min={0.95} max={1.05} step={0.01} display={`${video.speed.toFixed(2)}×`} onChange={(v) => setV({ speed: v })} hint="reaction part only — intro/outro always play at 1.00×" />
          </div>
        </div>
      </Section>

      <Section title="How to use it">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Every setting on this page touches the <b>reaction part only</b> — your intro and outro
          are exported exactly as recorded (no video disguise, no audio cloak, no voice changer,
          no sticker, no speed tweak). Start gentle and check after upload — these are a starting
          point, push further only where claims actually land. Small values already move the
          needle; large values annoy viewers faster than they fool matchers.
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
