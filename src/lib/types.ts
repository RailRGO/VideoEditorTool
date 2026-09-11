export type Fit = "cover" | "contain";

/** Normalised rectangle (0..1) relative to the output frame. */
export type Rect = { x: number; y: number; w: number; h: number };

export type SegmentType =
  | "intro"
  | "body"
  | "outro"
  | "lead"
  | "cut"
  | "mute"
  | "fast"
  | "card";

export interface Segment {
  id: string;
  type: SegmentType;
  start: number;
  end: number;
  /** per-card override — empty fields inherit the global card (layout.card) */
  card?: { title?: string; sub?: string; accent?: string };
}

export interface Claim {
  id: string;
  start: number;
  end: number;
  label: string;
  action: "none" | "cut" | "mute";
}

/** Mask shape of a layer. `rounded` uses the radius slider, `pill` = stadium. */
export type Shape = "rect" | "rounded" | "circle" | "pill";

export interface LayerStyle {
  fit: Fit;
  zoom: number;
  offsetX: number;
  offsetY: number;
  mirror: boolean;
  radius: number;
  shape: Shape;
  border: number;
  borderColor: string;
  opacity: number;
}

/** Beauty / face-shape retouch applied to the camera layer. */
export interface Retouch {
  enabled: boolean;
  /** 0 = off, 100 = full */
  skin: number;
  /** edge preservation — high keeps hair / brows / glasses crisp */
  detail: number;
  teeth: number;
  eyeScale: number;
  noseScale: number;
  /** soften the warp boundary so the distortion isn't visible */
  feather: number;
  /** temporal smoothing of the tracked landmarks (anti-jitter) */
  smoothing: number;
  /** run the detector every Nth frame; in between, the last pose is carried */
  everyN: number;
  /** fall back to a manually placed face box if tracking is unavailable */
  manual: boolean;
  manualRect: Rect;
}

export const defaultRetouch: Retouch = {
  enabled: false,
  skin: 55,
  detail: 45,
  teeth: 40,
  eyeScale: 0,
  noseScale: 0,
  feather: 45,
  smoothing: 60,
  everyN: 1,
  manual: false,
  manualRect: { x: 0.3, y: 0.1, w: 0.4, h: 0.55 },
};

export interface BackgroundStyle {
  source: "content" | "camera" | "full";
  blur: number;
  opacity: number;
  scale: number;
  dim: number;
}

export interface LayoutState {
  /** which half of the 3840x1080 OBS capture holds the webcam */
  cameraSide: "left" | "right";
  /** 'split' = 3840x1080 side-by-side capture, 'single' = one ordinary 16:9 file */
  sourceMode: "split" | "single";
  content: Rect;
  cam: Rect;
  bg: BackgroundStyle;
  contentStyle: LayerStyle;
  camStyle: LayerStyle;
  soloStyle: LayerStyle;
  muteContentInSolo: boolean;
  /** hide the sharp content layer entirely — only the blurred plate remains */
  contentHidden: boolean;
  /** fast-forward multiplier used by `fast` segments */
  fastSpeed: number;
  /** extra attenuation applied to content audio while fast-forwarding */
  fastGainDb: number;
  /** pitch rises with speed (classic fast-forward sound) instead of being preserved */
  chipmunk: boolean;
  card: { title: string; sub: string; accent: string };
}

export interface Compressor {
  on: boolean;
  threshold: number;
  ratio: number;
  knee: number;
  attack: number;
  release: number;
  makeup: number;
}

export interface Ducking {
  on: boolean;
  threshold: number;
  depth: number;
  attack: number;
  release: number;
  hold: number;
}

export interface AudioState {
  mic: {
    channel: "left" | "right";
    gain: number;
    pan: number;
    comp: Compressor;
    limiter: number;
  };
  content: {
    gain: number;
    duck: Ducking;
  };
  master: {
    gain: number;
  };
}

