#!/usr/bin/env node
/**
 * Geometry regression test: the card, the mirror and the fair-use limiter.
 *
 *     node src/__tests__/render_geometry.test.mjs
 *
 * Everything here is the browser half of a pair — the Colab pipeline
 * (compose.py / video_processor.py) implements the same math, and these are
 * the invariants both must keep:
 *
 *  1. the card covers exactly the *drawn content picture* (fit + zoom +
 *     offset), never the letterbox padding around it → no overrun, no gap;
 *  2. in YouTube mode the card covers exactly the content rect of the
 *     finished file (no hardcoded fallback box);
 *  3. opacity is literal: 100 % is opaque, 0 % draws no card at all, and the
 *     whole card (backdrop, bar, words, ring) shares that alpha;
 *  4. a mirror flips the picture about its own centre — never about a rect
 *     the picture does not occupy (that used to shift it: overrun on one
 *     side, gap on the other);
 *  5. the fair-use limiter inserts short cards instead of long ones, never
 *     "keep the first N minutes and cut the rest".
 *
 * render.ts is bundled with esbuild and drawn into a recording 2D context
 * with a real matrix stack, so the assertions are on device-space rects —
 * exactly the pixels the canvas would get.
 */
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "lib");

let fails = 0;
let checks = 0;
const check = (cond, what, extra = "") => {
  checks += 1;
  if (cond) console.log(`  ok   ${what}`);
  else {
    fails += 1;
    console.log(`  FAIL ${what}${extra ? ` | ${extra}` : ""}`);
  }
};
const near = (a, b, tol = 0.75) => Math.abs(a - b) <= tol;
const bboxNear = (got, want, tol = 0.75) =>
  !!got &&
  near(got[0], want[0], tol) &&
  near(got[1], want[1], tol) &&
  near(got[2], want[2], tol) &&
  near(got[3], want[3], tol);
const fmt = (b) => (b ? b.map((n) => +n.toFixed(1)).join(", ") : "none");

/* ------------------------------- recording canvas ------------------------- */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function makeCtx(canvas, log) {
  const st = { m: [1, 0, 0, 1, 0, 0], alpha: 1, filter: "none", clip: null };
  const stack = [];
  let pts = [];
  const dev = (x, y) => applyM(st.m, x, y);
  const bboxOf = (p) => {
    if (!p.length) return null;
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const rec = (o) => log.push({ ...o, alpha: st.alpha, filter: st.filter, m: [...st.m] });
  const ctx = {
    canvas,
    get globalAlpha() {
      return st.alpha;
    },
    set globalAlpha(v) {
      st.alpha = v;
    },
    get filter() {
      return st.filter;
    },
    set filter(v) {
      st.filter = v;
    },
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalCompositeOperation: "source-over",
    save() {
      stack.push({ m: [...st.m], alpha: st.alpha, filter: st.filter, clip: st.clip });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        st.m = s.m;
        st.alpha = s.alpha;
        st.filter = s.filter;
        st.clip = s.clip;
      }
    },
    setTransform(a, b, c, d, e, f) {
      st.m = [a, b, c, d, e, f];
    },
    translate(x, y) {
      st.m = mul(st.m, [1, 0, 0, 1, x, y]);
    },
    scale(x, y) {
      st.m = mul(st.m, [x, 0, 0, y, 0, 0]);
    },
    rotate(r) {
      st.m = mul(st.m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
    },
    beginPath() {
      pts = [];
    },
    closePath() {},
    moveTo(x, y) {
      pts.push(dev(x, y));
    },
    lineTo(x, y) {
      pts.push(dev(x, y));
    },
    quadraticCurveTo(cx, cy, x, y) {
      pts.push(dev(cx, cy), dev(x, y));
    },
    bezierCurveTo(a, b, c, d, x, y) {
      pts.push(dev(a, b), dev(c, d), dev(x, y));
    },
    rect(x, y, w, h) {
      pts.push(dev(x, y), dev(x + w, y + h));
    },
    ellipse(cx, cy, rx, ry) {
      pts.push(dev(cx - rx, cy - ry), dev(cx + rx, cy + ry));
    },
    arc(cx, cy, r) {
      pts.push(dev(cx - r, cy - r), dev(cx + r, cy + r));
    },
    clip() {
      st.clip = bboxOf(pts);
    },
    fill() {
      rec({ type: "fill", bbox: bboxOf(pts), fillStyle: ctx.fillStyle });
    },
    stroke() {
      rec({ type: "stroke", bbox: bboxOf(pts) });
    },
    fillRect(x, y, w, h) {
      rec({
        type: "fillRect",
        bbox: bboxOf([dev(x, y), dev(x + w, y + h)]),
        fillStyle: ctx.fillStyle,
      });
    },
    strokeRect() {},
    clearRect() {},
    drawImage(img, ...a) {
      let sx = 0;
      let sy = 0;
      let sw = img?.videoWidth ?? img?.width ?? 0;
      let sh = img?.videoHeight ?? img?.height ?? 0;
      let dx = 0;
      let dy = 0;
      let dw = sw;
      let dh = sh;
      if (a.length === 2) [dx, dy] = a;
      else if (a.length === 4) [dx, dy, dw, dh] = a;
      else if (a.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a;
      rec({
        type: "drawImage",
        img: img?.__id ?? "video",
        src: [sx, sy, sw, sh],
        bbox: bboxOf([dev(dx, dy), dev(dx + dw, dy + dh)]),
      });
    },
    fillText(t, x, y) {
      rec({ type: "fillText", text: t, bbox: bboxOf([dev(x, y), dev(x, y)]) });
    },
    measureText(t) {
      return { width: t.length * 8 };
    },
    createLinearGradient() {
      return {
        __grad: true,
        stops: [],
        addColorStop(o, c) {
          this.stops.push([o, c]);
        },
      };
    },
    createRadialGradient() {
      return { __grad: true, stops: [], addColorStop() {} };
    },
    createPattern() {
      return {};
    },
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), __rect: [x, y, w, h] };
    },
    putImageData(img, x, y) {
      rec({ type: "putImageData", bbox: bboxOf([dev(x, y), dev(x + img.width, y + img.height)]) });
    },
    setLineDash() {},
  };
  return ctx;
}

