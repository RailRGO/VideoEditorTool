import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../utils/cn";

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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = get();
      const pct = Math.max(0, Math.min(1, (v + 60) / 60)) * 100;
      if (bar.current) bar.current.style.width = `${pct}%`;
      if (bar.current) {
        bar.current.style.background =
          v > -0.5 ? "#f43f5e" : v > warn ? "#fbbf24" : "#34d399";
      }
      if (txt.current) txt.current.textContent = v <= -59.5 ? "-∞" : v.toFixed(1);
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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (el.current) el.current.textContent = get();
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
