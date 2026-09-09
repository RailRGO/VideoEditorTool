import { useEffect, useRef } from "react";
import type { Claim, Segment, SegmentType } from "../lib/types";
import { SEGMENT_META } from "../lib/types";
import { clamp, fmtTime } from "../lib/timeline";
import { cn } from "../utils/cn";

interface Props {
  segments: Segment[];
  claims: Claim[];
  selectedId: string | null;
  selectedClaim: string | null;
  duration: number;
  zoom: number;
  fastSpeed: number;
  playing: () => boolean;
  getSrcTime: () => number;
  onSelect: (id: string | null) => void;
  onSelectClaim: (id: string | null) => void;
  onChange: (segs: Segment[]) => void;
  onSeek: (srcTime: number) => void;
  onSplit: () => void;
  onAddSegment: (type: SegmentType) => void;
  onDelete: () => void;
}

const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

function Playhead({
  getSrcTime,
  duration,
  zoom,
  playing,
  scroller,
}: {
  getSrcTime: () => number;
  duration: number;
  zoom: number;
  playing: () => boolean;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const node = el.current;
      if (!node || duration <= 0) return;
      const p = clamp(getSrcTime() / duration, 0, 1);
      node.style.left = `${(p * 100).toFixed(4)}%`;
      const sc = scroller.current;
      if (sc && playing()) {
        const x = p * sc.clientWidth * zoom;
        if (x < sc.scrollLeft + 60 || x > sc.scrollLeft + sc.clientWidth - 60) {
          sc.scrollLeft = x - sc.clientWidth / 2;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getSrcTime, duration, zoom, playing, scroller]);
  return (
    <div
      ref={el}
      className="pointer-events-none absolute bottom-0 top-0 z-30 w-[2px] -translate-x-1/2 bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)]"
    >
      <span className="absolute -left-[5px] top-0 h-2.5 w-3 rounded-b-sm bg-rose-400" />
    </div>
  );
}

export default function Timeline(props: Props) {
  const {
    segments,
    claims,
    selectedId,
    selectedClaim,
    duration,
    zoom,
    fastSpeed,
    playing,
    getSrcTime,
    onSelect,
    onSelectClaim,
    onChange,
    onSeek,
  } = props;

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<null | {
    kind: "seg" | "claim";
    id: string;
    mode: "move" | "l" | "r";
    sx: number;
    orig: Segment;
  }>(null);
  const scrubbing = useRef(false);

  const timeAt = (clientX: number) => {
    const r = content.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1) * duration;
  };

  const beginSeg = (
    e: React.PointerEvent,
    seg: Segment,
    mode: "move" | "l" | "r"
  ) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSelect(seg.id);
    drag.current = { kind: "seg", id: seg.id, mode, sx: e.clientX, orig: { ...seg } };
  };

  const onMove = (e: React.PointerEvent) => {
    if (scrubbing.current) {
      onSeek(timeAt(e.clientX));
      return;
    }
    const d = drag.current;
    if (!d || !content.current) return;
    const dt = ((e.clientX - d.sx) / content.current.getBoundingClientRect().width) * duration;
    const i = segments.findIndex((s) => s.id === d.id);
    if (i < 0) return;
    const lo = i > 0 ? segments[i - 1].end : 0;
    const hi = i < segments.length - 1 ? segments[i + 1].start : duration;
    const len = d.orig.end - d.orig.start;
    let start = d.orig.start;
    let end = d.orig.end;
    if (d.mode === "move") {
      start = clamp(d.orig.start + dt, lo, hi - len);
      end = start + len;
    } else if (d.mode === "l") {
      start = clamp(d.orig.start + dt, lo, end - 0.1);
    } else {
      end = clamp(d.orig.end + dt, start + 0.1, hi);
    }
    onChange(
      segments.map((s) =>
        s.id === d.id
          ? { ...s, start: Math.min(start, end), end: Math.max(start, end) }
          : s
      )
    );
  };

  const endDrag = () => {
    drag.current = null;
    scrubbing.current = false;
  };

  const pxPerSec = (900 * zoom) / Math.max(1, duration);
  const step = TICKS.find((t) => t * pxPerSec > 68) ?? 3600;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t);

  const pct = (t: number) => `${(clamp(t / Math.max(duration, 0.001), 0, 1) * 100).toFixed(4)}%`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap border-t border-white/10 bg-slate-950/60 px-3 py-1">
        <span className="mr-1 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Timeline
        </span>
        {(["intro", "lead", "body", "outro", "fast", "card", "mute", "cut"] as SegmentType[]).map(
          (t) => (
          <button
            key={t}
            type="button"
            title={`Add ${SEGMENT_META[t].label} at playhead — ${SEGMENT_META[t].text}`}
            onClick={() => props.onAddSegment(t)}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
              SEGMENT_META[t].chip,
              "hover:brightness-125"
            )}
            >
              +{SEGMENT_META[t].short}
            </button>
          )
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={props.onSplit}
            className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
          >
            Split (S)
          </button>
          <button
            type="button"
            onClick={props.onDelete}
            disabled={!selectedId}
            className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
          >
            Delete (⌫)
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-[84px] shrink-0 border-r border-white/10 bg-slate-950/40 text-[9px] font-medium uppercase tracking-wider text-slate-500">
          <div className="flex h-[20px] items-center justify-end px-2">time</div>
          <div className="flex h-[40px] items-center justify-end px-2">video</div>
          <div className="flex h-[22px] items-center justify-end px-2">audio</div>
          <div className="flex h-[20px] items-center justify-end px-2">claims</div>
        </div>

        <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto">
          <div
            ref={content}
            className="relative"
            style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/* ruler */}
            <div
              className="relative h-[22px] cursor-ew-resize select-none border-b border-white/10 bg-slate-950/60"
              onPointerDown={(e) => {
                scrubbing.current = true;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                onSeek(timeAt(e.clientX));
              }}
            >
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full border-l border-white/15"
                  style={{ left: pct(t) }}
                >
                  <span className="ml-1 font-mono text-[9px] text-slate-500">
                    {fmtTime(t)}
                  </span>
                </div>
              ))}
            </div>

            {/* video segments */}
            <div
              className="relative h-[46px] bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.02)_0_8px,transparent_8px_16px)]"
              onPointerDown={(e) => {
                onSelect(null);
                scrubbing.current = true;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                onSeek(timeAt(e.clientX));
              }}
            >
              {segments.map((s) => {
                const meta = SEGMENT_META[s.type];
                const sel = s.id === selectedId;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "absolute top-1 bottom-1 overflow-hidden rounded-md border transition-shadow",
                      meta.bar,
                      s.type === "cut" &&
                        "bg-[repeating-linear-gradient(45deg,rgba(244,63,94,0.35)_0_6px,rgba(244,63,94,0.15)_6px_12px)]",
                      sel && "ring-2 ring-white/70"
                    )}
                    style={{ left: pct(s.start), width: pct(s.end - s.start) }}
                    onPointerDown={(e) => beginSeg(e, s, "move")}
                  >
                    <div className="flex h-full flex-col justify-between px-1.5 py-0.5">
                      <span className="truncate text-[9px] font-bold uppercase tracking-wider text-white/90">
                        {meta.short}
                        {s.type === "fast" && (
                          <span className="ml-0.5 opacity-80">{fastSpeed}×</span>
                        )}
                      </span>
                      <span className="truncate font-mono text-[9px] text-white/60">
                        {fmtTime(s.end - s.start)}
                        {s.type === "fast" && (
                          <span className="text-teal-200/80">
                            {" "}
                            → {fmtTime((s.end - s.start) / fastSpeed)}
                          </span>
                        )}
                      </span>
                    </div>
                    <div
                      className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/25"
                      onPointerDown={(e) => beginSeg(e, s, "l")}
                    />
                    <div
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/25"
                      onPointerDown={(e) => beginSeg(e, s, "r")}
                    />
                  </div>
                );
              })}
            </div>

            {/* audio lanes */}
            <div className="relative h-[22px] border-y border-white/5 bg-black/25">
              <div className="absolute inset-x-0 top-[2px] h-[7px] rounded-sm bg-sky-500/25 ring-1 ring-inset ring-sky-400/30" />
              <div className="absolute inset-x-0 bottom-[2px] h-[7px] rounded-sm bg-teal-500/25 ring-1 ring-inset ring-teal-400/30" />
              <span className="absolute left-1 top-[1px] text-[8px] font-bold uppercase tracking-wider text-sky-300/80">
                mic · comp/limiter
              </span>
              <span className="absolute bottom-[1px] left-1 text-[8px] font-bold uppercase tracking-wider text-teal-300/80">
                content · auto-duck
              </span>
              {segments
                .filter(
                  (s) =>
                    s.type === "mute" ||
                    s.type === "cut" ||
                    s.type === "card" ||
                    s.type === "intro" ||
                    s.type === "outro"
                )
                .map((s) => (
                  <div
                    key={`a${s.id}`}
                    className="absolute bottom-[2px] h-[7px] rounded-sm bg-slate-900/80 ring-1 ring-inset ring-amber-400/40"
                    style={{ left: pct(s.start), width: pct(s.end - s.start) }}
                  />
                ))}
            </div>

            {/* claims */}
            <div className="relative h-[20px] bg-slate-950/40">
              {claims.map((c) => (
                <div
                  key={c.id}
                  title={`${fmtTime(c.start)}–${fmtTime(c.end)} · ${c.label}`}
                  className={cn(
                    "absolute top-[3px] bottom-[3px] cursor-pointer overflow-hidden rounded-sm border",
                    c.action === "cut"
                      ? "border-rose-300/60 bg-rose-500/45"
                      : c.action === "mute"
                      ? "border-amber-300/60 bg-amber-500/45"
                      : "border-white/25 bg-white/10",
                    selectedClaim === c.id && "ring-2 ring-white/70"
                  )}
                  style={{ left: pct(c.start), width: pct(c.end - c.start) }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelectClaim(c.id);
                  }}
                >
                  <span className="px-1 text-[8px] font-semibold leading-[14px] text-white/80">
                    {c.label}
                  </span>
                </div>
              ))}
              {claims.length === 0 && (
                <span className="absolute left-2 top-[6px] text-[9px] text-slate-600">
                  paste claimed segments in the Claims tab to map them onto the timeline
                </span>
              )}
            </div>

            <Playhead
              getSrcTime={getSrcTime}
              duration={duration}
              zoom={zoom}
              playing={playing}
              scroller={scroller}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
