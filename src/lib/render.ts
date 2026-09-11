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
  /** overrides layout.content for the placeholder card (full-frame card in passthrough) */
  cardRect?: Rect;
  /** per-segment card text; empty fields fall back to layout.card */
  cardText?: { title?: string; sub?: string; accent?: string };
  /** anti-fingerprint frame treatment (YouTube passthrough only) */
  cloak?: VideoCloak | null;
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

  // Placeholder card: camera stays in its corner, the content area becomes the card
  if (type === "card") {
    return { bg: bgOf(), layers: [camLayer()], mode: "card", speed: 1, cardText: active?.card };
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
  cloak?: VideoCloak | null
): Scene {
  const active = segs.find((s) => srcTime >= s.start && srcTime < s.end);
  const type = active?.type ?? "body";
  if (type === "cut") return { bg: null, layers: [], mode: "cut", speed: 1 };
  if (type === "card") {
    return {
      bg: full,
      layers: [],
      mode: "card",
      speed: 1,
      cardRect: { x: 0.06, y: 0.16, w: 0.88, h: 0.68 },
      cardText: active?.card,
    };
  }
  const layer: SceneLayer = {
    src: full,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    style: FLAT,
  };
  const c = cloak && cloak.on ? cloak : null;
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

function drawCard(
  ctx: CanvasRenderingContext2D,
  layout: LayoutState,
  W: number,
  H: number,
  rect?: Rect,
  cardText?: { title?: string; sub?: string; accent?: string }
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
  const h = r.h * H;
  const radius = Math.min(28 * k, Math.min(w, h) / 2);

  ctx.save();
  ctx.filter = "none";
  shapePath(ctx, "rounded", x, y, w, h, radius);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "rgba(11,15,26,0.94)");
  g.addColorStop(1, "rgba(4,6,12,0.96)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);

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
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2 * k;
  shapePath(ctx, "rounded", x + 1, y + 1, w - 2, h - 2, radius);
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

/**
 * Full-frame draw with the anti-fingerprint treatment: slight punch-in,
 * colour shift, animated grain, vignette, cover bars and an optional frame.
 */
function drawCloakedFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  src: SrcRect,
  W: number,
  H: number,
  c: VideoCloak
) {
  const k = H / 1080;
  // cover the (zoomed) frame from the source rect
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
  ctx.save();
  const f: string[] = [];
  if (Math.abs(c.saturate - 100) > 0.5) f.push(`saturate(${(c.saturate / 100).toFixed(3)})`);
  if (Math.abs(c.contrast - 100) > 0.5) f.push(`contrast(${(c.contrast / 100).toFixed(3)})`);
  if (Math.abs(c.brightness - 100) > 0.5) f.push(`brightness(${(c.brightness / 100).toFixed(3)})`);
  if (Math.abs(c.hue) > 0.5) f.push(`hue-rotate(${c.hue.toFixed(1)}deg)`);
  ctx.filter = f.length ? f.join(" ") : "none";
  try {
    ctx.drawImage(video, sx, sy, sw, sh, (W - zw) / 2, (H - zh) / 2, zw, zh);
  } catch {
    /* frame not ready yet */
  }
  ctx.filter = "none";

  if (c.grain > 0.5) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.3, (c.grain / 100) * 0.3);
    const tile = getNoiseTile();
    const pat = ctx.createPattern(tile, "repeat");
    if (pat) {
      ctx.fillStyle = pat;
      // random offset every frame so the grain crawls instead of sitting still
      ctx.translate(-Math.random() * tile.width, -Math.random() * tile.height);
      ctx.fillRect(0, 0, W + tile.width, H + tile.height);
    }
    ctx.restore();
  }

  if (c.vignette > 0.5) {
    const g = ctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.36,
      W / 2, H / 2, Math.max(W, H) * 0.72
    );
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
  ctx.restore();
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

  // radius / border are authored in 1080p pixels, scale them for this canvas
  const k = H / 1080;
  for (const l of scene.layers) {
    // cloaked full-frame layer (YouTube passthrough) takes its own path
    if (scene.cloak && !l.isCam) {
      drawCloakedFrame(ctx, video, l.src, W, H, scene.cloak);
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

  if (scene.mode === "card") drawCard(ctx, layout, W, H, scene.cardRect);
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
