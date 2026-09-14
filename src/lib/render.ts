import type { LayerStyle, LayoutState, Rect, Segment, Shape, VideoCloak } from "./types";
import { fitRect, type FacePose } from "./retouch";

export type SrcRect = { x: number; y: number; w: number; h: number };

export interface SceneLayer {
  src: SrcRect;
  rect: Rect;
  style: LayerStyle;
  /** the camera layer gets the retouch pipeline applied */
  isCam?: boolean;
}

export interface RetouchHook {
  /** Draw the camera into a work canvas and run the beauty stack on it. */
  prepare: (
    video: HTMLVideoElement,
    src: SrcRect,
    w: number,
    h: number,
    style: LayerStyle
  ) => HTMLCanvasElement | null;
  /** Face geometry to overlay while tuning. */
  debugPose: FacePose | null;
}

export interface Scene {
  bg: SrcRect | null;
  layers: SceneLayer[];
  mode: "solo" | "body" | "cut" | "fast" | "card" | "lead";
  speed: number;
  /** rect the placeholder card covers — layout.content unless overridden */
  cardRect?: Rect;
  /** camera corner in the source frame — restored on top of YouTube cards */
  camRect?: Rect;
  /** per-segment card text; empty fields fall back to layout.card */
  cardText?: { title?: string; sub?: string; accent?: string; variant?: "full" | "short" };
  /** anti-fingerprint frame treatment (YouTube passthrough only) */
  cloak?: VideoCloak | null;
}

/**
 * Where the content picture actually lands inside its layout box.
 *
 * `content` is a box, not a promise: the layer is drawn with fit/zoom/offset
 * (see fitRect), so a 16:9 source in a 16:9 box fills it exactly, while a
 * mismatched aspect (single-file mode, a hand-resized content box) letterboxes
 * the picture with margins on two sides. The card and the content cloak must
 * follow the *picture*, otherwise they cover the letterbox padding and the
 * content area looks shifted — that is the "card goes over the content frame
 * and leaves a gap on the right and bottom" bug.
 *
 * Works in normalised units, so it does not need the canvas size.
 */
export function contentPicture(
  layout: LayoutState,
  src: SrcRect,
  /**
   * Canvas aspect (width / height). Both previews and every Patreon export
   * are 16:9; the YouTube path never needs this (its card is the file's own
   * content rect). The normalised box has to be measured against *this*, not
   * against its own w/h: a 0.7 x 0.7 box is 16:9 on screen, not square.
   */
  aspect = 16 / 9
): Rect {
  const box = layout.content;
  const style = layout.contentStyle;
  const sAsp = src.w / Math.max(1e-6, src.h);
  const dAsp = (box.w * aspect) / Math.max(1e-9, box.h);
  let x = box.x;
  let y = box.y;
  let w = box.w;
  let h = box.h;
  if (style.fit === "contain") {
    // fitRect picks whichever axis is the constraint, then centres the result
    if (sAsp > dAsp) {
      h = (box.w * aspect) / sAsp;
      y = box.y + (box.h - h) / 2;
    } else {
      w = (box.h * sAsp) / aspect;
      x = box.x + (box.w - w) / 2;
    }
  } else {
    // cover: the picture bleeds out of the box, the visible part is the box
    w = box.w;
    h = box.h;
  }
  // zoom/offset move the *picture* inside the box the same way fitRect does
  const zw = w * Math.max(0.01, style.zoom);
  const zh = h * Math.max(0.01, style.zoom);
  return {
    x: x + (w - zw) / 2 + style.offsetX * w,
    y: y + (h - zh) / 2 + style.offsetY * h,
    w: zw,
    h: zh,
  };
}

/** Same, in device pixels of a W×H canvas. */
export function contentPicturePx(
  layout: LayoutState,
  src: SrcRect,
  W: number,
  H: number
): Rect {
  const n = contentPicture(layout, src, W / Math.max(1, H));
  return { x: n.x * W, y: n.y * H, w: n.w * W, h: n.h * H };
}

export function sourceHalves(
  vw: number,
  vh: number,
  mode: "split" | "single",
  cameraSide: "left" | "right"
): { cam: SrcRect; content: SrcRect; full: SrcRect } {
  const full: SrcRect = { x: 0, y: 0, w: vw, h: vh };
  if (mode === "single") return { cam: full, content: full, full };
  const left: SrcRect = { x: 0, y: 0, w: vw / 2, h: vh };
  const right: SrcRect = { x: vw / 2, y: 0, w: vw / 2, h: vh };
  return cameraSide === "left"
    ? { cam: left, content: right, full }
    : { cam: right, content: left, full };
}

const FLAT: LayerStyle = {
  fit: "cover",
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  mirror: false,
  radius: 0,
  shape: "rect",
  border: 0,
  borderColor: "#000",
  opacity: 1,
};

