import { BeautyEngine, beautyActive } from "./beauty";
import { OUTPUT_H, OUTPUT_W } from "../lib/defaults";
import type { BeautySettings, CameraHalf, LayoutSettings, SourceKind, StageMode } from "../types";

type Crop = {
  el: CanvasImageSource | null;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  label: string;
  tint: string;
};

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function coverDest(
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return {
    x: dx + (dw - w) / 2,
    y: dy + (dh - h) / 2,
    w,
    h,
  };
}

function videoSize(el: CanvasImageSource | null) {
  if (!el) return { w: OUTPUT_W, h: OUTPUT_H };
  if (el instanceof HTMLVideoElement) {
    return { w: el.videoWidth || OUTPUT_W, h: el.videoHeight || OUTPUT_H };
  }
  if (el instanceof HTMLCanvasElement) {
    return { w: el.width, h: el.height };
  }
  return { w: OUTPUT_W, h: OUTPUT_H };
}

export function getCrops(opts: {
  kind: SourceKind;
  cameraHalf: CameraHalf;
  main: HTMLVideoElement | null;
  camera: HTMLVideoElement | null;
  content: HTMLVideoElement | null;
}): { camera: Crop; content: Crop } {
  const { kind, cameraHalf, main, camera, content } = opts;

  if (kind === "dual") {
    const camEl = camera ?? main;
    const conEl = content ?? main;
    const cs = videoSize(camEl);
    const ns = videoSize(conEl);
    return {
      camera: { el: camEl, sx: 0, sy: 0, sw: cs.w, sh: cs.h, label: "CAMERA", tint: "#f3c48a" },
      content: { el: conEl, sx: 0, sy: 0, sw: ns.w, sh: ns.h, label: "CONTENT", tint: "#6ee7d2" },
    };
  }

  const el = main;
  const size = videoSize(el);
  const half = size.w / 2;
  const left = { sx: 0, sy: 0, sw: half, sh: size.h };
  const right = { sx: half, sy: 0, sw: size.w - half, sh: size.h };
  const camRect = cameraHalf === "left" ? left : right;
  const conRect = cameraHalf === "left" ? right : left;
  return {
    camera: { el, ...camRect, label: "CAMERA", tint: "#f3c48a" },
    content: { el, ...conRect, label: "CONTENT", tint: "#6ee7d2" },
  };
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  crop: Crop,
  x: number,
  y: number,
  w: number,
  h: number,
  time: number,
) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#141822");
  g.addColorStop(1, "#0c1018");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const drift = (Math.sin(time / 700) * 0.5 + 0.5) * 80;
  ctx.fillStyle = crop.tint + "22";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.35 + drift, y + h * 0.45, w * 0.28, h * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = crop.tint + "18";
  ctx.fillRect(x + w * 0.12, y + h * 0.62, w * 0.76, h * 0.08);
  ctx.fillRect(x + w * 0.12, y + h * 0.74, w * 0.5, h * 0.05);
  ctx.restore();

  ctx.fillStyle = crop.tint;
  ctx.font = "600 28px Outfit, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(crop.label, x + w / 2, y + h / 2);
}

function sourceReady(el: CanvasImageSource | null) {
  if (!el) return false;
  if (el instanceof HTMLVideoElement) {
    return el.readyState >= 2 && el.videoWidth > 0;
  }
  return true;
}

