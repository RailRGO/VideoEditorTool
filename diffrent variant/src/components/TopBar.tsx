import { Download, Keyboard, ShieldCheck } from "lucide-react";

export function TopBar({
  projectName,
  onExport,
  exporting,
  canExport,
  onHelp,
}: {
  projectName: string;
  onExport: () => void;
  exporting: boolean;
  canExport: boolean;
  onHelp: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/5 bg-[#0c0f16]/90 px-4 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="relative h-8 w-8 overflow-hidden rounded-lg bg-[#141820] ring-1 ring-white/10">
          <span className="absolute left-1 top-1.5 h-5 w-3.5 rounded-[4px] bg-amber-200/90" />
          <span className="absolute right-1 top-2 h-5 w-3.5 rounded-[4px] bg-teal-300/90" />
        </div>
        <div className="leading-tight">
          <div className="font-serif text-[17px] tracking-tight text-zinc-100">Twinframe</div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            Reaction compositor
          </div>
        </div>
        <div className="ml-4 hidden items-center gap-2 rounded-full border border-white/8 bg-white/3 px-3 py-1 text-[11px] text-zinc-400 md:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-300/80" />
          {projectName}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-2 rounded-full border border-amber-200/10 bg-amber-200/5 px-3 py-1 text-[11px] text-amber-100/80 lg:flex">
          <ShieldCheck className="h-3.5 w-3.5" />
          Layout & mix only — no Content ID evasion
        </div>
        <button
          type="button"
          onClick={onHelp}
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/8 text-zinc-400 hover:text-zinc-100"
          title="Shortcuts"
        >
          <Keyboard className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!canExport || exporting}
          className="inline-flex h-9 items-center gap-2 rounded-xl bg-amber-200 px-3.5 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export"}
        </button>
      </div>
    </header>
  );
}