export function buildScene(
  layout: LayoutState,
  segs: Segment[],
  srcTime: number,
  halves: { cam: SrcRect; content: SrcRect; full: SrcRect }
): Scene {
  const active = segs.find((s) => srcTime >= s.start && srcTime < s.end);
  const type = active?.type ?? "body";
  const bgOf = () =>
    layout.bg.source === "content"
      ? halves.content
      : layout.bg.source === "camera"
      ? halves.cam
      : halves.full;

  if (type === "cut") return { bg: null, layers: [], mode: "cut", speed: 1 };

  const camLayer = (rect = layout.cam) => ({
    src: halves.cam,
    rect,
    style: layout.camStyle,
    isCam: true,
  });

  if (type === "intro" || type === "outro") {
    return {
      bg: bgOf(),
      layers: [
        {
          src: halves.cam,
          rect: { x: 0, y: 0, w: 1, h: 1 },
          style: layout.soloStyle,
          isCam: true,
        },
      ],
      mode: "solo",
      speed: 1,
    };
  }

  // Placeholder card: camera stays in its corner, the content picture becomes
  // the card. The card follows the *drawn* content (fit/zoom/offset applied),
  // so it can never spill over the letterbox padding around the picture.
  if (type === "card") {
    return {
      bg: bgOf(),
      layers: [camLayer()],
      mode: "card",
      speed: Math.max(1, active?.card?.speed ?? 1),
      cardRect: contentPicture(layout, halves.content),
      cardText: active?.card,
    };
  }

  // lead-in: reaction layout, but the content block is still black
  if (type === "lead") {
    return { bg: bgOf(), layers: [camLayer()], mode: "lead", speed: 1 };
  }

  const base: Scene = {
    bg: bgOf(),
    layers: [
      // `contentHidden` = the "big face, only blurred content behind" look
      ...(layout.contentHidden
        ? []
        : [{ src: halves.content, rect: layout.content, style: layout.contentStyle }]),
      camLayer(),
    ],
    mode: "body",
    speed: 1,
  };
  if (type === "fast") {
    base.mode = "fast";
    base.speed = layout.fastSpeed;
  }
  return base;
}

/**
 * YouTube mode: the source is already the finished 16:9 Patreon render, so it
 * passes through full-frame. Only cuts / mutes / speed / cards are applied —
 * there is no camera/content compositing to do.
 */
export function buildPassthroughScene(
  segs: Segment[],
  srcTime: number,
  full: SrcRect,
  speed: number,
  /**
   * The card rect — always the layout's own content rect (see below), which
   * is what the compositor covered when it made this file.
   */
  cardRect: Rect,
  cloak?: VideoCloak | null,
  /**
   * Where the camera corner sits in the finished file. The card pixels are
   * painted first and the camera region is then restored on top, so the card
   * covers 100% of the content yet can never touch the camera — whatever the
   * two rects do (they overlap by a hair in the default layout).
   */
  camRect?: Rect
): Scene {
  const active = segs.find((s) => srcTime >= s.start && srcTime < s.end);
  const type = active?.type ?? "body";
  if (type === "cut") return { bg: null, layers: [], mode: "cut", speed: 1 };
  const layer: SceneLayer = {
    src: full,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    style: FLAT,
  };
  const c = cloak && cloak.on ? cloak : null;
  if (type === "card") {
    // YouTube card: keep the full composited frame (camera corner stays
    // visible), cover only the content area of the finished file — the layout
    // rect the compositor used. A hardcoded fallback box here used to sit a
    // hair inside the real content rect, which is what left a gap on the
    // right and bottom of the card in the YouTube tab.
    return {
      bg: null,
      layers: [layer],
      mode: "card",
      speed: Math.max(1, active?.card?.speed ?? 1),
      cardRect,
      camRect,
      cardText: active?.card,
      cloak: c,
    };
  }
  if (type === "fast") return { bg: null, layers: [layer], mode: "fast", speed, cloak: c };
  return { bg: null, layers: [layer], mode: "body", speed: 1, cloak: c };
}

