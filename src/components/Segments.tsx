import { useEffect, useState } from "react";
import type { LayoutState, Segment, SegmentType } from "../lib/types";
import { SEGMENT_META } from "../lib/types";
import {
  clamp,
  fmtTime,
  outDuration,
  parseTimecode,
  removedDuration,
  removeSegment,
  reposition,
  segSpeed,
  tidy,
} from "../lib/timeline";
import { Btn, CardImagePicker, Note, Section, Segmented, Slider, Toggle } from "./ui";
import { cn } from "../utils/cn";

const ALL_TYPES = Object.keys(SEGMENT_META) as SegmentType[];

/**
 * Text field that accepts "90", "1:30", "1:30.5", "1:02:03" — commits on
 * Enter or blur, reverts to the canonical format when unparseable.
 */
function TimeInput({
  value,
  onCommit,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  title?: string;
}) {
  const [text, setText] = useState(() => fmtTime(value, true));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmtTime(value, true));
  }, [value, focus]);

  const commit = () => {
    setFocus(false);
    const parsed = parseTimecode(text);
    if (parsed == null) {
      setText(fmtTime(value, true));
      return;
    }
    if (parsed !== value) onCommit(clamp(parsed, 0, 1e6));
  };

  return (
    <input
      value={text}
      title={title}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        setFocus(true);
        setText(fmtTime(value, true));
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
      className="w-full rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-slate-200 outline-none focus:border-sky-400/50"
    />
  );
}

function Row({
  s,
  segments,
  fastSpeed,
  selected,
  onSelect,
  onSeek,
  onCommit,
}: {
  s: Segment;
  segments: Segment[];
  fastSpeed: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onCommit: (next: Segment[]) => void;
}) {
  const meta = SEGMENT_META[s.type];
  const len = s.end - s.start;
  const outLen = s.type === "cut" ? 0 : len / segSpeed(s, fastSpeed);
  /** intro / outro are exported exactly as recorded — never mirrored */
  const clean = s.type === "intro" || s.type === "outro";
  return (
    <div
      onClick={() => {
        onSelect(s.id);
        onSeek(s.start);
      }}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-lg border border-white/10 bg-black/25 px-1.5 py-1 hover:border-white/25",
        selected === s.id && "border-sky-400/50 bg-sky-500/10"
      )}
    >
      <select
        value={s.type}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const type = e.target.value as SegmentType;
          onCommit(tidy(segments.map((x) => (x.id === s.id ? { ...x, type } : x))));
        }}
        className={cn(
          "w-[64px] shrink-0 rounded-md border px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide outline-none",
          meta.chip
        )}
        style={{ background: "rgba(0,0,0,0.45)" }}
      >
        {ALL_TYPES.map((t) => (
          <option key={t} value={t} style={{ color: "#e2e8f0" }}>
            {SEGMENT_META[t].short}
          </option>
        ))}
      </select>
      {s.type === "card" && s.card?.variant === "short" && (
        <span
          className="shrink-0 rounded border border-fuchsia-400/30 bg-fuchsia-500/15 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-fuchsia-200"
          title="Short card — subtitles stay visible"
        >
          short
        </span>
      )}
      <TimeInput
        title="Start (source time)"
        value={s.start}
        onCommit={(v) => onCommit(reposition(segments, s.id, v, s.end))}
      />
      <span className="text-slate-600">→</span>
      <TimeInput
        title="End (source time)"
        value={s.end}
        onCommit={(v) => onCommit(reposition(segments, s.id, s.start, v))}
      />
      <button
        type="button"
        title={
          clean
            ? "Intro / outro are never mirrored — they stay exactly as recorded"
            : s.mirror
            ? "Mirrored (Cloak → Mirroring → only the blocks I tick). Click to leave it as recorded"
            : "Mirror this block on the YouTube cut (Cloak → Mirroring → only the blocks I tick)"
        }
        disabled={clean}
        onClick={(e) => {
          e.stopPropagation();
          onCommit(
            segments.map((x) => (x.id === s.id ? { ...x, mirror: !x.mirror } : x))
          );
        }}
        className={cn(
          "shrink-0 rounded px-1 text-[11px]",
          clean
            ? "cursor-not-allowed text-slate-700"
            : s.mirror
            ? "bg-fuchsia-500/25 text-fuchsia-100"
            : "text-slate-600 hover:bg-white/10 hover:text-fuchsia-200"
        )}
      >
        ⇄
      </button>
      <span
        className={cn(
          "w-[52px] shrink-0 text-right font-mono text-[10px] tabular-nums",
          s.type === "cut" ? "text-rose-300/70" : "text-slate-400"
        )}
      >
        {s.type === "cut" ? "−" + fmtTime(len) : fmtTime(outLen)}
      </span>
      <button
        type="button"
        title="Remove this segment (its time becomes reaction)"
        onClick={(e) => {
          e.stopPropagation();
          onCommit(removeSegment(segments, s.id));
        }}
        className="shrink-0 rounded px-1 text-[11px] text-slate-600 hover:bg-white/10 hover:text-rose-300"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Right-inspector tab with everything that shapes the edit itself: the
 * selected segment, the full segment list, and the per-segment-type settings
 * (fast-forward, card). The frame/retouch/audio tabs keep the look & sound.
 */
