import type { RefObject } from "react";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
} from "lucide-react";
import { formatTimecode } from "../lib/format";
import type { StageMode } from "../types";
import { cn } from "../utils/cn";

export function Preview({
  canvasRef,
  playing,
  current,
  duration,
  stage,
  onToggle,
  onStop,
  onSkip,
  ducking,
  micDb,
  exporting,
  exportProgress,
  scanning,
  scanProgress,
  faceLocked,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  playing: boolean;
  current: number;
  duration: number;
  stage: StageMode;
  onToggle: () => void;
  onStop: () => void;
  onSkip: (delta: number) => void;
  ducking: boolean;
  micDb: number;
  exporting: boolean;
  exportProgress: number;
  scanning: boolean;
  scanProgress: number;
  faceLocked: boolean;
}) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[#07090e]">
      <div className="tf-grid-bg relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2.5">
        <div className="tf-grain relative aspect-video w-full max-w-[1280px] overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_40px_120px_rgba(0,0,0,0.55)]">
          <canvas ref={canvasRef} className="h-full w-full" />
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                stage === "intro" && "bg-amber-200 text-zinc-950",
                stage === "reaction" && "bg-teal-300/90 text-zinc-950",
                stage === "outro" && "bg-violet-300 text-zinc-950",
              )}
            >
              {stage}
            </span>
            {ducking ? (
              <span className="rounded-full bg-pink-400/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-950">
                Duck
              </span>
            ) : null}
            {faceLocked ? (
              <span className="rounded-full bg-teal-300/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-950">
                Face lock
              </span>
            ) : null}
          </div>
          <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-black/55 px-2 py-1 font-mono text-[11px] text-zinc-200">
            {formatTimecode(current, true)} / {formatTimecode(duration, true)}
          </div>
          {scanning ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px]">
              <div className="text-sm font-medium text-zinc-100">Scanning mic & content audio</div>
              <div className="mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-teal-300" style={{ width: `${Math.round(scanProgress * 100)}%` }} />
              </div>
              <div className="mt-2 font-mono text-xs text-zinc-400">{Math.round(scanProgress * 100)}%</div>
              <div className="mt-1 text-[11px] text-zinc-500">Fast pass on this machine — no upload</div>
            </div>
          ) : null}
          {exporting ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px]">
              <div className="text-sm font-medium text-zinc-100">Rendering program</div>
              <div className="mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-amber-200"
                  style={{ width: `${Math.round(exportProgress * 100)}%` }}
                />
              </div>
              <div className="mt-2 font-mono text-xs text-zinc-400">
                {Math.round(exportProgress * 100)}%
                {duration > 0
                  ? ` · ~${Math.max(0, Math.round((1 - exportProgress) * duration))}s left`
                  : ""}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">Local 1× render — keep this tab open</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-11 shrink-0 items-center justify-center gap-2 border-t border-white/5 bg-[#0c0f16] px-4">
        <button
          type="button"
          onClick={() => onSkip(-5)}
          className="rounded-xl p-2 text-zinc-400 hover:bg-white/5 hover:text-white"
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 shadow-lg"
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={onStop}
          className="rounded-xl p-2 text-zinc-400 hover:bg-white/5 hover:text-white"
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onSkip(5)}
          className="rounded-xl p-2 text-zinc-400 hover:bg-white/5 hover:text-white"
        >
          <SkipForward className="h-4 w-4" />
        </button>
        <div className="ml-4 flex items-center gap-2 text-zinc-500">
          <Volume2 className="h-4 w-4" />
          <Meter value={micDb} />
        </div>
      </div>
    </div>
  );
}

function Meter({ value }: { value: number }) {
  const n = Math.max(0, Math.min(1, (value + 60) / 60));
  return (
    <div className="flex h-3 w-28 items-end gap-px">
      {Array.from({ length: 18 }).map((_, i) => {
        const lit = i / 18 < n;
        return (
          <div
            key={i}
            className="w-1.5 rounded-sm"
            style={{
              height: `${40 + i * 3.2}%`,
              background: lit ? (i > 14 ? "#f3c48a" : i > 10 ? "#6ee7d2" : "#3f4a60") : "#1b2030",
            }}
          />
        );
      })}
    </div>
  );
}
