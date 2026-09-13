import type { Segment } from "./types";
import type { Region } from "./analyze";
import type { Word } from "./polish";
import { tidy, uid } from "./timeline";
import { speechRegionsFromWords } from "./transcriptCut";

/**
 * Fair-use limiter: ensure the reaction (body) part does not exceed `maxBodySec`.
 * Keeps the most speech-rich portions of the body, preserving order.
 *
 * - rewriteTypes = body/lead/mute/fast/card (intro/outro untouched)
 * - bodySpan optionally limits the operation to a sub-range (usually bodySpan)
 * - speechRegions: from transcript words (preferred) or from detection.regions
 * - scoring: 1s buckets scored by speech overlap, plus small bonus for being near speech
 * - kept buckets merged into body segments, gaps become cut (or card+cut if large? we use cut for simplicity)
 * - If no speech info, keeps the first maxBodySec (chronological trim).
 */
export interface FairUseOptions {
  maxBodySec: number; // e.g. 600 = 10 min
  /** how to treat removed parts: cut or card+cut (for YT) */
  removedAction: "cut" | "card";
  /** card duration when removedAction=card and gap large */
  cardDuration: number;
  /** bucket size for scoring, seconds */
  bucketSec: number;
  /** keep at least this much context around kept speech */
  keepPad: number;
}

export const defaultFairUse: FairUseOptions = {
  maxBodySec: 600,
  removedAction: "cut",
  cardDuration: 3,
  bucketSec: 1,
  keepPad: 0.5,
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

  // Normalize speech regions
  let speech: Region[] = [];
  if (speechOrWords && speechOrWords.length) {
    // Check if Word[]
    const first = speechOrWords[0] as any;
    if (first && typeof first.text === "string" && typeof first.start === "number") {
      speech = speechRegionsFromWords(speechOrWords as Word[], 0.25, 0.8);
    } else {
      speech = (speechOrWords as Region[]).map((r) => ({ start: r.start, end: r.end }));
    }
  } else if (detectionRegions && detectionRegions.length) {
    speech = detectionRegions.map((r) => ({ start: r.start, end: r.end }));
  }

  // If no speech info, fallback to chronological first N seconds
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
        // remainder becomes cut/card
        if (opts.removedAction === "card" && se - keepEnd > opts.cardDuration) {
          out.push({ id: uid(), type: "card", start: keepEnd, end: keepEnd + opts.cardDuration });
          out.push({ id: uid(), type: "cut", start: keepEnd + opts.cardDuration, end: se });
        } else {
          out.push({ id: uid(), type: opts.removedAction, start: keepEnd, end: se });
        }
      } else {
        // beyond limit -> cut
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

  // Score buckets
  speech.sort((a, b) => a.start - b.start);
  const buckets = buildBuckets(spanStart, spanEnd, opts.bucketSec, speech);
  // Sort by score desc, keep top N
  const targetBuckets = Math.ceil(opts.maxBodySec / opts.bucketSec);
  const sorted = [...buckets].sort((a, b) => b.score - a.score || a.start - b.start);
  const selected = sorted.slice(0, targetBuckets);
  // If we have less speech than target, fill with chronological early buckets to reach limit?
  // Already selected top scoring; but we need to ensure we keep contiguous context.
  // Add pad: for each selected bucket, also select neighbours within keepPad
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
  // If keepSet exceeds targetBuckets, trim lowest scoring among padded set
  let keepIndices = Array.from(keepSet).sort((a, b) => a - b);
  if (keepIndices.length > targetBuckets) {
    // Keep highest scoring among keepSet
    const scored = keepIndices.map((i) => ({ i, score: buckets[i].score, start: buckets[i].start }));
    scored.sort((a, b) => b.score - a.score || a.start - b.start);
    const trimmed = scored.slice(0, targetBuckets).map((s) => s.i).sort((a, b) => a - b);
    keepIndices = trimmed;
  }

  const keepMask = new Set(keepIndices);
  // Build kept intervals in time order
  const keptIntervals: Region[] = [];
  let cur: Region | null = null;
  for (let i = 0; i < buckets.length; i++) {
    if (!keepMask.has(i)) {
      if (cur) {
        keptIntervals.push(cur);
        cur = null;
      }
      continue;
    }
    const b = buckets[i];
    if (!cur) cur = { start: b.start, end: b.end };
    else if (Math.abs(cur.end - b.start) < 0.02) cur.end = b.end;
    else {
      keptIntervals.push(cur);
      cur = { start: b.start, end: b.end };
    }
  }
  if (cur) keptIntervals.push(cur);

  // Now rebuild segments: intro/outro untouched, body replaced by keptIntervals as body, gaps as removedAction
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
    // Intersect ss-se with keptIntervals
    let cursor = ss;
    for (const k of keptIntervals) {
      if (k.end <= cursor + 0.01) continue;
      if (k.start >= se - 0.01) break;
      const ks = Math.max(k.start, ss);
      const ke = Math.min(k.end, se);
      if (ks - cursor > 0.02) {
        // gap -> removed
        if (opts.removedAction === "card" && ks - cursor > opts.cardDuration) {
          out.push({ id: uid(), type: "card", start: cursor, end: cursor + opts.cardDuration });
          out.push({ id: uid(), type: "cut", start: cursor + opts.cardDuration, end: ks });
        } else {
          out.push({ id: uid(), type: opts.removedAction, start: cursor, end: ks });
        }
      }
      out.push({ id: uid(), type: "body", start: ks, end: ke });
      cursor = ke;
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
