import type { AssemblyOptions, AssemblyReport, AudioSample } from "../types";

export const defaultAssembly = (): AssemblyOptions => ({
  blackHold: 1.5,
  pauseKeep: 0.2,
  pauseCutIfOver: 0.42,
  takeGap: 1.35,
  stallMin: 0.75,
  keepLastIntroTake: true,
  tightenPauses: true,
  cutStalls: true,
  cleanOutro: true,
  dropFalseStarts: true,
  scanRate: 4,
});

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * a.length)));
  return a[i];
}

function adaptiveThresh(values: number[], lo = 20, hi = 78, mix = 0.3) {
  const pLo = percentile(values, lo);
  const pHi = percentile(values, hi);
  return pLo + Math.max(0.0035, (pHi - pLo) * mix);
}

function cosine(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d < 1e-9 ? 0 : dot / d;
}

export function speechIslands(
  samples: AudioSample[],
  key: "mic" | "content",
  thresh: number,
  minDur = 0.22,
  mergeGap = 0.32,
) {
  const spans: { start: number; end: number }[] = [];
  let start: number | null = null;
  let last = 0;
  for (const s of samples) {
    if (s[key] >= thresh) {
      if (start == null) start = s.t;
      last = s.t;
    } else if (start != null && s.t - last > mergeGap) {
      if (last - start >= minDur) spans.push({ start, end: last });
      start = null;
    }
  }
  if (start != null && last - start >= minDur) spans.push({ start, end: last });
  return spans;
}

function inRange(spans: { start: number; end: number }[], a: number, b: number) {
  return spans
    .map((s) => ({ start: Math.max(s.start, a), end: Math.min(s.end, b) }))
    .filter((s) => s.end - s.start > 0.08);
}

function groupTakes(islands: { start: number; end: number }[], takeGap: number) {
  const takes: { start: number; end: number }[] = [];
  for (const isl of islands) {
    const last = takes[takes.length - 1];
    if (!last || isl.start - last.end > takeGap) takes.push({ ...isl });
    else last.end = isl.end;
  }
  return takes;
}

function dropFalseStarts(islands: { start: number; end: number }[]) {
  const kept: { start: number; end: number }[] = [];
  const dropped: { start: number; end: number }[] = [];
  for (let i = 0; i < islands.length; i++) {
    const cur = islands[i];
    const next = islands[i + 1];
    const dur = cur.end - cur.start;
    if (
      next &&
      dur < 1.15 &&
      next.start - cur.end < 1.7 &&
      next.end - next.start > dur * 1.12
    ) {
      dropped.push(cur);
      continue;
    }
    kept.push(cur);
  }
  return { kept, dropped };
}

function tightenPauses(
  islands: { start: number; end: number }[],
  from: number,
  to: number,
  pauseKeep: number,
  pauseCutIfOver: number,
) {
  const cuts: { start: number; end: number }[] = [];
  const local = inRange(islands, from, to);
  for (let i = 0; i < local.length - 1; i++) {
    const gap0 = local[i].end;
    const gap1 = local[i + 1].start;
    if (gap1 - gap0 > pauseCutIfOver) cuts.push({ start: gap0 + pauseKeep, end: gap1 });
  }
  return cuts;
}

function sustainedOnset(samples: AudioSample[], thresh: number, need = 0.55) {
  let run = 0;
  let runStart = 0;
  let prev = samples[0]?.t ?? 0;
  for (const s of samples) {
    const dt = Math.max(0.001, s.t - prev);
    prev = s.t;
    if (s.content >= thresh) {
      if (run === 0) runStart = s.t;
      run += dt;
      if (run >= need) return runStart;
    } else {
      run = 0;
    }
  }
  return null;
}

function lastActivity(samples: AudioSample[], thresh: number, need = 0.35) {
  let last: number | null = null;
  let run = 0;
  let prev = samples[0]?.t ?? 0;
  for (const s of samples) {
    const dt = Math.max(0.001, s.t - prev);
    prev = s.t;
    if (s.content >= thresh) {
      run += dt;
      if (run >= need) last = s.t;
    } else {
      run = 0;
    }
  }
  return last;
}

function contentGaps(
  samples: AudioSample[],
  thresh: number,
  t0: number,
  t1: number,
  minGap: number,
) {
  const gaps: { start: number; end: number }[] = [];
  let silentFrom: number | null = null;
  for (const s of samples) {
    if (s.t < t0 || s.t > t1) continue;
    if (s.content < thresh) {
      if (silentFrom == null) silentFrom = s.t;
    } else if (silentFrom != null) {
      if (s.t - silentFrom >= minGap) gaps.push({ start: silentFrom, end: s.t });
      silentFrom = null;
    }
  }
  if (silentFrom != null && t1 - silentFrom >= minGap) {
    gaps.push({ start: silentFrom, end: t1 });
  }
  return gaps;
}

function hopSize(samples: AudioSample[]) {
  if (samples.length < 2) return 0.05;
  return Math.max(0.012, (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1));
}

function rewindOverlap(samples: AudioSample[], g0: number, g1: number) {
  const hop = hopSize(samples);
  const pre = samples.filter((s) => s.t >= g0 - 8 && s.t < g0).map((s) => s.content);
  const post = samples.filter((s) => s.t >= g1 && s.t < g1 + 12).map((s) => s.content);
  const w = Math.max(6, Math.round(0.55 / hop));
  if (pre.length < w + 2 || post.length < w) return 0;
  const postW = post.slice(0, w);
  let best = 0;
  let bestI = 0;
  for (let i = 0; i <= pre.length - w; i++) {
    const sim = cosine(pre.slice(i, i + w), postW);
    if (sim > best) {
      best = sim;
      bestI = i;
    }
  }
  if (best < 0.8) return 0;
  const matchT = g0 - 8 + bestI * hop;
  return Math.min(10, Math.max(0, g0 - matchT));
}

