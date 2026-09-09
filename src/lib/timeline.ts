import type { Claim, CutOptions, Segment, SegmentType } from "./types";
import type { Region } from "./analyze";

let counter = 0;
export const uid = () =>
  `${Date.now().toString(36)}${(counter++).toString(36)}`.slice(-9);

export function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

export function fmtTime(t: number, ms = false): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  const core = `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(
    s
  ).padStart(2, "0")}`;
  return ms ? `${core}.${String(cs).padStart(2, "0")}` : core;
}

/** Media-time consumed by a segment, taking fast-forward into account. */
export function segSpeed(s: Segment, fastSpeed: number): number {
  return s.type === "fast" ? Math.max(1.05, fastSpeed) : 1;
}

export const isKept = (s: Segment) => s.type !== "cut";

export function outLen(s: Segment, fastSpeed: number): number {
  return isKept(s) ? (s.end - s.start) / segSpeed(s, fastSpeed) : 0;
}

/** Sort, drop zero-length, merge neighbours of the same type. No gap filling. */
export function tidy(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of [...segs]
    .filter((s) => s.end - s.start > 0.02)
    .sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && prev.type === s.type && Math.abs(prev.end - s.start) < 0.02) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Fill any hole with `body` (used once, when a file is loaded). */
export function normalize(segs: Segment[], duration: number): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of tidy(segs)) {
    if (s.start > cursor + 0.02) out.push({ id: uid(), type: "body", start: cursor, end: s.start });
    out.push(s);
    cursor = s.end;
  }
  if (duration - cursor > 0.02) {
    out.push({ id: uid(), type: "body", start: cursor, end: duration });
  }
  return out;
}

/** Turn [start,end) into a segment of `type`, splitting whatever is there. */
export function carve(
  segs: Segment[],
  start: number,
  end: number,
  type: SegmentType
): Segment[] {
  if (end - start <= 0.02) return tidy(segs);
  const out: Segment[] = [];
  let covered = false;
  for (const s of tidy(segs)) {
    if (s.end <= start || s.start >= end) {
      out.push(s);
      continue;
    }
    covered = true;
    if (s.start < start - 0.02) out.push({ ...s, id: uid(), end: start });
    out.push({ id: uid(), type, start: Math.max(s.start, start), end: Math.min(s.end, end) });
    if (s.end > end + 0.02) out.push({ ...s, id: uid(), start: end });
  }
  if (!covered) out.push({ id: uid(), type, start, end });
  return tidy(out);
}

export function splitAt(segs: Segment[], t: number): Segment[] {
  const out: Segment[] = [];
  for (const s of tidy(segs)) {
    if (t > s.start + 0.05 && t < s.end - 0.05) {
      out.push({ ...s, end: t });
      out.push({ ...s, id: uid(), start: t });
    } else out.push(s);
  }
  return out;
}

export function removeSegment(segs: Segment[], id: string): Segment[] {
  return segs.filter((s) => s.id !== id);
}

export const outDuration = (segs: Segment[], fastSpeed = 4) =>
  segs.reduce((a, s) => a + outLen(s, fastSpeed), 0);

export const removedDuration = (segs: Segment[]) =>
  segs.filter((s) => s.type === "cut").reduce((a, s) => a + (s.end - s.start), 0);

/** How much running time the fast-forward segments shave off. */
export const savedBySpeed = (segs: Segment[], fastSpeed = 4) =>
  segs
    .filter((s) => s.type === "fast")
    .reduce((a, s) => a + (s.end - s.start) * (1 - 1 / segSpeed(s, fastSpeed)), 0);

export function srcToOut(segs: Segment[], t: number, fastSpeed = 4): number {
  let acc = 0;
  for (const s of segs) {
    if (s.end <= t) {
      acc += outLen(s, fastSpeed);
      continue;
    }
    if (s.start >= t) break;
    if (!isKept(s)) break;
    acc += (t - s.start) / segSpeed(s, fastSpeed);
    break;
  }
  return acc;
}

export function outToSrc(segs: Segment[], o: number, fastSpeed = 4): number {
  let rem = o;
  for (const s of segs) {
    if (!isKept(s)) continue;
    const d = outLen(s, fastSpeed);
    if (rem <= d) return s.start + Math.max(0, rem) * segSpeed(s, fastSpeed);
    rem -= d;
  }
  return segs.length ? segs[segs.length - 1].end : 0;
}

