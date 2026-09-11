import type { Rect, Retouch } from "./types";

export interface Pt {
  x: number;
  y: number;
}

/** A source rectangle in image pixels (same shape as render.ts's SrcRect). */
export interface SrcRectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The subset of LayerStyle that the fit maths needs. */
export interface FitStyle {
  fit: "cover" | "contain";
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Where a source rect lands after fit / zoom / offset. */
export interface DrawTransform {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  zx: number;
  zy: number;
  zw: number;
  zh: number;
}

/**
 * The exact fit maths used by drawInto: crop (cover) or letterbox (contain)
 * the source into the destination, then apply zoom and offset. `sx/sy/sw/sh`
 * is the visible source sub-rect (image pixels); `zx/zy/zw/zh` is where it is
 * drawn (destination pixels). Kept in one place so the retouch pose mapping
 * can't drift from what actually gets drawn.
 */
export function fitRect(
  src: SrcRectLike,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  style: FitStyle
): DrawTransform {
  const sAsp = src.w / src.h;
  const dAsp = dw / dh;
  let sx = src.x;
  let sy = src.y;
  let sw = src.w;
  let sh = src.h;
  if (style.fit === "cover") {
    if (sAsp > dAsp) {
      const nw = src.h * dAsp;
      sx = src.x + (src.w - nw) / 2;
      sw = nw;
    } else {
      const nh = src.w / dAsp;
      sy = src.y + (src.h - nh) / 2;
      sh = nh;
    }
  } else {
    let w = dw;
    let h = dh;
    if (sAsp > dAsp) h = dw / sAsp;
    else w = dh * sAsp;
    dx += (dw - w) / 2;
    dy += (dh - h) / 2;
    dw = w;
    dh = h;
  }
  const zw = dw * style.zoom;
  const zh = dh * style.zoom;
  const zx = dx + (dw - zw) / 2 + style.offsetX * dw;
  const zy = dy + (dh - zh) / 2 + style.offsetY * dh;
  return { sx, sy, sw, sh, zx, zy, zw, zh };
}

/** Landmark indices from the MediaPipe face mesh (478 points, irises included). */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];

/** Inner lip ring — the region that actually contains the teeth. */
export const INNER_LIP = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87,
  178, 88, 95,
];

export const IRIS_R = 468;
export const IRIS_L = 473;
export const NOSE_TIP = 1;
export const NOSE_BRIDGE = 168;
export const CHIN = 152;
export const FOREHEAD = 10;

/**
 * Face pose in *layer* pixel space (the already-fitted camera layer), so the
 * retouch moves with the layer's zoom / offset / crop for free.
 */
export interface FacePose {
  /** in layer pixels */
  oval: Pt[];
  innerLip: Pt[];
  eyeL: Pt;
  eyeR: Pt;
  nose: Pt;
  /** distance between the outer eye corners, in layer pixels */
  eyeSpan: number;
  /** eye radius in layer pixels (for the enlarge warp) */
  eyeRadius: number;
  /** nose warp radius in layer pixels */
  noseRadius: number;
  box: { x: number; y: number; w: number; h: number };
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Convert normalised landmarks (0..1 over the camera half of the source) into
 * layer pixels. `src` is the camera source rect (image pixels) and `t` is the
 * same fitRect() transform that drew the camera into the work canvas, so the
 * pose lines up with the pixels exactly — for cover, contain, zoom and offset
 * alike.
 */
export function poseFromLandmarks(
  lm: { x: number; y: number }[],
  src: SrcRectLike,
  t: DrawTransform
): FacePose {
  const map = (i: number): Pt => ({
    x: t.zx + ((src.x + lm[i].x * src.w - t.sx) / t.sw) * t.zw,
    y: t.zy + ((src.y + lm[i].y * src.h - t.sy) / t.sh) * t.zh,
  });

  const oval = FACE_OVAL.map(map);
  const innerLip = INNER_LIP.map(map);
  const eyeL = map(IRIS_L);
  const eyeR = map(IRIS_R);
  const nose = map(NOSE_TIP);

  // eye span from the outer corners (33 = right outer, 263 = left outer)
  const rOuter = map(33);
  const lOuter = map(263);
  const eyeSpan = Math.hypot(lOuter.x - rOuter.x, lOuter.y - rOuter.y);
  const eyeRadius = Math.max(6, eyeSpan * 0.32);
  const noseRadius = Math.max(8, eyeSpan * 0.42);

  const xs = oval.map((p) => p.x);
  const ys = oval.map((p) => p.y);
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  return { oval, innerLip, eyeL, eyeR, nose, eyeSpan, eyeRadius, noseRadius, box };
}

/** Manual pose from a dragged box — used when the tracker isn't available. */
export function poseFromBox(box: Rect, layer: { w: number; h: number }): FacePose {
  const x = box.x * layer.w;
  const y = box.y * layer.h;
  const w = box.w * layer.w;
  const h = box.h * layer.h;
  const eyeSpan = w * 0.72;
  const oval: Pt[] = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    oval.push({ x: x + w / 2 + (Math.cos(a) * w) / 2, y: y + h / 2 + (Math.sin(a) * h) / 2 });
  }
  const lipW = w * 0.4;
  const lipH = h * 0.16;
  const innerLip: Pt[] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    innerLip.push({
      x: x + w / 2 + (Math.cos(a) * lipW) / 2,
      y: y + h * 0.72 + (Math.sin(a) * lipH) / 2,
    });
  }
  return {
    oval,
    innerLip,
    eyeL: { x: x + w * 0.32, y: y + h * 0.42 },
    eyeR: { x: x + w * 0.68, y: y + h * 0.42 },
    nose: { x: x + w * 0.5, y: y + h * 0.6 },
    eyeSpan,
    eyeRadius: Math.max(6, eyeSpan * 0.32),
    noseRadius: Math.max(8, eyeSpan * 0.42),
    box: { x, y, w, h },
  };
}

