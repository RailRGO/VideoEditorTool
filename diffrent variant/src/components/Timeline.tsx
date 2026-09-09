import { useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import { formatTimecode } from "../lib/format";
import { keptSegments, sourceToTimeline, timelineDuration } from "../lib/timeline";
import type { AssemblyMarkers, MuteSpan, Span } from "../types";
import { cn } from "../utils/cn";

export function Timeline({
  duration,
  currentSource,
  cuts,
  keeps,
  mutes,
  intro,
  outro,
  selection,
  onSeekSource,
  onSelect,
  onIntro,
  onOutro,
  markers,
}: {
  duration: number;
  currentSource: number;
  cuts: Span[];
  keeps: Span[];
  mutes: MuteSpan[];
  intro: number;
  outro: number;
  selection: { start: number; end: number } | null;
  onSeekSource: (t: number) => void;
  onSelect: (sel: { start: number; end: number } | null) => void;
  onIntro: (n: number) => void;
  onOutro: (n: number) => void;
  markers: AssemblyMarkers | null;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "seek" | "select"; a: number } | null>(null);
  const tDur = Math.max(0.001, timelineDuration(duration, cuts));
  const tCur = sourceToTimeline(currentSource, duration, cuts);
  const kept = useMemo(() => keptSegments(duration, cuts), [duration, cuts]);

  const timeFromEvent = (e: MouseEvent) => {
    const el = rail.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return x * duration;
  };

  return (
    <div className="h-[240px] shrink-0 border-t border-white/5 bg-[#0a0d14] px-3 py-2">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-zinc-500">
        <span>Program timeline</span>
        <span className="font-mono text-zinc-400">
          {formatTimecode(tCur)} · {formatTimecode(tDur)} program
        </span>
      </div>
      <div
        ref={rail}
        className="relative select-none"
        onMouseDown={(e) => {
          const t = timeFromEvent(e);
          if (e.shiftKey) {
            drag.current = { mode: "select", a: t };
            onSelect({ start: t, end: t });
          } else {
            drag.current = { mode: "seek", a: t };
            onSeekSource(t);
          }
        }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          const t = timeFromEvent(e);
          if (drag.current.mode === "seek") onSeekSource(t);
          else {
            const a = drag.current.a;
            onSelect({ start: Math.min(a, t), end: Math.max(a, t) });
          }
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <Ruler duration={duration} />
        <Track className="h-8">
          <StageBand duration={duration} intro={intro} outro={outro} tDur={tDur} cuts={cuts} markers={markers} />
        </Track>
        <Track className="h-10" label="Video">
          {kept.map((k) => (
            <Block
              key={`${k.start}-${k.end}`}
              duration={duration}
              start={k.start}
              end={k.end}
              className="bg-gradient-to-r from-amber-200/80 to-teal-300/70"
            />
          ))}
        </Track>
        <Track className="h-7" label="Mic">
          <Block duration={duration} start={0} end={duration} className="bg-pink-400/35" />
          {mutes
            .filter((m) => m.track === "mic")
            .map((m) => (
              <Block
                key={m.id}
                duration={duration}
                start={m.start}
                end={m.end}
                className="z-10 bg-zinc-950/80"
              />
            ))}
        </Track>
        <Track className="h-7" label="Content">
          <Block duration={duration} start={0} end={duration} className="bg-sky-400/30" />
          {mutes
            .filter((m) => m.track === "content")
            .map((m) => (
              <Block
                key={m.id}
                duration={duration}
                start={m.start}
                end={m.end}
                className="z-10 bg-zinc-950/80"
              />
            ))}
        </Track>
        {keeps.map((k) => (
          <div
            key={k.id}
            className="pointer-events-none absolute bottom-0 top-5 z-10 border border-teal-300/70 bg-teal-300/15"
            style={{
              left: `${(k.start / duration) * 100}%`,
              width: `${((k.end - k.start) / duration) * 100}%`,
            }}
          />
        ))}
        {cuts.map((c) => (
          <div
            key={c.id}
            className="pointer-events-none absolute bottom-0 top-5 z-20 bg-zinc-950/70"
            style={{
              left: `${(c.start / duration) * 100}%`,
              width: `${((c.end - c.start) / duration) * 100}%`,
            }}
          >
            <div className="h-full w-full bg-[repeating-linear-gradient(135deg,#0000,#0000_6px,#ffffff10_6px,#ffffff10_7px)]" />
          </div>
        ))}
        {selection && selection.end - selection.start > 0.05 ? (
          <div
            className="pointer-events-none absolute bottom-0 top-5 z-30 border border-amber-200/70 bg-amber-200/10"
            style={{
              left: `${(selection.start / duration) * 100}%`,
              width: `${((selection.end - selection.start) / duration) * 100}%`,
            }}
          />
        ) : null}
        <div
          className="pointer-events-none absolute bottom-0 top-0 z-40 w-px bg-amber-100"
          style={{ left: `${(currentSource / Math.max(duration, 0.001)) * 100}%` }}
        >
          <div className="absolute -left-1.5 top-0 h-3 w-3 rotate-45 bg-amber-100" />
        </div>
      </div>
      <div className="mt-2 flex gap-4 text-[11px] text-zinc-500">
        <span>Click seek · Shift-drag select · intro/outro locked</span>
        <label className="flex items-center gap-2">
          Intro
          <input
            type="number"
            min={0}
            step={0.5}
            value={intro}
            onChange={(e) => onIntro(Number(e.target.value))}
            className="w-16 rounded-md border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-zinc-300"
          />
        </label>
        <label className="flex items-center gap-2">
          Outro
          <input
            type="number"
            min={0}
            step={0.5}
            value={outro}
            onChange={(e) => onOutro(Number(e.target.value))}
            className="w-16 rounded-md border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-zinc-300"
          />
        </label>
      </div>
    </div>
  );
}

function Ruler({ duration }: { duration: number }) {
  const ticks = 12;
  return (
    <div className="relative mb-1 h-4">
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const t = (duration * i) / ticks;
        return (
          <div
            key={i}
            className="absolute top-0 font-mono text-[9px] text-zinc-600"
            style={{ left: `${(i / ticks) * 100}%` }}
          >
            {formatTimecode(t)}
          </div>
        );
      })}
    </div>
  );
}

