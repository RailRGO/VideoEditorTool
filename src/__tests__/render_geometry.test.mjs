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
 *     side, gap on the other) — and a SHORT card is never mirrored at all,
 *     so the strip it leaves visible stays readable;
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
/**
 * Stub image. The 160x40 size is what a sticker/overlay image would report,
 * and `src =` fires onload synchronously so the sticker cache is warm by the
 * time renderScene draws — otherwise every sticker test would silently pass
 * on "nothing was drawn".
 */
globalThis.Image = class {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
    this.__id = "sticker";
    this._src = "";
  }
  set src(v) {
    this._src = v;
    if (!v) return;
    this.naturalWidth = 160;
    this.naturalHeight = 40;
    if (this.onload) this.onload();
  }
  get src() {
    return this._src;
  }
};

/* --------------------------------- bundle -------------------------------- */
const ENTRY = `
export * from "./render";
export * from "./timeline";
export * from "./fairUseCut";
export * from "./types";
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
  check(near(report.originalBody, 30, 0.1), "cards mode keeps the whole reaction as the source length");
  // the default card speed is 1.55: the picture under a card runs faster, so
  // the programme gets time back — nothing is dropped from the timeline, the
  // two 4 s cards simply cost ~2.6 s each
  check(near(R.defaultFairUse.cardSpeed, 1.55, 0.001),
    "speed under card defaults to 1.55x", String(R.defaultFairUse.cardSpeed));
  check(cards.every((c) => near(c.card?.speed ?? 1, 1.55, 0.001)),
    "every inserted card carries that speed",
    JSON.stringify(cards.map((c) => c.card?.speed)));
  const rest = out.filter((s) => s.type === "body");
  check(near(rest.reduce((a, s) => a + (s.end - s.start), 0), 22, 0.5) &&
    !out.some((s) => s.type === "cut"),
    `cards mode drops no footage (${rest.length} body pieces, no cuts)`);
  check(report.limitedBody < report.originalBody - 1,
    `the sped cards claw programme time back (${report.limitedBody.toFixed(1)}s of ${report.originalBody.toFixed(1)}s)`);
  // switching the slider off keeps the old real-time behaviour
  const plain = R.buildFairUseLimit(segs, 50, { ...R.defaultFairUse, cardSpeed: 1 },
    speech, { start: 10, end: 40 }, null, 4);
  check(near(plain.report.limitedBody, 30, 0.2) &&
    plain.segments.filter((s) => s.type === "card").every((c) => !c.card?.speed),
    "card speed 1 = as recorded (no speed written on the card)");
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

/* ================= 10. the Cloak tab's mirror (mode / ticks / strip) ===== */
console.log("\n== Cloak mirror: modes, per-block ticks, short cards");
{
  const R0 = (cloak, seg = null) => R.resolveMirror(cloak, seg);
  check(R0(null).mode === "off", "no cloak at all -> nothing is mirrored");
  check(R0({}).mode === "off", "the default cloak -> nothing is mirrored");

  const content = R0({ mirrorMode: "content" });
  check(content.mode === "content" && content.frameFlip === false,
    "content mode flips the programme, not the whole picture");
  const frame = R0({ mirrorMode: "frame" });
  check(frame.mode === "frame" && frame.frameFlip === true,
    "whole-picture mode flips the frame (camera included)");
  check(R0({ mirrorMode: "off" }).mode === "off", "off stays off");

  // a short card only covers the top of the programme: nothing under it is
  // mirrored, so the strip it leaves visible (subtitles) stays readable
  check(R0({ mirrorMode: "content" }, { type: "card", card: { variant: "short" } }).mode === "off",
    "a SHORT card is never mirrored");
  check(R0({ mirrorMode: "frame" }, { type: "card", card: { variant: "short" } }).mode === "off",
    "…neither whole-picture nor content-only");
  check(R0({ mirrorMode: "content" }, { type: "card", card: { variant: "full" } }).mode === "content",
    "a full card keeps the mirror (it covers the whole content rect)");
  check(R0({ mirrorMode: "content" }, { type: "card" }).mode === "content",
    "a card with no variant stored is a full card");
  check(R0({ mirrorMode: "content", mirrorScope: "blocks" },
           { type: "card", mirror: true, card: { variant: "short" } }).mode === "off",
    "a ticked short card stays unmirrored too");
  check(R0({ mirrorMode: "content" }, { type: "body" }).mode === "content",
    "reaction blocks are unaffected by the short-card rule");

  // projects saved before v7 (the old flip / flipContent flags)
  check(R0({ flipContent: true }).mode === "content", "legacy flipContent reads as content mode");
  check(R0({ flip: true }).mode === "legacy", "legacy flip keeps its own mode");
  check(R0({ mirrorMode: "frame", flip: true }).mode === "frame",
    "the v7 mode wins over a leftover legacy flag");

  // scope = the tick list
  const blocks = { mirrorMode: "content", mirrorScope: "blocks" };
  check(R0(blocks).mode === "off", "blocks scope: an unticked block is left alone");
  check(R0(blocks, { mirror: true }).mode === "content", "blocks scope: a ticked block flips");
  check(R0({ mirrorMode: "content" }, { mirror: false }).mode === "content",
    "reaction scope ignores the ticks");

  // the scene the canvas draws from — this is what the preview shows
  const halves = R.sourceHalves(1920, 1080, "single", "left");
  const cloak = {
    on: false, zoom: 1, bars: 0, border: 0, borderColor: "#0ea5e9", saturate: 100,
    contrast: 100, brightness: 100, hue: 0, grain: 0, vignette: 0, flip: false,
    flipContent: false, blur: 0, rotate: 0, speed: 1, contentOnly: true,
    mirrorMode: "content", mirrorScope: "blocks",
  };
  const segs = [
    { id: "i", type: "intro", start: 0, end: 2, mirror: true },
    { id: "b", type: "body", start: 2, end: 8, mirror: true },
    { id: "c", type: "body", start: 8, end: 10 },
    { id: "s", type: "card", start: 10, end: 14, mirror: true, card: { variant: "short" } },
    { id: "f", type: "card", start: 14, end: 18, mirror: true, card: { variant: "full" } },
  ];
  const sceneAt = (t, c = cloak) =>
    R.buildPassthroughScene(segs, t, halves.full, 4, LAYOUT.content, c, LAYOUT.cam, null);
  check(sceneAt(1).mirror === null, "an intro span is never mirrored, tick or no tick");
  check(sceneAt(3).mirror?.mode === "content", "the ticked reaction block is mirrored");
  check(sceneAt(9).mirror === null, "an unticked block is not");
  check(sceneAt(3, { ...cloak, on: true }).mirror?.mode === "content",
    "the mirror lands even with the frame cloak on");
  // the preview scene is where the short-card rule has to land: the card is
  // drawn on top, and the strip it leaves visible comes through unflipped
  check(sceneAt(11).mirror === null, "a short-card span is drawn unmirrored");
  check(sceneAt(15).mirror?.mode === "content", "a full-card span is mirrored as usual");
  const shortLog = draw(LAYOUT, sceneAt(11));
  check(shortLog.filter((e) => e.type === "drawImage" && e.m[0] < 0).length === 0,
    "no flipped draw happens inside a short card");

  const frameScene = sceneAt(3, { ...cloak, mirrorMode: "frame", on: true });
  check(frameScene.mirrorFrame === true, "whole-picture mode sets mirrorFrame");
  const log = draw(LAYOUT, frameScene);
  const flipped = log.filter((e) => e.type === "drawImage" && e.m[0] < 0);
  check(flipped.length >= 1, "the frame is drawn with a mirror transform");
  const contentScene = sceneAt(3, { ...cloak, on: true });
  const log2 = draw(LAYOUT, contentScene);
  const flipped2 = log2.filter((e) => e.type === "drawImage" && e.m[0] < 0);
  check(flipped2.length >= 1 && flipped2.length < flipped.length,
    "content mode flips less than the whole picture",
    `${flipped2.length} vs ${flipped.length}`);
  check(bboxNear(flipped2[0]?.bbox, rectPx(LAYOUT.content), 2.0),
    "the content flip lands exactly on the content rect", fmt(flipped2[0]?.bbox));
}

/* ================ 11. a mirror tick is a real edit (timeline) ============ */
console.log("\n== a mirror tick is a real edit");
{
  const a = [{ id: "a", type: "body", start: 0, end: 5 }];
  const b = [{ id: "a", type: "body", start: 0, end: 5, mirror: true }];
  check(!R.sameSegs(a, b), "ticking a block counts as a change (it used to be dropped)");
  check(R.sameSegs(b, [{ ...b[0] }]), "an identical tick list is still 'no change'");

  // tidy() rebuilds the list on every edit — a ticked and an unticked
  // neighbour must never be merged into one block
  const merged = R.tidy([
    { id: "a", type: "body", start: 0, end: 5, mirror: true },
    { id: "b", type: "body", start: 5, end: 9 },
  ]);
  check(merged.length === 2, "tidy keeps a ticked block apart from its unticked neighbour", String(merged.length));
  check(merged[0].mirror === true, "…and the tick survives the rebuild");
  const merged2 = R.tidy([
    { id: "a", type: "body", start: 0, end: 5, mirror: true },
    { id: "b", type: "body", start: 5, end: 9, mirror: true },
  ]);
  check(merged2.length === 1 && merged2[0].mirror === true,
    "two ticked neighbours still merge, tick intact");
}

/* ========================= 12. the sticker overlay ======================= */
console.log("\n== sticker / overlay image");
{
  const halves = R.sourceHalves(3840, 1080, "split", "left");
  const stickerImg = (over = {}) => ({
    on: true,
    src: "subscribe.png",
    x: 0.72,
    y: 0.04,
    w: 0.18,
    opacity: 1,
    ...over,
  });
  const segs = [
    { id: "i", type: "intro", start: 0, end: 2 },
    { id: "b", type: "body", start: 2, end: 6 },
    { id: "c", type: "card", start: 6, end: 9, card: { variant: "short" } },
    { id: "l", type: "lead", start: 9, end: 10 },
    { id: "o", type: "outro", start: 10, end: 12 },
  ];
  const sceneAt = (t, st) => R.buildScene(LAYOUT, segs, t, halves, st);
  // width 18 % of the frame, height follows the image's own 160x40 aspect
  const want = [0.72 * W, 0.04 * H, 0.9 * W, 0.04 * H + 0.18 * W * (40 / 160)];

  // the composite scene carries the overlay (this used to be null, which is
  // why the overview and the Patreon render never showed it)
  check(R.buildScene(LAYOUT, segs, 3, halves).sticker === null,
    "no sticker configured -> nothing in the scene");
  check(!!sceneAt(3, stickerImg())?.sticker, "body span: the scene carries the overlay");
  check(!!sceneAt(6, stickerImg())?.sticker, "card span: the scene carries the overlay");
  check(!!sceneAt(9, stickerImg())?.sticker, "lead span: the scene carries the overlay");
  check(sceneAt(1, stickerImg())?.sticker === null,
    "intro span: never overlaid (exported as recorded)");
  check(sceneAt(11, stickerImg())?.sticker === null, "outro span: never overlaid");

  const log = draw(LAYOUT, sceneAt(3, stickerImg()));
  const stick = log.filter((e) => e.type === "drawImage" && e.img === "sticker");
  check(stick.length === 1, "the overlay is drawn exactly once per frame");
  check(bboxNear(stick[0]?.bbox, want, 1.5),
    "at the configured position and width (height follows the aspect)", fmt(stick[0]?.bbox));
  check(Math.abs(stick[0]?.alpha - 1) < 1e-6, "full opacity by default");

  const ghost = draw(LAYOUT, sceneAt(3, stickerImg({ opacity: 0.5 })));
  const g = ghost.filter((e) => e.type === "drawImage" && e.img === "sticker")[0];
  check(!!g && Math.abs(g.alpha - 0.5) < 1e-6, "opacity is applied to the draw", `alpha=${g?.alpha}`);

  // the picture is clamped inside the frame, exactly like _sticker_png does
  const clamped = draw(LAYOUT, sceneAt(3, stickerImg({ x: 1, y: 1 })));
  const cl = clamped.filter((e) => e.type === "drawImage" && e.img === "sticker")[0];
  check(near(cl?.bbox[2], W, 1.5) && near(cl?.bbox[3], H, 1.5),
    "x/y = 100 % clamps the image inside the frame", fmt(cl?.bbox));

  check(sceneAt(3, stickerImg({ on: false }))?.sticker === null,
    "the on/off tick is honoured");
  check(sceneAt(3, stickerImg({ src: "" }))?.sticker === null,
    "an empty src draws nothing");

  // YouTube passthrough: same rule, different scene builder
  const yt = R.buildPassthroughScene(segs, 3, halves.full, 4, LAYOUT.content,
    null, LAYOUT.cam, stickerImg());
  check(!!yt.sticker, "passthrough body span carries the overlay");
  const ytIntro = R.buildPassthroughScene(segs, 1, halves.full, 4, LAYOUT.content,
    null, LAYOUT.cam, stickerImg());
  check(ytIntro.sticker === null, "passthrough intro stays clean");

  // Colab mode: `sticker.src` is only a *name* on the notebook (that is what
  // /api/upload hands back and the panel stores), so the preview can only
  // load it through the resolver the app installs once it is connected.
  // Without that hop the canvas drew nothing while Drive showed the file.
  R.setStickerResolver((src) => `https://tunnel.test/files/${encodeURIComponent(src)}`);
  check(R.stickerPreviewUrl("subscribe.png") === "https://tunnel.test/files/subscribe.png",
    "a bare notebook name resolves to a URL the browser can load",
    R.stickerPreviewUrl("subscribe.png"));
  const remote = draw(LAYOUT, sceneAt(3, stickerImg()));
  check(remote.filter((e) => e.type === "drawImage" && e.img === "sticker").length === 1,
    "the notebook-hosted overlay still reaches the preview canvas");
  check(R.stickerPreviewUrl("data:image/png;base64,AA") === "data:image/png;base64,AA" &&
    R.stickerPreviewUrl("https://cdn.test/a.png") === "https://cdn.test/a.png",
    "a local data URL / an http(s) src is used as is");
  R.setStickerResolver(null);
  check(R.stickerPreviewUrl("subscribe.png") === "subscribe.png",
    "disconnecting the backend drops the resolver again");
}

fs.rmSync(tmp, { force: true });
console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
