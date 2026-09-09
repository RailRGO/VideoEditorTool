export type CameraHalf = "left" | "right";
export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type StageMode = "intro" | "reaction" | "outro";
export type InspectorTab = "layout" | "audio" | "auto" | "edit" | "export";
export type SourceKind = "ultrawide" | "dual";
export type ProgramLook = "cards" | "blurStage" | "hero";
export type CameraShape = "rounded" | "circle";

export interface Span {
  id: string;
  start: number;
  end: number;
}

export interface MuteSpan extends Span {
  track: "mic" | "content";
}

export interface LayoutSettings {
  contentScale: number;
  cameraScale: number;
  cameraCorner: Corner;
  cameraMargin: number;
  contentX: number;
  contentY: number;
  bgBlur: number;
  bgOpacity: number;
  cameraRadius: number;
  contentRadius: number;
  cameraBorder: number;
  contentBorder: number;
  vignette: number;
  look: ProgramLook;
  cameraShape: CameraShape;
  showContentCard: boolean;
}

export interface BeautySettings {
  enabled: boolean;
  smooth: number;
  teeth: number;
  nose: number;
  eyes: number;
}

export interface CompressorSettings {
  enabled: boolean;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
  makeup: number;
}

export interface LimiterSettings {
  enabled: boolean;
  threshold: number;
}

export interface DuckingSettings {
  enabled: boolean;
  threshold: number;
  depth: number;
  attack: number;
  release: number;
}

export interface AudioSettings {
  micChannel: 0 | 1;
  contentChannel: 0 | 1;
  micGain: number;
  contentGain: number;
  masterGain: number;
  swapChannels: boolean;
  compressor: CompressorSettings;
  limiter: LimiterSettings;
  ducking: DuckingSettings;
}

export interface MediaInfo {
  name: string;
  width: number;
  height: number;
  duration: number;
  size: number;
}

export interface Selection {
  start: number;
  end: number;
}

export interface AudioSample {
  t: number;
  mic: number;
  content: number;
}

export interface AssemblyMarkers {
  layoutSwitch: number;
  contentReveal: number;
  outroAt: number;
}

export interface AssemblyOptions {
  blackHold: number;
  pauseKeep: number;
  pauseCutIfOver: number;
  takeGap: number;
  stallMin: number;
  keepLastIntroTake: boolean;
  tightenPauses: boolean;
  cutStalls: boolean;
  cleanOutro: boolean;
  dropFalseStarts: boolean;
  scanRate: number;
}

export interface AssemblyTake {
  start: number;
  end: number;
  keep: boolean;
}

export interface AssemblyReport {
  contentOnset: number | null;
  contentEnd: number | null;
  markers: AssemblyMarkers;
  introTakes: AssemblyTake[];
  outroTakes: AssemblyTake[];
  stalls: { start: number; end: number; overlap: number }[];
  cuts: { start: number; end: number }[];
  notes: string[];
}