function Track({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn("relative mb-1 overflow-hidden rounded-md bg-white/4", className)}>
      {label ? (
        <div className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/40 px-1 text-[9px] uppercase tracking-wider text-zinc-400">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function Block({
  duration,
  start,
  end,
  className,
}: {
  duration: number;
  start: number;
  end: number;
  className?: string;
}) {
  return (
    <div
      className={cn("absolute inset-y-0 rounded-sm", className)}
      style={{
        left: `${(start / Math.max(duration, 0.001)) * 100}%`,
        width: `${((end - start) / Math.max(duration, 0.001)) * 100}%`,
      }}
    />
  );
}

function StageBand({
  duration,
  intro,
  outro,
  tDur,
  cuts,
  markers,
}: {
  duration: number;
  intro: number;
  outro: number;
  tDur: number;
  cuts: Span[];
  markers: AssemblyMarkers | null;
}) {
  void cuts;
  const introW =
    duration <= 0
      ? 0
      : markers
        ? (markers.layoutSwitch / duration) * 100
        : (Math.min(intro, tDur) / duration) * 100;
  const outroW =
    duration <= 0
      ? 0
      : markers
        ? ((duration - markers.outroAt) / duration) * 100
        : (Math.min(outro, tDur) / duration) * 100;
  return (
    <>
      <div className="absolute inset-y-0 left-0 bg-amber-200/40" style={{ width: `${introW}%` }} />
      <div className="absolute inset-y-0 right-0 bg-violet-300/35" style={{ width: `${outroW}%` }} />
      <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-[0.2em] text-zinc-400">
        Intro · Reaction · Outro
      </div>
    </>
  );
}