/** Clip/stroke path for any of the supported layer shapes. */
export function shapePath(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
) {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  let rr = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (shape === "pill") rr = Math.min(w, h) / 2;
  if (shape === "rect" || rr <= 0.5) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Draw a sub-rectangle of `image` into a destination rectangle, with fit/zoom/mirror. */
export function drawInto(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  src: SrcRect,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  style: LayerStyle
) {
  if (dw <= 0.5 || dh <= 0.5 || src.w <= 0 || src.h <= 0) return;
  const t = fitRect(src, dx, dy, dw, dh, style);

  ctx.save();
  ctx.globalAlpha *= style.opacity;
  if (style.mirror) {
    ctx.translate(t.zx * 2 + t.zw, 0);
    ctx.scale(-1, 1);
  }
  if (style.shape !== "rect" || style.radius > 0) {
    shapePath(ctx, style.shape, t.zx, t.zy, t.zw, t.zh, style.radius);
    ctx.clip();
  }
  try {
    ctx.drawImage(image, t.sx, t.sy, t.sw, t.sh, t.zx, t.zy, t.zw, t.zh);
  } catch {
    /* frame not ready yet */
  }
  if (style.border > 0) {
    ctx.lineWidth = style.border;
    ctx.strokeStyle = style.borderColor;
    shapePath(
      ctx,
      style.shape,
      t.zx + style.border / 2,
      t.zy + style.border / 2,
      Math.max(1, t.zw - style.border),
      Math.max(1, t.zh - style.border),
      Math.max(0, style.radius - style.border / 2)
    );
    ctx.stroke();
  }
  ctx.restore();
}

/** Custom card backgrounds, decoded once and shared by every draw. */
const cardImgCache = new Map<string, { img: HTMLImageElement; ready: boolean }>();
let cardImgEpoch = 0;
/** Bumped whenever a card image finishes loading — the preview loop repaints. */
export function cardImageEpoch(): number {
  return cardImgEpoch;
}
function getCardImage(url: string): HTMLImageElement | null {
  let e = cardImgCache.get(url);
  if (!e) {
    const img = new Image();
    e = { img, ready: false };
    cardImgCache.set(url, e);
    img.onload = () => {
      const cur = cardImgCache.get(url);
      if (cur) cur.ready = true;
      cardImgEpoch++;
    };
    img.onerror = () => {
      cardImgCache.delete(url);
      cardImgEpoch++;
    };
    img.src = url;
  }
  return e.ready && e.img.naturalWidth > 0 ? e.img : null;
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  layout: LayoutState,
  W: number,
  H: number,
  rect?: Rect,
  cardText?: { title?: string; sub?: string; accent?: string; variant?: "full" | "short" }
) {
  const k = H / 1080;
  const r = rect ?? layout.content;
  // per-segment override; empty fields inherit the global card
  const pick = (v: string | undefined) => (v && v.trim() ? v : undefined);
  const title = pick(cardText?.title) ?? layout.card.title;
  const sub = pick(cardText?.sub) ?? layout.card.sub;
  const accent = pick(cardText?.accent) ?? layout.card.accent;
  const x = r.x * W;
  const y = r.y * H;
  const w = r.w * W;
  const variant = cardText?.variant ?? "full";
  const shortH = Math.max(0.2, Math.min(1, layout.card.shortHeight ?? 0.75));
  // short cards anchor to the top of the content — the bottom (subtitles) stays visible
  const h = (variant === "short" ? r.h * shortH : r.h) * H;
  // Opacity is exact: 1 = fully opaque, 0 = the card isn't drawn at all.
  // (The old code clamped it to 0.05 and the gradient carried its own 0.94 /
  // 0.96 alpha, so 0 % still showed a card and 100 % was never opaque.)
  const opacity = Math.max(0, Math.min(1, layout.card.opacity ?? 0.9));
  if (opacity <= 0.001 || w <= 1 || h <= 1) return;
  // Use the same shape/radius as the content layer so the card fully covers it
  // (old fixed 28px radius left tiny gaps in the corners)
  const contentRadius = layout.contentStyle?.radius ?? 10;
  const contentShape = layout.contentStyle?.shape ?? "rounded";
  const radius = contentShape === "rect" ? 0 : Math.min(contentRadius * k, Math.min(w, h) / 2);

  // Custom background image (cover-fit, clipped to the card shape). While it
  // is still decoding we fall through to the generated gradient, so the card
  // is never blank.
  const imgUrl = (layout.card.image ?? "").trim();
  const showText = layout.card.showText !== false;
  const bgImg = imgUrl ? getCardImage(imgUrl) : null;

  ctx.save();
  ctx.filter = "none";
  // The whole card — backdrop, bar, words and ring — is painted at the same
  // alpha, so `opacity` means exactly what it says. The backdrop is opaque
  // at 100 %, which is what finally makes the slider read correctly.
  ctx.globalAlpha *= opacity;
  // Match content layer shape so card fully covers content (no corner gaps)
  shapePath(ctx, layout.contentStyle?.shape ?? "rounded", x, y, w, h, radius);
  ctx.clip();
  if (bgImg) {
    const iw = bgImg.naturalWidth;
    const ih = bgImg.naturalHeight;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    try {
      ctx.drawImage(bgImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } catch {
      /* fall through to the gradient below on a bad frame */
    }
    if (showText) {
      // gentle dim so the headline stays readable on any photo
      ctx.fillStyle = "rgba(2,4,10,0.45)";
      ctx.fillRect(x, y, w, h);
    }
  } else {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    // opaque stops: at 100 % the content is gone, at 50 % it ghosts through
    g.addColorStop(0, "rgb(11,15,26)");
    g.addColorStop(1, "rgb(4,6,12)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }

  if (bgImg && !showText) {
    // photo-only card: just the accent ring, no words
    ctx.strokeStyle = accent;
    ctx.globalAlpha *= 0.5;
    ctx.lineWidth = 2 * k;
    shapePath(ctx, layout.contentStyle?.shape ?? "rounded", x + 1, y + 1, w - 2, h - 2, radius);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // accent bar
  ctx.fillStyle = accent;
  ctx.fillRect(x + w * 0.16, y + h * 0.34, w * 0.68, 4 * k);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f1f5f9";
  const size = Math.max(11, Math.min(58 * k, (w * 0.072) | 0));
  ctx.font = `700 ${size}px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(title, x + w / 2, y + h * 0.47, w * 0.88);

  ctx.fillStyle = "rgba(226,232,240,0.72)";
  ctx.font = `400 ${(size * 0.62) | 0}px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(sub, x + w / 2, y + h * 0.58, w * 0.88);

  ctx.strokeStyle = accent;
  ctx.globalAlpha *= 0.5;
  ctx.lineWidth = 2 * k;
  shapePath(ctx, layout.contentStyle?.shape ?? "rounded", x + 1, y + 1, w - 2, h - 2, radius);
  ctx.stroke();
  ctx.restore();
}

/** Black content block while we wait for the video to actually start. */
function drawLeadBlock(
  ctx: CanvasRenderingContext2D,
  layout: LayoutState,
  W: number,
  H: number
) {
  const k = H / 1080;
  const r = layout.content;
  const x = r.x * W;
  const y = r.y * H;
  const w = r.w * W;
  const h = r.h * H;
  const radius = layout.contentStyle.radius * k;
  ctx.save();
  ctx.filter = "none";
  ctx.fillStyle = "#000000";
  shapePath(ctx, layout.contentStyle.shape, x, y, w, h, radius);
  ctx.fill();
  ctx.restore();
}

function drawSpeedBadge(
  ctx: CanvasRenderingContext2D,
  speed: number,
  W: number,
  H: number
) {
  const k = H / 1080;
  const label = `${speed % 1 === 0 ? speed : speed.toFixed(1)}× ▶▶`;
  ctx.save();
  ctx.filter = "none";
  ctx.font = `700 ${(20 * k) | 0}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const w = ctx.measureText(label).width + 22 * k;
  const h = 34 * k;
  const x = W - w - 18 * k;
  const y = H - h - 18 * k;
  shapePath(ctx, "pill", x, y, w, h, 0);
  ctx.fillStyle = "rgba(13,148,136,0.85)";
  ctx.fill();
  ctx.fillStyle = "#ecfeff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + k);
  ctx.restore();
}

/** Reusable monochrome noise tile for the animated grain overlay. */
let noiseTile: HTMLCanvasElement | null = null;
function getNoiseTile(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const cv = document.createElement("canvas");
  cv.width = 160;
  cv.height = 160;
  const c = cv.getContext("2d");
  if (c) {
    const img = c.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }
  noiseTile = cv;
  return cv;
}

/** Offscreen canvas cache for fisheye source */
let fisheyeSrcCanvas: HTMLCanvasElement | null = null;
function getFisheyeSrcCanvas(w: number, h: number): HTMLCanvasElement {
  if (!fisheyeSrcCanvas) fisheyeSrcCanvas = document.createElement("canvas");
  const cv = fisheyeSrcCanvas;
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  return cv;
}

/**
 * Draw src canvas onto ctx with fisheye lens distortion.
 * amount 0..1, 0=no distortion, 1=strong barrel bulge.
 * rotateDeg is applied as part of mapping (around center) so it composes correctly.
 * Uses grid approximation for performance: N x N cells with per-cell scale.
 */
function drawFisheyeGrid(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  amount: number,
  rotateDeg: number
) {
  if (dw <= 2 || dh <= 2) return;
  const amt = Math.max(0, Math.min(1, amount));
  if (amt < 0.01) {
    // fast path no fisheye but with rotation
    if (Math.abs(rotateDeg) > 0.05) {
      ctx.save();
      ctx.translate(dx + dw / 2, dy + dh / 2);
      ctx.rotate((rotateDeg * Math.PI) / 180);
      ctx.translate(-(dx + dw / 2), -(dy + dh / 2));
      try {
        ctx.drawImage(src, 0, 0, src.width, src.height, dx, dy, dw, dh);
      } catch {}
      ctx.restore();
    } else {
      try {
        ctx.drawImage(src, 0, 0, src.width, src.height, dx, dy, dw, dh);
      } catch {}
    }
    return;
  }
  const exp = 1 + amt * 1.8; // 1..2.8
  const cx = dx + dw / 2;
  const cy = dy + dh / 2;
  const maxR = Math.sqrt((dw / 2) * (dw / 2) + (dh / 2) * (dh / 2)); // diagonal half, keeps corners pinned
  const rad = (-rotateDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  // adaptive grid: larger area -> more cells, but capped for perf
  const N = dw * dh > 600 * 400 ? 20 : 16;
  const cellW = dw / N;
  const cellH = dh / N;
  const srcW = src.width;
  const srcH = src.height;
  // precompute scale from dw/dh to src
  const scaleX = srcW / dw;
  const scaleY = srcH / dh;

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const outX = dx + i * cellW;
      const outY = dy + j * cellH;
      const outCX = outX + cellW / 2;
      const outCY = outY + cellH / 2;
      let x = outCX - cx;
      let y = outCY - cy;
      // undo rotation
      const xr = x * cosR - y * sinR;
      const yr = x * sinR + y * cosR;
      const r = Math.sqrt(xr * xr + yr * yr);
      if (r < 0.5) {
        // near center, direct draw small src
        const rn = r / maxR;
        const rSrcNorm = rn <= 0 ? 0 : Math.pow(rn, exp);
        const rSrc = rSrcNorm * maxR;
        const theta = r > 0.001 ? Math.atan2(yr, xr) : 0;
        const srcXr = rSrc * Math.cos(theta);
        const srcYr = rSrc * Math.sin(theta);
        const srcCX = srcXr + dw / 2;
        const srcCY = srcYr + dh / 2;
        // scale derivative
        const deriv = rn > 0.01 ? exp * Math.pow(rn, exp - 1) : 0.15;
        const sW = Math.max(1, cellW * deriv * scaleX);
        const sH = Math.max(1, cellH * deriv * scaleY);
        const sx = Math.max(0, Math.min(srcW - 1, srcCX * scaleX - sW / 2));
        const sy = Math.max(0, Math.min(srcH - 1, srcCY * scaleY - sH / 2));
        try {
          ctx.drawImage(src, sx, sy, sW, sH, outX, outY, cellW, cellH);
        } catch {}
        continue;
      }
      const rn = Math.min(1, r / maxR);
      const rSrcNorm = Math.pow(rn, exp);
      const rSrc = rSrcNorm * maxR;
      const theta = Math.atan2(yr, xr);
      const srcXr = rSrc * Math.cos(theta);
      const srcYr = rSrc * Math.sin(theta);
      const srcCX = srcXr + dw / 2;
      const srcCY = srcYr + dh / 2;
      const deriv = exp * Math.pow(rn, exp - 1);
      const sW = Math.max(1, cellW * deriv * scaleX);
      const sH = Math.max(1, cellH * deriv * scaleY);
      const sx = Math.max(0, Math.min(srcW - 1, srcCX * scaleX - sW / 2));
      const sy = Math.max(0, Math.min(srcH - 1, srcCY * scaleY - sH / 2));
      // clamp source size inside src bounds
      const clampSW = Math.min(sW, srcW - sx);
      const clampSH = Math.min(sH, srcH - sy);
      if (clampSW <= 0 || clampSH <= 0) continue;
      try {
        ctx.drawImage(src, sx, sy, clampSW, clampSH, outX, outY, cellW, cellH);
      } catch {}
    }
  }
}

/**
 * Full-frame draw with the anti-fingerprint treatment: slight punch-in,
 * colour shift, animated grain, vignette, cover bars and an optional frame.
 *
 * When contentOnly=true (default), zoom/blur/rotate/hue/saturate/contrast/
 * brightness/grain/flipContent/fisheye affect only the content area, leaving the
 * camera corner untouched. That fixes "reaction cuts my camera / black lines":
 * the camera stays full quality, only the watched video gets disguised.
 * Mirroring is always content-only (`flip` is a legacy alias of flipContent):
 * the camera corner and the card text stay readable. The ffmpeg export does
 * the same (crop + hflip + paste back), so preview and render agree.
 *
 * NEW: fisheye lens distortion — strong anti-ContentID, content-only when
 * contentOnly=true, full-frame otherwise. Off by default.
 */
function drawCloakedFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  src: SrcRect,
  W: number,
  H: number,
  c: VideoCloak,
  contentRect?: Rect,
  layout?: LayoutState
) {
  const k = H / 1080;
  const cr = contentRect ?? layout?.content ?? { x: 0.294, y: 0.289, w: 0.7, h: 0.7 };
  const contentOnly = c.contentOnly ?? true;

  const buildFilters = () => {
    const f: string[] = [];
    if (Math.abs(c.saturate - 100) > 0.5) f.push(`saturate(${(c.saturate / 100).toFixed(3)})`);
    if (Math.abs(c.contrast - 100) > 0.5) f.push(`contrast(${(c.contrast / 100).toFixed(3)})`);
    if (Math.abs(c.brightness - 100) > 0.5) f.push(`brightness(${(c.brightness / 100).toFixed(3)})`);
    if (Math.abs(c.hue) > 0.5) f.push(`hue-rotate(${c.hue.toFixed(1)}deg)`);
    if ((c.blur ?? 0) > 0.05) f.push(`blur(${c.blur!.toFixed(2)}px)`);
    return f;
  };

  const fisheyeOn = !!(c.fisheye && (c.fisheyeAmount ?? 0) > 0.5);
  const fisheyeAmt = Math.max(0, Math.min(100, c.fisheyeAmount ?? 0)) / 100;

  // Full-frame path when contentOnly is off
  if (!contentOnly) {
    const zw = W * c.zoom;
    const zh = H * c.zoom;
    const sAsp = src.w / Math.max(1, src.h);
    const dAsp = zw / Math.max(1, zh);
    let sx = src.x;
    let sy = src.y;
    let sw = src.w;
    let sh = src.h;
    if (sAsp > dAsp) {
      sw = src.h * dAsp;
      sx = src.x + (src.w - sw) / 2;
    } else {
      sh = src.w / dAsp;
      sy = src.y + (src.h - sh) / 2;
    }

    // Build filtered full-frame into offscreen if fisheye needed
    if (fisheyeOn) {
      const tmp = getFisheyeSrcCanvas(W, H);
      const tctx = tmp.getContext("2d");
      if (tctx) {
        tctx.save();
        tctx.clearRect(0, 0, W, H);
        const f = buildFilters();
        tctx.filter = f.length ? f.join(" ") : "none";
        // handle flip as hflip in tmp
        if (c.flipContent || c.flip) {
          tctx.translate(W, 0);
          tctx.scale(-1, 1);
        }
        // zoom already accounted via sx/sy/sw/sh crop, but we also need to respect zw/zh centering
        const dx = (W - zw) / 2;
        const dy = (H - zh) / 2;
        try {
          tctx.drawImage(video, sx, sy, sw, sh, dx, dy, zw, zh);
        } catch {}
        tctx.filter = "none";
        tctx.restore();
      }
      // draw fisheye grid to main
      ctx.save();
      drawFisheyeGrid(ctx, tmp, 0, 0, W, H, fisheyeAmt, c.rotate ?? 0);
      // grain overlay
      if (c.grain > 0.5) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.3, (c.grain / 100) * 0.3);
        const tile = getNoiseTile();
        const pat = ctx.createPattern(tile, "repeat");
        if (pat) {
          ctx.fillStyle = pat;
          ctx.translate(-Math.random() * tile.width, -Math.random() * tile.height);
          ctx.fillRect(0, 0, W + tile.width, H + tile.height);
        }
        ctx.restore();
      }
      ctx.restore();
    } else {
      ctx.save();
      if (Math.abs(c.rotate ?? 0) > 0.05) {
        ctx.translate(W / 2, H / 2);
        ctx.rotate(((c.rotate ?? 0) * Math.PI) / 180);
        ctx.translate(-W / 2, -H / 2);
      }
      const dx = (W - zw) / 2;
      const dy = (H - zh) / 2;
      if (c.flipContent || c.flip) {
        ctx.translate(dx * 2 + zw, 0);
        ctx.scale(-1, 1);
      }
      const f = buildFilters();
      ctx.filter = f.length ? f.join(" ") : "none";
      try {
        ctx.drawImage(video, sx, sy, sw, sh, dx, dy, zw, zh);
      } catch {}
      ctx.filter = "none";

      if (c.grain > 0.5) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.3, (c.grain / 100) * 0.3);
        const tile = getNoiseTile();
        const pat = ctx.createPattern(tile, "repeat");
        if (pat) {
          ctx.fillStyle = pat;
          ctx.translate(-Math.random() * tile.width, -Math.random() * tile.height);
          ctx.fillRect(0, 0, W + tile.width, H + tile.height);
        }
        ctx.restore();
      }
      ctx.restore();
    }

    if (c.vignette > 0.5) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${((c.vignette / 100) * 0.55).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (c.bars > 0.05) {
      const bh = (H * c.bars) / 100;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, Math.ceil(bh));
      ctx.fillRect(0, H - Math.ceil(bh), W, Math.ceil(bh));
    }
    if (c.border > 0.5) {
      ctx.lineWidth = Math.max(1, c.border * k);
      ctx.strokeStyle = c.borderColor;
      const o = ctx.lineWidth / 2;
      ctx.strokeRect(o, o, W - ctx.lineWidth, H - ctx.lineWidth);
    }
    return;
  }

  // Content-only path (default): camera stays untouched, content gets disguised
  // 1) Base full frame, unflipped (the full-frame mirror goes on the
  // finished frame at the end of renderScene, like the ffmpeg export)
  try {
    ctx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, W, H);
  } catch {}

  // 2) Content area cloaked
  const cx = cr.x * W;
  const cy = cr.y * H;
  const cw = cr.w * W;
  const ch = cr.h * H;

  // Source content area inside the Patreon render (same normalized position)
  const sxc0 = src.x + src.w * cr.x;
  const syc0 = src.y + src.h * cr.y;
  const swc0 = src.w * cr.w;
  const shc0 = src.h * cr.h;

  let csx = sxc0;
  let csy = syc0;
  let csw = swc0;
  let csh = shc0;
  if (c.zoom > 1.001) {
    csw = swc0 / c.zoom;
    csh = shc0 / c.zoom;
    csx = sxc0 + (swc0 - csw) / 2;
    csy = syc0 + (shc0 - csh) / 2;
  }

  // Prepare filtered content into offscreen canvas
  const tmp = getFisheyeSrcCanvas(Math.max(2, Math.round(cw)), Math.max(2, Math.round(ch)));
  const tctx = tmp.getContext("2d");
  if (tctx) {
    tctx.save();
    tctx.clearRect(0, 0, tmp.width, tmp.height);
    const f = buildFilters();
    tctx.filter = f.length ? f.join(" ") : "none";
    if (c.flipContent || c.flip) {
      tctx.translate(tmp.width, 0);
      tctx.scale(-1, 1);
    }
    try {
      tctx.drawImage(video, csx, csy, csw, csh, 0, 0, tmp.width, tmp.height);
    } catch {}
    tctx.filter = "none";
    tctx.restore();
  }

  ctx.save();
  // Clip to content rect with same shape as content layer if available
  if (layout?.contentStyle) {
    const rad = (layout.contentStyle.radius ?? 10) * k;
    shapePath(ctx, layout.contentStyle.shape ?? "rounded", cx, cy, cw, ch, rad);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();
  }

  if (fisheyeOn && tmp) {
    drawFisheyeGrid(ctx, tmp, cx, cy, cw, ch, fisheyeAmt, c.rotate ?? 0);
  } else {
    // no fisheye: rotate around content center
    if (Math.abs(c.rotate ?? 0) > 0.05) {
      ctx.translate(cx + cw / 2, cy + ch / 2);
      ctx.rotate(((c.rotate ?? 0) * Math.PI) / 180);
      ctx.translate(-(cx + cw / 2), -(cy + ch / 2));
    }
    try {
      ctx.drawImage(tmp, cx, cy, cw, ch);
    } catch {}
  }

  if (c.grain > 0.5) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.3, (c.grain / 100) * 0.3);
    const tile = getNoiseTile();
    const pat = ctx.createPattern(tile, "repeat");
    if (pat) {
      ctx.fillStyle = pat;
      ctx.translate(-Math.random() * tile.width, -Math.random() * tile.height);
      ctx.fillRect(cx, cy, cw + tile.width, ch + tile.height);
    }
    ctx.restore();
  }
  ctx.restore();

  // 3) Full-frame overlays (bars, border, vignette) — always on top, not content-only
  if (c.vignette > 0.5) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${((c.vignette / 100) * 0.55).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (c.bars > 0.05) {
    const bh = (H * c.bars) / 100;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, Math.ceil(bh));
    ctx.fillRect(0, H - Math.ceil(bh), W, Math.ceil(bh));
  }
  if (c.border > 0.5) {
    ctx.lineWidth = Math.max(1, c.border * k);
    ctx.strokeStyle = c.borderColor;
    const o = ctx.lineWidth / 2;
    ctx.strokeRect(o, o, W - ctx.lineWidth, H - ctx.lineWidth);
  }
}

/**
 * Blurred / dimmed full-frame backdrop. The video is first down-scaled into a
 * scratch canvas — blurring a small bitmap and scaling it back up is an order of
 * magnitude cheaper than blurring the full frame every tick.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  scene: Scene,
  layout: LayoutState,
  W: number,
  H: number,
  scratch: HTMLCanvasElement,
  downscale: number,
  retouchHook?: RetouchHook | null,
  showFaceBox = false
) {
  const retouch = retouchHook ?? null;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.fillStyle = "#04060c";
  ctx.fillRect(0, 0, W, H);

  if (scene.bg) {
    const sw = Math.max(16, Math.round(W * downscale));
    const sh = Math.max(9, Math.round(H * downscale));
    if (scratch.width !== sw || scratch.height !== sh) {
      scratch.width = sw;
      scratch.height = sh;
    }
    const sctx = scratch.getContext("2d");
    if (sctx) {
      sctx.fillStyle = "#04060c";
      sctx.fillRect(0, 0, sw, sh);
      drawInto(sctx, video, scene.bg, 0, 0, sw, sh, FLAT);
      ctx.save();
      ctx.globalAlpha = layout.bg.opacity;
      ctx.filter = `blur(${(layout.bg.blur * downscale * (H / 1080)).toFixed(2)}px) brightness(${(
        1 - layout.bg.dim
      ).toFixed(3)}) saturate(1.15)`;
      const w = W * layout.bg.scale;
      const h = H * layout.bg.scale;
      ctx.drawImage(scratch, (W - w) / 2, (H - h) / 2, w, h);
      ctx.restore();
    }
  }

  // Patreon card: the placeholder goes down FIRST so the camera layer paints
  // over it — the card then covers the content 100% yet can never touch the
  // camera, even when the two rects overlap (they do, by a hair, by default).
  const cardFirst = scene.mode === "card" && scene.bg != null;
  if (cardFirst) drawCard(ctx, layout, W, H, scene.cardRect, scene.cardText);

  // radius / border are authored in 1080p pixels, scale them for this canvas
  const k = H / 1080;
  for (const l of scene.layers) {
    // cloaked full-frame layer (YouTube passthrough) takes its own path
    if (scene.cloak && !l.isCam) {
      drawCloakedFrame(ctx, video, l.src, W, H, scene.cloak, scene.cardRect, layout);
      continue;
    }
    const style: LayerStyle =
      l.style.radius || l.style.border
        ? { ...l.style, radius: l.style.radius * k, border: l.style.border * k }
        : l.style;

    // the camera goes through the beauty pipeline first
    let image: CanvasImageSource = video;
    let imageSrc = l.src;
    let imageStyle = style;
    if (l.isCam && retouch) {
      const prepared = retouch.prepare(
        video,
        l.src,
        Math.max(2, Math.round(l.rect.w * W)),
        Math.max(2, Math.round(l.rect.h * H)),
        l.style
      );
      if (prepared) {
        // the work canvas already holds the fitted / zoomed / offset camera,
        // so blit it 1:1 instead of applying the transform a second time
        image = prepared;
        imageSrc = { x: 0, y: 0, w: prepared.width, h: prepared.height };
        imageStyle = { ...style, fit: "cover", zoom: 1, offsetX: 0, offsetY: 0 };
      }
    }

    drawInto(
      ctx,
      image,
      imageSrc,
      l.rect.x * W,
      l.rect.y * H,
      l.rect.w * W,
      l.rect.h * H,
      imageStyle
    );

    if (l.isCam && retouch?.debugPose && showFaceBox) {
      drawFaceOverlay(ctx, retouch.debugPose, l.rect.x * W, l.rect.y * H, k);
    }
  }

  if (scene.mode === "card" && !cardFirst) {
    // YouTube card: the source is one flat composited frame, so there is no
    // camera layer to paint over the card — snapshot the camera corner first
    // (post-cloak pixels) and restore it after the card. Same guarantee as
    // the Patreon path above: full content cover, camera never touched.
    const cr = scene.camRect;
    let snap: ImageData | null = null;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let sh = 0;
    if (cr && cr.w > 0.001 && cr.h > 0.001) {
      sx = Math.max(0, Math.min(W - 1, Math.round(cr.x * W)));
      sy = Math.max(0, Math.min(H - 1, Math.round(cr.y * H)));
      sw = Math.max(0, Math.min(W - sx, Math.round(cr.w * W)));
      sh = Math.max(0, Math.min(H - sy, Math.round(cr.h * H)));
      if (sw > 1 && sh > 1) {
        try {
          snap = ctx.getImageData(sx, sy, sw, sh);
        } catch {
          snap = null;
        }
      }
    }
    drawCard(ctx, layout, W, H, scene.cardRect, scene.cardText);
    if (snap) {
      try {
        ctx.putImageData(snap, sx, sy);
      } catch {
        /* canvas tainted or detached — the card stays, camera covered */
      }
    }
  }
  if (scene.mode === "lead") drawLeadBlock(ctx, layout, W, H);
  if (scene.mode === "fast") drawSpeedBadge(ctx, scene.speed, W, H);
  ctx.restore();
}

/** Where the tracked face actually is — handy while tuning. */
function drawFaceOverlay(
  ctx: CanvasRenderingContext2D,
  pose: FacePose,
  ox: number,
  oy: number,
  k: number
) {
  ctx.save();
  ctx.filter = "none";
  ctx.lineWidth = Math.max(1, 1.5 * k);
  ctx.strokeStyle = "rgba(56,189,248,0.85)";
  ctx.beginPath();
  pose.oval.forEach((p, i) => {
    const x = ox + p.x;
    const y = oy + p.y;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = "rgba(232,121,249,0.9)";
  for (const [p, r] of [
    [pose.eyeL, pose.eyeRadius],
    [pose.eyeR, pose.eyeRadius],
    [pose.nose, pose.noseRadius],
  ] as [typeof pose.eyeL, number][]) {
    ctx.beginPath();
    ctx.arc(ox + p.x, oy + p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function pickRecorderMime(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}
