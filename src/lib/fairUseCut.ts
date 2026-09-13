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
  /** breaker card size: short covers the top only (subs stay visible) */
  breakerVariant: "full" | "short";
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
  breakerVariant: "short",
};

export interface FairUseReport {
  /** kept programme (output) seconds inside the reaction span, before limiting */
  originalBody: number;
  /** kept programme seconds the limiter aims at (<= maxBodySec) */
  limitedBody: number;
  keptBuckets: number;
  totalBuckets: number;
  saved: number;
  /** programme seconds of preserved cards inside the span (never touched) */
  preservedCards?: number;
}

/**
 * Only these are candidates for removal. Everything else is preserved:
 * - intro/outro: never touched (solo full-cam)
 * - cut: already removed by an earlier step (e.g. the transcript cut) — stays cut,
 *   and is NOT counted against the budget (it produces no output)
 * - card: a Patreon card from an earlier step — stays a card, keeps its slot
 *   in the budget (it produces output)
 *
 * So running transcript-cut first and the fair-use limiter second now stacks:
 * the limiter only shortens the remaining reaction footage.
 */
const REWRITE = new Set(["body", "lead", "mute", "fast"]);

function progLen(s: Segment, fastSpeed: number): number {
  const src = Math.max(0, s.end - s.start);
  return s.type === "fast" ? src / Math.max(1.05, fastSpeed) : src;
}

/** Kept (non-cut) programme seconds of `segments` clipped to [spanStart, spanEnd). */
function keptProgramme(
  segments: Segment[],
  spanStart: number,
  spanEnd: number,
  fastSpeed: number,
  onlyRewriteable = false
): number {
  let total = 0;
  for (const s of segments) {
    if (s.type === "cut") continue;
    if (onlyRewriteable && !REWRITE.has(s.type)) continue;
    const a = Math.max(s.start, spanStart);
    const b = Math.min(s.end, spanEnd);
    if (b - a <= 0.001) continue;
    total += progLen({ ...s, start: a, end: b }, fastSpeed);
  }
  return total;
}

function speechOf(
  speechOrWords: Region[] | Word[] | null,
  detectionRegions?: Region[] | null
): Region[] {
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
  return speech.sort((a, b) => a.start - b.start);
}

function overlapScore(speech: Region[], a: number, b: number): number {
  let score = 0;
  for (const s of speech) {
    if (s.end <= a) continue;
    if (s.start >= b) break;
    const overlap = Math.min(s.end, b) - Math.max(s.start, a);
    if (overlap > 0) score += overlap;
  }
  return score;
}

