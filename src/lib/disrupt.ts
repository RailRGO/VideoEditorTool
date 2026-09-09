import type { DisruptRules } from "./types";
import type { Envelope, Region } from "./analyze";
import { mergeRegions, regionsTotal } from "./polish";

export interface Repeat {
  /** earlier occurrence */
  a: number;
  /** later occurrence */
  b: number;
  len: number;
}

interface Fp {
  times: number[];
  codes: string[];
}

const STEP = 0.2;
const WIN = 1.0;
const QUANT = 2.5;

/** Coarse loudness fingerprint: one code per STEP of source time. */
function fingerprint(env: Envelope): Fp {
  const sec = env.binMs / 1000;
  const n = Math.max(0, Math.floor((env.duration - WIN) / STEP)) + 1;
  const times: number[] = [];
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * STEP;
    const i0 = Math.floor(t / sec);
    const i1 = Math.floor((t + WIN) / sec);
    const parts: string[] = [];
    for (let k = i0; k <= i1 && k < env.db.length; k++) {
      parts.push(Math.round(env.db[k] / QUANT).toString(36));
    }
    times.push(t);
    codes.push(parts.join("."));
  }
  return { times, codes };
}

/**
 * Find every place where a stretch of audio appears again later — i.e. you
 * rewound and re-watched it. Longest-match-first, so a big rewind wins over the
 * little echoes inside it.
 */
export function findRepeats(env: Envelope, opts: DisruptRules): Repeat[] {
  const fp = fingerprint(env);
  const n = fp.codes.length;

  // bucket windows by code so we only compare likely matches
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const list = buckets.get(fp.codes[i]);
    if (list) list.push(i);
    else buckets.set(fp.codes[i], [i]);
  }

  const minWin = Math.max(1, Math.round(opts.minRepeat / STEP));
  const found: Repeat[] = [];
  const dead = new Uint8Array(n);

  const pairs: [number, number][] = [];
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 400) continue;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        pairs.push([list[x], list[y]]);
      }
    }
  }
  pairs.sort((p, q) => q[1] - q[0] - (p[1] - p[0]));

  for (const [i, j] of pairs) {
    if (dead[i] || dead[j]) continue;
    const gap = fp.times[j] - fp.times[i];
    if (gap < opts.minSeparation) continue;
    let k = 0;
    while (
      i + k < n &&
      j + k < n &&
      fp.codes[i + k] === fp.codes[j + k] &&
      !dead[i + k]
    ) {
      k++;
    }
    if (k < minWin) continue;
    const len = k * STEP;
    found.push({ a: fp.times[i], b: fp.times[j], len });
    for (let m = 0; m < k; m++) {
      dead[i + m] = 1;
      dead[j + m] = 1;
    }
  }
  return found.sort((p, q) => p.a - q.a);
}

/**
 * Convert a rewind-replay into the span that has to go. For a repeat at
 * [a, a+len) and [b, b+len) we drop [a+len, b+len): the disruption *and* the
 * duplicate, so the first playthrough runs straight into the new material.
 */
export function repeatDrop(r: Repeat): Region {
  return { start: r.a + r.len, end: r.b + r.len };
}

/**
 * Stretches where the content audio simply stopped — the player froze while the
 * connection caught up.
 */
export function findDeadAir(env: Envelope, span: Region, opts: DisruptRules): Region[] {
  if (!opts.trimDeadAir) return [];
  const sec = env.binMs / 1000;
  const vals = Array.from(env.db);
  const loud = vals.filter((v) => v > -75).sort((a, b) => a - b);
  if (!loud.length) return [];
  const floor = loud[Math.floor(0.15 * (loud.length - 1))];
  const peak = loud[loud.length - 1];
  if (peak - floor < 12) return []; // content basically never plays here

  const out: Region[] = [];
  let runStart: number | null = null;
  const i0 = Math.max(0, Math.floor(span.start / sec));
  const i1 = Math.min(env.db.length, Math.ceil(span.end / sec));
  for (let i = i0; i < i1; i++) {
    const silent = env.db[i] < floor + 6;
    if (silent && runStart === null) runStart = i * sec;
    if (!silent && runStart !== null) {
      const d = i * sec - runStart;
      if (d >= opts.deadAir) {
        out.push({ start: runStart + opts.keepDead, end: i * sec });
      }
      runStart = null;
    }
  }
  if (runStart !== null) {
    const d = i1 * sec - runStart;
    if (d >= opts.deadAir) out.push({ start: runStart + opts.keepDead, end: i1 * sec });
  }
  return out;
}

export interface DisruptionReport {
  repeats: Repeat[];
  drops: Region[];
  deadAir: Region[];
  wasted: number;
}

export function analyseDisruptions(
  contentEnv: Envelope,
  bodySpan: Region,
  opts: DisruptRules
): DisruptionReport {
  const span: Region = {
    start: Math.max(bodySpan.start, 0),
    end: Math.min(bodySpan.end, contentEnv.duration),
  };
  const inSpan = (r: Region) => r.end > span.start + 0.2 && r.start < span.end - 0.2;
  const repeats = findRepeats(contentEnv, opts).filter((r) =>
    inSpan({ start: r.a, end: r.a + r.len })
  );
  const drops = mergeRegions([
    ...repeats.map(repeatDrop),
    ...findDeadAir(contentEnv, span, opts),
  ]);
  const deadAir = findDeadAir(contentEnv, span, opts);
  return {
    repeats,
    drops: drops.filter((d) => d.end - d.start > 0.15),
    deadAir,
    wasted: regionsTotal(drops),
  };
}

/**
 * First sustained burst of content audio — i.e. the moment the video you're
 * watching actually starts.
 */
export function findContentStart(env: Envelope, after: number): number | null {
  const sec = env.binMs / 1000;
  const vals = Array.from(env.db);
  const loud = vals.filter((v) => v > -75).sort((a, b) => a - b);
  if (!loud.length) return null;
  const floor = loud[Math.floor(0.1 * (loud.length - 1))];
  const peak = loud[loud.length - 1];
  if (peak - floor < 15) return null;

  const need = Math.round(1.0 / sec);
  const from = Math.max(0, Math.floor(after / sec));
  let run = 0;
  for (let i = from; i < env.db.length; i++) {
    if (env.db[i] > floor + 10) {
      run++;
      if (run >= need) return (i - run + 1) * sec;
    } else {
      run = 0;
    }
  }
  return null;
}