function mergeCuts(cuts: { start: number; end: number }[]) {
  const sorted = cuts
    .filter((c) => c.end - c.start > 0.04)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (!last || c.start > last.end + 0.01) out.push({ ...c });
    else last.end = Math.max(last.end, c.end);
  }
  return out;
}

export function buildAssembly(
  samples: AudioSample[],
  duration: number,
  opt: AssemblyOptions,
): AssemblyReport {
  const notes: string[] = [];
  const cuts: { start: number; end: number }[] = [];
  const micVals = samples.map((s) => s.mic);
  const conVals = samples.map((s) => s.content);
  const micThresh = adaptiveThresh(micVals);
  const conThresh = adaptiveThresh(conVals, 15, 82, 0.34);

  const contentOnset = sustainedOnset(samples, conThresh, 0.55);
  const contentEnd = lastActivity(samples, conThresh, 0.3);

  if (!contentOnset) {
    notes.push("No content-audio start found. Swap L/R in Audio if your mic is on the right.");
  }

  const contentReveal = contentOnset ?? Math.min(6, duration * 0.08);
  const layoutSwitch = Math.max(0.2, contentReveal - opt.blackHold);
  const outroAt = Math.min(duration, Math.max(layoutSwitch + 1, (contentEnd ?? duration - 8) + 0.25));

  const allMic = speechIslands(samples, "mic", micThresh);
  let introIslands = inRange(allMic, 0, layoutSwitch);
  const falseStartCuts: { start: number; end: number }[] = [];
  if (opt.dropFalseStarts) {
    const r = dropFalseStarts(introIslands);
    introIslands = r.kept;
    falseStartCuts.push(...r.dropped);
  }
  const introTakesRaw = groupTakes(introIslands, opt.takeGap);
  const introTakes = introTakesRaw.map((t, i) => ({
    ...t,
    keep: opt.keepLastIntroTake ? i === introTakesRaw.length - 1 : true,
  }));

  if (opt.keepLastIntroTake && introTakesRaw.length) {
    const last = introTakesRaw[introTakesRaw.length - 1];
    if (last.start > 0.25) cuts.push({ start: 0, end: Math.max(0, last.start - 0.06) });
    notes.push(
      introTakesRaw.length > 1
        ? `Kept last intro take of ${introTakesRaw.length} (${introTakesRaw.length - 1} earlier take${introTakesRaw.length > 2 ? "s" : ""} dropped).`
        : "Single intro take kept.",
    );
    if (opt.tightenPauses) {
      cuts.push(...tightenPauses(introIslands, last.start, layoutSwitch, opt.pauseKeep, opt.pauseCutIfOver));
    }
    cuts.push(...falseStartCuts.filter((c) => c.start >= last.start));
  } else if (opt.tightenPauses) {
    cuts.push(...tightenPauses(introIslands, 0, layoutSwitch, opt.pauseKeep, opt.pauseCutIfOver));
    notes.push("Intro pauses tightened.");
  }

  const outroTakesRaw = groupTakes(inRange(allMic, outroAt, duration), opt.takeGap);
  const outroTakes = outroTakesRaw.map((t, i) => ({
    ...t,
    keep: opt.cleanOutro ? i === outroTakesRaw.length - 1 : true,
  }));

  if (opt.cleanOutro && outroTakesRaw.length) {
    const last = outroTakesRaw[outroTakesRaw.length - 1];
    if (last.start - outroAt > 0.35) cuts.push({ start: outroAt, end: Math.max(outroAt, last.start - 0.06) });
    if (opt.tightenPauses) {
      cuts.push(...tightenPauses(inRange(allMic, outroAt, duration), last.start, duration, opt.pauseKeep, opt.pauseCutIfOver));
    }
    notes.push(
      outroTakesRaw.length > 1
        ? `Outro: kept last take of ${outroTakesRaw.length}.`
        : "Outro pauses cleaned.",
    );
  } else if (opt.cleanOutro && opt.tightenPauses) {
    cuts.push(...tightenPauses(inRange(allMic, outroAt, duration), outroAt, duration, opt.pauseKeep, opt.pauseCutIfOver));
  }

  const stalls: AssemblyReport["stalls"] = [];
  if (opt.cutStalls && contentOnset != null) {
    const gaps = contentGaps(samples, conThresh, contentReveal, outroAt, opt.stallMin);
    for (const g of gaps) {
      const overlap = rewindOverlap(samples, g.start, g.end);
      const end = Math.min(outroAt, g.end + overlap);
      if (end - g.start > 0.2) {
        cuts.push({ start: g.start, end });
        stalls.push({ start: g.start, end, overlap });
      }
    }
    if (stalls.length) {
      notes.push(
        `Removed ${stalls.length} stall/rewind stretch${stalls.length > 1 ? "es" : ""} in the reaction (buffering / going back). Content otherwise left intact.`,
      );
    } else {
      notes.push("No buffering stalls detected. Reaction content left uncut.");
    }
  } else {
    notes.push("Reaction content left uncut.");
  }

  notes.push(
    `Layout switches to reaction at ${layoutSwitch.toFixed(1)}s, content card black until ${contentReveal.toFixed(1)}s.`,
  );

  return {
    contentOnset,
    contentEnd,
    markers: { layoutSwitch, contentReveal, outroAt },
    introTakes,
    outroTakes,
    stalls,
    cuts: mergeCuts(cuts),
    notes,
  };
}