export function buildFairUseLimit(
  segments: Segment[],
  duration: number,
  opts: FairUseOptions,
  speechOrWords: Region[] | Word[] | null,
  bodySpan?: Region,
  detectionRegions?: Region[] | null,
  fastSpeed = 4
): { segments: Segment[]; report: FairUseReport } {
  const tidied = tidy(segments);
  const rewriteable = tidied.filter((s) => REWRITE.has(s.type));
  const spanStart = bodySpan ? bodySpan.start : (rewriteable[0]?.start ?? 0);
  const spanEnd = bodySpan ? bodySpan.end : (rewriteable[rewriteable.length - 1]?.end ?? duration);

  // Programme (output) accounting: cuts produce no output, so they neither
  // consume the budget nor get rewritten. Cards produce output, so they keep
  // their slot — but are never rewritten either.
  const originalBody = keptProgramme(tidied, spanStart, spanEnd, fastSpeed, false);
  const rewriteableProg = keptProgramme(tidied, spanStart, spanEnd, fastSpeed, true);
  const preservedProg = Math.max(0, originalBody - rewriteableProg);

  const emptyReport = (limited: number): FairUseReport => ({
    originalBody,
    limitedBody: limited,
    keptBuckets: 0,
    totalBuckets: 0,
    saved: Math.max(0, originalBody - limited),
    preservedCards: preservedProg,
  });

  if (originalBody <= opts.maxBodySec + 0.01 || rewriteableProg <= 0.01) {
    return { segments, report: emptyReport(originalBody) };
  }

  // The rewriteable footage must shrink to whatever the preserved cards left.
  const rewriteBudget = Math.max(0, opts.maxBodySec - preservedProg);
  const speech = speechOf(speechOrWords, detectionRegions);

  // Buckets cover ONLY rewriteable footage — cards/cuts are holes in the map.
  interface Bucket { start: number; end: number; score: number; type: Segment["type"] }
  const buckets: Bucket[] = [];
  for (const s of rewriteable) {
    const ss = Math.max(s.start, spanStart);
    const se = Math.min(s.end, spanEnd);
    for (let t = ss; t < se - 0.01; t += opts.bucketSec) {
      const bEnd = Math.min(t + opts.bucketSec, se);
      buckets.push({
        start: t,
        end: bEnd,
        score: speech.length ? overlapScore(speech, t, bEnd) : 0,
        type: s.type,
      });
    }
  }
  if (!buckets.length) {
    return { segments, report: emptyReport(originalBody) };
  }

  const progPerBucket = rewriteableProg / buckets.length;
  const targetBuckets = Math.max(
    0,
    Math.min(buckets.length, Math.round(rewriteBudget / Math.max(1e-6, progPerBucket)))
  );

  const keepSet = new Set<number>();
  if (targetBuckets > 0) {
    // No speech info: keep chronologically (first N). Otherwise keep densest.
    const ranked = buckets
      .map((b, i) => ({ i, score: b.score, start: b.start }))
      .sort((a, b) => (speech.length ? b.score - a.score || a.start - b.start : a.start - b.start));
    const selected = ranked.slice(0, targetBuckets);
    const padBuckets = Math.ceil(opts.keepPad / opts.bucketSec);
    // Context padding must not leak across preserved cards/cuts: only pad
    // into buckets adjacent in time (gap <= ~1 bucket).
    for (const sel of selected) {
      keepSet.add(sel.i);
      for (let d = 1; d <= padBuckets; d++) {
        for (const ni of [sel.i - d, sel.i + d]) {
          if (ni < 0 || ni >= buckets.length || keepSet.has(ni)) continue;
          const a = buckets[sel.i];
          const b = buckets[ni];
          const gap =
            ni > sel.i
              ? Math.max(0, b.start - a.end)
              : Math.max(0, a.start - b.end);
          if (gap < opts.bucketSec * 1.5 + 0.05) keepSet.add(ni);
        }
      }
    }
    if (keepSet.size > targetBuckets) {
      const scored = [...keepSet].map((i) => ({ i, score: buckets[i].score, start: buckets[i].start }));
      scored.sort((a, b) => (speech.length ? b.score - a.score || a.start - b.start : a.start - b.start));
      const trimmed = new Set(scored.slice(0, targetBuckets).map((s) => s.i));
      keepSet.clear();
      for (const i of trimmed) keepSet.add(i);
    }
  }

  // Merge kept buckets into intervals (only across adjacent buckets).
  const keepIndices = [...keepSet].sort((a, b) => a - b);
  const keptIntervals: { start: number; end: number; type: Segment["type"] }[] = [];
  for (const i of keepIndices) {
    const b = buckets[i];
    const last = keptIntervals[keptIntervals.length - 1];
    if (last && Math.abs(last.end - b.start) < 0.05 && last.type === b.type) last.end = b.end;
    else keptIntervals.push({ start: b.start, end: b.end, type: b.type });
  }

  // Breaker cards inside long kept intervals (Content ID disruption).
  // maxSpeech <= 1 (slider "off") disables them entirely.
  const maxSpeech = opts.maxSpeech ?? 30;
  const breakerDur = opts.breakerDuration ?? 3;
  const breakerAction = opts.breakerAction ?? "card";
  const breakerVariant = opts.breakerVariant ?? "short";
  const keptFinal: { start: number; end: number; type: Segment["type"] }[] = [];
  const breakerIntervals: Region[] = [];
  if (maxSpeech > 1 && breakerDur > 0) {
    for (const r of keptIntervals) {
      let c = r.start;
      while (c < r.end - 0.01) {
        const bodyEnd = Math.min(r.end, c + maxSpeech);
        keptFinal.push({ start: c, end: bodyEnd, type: r.type });
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
    keptFinal.push(...keptIntervals);
  }

  const emitRemoved = (from: number, to: number): Segment[] => {
    if (to - from <= 0.02) return [];
    if (opts.removedAction === "card" && to - from > opts.cardDuration) {
      return [
        { id: uid(), type: "card", start: from, end: from + opts.cardDuration },
        { id: uid(), type: "cut", start: from + opts.cardDuration, end: to },
      ];
    }
    return [{ id: uid(), type: opts.removedAction, start: from, end: to }];
  };

  const out: Segment[] = [];
  for (const s of tidied) {
    if (!REWRITE.has(s.type)) {
      out.push(s); // intro/outro/card/cut: preserved byte-for-byte
      continue;
    }
    if (s.end <= spanStart || s.start >= spanEnd) {
      out.push(s);
      continue;
    }
    const ss = Math.max(s.start, spanStart);
    const se = Math.min(s.end, spanEnd);
    const pieces: { start: number; end: number; isBreaker: boolean; type: Segment["type"] }[] = [];
    for (const k of keptFinal) {
      if (k.end <= ss + 0.01 || k.start >= se - 0.01) continue;
      pieces.push({ start: Math.max(k.start, ss), end: Math.min(k.end, se), isBreaker: false, type: k.type });
    }
    for (const b of breakerIntervals) {
      if (b.end <= ss + 0.01 || b.start >= se - 0.01) continue;
      pieces.push({ start: Math.max(b.start, ss), end: Math.min(b.end, se), isBreaker: true, type: "card" });
    }
    pieces.sort((a, b) => a.start - b.start);

    let cursor = ss;
    for (const p of pieces) {
      if (p.start - cursor > 0.02) out.push(...emitRemoved(cursor, p.start));
      if (p.isBreaker) {
        out.push({
          id: uid(),
          type: breakerAction as Segment["type"],
          start: p.start,
          end: p.end,
          ...(breakerAction === "card" && breakerVariant === "short"
            ? { card: { variant: "short" as const } }
            : {}),
        });
      } else {
        // kept footage keeps its original type (a muted stretch stays muted…)
        out.push({ id: uid(), type: p.type, start: p.start, end: p.end });
      }
      cursor = Math.max(cursor, p.end);
    }
    if (se - cursor > 0.02) out.push(...emitRemoved(cursor, se));
  }

  const final = tidy(out).filter((s) => s.end - s.start > 0.08 && s.end <= duration + 0.05);
  const limitedBody = keptProgramme(final, spanStart, spanEnd, fastSpeed, false);
  return {
    segments: final,
    report: {
      originalBody,
      limitedBody,
      keptBuckets: keepIndices.length,
      totalBuckets: buckets.length,
      saved: Math.max(0, originalBody - limitedBody),
      preservedCards: preservedProg,
    },
  };
}
