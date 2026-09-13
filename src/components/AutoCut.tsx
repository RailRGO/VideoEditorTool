import { useEffect, useRef, useState } from "react";
import type { CutOptions, LayoutState, TranscriptCutOptions, VideoCloak } from "../lib/types";
import type { Detection, Envelope } from "../lib/analyze";
import type { Transcript } from "../lib/polish";
import { fmtTime } from "../lib/timeline";
import { Btn, Note, Section, Segmented, Slider, Toggle } from "./ui";
import { analyseTranscriptCut } from "../lib/transcriptCut";
import type { FairUseOptions } from "../lib/fairUseCut";
import { buildFairUseLimit } from "../lib/fairUseCut";

function EnvelopeChart({
  env,
  detection,
  introOutro,
  getSrcTime,
}: {
  env: Envelope;
  detection: Detection;
  introOutro: { start: number; end: number }[];
  getSrcTime: () => number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const draw = () => {
      const c = cv.current;
      const box = wrap.current;
      if (!c || !box) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = box.clientWidth;
      const H = box.clientHeight;
      if (!W || !H) return;
      if (c.width !== W * dpr || c.height !== H * dpr) {
        c.width = W * dpr;
        c.height = H * dpr;
      }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const LO = -70;
      const HI = -8;
      const n = env.db.length;
      const y = (db: number) => H - ((Math.min(HI, Math.max(LO, db)) - LO) / (HI - LO)) * H;

      ctx.fillStyle = "rgba(139,92,246,0.16)";
      for (const s of introOutro) {
        ctx.fillRect((s.start / env.duration) * W, 0, ((s.end - s.start) / env.duration) * W, H);
      }

      ctx.fillStyle = "rgba(56,189,248,0.16)";
      for (const r of detection.regions) {
        ctx.fillRect((r.start / env.duration) * W, 0, ((r.end - r.start) / env.duration) * W, H);
      }

      ctx.fillStyle = "rgba(148,163,184,0.75)";
      const step = W / n;
      for (let i = 0; i < n; i++) {
        const v = y(env.db[i]);
        ctx.fillRect(i * step, v, Math.max(0.6, step), H - v);
      }

      ctx.strokeStyle = "rgba(251,191,36,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y(detection.thresholdDb));
      ctx.lineTo(W, y(detection.thresholdDb));
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(0, y(detection.floorDb));
      ctx.lineTo(W, y(detection.floorDb));
      ctx.stroke();
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [env, detection, introOutro]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      const node = head.current;
      if (!node || !env.duration) return;
      const pct = `${Math.min(100, (getSrcTime() / env.duration) * 100)}%`;
      if (node.style.left !== pct) node.style.left = pct;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [env, getSrcTime]);

  return (
    <div ref={wrap} className="relative h-[92px] w-full overflow-hidden rounded-lg bg-black/50 ring-1 ring-inset ring-white/10">
      <canvas ref={cv} className="block h-full w-full" />
      <div ref={head} className="pointer-events-none absolute bottom-0 top-0 w-[2px] -translate-x-1/2 bg-rose-400/90" />
      <span className="pointer-events-none absolute bottom-1 left-1.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300/80">
        intro / outro (kept whole)
      </span>
      <span className="pointer-events-none absolute right-1.5 top-1 text-[9px] font-semibold uppercase tracking-wider text-amber-300/80">
        speech threshold
      </span>
    </div>
  );
}

export default function AutoCut({
  hasSource,
  duration,
  scanning,
  scanProgress,
  env,
  detection,
  opts,
  setOpts,
  layout,
  setLayout,
  scanSpeed,
  setScanSpeed,
  onScan,
  onStopScan,
  onApply,
  onReset,
  estimate,
  getSrcTime,
  introOutro,
  browserOk,
  mixed = false,
  transcript,
  transcriptCutOpts,
  setTranscriptCutOpts,
  onTranscriptFile,
  onTranscriptText,
  canTranscribe,
  trBusy,
  trProgress,
  trLang,
  setTrLang,
  onTranscribe,
  trError,
  onApplyTranscriptCut,
  bodySpan,
  fairUseOpts,
  setFairUseOpts,
  onApplyFairUse,
  videoCloak,
  setVideoCloak,
}: {
  hasSource: boolean;
  duration: number;
  scanning: boolean;
  scanProgress: number;
  env: Envelope | null;
  detection: Detection | null;
  opts: CutOptions;
  setOpts: React.Dispatch<React.SetStateAction<CutOptions>>;
  layout: LayoutState;
  setLayout: React.Dispatch<React.SetStateAction<LayoutState>>;
  scanSpeed: number;
  setScanSpeed: (v: number) => void;
  onScan: () => void;
  onStopScan: () => void;
  onApply: () => void;
  onReset: () => void;
  estimate: number;
  getSrcTime: () => number;
  introOutro: { start: number; end: number }[];
  browserOk: boolean;
  mixed?: boolean;
  transcript: Transcript | null;
  transcriptCutOpts: TranscriptCutOptions;
  setTranscriptCutOpts: React.Dispatch<React.SetStateAction<TranscriptCutOptions>>;
  onTranscriptFile: (f: File) => void;
  onTranscriptText: (t: string) => void;
  canTranscribe: boolean;
  trBusy: boolean;
  trProgress: number;
  trLang: string;
  setTrLang: (v: string) => void;
  onTranscribe: () => void;
  trError: string;
  onApplyTranscriptCut: () => void;
  bodySpan: { start: number; end: number };
  fairUseOpts: FairUseOptions;
  setFairUseOpts: React.Dispatch<React.SetStateAction<FairUseOptions>>;
  onApplyFairUse: () => void;
  videoCloak: VideoCloak;
  setVideoCloak: React.Dispatch<React.SetStateAction<VideoCloak>>;
}) {
  const density =
    detection && duration > 0 ? (detection.speechSec / duration) * 100 : 0;
  const bodySec = introOutro.length
    ? Math.max(0, duration - introOutro.reduce((a, s) => a + (s.end - s.start), 0))
    : duration;
  const bodyDensity = detection && bodySec > 0 ? (detection.speechSec / bodySec) * 100 : 0;

  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  const trReport = (() => {
    if (!transcript?.words?.length || !duration) return null;
    try {
      return analyseTranscriptCut(
        [],
        transcript.words,
        duration,
        transcriptCutOpts,
        bodySpan
      );
    } catch {
      return null;
    }
  })();

  const fairUsePreview = (() => {
    if (!duration || bodySpan.end - bodySpan.start < 1) return null;
    try {
      const speech = transcript?.timed ? transcript.words : detection?.regions ?? null;
      const { report } = buildFairUseLimit(
        [],
        duration,
        fairUseOpts,
        speech as any,
        bodySpan,
        detection?.regions ?? null
      );
      // When passing empty segments, report uses bodySpan as original
      // So compute original from bodySpan
      const orig = bodySpan.end - bodySpan.start;
      return { ...report, originalBody: orig, limitedBody: Math.min(orig, fairUseOpts.maxBodySec), saved: Math.max(0, orig - fairUseOpts.maxBodySec) };
    } catch {
      return null;
    }
  })();

  const bodyCurrent = bodySpan.end - bodySpan.start;

  return (
    <div className="space-y-2.5">
      <Section title="1 · Find your commentary (audio level)">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          {mixed
            ? "The auto-cut plays your Patreon render once (silently, at high speed) and measures the mixed audio, then keeps only the stretches where you are actually talking — plus a little context on each side. Intro and outro are never touched."
            : "The auto-cut plays your recording once (silently, at high speed) and measures the mic channel, then keeps only the stretches where you are actually talking — plus a little context on each side. Intro and outro are never touched."}
        </p>
        <div className="flex items-center gap-1.5">
          <Segmented
            className="w-[128px]"
            value={String(scanSpeed)}
            onChange={(v) => setScanSpeed(Number(v))}
            options={[
              { value: "2", label: "2×" },
              { value: "4", label: "4×" },
              { value: "8", label: "8×" },
            ]}
          />
          {scanning ? (
            <Btn variant="danger" className="flex-1" onClick={onStopScan}>
              Stop scan
            </Btn>
          ) : (
            <Btn
              variant="primary"
              className="flex-1 py-1.5"
              disabled={!hasSource || !browserOk}
              onClick={onScan}
            >
              {mixed ? "Analyse audio" : "Analyse mic track"}
            </Btn>
          )}
        </div>
        {scanning && (
          <>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/50 ring-1 ring-inset ring-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
                style={{ width: `${Math.round(scanProgress * 100)}%` }}
              />
            </div>
            <p className="mt-1 font-mono text-[10px] text-sky-300">
              {Math.round(scanProgress * 100)}% · about{" "}
              {fmtTime(Math.max(0, (duration * (1 - scanProgress)) / scanSpeed))} left
            </p>
          </>
        )}
        {!browserOk && (
          <p className="mt-2 text-[10px] text-amber-300">
            This browser can’t run the level scanner. Chrome or Edge on desktop will.
          </p>
        )}
      </Section>

      {env && detection && (
        <>
          <Section title={mixed ? "Level over time" : "Mic level over time"}>
            <EnvelopeChart
              env={env}
              detection={detection}
              introOutro={introOutro}
              getSrcTime={getSrcTime}
            />
            <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">talk time</p>
                <p className="font-mono text-[13px] text-sky-300">{fmtTime(detection.speechSec)}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">of the reaction</p>
                <p className="font-mono text-[13px] text-sky-300">{bodyDensity.toFixed(0)}%</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">bursts</p>
                <p className="font-mono text-[13px] text-sky-300">{detection.bursts}</p>
              </div>
            </div>
            <p className="mt-2 font-mono text-[10px] text-slate-500">
              floor {detection.floorDb.toFixed(1)} dB · threshold {detection.thresholdDb.toFixed(1)} dB
            </p>
          </Section>

          <Section title="2 · Tune the cut">
            <div className="space-y-2">
              <Slider
                label="Sensitivity"
                value={opts.marginDb}
                min={2}
                max={20}
                step={0.5}
                display={`+${opts.marginDb} dB`}
                onChange={(v) => setOpts((o) => ({ ...o, marginDb: v }))}
                hint="how far above your room noise a sound has to be to count as you talking"
              />
              <Slider
                label="Context before / after"
                value={opts.pad}
                min={0}
                max={5}
                step={0.1}
                display={`${opts.pad.toFixed(1)} s`}
                onChange={(v) => setOpts((o) => ({ ...o, pad: v }))}
                hint="breathing room around each remark so it never starts mid-word"
              />
              <Slider
                label="Bridge silences up to"
                value={opts.maxGap}
                min={0.1}
                max={8}
                step={0.1}
                display={`${opts.maxGap.toFixed(1)} s`}
                onChange={(v) => setOpts((o) => ({ ...o, maxGap: v }))}
                hint="a pause shorter than this stays in the video instead of cutting"
              />
              <Slider
                label="Ignore blips under"
                value={opts.minSpeech}
                min={0.1}
                max={3}
                step={0.05}
                display={`${opts.minSpeech.toFixed(2)} s`}
                onChange={(v) => setOpts((o) => ({ ...o, minSpeech: v }))}
                hint="coughs, chair creaks, key clicks"
              />
              <Slider
                label="Drop islands shorter than"
                value={opts.minKeep}
                min={0.3}
                max={10}
                step={0.1}
                display={`${opts.minKeep.toFixed(1)} s`}
                onChange={(v) => setOpts((o) => ({ ...o, minKeep: v }))}
                hint="a two-word remark isn’t worth a cut on both sides of it"
              />
            </div>
          </Section>

          <Section title="3 · What happens between your remarks">
            <Segmented
              value={opts.replace}
              onChange={(v) => setOpts((o) => ({ ...o, replace: v }))}
              options={[
                { value: "card", label: "Card" },
                { value: "fast", label: "Fast-fwd" },
                { value: "cut", label: "Hard cut" },
              ]}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              {opts.replace === "card" &&
                "The content area becomes a placeholder — your camera stays in its corner and the viewer is pointed at Patreon. Nothing copyrighted is shown or heard."}
              {opts.replace === "fast" &&
                "The skipped part stays visible but sped up, so the video still makes sense. Content audio keeps playing (ducked, and quieter)."}
              {opts.replace === "cut" &&
                "The part is simply removed. Shortest possible video, but the viewer loses all context for what they’re reacting to."}
            </p>
            {opts.replace === "card" && (
              <div className="mt-2 space-y-1.5">
                <input
                  value={layout.card.title}
                  onChange={(e) =>
                    setLayout((l) => ({ ...l, card: { ...l.card, title: e.target.value } }))
                  }
                  placeholder="Card headline"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
                />
                <input
                  value={layout.card.sub}
                  onChange={(e) =>
                    setLayout((l) => ({ ...l, card: { ...l.card, sub: e.target.value } }))
                  }
                  placeholder="Card sub-line"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
                />
              </div>
            )}
            {opts.replace === "fast" && (
              <div className="mt-2 space-y-2">
                <Slider
                  label="Speed"
                  value={layout.fastSpeed}
                  min={1.5}
                  max={12}
                  step={0.5}
                  display={`${layout.fastSpeed}×`}
                  onChange={(v) => setLayout((l) => ({ ...l, fastSpeed: v }))}
                />
                <Slider
                  label="Content audio while fast"
                  value={layout.fastGainDb}
                  min={-30}
                  max={0}
                  step={1}
                  display={`${layout.fastGainDb} dB`}
                  onChange={(v) => setLayout((l) => ({ ...l, fastGainDb: v }))}
                />
                <Toggle
                  label="Let the pitch rise with speed"
                  hint="the classic fast-forward sound"
                  value={layout.chipmunk}
                  onChange={(v) => setLayout((l) => ({ ...l, chipmunk: v }))}
                />
              </div>
            )}
          </Section>

          <Section title="4 · Apply audio cut">
            <div className="mb-2 grid grid-cols-2 gap-1.5 text-center">
              <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">source</p>
                <p className="font-mono text-[13px] text-slate-200">{fmtTime(duration)}</p>
              </div>
              <div className="rounded-lg border border-sky-400/30 bg-sky-500/10 p-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-400">after cut</p>
                <p className="font-mono text-[13px] text-sky-300">{fmtTime(estimate)}</p>
              </div>
            </div>
            <div className="flex gap-1.5">
              <Btn variant="primary" className="flex-1 py-1.5" onClick={onApply}>
                Apply audio cut to timeline
              </Btn>
              <Btn onClick={onReset} title="Restore a plain intro / reaction / outro timeline">
                Reset
              </Btn>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              Rewrites only the reaction part — you can still drag every segment afterwards.
            </p>
          </Section>
        </>
      )}

      <Section title="5 · Silent gaps → Patreon card (transcript)">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          Transcribe your commentary, then every stretch <em>without words</em> becomes a card that
          points to Patreon. The content area is covered (camera corner stays), audio silenced,
          and the rest of the silent stretch is hard-cut. Short pauses under 1 s can stay, be
          fast-forwarded, or muted — your call. This is the strongest Content ID shield because
          long no-dialog sections simply disappear.
        </p>

        {canTranscribe ? (
          <div className="mb-2 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.07] p-2">
            <div className="flex items-center gap-1.5">
              <select
                value={trLang}
                disabled={trBusy}
                onChange={(e) => setTrLang(e.target.value)}
                className="h-7 shrink-0 rounded-lg border border-white/10 bg-black/40 px-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-400/50 disabled:opacity-50"
                title="Spoken language"
              >
                <option value="auto">Auto</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
              <Btn
                variant="primary"
                className="flex-1"
                disabled={trBusy || !hasSource}
                onClick={onTranscribe}
              >
                {trBusy
                  ? `Transcribing… ${Math.round(trProgress * 100)}%`
                  : "Transcribe reaction (body)"}
              </Btn>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
              Runs Whisper on the server against the reaction part only — much faster than full
              file. Or load a .srt / .vtt / .json below.
            </p>
            {trError && (
              <p className="mt-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[10px] leading-relaxed text-rose-200">
                {trError}
              </p>
            )}
          </div>
        ) : (
          <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
            Load a transcript file below — Whisper SRT/VTT/JSON with word timestamps works best.
            (Connect Colab to transcribe directly.)
          </p>
        )}

        <div className="flex gap-1.5">
          <Btn className="flex-1" onClick={() => fileRef.current?.click()}>
            Load .srt / .vtt / .json
          </Btn>
          <Btn className="flex-1" onClick={() => setShowPaste((s) => !s)}>
            Paste
          </Btn>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,.vtt,.txt,.json,text/plain,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onTranscriptFile(f);
          }}
        />
        {showPaste && (
          <div className="mt-2">
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={"00:00:01,000 --> 00:00:04,000\nso um today we're going to…"}
              className="w-full resize-y rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[10px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-violet-400/50"
            />
            <Btn variant="primary" className="mt-1.5 w-full" onClick={() => onTranscriptText(paste)}>
              Use this transcript
            </Btn>
          </div>
        )}

        {transcript && (
          <div className="mt-2 rounded-lg border border-white/10 bg-black/25 p-2">
            <p className="text-[10px] text-slate-400">
              {transcript.words.length} words ·{" "}
              <span className={transcript.timed ? "text-emerald-300" : "text-amber-300"}>
                {transcript.timed ? "timed" : "no timings"}
              </span>{" "}
              · {transcript.source}
            </p>
            <p className="mt-1 max-h-20 overflow-y-auto text-[11px] leading-relaxed text-slate-300">
              {transcript.words.map((w) => w.text).join(" ").slice(0, 600)}
              {transcript.words.length > 120 ? "…" : ""}
            </p>
          </div>
        )}

        {transcript?.timed && (
          <div className="mt-3 space-y-2">
            <Slider
              label="Silence ≥ becomes card+cut"
              value={transcriptCutOpts.minSilence}
              min={0.5}
              max={10}
              step={0.25}
              display={`${transcriptCutOpts.minSilence.toFixed(2)} s`}
              onChange={(v) => setTranscriptCutOpts((o) => ({ ...o, minSilence: v }))}
              hint="long no-dialog stretches become a Patreon card, rest cut"
            />
            <Slider
              label="Card lasts"
              value={transcriptCutOpts.cardDuration}
              min={1}
              max={8}
              step={0.5}
              display={`${transcriptCutOpts.cardDuration.toFixed(1)} s`}
              onChange={(v) => setTranscriptCutOpts((o) => ({ ...o, cardDuration: v }))}
              hint="fixed card duration inserted for each long silence"
            />
            <div className="grid grid-cols-2 gap-x-3">
              <Slider
                label="Ignore gaps <"
                value={transcriptCutOpts.minGap}
                min={0}
                max={1}
                step={0.05}
                display={`${transcriptCutOpts.minGap.toFixed(2)} s`}
                onChange={(v) => setTranscriptCutOpts((o) => ({ ...o, minGap: v }))}
              />
              <Slider
                label="Word padding"
                value={transcriptCutOpts.pad}
                min={0}
                max={1}
                step={0.05}
                display={`${transcriptCutOpts.pad.toFixed(2)} s`}
                onChange={(v) => setTranscriptCutOpts((o) => ({ ...o, pad: v }))}
                hint="context kept before/after each word"
              />
            </div>
            <div className="grid grid-cols-2 gap-x-3">
              <Slider
                label="Merge words within"
                value={transcriptCutOpts.mergeGap}
                min={0.2}
                max={3}
                step={0.1}
                display={`${transcriptCutOpts.mergeGap.toFixed(1)} s`}
                onChange={(v) => setTranscriptCutOpts((o) => ({ ...o, mergeGap: v }))}
                hint="words closer than this are same speech burst"
              />
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Tiny silences (&lt; {transcriptCutOpts.minSilence.toFixed(1)}s)
                </p>
                <Segmented
                  value={transcriptCutOpts.tinyAction}
                  onChange={(v) => setTranscriptCutOpts((o) => ({ ...o, tinyAction: v }))}
                  options={[
                    { value: "keep", label: "Keep" },
                    { value: "fast", label: "FFWD" },
                    { value: "mute", label: "Mute" },
                  ]}
                />
              </div>
            </div>

            {trReport && (
              <div className="rounded-lg border border-white/10 bg-black/25 p-2">
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded border border-white/10 bg-black/30 p-1">
                    <p className="text-[8px] uppercase tracking-wider text-slate-500">silent gaps</p>
                    <p className="font-mono text-[11px] text-slate-200">{trReport.gaps.length}</p>
                  </div>
                  <div className="rounded border border-fuchsia-400/20 bg-fuchsia-500/10 p-1">
                    <p className="text-[8px] uppercase tracking-wider text-slate-400">will be cards</p>
                    <p className="font-mono text-[11px] text-fuchsia-200">{trReport.largeGaps.length}</p>
                  </div>
                  <div className="rounded border border-rose-400/20 bg-rose-500/10 p-1">
                    <p className="text-[8px] uppercase tracking-wider text-slate-400">time saved</p>
                    <p className="font-mono text-[11px] text-rose-200">{fmtTime(trReport.saved)}</p>
                  </div>
                </div>
                <p className="mt-1.5 font-mono text-[9px] text-slate-500">
                  {trReport.speech.length} speech bursts · {fmtTime(trReport.cardTime)} of cards ·{" "}
                  {trReport.tinyGaps.length} tiny gaps → {transcriptCutOpts.tinyAction}
                </p>
              </div>
            )}

            <Btn
              variant="primary"
              className="w-full py-1.5"
              onClick={onApplyTranscriptCut}
              disabled={!transcript?.timed}
            >
              Apply transcript cut → card+cut
            </Btn>
            <p className="text-[10px] leading-relaxed text-slate-500">
              Rewrites only the reaction part: speech stays, long silences become a {transcriptCutOpts.cardDuration}s
              Patreon card (content area only, camera stays) plus hard cut for the rest. Drag segments after if needed.
            </p>
          </div>
        )}
      </Section>

      <Section title="6 · Fair-use limiter (10 min rule)">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          YouTube fair-use: keep reaction body ≤10 min. Intro/outro are never touched. When you have
          little commentary, this keeps only the most speech-dense parts (from transcript or audio scan)
          and cuts the rest. Use after the transcript cut for best result.
        </p>
        <div className="space-y-2">
          <Slider
            label="Max reaction time"
            value={fairUseOpts.maxBodySec}
            min={60}
            max={900}
            step={30}
            display={fmtTime(fairUseOpts.maxBodySec)}
            onChange={(v) => setFairUseOpts((o) => ({ ...o, maxBodySec: v }))}
            hint="target duration for reaction part only"
          />
          <div className="grid grid-cols-2 gap-x-3">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Removed parts</p>
              <Segmented
                value={fairUseOpts.removedAction}
                onChange={(v) => setFairUseOpts((o) => ({ ...o, removedAction: v as any }))}
                options={[
                  { value: "cut", label: "Cut" },
                  { value: "card", label: "Card" },
                ]}
              />
            </div>
            <Slider
              label="Keep context"
              value={fairUseOpts.keepPad}
              min={0}
              max={3}
              step={0.25}
              display={`${fairUseOpts.keepPad.toFixed(2)} s`}
              onChange={(v) => setFairUseOpts((o) => ({ ...o, keepPad: v }))}
              hint="extra context around kept speech"
            />
          </div>
          <div className="rounded-lg border border-white/10 bg-black/25 p-2">
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded border border-white/10 bg-black/30 p-1">
                <p className="text-[8px] uppercase tracking-wider text-slate-500">reaction now</p>
                <p className="font-mono text-[11px] text-slate-200">{fmtTime(bodyCurrent)}</p>
              </div>
              <div className="rounded border border-emerald-400/20 bg-emerald-500/10 p-1">
                <p className="text-[8px] uppercase tracking-wider text-slate-400">target</p>
                <p className="font-mono text-[11px] text-emerald-200">{fmtTime(fairUseOpts.maxBodySec)}</p>
              </div>
              <div className="rounded border border-amber-400/20 bg-amber-500/10 p-1">
                <p className="text-[8px] uppercase tracking-wider text-slate-400">will save</p>
                <p className="font-mono text-[11px] text-amber-200">{fmtTime(Math.max(0, bodyCurrent - fairUseOpts.maxBodySec))}</p>
              </div>
            </div>
            {fairUsePreview && (
              <p className="mt-1.5 font-mono text-[9px] text-slate-500">
                {fairUsePreview.totalBuckets} sec buckets · keeping most speech-dense {fairUsePreview.keptBuckets} · transcript {transcript?.timed ? "yes" : detection ? "audio scan" : "none (chronological)"}
              </p>
            )}
          </div>
          <Btn
            variant="primary"
            className="w-full py-1.5"
            onClick={onApplyFairUse}
            disabled={!hasSource || bodyCurrent <= fairUseOpts.maxBodySec + 0.5}
          >
            {bodyCurrent > fairUseOpts.maxBodySec + 0.5
              ? `Limit reaction to ${fmtTime(fairUseOpts.maxBodySec)} (keep speech-rich)`
              : "Reaction already within limit"}
          </Btn>
          <p className="text-[10px] leading-relaxed text-slate-500">
            Only rewrites body — intro/outro preserved. Keeps highest-scoring seconds (speech overlap), preserves order, merges neighbours. If no transcript/scan, keeps first {fmtTime(fairUseOpts.maxBodySec)}.
          </p>
        </div>
      </Section>

      <Section title="7 · Video disguise (anti-Content ID)">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          Alter the picture itself so Content ID can’t match frames. Mirror is strongest single trick. Combine with zoom, hue, blur, rotate and audio pitch. Preview shows effect, final render uses same in ffmpeg (hflip, gblur, rotate). GPU (nvenc) will be used if available.
        </p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setVideoCloak((c) => ({ ...c, flip: !c.flip }))}
              className={
                videoCloak.flip
                  ? "rounded border border-fuchsia-400/40 bg-fuchsia-500/15 px-2 py-1 text-[11px] font-semibold text-fuchsia-100"
                  : "rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] font-semibold text-slate-400"
              }
            >
              {videoCloak.flip ? "Mirror ON (hflip)" : "Mirror off"}
            </button>
            <span className="text-[10px] text-slate-500">Flips whole frame horizontally</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <Slider label="Zoom" value={videoCloak.zoom} min={1} max={1.12} step={0.005} display={`${Math.round((videoCloak.zoom - 1) * 1000) / 10}%`} onChange={(v) => setVideoCloak((c) => ({ ...c, zoom: v }))} />
            <Slider label="Blur" value={videoCloak.blur} min={0} max={3} step={0.1} display={videoCloak.blur ? `${videoCloak.blur.toFixed(1)}px` : "off"} onChange={(v) => setVideoCloak((c) => ({ ...c, blur: v }))} />
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <Slider label="Rotate" value={videoCloak.rotate} min={-5} max={5} step={0.25} display={`${videoCloak.rotate > 0 ? "+" : ""}${videoCloak.rotate.toFixed(2)}°`} onChange={(v) => setVideoCloak((c) => ({ ...c, rotate: v }))} />
            <Slider label="Hue" value={videoCloak.hue} min={-30} max={30} step={1} display={`${videoCloak.hue > 0 ? "+" : ""}${videoCloak.hue}°`} onChange={(v) => setVideoCloak((c) => ({ ...c, hue: v }))} />
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <Slider label="Saturation" value={videoCloak.saturate} min={50} max={150} step={1} display={`${videoCloak.saturate}%`} onChange={(v) => setVideoCloak((c) => ({ ...c, saturate: v }))} />
            <Slider label="Speed tweak" value={videoCloak.speed} min={0.95} max={1.05} step={0.01} display={`${videoCloak.speed.toFixed(2)}×`} onChange={(v) => setVideoCloak((c) => ({ ...c, speed: v }))} hint="re-times video+audio together" />
          </div>
        </div>
      </Section>

      {!env && !scanning && hasSource && !transcript && (
        <Note>
          Run the audio analysis or load a transcript. Audio scan takes about {fmtTime(duration / scanSpeed)} at{" "}
          {scanSpeed}×. Transcript mode needs word timestamps.
        </Note>
      )}
      {!hasSource && (
        <Note>
          {mixed
            ? "Load your Patreon render first — the analysis needs its audio to measure."
            : "Load a recording first — the analysis needs the mic channel to measure."}
        </Note>
      )}

      {env && detection && density < 12 && (
        <Note tone="warn">
          <strong>{bodyDensity.toFixed(0)}% of the reaction has you talking.</strong> That’s on the
          quiet side — the cut version will lean heavily on{" "}
          {opts.replace === "cut" ? "hard cuts" : opts.replace === "fast" ? "fast-forward" : "cards"}.
          If you can, try narrating reactions as they happen (“oh wait—”, “no way”, “look at
          this”) — even short interjections give the auto-cut something to hold on to, and they’re
          what makes a cut version worth watching.
        </Note>
      )}
    </div>
  );
}
