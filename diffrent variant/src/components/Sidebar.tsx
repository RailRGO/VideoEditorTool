import type { ReactNode } from "react";
import { Film, Mic2, MonitorPlay, Upload } from "lucide-react";
import { formatBytes, formatTimecode } from "../lib/format";
import type { CameraHalf, MediaInfo, SourceKind } from "../types";
import { Segmented } from "./widgets";

export function Sidebar({
  media,
  kind,
  cameraHalf,
  onKind,
  onHalf,
  onPickMain,
  onPickCamera,
  onPickContent,
  onPickMic,
  onPickContentAudio,
  micName,
  contentAudioName,
  cameraName,
  contentName,
}: {
  media: MediaInfo | null;
  kind: SourceKind;
  cameraHalf: CameraHalf;
  onKind: (k: SourceKind) => void;
  onHalf: (h: CameraHalf) => void;
  onPickMain: () => void;
  onPickCamera: () => void;
  onPickContent: () => void;
  onPickMic: () => void;
  onPickContentAudio: () => void;
  micName: string | null;
  contentAudioName: string | null;
  cameraName: string | null;
  contentName: string | null;
}) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/5 bg-[#0c0f16] p-3">
      <button
        type="button"
        onClick={onPickMain}
        className="group relative overflow-hidden rounded-2xl border border-dashed border-amber-200/20 bg-[radial-gradient(circle_at_20%_20%,rgba(243,196,138,0.16),transparent_42%),radial-gradient(circle_at_80%_80%,rgba(110,231,210,0.12),transparent_40%)] p-4 text-left"
      >
        <div className="relative">
          <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-200 text-zinc-950">
            <Upload className="h-4 w-4" />
          </div>
          <div className="font-medium text-zinc-100">Drop OBS recording</div>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            Dual-pane 3840×1080 with camera beside content. MP4 / WebM / MOV.
          </p>
        </div>
      </button>

      {media ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-3">
          <div className="flex items-start gap-2">
            <Film className="mt-0.5 h-4 w-4 text-amber-200" />
            <div className="min-w-0">
              <div className="truncate text-sm text-zinc-200">{media.name}</div>
              <div className="mt-1 font-mono text-[11px] text-zinc-500">
                {media.width}×{media.height} · {formatTimecode(media.duration)} · {formatBytes(media.size)}
              </div>
              {media.width / Math.max(1, media.height) > 2.3 ? (
                <div className="mt-2 inline-flex rounded-full bg-teal-300/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-teal-200">
                  Ultrawide dual-pane detected
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-zinc-500">
                  Not 32:9 — use dual files or still split the frame.
                </div>
              )}
              {media.size > 1.5 * 1024 * 1024 * 1024 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-200/70">
                  Heavy source. Render is local and real-time in this tab — a 20 minute program takes about 20 minutes to export. Prefer MP4 H.264 from OBS.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-2 rounded-2xl border border-white/5 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Source map
        </div>
        <Segmented
          value={kind}
          onChange={onKind}
          options={[
            { id: "ultrawide", label: "Ultrawide split" },
            { id: "dual", label: "Two files" },
          ]}
        />
        {kind === "ultrawide" ? (
          <div className="space-y-2">
            <div className="text-[11px] text-zinc-500">Camera half</div>
            <Segmented
              value={cameraHalf}
              onChange={onHalf}
              options={[
                { id: "left", label: "Camera left" },
                { id: "right", label: "Camera right" },
              ]}
            />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Splits the 3840×1080 recording down the middle. Left 1920 is usually your face.
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <MiniPick icon={<MonitorPlay className="h-3.5 w-3.5" />} label="Camera file" value={cameraName} onClick={onPickCamera} />
            <MiniPick icon={<Film className="h-3.5 w-3.5" />} label="Content file" value={contentName} onClick={onPickContent} />
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-2xl border border-white/5 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Audio stems
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Default: stereo L = mic, R = content. Override with separate files if OBS exported extra tracks.
        </p>
        <MiniPick icon={<Mic2 className="h-3.5 w-3.5" />} label="Mic audio (optional)" value={micName} onClick={onPickMic} />
        <MiniPick icon={<Film className="h-3.5 w-3.5" />} label="Content audio (optional)" value={contentAudioName} onClick={onPickContentAudio} />
      </div>

      <div className="mt-auto rounded-2xl border border-white/8 bg-black/30 p-3 text-[11px] leading-relaxed text-zinc-500">
        Twinframe is an editor for footage you have the right to use. YouTube may still match copyrighted clips. Get licenses, use libraries you own, or rely on legitimate commentary — this app will not hide material from Content ID.
      </div>
    </aside>
  );
}

function MiniPick({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-xl border border-white/6 bg-white/[0.03] px-2.5 py-2 text-left hover:border-white/12"
    >
      <span className="text-zinc-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="block truncate text-xs text-zinc-200">{value ?? "Choose file"}</span>
      </span>
    </button>
  );
}
