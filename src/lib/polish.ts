import type { PolishRules, Segment } from "./types";
import type { Envelope, Region } from "./analyze";
import { clamp, tidy, uid } from "./timeline";

export interface Word {
  start: number;
  end: number;
  text: string;
  approx?: boolean;
}

export interface Transcript {
  words: Word[];
  timed: boolean;
  source: string;
}

const CLOCK = /(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{1,3})/;

function stamp(s: string): number | null {
  const m = s.trim().match(CLOCK);
  if (!m) return null;
  if (m[3] !== undefined) {
    return (
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`)
    );
  }
  return Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[4]}`);
}

const clean = (t: string) =>
  t
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}'’\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Accepts SRT, WebVTT, plain text and Whisper-style JSON
 * ({segments:[{start,end,text}]} or {words:[{word,start,end}]}).
 */
export function parseTranscript(text: string): Transcript {
  const raw = text.replace(/\r/g, "");

  // JSON?
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const words: Word[] = [];
      const push = (start: number, end: number, t: string) => {
        const c = clean(t);
        if (!c) return;
        const parts = c.split(" ");
        const per = (end - start) / parts.length;
        parts.forEach((p, i) => words.push({ start: start + i * per, end: start + (i + 1) * per, text: p }));
      };
      const walk = (node: unknown) => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        if (o.start !== undefined && o.end !== undefined) {
          const t = String(o.text ?? o.word ?? "");
          if (o.word !== undefined) {
            const c = clean(String(o.word));
            if (c) words.push({ start: Number(o.start), end: Number(o.end), text: c });
          } else push(Number(o.start), Number(o.end), t);
        }
        for (const k of ["segments", "words", "transcript", "chunks"]) {
          if (Array.isArray(o[k])) walk(o[k]);
        }
      };
      walk(data);
      if (words.length) {
        words.sort((a, b) => a.start - b.start);
        return { words, timed: true, source: "JSON" };
      }
    } catch {
      /* fall through to cue parsing */
    }
  }

  // cue-based (SRT / VTT)
  const cues: Word[] = [];
  const blocks = raw.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    let start: number | null = null;
    let end: number | null = null;
    const textLines: string[] = [];
    for (const line of lines) {
      if (line.includes("-->")) {
        const [a, b] = line.split("-->");
        start = stamp(a);
        end = stamp(b ?? "");
      } else if (start === null) {
        continue; // cue number / WEBVTT header
      } else {
        textLines.push(line);
      }
    }
    if (start === null || end === null) continue;
    const c = clean(textLines.join(" "));
    if (!c) continue;
    const parts = c.split(" ");
    const per = Math.max(0.04, (end - start) / parts.length);
    parts.forEach((p, i) =>
      cues.push({ start: start! + i * per, end: start! + (i + 1) * per, text: p })
    );
  }
  if (cues.length) {
    cues.sort((a, b) => a.start - b.start);
    return { words: cues, timed: true, source: raw.includes("WEBVTT") ? "WebVTT" : "SRT" };
  }

  // plain text — no timings at all
  const words = clean(raw)
    .split(" ")
    .filter(Boolean)
    .map((t) => ({ start: 0, end: 0, text: t, approx: true }));
  return { words, timed: false, source: "plain text" };
}

/**
 * Give an untimed transcript approximate timings by spreading the words over
 * each intro / outro span at a steady reading rate. Good enough for spotting
 * fillers, not good enough for surgical cuts.
 */
export function approxAlign(
  t: Transcript,
  spans: Region[],
  wps: number
): Transcript {
  if (t.timed) return t;
  const totalWords = t.words.length;
  if (!totalWords) return t;
  const spanDur = spans.reduce((a, s) => a + (s.end - s.start), 0);
  const spoken = totalWords / Math.max(0.3, wps);
  const scale = spanDur > 0 ? Math.min(1, spanDur / spoken) : 1;
  const words: Word[] = [];
  let cursor = spans.length ? spans[0].start : 0;
  for (const w of t.words) {
    const dur = (1 / Math.max(0.3, wps)) * scale;
    words.push({ start: cursor, end: cursor + dur, text: w.text, approx: true });
    cursor += dur;
    const span = spans.find((s) => cursor >= s.start && cursor < s.end);
    if (!span) {
      const next = spans.find((s) => s.start > cursor);
      if (next) cursor = next.start;
      else if (spans.length) cursor = Math.min(cursor, spans[spans.length - 1].end);
    }
  }
  return { words, timed: true, source: "approximate" };
}