export function activeSegment(segs: Segment[], t: number): Segment | null {
  for (const s of segs) if (t >= s.start && t < s.end) return s;
  return segs.length ? segs[segs.length - 1] ?? null : null;
}

/**
 * Rebuild the reaction (middle) part of the timeline so that only the stretches
 * with commentary survive. Intro and outro segments are never touched.
 */
export function buildCut(
  segs: Segment[],
  regions: Region[],
  opts: CutOptions,
  duration: number
): Segment[] {
  const out: Segment[] = [];
  for (const s of tidy(segs)) {
    if (s.type === "intro" || s.type === "outro") {
      out.push(s);
      continue;
    }
    // split this segment by the commentary regions
    const hits: Region[] = regions
      .map((r) => ({ start: Math.max(r.start, s.start), end: Math.min(r.end, s.end) }))
      .filter((r) => r.end - r.start > 0.04)
      .sort((a, b) => a.start - b.start);

    if (!hits.length) {
      if (s.type === "body" || s.type === "mute") out.push({ ...s, type: opts.replace });
      else out.push(s);
      continue;
    }

    let cursor = s.start;
    for (const h of hits) {
      if (h.start - cursor > 0.04) out.push({ id: uid(), type: opts.replace, start: cursor, end: h.start });
      out.push({ id: uid(), type: s.type === "mute" ? "mute" : "body", start: h.start, end: h.end });
      cursor = h.end;
    }
    if (s.end - cursor > 0.04) out.push({ id: uid(), type: opts.replace, start: cursor, end: s.end });
  }

  // absorb islands too short to be worth keeping
  const minKeep = Math.max(0.3, opts.minKeep);
  const absorbed = out.map((s) =>
    s.type === "body" && s.end - s.start < minKeep ? { ...s, type: opts.replace } : s
  );

  return tidy(absorbed).filter((s) => s.end <= duration + 0.05);
}

function tokenToSec(m: RegExpExecArray): number {
  if (m[4] !== undefined || m[1] !== undefined || m[2] !== undefined) {
    return (
      Number(m[1] || 0) * 3600 +
      Number(m[2] || 0) * 60 +
      Number(m[3] || 0) +
      (m[4] ? parseFloat(`0.${m[4]}`) : 0)
    );
  }
  return Number(m[5]);
}

/** YouTube Studio's list of matched segments, one per line. */
export function parseClaims(text: string, duration: number): Claim[] {
  const out: Claim[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*•\-–—]+/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const re = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?|(\d+(?:\.\d+)?)/g;
    const a = re.exec(line);
    if (!a) continue;
    const b = re.exec(line);
    if (!b) continue;
    const start = tokenToSec(a);
    const end = tokenToSec(b);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const label = line
      .slice(b.index + b[0].length)
      .replace(/^[\s\-–—:,|]+/, "")
      .trim();
    out.push({
      id: uid(),
      start: clamp(start, 0, duration),
      end: clamp(end, 0, duration),
      label: label || "Matched segment",
      action: "none",
    });
  }
  return out;
}

export function buildEDL(
  fileName: string,
  segs: Segment[],
  claims: Claim[],
  fastSpeed: number
): string {
  const lines: string[] = [];
  lines.push("# Reaction Studio — edit decision list");
  lines.push(`source: ${fileName}`);
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`source length: ${fmtTime(segs.length ? segs[segs.length - 1].end : 0)}`);
  lines.push(
    `render length: ${fmtTime(outDuration(segs, fastSpeed))} ` +
      `(removed ${fmtTime(removedDuration(segs))}, fast-forwarded ${fmtTime(savedBySpeed(segs, fastSpeed))})`
  );
  lines.push("");
  lines.push("## segments");
  for (const s of segs) {
    const extra = s.type === "fast" ? ` @${fastSpeed}x` : "";
    lines.push(
      `${fmtTime(s.start).padStart(8)} → ${fmtTime(s.end).padStart(8)}  ${s.type.toUpperCase().padEnd(
        5
      )}${extra}`
    );
  }
  if (claims.length) {
    lines.push("");
    lines.push("## matched material (from YouTube Studio)");
    for (const c of claims) {
      lines.push(
        `${fmtTime(c.start).padStart(8)} → ${fmtTime(c.end).padStart(8)}  ${
          c.action === "none" ? "unresolved" : c.action.toUpperCase()
        }  ${c.label}`
      );
    }
  }
  return lines.join("\n");
}
