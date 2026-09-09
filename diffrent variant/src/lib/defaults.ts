import type { AudioSettings, BeautySettings, LayoutSettings } from "../types";

export const OUTPUT_W = 1920;
export const OUTPUT_H = 1080;

export const defaultLayout = (): LayoutSettings => ({
  contentScale: 0.7,
  cameraScale: 0.3,
  cameraCorner: "top-left",
  cameraMargin: 40,
  contentX: 1,
  contentY: 1,
  bgBlur: 0.5,
  bgOpacity: 0.4,
  cameraRadius: 28,
  contentRadius: 28,
  cameraBorder: 3,
  contentBorder: 2.5,
  vignette: 0.32,
  look: "cards",
  cameraShape: "rounded",
  showContentCard: true,
});

export const defaultBeauty = (): BeautySettings => ({
  enabled: true,
  smooth: 0,
  teeth: 0,
  nose: 0,
  eyes: 0,
});

export const defaultAudio = (): AudioSettings => ({
  micChannel: 0,
  contentChannel: 1,
  micGain: 1,
  contentGain: 0.85,
  masterGain: 0.95,
  swapChannels: false,
  compressor: {
    enabled: true,
    threshold: -24,
    ratio: 4,
    attack: 0.012,
    release: 0.12,
    knee: 8,
    makeup: 4,
  },
  limiter: {
    enabled: true,
    threshold: -1.2,
  },
  ducking: {
    enabled: true,
    threshold: -32,
    depth: 12,
    attack: 0.05,
    release: 0.32,
  },
});

export const layoutPresets: { id: string; name: string; hint: string; values: Partial<LayoutSettings> }[] = [
  {
    id: "diagonal",
    name: "Diagonal cards",
    hint: "Camera top-left, content bottom-right",
    values: {
      look: "cards",
      cameraShape: "rounded",
      showContentCard: true,
      contentScale: 0.7,
      cameraScale: 0.3,
      cameraCorner: "top-left",
      contentX: 1,
      contentY: 1,
      cameraMargin: 40,
    },
  },
  {
    id: "circle-blur",
    name: "Circle on blur",
    hint: "Round face over fully blurred watch",
    values: {
      look: "blurStage",
      cameraShape: "circle",
      showContentCard: false,
      cameraScale: 0.44,
      cameraCorner: "top-left",
      bgBlur: 0.78,
      bgOpacity: 0.58,
    },
  },
  {
    id: "rect-blur",
    name: "Rect on blur",
    hint: "Rounded face, content only as blur",
    values: {
      look: "blurStage",
      cameraShape: "rounded",
      showContentCard: false,
      cameraScale: 0.48,
      cameraCorner: "top-left",
      cameraRadius: 36,
      bgBlur: 0.78,
      bgOpacity: 0.55,
    },
  },
  {
    id: "hero-circle",
    name: "Hero circle",
    hint: "Face takes most of the frame",
    values: {
      look: "hero",
      cameraShape: "circle",
      showContentCard: false,
      cameraScale: 0.82,
      cameraCorner: "top-left",
      bgBlur: 0.7,
      bgOpacity: 0.5,
    },
  },
  {
    id: "hero-plus",
    name: "Hero + content",
    hint: "Big face, small content card",
    values: {
      look: "hero",
      cameraShape: "rounded",
      showContentCard: true,
      cameraScale: 0.72,
      contentScale: 0.34,
      cameraCorner: "top-left",
      contentX: 1,
      contentY: 1,
      cameraRadius: 32,
    },
  },
  {
    id: "news",
    name: "News inset",
    hint: "Camera top-right",
    values: {
      look: "cards",
      cameraShape: "rounded",
      showContentCard: true,
      contentScale: 0.72,
      cameraScale: 0.26,
      cameraCorner: "top-right",
      cameraMargin: 28,
      contentX: 0.08,
      contentY: 0.62,
    },
  },
];
