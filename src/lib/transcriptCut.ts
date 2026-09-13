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
  outSegments: Segment[];
  saved: number;
  cardTime: number;
}

/**
 * Build the YouTube timeline from transcript gaps:
 * - speech -> body
 * - tiny gaps (< minSilence) -> keep/fast/mute per tinyAction
 * - large gaps (>= minSilence) -> card + cut
 * Plus breaker: long continuous speech > maxSpeech -> insert card over content
 * (keeps voice, breaks ContentID).
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

  const rewriteTypes = new Set(["body", "lead", "mute", "fast", "card"]);
  const bodySegs = segments.filter((s) => rewriteTypes.has(s.type));
  const spanStart = bodySpan ? bodySpan.start : (bodySegs[0]?.start ?? 0);
  const spanEnd = bodySpan ? bodySpan.end : (bodySegs[bodySegs.length - 1]?.end ?? duration);

  let clippedSpeech = speech
    .map((r) => ({
      start: Math.max(r.start, spanStart),
      end: Math.min(r.end, spanEnd),
    }))
    .filter((r) => r.end - r.start > 0.02)
    .sort((a, b) => a.start - b.start);

  const maxSpeech = (opts as any).maxSpeech ?? 30;
  const breakerDur = (opts as any).breakerDuration ?? 3;
  const breakerAction = (opts as any).breakerAction ?? "card";
  // long-talk breakers default to the short card (subs stay visible);
  // silence cards from emitGap stay full
  const breakerVariant = (opts as any).breakerVariant ?? "short";

  let breakerRegions: Region[] = [];
  if (maxSpeech > 1 && breakerDur > 0) {
    type Piece = { start: number; end: number; isBreaker: boolean };
    const pieces: Piece[] = [];
    for (const r of clippedSpeech) {
      let cur = r.start;
      while (cur < r.end - 0.01) {
        const bodyEnd = Math.min(r.end, cur + maxSpeech);
        pieces.push({ start: cur, end: bodyEnd, isBreaker: false });
        cur = bodyEnd;
        if (cur < r.end - 0.01) {
          const brEnd = Math.min(r.end, cur + breakerDur);
          if (brEnd - cur > 0.05) {
            pieces.push({ start: cur, end: brEnd, isBreaker: true });
            cur = brEnd;
          }
        }
      }
    }
    const newSpeech: Region[] = [];
    const br: Region[] = [];
    for (const p of pieces) {
      if (p.isBreaker) br.push({ start: p.start, end: p.end });
      else newSpeech.push({ start: p.start, end: p.end });
    }
    breakerRegions = br;
    clippedSpeech = newSpeech;
  }

  const out: Segment[] = [];

  for (const s of tidy(segments)) {
    if (!rewriteTypes.has(s.type)) {
      out.push(s);
      continue;
    }
    if (s.end <= spanStart || s.start >= spanEnd) {
      out.push(s);
      continue;
    }
    const segStart = Math.max(s.start, spanStart);
    const segEnd = Math.min(s.end, spanEnd);
    if (segEnd - segStart <= 0.02) continue;

    const overlapping = clippedSpeech.filter(
      (r) => r.end > segStart + 0.01 && r.start < segEnd - 0.01
    );
    const overlappingBreakers = breakerRegions.filter(
      (r) => r.end > segStart + 0.01 && r.start < segEnd - 0.01
    );

    const allPieces: { start: number; end: number; isBreaker: boolean }[] = [];
    for (const r of overlapping) {
      allPieces.push({ start: Math.max(r.start, segStart), end: Math.min(r.end, segEnd), isBreaker: false });
    }
    for (const r of overlappingBreakers) {
      allPieces.push({ start: Math.max(r.start, segStart), end: Math.min(r.end, segEnd), isBreaker: true });
    }
    allPieces.sort((a, b) => a.start - b.start);

    if (!allPieces.length) {
      out.push(...emitGap(segStart, segEnd, opts));
      continue;
    }

    let cursor = segStart;
    for (const p of allPieces) {
      if (p.start - cursor > 0.02) {
        out.push(...emitGap(cursor, p.start, opts));
      }
      if (p.isBreaker) {
        out.push({
          id: uid(),
          type: breakerAction === "cut" ? "cut" : "card",
          start: p.start,
          end: p.end,
          ...(breakerAction !== "cut" && breakerVariant === "short"
            ? { card: { variant: "short" as const } }
            : {}),
        });
      } else {
        out.push({ id: uid(), type: "body", start: p.start, end: p.end });
      }
      cursor = Math.max(cursor, p.end);
    }
    if (segEnd - cursor > 0.02) {
      out.push(...emitGap(cursor, segEnd, opts));
    }
  }

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