/* --------------------------------------------------------------- geometry */

function inPoly(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

/** Signed distance to a polygon's bounding shape, softened by `soft` pixels. */
function polyMask(p: Pt, poly: Pt[], soft: number): number {
  const inside = inPoly(p, poly);
  if (soft <= 0.5) return inside ? 1 : 0;
  // distance to the nearest edge
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx - p.x;
    const py = a.y + t * dy - p.y;
    d = Math.min(d, Math.hypot(px, py));
  }
  const v = inside ? 1 : 1 - Math.min(1, d / soft);
  return Math.max(0, Math.min(1, v));
}

/** Cheap, conservative skin-tone test — keeps the smoothing off hair and walls. */
function isSkin(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 60 &&
    g > 30 &&
    b > 15 &&
    max - min > 12 &&
    r > g + 8 &&
    r > b + 8 &&
    r < 255
  );
}

/* ------------------------------------------------------- the actual filters */

/**
 * Edge-preserving skin smoothing. A blurred copy is built in a scratch canvas
 * (GPU blur, so it's fast), then blended back only where the skin mask is set,
 * with the high-frequency detail re-added in proportion to `detail` so hair,
 * brows, glasses and eyelashes stay sharp instead of turning to mush.
 */
export function smoothSkin(
  ctx: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  pose: FacePose,
  amount: number,
  detail: number,
  feather: number
) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (amount <= 0 || w < 4 || h < 4) return;

  const src = ctx.getImageData(0, 0, w, h);
  const blurW = Math.max(4, Math.round(w / 3));
  const blurH = Math.max(4, Math.round(h / 3));
  if (scratch.width !== blurW || scratch.height !== blurH) {
    scratch.width = blurW;
    scratch.height = blurH;
  }
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!sctx) return;
  sctx.clearRect(0, 0, blurW, blurH);
  sctx.drawImage(ctx.canvas, 0, 0, blurW, blurH);
  // blur the small copy; scaling back up afterwards adds more of its own
  sctx.filter = `blur(${Math.max(0.6, (amount / 100) * 2.4).toFixed(2)}px)`;
  sctx.drawImage(scratch, 0, 0);
  sctx.filter = "none";
  const blurred = sctx.getImageData(0, 0, blurW, blurH).data;

  const soft = Math.max(2, (feather / 100) * Math.max(w, h) * 0.06);
  const mix = Math.min(1, amount / 100);
  const keepDetail = Math.min(1, detail / 100);
  const sx = blurW / w;
  const sy = blurH / h;
  const data = src.data;

  // only walk the face bounding box + feather, not the whole layer
  const x0 = Math.max(0, Math.floor(pose.box.x - soft));
  const y0 = Math.max(0, Math.floor(pose.box.y - soft));
  const x1 = Math.min(w - 1, Math.ceil(pose.box.x + pose.box.w + soft));
  const y1 = Math.min(h - 1, Math.ceil(pose.box.y + pose.box.h + soft));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const m = polyMask({ x, y }, pose.oval, soft);
      if (m <= 0.01) continue;
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (!isSkin(r, g, b)) continue;

      const bi = ((Math.round(y * sy) * blurW) + Math.round(x * sx)) * 4;
      const br = blurred[bi];
      const bg = blurred[bi + 1];
      const bb = blurred[bi + 2];

      // detail layer = original − blurred; put a fraction of it back
      const dr = r - br;
      const dg = g - bg;
      const db = b - bb;

      const a = m * mix;
      data[i] = r + a * ((br + dr * keepDetail) - r);
      data[i + 1] = g + a * ((bg + dg * keepDetail) - g);
      data[i + 2] = b + a * ((bb + db * keepDetail) - b);
    }
  }
  ctx.putImageData(src, 0, 0);
}