/** Which deliverable we're building right now. */
export type Target = "patreon" | "youtube";
export const TARGET_META: Record<Target, { label: string; hint: string; badge: string }> = {
  patreon: {
    label: "Patreon",
    hint: "from the raw 32:9 capture · separate mic + content channels · full compositing",
    badge: "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-100",
  },
  youtube: {
    label: "YouTube",
    hint: "from the finished 16:9 Patreon render · mixed audio · straight cuts only",
    badge: "border-sky-400/40 bg-sky-500/15 text-sky-100",
  },
};

/** How the reaction part begins: camera corner + black content block. */
export interface LeadConfig {
  /** how much of your "let's go" stays at the end of the intro */
  leadIn: number;
  /** black content block before the video actually starts */
  black: number;
}

export interface PolishRules {
  /** a pause longer than this inside intro / outro gets tightened */
  maxPause: number;
  /** what a tightened pause becomes */
  keepPause: number;
  /** repeated audio shorter than this is a stutter, not a take */
  minRepeat: number;
  /** repeated audio at least this long counts as another take */
  minTake: number;
  /** silence needed between two takes */
  takeGap: number;
  /** drop um / uh / er / hmm … */
  dropFillers: boolean;
  /** drop like / basically / you know / I mean … */
  dropSoftFillers: boolean;
  /** plain-text transcript: spread words out at this rate instead of using real timings */
  approxWps: number;
}

export interface DisruptRules {
  /** a repeated stretch of content at least this long counts as a rewind-replay */
  minRepeat: number;
  /** look for repeats at least this far apart */
  minSeparation: number;
  /** also trim dead air where the content went silent (buffering) */
  trimDeadAir: boolean;
  /** content silence longer than this gets tightened */
  deadAir: number;
  /** what a trimmed dead-air gap becomes */
  keepDead: number;
}

export const defaultLead: LeadConfig = { leadIn: 2, black: 1.5 };

export const defaultPolish: PolishRules = {
  maxPause: 0.9,
  keepPause: 0.3,
  minRepeat: 0.5,
  minTake: 2,
  takeGap: 0.6,
  dropFillers: true,
  dropSoftFillers: false,
  approxWps: 2.8,
};

export const defaultDisrupt: DisruptRules = {
  minRepeat: 3,
  minSeparation: 4,
  trimDeadAir: true,
  deadAir: 4,
  keepDead: 1,
};

export interface CutOptions {
  /** how many dB above the measured noise floor counts as speech */
  marginDb: number;
  /** ignore bursts shorter than this */
  minSpeech: number;
  /** silences shorter than this stay in the video */
  maxGap: number;
  /** context kept before / after each burst */
  pad: number;
  /** drop kept islands shorter than this */
  minKeep: number;
  /** what happens to the parts without commentary */
  replace: "cut" | "fast" | "card";
}

export const SEGMENT_META: Record<
  SegmentType,
  { label: string; short: string; chip: string; bar: string; text: string }
> = {
  intro: {
    label: "Intro",
    short: "INTRO",
    chip: "bg-violet-500/15 text-violet-200 border-violet-400/30",
    bar: "bg-violet-500/35 border-violet-300/40",
    text: "your camera, full frame, never trimmed",
  },
  body: {
    label: "Reaction",
    short: "REACT",
    chip: "bg-sky-500/15 text-sky-200 border-sky-400/30",
    bar: "bg-sky-500/30 border-sky-300/40",
    text: "content + camera corner",
  },
  lead: {
    label: "Lead-in",
    short: "LEAD",
    chip: "bg-cyan-500/15 text-cyan-200 border-cyan-400/30",
    bar: "bg-cyan-500/35 border-cyan-300/40",
    text: "reaction layout, content block still black",
  },
  outro: {
    label: "Outro",
    short: "OUTRO",
    chip: "bg-indigo-500/15 text-indigo-200 border-indigo-400/30",
    bar: "bg-indigo-500/35 border-indigo-300/40",
    text: "your camera, full frame, never trimmed",
  },
  cut: {
    label: "Removed",
    short: "CUT",
    chip: "bg-rose-500/15 text-rose-200 border-rose-400/30",
    bar: "bg-rose-600/40 border-rose-400/40",
    text: "dropped from the render entirely",
  },
  fast: {
    label: "Fast-forward",
    short: "FFWD",
    chip: "bg-teal-500/15 text-teal-200 border-teal-400/30",
    bar: "bg-teal-500/35 border-teal-300/40",
    text: "kept, but sped up",
  },
  mute: {
    label: "Muted",
    short: "MUTE",
    chip: "bg-amber-500/15 text-amber-200 border-amber-400/30",
    bar: "bg-amber-500/35 border-amber-300/40",
    text: "video plays, content audio silenced",
  },
  card: {
    label: "Card",
    short: "CARD",
    chip: "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/30",
    bar: "bg-fuchsia-500/35 border-fuchsia-300/40",
    text: "placeholder instead of the content",
  },
};

