import type { Segment } from "./types";
import type { TranscriptCutOptions } from "./types";
import type { Region } from "./analyze";
import type { Word } from "./polish";
import { tidy, uid } from "./timeline";

export interface Gap {
  start: number;
  end: number;
  dur: number;
}

/**
 * Turn word-level timestamps into speech regions:
 * each word expanded by `pad`, then merged when closer than `mergeGap`.
 */
export function speechRegionsFromWords(
  words: Word[],
  pad: number,
  mergeGap: number
): Region[] {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const expanded: Region[] = sorted.map((w) => ({
    start: Math.max(0, w.start - pad),
    end: w.end + pad,
  }));
  // merge
  const merged: Region[] = [];
  let cur = { ...expanded[0] };
  for (let i = 1; i < expanded.length; i++) {
    const nxt = expanded[i];
    if (nxt.start - cur.end <= mergeGap) {
      cur.end = Math.max(cur.end, nxt.end);
    } else {
      merged.push(cur);
      cur = { ...nxt };
    }
  }
  merged.push(cur);
  return merged.filter((r) => r.end - r.start > 0.05);
}

/** Inverse of speech regions inside [spanStart, spanEnd) */
export function gapsFromSpeech(
  speech: Region[],
  spanStart: number,
  spanEnd: number
): Region[] {
  const out: Region[] = [];
  let cursor = spanStart;
  for (const s of speech) {
    if (s.end <= spanStart) continue;
    if (s.start >= spanEnd) break;
    const a = Math.max(s.start, spanStart);
    const b = Math.min(s.end, spanEnd);
    if (a - cursor > 0.02) out.push({ start: cursor, end: a });
    cursor = Math.max(cursor, b);
  }
  if (spanEnd - cursor > 0.02) out.push({ start: cursor, end: spanEnd });
  return out;
}

export interface TranscriptCutReport {
  speech: Region[];
  gaps: Region[];
  largeGaps: Region[];
  tinyGaps: Region[];
  keptGaps: Region[];
  /** output segments that would replace body (for stats) */
  outSegments: Segment[];
  /** how much time is saved by cutting */
  saved: number;
  /** total card time inserted */
  cardTime: number;
}

/**
 * Build the YouTube timeline from transcript gaps:
 * - speech -> body
 * - tiny gaps (< minSilence) -> keep/fast/mute per tinyAction
 * - large gaps (>= minSilence) -> card (cardDuration) + cut (rest)
 *
 * Only the reaction part (body/lead/mute/fast/card) is rewritten;
 * intro/outro are preserved. If bodySpan is given, gaps are computed
 * only inside that span (the usual case).
 */
export function buildTranscriptCut(
  segments: Segment[],
  words: Word[],
  duration: number,
  opts: TranscriptCutOptions,
  bodySpan?: Region
): Segment[] {
  if (!words.length || duration <= 0) return segments;

  const speech = speechRegionsFromWords(words, opts.pad, opts.mergeGap);

  // Determine the spans we are allowed to rewrite
  const rewriteTypes = new Set(["body", "lead", "mute", "fast", "card"]);
  const bodySegs = segments.filter((s) => rewriteTypes.has(s.type));
  const spanStart = bodySpan ? bodySpan.start : (bodySegs[0]?.start ?? 0);
  const spanEnd = bodySpan ? bodySpan.end : (bodySegs[bodySegs.length - 1]?.end ?? duration);

  // Clip speech to the rewrite span for gap computation
  const clippedSpeech = speech
    .map((r) => ({
      start: Math.max(r.start, spanStart),
      end: Math.min(r.end, spanEnd),
    }))
    .filter((r) => r.end - r.start > 0.02)
    .sort((a, b) => a.start - b.start);

  const out: Segment[] = [];

  for (const s of tidy(segments)) {
    if (!rewriteTypes.has(s.type)) {
      out.push(s);
      continue;
    }
    // Outside the bodySpan? keep as is (defensive)
    if (s.end <= spanStart || s.start >= spanEnd) {
      out.push(s);
      continue;
    }
    const segStart = Math.max(s.start, spanStart);
    const segEnd = Math.min(s.end, spanEnd);
    if (segEnd - segStart <= 0.02) continue;

    // Speech overlapping this segment
    const overlapping = clippedSpeech.filter(
      (r) => r.end > segStart + 0.01 && r.start < segEnd - 0.01
    );

    if (!overlapping.length) {
      // Whole segment is a gap
      out.push(...emitGap(segStart, segEnd, opts));
      continue;
    }

    let cursor = segStart;
    for (const sr of overlapping) {
      const a = Math.max(sr.start, segStart);
      const b = Math.min(sr.end, segEnd);
      if (a - cursor > 0.02) {
        out.push(...emitGap(cursor, a, opts));
      }
      // speech itself -> body (preserve original type if it was mute? but for YT we want body)
      out.push({ id: uid(), type: "body", start: cursor < a ? a : cursor, end: b });
      cursor = b;
    }
    if (segEnd - cursor > 0.02) {
      out.push(...emitGap(cursor, segEnd, opts));
    }
  }

  // Preserve any leading/trailing bits outside bodySpan that were body but not iterated?
  // tidy will merge same-type neighbours.
  const final = tidy(out).filter((s) => s.end - s.start > 0.08 && s.end <= duration + 0.05);
  return final;
}

function emitGap(start: number, end: number, opts: TranscriptCutOptions): Segment[] {
  const dur = end - start;
  if (dur < opts.minGap) {
    return [{ id: uid(), type: "body", start, end }];
  }
  if (dur < opts.minSilence) {
    if (opts.tinyAction === "keep") return [{ id: uid(), type: "body", start, end }];
    if (opts.tinyAction === "fast") return [{ id: uid(), type: "fast", start, end }];
    return [{ id: uid(), type: "mute", start, end }];
  }
  // large gap -> card + cut
  if (dur <= opts.cardDuration) {
    return [{ id: uid(), type: "card", start, end }];
  }
  return [
    { id: uid(), type: "card", start, end: start + opts.cardDuration },
    { id: uid(), type: "cut", start: start + opts.cardDuration, end },
  ];
}

export function analyseTranscriptCut(
  segments: Segment[],
  words: Word[],
  duration: number,
  opts: TranscriptCutOptions,
  bodySpan?: Region
): TranscriptCutReport {
  const speech = speechRegionsFromWords(words, opts.pad, opts.mergeGap);
  const spanStart = bodySpan ? bodySpan.start : 0;
  const spanEnd = bodySpan ? bodySpan.end : duration;
  const clipped = speech
    .map((r) => ({
      start: Math.max(r.start, spanStart),
      end: Math.min(r.end, spanEnd),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const gaps = gapsFromSpeech(clipped, spanStart, spanEnd);
  const large = gaps.filter((g) => g.end - g.start >= opts.minSilence);
  const tiny = gaps.filter(
    (g) => g.end - g.start >= opts.minGap && g.end - g.start < opts.minSilence
  );
  const kept = gaps.filter((g) => g.end - g.start < opts.minGap);

  const outSegments = buildTranscriptCut(segments, words, duration, opts, bodySpan);
  let saved = 0;
  let cardTime = 0;
  for (const s of outSegments) {
    if (s.type === "cut") saved += s.end - s.start;
    if (s.type === "card") cardTime += s.end - s.start;
  }
  // Also count gaps that become cut inside body
  return {
    speech: clipped,
    gaps,
    largeGaps: large,
    tinyGaps: tiny,
    keptGaps: kept,
    outSegments,
    saved,
    cardTime,
  };
}
