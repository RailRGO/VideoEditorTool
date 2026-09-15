import type { Retouch } from "../lib/types";
import type { TrackStatus } from "../lib/face";
import { Btn, Note, Section, Slider, Toggle } from "./ui";
import { cn } from "../utils/cn";

const STATUS: Record<TrackStatus, { label: string; cls: string }> = {
  idle: { label: "off", cls: "border-white/10 bg-white/5 text-slate-400" },
  loading: { label: "loading model…", cls: "border-sky-400/30 bg-sky-500/10 text-sky-200" },
  ready: { label: "model ready", cls: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" },
  tracking: { label: "tracking your face", cls: "border-emerald-400/40 bg-emerald-500/15 text-emerald-100" },
  lost: { label: "face not found", cls: "border-amber-400/30 bg-amber-500/10 text-amber-200" },
  failed: { label: "model unavailable", cls: "border-rose-400/30 bg-rose-500/10 text-rose-200" },
};

export default function RetouchPanel({
  cfg,
  setCfg,
  status,
  statusText,
  fps,
  onLoad,
  showFaceBox,
  setShowFaceBox,
  manualBox,
  setManualBox,
}: {
  cfg: Retouch;
  setCfg: React.Dispatch<React.SetStateAction<Retouch>>;
  status: TrackStatus;
  statusText: string;
  fps: number;
  onLoad: () => void;
  showFaceBox: boolean;
  setShowFaceBox: (v: boolean) => void;
  manualBox: { x: number; y: number; w: number; h: number };
  setManualBox: (b: { x: number; y: number; w: number; h: number }) => void;
}) {
  const s = STATUS[status];
  const set = (p: Partial<Retouch>) => setCfg((c) => ({ ...c, ...p }));

  return (
    <div className="space-y-2.5">
      <Section
        title="Face tracking"
        right={
          <span className={cn("rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase", s.cls)}>
            {s.label}
          </span>
        }
      >
        <Toggle
          label="Enable retouching"
          hint="applies to the camera layer only"
          value={cfg.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <div className="mt-2 flex gap-1.5">
          <Btn
            variant={status === "failed" || status === "idle" ? "primary" : "ghost"}
            className="flex-1"
            onClick={onLoad}
          >
            {status === "failed" ? "Retry model load" : "Load face model"}
          </Btn>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          {status === "failed"
            ? `Couldn't fetch the model — ${statusText}. Use manual placement, or check the connection.`
            : "The model (~3 MB) is fetched once and cached; it runs locally."}
        </p>
        {status === "tracking" && (
          <p className="mt-1 font-mono text-[10px] text-emerald-300">{fps} detections/s</p>
        )}
        <div className="mt-2">
          <Toggle
            label="Show the tracked mask"
            hint="blue = skin area, pink = eye / nose warps"
            value={showFaceBox}
            onChange={setShowFaceBox}
          />
        </div>
      </Section>

      <Section title="Skin">
        <div className="space-y-2">
          <Slider
            label="Smoothing"
            value={cfg.skin}
            min={0}
            max={100}
            step={1}
            display={`${cfg.skin}%`}
            onChange={(v) => set({ skin: v })}
          />
          <Slider
            label="Keep detail"
            value={cfg.detail}
            min={0}
            max={100}
            step={1}
            display={`${cfg.detail}%`}
            onChange={(v) => set({ detail: v })}
            hint="high keeps hair, brows and glasses crisp; low goes full beauty-filter"
          />
        </div>
      </Section>

      <Section title="Teeth">
        <Slider
          label="Whitening"
          value={cfg.teeth}
          min={0}
          max={100}
          step={1}
          display={`${cfg.teeth}%`}
          onChange={(v) => set({ teeth: v })}
          hint="masked to the inner-lip region, so lips keep their colour"
        />
      </Section>

      <Section title="Face shape">
        <div className="space-y-2">
          <Slider
            label="Eye size"
            value={cfg.eyeScale}
            min={-30}
            max={45}
            step={1}
            display={`${cfg.eyeScale > 0 ? "+" : ""}${cfg.eyeScale}%`}
            onChange={(v) => set({ eyeScale: v })}
            hint="each eye is magnified around its own iris"
          />
          <Slider
            label="Nose width"
            value={cfg.noseScale}
            min={-40}
            max={20}
            step={1}
            display={`${cfg.noseScale > 0 ? "+" : ""}${cfg.noseScale}%`}
            onChange={(v) => set({ noseScale: v })}
            hint="negative narrows — 0 leaves it alone"
          />
          <Slider
            label="Warp feathering"
            value={cfg.feather}
            min={0}
            max={100}
            step={1}
            display={`${cfg.feather}%`}
            onChange={(v) => set({ feather: v })}
            hint="how gradually the distortion fades out — higher hides the seam"
          />
        </div>
      </Section>

      <Section title="Tracking stability">
        <div className="space-y-2">
          <Slider
            label="Jitter smoothing"
            value={cfg.smoothing}
            min={0}
            max={95}
            step={1}
            display={`${cfg.smoothing}%`}
            onChange={(v) => set({ smoothing: v })}
            hint="adaptive — a still head is held steady, a fast one is followed"
          />
          <Slider
            label="Detect every"
            value={cfg.everyN}
            min={1}
            max={4}
            step={1}
            display={`${cfg.everyN} frame${cfg.everyN === 1 ? "" : "s"}`}
            onChange={(v) => set({ everyN: v })}
            hint="raise this if preview playback stutters; the last pose is held between"
          />
        </div>
      </Section>

      <Section title="Manual placement">
        <Toggle
          label="Use a manual face box instead"
          hint="no model needed — set it once, it stays put"
          value={cfg.manual}
          onChange={(v) => set({ manual: v })}
        />
        {cfg.manual && (
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
            <Slider label="X" value={manualBox.x} min={0} max={0.95} step={0.005} display={`${Math.round(manualBox.x * 100)}%`} onChange={(v) => setManualBox({ ...manualBox, x: v })} />
            <Slider label="Y" value={manualBox.y} min={0} max={0.95} step={0.005} display={`${Math.round(manualBox.y * 100)}%`} onChange={(v) => setManualBox({ ...manualBox, y: v })} />
            <Slider label="Width" value={manualBox.w} min={0.05} max={1} step={0.005} display={`${Math.round(manualBox.w * 100)}%`} onChange={(v) => setManualBox({ ...manualBox, w: v })} />
            <Slider label="Height" value={manualBox.h} min={0.05} max={1} step={0.005} display={`${Math.round(manualBox.h * 100)}%`} onChange={(v) => setManualBox({ ...manualBox, h: v })} />
            <p className="col-span-2 text-[10px] leading-relaxed text-slate-500">
              Percentages are of the camera layer. Skin, teeth and the warps are approximated
              from this box — fine for still framing, not for leaning around.
            </p>
          </div>
        )}
      </Section>

      <Section title="Camera &amp; content shape">
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          Set the camera and content shapes in the <strong>Layout</strong> tab — rectangle, rounded
          rectangle, circle or pill.
        </p>
      </Section>

      <Note tone="warn">
        <strong className="font-semibold">Keep it subtle.</strong> Heavy warping shows at
        glasses, hair and edges. For a bigger change, use OBS filters while recording.
      </Note>
    </div>
  );
}


