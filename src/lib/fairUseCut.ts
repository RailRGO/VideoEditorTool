import type { Segment } from "./types";
import type { Region } from "./analyze";
import type { Word } from "./polish";
import { tidy, uid } from "./timeline";
import { speechRegionsFromWords } from "./transcriptCut";

export interface FairUseOptions {
  maxBodySec: number;
  removedAction: "cut" | "card";
  cardDuration: number;
  bucketSec: number;
  keepPad: number;
  maxSpeech: number;
  breakerDuration: number;
  breakerAction: "card" | "cut";
}

export const defaultFairUse: FairUseOptions = {
  maxBodySec: 600,
  removedAction: "cut",
  cardDuration: 3,
  bucketSec: 1,
  keepPad: 0.5,
  maxSpeech: 30,
  breakerDuration: 3,
  breakerAction: "card",
};

export interface FairUseReport {
  originalBody: number;
  limitedBody: number;
  keptBuckets: number;
  totalBuckets: number;
  saved: number;
}

function buildBuckets(
  spanStart: number,
  spanEnd: number,
  bucketSec: number,
  speech: Region[]
): { start: number; end: number; score: number }[] {
  const buckets: { start: number; end: number; score: number }[] = [];
  for (let t = spanStart; t < spanEnd - 0.01; t += bucketSec) {
    const bEnd = Math.min(t + bucketSec, spanEnd);
    let score = 0;
    for (const s of speech) {
      if (s.end <= t) continue;
      if (s.start >= bEnd) break;
      const overlap = Math.min(s.end, bEnd) - Math.max(s.start, t);
      if (overlap > 0) score += overlap;
    }
    buckets.push({ start: t, end: bEnd, score });
  }
  return buckets;
}