export default function SegmentsPanel({
  segments,
  layout,
  setLayout,
  selected,
  onSelect,
  onSeek,
  onCommit,
  onSplit,
}: {
  segments: Segment[];
  layout: LayoutState;
  setLayout: React.Dispatch<React.SetStateAction<LayoutState>>;
  selected: Segment | null;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  /** commit a new segment list (normalized + undoable) */
  onCommit: (next: Segment[]) => void;
  onSplit: () => void;
}) {
  /** edit one card's overrides; empty values inherit the global card */
  const onCardChange = (
    id: string,
    patch: { title?: string; sub?: string; accent?: string; variant?: "full" | "short" }
  ) => {
    const card: { title?: string; sub?: string; accent?: string; variant?: "full" | "short" } = {};
    const src = segments.find((s) => s.id === id)?.card ?? {};
    for (const k of ["title", "sub", "accent"] as const) {
      const v = patch[k] !== undefined ? patch[k] : src[k];
      if (v != null && v.trim() !== "") card[k] = v;
    }
    // "full" is the default — only short is stored on the segment
    const variant = patch.variant !== undefined ? patch.variant : src.variant;
    if (variant === "short") card.variant = "short";
    onCommit(
      segments.map((s) =>
        s.id === id ? { ...s, card: Object.keys(card).length ? card : undefined } : s
      )
    );
  };

  const fastN = segments.filter((s) => s.type === "fast").length;
  const cardN = segments.filter((s) => s.type === "card").length;
  const removed = removedDuration(segments);
  const outDur = outDuration(segments, layout.fastSpeed);

  return (
    <div className="space-y-2.5">
      <Section
        title="Selected segment"
        right={
          selected && (
            <span className="font-mono text-[10px] text-slate-500">
              {fmtTime(selected.end - selected.start)}
              {selected.type === "fast" && ` → ${fmtTime((selected.end - selected.start) / layout.fastSpeed)}`}
            </span>
          )
        }
      >
        {selected ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {ALL_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={SEGMENT_META[t].text}
                  onClick={() =>
                    onCommit(
                      tidy(segments.map((x) => (x.id === selected.id ? { ...x, type: t } : x)))
                    )
                  }
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    SEGMENT_META[t].chip,
                    selected.type === t && "ring-2 ring-white/60"
                  )}
                >
                  {SEGMENT_META[t].short}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
              <TimeInput
                title="Start (source time)"
                value={selected.start}
                onCommit={(v) =>
                  onCommit(reposition(segments, selected.id, v, selected.end))
                }
              />
              <span className="text-slate-600">→</span>
              <TimeInput
                title="End (source time)"
                value={selected.end}
                onCommit={(v) =>
                  onCommit(reposition(segments, selected.id, selected.start, v))
                }
              />
            </div>
            <p className="font-mono text-[10px] text-slate-500">
              output {selected.type === "cut" ? fmtTime(0) : fmtTime((selected.end - selected.start) / segSpeed(selected, layout.fastSpeed))}
              {" · "}{selected.type === "cut" ? "removed entirely" : SEGMENT_META[selected.type].text}
            </p>
            <button
              type="button"
              disabled={selected.type === "intro" || selected.type === "outro"}
              title={
                selected.type === "intro" || selected.type === "outro"
                  ? "Intro / outro stay exactly as recorded"
                  : "Mirror this block on the YouTube cut — Cloak tab → Mirroring → “only the blocks I tick”"
              }
              onClick={() =>
                onCommit(
                  segments.map((x) =>
                    x.id === selected.id ? { ...x, mirror: !x.mirror } : x
                  )
                )
              }
              className={cn(
                "flex w-full items-center justify-between rounded-lg border px-2 py-1.5 text-[11px] font-semibold",
                selected.mirror
                  ? "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-100"
                  : "border-white/10 bg-black/25 text-slate-400 hover:border-white/25",
                (selected.type === "intro" || selected.type === "outro") &&
                  "cursor-not-allowed opacity-40"
              )}
            >
              <span>⇄ Mirror this block</span>
              <span className="font-mono text-[10px]">
                {selected.type === "intro" || selected.type === "outro"
                  ? "clean span"
                  : selected.mirror
                  ? "mirrored"
                  : "as recorded"}
              </span>
            </button>
            {selected.type === "card" && (
              <div className="space-y-1.5 rounded-lg border border-white/10 bg-black/25 p-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-400">
                  This card's text — empty fields inherit the defaults
                </p>
                <input
                  className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-sky-400/50"
                  placeholder={`Title (default: “${layout.card.title}”)`}
                  value={selected.card?.title ?? ""}
                  onChange={(e) => onCardChange(selected.id, { title: e.target.value })}
                />
                <input
                  className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-sky-400/50"
                  placeholder={`Subtitle (default: “${layout.card.sub}”)`}
                  value={selected.card?.sub ?? ""}
                  onChange={(e) => onCardChange(selected.id, { sub: e.target.value })}
                />
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    title="Accent colour"
                    value={/^#[0-9a-fA-F]{6}$/.test(selected.card?.accent ?? "") ? selected.card!.accent! : layout.card.accent}
                    className="h-6 w-8 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
                    onChange={(e) => onCardChange(selected.id, { accent: e.target.value })}
                  />
                  <input
                    className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-sky-400/50"
                    placeholder={`Accent (default: ${layout.card.accent})`}
                    value={selected.card?.accent ?? ""}
                    onChange={(e) => onCardChange(selected.id, { accent: e.target.value })}
                  />
                  {(selected.card?.title || selected.card?.sub || selected.card?.accent) && (
                    <button
                      type="button"
                      onClick={() => onCardChange(selected.id, { title: "", sub: "", accent: "" })}
                      className="shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-1 text-[9px] font-semibold uppercase text-slate-400 hover:bg-white/10"
                      title="Clear this card's overrides"
                    >
                      use defaults
                    </button>
                  )}
                </div>
                <Segmented
                  value={selected.card?.variant ?? "full"}
                  onChange={(v) => onCardChange(selected.id, { variant: v as "full" | "short" })}
                  options={[
                    { value: "full", label: "Full card" },
                    { value: "short", label: "Short card" },
                  ]}
                />
                <p className="text-[10px] leading-relaxed text-slate-500">
                  Short covers the top {Math.round((layout.card.shortHeight ?? 0.75) * 100)}% only —
                  subtitles stay visible. Both mute the content audio.
                </p>
              </div>
            )}
            <div className="flex gap-1.5">
              <Btn className="flex-1" onClick={onSplit} title="Split the selected segment at the playhead">
                Split at playhead (S)
              </Btn>
              <Btn
                variant="danger"
                className="flex-1"
                onClick={() => {
                  onCommit(removeSegment(segments, selected.id));
                  onSelect(null);
                }}
              >
                Delete (⌫)
              </Btn>
            </div>
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-slate-500">
            Click a block to edit its type and exact start / end. Drag an edge to extend it —
            the neighbour gives up the time.
          </p>
        )}
      </Section>

      <Section
        title={`Fast-forward · ${fastN} segment${fastN === 1 ? "" : "s"}`}
        right={fastN > 0 ? <span className="text-[10px] font-semibold text-teal-300">active</span> : undefined}
      >
        <div className="space-y-2">
          <Slider
            label="Speed"
            value={layout.fastSpeed}
            min={1.5}
            max={12}
            step={0.5}
            display={`${layout.fastSpeed}×`}
            onChange={(v) => setLayout((l) => ({ ...l, fastSpeed: v }))}
          />
          <Slider
            label="Content audio while fast"
            value={layout.fastGainDb}
            min={-30}
            max={0}
            step={1}
            display={`${layout.fastGainDb} dB`}
            onChange={(v) => setLayout((l) => ({ ...l, fastGainDb: v }))}
          />
          <Toggle
            label="Let the pitch rise with speed"
            hint="the classic fast-forward sound"
            value={layout.chipmunk}
            onChange={(v) => setLayout((l) => ({ ...l, chipmunk: v }))}
          />
        </div>
      </Section>

      <Section
        title={`Card · ${cardN} segment${cardN === 1 ? "" : "s"}`}
        right={cardN > 0 ? <span className="text-[10px] font-semibold text-fuchsia-300">active</span> : undefined}
      >
        <div className="space-y-1.5">
          <input
            value={layout.card.title}
            onChange={(e) => setLayout((l) => ({ ...l, card: { ...l.card, title: e.target.value } }))}
            placeholder="Card headline"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
          />
          <input
            value={layout.card.sub}
            onChange={(e) => setLayout((l) => ({ ...l, card: { ...l.card, sub: e.target.value } }))}
            placeholder="Card sub-line"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-fuchsia-400/50"
          />
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={layout.card.accent}
              onChange={(e) => setLayout((l) => ({ ...l, card: { ...l.card, accent: e.target.value } }))}
              className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-black/40"
            />
            <span className="font-mono text-[10px] text-slate-500">{layout.card.accent}</span>
          </div>
          <CardImagePicker
            image={layout.card.image ?? ""}
            showText={layout.card.showText !== false}
            onImage={(v) => setLayout((l) => ({ ...l, card: { ...l.card, image: v } }))}
            onShowText={(v) => setLayout((l) => ({ ...l, card: { ...l.card, showText: v } }))}
          />
          <Slider
            label="Card opacity"
            value={Math.round((layout.card.opacity ?? 0.97) * 100)}
            min={0}
            max={100}
            step={1}
            display={`${Math.round((layout.card.opacity ?? 0.97) * 100)}%`}
            onChange={(v) => setLayout((l) => ({ ...l, card: { ...l.card, opacity: v / 100 } }))}
            hint="exact: 100% hides the content, 50% ghosts through, 0% draws no card at all"
          />
          <Slider
            label="Short card height"
            value={Math.round((layout.card.shortHeight ?? 0.75) * 100)}
            min={30}
            max={100}
            step={1}
            display={`${Math.round((layout.card.shortHeight ?? 0.75) * 100)}% of content`}
            onChange={(v) => setLayout((l) => ({ ...l, card: { ...l.card, shortHeight: v / 100 } }))}
            hint="short cards cover the top only — subtitles at the bottom stay visible"
          />
        </div>
      </Section>

      <Section
        title={`All segments · ${segments.length}`}
        right={
          <span className="font-mono text-[10px] text-slate-500">
            −{fmtTime(removed)} · out {fmtTime(outDur)}
          </span>
        }
      >
        {segments.length === 0 ? (
          <p className="text-[11px] text-slate-500">Load a source to build the timeline.</p>
        ) : (
          <div className="max-h-[300px] space-y-1 overflow-y-auto pr-0.5">
            {segments.map((s) => (
              <Row
                key={s.id}
                s={s}
                segments={segments}
                fastSpeed={layout.fastSpeed}
                selected={selected?.id ?? null}
                onSelect={onSelect}
                onSeek={onSeek}
                onCommit={onCommit}
              />
            ))}
          </div>
        )}
      </Section>

      {/*
        Timeline cheat sheet (kept out of the panel itself):
        • the timeline is a partition of the source — extending one section
          shortens its neighbour, so no second is ever unaccounted for;
        • shift+drag marks a range for CUT / MUTE / FFWD / CARD / INTRO / LEAD /
          REACT / OUTRO (or the +buttons for a quick section at the playhead);
        • a selected block can be retyped and given exact in/out timecodes, and
          split at the playhead with S.
      */}
      <Note>
        <strong className="font-semibold">How the timeline works</strong>
        <br />
        <br />
        Drag an edge and the neighbour gives up the time. Shift+drag a range, then press{" "}
        <strong>CUT / MUTE / CARD</strong> … to make it that. Select a block to fine-tune
        or split it (S).
        <br />
        <br />
        <span className="font-mono text-[10px] text-slate-400">
          S split · ⌫ delete · ←/→ frame · Shift+←/→ second · ,/. prev/next boundary ·
          Ctrl+Z / Ctrl+Shift+Z undo/redo · Esc clears the range
        </span>
      </Note>
    </div>
  );
}