function makeCanvas(id, w = 1280, h = 720) {
  const cv = { width: w, height: h, __id: id, _log: [] };
  cv.getContext = () => (cv._ctx ||= makeCtx(cv, cv._log));
  return cv;
}

globalThis.document = { createElement: (t) => makeCanvas(t) };
globalThis.Image = class {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }
};

/* --------------------------------- bundle -------------------------------- */
const ENTRY = `
export * from "./render";
export * from "./timeline";
export * from "./fairUseCut";
`;
const bundle = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: srcDir, loader: "ts", sourcefile: "entry.ts" },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const tmp = path.join(here, `.geom_${process.pid}.mjs`);
fs.writeFileSync(tmp, bundle.outputFiles[0].text);
const R = await import(`file://${tmp}?v=${Date.now()}`);

/* --------------------------------- layout -------------------------------- */
const baseStyle = (fit) => ({
  fit,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  mirror: false,
  radius: 10,
  shape: "rounded",
  border: 0,
  borderColor: "#0b1220",
  opacity: 1,
});
const LAYOUT = {
  cameraSide: "left",
  sourceMode: "split",
  cam: { x: 0.006, y: 0.011, w: 0.3, h: 0.3 },
  content: { x: 0.294, y: 0.289, w: 0.7, h: 0.7 },
  bg: { source: "full", blur: 50, opacity: 0.4, scale: 1.08, dim: 0.25 },
  contentStyle: baseStyle("contain"),
  camStyle: { ...baseStyle("contain"), radius: 20, border: 3 },
  soloStyle: { ...baseStyle("contain"), zoom: 1.05 },
  muteContentInSolo: true,
  contentHidden: false,
  fastSpeed: 4,
  fastGainDb: -6,
  chipmunk: false,
  card: {
    title: "Full uncut reaction on Patreon",
    sub: "link in the description",
    accent: "#e879f9",
    image: "",
    showText: true,
    shortHeight: 0.75,
    opacity: 0.9,
  },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const W = 1280;
const H = 720;
const scratch = makeCanvas("scratch");
const video = { videoWidth: 1920, videoHeight: 1080, width: 1920, height: 1080, __id: "video" };
const rectPx = (r) => [r.x * W, r.y * H, (r.x + r.w) * W, (r.y + r.h) * H];

const draw = (layout, scene) => {
  const cv = makeCanvas("preview");
  R.renderScene(cv.getContext("2d"), video, scene, layout, W, H, scratch, 0.34, null);
  return cv._log;
};
const cardFills = (log, want) =>
  log.filter((e) => e.type === "fillRect" && bboxNear(e.bbox, want, 1.5));

/* =========================== 1. the content picture ====================== */
console.log("\n== content picture (fit + zoom + offset)");
{
  const halves = R.sourceHalves(3840, 1080, "split", "left");
  const plain = R.contentPicture(LAYOUT, halves.content);
  check(
    bboxNear(rectPx(plain), rectPx(LAYOUT.content), 0.01),
    "a 16:9 half fills the content rect exactly",
    fmt(rectPx(plain))
  );
  const tall = R.sourceHalves(1920, 2160, "split", "left");
  const fit = rectPx(R.contentPicture(LAYOUT, tall.content));
  const box = rectPx(LAYOUT.content);
  const sAsp = tall.content.w / tall.content.h;
  const wantW = (box[3] - box[1]) * sAsp;
  check(
    near(fit[2] - fit[0], wantW, 1) &&
      near(fit[0], box[0] + (box[2] - box[0] - wantW) / 2, 1) &&
      near(fit[1], box[1], 1) &&
      near(fit[3], box[3], 1),
    "a taller half is pillarboxed inside the rect (centred, full height)",
    `${fmt(fit)} in ${fmt(box)} (want width ${wantW.toFixed(1)})`
  );
  const zoomed = clone(LAYOUT);
  zoomed.contentStyle.zoom = 1.1;
  const z = rectPx(R.contentPicture(zoomed, halves.content));
  check(
    near(z[2] - z[0], (box[2] - box[0]) * 1.1, 0.51) &&
      near(z[0] + (z[2] - z[0]) / 2, box[0] + (box[2] - box[0]) / 2, 0.51),
    "zoom grows the picture about the box centre",
    fmt(z)
  );
  const off = clone(LAYOUT);
  off.contentStyle.offsetX = 0.5;
  const o = rectPx(R.contentPicture(off, halves.content));
  check(near(o[0] - box[0], (box[2] - box[0]) / 2, 0.51), "offsetX moves the picture by half its own width", fmt(o));
}

/* ================= 2. Patreon card == the drawn content picture =========== */
console.log("\n== Patreon card covers the drawn content picture");
{
  // a half whose aspect does NOT match the content rect: the picture is
  // letterboxed inside the box, so a card pinned to the box would overrun it
  const halves = R.sourceHalves(1920, 2160, "split", "left");
  const pic = rectPx(R.contentPicture(LAYOUT, halves.content));
  const box = rectPx(LAYOUT.content);

  const body = draw(LAYOUT, R.buildScene(LAYOUT, [{ id: "b", type: "body", start: 0, end: 5 }], 1, halves));
  const drawn = body.filter((e) => e.type === "drawImage" && e.img === "video" && e.src[2] > 100)[0];
  check(bboxNear(drawn.bbox, pic, 1.5), "body: content is drawn at the picture rect", fmt(drawn.bbox));

  const segs = [{ id: "c", type: "card", start: 0, end: 5, card: { variant: "full" } }];
  const log = draw(LAYOUT, R.buildScene(LAYOUT, segs, 1, halves));
  const fills = cardFills(log, pic);
  check(fills.length > 0, "full card: backdrop lands on the picture rect", fmt(pic));
  check(
    !cardFills(log, box).length,
    "full card: nothing is painted at the box's letterbox padding",
    fmt(box)
  );
}

/* ===================== 3. short card: top-anchored 75 % ================== */
console.log("\n== short card");
{
  const halves = R.sourceHalves(3840, 1080, "split", "left");
  const pic = rectPx(R.contentPicture(LAYOUT, halves.content));
  const shortWant = [pic[0], pic[1], pic[2], pic[1] + (pic[3] - pic[1]) * 0.75];
  const segs = [{ id: "c", type: "card", start: 0, end: 5, card: { variant: "short" } }];
  const log = draw(LAYOUT, R.buildScene(LAYOUT, segs, 1, halves));
  check(cardFills(log, shortWant, 1.5).length > 0, "short card covers the top 75 % of the content", fmt(shortWant));
  check(!cardFills(log, pic, 1.5).length, "short card does not cover the bottom (subtitles stay visible)");

  // the default when a project has no shortHeight at all
  const bare = clone(LAYOUT);
  delete bare.card.shortHeight;
  const log2 = draw(bare, R.buildScene(bare, segs, 1, halves));
  check(
    cardFills(log2, shortWant, 1.5).length > 0,
    "default short height is 75 % of the content"
  );
}

/* ============================ 4. exact opacity =========================== */
console.log("\n== card opacity is literal");
{
  const halves = R.sourceHalves(3840, 1080, "split", "left");
  const pic = rectPx(R.contentPicture(LAYOUT, halves.content));
  const segs = [{ id: "c", type: "card", start: 0, end: 5, card: { variant: "full" } }];

  const zero = clone(LAYOUT);
  zero.card.opacity = 0;
  const log0 = draw(zero, R.buildScene(zero, segs, 1, halves));
  check(
    cardFills(log0, pic, 1.5).length === 0 &&
      !log0.some((e) => e.type === "fillText" && /Patreon/.test(e.text || "")),
    "0 % draws no card at all (no backdrop, no words)"
  );

  const full = clone(LAYOUT);
  full.card.opacity = 1;
  const log1 = draw(full, R.buildScene(full, segs, 1, halves));
  const fill1 = cardFills(log1, pic, 1.5)[0];
  const grad = fill1?.fillStyle;
  check(!!fill1 && fill1.alpha === 1, "100 % is fully opaque", `alpha=${fill1?.alpha}`);
  check(
    !!grad && grad.stops && grad.stops.every(([, c]) => /^rgb\(/.test(c)),
    "100 % backdrop has no baked-in alpha",
    grad?.stops?.map(([, c]) => c).join(" ")
  );

  const half = clone(LAYOUT);
  half.card.opacity = 0.9;
  const log9 = draw(half, R.buildScene(half, segs, 1, halves));
  const fill9 = cardFills(log9, pic, 1.5)[0];
  const text9 = log9.find((e) => e.type === "fillText" && /Patreon/.test(e.text || ""));
  check(fill9 && near(fill9.alpha, 0.9, 0.001), "90 % backdrop draws at 0.9", `alpha=${fill9?.alpha}`);
  check(text9 && near(text9.alpha, 0.9, 0.001), "the words share the same alpha (whole card = one opacity)", `alpha=${text9?.alpha}`);
}

/* ================== 5. YouTube: card follows the layout rect ============= */
console.log("\n== YouTube passthrough card");
{
  const halves = R.sourceHalves(1920, 1080, "single", "left");
  const custom = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
  const want = rectPx(custom);
  const segs = [{ id: "c", type: "card", start: 0, end: 5, card: { variant: "short" } }];
  const scene = R.buildPassthroughScene(segs, 1, halves.full, 4, custom, null, LAYOUT.cam);
  const log = draw(LAYOUT, scene);
  check(
    cardFills(log, [want[0], want[1], want[2], want[1] + (want[3] - want[1]) * 0.75], 1.5).length > 0,
    "the card lands exactly on the rect the file was composed with",
    fmt(want)
  );
  const restore = log.find((e) => e.type === "putImageData");
  check(
    bboxNear(restore?.bbox, rectPx(LAYOUT.cam), 1.5),
    "the camera corner is restored on top of the card",
    fmt(restore?.bbox)
  );
  const a = R.contentPicture(LAYOUT, halves.full);
  check(
    bboxNear(rectPx(a), rectPx(LAYOUT.content), 0.01),
    "single-source mode: the picture is the content box",
    fmt(rectPx(a))
  );
}

/* =============================== 6. mirrors ============================== */
console.log("\n== mirror flips the picture about its own centre");
{
  const halves = R.sourceHalves(1920, 2160, "split", "left");
  const pic = rectPx(R.contentPicture(LAYOUT, halves.content));

  const lay = clone(LAYOUT);
  lay.contentStyle.mirror = true;
  const log = draw(lay, R.buildScene(lay, [{ id: "b", type: "body", start: 0, end: 5 }], 1, halves));
  const m = log.filter((e) => e.type === "drawImage" && e.m[0] < 0)[0];
  const axis = m ? m.m[4] / 2 : NaN;
  check(bboxNear(m?.bbox, pic, 1.5), "Patreon: the mirrored picture stays on the picture rect", fmt(m?.bbox));
  check(near(axis, pic[0] + (pic[2] - pic[0]) / 2, 0.75), "Patreon: mirrored about the picture centre", `axis=${axis?.toFixed?.(1)}`);

  // YouTube: the content block of the finished file, mirrored in place
  const cloak = {
    on: true, zoom: 1, bars: 0, border: 0, borderColor: "#0ea5e9", saturate: 100,
    contrast: 100, brightness: 100, hue: 0, grain: 0, vignette: 0, flip: false,
    flipContent: true, blur: 0, rotate: 0, speed: 1, contentOnly: true,
  };
  const full = R.sourceHalves(1920, 1080, "single", "left");
  const segs = [{ id: "b", type: "body", start: 0, end: 5 }];
  const log2 = draw(LAYOUT, R.buildPassthroughScene(segs, 1, full.full, 4, LAYOUT.content, cloak, LAYOUT.cam));
  const mb = log2.filter((e) => e.type === "drawImage" && e.m[0] < 0)[0];
  const wantBlock = rectPx(LAYOUT.content);
  check(bboxNear(mb?.bbox, wantBlock, 1.5), "YouTube: mirrored block stays on the content rect", fmt(mb?.bbox));
  check(near(mb ? mb.m[4] / 2 : NaN, wantBlock[0] + (wantBlock[2] - wantBlock[0]) / 2, 0.75), "YouTube: mirrored about the block centre");

  // legacy full-frame cloak path: the picture there is the zoomed full frame
  const legacy = { ...clone(cloak), contentOnly: false, flipContent: false, flip: true, zoom: 1.1 };
  const log3 = draw(LAYOUT, R.buildPassthroughScene(segs, 1, full.full, 4, LAYOUT.content, legacy, LAYOUT.cam));
  const lm = log3.filter((e) => e.type === "drawImage" && e.m[0] < 0)[0];
  const wantZoom = [(W - W * 1.1) / 2, (H - H * 1.1) / 2, (W + W * 1.1) / 2, (H + H * 1.1) / 2];
  check(bboxNear(lm?.bbox, wantZoom, 1.0), "legacy cloak: mirror is about the drawn (zoomed) frame", fmt(lm?.bbox));
  check(!near((lm ? lm.m[4] / 2 : -1), wantBlock[0] + (wantBlock[2] - wantBlock[0]) / 2, 2), "legacy cloak: no longer mirrored about a stale content rect");
}

/* ========================= 7. card speed (timeline) ====================== */
console.log("\n== card playback speed");
{
  const segs = [
    { id: "a", type: "body", start: 0, end: 10 },
    { id: "b", type: "card", start: 10, end: 14, card: { variant: "short", speed: 1.25 } },
  ];
  check(R.segSpeed(segs[1], 4) === 1.25, "segSpeed returns the card's own speed");
  check(near(R.outDuration(segs, 4), 13.2, 0.001), "the sped card shortens the programme", String(R.outDuration(segs, 4)));
  check(near(R.srcToOut(segs, 14, 4), 13.2, 0.001), "srcToOut accounts for it");
  check(near(R.outToSrc(segs, 12.4, 4), 13, 0.001), "outToSrc inverts it");
}

/* ======================= 8. fair-use limiter (cards) ===================== */
console.log("\n== fair-use limiter: cards mode");
{
  const segs = [
    { id: "i", type: "intro", start: 0, end: 10 },
    { id: "b", type: "body", start: 10, end: 40 },
    { id: "o", type: "outro", start: 40, end: 50 },
  ];
  const speech = [{ start: 10, end: 40 }];
  const { segments: out, report } = R.buildFairUseLimit(segs, 50, R.defaultFairUse, speech, { start: 10, end: 40 }, null, 4);
  const cards = out.filter((s) => s.type === "card");
  const cuts = out.filter((s) => s.type === "cut");
  check(cards.length === 2, `30 s of talk gets 2 cards (got ${cards.length})`);
  check(
    cards.every((c) => c.card?.variant === "short"),
    "every card is short, never a long one",
    JSON.stringify(cards.map((c) => c.card))
  );
  check(near(cards[0]?.start, 18, 0.5) && near(cards[0]?.end, 22, 0.5), `first card at 8-12 s of talk (${cards[0]?.start}-${cards[0]?.end})`);
  check(near(cards[1]?.start, 30, 0.5) && near(cards[1]?.end, 34, 0.5), `second card 8-12 s later (${cards[1]?.start}-${cards[1]?.end})`);
  check(cuts.length === 0, "nothing is cut — the reaction stays in one piece");
  check(
    out.every((s, i) => i === 0 || s.start >= out[i - 1].end - 0.02),
    "chronological, no overlaps"
  );
  check(report.mode === "cards" && report.cards === 2, "report counts the cards");
  check(near(report.originalBody, 30, 0.1) && near(report.limitedBody, 30, 0.1), "cards mode keeps the whole reaction");
}

/* ======================== 9. fair-use limiter (trim) ===================== */
console.log("\n== fair-use limiter: trim mode");
{
  const segs = [{ id: "b", type: "body", start: 0, end: 120 }];
  const opts = { ...R.defaultFairUse, mode: "trim", maxBodySec: 40, keepPad: 0.25 };
  const speech = [];
  for (let t = 0; t < 120; t += 2) speech.push({ start: t, end: t + 1.2 });
  const { segments: out, report } = R.buildFairUseLimit(segs, 120, opts, speech, { start: 0, end: 120 }, null, 4);
  const kept = out.filter((s) => s.type !== "cut" && s.type !== "card");
  const keptSec = kept.reduce((a, s) => a + (s.end - s.start), 0);
  check(near(keptSec, 40, 2.5), `keeps the budget (${keptSec.toFixed(1)} s of 40)`);
  const tail = kept.filter((s) => s.start > 90).length;
  const head = kept.filter((s) => s.end < 20).length;
  const middle = kept.filter((s) => s.start > 50 && s.end < 70).length;
  check(head > 0 && middle > 0 && tail > 0, `start, middle and end all survive (${head}/${middle}/${tail} pieces)`);
  check(report.mode === "trim" && near(report.saved, 80, 2.5), `report says what was saved (${report.saved?.toFixed(1)} s)`);

  // no speech info at all: still spread over the whole reaction, not the head
  const { segments: out2 } = R.buildFairUseLimit(segs, 120, opts, null, { start: 0, end: 120 }, null, 4);
  const kept2 = out2.filter((s) => s.type !== "cut");
  check(
    kept2.some((s) => s.start > 90) && kept2.some((s) => s.start < 20),
    "without speech info the kept windows are still spread out"
  );

  // the reported bug: "limit to 10:00" on a 30 min reaction used to keep the
  // first ten minutes and cut everything after 10:45. A flat audio scan (no
  // speech info) is the worst case for that.
  const big = [{ id: "b", type: "body", start: 0, end: 1800 }];
  const bigOpts = { ...R.defaultFairUse, mode: "trim", maxBodySec: 600 };
  const { segments: bigOut, report: bigRep } = R.buildFairUseLimit(big, 1800, bigOpts, null, { start: 0, end: 1800 }, null, 4);
  const bigKept = bigOut.filter((s) => s.type !== "cut" && s.type !== "card");
  const bigSec = bigKept.reduce((a, s) => a + (s.end - s.start), 0);
  const lastEnd = bigKept.length ? bigKept[bigKept.length - 1].end : 0;
  check(near(bigSec, 600, 25), `30 min reaction trims to the budget (${bigSec.toFixed(0)} s of 600)`);
  check(lastEnd > 1750, `the reaction still runs to the end, not cut at 10:45 (last piece ends ${lastEnd.toFixed(0)} s)`);
  check(
    bigKept.filter((s) => s.start > 1500).length > 0 && bigKept.filter((s) => s.start < 300).length > 0,
    "kept pieces are spread over the whole reaction"
  );
  check(
    bigOut.filter((s) => s.type === "card").every((c) => c.card?.variant === "short"),
    "trim mode's pointers are short cards"
  );

  // an old project that stored cardVariant "full" must not get tall cards back
  const legacy = { ...R.defaultFairUse, mode: "trim", maxBodySec: 40, keepPad: 0.25,
                   removedAction: "card", cardVariant: "full" };
  const { segments: oldOut } = R.buildFairUseLimit(segs, 120, legacy, speech, { start: 0, end: 120 }, null, 4);
  const oldCards = oldOut.filter((s) => s.type === "card");
  check(oldCards.length > 0, `legacy project still gets pointer cards (${oldCards.length})`);
  check(
    oldCards.every((c) => c.card?.variant === "short"),
    "cardVariant `full` from an old project is ignored — limiter cards stay short",
    JSON.stringify(oldCards.slice(0, 3).map((c) => c.card))
  );
  check(
    oldCards.every((c) => c.end - c.start <= legacy.cardDuration + 0.01),
    "pointer cards never run longer than cardDuration"
  );
}

fs.rmSync(tmp, { force: true });
console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
