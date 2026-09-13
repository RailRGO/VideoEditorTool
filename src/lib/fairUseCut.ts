import type { Segment } from "./types";
import type { Region } from "./analyze";
import type { Word } from "./polish";
import { segSpeed, tidy, uid } from "./timeline";
import { speechRegionsFromWords } from "./transcriptCut";

export interface FairUseOptions {
  /**
   * How the limiter works:
   * - "cards" (default): cut nothing. Long stretches of talking get short
   *   cards laid over the content every `everySec` seconds, so Content ID
   *   never sees an uninterrupted run of the programme.
   * - "trim": the older behaviour — keep only the most speech-dense minutes
   *   of the reaction up to `maxBodySec` and drop the rest.
   */
  mode: "cards" | "trim";
  /** cards mode: seconds of talking kept before each card */
  everySec: number;
  /** cards mode: how long the card stays up */
  cardSec: number;
  /** cards mode: playback speed while a card is up (1 = normal) */
  cardSpeed: number;
  /** cards mode: talking stretches shorter than this are left alone */
  minRunSec: number;
  /** trim mode: target length of the reaction part */
  maxBodySec: number;
  /** trim mode: what happens to the parts that are dropped */
  removedAction: "cut" | "card";
  /** trim mode: pointer card left in front of a dropped stretch */
  cardDuration: number;
  bucketSec: number;
  keepPad: number;
  /**
   * Legacy/ignored: the limiter only ever inserts SHORT cards, whatever this
   * says. Old projects that stored "full" must not come back with tall cards
   * covering the whole content — the bottom of the picture has to stay
   * visible so the subtitles and the reaction still read.
   */
  cardVariant: "full" | "short";
}

export const defaultFairUse: FairUseOptions = {
  mode: "cards",
  everySec: 8,
  cardSec: 4,
  cardSpeed: 1,
  minRunSec: 6,
  maxBodySec: 600,
  removedAction: "cut",
  cardDuration: 3,
  bucketSec: 1,
  keepPad: 0.5,
  cardVariant: "short",
};

export interface FairUseReport {
  mode: "cards" | "trim";
  /** kept programme (output) seconds inside the reaction span, before limiting */
  originalBody: number;
  /** kept programme seconds the limiter aims at (<= maxBodySec) */
  limitedBody: number;
  /** cards mode: how many cards were laid down */
  cards: number;
  /** cards mode: programme seconds spent under a card */
  cardTime: number;
  keptBuckets: number;
  totalBuckets: number;
  saved: number;
  /** programme seconds of preserved cards inside the span (never touched) */
  preservedCards?: number;
}

const REWRITE = new Set(["body", "lead", "mute", "fast"]);
/** every card this module inserts is short: subs and the reaction stay visible */
const LIMITER_CARD: "short" = "short";
/** cards may be laid over these too (the card hides the content anyway) */
const COVERABLE = new Set(["body", "lead", "mute", "fast", "card"]);

