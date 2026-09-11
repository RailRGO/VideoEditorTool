import { useEffect, useRef, useState } from "react";
import type { Claim, Segment, SegmentType } from "../lib/types";
import { SEGMENT_META } from "../lib/types";
import type { Envelope } from "../lib/analyze";
import type { Transcript } from "../lib/polish";
import { clamp, fmtTime, MIN_SEG, reposition } from "../lib/timeline";
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
  /** level envelopes to draw in the audio lanes (after a scan) */
  waves: { lane: "top" | "bottom" | "full"; env: Envelope; label: string }[];
  /** word-timed transcript for the script lane */
  transcript: Transcript | null;
  onSelect: (id: string | null) => void;
  onSelectClaim: (id: string | null) => void;
  onChange: (segs: Segment[]) => void;
  /** one editable gesture started (drag) — snapshot for undo */
  onEditStart: () => void;
  /** one editable gesture finished — commit the undo snapshot if changed */
  onEditEnd: () => void;
  onSeek: (srcTime: number) => void;
  onSplit: () => void;
  onAddSegment: (type: SegmentType) => void;
  onDelete: () => void;
  /** carve the selected range into a segment of `type` */
  onApplyRange: (a: number, b: number, type: SegmentType) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

/** types offered on the range-selection bar */
const RANGE_TYPES: SegmentType[] = [
  "cut",
  "mute",
  "fast",
  "card",
  "intro",
  "lead",
  "body",
  "outro",
];

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
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return; // ~30 fps is plenty for the playhead
      last = t;
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

/**
 * Level envelope as a tiny bar chart. Fixed internal resolution — the canvas
 * is CSS-stretched with the zoom, so no redraw on zoom.
 */