function drawCropped(
  ctx: CanvasRenderingContext2D,
  crop: Crop,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  time: number,
  cover = true,
) {
  if (!sourceReady(crop.el) || crop.sw < 2 || crop.sh < 2) {
    drawPlaceholder(ctx, crop, dx, dy, dw, dh, time);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  if (cover) {
    const dest = coverDest(crop.sw, crop.sh, dx, dy, dw, dh);
    ctx.drawImage(crop.el as CanvasImageSource, crop.sx, crop.sy, crop.sw, crop.sh, dest.x, dest.y, dest.w, dest.h);
  } else {
    ctx.drawImage(crop.el as CanvasImageSource, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
  }
  ctx.restore();
}

function drawFramed(
  ctx: CanvasRenderingContext2D,
  crop: Crop,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  time: number,
  opts?: { border?: number; shadow?: boolean; borderColor?: string },
) {
  ctx.save();
  if (opts?.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.62)";
    ctx.shadowBlur = 48;
    ctx.shadowOffsetY = 18;
  }
  drawRoundedRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = "#05070c";
  ctx.fill();
  ctx.clip();
  ctx.shadowColor = "transparent";
  drawCropped(ctx, crop, x, y, w, h, time, true);
  ctx.restore();

  if (opts?.border) {
    ctx.save();
    drawRoundedRect(ctx, x, y, w, h, radius);
    ctx.strokeStyle = opts.borderColor ?? "rgba(255,236,210,0.82)";
    ctx.lineWidth = opts.border;
    ctx.stroke();
    drawRoundedRect(ctx, x + 2, y + 2, w - 4, h - 4, Math.max(0, radius - 2));
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

function drawBlurredBackground(
  ctx: CanvasRenderingContext2D,
  blurCanvas: HTMLCanvasElement,
  crop: Crop,
  blur: number,
  opacity: number,
  time: number,
) {
  const bw = 480;
  const bh = 270;
  if (blurCanvas.width !== bw) blurCanvas.width = bw;
  if (blurCanvas.height !== bh) blurCanvas.height = bh;
  const bctx = blurCanvas.getContext("2d");
  if (!bctx) return;
  bctx.clearRect(0, 0, bw, bh);
  const pad = 28;
  bctx.filter = `blur(${Math.max(2, blur * 22)}px)`;
  if (sourceReady(crop.el) && crop.sw > 1) {
    bctx.drawImage(
      crop.el as CanvasImageSource,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      -pad,
      -pad,
      bw + pad * 2,
      bh + pad * 2,
    );
  } else {
    bctx.filter = "none";
    const g = bctx.createLinearGradient(0, 0, bw, bh);
    g.addColorStop(0, "#1a2230");
    g.addColorStop(1, "#0d151c");
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, bw, bh);
  }
  bctx.filter = "none";
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(blurCanvas, 0, 0, OUTPUT_W, OUTPUT_H);
  ctx.restore();
  ctx.fillStyle = `rgba(5,7,12,${0.18 + (1 - opacity) * 0.12})`;
  ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
  void time;
}

function cornerPos(
  corner: LayoutSettings["cameraCorner"],
  w: number,
  h: number,
  margin: number,
) {
  switch (corner) {
    case "top-left":
      return { x: margin, y: margin };
    case "top-right":
      return { x: OUTPUT_W - w - margin, y: margin };
    case "bottom-left":
      return { x: margin, y: OUTPUT_H - h - margin };
    default:
      return { x: OUTPUT_W - w - margin, y: OUTPUT_H - h - margin };
  }
}

function fillCameraWork(work: HTMLCanvasElement, crop: Crop, w: number, h: number, timeMs: number) {
  const maxW = 960;
  const scale = Math.min(1, maxW / Math.max(w, 1));
  const cw = Math.max(8, Math.round(w * scale));
  const ch = Math.max(8, Math.round(h * scale));
  if (work.width !== cw) work.width = cw;
  if (work.height !== ch) work.height = ch;
  const wctx = work.getContext("2d");
  if (!wctx) return;
  wctx.clearRect(0, 0, cw, ch);
  drawCropped(wctx, crop, 0, 0, cw, ch, timeMs, true);
}

function drawCameraShape(
  ctx: CanvasRenderingContext2D,
  work: HTMLCanvasElement | null,
  crop: Crop,
  x: number,
  y: number,
  w: number,
  h: number,
  layout: LayoutSettings,
  timeMs: number,
) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.62)";
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 18;
  if (layout.cameraShape === "circle") {
    const r = Math.min(w, h) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#05070c";
    ctx.fill();
    ctx.clip();
    ctx.shadowColor = "transparent";
    if (work && work.width > 0) ctx.drawImage(work, x, y, w, h);
    else drawCropped(ctx, crop, x, y, w, h, timeMs, true);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 236, 210, 0.88)";
    ctx.lineWidth = layout.cameraBorder;
    ctx.stroke();
    return;
  }
  drawRoundedRect(ctx, x, y, w, h, layout.cameraRadius);
  ctx.fillStyle = "#05070c";
  ctx.fill();
  ctx.clip();
  ctx.shadowColor = "transparent";
  if (work && work.width > 0) ctx.drawImage(work, x, y, w, h);
  else drawCropped(ctx, crop, x, y, w, h, timeMs, true);
  ctx.restore();
  if (layout.cameraBorder) {
    ctx.save();
    drawRoundedRect(ctx, x, y, w, h, layout.cameraRadius);
    ctx.strokeStyle = "rgba(255, 236, 210, 0.88)";
    ctx.lineWidth = layout.cameraBorder;
    ctx.stroke();
    ctx.restore();
  }
}

function cameraBox(layout: LayoutSettings) {
  const margin = layout.cameraMargin;
  if (layout.look === "hero") {
    const size = Math.min(OUTPUT_W, OUTPUT_H) * layout.cameraScale;
    const pos = cornerPos(layout.cameraCorner, size, size, margin);
    if (layout.cameraCorner.includes("left")) pos.x = margin + 24;
    pos.y = (OUTPUT_H - size) * (layout.cameraCorner.startsWith("top") ? 0.18 : 0.55);
    if (layout.cameraCorner.startsWith("top")) pos.y = Math.max(margin, pos.y);
    return { x: pos.x, y: Math.min(OUTPUT_H - size - margin, Math.max(margin, pos.y)), w: size, h: size };
  }
  const camW = OUTPUT_W * layout.cameraScale;
  const camH = layout.cameraShape === "circle" ? camW : camW * (9 / 16);
  const pos = cornerPos(layout.cameraCorner, camW, camH, margin);
  return { x: pos.x, y: pos.y, w: camW, h: camH };
}

