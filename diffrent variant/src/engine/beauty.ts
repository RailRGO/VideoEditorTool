import type { BeautySettings } from "../types";

type Pt = { x: number; y: number };

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const L_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const R_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";

function pts(lm: { x: number; y: number }[], idx: number[], w: number, h: number): Pt[] {
  return idx.map((i) => ({ x: lm[i].x * w, y: lm[i].y * h }));
}

function centroid(p: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q.x;
    y += q.y;
  }
  return { x: x / p.length, y: y / p.length };
}

function radius(p: Pt[], c: Pt) {
  let r = 0;
  for (const q of p) {
    const d = Math.hypot(q.x - c.x, q.y - c.y);
    if (d > r) r = d;
  }
  return r * 1.15;
}

function pathPoly(ctx: CanvasRenderingContext2D, p: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.closePath();
}

function insidePoly(p: Pt[], x: number, y: number) {
  let n = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i].x;
    const yi = p[i].y;
    const xj = p[j].x;
    const yj = p[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-6) + xi) n = !n;
  }
  return n;
}

export function beautyActive(b: BeautySettings) {
  return b.enabled && (b.smooth > 0.01 || b.teeth > 0.01 || b.nose > 0.01 || b.eyes > 0.01);
}

export class BeautyEngine {
  ready = false;
  loading = false;
  locked = false;
  error: string | null = null;
  private landmarker: { detectForVideo: (img: TexImageSource, ts: number) => { faceLandmarks: { x: number; y: number }[][] } } | null =
    null;
  private detect = document.createElement("canvas");
  private mask = document.createElement("canvas");
  private blur = document.createElement("canvas");
  private lastTs = -1;
  private smoothLm: { x: number; y: number }[] | null = null;
  private lost = 0;

  async ensure() {
    if (this.ready || this.loading) return;
    this.loading = true;
    try {
      const mod = await import("@mediapipe/tasks-vision");
      const vision = await mod.FilesetResolver.forVisionTasks(WASM);
      const opts = {
        runningMode: "VIDEO" as const,
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minTrackingConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
      };
      try {
        this.landmarker = await mod.FaceLandmarker.createFromOptions(vision, {
          ...opts,
          baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
        });
      } catch {
        this.landmarker = await mod.FaceLandmarker.createFromOptions(vision, {
          ...opts,
          baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        });
      }
      this.ready = true;
      this.error = null;
    } catch {
      this.error = "Face tracker failed to load (needs network once for the model).";
    } finally {
      this.loading = false;
    }
  }

  process(cam: HTMLCanvasElement, ts: number, settings: BeautySettings) {
    if (!this.ready || !this.landmarker || !beautyActive(settings)) {
      this.locked = false;
      return;
    }
    const w = cam.width;
    const h = cam.height;
    if (w < 8 || h < 8) return;

    const dw = 256;
    const dh = Math.max(8, Math.round((h / w) * dw));
    if (this.detect.width !== dw) this.detect.width = dw;
    if (this.detect.height !== dh) this.detect.height = dh;
    const dctx = this.detect.getContext("2d", { willReadFrequently: true });
    if (!dctx) return;
    dctx.drawImage(cam, 0, 0, dw, dh);

    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;

    let lm: { x: number; y: number }[] | null = null;
    try {
      const res = this.landmarker.detectForVideo(this.detect, ts);
      if (res.faceLandmarks[0]?.length) lm = res.faceLandmarks[0];
    } catch {
      lm = null;
    }

    if (lm) {
      this.lost = 0;
      if (!this.smoothLm) this.smoothLm = lm.map((p) => ({ x: p.x, y: p.y }));
      else {
        const fw = Math.abs((lm[234]?.x ?? 0.3) - (lm[454]?.x ?? 0.7));
        const maxJump = Math.max(0.04, fw * 0.14);
        for (let i = 0; i < lm.length; i++) {
          const s = this.smoothLm[i];
          const n = lm[i];
          const jump = Math.hypot(n.x - s.x, n.y - s.y);
          const a = jump > maxJump ? 0.12 : 0.38;
          s.x += (n.x - s.x) * a;
          s.y += (n.y - s.y) * a;
        }
      }
    } else {
      this.lost += 1;
      if (this.lost > 18) this.smoothLm = null;
    }

    this.locked = Boolean(this.smoothLm);
    if (!this.smoothLm) return;

    const mesh = this.smoothLm;
    const oval = pts(mesh, OVAL, w, h);
    const le = pts(mesh, L_EYE, w, h);
    const re = pts(mesh, R_EYE, w, h);
    const mouthIn = pts(mesh, LIPS_INNER, w, h);
    const mouthOut = pts(mesh, LIPS_OUTER, w, h);

    if (settings.eyes > 0.01 || settings.nose > 0.01) {
      warpFace(cam, le, re, mesh, w, h, settings.eyes, settings.nose);
    }
    if (settings.smooth > 0.01) {
      smoothSkin(cam, this.blur, this.mask, oval, le, re, mouthOut, settings.smooth);
    }
    if (settings.teeth > 0.01) {
      whitenTeeth(cam, mouthIn, settings.teeth);
    }
  }
}