function WaveStrip({ env, color }: { env: Envelope; color: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const W = 1600;
    const H = 32;
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const n = env.db.length;
    const step = W / n;
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const p = clamp((env.db[i] + 70) / 62, 0.04, 1); // −70 … −8 dB
      const h = Math.max(1, p * (H - 2));
      ctx.fillRect(i * step, H - h, Math.max(1, step), h);
    }
  }, [env, color]);
  return <canvas ref={cv} className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />;
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
    waves,
    transcript,
    onSelect,
    onSelectClaim,
    onChange,
    onEditStart,
    onEditEnd,
    onSeek,
  } = props;

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<null | {
    id: string;
    mode: "move" | "l" | "r";
    sx: number;
    orig: Segment;
  }>(null);
  const rangeDrag = useRef<null | { a: number; moved: boolean; seekTo?: number }>(null);
  const scrubbing = useRef(false);
  const [rangeSel, setRangeSel] = useState<{ a: number; b: number } | null>(null);

  /* Escape clears the range selection */
  useEffect(() => {
    if (!rangeSel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRangeSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rangeSel]);

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
    onEditStart();
    drag.current = { id: seg.id, mode, sx: e.clientX, orig: { ...seg } };
  };

  const onMove = (e: React.PointerEvent) => {
    if (rangeDrag.current) {
      rangeDrag.current.moved = true;
      setRangeSel({ a: rangeDrag.current.a, b: timeAt(e.clientX) });
      return;
    }
    if (scrubbing.current) {
      onSeek(timeAt(e.clientX));
      return;
    }
    const d = drag.current;
    if (!d || !content.current) return;
    const dt =
      ((e.clientX - d.sx) / content.current.getBoundingClientRect().width) * duration;
    if (!segments.some((s) => s.id === d.id)) return;
    // push semantics: neighbours absorb the change, so a section can extend
    // into its neighbours (and vice versa) instead of stopping at the border
    const start = d.mode === "r" ? d.orig.start : d.orig.start + dt;
    const end = d.mode === "l" ? d.orig.end : d.orig.end + dt;
    onChange(reposition(segments, d.id, start, end));
  };

  const endDrag = () => {
    if (drag.current) onEditEnd();
    drag.current = null;
    scrubbing.current = false;
    const rd = rangeDrag.current;
    rangeDrag.current = null;
    if (rd && !rd.moved) {
      // a plain click: on the video lane it clears the selection,
      // on a script word it seeks to that word
      setRangeSel(null);
      if (rd.seekTo != null) onSeek(rd.seekTo);
    }
  };

  const beginRange = (e: React.PointerEvent, seekTo?: number) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rangeDrag.current = { a: seekTo ?? timeAt(e.clientX), moved: false, seekTo };
  };

  const pxPerSec = (900 * zoom) / Math.max(1, duration);
  const step = TICKS.find((t) => t * pxPerSec > 68) ?? 3600;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t);

  const pct = (t: number) => `${(clamp(t / Math.max(duration, 0.001), 0, 1) * 100).toFixed(4)}%`;

  const selA = rangeSel ? Math.min(rangeSel.a, rangeSel.b) : 0;
  const selB = rangeSel ? Math.max(rangeSel.a, rangeSel.b) : 0;
  const selValid = !!rangeSel && selB - selA > MIN_SEG;

  const wTop = waves.find((w) => w.lane === "top") ?? null;
  const wBottom = waves.find((w) => w.lane === "bottom") ?? null;
  const wFull = waves.find((w) => w.lane === "full") ?? null;

  const words = transcript?.words ?? [];
  const wordStep = words.length > 700 ? Math.ceil(words.length / 700) : 1;

  const applyRangeAction = (t: SegmentType) => {
    props.onApplyRange(selA, selB, t);
    setRangeSel(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap border-t border-white/10 bg-slate-950/60 px-3 py-1">
        <span className="mr-1 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Timeline
        </span>

        {selValid ? (
          <span className="flex shrink-0 items-center gap-1">
            <span
              className="rounded border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-200"
              title="Shift+drag on the timeline draws this range — cut it or turn it into any section"
            >
              {fmtTime(selA, true)} → {fmtTime(selB, true)} · {fmtTime(selB - selA)}
            </span>
            {RANGE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                title={`Make the selected range ${SEGMENT_META[t].label} — ${SEGMENT_META[t].text}`}
                onClick={() => applyRangeAction(t)}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                  SEGMENT_META[t].chip,
                  "hover:brightness-125"
                )}
              >
                {SEGMENT_META[t].short}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setRangeSel(null)}
              title="Clear selection (Esc)"
              className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/10"
            >
              ✕
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            {(["intro", "lead", "body", "outro", "fast", "card", "mute", "cut"] as SegmentType[]).map(
              (t) => (
                <button
                  key={t}
                  type="button"
                  title={`Add ${SEGMENT_META[t].label} at the playhead (${
                    t === "cut" ? "4s" : t === "card" ? "6s" : "3s"
                  }) — ${SEGMENT_META[t].text}. For a custom range: shift+drag on the timeline.`}
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
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={props.onUndo}
            disabled={!props.canUndo}
            title="Undo (Ctrl+Z)"
            className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            onClick={props.onRedo}
            disabled={!props.canRedo}
            title="Redo (Ctrl+Shift+Z)"
            className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
          >
            ↷ Redo
          </button>
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
          <div className="flex h-[16px] items-center justify-end px-2">script</div>
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
                if (e.shiftKey) {
                  beginRange(e);
                  return;
                }
                onSelect(null);
                scrubbing.current = true;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                onSeek(timeAt(e.clientX));
              }}
              title="Click: seek · Shift+drag: select a range to cut or convert"
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
                      title="Drag — the neighbour gives up the time"
                      onPointerDown={(e) => beginSeg(e, s, "l")}
                    />
                    <div
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/25"
                      title="Drag — the neighbour gives up the time"
                      onPointerDown={(e) => beginSeg(e, s, "r")}
                    />
                  </div>
                );
              })}

              {/* range selection overlay */}
              {selValid && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20 border-x-2 border-sky-300/90 bg-sky-400/15"
                  style={{ left: pct(selA), width: pct(selB - selA) }}
                >
                  <span className="absolute -top-0 left-1/2 -translate-x-1/2 rounded-sm bg-sky-500/90 px-1 font-mono text-[9px] leading-[13px] text-white">
                    {fmtTime(selB - selA)}
                  </span>
                </div>
              )}
            </div>

            {/* audio lanes (level waveforms appear after a scan) */}
            <div className="relative h-[22px] border-y border-white/5 bg-black/25">
              {wFull ? (
                <>
                  <div className="absolute inset-x-0 top-[2px] bottom-[2px] rounded-sm bg-sky-500/15 ring-1 ring-inset ring-sky-400/30" />
                  <WaveStrip env={wFull.env} color="rgba(125,211,252,0.8)" />
                  <span className="absolute left-1 top-[1px] text-[8px] font-bold uppercase tracking-wider text-sky-300/80">
                    {wFull.label}
                  </span>
                </>
              ) : (
                <>
                  <div className="absolute inset-x-0 top-[2px] h-[7px] rounded-sm bg-sky-500/25 ring-1 ring-inset ring-sky-400/30" />
                  {wTop && <WaveStrip env={wTop.env} color="rgba(125,211,252,0.85)" />}
                  <div className="absolute inset-x-0 bottom-[2px] h-[7px] rounded-sm bg-teal-500/25 ring-1 ring-inset ring-teal-400/30" />
                  {wBottom && <WaveStrip env={wBottom.env} color="rgba(94,234,212,0.85)" />}
                  <span className="absolute left-1 top-[1px] text-[8px] font-bold uppercase tracking-wider text-sky-300/80">
                    {wTop ? wTop.label : "mic · run the scan to see levels"}
                  </span>
                  <span className="absolute bottom-[1px] left-1 text-[8px] font-bold uppercase tracking-wider text-teal-300/80">
                    {wBottom ? wBottom.label : "content · run the scan to see levels"}
                  </span>
                </>
              )}
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
                    className={cn(
                      "absolute rounded-sm bg-slate-900/80 ring-1 ring-inset ring-amber-400/40",
                      wFull ? "top-[2px] bottom-[2px]" : "bottom-[2px] h-[7px]"
                    )}
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

            {/* script (transcript words) — click a word to seek, drag to mark a range */}
            <div
              className="relative h-[16px] border-t border-white/5 bg-slate-950/60"
              onPointerDown={(e) => beginRange(e)}
              title="Click a word to seek · drag to mark a range (then cut/mute it)"
            >
              {wordStep === 1
                ? words.map((w, i) => (
                    <span
                      key={i}
                      title={`${w.text} · ${fmtTime(w.start, true)}`}
                      onPointerDown={(e) => beginRange(e, w.start)}
                      className="absolute top-[1px] bottom-[1px] cursor-pointer overflow-hidden rounded-sm bg-violet-500/25 pl-[2px] text-[8px] leading-[12px] text-violet-100/80 hover:bg-violet-500/50"
                      style={{
                        left: pct(w.start),
                        width: Math.max(2, ((w.end - w.start) / Math.max(duration, 0.001)) * 100),
                      }}
                    >
                      {w.text}
                    </span>
                  ))
                : words
                    .filter((_, i) => i % wordStep === 0)
                    .map((w, i) => (
                      <span
                        key={i}
                        title={`${w.text} · ${fmtTime(w.start, true)}`}
                        className="absolute top-1/2 h-[8px] w-[2px] -translate-y-1/2 rounded bg-violet-400/60"
                        style={{ left: pct(w.start) }}
                      />
                    ))}
              {words.length === 0 && (
                <span className="absolute left-2 top-[4px] text-[9px] text-slate-600">
                  no transcript — transcribe in Polish (Colab) or load a .srt/.txt to see your words here
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
