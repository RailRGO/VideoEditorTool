import type { CutOptions } from "./types";
import { clamp } from "./timeline";

/** Mic loudness envelope: one dB value per `binMs` of source time. */
export interface Envelope {
  binMs: number;
  db: Float32Array;
  duration: number;
}

export interface Region {
  start: number;
  end: number;
}

export interface Detection {
  regions: Region[];
  floorDb: number;
  thresholdDb: number;
  speechSec: number;
  bursts: number;
}

export const BIN_MS = 50;

const toDb = (v: number) => (v > 1e-8 ? 10 * Math.log10(v) : -90);

export function buildEnvelope(
  sumSquares: Float32Array,
  counts: Float32Array,
  duration: number
): Envelope {
  const db = new Float32Array(sumSquares.length);
  for (let i = 0; i < sumSquares.length; i++) {
    db[i] = counts[i] > 0 ? toDb(sumSquares[i] / counts[i]) : -90;
  }
  return { binMs: BIN_MS, db, duration };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -70;
  const i = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[i];
}

/**
 * Find the stretches where the mic is actually live. Works from the measured
 * noise floor of *this* recording rather than an absolute number, so a quiet
 * mic and a hot mic both behave the same.
 */
export function detectSpeech(env: Envelope, opts: CutOptions): Detection {
  const sec = env.binMs / 1000;
  const n = env.db.length;

  // Noise floor: quietest 15% of bins that aren't digital silence.
  const voiced = Array.from(env.db).filter((v) => v > -75);
  const sorted = [...voiced].sort((a, b) => a - b);
  const floorDb = percentile(sorted, 0.15);
  const loudDb = percentile(sorted, 0.97);
  // Never let the threshold sit above the busy level, and keep >= 3 dB of headroom.
  const thresholdDb = Math.min(floorDb + Math.max(2, opts.marginDb), loudDb - 2);

  const above = new Uint8Array(n);
  for (let i = 0; i < n; i++) above[i] = env.db[i] >= thresholdDb ? 1 : 0;

  // raw runs
  const runs: Region[] = [];
  let i = 0;
  while (i < n) {
    if (!above[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && above[j]) j++;
    runs.push({ start: i * sec, end: j * sec });
    i = j;
  }

  // drop blips, then bridge short silences
  const kept = runs.filter((r) => r.end - r.start >= opts.minSpeech);
  const merged: Region[] = [];
  for (const r of kept) {
    const prev = merged[merged.length - 1];
    if (prev && r.start - prev.end <= opts.maxGap) prev.end = r.end;
    else merged.push({ ...r });
  }

  // padding + clamping
  const padded = merged.map((r) => ({
    start: Math.max(0, r.start - opts.pad),
    end: Math.min(env.duration, r.end + opts.pad),
  }));

  // drop islands too short to be worth a cut around
  const final = padded.filter((r) => r.end - r.start >= Math.max(0.4, opts.minKeep * 0.5));

  const speechSec = final.reduce((a, r) => a + (r.end - r.start), 0);
  return {
    regions: final,
    floorDb,
    thresholdDb,
    speechSec,
    bursts: final.length,
  };
}

/** Does `t` fall inside any region (with a little tolerance)? */
export function inRegions(regions: Region[], t: number, tol = 0.05): boolean {
  for (const r of regions) if (t >= r.start - tol && t <= r.end + tol) return true;
  return false;
}
