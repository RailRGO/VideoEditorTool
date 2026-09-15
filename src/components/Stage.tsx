import { useEffect, useRef, useState, type RefObject } from "react";
import type { LayoutState, Rect } from "../lib/types";
import { clamp } from "../lib/timeline";
import { cn } from "../utils/cn";

export type StageLayer = { key: "content" | "cam"; rect: Rect; name: string };

interface Props {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  layout: LayoutState;
  onRect: (key: "content" | "cam", rect: Rect) => void;
  layers: StageLayer[];
  /**
   * Read-only outline for a rect the render derives (the card's real rect in
   * a card span — the drawn content picture, which is not always the content
   * box). Shown so the preview never hides where the card will land.
   */
  guide?: { rect: Rect; name: string } | null;
  editLayer: "content" | "cam";
  setEditLayer: (k: "content" | "cam") => void;
  sceneMode: "body" | "solo" | "cut" | "fast" | "card" | "lead";
  showGuides: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  empty: boolean;
  passthrough?: boolean;
}

const snapTo = (v: number, targets: number[]) => {
  for (const t of targets) if (Math.abs(v - t) < 0.014) return t;
  return Math.round(v * 1000) / 1000;
};

export default function Stage({
  canvasRef,
  layout,
  onRect,
  layers,
  guide = null,
  editLayer,
  setEditLayer,
  sceneMode,
  showGuides,
  playing,
  onTogglePlay,
  empty,
  passthrough = false,
}: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const boxRef = useRef({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0, x: 0, y: 0 });
  const drag = useRef<null | {
    mode: "move" | "resize";
    key: "content" | "cam";
    sx: number;
    sy: number;
    orig: Rect;
  }>(null);

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.width, (r.height * 16) / 9);
      const h = (w * 9) / 16;
      boxRef.current = { w, h };
      setBox({ w, h, x: (r.width - w) / 2, y: (r.height - h) / 2 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = (e: React.PointerEvent, key: "content" | "cam", mode: "move" | "resize") => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, key, sx: e.clientX, sy: e.clientY, orig: { ...layout[key] } };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const b = boxRef.current;
    if (!b.w) return;
    const dx = (e.clientX - d.sx) / b.w;
    const dy = (e.clientY - d.sy) / b.h;
    const r: Rect = { ...d.orig };
    if (d.mode === "move") {
      r.x = clamp(snapTo(d.orig.x + dx, [0, 0.5 - d.orig.w / 2, 1 - d.orig.w]), 0, 1 - d.orig.w);
      r.y = clamp(snapTo(d.orig.y + dy, [0, 0.5 - d.orig.h / 2, 1 - d.orig.h]), 0, 1 - d.orig.h);
    } else {
      r.w = clamp(snapTo(d.orig.w + dx, [0.25, 0.3, 0.5, 0.7, 1]), 0.05, 1 - r.x);
      r.h = clamp(snapTo(d.orig.h + dy, [0.25, 0.3, 0.5, 1]), 0.05, 1 - r.y);
    }
    onRect(d.key, r);
  };

  const end = () => {
    drag.current = null;
  };

  return (
    <div ref={outer} className="relative min-h-0 flex-1">
      {/*
        No rounded / clipping here on purpose: the preview must show the exact
        frame that gets exported. A rounded-corner clip shaved the bottom-right
        of the content box (the card's corner sits ~0.6 % from the frame edge),
        which looked like the card was misplaced — the render itself is square.
      */}
      <div
        className="absolute bg-[#04060c] shadow-2xl ring-1 ring-white/10"
        style={{
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          visibility: box.w ? "visible" : "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          onClick={onTogglePlay}
          className="block h-full w-full cursor-pointer"
        />

        {showGuides && (
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-[5%] border border-white/20" />
            {[1, 2].map((i) => (
              <div
                key={`v${i}`}
                className="absolute top-0 bottom-0 w-px bg-white/10"
                style={{ left: `${(i * 100) / 3}%` }}
              />
            ))}
            {[1, 2].map((i) => (
              <div
                key={`h${i}`}
                className="absolute left-0 right-0 h-px bg-white/10"
                style={{ top: `${(i * 100) / 3}%` }}
              />
            ))}
          </div>
        )}

        {!empty && !playing && (
          <button
            type="button"
            onClick={onTogglePlay}
            className="group absolute inset-0 z-20 flex items-center justify-center bg-black/25 backdrop-blur-[1px]"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur transition group-hover:bg-white/25">
              <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6 fill-white">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </button>
        )}

        {guide && guide.rect.w > 0 && (
          <div
            className="pointer-events-none absolute z-30"
            style={{
              left: `${guide.rect.x * 100}%`,
              top: `${guide.rect.y * 100}%`,
              width: `${guide.rect.w * 100}%`,
              height: `${guide.rect.h * 100}%`,
            }}
          >
            <div className="absolute inset-0 rounded-[4px] border border-fuchsia-300/80 bg-fuchsia-400/5" />
            <span className="absolute -top-[9px] left-0 rounded bg-fuchsia-400 px-1 text-[9px] font-semibold uppercase tracking-wider text-slate-900">
              {guide.name}
            </span>
          </div>
        )}

        <div
          className="pointer-events-none absolute inset-0 z-10"
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          {layers.map(({ key, rect, name }) => {
            const active = editLayer === key;
            return (
              <div
                key={key}
                className={cn(
                  "pointer-events-auto absolute cursor-move",
                  active ? "z-20" : "z-10"
                )}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
                onPointerDown={(e) => {
                  setEditLayer(key);
                  start(e, key, "move");
                }}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
              >
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 rounded-[4px] border border-dashed",
                    active
                      ? "border-sky-300/90 bg-sky-400/5"
                      : "border-white/25 hover:border-white/50"
                  )}
                />
                <span
                  className={cn(
                    "pointer-events-none absolute -top-[9px] left-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wider",
                    active ? "bg-sky-400 text-slate-900" : "bg-white/25 text-white"
                  )}
                >
                  {name}
                </span>
                {active && (
                  <>
                    <div className="pointer-events-none absolute inset-0">
                      {[
                        "left-0 top-0",
                        "right-0 top-0",
                        "left-0 bottom-0",
                        "right-0 bottom-0",
                      ].map((pos) => (
                        <span
                          key={pos}
                          className={cn(
                            "absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-sky-300",
                            pos
                          )}
                        />
                      ))}
                    </div>
                    <div
                      className="pointer-events-auto absolute -bottom-1 -right-1 h-4 w-4 cursor-nwse-resize rounded-sm bg-sky-400 ring-2 ring-slate-900"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        start(e, key, "resize");
                      }}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={end}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[9px] text-slate-300">
          {sceneMode === "cut"
            ? "REMOVED — NOT RENDERED"
            : sceneMode === "card"
            ? "CARD — PROGRAMME HIDDEN"
            : sceneMode === "fast"
            ? "FAST-FORWARD"
            : passthrough
            ? "1920 × 1080 · FULL FRAME"
            : "1920 × 1080 · 16:9"}
        </div>
      </div>
    </div>
  );
}