function smoothSkin(
  cam: HTMLCanvasElement,
  blur: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  oval: Pt[],
  le: Pt[],
  re: Pt[],
  mouth: Pt[],
  amount: number,
) {
  const w = cam.width;
  const h = cam.height;
  if (blur.width !== w) blur.width = w;
  if (blur.height !== h) blur.height = h;
  if (mask.width !== w) mask.width = w;
  if (mask.height !== h) mask.height = h;
  const bctx = blur.getContext("2d");
  const mctx = mask.getContext("2d");
  const ctx = cam.getContext("2d");
  if (!bctx || !mctx || !ctx) return;

  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = "#fff";
  pathPoly(mctx, oval);
  mctx.fill();
  mctx.globalCompositeOperation = "destination-out";
  pathPoly(mctx, le);
  mctx.fill();
  pathPoly(mctx, re);
  mctx.fill();
  pathPoly(mctx, mouth);
  mctx.fill();
  mctx.globalCompositeOperation = "source-over";

  bctx.filter = `blur(${3 + amount * 9}px)`;
  bctx.drawImage(cam, 0, 0);
  bctx.filter = "none";
  bctx.globalCompositeOperation = "destination-in";
  bctx.drawImage(mask, 0, 0);
  bctx.globalCompositeOperation = "source-over";

  ctx.save();
  ctx.globalAlpha = 0.28 + amount * 0.62;
  ctx.drawImage(blur, 0, 0);
  ctx.restore();
}

function whitenTeeth(cam: HTMLCanvasElement, mouth: Pt[], amount: number) {
  const ctx = cam.getContext("2d", { willReadFrequently: true });
  if (!ctx || mouth.length < 4) return;
  let minX = 1e9,
    minY = 1e9,
    maxX = 0,
    maxY = 0;
  for (const p of mouth) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  minX = Math.max(0, Math.floor(minX));
  minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(cam.width, Math.ceil(maxX));
  maxY = Math.min(cam.height, Math.ceil(maxY));
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < 4 || bh < 4) return;
  const img = ctx.getImageData(minX, minY, bw, bh);
  const d = img.data;
  const t = amount;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!insidePoly(mouth, x + minX, y + minY)) continue;
      const i = (y * bw + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const yellow = (r + g) * 0.5 - b;
      if (luma < 88 || r < 70 || g < 55) continue;
      if (r > g * 1.45 && r > b * 1.35) continue;
      d[i] = Math.min(255, r + 8 * t - yellow * 0.15 * t);
      d[i + 1] = Math.min(255, g + 14 * t);
      d[i + 2] = Math.min(255, b + 38 * t);
      const lift = 12 * t;
      d[i] = Math.min(255, d[i] + lift);
      d[i + 1] = Math.min(255, d[i + 1] + lift);
      d[i + 2] = Math.min(255, d[i + 2] + lift);
    }
  }
  ctx.putImageData(img, minX, minY);
}

