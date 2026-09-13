import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Downscale an uploaded picture to a card-sized JPEG data URL (≤1280px wide).
 * Keeps project files and autosaves small — a full-res phone photo would be
 * megabytes of base64 for a 1344×756 card.
 */
export function fileToCardImage(file: File, maxW = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const iw = img.naturalWidth || 1;
        const ih = img.naturalHeight || 1;
        const s = Math.min(1, maxW / iw);
        const w = Math.max(2, Math.round(iw * s));
        const h = Math.max(2, Math.round(ih * s));
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.fillStyle = "#04060c";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL("image/jpeg", 0.85));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read that image"));
    };
    img.src = url;
  });
}

/** Custom card background picker: upload / preview / remove + text toggle. */
export function CardImagePicker({
  image,
  showText,
  onImage,
  onShowText,
}: {
  image: string;
  showText: boolean;
  onImage: (dataUrl: string) => void;
  onShowText: (v: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const has = image.trim().length > 0;
  return (
    <div className="rounded-lg border border-white/10 bg-black/25 p-2">
      <div className="flex items-center gap-2">
        {has ? (
          <img
            src={image}
            alt="card background"
            className="h-10 w-[72px] shrink-0 rounded border border-white/15 object-cover"
          />
        ) : (
          <div className="flex h-10 w-[72px] shrink-0 items-center justify-center rounded border border-dashed border-white/15 text-[9px] text-slate-500">
            no image
          </div>
        )}
        <div className="flex min-w-0 flex-1 gap-1.5">
          <Btn className="flex-1" onClick={() => ref.current?.click()}>
            {has ? "Change image…" : "Use image…"}
          </Btn>
          {has && (
            <Btn title="Back to the generated gradient card" onClick={() => onImage("")}>
              ✕
            </Btn>
          )}
        </div>
        <input
          ref={ref}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void fileToCardImage(f).then(onImage).catch(() => {});
          }}
        />
      </div>
      {has && (
        <div className="mt-1">
          <Toggle
            label="Show headline over the image"
            hint="off = photo-only card"
            value={showText}
            onChange={onShowText}
          />
        </div>
      )}
      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
        {has
          ? "The picture covers the content area (same shape as the content box); the camera corner stays visible. Saved inside the project."
          : "Optional: a photo/poster instead of the generated card — e.g. a “full video on Patreon” graphic."}
      </p>
    </div>
  );
}

export function Section({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-white/10 bg-white/[0.025] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
        className
      )}
    >
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {title}
        </h3>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  display?: string;
  hint?: string;
}) {
  return (
    <label className="block select-none">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-300">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-sky-300">
          {display ?? value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400
                   [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none
                   [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-400
                   [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(56,189,248,0.18)]"
      />
      {hint && <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{hint}</p>}
    </label>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white/5"
    >
      <span>
        <span className="block text-[11px] text-slate-300">{label}</span>
        {hint && <span className="block text-[10px] text-slate-500">{hint}</span>}
      </span>
      <span
        className={cn(
          "relative h-4 w-8 shrink-0 rounded-full transition-colors",
          value ? "bg-sky-500" : "bg-slate-700"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
            value ? "left-4.5" : "left-0.5"
          )}
          style={{ left: value ? 18 : 2 }}
        />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5",
        className
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          title={o.label}
          className={cn(
            "min-w-0 flex-1 truncate rounded-[6px] font-medium transition-colors",
            size === "sm" ? "px-1.5 py-[3px] text-[10px]" : "px-2 py-1 text-[11px]",
            value === o.value
              ? "bg-sky-500/20 text-sky-200 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.35)]"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  variant = "ghost",
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "ghost" | "primary" | "danger" | "solid";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const styles = {
    ghost:
      "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10 hover:text-white",
    solid: "border-white/15 bg-slate-100 text-slate-900 hover:bg-white",
    primary:
      "border-sky-400/40 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30",
    danger:
      "border-rose-400/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25",
  }[variant];
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        styles,
        className
      )}
    >
      {children}
    </button>
  );
}

export function Meter({
  label,
  get,
  warn = -6,
}: {
  label: string;
  get: () => number;
  warn?: number;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      // ~15 fps is plenty for a meter; touching the DOM every frame is what
      // keeps the main thread busy and makes the editor feel laggy
      if (t - last < 66) return;
      last = t;
      const v = get();
      const pct = `${(Math.max(0, Math.min(1, (v + 60) / 60)) * 100).toFixed(1)}%`;
      if (bar.current && bar.current.style.width !== pct) bar.current.style.width = pct;
      const bg = v > -0.5 ? "#f43f5e" : v > warn ? "#fbbf24" : "#34d399";
      if (bar.current && bar.current.style.background !== bg) bar.current.style.background = bg;
      const text = v <= -59.5 ? "-∞" : v.toFixed(1);
      if (txt.current && txt.current.textContent !== text) txt.current.textContent = text;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [get, warn]);
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/50 ring-1 ring-inset ring-white/10">
        <div ref={bar} className="h-full w-0 rounded-full bg-emerald-400" />
      </div>
      <span
        ref={txt}
        className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-400"
      >
        -∞
      </span>
    </div>
  );
}

export function LiveText({ get, className }: { get: () => string; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      // throttled + change-only: writing textContent at 60fps forces layout
      if (t - last < 66) return;
      last = t;
      if (!el.current) return;
      const s = get();
      if (el.current.textContent !== s) el.current.textContent = s;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [get]);
  return <span ref={el} className={className} />;
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2.5 text-[11px] leading-relaxed",
        tone === "info"
          ? "border-sky-400/25 bg-sky-500/10 text-sky-100/85"
          : "border-amber-400/25 bg-amber-500/10 text-amber-100/85"
      )}
    >
      {children}
    </div>
  );
}