const baseStyle = (fit: Fit): LayerStyle => ({
  fit,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  mirror: false,
  radius: 0,
  shape: "rounded",
  border: 0,
  borderColor: "#0b1220",
  opacity: 1,
});

/**
 * Camera top-left, content bottom-right, both rounded.
 * Measured sizes at 1080p: content 1344x756 (70%), camera 576x324 (30%),
 * corner radius 10 on content, 20 on camera.
 */
export const defaultLayout: LayoutState = {
  cameraSide: "left",
  sourceMode: "split",
  cam: { x: 0.006, y: 0.011, w: 0.3, h: 0.3 },
  content: { x: 0.294, y: 0.289, w: 0.7, h: 0.7 },
  bg: { source: "full", blur: 50, opacity: 0.4, scale: 1.08, dim: 0.25 },
  contentStyle: { ...baseStyle("contain"), radius: 10, shape: "rounded" },
  camStyle: {
    ...baseStyle("contain"),
    radius: 20,
    border: 3,
    borderColor: "#0ea5e9",
  },
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
  },
};

export const defaultAudio: AudioState = {
  mic: {
    channel: "left",
    gain: 1,
    pan: 0,
    comp: {
      on: true,
      threshold: -22,
      ratio: 4,
      knee: 8,
      attack: 6,
      release: 180,
      makeup: 4,
    },
    limiter: -3,
  },
  content: {
    gain: 0.85,
    duck: {
      on: true,
      threshold: -34,
      depth: 14,
      attack: 60,
      release: 420,
      hold: 320,
    },
  },
  master: { gain: 1 },
};

/**
 * Anti-fingerprint processing for the YouTube cut. The source there is already
 * mixed, so this treats the whole programme (you + content) as one signal.
 * Everything here preserves duration — no timeline remapping needed.
 */
export interface AudioCloak {
  on: boolean;
  /** tempo-preserving pitch shift in semitones (±1 ≈ ±6%) */
  pitch: number;
  /** chorus movement 0..100 — constantly detunes the spectrum */
  chorus: number;
  /** small-room reverb 0..100 */
  reverb: number;
  /** EQ tilt in dB: positive = brighter, negative = darker */
  tilt: number;
  /** Haas stereo widening in ms (delays the right channel) */
  widen: number;
}

export const defaultAudioCloak: AudioCloak = {
  on: true,
  pitch: 0.5,
  chorus: 25,
  reverb: 18,
  tilt: 2,
  widen: 6,
};

/**
 * Frame-level changes for the YouTube cut. Applied to the full frame in
 * passthrough mode — zoom/crop, cover bars, colour and grain.
 */
export interface VideoCloak {
  on: boolean;
  /** punch-in 1..1.12 — drops edge pixels trackers rely on */
  zoom: number;
  /** top/bottom cover bars, % of frame height each */
  bars: number;
  /** inset frame border, 1080p px */
  border: number;
  borderColor: string;
  /** colour, % (100 = untouched) */
  saturate: number;
  contrast: number;
  brightness: number;
  /** hue rotation in degrees */
  hue: number;
  /** animated film grain 0..100 */
  grain: number;
  /** edge darkening 0..100 */
  vignette: number;
}

