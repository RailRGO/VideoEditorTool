import type { Span, StageMode } from "../types";

export function mergeSpans(cuts: Span[]): Span[] {
  const sorted = [...cuts]
    .filter((c) => c.end - c.start > 0.02)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (!last || c.start > last.end + 0.001) {
      merged.push({ ...c });
    } else {
      last.end = Math.max(last.end, c.end);
    }
  }
  return merged;
}

export function keptSegments(duration: number, cuts: Span[]): { start: number; end: number }[] {
  const merged = mergeSpans(cuts).map((c) => ({
    start: clampNum(c.start, 0, duration),
    end: clampNum(c.end, 0, duration),
  }));
  const kept: { start: number; end: number }[] = [];
  let t = 0;
  for (const c of merged) {
    if (c.start > t + 0.001) kept.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (t < duration - 0.001) kept.push({ start: t, end: duration });
  return kept;
}

export function timelineDuration(duration: number, cuts: Span[]) {
  return keptSegments(duration, cuts).reduce((sum, k) => sum + (k.end - k.start), 0);
}

export function timelineToSource(timelineTime: number, duration: number, cuts: Span[]) {
  const kept = keptSegments(duration, cuts);
  let acc = 0;
  for (const k of kept) {
    const len = k.end - k.start;
    if (timelineTime <= acc + len) return k.start + (timelineTime - acc);
    acc += len;
  }
  return duration;
}

export function sourceToTimeline(sourceTime: number, duration: number, cuts: Span[]) {
  const kept = keptSegments(duration, cuts);
  let acc = 0;
  for (const k of kept) {
    if (sourceTime < k.start) return acc;
    if (sourceTime <= k.end) return acc + (sourceTime - k.start);
    acc += k.end - k.start;
  }
  return acc;
}

export function isInCut(sourceTime: number, cuts: Span[]) {
  return mergeSpans(cuts).some((c) => sourceTime >= c.start && sourceTime < c.end);
}

export function skipCut(sourceTime: number, cuts: Span[]) {
  const hit = mergeSpans(cuts).find((c) => sourceTime >= c.start && sourceTime < c.end);
  return hit ? hit.end + 0.001 : sourceTime;
}

export function stageAt(
  timelineTime: number,
  totalTimeline: number,
  introDuration: number,
  outroDuration: number,
): StageMode {
  if (totalTimeline <= 0) return "reaction";
  const intro = Math.max(0, introDuration);
  const outro = Math.max(0, outroDuration);
  if (timelineTime < intro) return "intro";
  if (timelineTime > Math.max(intro, totalTimeline - outro)) return "outro";
  return "reaction";
}

export function reactionBody(duration: number, intro: number, outro: number) {
  const start = Math.max(0, intro);
  const end = Math.max(start, duration - Math.max(0, outro));
  return { start, end };
}

export function clampSpanToBody(
  span: { start: number; end: number },
  duration: number,
  intro: number,
  outro: number,
) {
  const body = reactionBody(duration, intro, outro);
  const start = Math.max(span.start, body.start);
  const end = Math.min(span.end, body.end);
  if (end - start < 0.05) return null;
  return { start, end };
}

export function cutsFromKeeps(
  duration: number,
  intro: number,
  outro: number,
  keeps: Span[],
  makeId: () => string,
): Span[] {
  const { start: bodyStart, end: bodyEnd } = reactionBody(duration, intro, outro);
  const merged = mergeSpans(keeps)
    .map((k) => ({
      start: Math.max(k.start, bodyStart),
      end: Math.min(k.end, bodyEnd),
    }))
    .filter((k) => k.end - k.start > 0.05);
  const cuts: Span[] = [];
  let t = bodyStart;
  for (const k of merged) {
    if (k.start > t + 0.05) cuts.push({ id: makeId(), start: t, end: k.start });
    t = Math.max(t, k.end);
  }
  if (bodyEnd > t + 0.05) cuts.push({ id: makeId(), start: t, end: bodyEnd });
  return cuts;
}

function clampNum(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