/**
 * Whiten teeth inside the inner-lip polygon. Gated on brightness and saturation
 * so it lifts the teeth without turning the lips pale.
 */
export function whitenTeeth(
  ctx: CanvasRenderingContext2D,
  pose: FacePose,
  amount: number,
  feather: number
) {
  if (amount <= 0) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const soft = Math.max(1.5, (feather / 100) * 22);
  const strength = amount / 100;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pose.innerLip) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX - soft));
  const y0 = Math.max(0, Math.floor(minY - soft));
  const x1 = Math.min(w - 1, Math.ceil(maxX + soft));
  const y1 = Math.min(h - 1, Math.ceil(maxY + soft));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const m = polyMask({ x, y }, pose.innerLip, soft);
      if (m <= 0.01) continue;
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      // teeth: reasonably bright and not strongly coloured (lips are)
      const toothiness = Math.max(0, Math.min(1, (lum - 55) / 90)) * (1 - Math.min(1, sat / 0.42));
      const a = m * strength * toothiness;
      if (a <= 0.005) continue;
      // pull toward a bright, low-saturation version of itself
      const target = Math.min(255, lum * 1.14 + 26);
      data[i] = r + a * (target - r);
      data[i + 1] = g + a * (target * 0.995 - g);
      data[i + 2] = b + a * (target * 0.97 - b);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Radial warp used for eye enlargement and nose narrowing. Inverse mapping with
 * a smooth cosine falloff, so the boundary blends into untouched pixels instead
 * of showing a seam. `scale` > 1 magnifies (bigger eyes), < 1 pinches (smaller
 * nose).
 */
export function radialWarp(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  radius: number,
  scale: number,
  feather: number
) {
  if (Math.abs(scale - 1) < 0.005 || radius < 2) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  // how far the influence reaches beyond the warp radius
  const reach = radius * (1 + Math.max(0, feather / 100) * 1.2);

  const x0 = Math.max(0, Math.floor(center.x - reach));
  const y0 = Math.max(0, Math.floor(center.y - reach));
  const x1 = Math.min(w - 1, Math.ceil(center.x + reach));
  const y1 = Math.min(h - 1, Math.ceil(center.y + reach));
  if (x1 <= x0 || y1 <= y0) return;

  const img = ctx.getImageData(0, 0, w, h);
  const src = new Uint8ClampedArray(img.data);
  const out = img.data;
  const smooth = 0.5 * (1 + Math.tanh((1 - Math.abs(scale)) * 3)) * 0 + 1; // keeps types honest

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      const d = Math.hypot(dx, dy);
      if (d > reach) continue;
      // full effect inside `radius`, easing to nothing at `reach`
      const t = d <= radius ? 1 : Math.max(0, Math.cos(((d - radius) / (reach - radius)) * Math.PI * 0.5));
      if (t <= 0.001) continue;
      // effective magnification at this pixel
      const mag = 1 + (scale - 1) * t;
      const sx = center.x + dx / mag;
      const sy = center.y + dy / mag;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const i00 = (iy * w + ix) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
      void smooth;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Apply the whole stack to a camera layer that has already been drawn. */
export function applyRetouch(
  ctx: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  pose: FacePose,
  cfg: Retouch
) {
  if (!cfg.enabled) return;
  if (cfg.skin > 0) {
    smoothSkin(ctx, scratch, pose, cfg.skin, cfg.detail, cfg.feather);
  }
  if (cfg.teeth > 0) whitenTeeth(ctx, pose, cfg.teeth, cfg.feather);
  if (Math.abs(cfg.eyeScale) > 0.005) {
    const s = 1 + cfg.eyeScale / 100;
    radialWarp(ctx, pose.eyeL, pose.eyeRadius, s, cfg.feather);
    radialWarp(ctx, pose.eyeR, pose.eyeRadius, s, cfg.feather);
  }
  if (Math.abs(cfg.noseScale) > 0.005) {
    const s = 1 + cfg.noseScale / 100; // negative = narrower
    radialWarp(ctx, pose.nose, pose.noseRadius, s, cfg.feather);
  }
}

export const poseTools = { centroid };