function progLen(s: Segment, fastSpeed: number): number {
  if (s.type === "cut") return 0;
  return Math.max(0, s.end - s.start) / segSpeed(s, fastSpeed);
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

/** Merge regions that touch or nearly touch, then clip to the span. */
function runsIn(speech: Region[], spanStart: number, spanEnd: number, gap = 1.0): Region[] {
  const clipped = speech
    .map((r) => ({ start: Math.max(r.start, spanStart), end: Math.min(r.end, spanEnd) }))
    .filter((r) => r.end - r.start > 0.05)
    .sort((a, b) => a.start - b.start);
  const out: Region[] = [];
  for (const r of clipped) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Cards mode: keep every second of the reaction and lay short cards over the
 * long talking stretches, `cardSec` of card after every `everySec` of speech.
 *
 * A 30 s talking stretch with the defaults (8 s / 4 s) gets cards at 8–12 s
 * and 20–24 s. Nothing is removed, so the only thing Content ID sees is a
 * programme that keeps getting interrupted — and because the card hides the
 * content anyway, it can be played `cardSpeed` × to claw back some time.
 */
function buildCards(
  segments: Segment[],
  duration: number,
  opts: FairUseOptions,
  speech: Region[],
  spanStart: number,
  spanEnd: number,
  fastSpeed: number
): { segments: Segment[]; intervals: Region[] } {
  const every = Math.max(1.5, opts.everySec);
  const cardLen = Math.max(0.5, Math.min(opts.cardSec, every));
  const minRun = Math.max(0, opts.minRunSec);

  // Where the talking is: real speech runs, or — with no speech info at all —
  // every kept stretch, so "just sprinkle cards" still works.
  let runs: Region[] = [];
  if (speech.length) {
    runs = runsIn(speech, spanStart, spanEnd).filter((r) => r.end - r.start >= minRun);
  } else {
    for (const s of tidy(segments)) {
      if (!COVERABLE.has(s.type)) continue;
      const a = Math.max(s.start, spanStart);
      const b = Math.min(s.end, spanEnd);
      if (b - a >= every + cardLen) runs.push({ start: a, end: b });
    }
  }

  // Lay the cards down: `every` seconds of talking, then a card, repeating.
  // A card never runs past the end of the run and never sits in its last
  // second (no point covering the pause that follows).
  const intervals: { start: number; end: number; segType: Segment["type"] }[] = [];
  const byStart = tidy(segments);
  const typeAt = (t: number): Segment["type"] => {
    for (const s of byStart) if (t >= s.start && t < s.end) return s.type;
    return "body";
  };
  for (const r of runs) {
    let cursor = r.start;
    while (cursor + every < r.end - 1.0) {
      const a = cursor + every;
      const b = Math.min(r.end - 0.5, a + cardLen);
      if (b - a < Math.min(1, cardLen * 0.5)) break;
      const t = typeAt(a);
      if (COVERABLE.has(t)) intervals.push({ start: a, end: b, segType: t });
      cursor = a + cardLen;
    }
  }

  // Split the timeline by the card intervals; everything else is preserved.
  const out: Segment[] = [];
  const cards: Region[] = [];
  for (const s of tidy(segments)) {
    if (!COVERABLE.has(s.type)) {
      out.push(s);
      continue;
    }
    const ss = Math.max(s.start, spanStart);
    const se = Math.min(s.end, spanEnd);
    if (se <= ss) {
      out.push(s);
      continue;
    }
    const hits = intervals
      .filter((iv) => iv.end > ss + 0.02 && iv.start < se - 0.02)
      .sort((a, b) => a.start - b.start);
    let cursor = ss;
    for (const iv of hits) {
      const a = Math.max(iv.start, ss);
      const b = Math.min(iv.end, se);
      if (a - cursor > 0.02) out.push({ id: uid(), type: s.type, start: cursor, end: a });
      const speed = s.type === "fast" ? Math.max(1.05, fastSpeed) : Math.max(1, opts.cardSpeed);
      out.push({
        id: uid(),
        type: "card",
        start: a,
        end: b,
        card: {
          variant: LIMITER_CARD,
          ...(speed > 1.0001 ? { speed } : {}),
        },
      });
      cards.push({ start: a, end: b });
      cursor = Math.max(cursor, b);
    }
    if (se - cursor > 0.02) out.push({ id: uid(), type: s.type, start: cursor, end: se });
  }

  return {
    segments: tidy(out).filter((s) => s.end - s.start > 0.08 && s.end <= duration + 0.05),
    intervals: cards,
  };
}

/**
 * Trim mode: keep the most speech-dense seconds of the reaction up to
 * `maxBodySec`, preserving order.
 *
 * The old build kept buckets purely by score with "earliest first" as the
 * tie-break, so a nearly-uniform audio scan (everything scores ~1.0) kept the
 * *first* ten minutes and cut the tail. The selection below spreads the keeps
 * over the whole reaction instead: a candidate has to be far enough from an
 * already-kept one, so the result is "the speech-rich parts of the reaction",
 * not "the reaction's opening act".
 */
function buildTrim(
  segments: Segment[],
  duration: number,
  opts: FairUseOptions,
  speech: Region[],
  spanStart: number,
  spanEnd: number,
  fastSpeed: number
): { segments: Segment[]; kept: number; total: number; trimmed: Region[] } {
  const tidied = tidy(segments);
  const rewriteable = tidied.filter((s) => REWRITE.has(s.type));
  const originalBody = keptProgramme(tidied, spanStart, spanEnd, fastSpeed, false);
  const rewriteableProg = keptProgramme(tidied, spanStart, spanEnd, fastSpeed, true);
  const preservedProg = Math.max(0, originalBody - rewriteableProg);
  if (originalBody <= opts.maxBodySec + 0.01 || rewriteableProg <= 0.01) {
    return {
      segments,
      kept: 0,
      total: 0,
      trimmed: tidied
        .filter((s) => s.type !== "cut" && s.end > spanStart && s.start < spanEnd)
        .map((s) => ({ start: Math.max(s.start, spanStart), end: Math.min(s.end, spanEnd) })),
    };
  }

  const rewriteBudget = Math.max(0, opts.maxBodySec - preservedProg);
  interface Bucket {
    start: number;
    end: number;
    score: number;
    type: Segment["type"];
  }
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
    return { segments, kept: 0, total: 0, trimmed: [] };
  }

  const progPerBucket = rewriteableProg / buckets.length;
  // Each kept island carries its context padding, and that padding is real
  // programme time — it has to come out of the budget, or "limit to 10 min"
  // lands well past the limit once there is more than one island.
  const pad = Math.max(0, Math.min(opts.keepPad, opts.bucketSec));
  const perIsland = progPerBucket + 2 * pad;
  const target = Math.max(
    0,
    Math.min(buckets.length, Math.round(rewriteBudget / Math.max(1e-6, perIsland)))
  );

  // Windows: split the footage into `target` equal slots and keep the best
  // bucket of each. The keeps therefore land all over the reaction — start,
  // middle and end all survive — instead of piling up at the front, which is
  // what "score order with an earliest-first tie-break" used to do (a flat
  // audio scan kept the first N minutes and cut the rest).
  const chosen: number[] = [];
  for (let w = 0; w < target; w++) {
    const a = Math.floor((w * buckets.length) / target);
    const b = Math.max(a + 1, Math.floor(((w + 1) * buckets.length) / target));
    let best = -1;
    for (let i = a; i < b && i < buckets.length; i++) {
      if (!speech.length) {
        best = i; // no scores to compare — one sample per window
        break;
      }
      if (best < 0 || buckets[i].score > buckets[best].score) best = i;
    }
    if (best >= 0) chosen.push(best);
  }

  const keepSet = new Set(chosen);

  const keepIndices = [...keepSet].sort((a, b) => a - b);
  const keptIntervals: { start: number; end: number; type: Segment["type"] }[] = [];
  for (const i of keepIndices) {
    const b = buckets[i];
    const last = keptIntervals[keptIntervals.length - 1];
    if (last && Math.abs(last.end - b.start) < 0.05 && last.type === b.type) last.end = b.end;
    else keptIntervals.push({ start: b.start, end: b.end, type: b.type });
  }

  // Context padding around each kept island (never across preserved cards).
  const padded = keptIntervals.map((r) => ({ ...r }));
  for (const r of padded) {
    r.start = Math.max(spanStart, r.start - pad);
    r.end = Math.min(spanEnd, r.end + pad);
  }
  const merged: typeof keptIntervals = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= 0.05 && last.type === r.type) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  const emitRemoved = (from: number, to: number): Segment[] => {
    if (to - from <= 0.02) return [];
    if (opts.removedAction === "card" && to - from > opts.cardDuration) {
      return [
        {
          id: uid(),
          type: "card",
          start: from,
          end: from + opts.cardDuration,
          card: { variant: LIMITER_CARD },
        },
        { id: uid(), type: "cut", start: from + opts.cardDuration, end: to },
      ];
    }
    // a dropped stretch that is shorter than a card gets a short card too —
    // never a tall one, whatever an old project stored in cardVariant
    if (opts.removedAction === "card") {
      return [{ id: uid(), type: "card", start: from, end: to,
                card: { variant: LIMITER_CARD } }];
    }
    return [{ id: uid(), type: opts.removedAction, start: from, end: to }];
  };

  const out: Segment[] = [];
  for (const s of tidied) {
    if (!REWRITE.has(s.type)) {
      out.push(s);
      continue;
    }
    if (s.end <= spanStart || s.start >= spanEnd) {
      out.push(s);
      continue;
    }
    const ss = Math.max(s.start, spanStart);
    const se = Math.min(s.end, spanEnd);
    let cursor = ss;
    for (const k of merged) {
      if (k.end <= cursor + 0.02 || k.start >= se - 0.02) continue;
      const a = Math.max(k.start, cursor);
      const b = Math.min(k.end, se);
      if (b - a <= 0.02) continue;
      if (a - cursor > 0.02) out.push(...emitRemoved(cursor, a));
      out.push({ id: uid(), type: s.type, start: a, end: b });
      cursor = Math.max(cursor, b);
    }
    if (se - cursor > 0.02) out.push(...emitRemoved(cursor, se));
  }

  const final = tidy(out).filter((s) => s.end - s.start > 0.08 && s.end <= duration + 0.05);
  const trimmed = final
    .filter((s) => s.type !== "cut" && s.end > spanStart && s.start < spanEnd)
    .map((s) => ({ start: Math.max(s.start, spanStart), end: Math.min(s.end, spanEnd) }));
  return { segments: final, kept: keepIndices.length, total: buckets.length, trimmed };
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

  const originalBody = keptProgramme(tidied, spanStart, spanEnd, fastSpeed, false);
  const speech = speechOf(speechOrWords, detectionRegions);

  const o: FairUseOptions = { ...defaultFairUse, ...(opts as any) };

  if (o.mode === "cards") {
    const { segments: next, intervals } = buildCards(
      tidied,
      duration,
      o,
      speech,
      spanStart,
      spanEnd,
      fastSpeed
    );
    const cardTime = intervals.reduce(
      (a, iv) => a + (iv.end - iv.start) / Math.max(1, o.cardSpeed),
      0
    );
    const limitedBody = keptProgramme(next, spanStart, spanEnd, fastSpeed, false);
    return {
      segments: next,
      report: {
        mode: "cards",
        originalBody,
        limitedBody,
        cards: intervals.length,
        cardTime,
        keptBuckets: intervals.length,
        totalBuckets: 0,
        // only the card speed can shave time off; cards themselves are overlay
        saved: Math.max(0, originalBody - limitedBody),
      },
    };
  }

  const trim = buildTrim(tidied, duration, o, speech, spanStart, spanEnd, fastSpeed);
  const preservedProg = Math.max(
    0,
    originalBody - keptProgramme(tidied, spanStart, spanEnd, fastSpeed, true)
  );
  const limitedBody = keptProgramme(trim.segments, spanStart, spanEnd, fastSpeed, false);
  return {
    segments: trim.segments,
    report: {
      mode: "trim",
      originalBody,
      limitedBody,
      cards: 0,
      cardTime: 0,
      keptBuckets: trim.kept,
      totalBuckets: trim.total,
      saved: Math.max(0, originalBody - limitedBody),
      preservedCards: preservedProg,
    },
  };
}