function warpFace(
  cam: HTMLCanvasElement,
  le: Pt[],
  re: Pt[],
  mesh: { x: number; y: number }[],
  w: number,
  h: number,
  eyes: number,
  nose: number,
) {
  const ctx = cam.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const lc = centroid(le);
  const rc = centroid(re);
  const lr = radius(le, lc);
  const rr = radius(re, rc);
  const noseC = { x: mesh[1].x * w, y: mesh[1].y * h };
  const noseR = Math.hypot(mesh[1].x - mesh[5].x, mesh[1].y - mesh[5].y) * w * 2.4;

  const minX = Math.max(0, Math.floor(Math.min(lc.x - lr, rc.x - rr, noseC.x - noseR) - 4));
  const minY = Math.max(0, Math.floor(Math.min(lc.y - lr, rc.y - rr, noseC.y - noseR) - 4));
  const maxX = Math.min(w, Math.ceil(Math.max(lc.x + lr, rc.x + rr, noseC.x + noseR) + 4));
  const maxY = Math.min(h, Math.ceil(Math.max(lc.y + lr, rc.y + rr, noseC.y + noseR) + 4));
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < 8 || bh < 8) return;

  const src = ctx.getImageData(minX, minY, bw, bh);
  const out = ctx.createImageData(bw, bh);
  out.data.set(src.data);
  const s = src.data;
  const o = out.data;
  const eAmt = eyes * 0.42;
  const nAmt = nose * 0.38;

  const sample = (x: number, y: number, i: number) => {
    x = Math.min(bw - 1.001, Math.max(0, x));
    y = Math.min(bh - 1.001, Math.max(0, y));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(bw - 1, x0 + 1);
    const y1 = Math.min(bh - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * bw + x0) * 4 + i;
    const i10 = (y0 * bw + x1) * 4 + i;
    const i01 = (y1 * bw + x0) * 4 + i;
    const i11 = (y1 * bw + x1) * 4 + i;
    return s[i00] * (1 - fx) * (1 - fy) + s[i10] * fx * (1 - fy) + s[i01] * (1 - fx) * fy + s[i11] * fx * fy;
  };

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let sx = x;
      let sy = y;
      const gx = x + minX;
      const gy = y + minY;
      if (eAmt > 0) {
        for (const eye of [
          { c: lc, r: lr },
          { c: rc, r: rr },
        ]) {
          const dx = gx - eye.c.x;
          const dy = gy - eye.c.y;
          const d2 = dx * dx + dy * dy;
          const r2 = eye.r * eye.r;
          if (d2 < r2 && d2 > 1) {
            const t = 1 - Math.sqrt(d2) / eye.r;
            const k = eAmt * t * t;
            sx -= dx * k;
            sy -= dy * k;
          }
        }
      }
      if (nAmt > 0) {
        const dx = gx - noseC.x;
        const dy = gy - noseC.y;
        const d2 = dx * dx + dy * dy;
        const r2 = noseR * noseR;
        if (d2 < r2 && d2 > 1) {
          const t = 1 - Math.sqrt(d2) / noseR;
          const k = nAmt * t * t;
          sx += dx * k;
          sy += dy * k;
        }
      }
      if (sx === x && sy === y) continue;
      const di = (y * bw + x) * 4;
      o[di] = sample(sx, sy, 0);
      o[di + 1] = sample(sx, sy, 1);
      o[di + 2] = sample(sx, sy, 2);
    }
  }
  ctx.putImageData(out, minX, minY);
}

export const defaultBeauty = (): BeautySettings => ({
  enabled: true,
  smooth: 0,
  teeth: 0,
  nose: 0,
  eyes: 0,
});