/* ------------------------------------------------------------- fillers */

const HARD = new Set([
  "um","uh","umm","uhh","uhm","er","erm","ah","ahh","hmm","hm","mm","mhm","mhmm",
  "uhhuh","uhhuh","eh","ehm","umm","umm","oof","huh","mmm","erm",
]);

const SOFT = new Set([
  "like","basically","actually","literally","kinda","sorta","right","okay","ok",
  "yeah","yep","yup","anyway","anyways","seriously","honestly","obviously",
]);

const SOFT_PHRASES = ["you know", "i mean", "kind of", "sort of", "i guess", "let me think"];

const norm = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");

export interface FillerHit {
  start: number;
  end: number;
  text: string;
  kind: "filler" | "hedge";
}

export function findFillers(words: Word[], rules: PolishRules): FillerHit[] {
  const hits: FillerHit[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const n = norm(w.text);
    if (!n) continue;
    if (rules.dropFillers && HARD.has(n)) {
      hits.push({ start: w.start, end: w.end, text: w.text, kind: "filler" });
      continue;
    }
    if (rules.dropSoftFillers) {
      if (SOFT.has(n)) {
        hits.push({ start: w.start, end: w.end, text: w.text, kind: "hedge" });
        continue;
      }
      const two = `${n} ${norm(words[i + 1]?.text ?? "")}`.trim();
      if (SOFT_PHRASES.includes(two)) {
        hits.push({
          start: w.start,
          end: words[i + 1]?.end ?? w.end,
          text: `${w.text} ${words[i + 1]?.text ?? ""}`.trim(),
          kind: "hedge",
        });
        i++;
      }
    }
  }
  return hits;
}

/** Immediate repeats — "so the the way", "let's let's go". */
export function findWordRepeats(words: Word[]): FillerHit[] {
  const hits: FillerHit[] = [];
  for (let i = 1; i < words.length; i++) {
    const a = norm(words[i - 1].text);
    const b = norm(words[i].text);
    if (!a || !b || a !== b) continue;
    if (words[i].start - words[i - 1].end > 0.5) continue;
    hits.push({
      start: words[i - 1].start,
      end: words[i].end,
      text: `${words[i - 1].text} ${words[i].text}`,
      kind: "filler",
    });
  }
  return hits;
}

/* ------------------------------------------------------- pause tightening */

/** Gaps inside a span that are longer than `maxPause`, trimmed down to `keepPause`. */
export function findLongPauses(
  words: Word[],
  span: Region,
  rules: PolishRules
): Region[] {
  const out: Region[] = [];
  const inSpan = words
    .filter((w) => w.end > span.start && w.start < span.end)
    .sort((a, b) => a.start - b.start);

  const add = (start: number, end: number) => {
    const d = end - start;
    if (d <= rules.maxPause + 0.05) return;
    const keep = Math.min(rules.keepPause, d * 0.4);
    const cut = start + keep;
    if (end - cut > 0.12) out.push({ start: cut, end });
  };

  if (!inSpan.length) return out;
  // leading dead air
  add(span.start, inSpan[0].start);
  for (let i = 1; i < inSpan.length; i++) add(inSpan[i - 1].end, inSpan[i].start);
  // trailing dead air
  add(inSpan[inSpan.length - 1].end, span.end);
  return out;
}

/* ------------------------------------------------------------ utilities */

