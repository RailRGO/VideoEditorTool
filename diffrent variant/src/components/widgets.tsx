import type { ReactNode } from "react";
import { cn } from "../utils/cn";

export function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
          {label}
        </span>
        {value ? (
          <span className="font-mono text-[11px] text-zinc-400">{value}</span>
        ) : null}
      </div>
      {children}
    </label>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  tone = "sand",
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  tone?: "sand" | "teal" | "mic";
}) {
  return (
    <input
      type="range"
      className={cn("tf-range", tone === "teal" && "teal", tone === "mic" && "mic")}
      min={min}
      max={max}
      step={step ?? 0.01}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  compact,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg text-left",
        compact ? "shrink-0" : "w-full justify-between py-1",
      )}
    >
      {label && !compact ? <span className="text-sm text-zinc-300">{label}</span> : null}
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-amber-300/90" : "bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-zinc-950 transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div
      className="grid gap-1 rounded-xl bg-black/30 p-1"
      style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-lg px-2 py-1.5 text-xs font-medium transition",
            value === o.id
              ? "bg-zinc-100 text-zinc-950 shadow"
              : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PanelCard({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-white/5 bg-white/[0.025] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