function vignette(ctx: CanvasRenderingContext2D, amount: number) {
  if (amount <= 0) return;
  const g = ctx.createRadialGradient(
    OUTPUT_W / 2,
    OUTPUT_H / 2,
    OUTPUT_H * 0.15,
    OUTPUT_W / 2,
    OUTPUT_H / 2,
    OUTPUT_W * 0.62,
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${amount})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
}

export function composeFrame(opts: {
  ctx: CanvasRenderingContext2D;
  blurCanvas: HTMLCanvasElement;
  mode: StageMode;
  layout: LayoutSettings;
  kind: SourceKind;
  cameraHalf: CameraHalf;
  main: HTMLVideoElement | null;
  camera: HTMLVideoElement | null;
  content: HTMLVideoElement | null;
  timeMs: number;
  contentBlack?: boolean;
  camWork?: HTMLCanvasElement;
  beauty?: BeautyEngine | null;
  beautySettings?: BeautySettings;
}) {
  const { ctx, blurCanvas, mode, layout, timeMs, contentBlack, camWork, beauty, beautySettings } = opts;
  ctx.clearRect(0, 0, OUTPUT_W, OUTPUT_H);
  ctx.fillStyle = "#07090e";
  ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);

  const crops = getCrops(opts);
  const box = mode === "intro" || mode === "outro"
    ? { x: 0, y: 0, w: OUTPUT_W, h: OUTPUT_H }
    : cameraBox(layout);

  if (camWork) {
    fillCameraWork(camWork, crops.camera, box.w, box.h, timeMs);
    if (beauty && beautySettings && beautyActive(beautySettings)) {
      beauty.process(camWork, timeMs, beautySettings);
    }
  }

  if (mode === "intro" || mode === "outro") {
    if (camWork && camWork.width > 0) {
      const dest = { x: 0, y: 0, w: OUTPUT_W, h: OUTPUT_H };
      const scale = Math.max(dest.w / camWork.width, dest.h / camWork.height);
      const dw = camWork.width * scale;
      const dh = camWork.height * scale;
      ctx.drawImage(camWork, dest.x + (dest.w - dw) / 2, dest.y + (dest.h - dh) / 2, dw, dh);
    } else {
      drawCropped(ctx, crops.camera, 0, 0, OUTPUT_W, OUTPUT_H, timeMs, true);
    }
    vignette(ctx, 0.28 + layout.vignette * 0.4);
    ctx.fillStyle = "rgba(243,196,138,0.08)";
    ctx.fillRect(0, OUTPUT_H - 8, OUTPUT_W, 8);
    return;
  }

  const margin = layout.cameraMargin;
  const contentW = OUTPUT_W * layout.contentScale;
  const contentH = contentW * (9 / 16);
  const cx = margin + layout.contentX * (OUTPUT_W - contentW - margin * 2);
  const cy = margin + layout.contentY * (OUTPUT_H - contentH - margin * 2);
  const showCard = layout.showContentCard && layout.look !== "blurStage";
  const blurAmt = layout.look === "blurStage" || layout.look === "hero" ? Math.max(layout.bgBlur, 0.62) : layout.bgBlur;
  const blurOp = layout.look === "blurStage" ? Math.max(layout.bgOpacity, 0.5) : layout.bgOpacity;

  if (contentBlack) {
    ctx.fillStyle = "#07090e";
    ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    if (showCard) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.62)";
      ctx.shadowBlur = 48;
      ctx.shadowOffsetY = 18;
      drawRoundedRect(ctx, cx, cy, contentW, contentH, layout.contentRadius);
      ctx.fillStyle = "#05070c";
      ctx.fill();
      ctx.restore();
      drawRoundedRect(ctx, cx, cy, contentW, contentH, layout.contentRadius);
      ctx.strokeStyle = "rgba(200, 230, 255, 0.78)";
      ctx.lineWidth = layout.contentBorder || 2;
      ctx.stroke();
    }
  } else {
    drawBlurredBackground(ctx, blurCanvas, crops.content, blurAmt, blurOp, timeMs);
    if (showCard) {
      drawFramed(ctx, crops.content, cx, cy, contentW, contentH, layout.contentRadius, timeMs, {
        shadow: true,
        border: layout.contentBorder,
        borderColor: "rgba(200, 230, 255, 0.78)",
      });
    }
  }

  drawCameraShape(ctx, camWork ?? null, crops.camera, box.x, box.y, box.w, box.h, layout, timeMs);
  vignette(ctx, layout.vignette * 0.55);
}