export function buildFairUseLimit(
  segments: Segment[],
  duration: number,
  opts: FairUseOptions,
  speechOrWords: Region[] | Word[] | null,
  bodySpan?: Region,
  detectionRegions?: Region[] | null
): { segments: Segment[]; report: FairUseReport } {
  const rewriteTypes = new Set(["body", "lead", "mute", "fast", "card"]);
  const bodySegs = segments.filter((s) => rewriteTypes.has(s.type));
  const spanStart = bodySpan ? bodySpan.start : (bodySegs[0]?.start ?? 0);
  const spanEnd = bodySpan ? bodySpan.end : (bodySegs[bodySegs.length - 1]?.end ?? duration);
  const bodyDuration = Math.max(0, spanEnd - spanStart);

  if (bodyDuration <= opts.maxBodySec + 0.01) {
    return {
      segments,
      report: {
        originalBody: bodyDuration,
        limitedBody: bodyDuration,
        keptBuckets: Math.ceil(bodyDuration / opts.bucketSec),
        totalBuckets: Math.ceil(bodyDuration / opts.bucketSec),
        saved: 0,
      },
    };
  }

  let speech: Region[] = [];
  if (speechOrWords && speechOrWords.length) {
    const first = speechOrWords[0] as any;
    if (first && typeof first.text === "string" && typeof first.start === "number") {
      speech = speechRegionsFromWords(speechOrWords as Word[], 0.25, 0.8);
    } else {
      speech = (speechOrWords as Region[]).map((r) => ({ start: r.start, end: r.end }));
    }
  } else if (detectionRegions && detectionRegions.length) {
    speech = detectionRegions.map((r) => ({ start: r.start, end: r.end }));
  }

  if (!speech.length) {
    const keepEnd = spanStart + opts.maxBodySec;
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
      const ss = Math.max(s.start, spanStart);
      const se = Math.min(s.end, spanEnd);
      if (se <= keepEnd) {
        if (ss < keepEnd) out.push({ ...s, start: ss, end: Math.min(se, keepEnd) });
      } else if (ss < keepEnd) {
        out.push({ ...s, start: ss, end: keepEnd });
        if (opts.removedAction === "card" && se - keepEnd > opts.cardDuration) {
          out.push({ id: uid(), type: "card", start: keepEnd, end: keepEnd + opts.cardDuration });
          out.push({ id: uid(), type: "cut", start: keepEnd + opts.cardDuration, end: se });
        } else {
          out.push({ id: uid(), type: opts.removedAction, start: keepEnd, end: se });
        }
      } else {
        if (opts.removedAction === "card" && se - ss > opts.cardDuration) {
          out.push({ id: uid(), type: "card", start: ss, end: ss + opts.cardDuration });
          out.push({ id: uid(), type: "cut", start: ss + opts.cardDuration, end: se });
        } else {
          out.push({ id: uid(), type: opts.removedAction, start: ss, end: se });
        }
      }
    }
    const final = tidy(out).filter((s) => s.end - s.start > 0.08);
    return {
      segments: final,
      report: {
        originalBody: bodyDuration,
        limitedBody: opts.maxBodySec,
        keptBuckets: Math.ceil(opts.maxBodySec / opts.bucketSec),
        totalBuckets: Math.ceil(bodyDuration / opts.bucketSec),
        saved: bodyDuration - opts.maxBodySec,
      },
    };
  }

  speech.sort((a, b) => a.start - b.start);
  const buckets = buildBuckets(spanStart, spanEnd, opts.bucketSec, speech);
  const targetBuckets = Math.ceil(opts.maxBodySec / opts.bucketSec);
  const sorted = [...buckets].sort((a, b) => b.score - a.score || a.start - b.start);
  const selected = sorted.slice(0, targetBuckets);

  const bucketIndex = new Map<number, number>();
  buckets.forEach((b, i) => bucketIndex.set(b.start, i));
  const keepSet = new Set<number>();
  const padBuckets = Math.ceil(opts.keepPad / opts.bucketSec);
  for (const b of selected) {
    const idx = bucketIndex.get(b.start)!;
    for (let d = -padBuckets; d <= padBuckets; d++) {
      const ni = idx + d;
      if (ni >= 0 && ni < buckets.length) keepSet.add(ni);
    }
  }
  let keepIndices = Array.from(keepSet).sort((a, b) => a - b);
  if (keepIndices.length > targetBuckets) {
    const scored = keepIndices.map((i) => ({ i, score: buckets[i].score, start: buckets[i].start }));
    scored.sort((a, b) => b.score - a.score || a.start - b.start);
    const trimmed = scored.slice(0, targetBuckets).map((s) => s.i).sort((a, b) => a - b);
    keepIndices = trimmed;
  }

  const keepMask = new Set(keepIndices);
  const rawKept: Region[] = [];
  let cur: Region | null = null;
  for (let i = 0; i < buckets.length; i++) {
    if (!keepMask.has(i)) {
      if (cur) {
        rawKept.push(cur);
        cur = null;
      }
      continue;
    }
    const b = buckets[i];
    if (!cur) cur = { start: b.start, end: b.end };
    else if (Math.abs(cur.end - b.start) < 0.02) cur.end = b.end;
    else {
      rawKept.push(cur);
      cur = { start: b.start, end: b.end };
    }
  }
  if (cur) rawKept.push(cur);

  // Insert breaker cards inside long kept intervals every maxSpeech
  const maxSpeech = (opts as any).maxSpeech ?? 30;
  const breakerDur = (opts as any).breakerDuration ?? 3;
  const breakerAction = (opts as any).breakerAction ?? "card";
  const keptIntervals: Region[] = [];
  const breakerIntervals: Region[] = [];
  if (maxSpeech > 1 && breakerDur > 0) {
    for (const r of rawKept) {
      let c = r.start;
      while (c < r.end - 0.01) {
        const bodyEnd = Math.min(r.end, c + maxSpeech);
        keptIntervals.push({ start: c, end: bodyEnd });
        c = bodyEnd;
        if (c < r.end - 0.01) {
          const brEnd = Math.min(r.end, c + breakerDur);
          if (brEnd - c > 0.05) {
            breakerIntervals.push({ start: c, end: brEnd });
            c = brEnd;
          }
        }
      }
    }
  } else {
    keptIntervals.push(...rawKept);
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
    const ss = Math.max(s.start, spanStart);
    const se = Math.min(s.end, spanEnd);
    // Collect overlapping kept + breaker pieces
    const pieces: { start: number; end: number; isBreaker: boolean }[] = [];
    for (const k of keptIntervals) {
      if (k.end <= ss + 0.01 || k.start >= se - 0.01) continue;
      pieces.push({ start: Math.max(k.start, ss), end: Math.min(k.end, se), isBreaker: false });
    }
    for (const b of breakerIntervals) {
      if (b.end <= ss + 0.01 || b.start >= se - 0.01) continue;
      pieces.push({ start: Math.max(b.start, ss), end: Math.min(b.end, se), isBreaker: true });
    }
    pieces.sort((a, b) => a.start - b.start);

    let cursor = ss;
    for (const p of pieces) {
      if (p.start - cursor > 0.02) {
        if (opts.removedAction === "card" && p.start - cursor > opts.cardDuration) {
          out.push({ id: uid(), type: "card", start: cursor, end: cursor + opts.cardDuration });
          out.push({ id: uid(), type: "cut", start: cursor + opts.cardDuration, end: p.start });
        } else {
          out.push({ id: uid(), type: opts.removedAction, start: cursor, end: p.start });
        }
      }
      if (p.isBreaker) {
        out.push({ id: uid(), type: breakerAction as any, start: p.start, end: p.end });
      } else {
        out.push({ id: uid(), type: "body", start: p.start, end: p.end });
      }
      cursor = Math.max(cursor, p.end);
    }
    if (se - cursor > 0.02) {
      if (opts.removedAction === "card" && se - cursor > opts.cardDuration) {
        out.push({ id: uid(), type: "card", start: cursor, end: cursor + opts.cardDuration });
        out.push({ id: uid(), type: "cut", start: cursor + opts.cardDuration, end: se });
      } else {
        out.push({ id: uid(), type: opts.removedAction, start: cursor, end: se });
      }
    }
  }

  const final = tidy(out).filter((s) => s.end - s.start > 0.08 && s.end <= duration + 0.05);
  const limitedBody = keptIntervals.reduce((a, r) => a + (r.end - r.start), 0);
  return {
    segments: final,
    report: {
      originalBody: bodyDuration,
      limitedBody,
      keptBuckets: keepIndices.length,
      totalBuckets: buckets.length,
      saved: bodyDuration - limitedBody,
    },
  };
}