export function mergeRegions(list: Region[]): Region[] {
  if (!list.length) return [];
  const s = [...list].sort((a, b) => a.start - b.start);
  const out: Region[] = [{ ...s[0] }];
  for (const r of s.slice(1)) {
    const p = out[out.length - 1];
    if (r.start <= p.end + 0.04) p.end = Math.max(p.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function clipRegions(list: Region[], span: Region): Region[] {
  return mergeRegions(
    list
      .map((r) => ({ start: Math.max(r.start, span.start), end: Math.min(r.end, span.end) }))
      .filter((r) => r.end - r.start > 0.06)
  );
}

export function regionsTotal(list: Region[]): number {
  return list.reduce((a, r) => a + (r.end - r.start), 0);
}

/** Turn "drop these spans" into actual cut segments, restricted to intro/outro. */
export function applyPolish(
  segs: Segment[],
  drops: Region[],
  duration: number
): Segment[] {
  let out = segs;
  for (const d of mergeRegions(drops)) {
    out = out.flatMap((s) => {
      if (s.type !== "intro" && s.type !== "outro") return [s];
      if (s.end <= d.start || s.start >= d.end) return [s];
      const parts: Segment[] = [];
      if (s.start < d.start - 0.05) parts.push({ ...s, end: d.start });
      // explicit cut (not a gap) so browser and server render it the same way
      if (Math.min(s.end, d.end) - Math.max(s.start, d.start) > 0.05)
        parts.push({ id: uid(), type: "cut", start: Math.max(s.start, d.start), end: Math.min(s.end, d.end) });
      if (s.end > d.end + 0.05) parts.push({ ...s, id: uid(), start: d.end });
      return parts;
    });
  }
  return tidy(out).filter((s) => s.end - s.start > 0.12 && s.end <= duration + 0.05);
}

/** Remove dead air from the reaction part without touching any real content. */
export function applyDisrupt(
  segs: Segment[],
  drops: Region[],
  duration: number
): Segment[] {
  let out = segs;
  for (const d of mergeRegions(drops)) {
    out = out.flatMap((s) => {
      if (s.type === "intro" || s.type === "outro" || s.type === "lead") return [s];
      if (s.end <= d.start || s.start >= d.end) return [s];
      const parts: Segment[] = [];
      if (s.start < d.start - 0.05) parts.push({ ...s, end: d.start });
      // explicit cut (not a gap) so browser and server render it the same way
      if (Math.min(s.end, d.end) - Math.max(s.start, d.start) > 0.05)
        parts.push({ id: uid(), type: "cut", start: Math.max(s.start, d.start), end: Math.min(s.end, d.end) });
      if (s.end > d.end + 0.05) parts.push({ ...s, id: uid(), start: d.end });
      return parts;
    });
  }
  return tidy(out).filter((s) => s.end - s.start > 0.12 && s.end <= duration + 0.05);
}

/** Build the intro → lead-in → reaction → outro skeleton around the content start. */
export function buildSkeleton(
  duration: number,
  reactionStart: number | null,
  leadIn: number,
  black: number
): { segments: Segment[]; introEnd: number } {
  const start = reactionStart ?? Math.min(8, duration * 0.05);
  const introEnd = clamp(start - Math.max(0, leadIn), 1, Math.max(1, duration * 0.5));
  const bodyStart = clamp(start - Math.max(0, black), introEnd, start);
  const outroStart = Math.max(bodyStart, duration - Math.min(12, duration * 0.04));
  const segs: Segment[] = [
    { id: uid(), type: "intro", start: 0, end: introEnd },
  ];
  if (bodyStart - introEnd > 0.15) {
    segs.push({ id: uid(), type: "lead", start: introEnd, end: bodyStart });
  }
  segs.push({ id: uid(), type: "body", start: bodyStart, end: outroStart });
  segs.push({ id: uid(), type: "outro", start: outroStart, end: duration });
  return { segments: segs.filter((s) => s.end > s.start), introEnd };
}

/** Where the mic is actually quiet — useful for spotting take boundaries. */
export function quietSpans(env: Envelope, span: Region, minQuiet: number): Region[] {
  const sec = env.binMs / 1000;
  const vals = Array.from(env.db);
  const floor = percentile(vals.filter((v) => v > -75).sort((a, b) => a - b), 0.15);
  const out: Region[] = [];
  let i = Math.max(0, Math.floor(span.start / sec));
  const end = Math.min(env.db.length, Math.ceil(span.end / sec));
  let runStart: number | null = null;
  for (; i < end; i++) {
    const quiet = env.db[i] < floor + 5;
    if (quiet && runStart === null) runStart = i * sec;
    if (!quiet && runStart !== null) {
      if (i * sec - runStart >= minQuiet) out.push({ start: runStart, end: i * sec });
      runStart = null;
    }
  }
  if (runStart !== null && end * sec - runStart >= minQuiet) {
    out.push({ start: runStart, end: end * sec });
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -70;
  return sorted[clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1)];
}