export const defaultVideoCloak: VideoCloak = {
  on: true,
  zoom: 1.03,
  bars: 3,
  border: 0,
  borderColor: "#0ea5e9",
  saturate: 108,
  contrast: 104,
  brightness: 100,
  hue: 0,
  grain: 12,
  vignette: 25,
};

export const defaultCut: CutOptions = {
  marginDb: 7,
  minSpeech: 0.3,
  maxGap: 1.2,
  pad: 1.1,
  minKeep: 1.5,
  replace: "card",
};

export type LayoutPreset = {
  id: string;
  name: string;
  hint: string;
  content: Rect;
  cam: Rect;
  camShape: Shape;
  hideContent: boolean;
  /** corner radii in 1080p px; applied when present */
  contentRadius?: number;
  camRadius?: number;
};

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: "reaction-1344",
    name: "Reaction 1344+576",
    hint: "content 1344×756 r10 · cam 576×324 r20",
    cam: { x: 0.006, y: 0.011, w: 0.3, h: 0.3 },
    content: { x: 0.294, y: 0.289, w: 0.7, h: 0.7 },
    camShape: "rounded",
    hideContent: false,
    contentRadius: 10,
    camRadius: 20,
  },
  {
    id: "hero-circle",
    name: "Hero circle",
    hint: "big circle face · content blurred behind",
    cam: { x: 0.28, y: 0.06, w: 0.44, h: 0.78 },
    content: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    camShape: "circle",
    hideContent: true,
  },
  {
    id: "hero-circle-left",
    name: "Hero circle L",
    hint: "big circle left · blurred content",
    cam: { x: 0.04, y: 0.1, w: 0.42, h: 0.74 },
    content: { x: 0.45, y: 0.2, w: 0.5, h: 0.6 },
    camShape: "circle",
    hideContent: true,
  },
  {
    id: "hero-pill",
    name: "Hero pill",
    hint: "stadium face · blurred content",
    cam: { x: 0.18, y: 0.22, w: 0.64, h: 0.56 },
    content: { x: 0.2, y: 0.25, w: 0.6, h: 0.5 },
    camShape: "pill",
    hideContent: true,
  },
  {
    id: "hero-rect",
    name: "Hero rectangle",
    hint: "large rounded face · blurred content",
    cam: { x: 0.12, y: 0.08, w: 0.5, h: 0.84 },
    content: { x: 0.6, y: 0.25, w: 0.36, h: 0.5 },
    camShape: "rounded",
    hideContent: true,
  },
  {
    id: "tl-br",
    name: "Cam TL · content BR",
    hint: "your default look",
    cam: { x: 0.006, y: 0.011, w: 0.3, h: 0.3 },
    content: { x: 0.294, y: 0.289, w: 0.7, h: 0.7 },
    camShape: "rounded",
    hideContent: false,
    contentRadius: 10,
    camRadius: 20,
  },
  {
    id: "tl-br-tight",
    name: "Cam TL · content BR",
    hint: "small camera · bigger content",
    cam: { x: 0.025, y: 0.04, w: 0.24, h: 0.27 },
    content: { x: 0.29, y: 0.26, w: 0.685, h: 0.7 },
    camShape: "rounded",
    hideContent: false,
  },
  {
    id: "bl-tr",
    name: "Cam BL · content TR",
    hint: "mirrored corners",
    cam: { x: 0.03, y: 0.62, w: 0.3, h: 0.335 },
    content: { x: 0.35, y: 0.045, w: 0.62, h: 0.655 },
    camShape: "rounded",
    hideContent: false,
  },
  {
    id: "overlay-br",
    name: "Content full",
    hint: "camera overlaid TL",
    cam: { x: 0.03, y: 0.045, w: 0.3, h: 0.335 },
    content: { x: 0.02, y: 0.06, w: 0.96, h: 0.88 },
    camShape: "rounded",
    hideContent: false,
  },
];
