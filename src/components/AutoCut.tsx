import { useEffect, useRef } from "react";
import type { CutOptions, LayoutState } from "../lib/types";
import type { Detection, Envelope } from "../lib/analyze";
import { fmtTime } from "../lib/timeline";
import { Btn, Note, Section, Segmented, Slider, Toggle } from "./ui";

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

      // intro / outro spans
      ctx.fillStyle = "rgba(139,92,246,0.16)";
      for (const s of introOutro) {
        ctx.fillRect((s.start / env.duration) * W, 0, ((s.end - s.start) / env.duration) * W, H);
      }

      // kept regions
      ctx.fillStyle = "rgba(56,189,248,0.16)";
      for (const r of detection.regions) {
        ctx.fillRect((r.start / env.duration) * W, 0, ((r.end - r.start) / env.duration) * W, H);
      }

      // envelope
      ctx.fillStyle = "rgba(148,163,184,0.75)";
      const step = W / n;
      for (let i = 0; i < n; i++) {
        const v = y(env.db[i]);
        ctx.fillRect(i * step, v, Math.max(0.6, step), H - v);
      }

      // threshold
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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const node = head.current;
      if (!node || !env.duration) return;
      node.style.left = `${Math.min(100, (getSrcTime() / env.duration) * 100)}%`;
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
  /** the source is a finished mixed render rather than a raw dual-channel capture */
  mixed?: boolean;
}) {
  const density =
    detection && duration > 0 ? (detection.speechSec / duration) * 100 : 0;
  const bodySec = introOutro.length
    ? Math.max(0, duration - introOutro.reduce((a, s) => a + (s.end - s.start), 0))
    : duration;
  const bodyDensity = detection && bodySec > 0 ? (detection.speechSec / bodySec) * 100 : 0;

  return (
    <div className="space-y-2.5">
      <Section title="1 · Find your commentary">
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

          <Section title="4 · Apply">
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
                Apply to timeline
              </Btn>
              <Btn onClick={onReset} title="Restore a plain intro / reaction / outro timeline">
                Reset
              </Btn>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              Applying rewrites only the reaction part of the timeline — you can still drag every
              segment afterwards.
            </p>
          </Section>
        </>
      )}

      {!env && !scanning && hasSource && (
        <Note>
          Run the analysis first. It only reads the audio and takes about{" "}
          {fmtTime(duration / scanSpeed)} at {scanSpeed}×.
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
          {opts.replace === "cut" ? "hard cuts" : opts.replace === "fast" ? "fast-forward" : "cards"}
          . If you can, try narrating reactions as they happen (“oh wait—”, “no way”, “look at
          this”) — even short interjections give the auto-cut something to hold on to, and they’re
          what makes a cut version worth watching.
        </Note>
      )}
    </div>
  );
}
