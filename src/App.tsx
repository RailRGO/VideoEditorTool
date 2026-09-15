import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Stage from "./components/Stage";
import Timeline from "./components/Timeline";
import AutoCut from "./components/AutoCut";
import PolishPanel from "./components/Polish";
import RetouchPanel from "./components/RetouchPanel";
import CloakPanel from "./components/Cloak";
import SegmentsPanel from "./components/Segments";
import { AudioPanel, ClaimsPanel, ExportPanel, LayoutPanel, VideoPanel } from "./components/Panels";
import { Btn, LiveText } from "./components/ui";
import { AudioEngine } from "./lib/audio";
import { FaceTracker, type TrackStatus } from "./lib/face";
import {
  ProxyError,
  RemoteClient,
  sleep,
  type RemoteJob,
  type RemoteSource,
  type RemoteState,
} from "./lib/remote";
import {
  applyRetouch,
  fitRect,
  poseFromBox,
  poseFromLandmarks,
  type FacePose,
} from "./lib/retouch";
import type { RetouchHook, SrcRect } from "./lib/render";
import { buildEnvelope, detectSpeech, type Detection, type Envelope } from "./lib/analyze";
import {
  buildPassthroughScene,
  buildScene,
  cardImageEpoch,
  contentPicture,
  pickRecorderMime,
  renderScene,
  setStickerResolver,
  sourceHalves,
} from "./lib/render";
import {
  analyseDisruptions,
  findContentStart,
  findRepeats,
} from "./lib/disrupt";
import type { Region } from "./lib/analyze";
import {
  approxAlign,
  applyDisrupt,
  applyPolish,
  buildSkeleton,
  findFillers,
  findLongPauses,
  findWordRepeats,
  mergeRegions,
  parseTranscript,
  regionsTotal,
  type FillerHit,
  type Transcript,
} from "./lib/polish";
import { buildTranscriptCut } from "./lib/transcriptCut";
import { buildFairUseLimit, defaultFairUse, type FairUseOptions } from "./lib/fairUseCut";
import {
  activeSegment,
  buildCut,
  buildEDL,
  carve,
  clamp,
  fmtTime,
  normalize,
  outDuration,
  outToSrc,
  parseClaims,
  parseEDL,
  removedDuration,
  removeSegment,
  savedBySpeed,
  sameSegs,
  segSpeed,
  splitAt,
  srcToOut,
  uid,
} from "./lib/timeline";
import {
  defaultAudio,
  defaultAudioCloak,
  defaultCut,
  defaultDisrupt,
  defaultLead,
  defaultLayout,
  defaultPolish,
  defaultRetouch,
  defaultSticker,
  defaultTranscriptCut,
  defaultVideoCloak,
  SEGMENT_META,
  TARGET_META,
  type AudioCloak,
  type AudioState,
  type Claim,
  type CutOptions,
  type DisruptRules,
  type LayoutState,
  type LeadConfig,
  type PolishRules,
  type Rect,
  type Retouch,
  type Segment,
  type SegmentType,
  type Sticker,
  type Target,
  type TranscriptCutOptions,
  type VideoCloak,
} from "./lib/types";
import { cn } from "./utils/cn";

type SceneMode = "body" | "solo" | "cut" | "fast" | "card" | "lead";

/** intro / reaction / outro starting point — the two solo parts are left whole. */
function defaultSegments(d: number): Segment[] {
  const intro = Math.min(8, d * 0.03);
  const outro = Math.min(12, d * 0.04);
  const bodyEnd = Math.max(intro, d - outro);
  return normalize(
    [
      { id: uid(), type: "intro", start: 0, end: intro },
      { id: uid(), type: "body", start: intro, end: bodyEnd },
      { id: uid(), type: "outro", start: bodyEnd, end: d },
    ],
    d
  );
}

/** CapCut-style side rails. Left = workflow tools, right = inspector. */
const LEFT_TABS: Record<Target, { id: string; label: string }[]> = {
  patreon: [
    { id: "polish", label: "Polish" },
    { id: "claims", label: "Claims" },
  ],
  youtube: [
    { id: "autocut", label: "Auto-cut" },
    { id: "claims", label: "Claims" },
  ],
};

const RIGHT_TABS: Record<Target, { id: string; label: string }[]> = {
  patreon: [
    { id: "layout", label: "Layout" },
    { id: "retouch", label: "Retouch" },
    { id: "audio", label: "Audio" },
    { id: "timeline", label: "Timeline" },
    { id: "export", label: "Render" },
  ],
  youtube: [
    { id: "video", label: "Video" },
    { id: "cloak", label: "Cloak" },
    { id: "audio", label: "Audio" },
    { id: "timeline", label: "Timeline" },
    { id: "export", label: "Render" },
  ],
};

const AUTOSAVE_KEY = "reaction-studio:autosave:v1";
/** ?backend=<tunnel url> — kept in the address bar so a refresh reconnects */
const BACKEND_PARAM = "backend";

export default function App() {
  /* ---------------------------------------------------------------- refs */
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const exportRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const objectUrl = useRef<string | null>(null);
  const timeRef = useRef({ src: 0, out: 0 });
  const fileNameRef = useRef("");
  const lastProgress = useRef(0);
  const lastFastDb = useRef(0);
  const trackStatusRef = useRef<TrackStatus>("idle");
  const trackFpsRef = useRef(0);
  /** frame budget: last draw time + references of everything the canvas shows,
   * so we skip redraws while idle but never miss a paused edit */
  const lastDrawRef = useRef({
    at: 0,
    t: -1,
    segs: null as Segment[] | null,
    layout: null as LayoutState | null,
    cloak: null as VideoCloak | null,
    retouch: null as Retouch | null,
    sticker: null as Sticker | null,
    face: false,
    img: -1,
  });
  /** when the proxy transcode made its first measurable progress */
  const proxyStartRef = useRef(0);
  /** play was pressed before the file's metadata arrived — start when it does */
  const pendingPlay = useRef(false);
  /** a new source is loading: don't autosave the outgoing one over it */
  const loadingSource = useRef(false);
  /** playback watchdog: last src time we saw move, and how many nudges we gave */
  const stallRef = useRef({ at: 0, t: -1, nudges: 0 });
  /** always-fresh autosave writer (assigned every render) */
  const writeAutosaveRef = useRef<() => void>(() => {});

  const engine = () => (engineRef.current ??= new AudioEngine());

  /* --------------------------------------------------------------- state */
  const [fileName, setFileName] = useState("");
  const [lastAutosaveInfo, setLastAutosaveInfo] = useState<{
    savedAt: string;
    sourceFile: string;
    segmentCount: number;
  } | null>(null);
  /** why the last autosave was not a plain success (storage full, …) */
  const [autosaveNote, setAutosaveNote] = useState("");
  /** why the preview could not start — shown over the stage, never silent */
  const [playNote, setPlayNote] = useState("");
  const [duration, setDuration] = useState(0);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [segments, setSegments] = useState<Segment[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [raw, setRaw] = useState("");
  const [timeBase, setTimeBase] = useState<"source" | "render">("source");
  const [layout, setLayout] = useState<LayoutState>(defaultLayout);
  const [audio, setAudio] = useState<AudioState>(defaultAudio);
  const [cutOpts, setCutOpts] = useState<CutOptions>(defaultCut);
  const [transcriptCutOpts, setTranscriptCutOpts] = useState<TranscriptCutOptions>(defaultTranscriptCut);
  const [fairUseOpts, setFairUseOpts] = useState<FairUseOptions>(defaultFairUse);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState("polish");
  const [rightTab, setRightTab] = useState("layout");
  const [editLayer, setEditLayer] = useState<"content" | "cam">("cam");
  const [showGuides, setShowGuides] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rate, setRate] = useState(1);
  const [res, setRes] = useState<720 | 1080>(1080);
  const [fps, setFps] = useState<24 | 30 | 60>(30);
  const [bitrate, setBitrate] = useState(8);
  /** seconds of programme per server part — 0 = automatic (short = 1 pass) */
  const [partTarget, setPartTarget] = useState(0);
  /** Patreon master: also publish content-only + mic-only audio tracks */
  const [stems, setStems] = useState(true);
  const [audioFadeMs, setAudioFadeMs] = useState(80);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ url: string; size: number } | null>(null);
  const [mime] = useState(() => pickRecorderMime());
  const [browserOk] = useState(() => {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return !!Ctor && typeof Ctor.prototype.createScriptProcessor === "function";
  });

  /* remote engine (Colab backend) */
  const [engineMode, setEngineMode] = useState<"local" | "remote">("local");
  const [remoteDraft, setRemoteDraft] = useState(
    () => localStorage.getItem("remoteUrl") ?? ""
  );
  const [remote, setRemote] = useState<RemoteClient | null>(null);
  const [remoteInfo, setRemoteInfo] = useState<RemoteState | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [sources, setSources] = useState<RemoteSource[]>([]);
  const [proxyProgress, setProxyProgress] = useState(0);
  const [proxyEta, setProxyEta] = useState(0);
  /** the proxy build failed but the connection is fine — a retry is offered */
  const [proxyFailed, setProxyFailed] = useState(false);
  const [remoteJob, setRemoteJob] = useState<RemoteJob | null>(null);
  /** which audio bus the remote preview element is playing */
  const [previewBus, setPreviewBus] = useState<"mix" | "mic" | "content">("mix");
  const busSwitchRef = useRef<{ time: number } | null>(null);
  const connectToken = useRef(0);
  const remoteRef = useRef<RemoteClient | null>(null);
  remoteRef.current = remote;
  const isRemote = engineMode === "remote";

  /* auto-cut */
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanSpeed, setScanSpeed] = useState(4);
  const [env, setEnv] = useState<Envelope | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [sceneMode, setSceneMode] = useState<SceneMode>("body");

  /* polish */
  const [target, setTarget] = useState<Target>("patreon");
  const [audioCloak, setAudioCloak] = useState<AudioCloak>(defaultAudioCloak);
  const [videoCloak, setVideoCloak] = useState<VideoCloak>(defaultVideoCloak);
  const [sticker, setSticker] = useState<Sticker>(defaultSticker);
  const [scanChannel, setScanChannel] = useState<"mic" | "content">("mic");
  const [micEnv, setMicEnv] = useState<Envelope | null>(null);
  const [contentEnv, setContentEnv] = useState<Envelope | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [trBusy, setTrBusy] = useState(false);
  const [trProgress, setTrProgress] = useState(0);
  const [trLang, setTrLang] = useState("auto");
  const [trError, setTrError] = useState("");
  const trToken = useRef(0);
  const [polish, setPolish] = useState<PolishRules>(defaultPolish);
  const [disruptRules, setDisruptRules] = useState<DisruptRules>(defaultDisrupt);
  const [leadCfg, setLeadCfg] = useState<LeadConfig>(defaultLead);
  const polishRef = useRef(polish);
  const disruptRef = useRef(disruptRules);
  polishRef.current = polish;
  disruptRef.current = disruptRules;
  const targetRef = useRef<Target>("patreon");
  targetRef.current = target;
  const audioCloakRef = useRef(audioCloak);
  audioCloakRef.current = audioCloak;
  const videoCloakRef = useRef(videoCloak);
  videoCloakRef.current = videoCloak;
  const stickerRef = useRef(sticker);
  stickerRef.current = sticker;

  /* retouch */
  const [retouch, setRetouch] = useState<Retouch>(defaultRetouch);
  const [showFaceBox, setShowFaceBox] = useState(false);
  const [trackStatus, setTrackStatus] = useState<TrackStatus>("idle");
  const [trackError, setTrackError] = useState("");
  const [trackFps, setTrackFps] = useState(0);
  const trackerRef = useRef<FaceTracker | null>(null);
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const skinScratchRef = useRef<HTMLCanvasElement | null>(null);
  const poseRef = useRef<FacePose | null>(null);
  const faceLmRef = useRef<{ x: number; y: number }[] | null>(null);
  const retouchRef = useRef(retouch);
  retouchRef.current = retouch;
  const showFaceBoxRef = useRef(showFaceBox);
  showFaceBoxRef.current = showFaceBox;

  /* live mirrors for the animation loop */
  const segsRef = useRef(segments);
  const layoutRef = useRef(layout);
  const audioRef = useRef(audio);
  const cutRef = useRef(cutOpts);
  const durRef = useRef(duration);
  const rateRef = useRef(rate);
  const scanSpeedRef = useRef(scanSpeed);
  const scanningRef = useRef(false);
  const exportingRef = useRef(false);
  const playingRef = useRef(false);
  const sceneModeRef = useRef<SceneMode>("body");
  segsRef.current = segments;
  layoutRef.current = layout;
  audioRef.current = audio;
  cutRef.current = cutOpts;
  durRef.current = duration;
  rateRef.current = rate;
  scanSpeedRef.current = scanSpeed;
  playingRef.current = playing;

  /* ---------------------------------------- undo / redo (whole project) */
  /** Everything the editor can change — one snapshot per undo step. */
  interface EditState {
    segments: Segment[];
    layout: LayoutState;
    audio: AudioState;
    retouch: Retouch;
    audioCloak: AudioCloak;
    videoCloak: VideoCloak;
    sticker: Sticker;
    cutOpts: CutOptions;
    transcriptCutOpts: TranscriptCutOptions;
    fairUseOpts: FairUseOptions;
    polish: PolishRules;
    disruptRules: DisruptRules;
    leadCfg: LeadConfig;
    res: 720 | 1080;
    fps: 24 | 30 | 60;
  }
  const snapshotEdit = (s: EditState): EditState => ({
    ...s,
    segments: s.segments.map((x) => ({ ...x })),
  });
  const editStateEq = (a: EditState, b: EditState) =>
    sameSegs(a.segments, b.segments) &&
    a.layout === b.layout &&
    a.audio === b.audio &&
    a.retouch === b.retouch &&
    a.audioCloak === b.audioCloak &&
    a.videoCloak === b.videoCloak &&
    a.sticker === b.sticker &&
    a.cutOpts === b.cutOpts &&
    a.transcriptCutOpts === b.transcriptCutOpts &&
    a.fairUseOpts === b.fairUseOpts &&
    a.polish === b.polish &&
    a.disruptRules === b.disruptRules &&
    a.leadCfg === b.leadCfg &&
    a.res === b.res &&
    a.fps === b.fps;

  const editStateRef = useRef<EditState>({
    segments, layout, audio, retouch, audioCloak, videoCloak, sticker,
    cutOpts, transcriptCutOpts, fairUseOpts, polish, disruptRules, leadCfg, res, fps,
  });
  editStateRef.current = {
    segments, layout, audio, retouch, audioCloak, videoCloak, sticker,
    cutOpts, transcriptCutOpts, fairUseOpts, polish, disruptRules, leadCfg, res, fps,
  };

  const pastRef = useRef<EditState[]>([]);
  const futureRef = useRef<EditState[]>([]);
  const txnRef = useRef<EditState | null>(null);
  const lastGroupRef = useRef<{ key: string; at: number } | null>(null);
  const [histTick, setHistTick] = useState(0);
  const bumpHist = () => setHistTick((v) => v + 1);

  const pushSnap = useCallback((snap: EditState) => {
    pastRef.current.push(snap);
    if (pastRef.current.length > 150) pastRef.current.shift();
    futureRef.current = [];
    bumpHist();
  }, []);

  /**
   * Record the pre-edit state. Continuous controls (sliders, box drags) are
   * grouped: changes to the same group within 600 ms share one undo step.
   */
  const recordHistory = useCallback(
    (group: string, force = false) => {
      const now = Date.now();
      const lg = lastGroupRef.current;
      if (!force && lg && lg.key === group && now - lg.at < 600) {
        lg.at = now;
        return;
      }
      lastGroupRef.current = { key: group, at: now };
      const prev = pastRef.current[pastRef.current.length - 1];
      if (prev && editStateEq(prev, editStateRef.current)) return;
      pushSnap(snapshotEdit(editStateRef.current));
    },
    [pushSnap]
  );

  /** Apply one piece of the edit state as a (possibly undoable) update. */
  const patchState = useCallback(
    <K extends keyof EditState>(
      key: K,
      group: string,
      next: EditState[K],
      force = false
    ) => {
      recordHistory(group, force);
      switch (key) {
        case "segments": setSegments(next as Segment[]); break;
        case "layout": setLayout(next as LayoutState); break;
        case "audio": setAudio(next as AudioState); break;
        case "retouch": setRetouch(next as Retouch); break;
        case "audioCloak": setAudioCloak(next as AudioCloak); break;
        case "videoCloak": setVideoCloak(next as VideoCloak); break;
        case "sticker": setSticker(next as Sticker); break;
        case "cutOpts": setCutOpts(next as CutOptions); break;
        case "transcriptCutOpts": setTranscriptCutOpts(next as TranscriptCutOptions); break;
        case "fairUseOpts": setFairUseOpts(next as FairUseOptions); break;
        case "polish": setPolish(next as PolishRules); break;
        case "disruptRules": setDisruptRules(next as DisruptRules); break;
        case "leadCfg": setLeadCfg(next as LeadConfig); break;
        case "res": setRes(next as 720 | 1080); break;
        case "fps": setFps(next as 24 | 30 | 60); break;
      }
    },
    [recordHistory]
  );

  /**
   * History-aware setter factories: panels keep using Dispatch-style
   * setters, every change is grouped + undoable behind the scenes.
   */
  const makeSetter = useCallback(
    <K extends keyof EditState>(
      key: K,
      group: string
    ): React.Dispatch<React.SetStateAction<EditState[K]>> =>
      (u) => {
        const cur = editStateRef.current[key];
        const next =
          typeof u === "function"
            ? (u as (p: EditState[K]) => EditState[K])(cur)
            : u;
        if (next === cur) return;
        patchState(key, group, next);
      },
    [patchState]
  );
  const setLayoutH = useMemo(() => makeSetter("layout", "layout"), [makeSetter]);
  const setAudioH = useMemo(() => makeSetter("audio", "audio"), [makeSetter]);
  const setRetouchH = useMemo(() => makeSetter("retouch", "retouch"), [makeSetter]);
  const setAudioCloakH = useMemo(
    () => makeSetter("audioCloak", "audioCloak"),
    [makeSetter]
  );
  const setVideoCloakH = useMemo(
    () => makeSetter("videoCloak", "videoCloak"),
    [makeSetter]
  );
  const setStickerH = useMemo(
    () => makeSetter("sticker", "sticker"),
    [makeSetter]
  );
  const setCutOptsH = useMemo(() => makeSetter("cutOpts", "cutOpts"), [makeSetter]);
  const setTranscriptCutOptsH = useMemo(() => makeSetter("transcriptCutOpts", "transcriptCut"), [makeSetter]);
  const setFairUseOptsH = useMemo(() => makeSetter("fairUseOpts", "fairUse"), [makeSetter]);
  const setPolishH = useMemo(() => makeSetter("polish", "polish"), [makeSetter]);
  const setDisruptH = useMemo(
    () => makeSetter("disruptRules", "disruptRules"),
    [makeSetter]
  );
  const setLeadH = useMemo(() => makeSetter("leadCfg", "leadCfg"), [makeSetter]);
  const setResH = useMemo(() => makeSetter("res", "render"), [makeSetter]);
  const setFpsH = useMemo(() => makeSetter("fps", "render"), [makeSetter]);

  /** Apply a new segment list as one undoable step (no-op if identical). */
  const withTxn = useCallback(
    (next: Segment[]) => {
      const cur = editStateRef.current;
      if (sameSegs(cur.segments, next)) return;
      recordHistory("segments", true);
      setSegments(next);
    },
    [recordHistory]
  );

  /** Continuous gesture (drag): snapshot once at start, commit at the end. */
  const editStart = useCallback(() => {
    txnRef.current = snapshotEdit(editStateRef.current);
    lastGroupRef.current = null;
  }, []);
  const editEnd = useCallback(() => {
    const before = txnRef.current;
    txnRef.current = null;
    if (before && !editStateEq(before, editStateRef.current)) pushSnap(before);
  }, [pushSnap]);

  const clearHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    txnRef.current = null;
    lastGroupRef.current = null;
    bumpHist();
  }, []);

  const applyEditState = useCallback((st: EditState) => {
    setSegments(st.segments.map((x) => ({ ...x })));
    setLayout(st.layout);
    setAudio(st.audio);
    setRetouch(st.retouch);
    setAudioCloak(st.audioCloak);
    setVideoCloak(st.videoCloak);
    setSticker(st.sticker ?? defaultSticker);
    setCutOpts(st.cutOpts);
    setTranscriptCutOpts(st.transcriptCutOpts);
    setFairUseOpts(st.fairUseOpts);
    setPolish(st.polish);
    setDisruptRules(st.disruptRules);
    setLeadCfg(st.leadCfg);
    setRes(st.res);
    setFps(st.fps);
  }, []);

  const undo = useCallback(() => {
    const p = pastRef.current;
    if (!p.length) return;
    const prev = p.pop()!;
    futureRef.current.push(snapshotEdit(editStateRef.current));
    applyEditState(prev);
    bumpHist();
  }, [applyEditState]);
  const redo = useCallback(() => {
    const f = futureRef.current;
    if (!f.length) return;
    const next = f.pop()!;
    pastRef.current.push(snapshotEdit(editStateRef.current));
    applyEditState(next);
    bumpHist();
  }, [applyEditState]);
  void histTick;

  /**
   * Renders the camera into a work canvas at layer resolution, then runs the
   * beauty stack on it. Keeping this at layer size (not 1080p) is what makes
   * the per-pixel warps affordable in real time.
   */
  const retouchHook: RetouchHook = useMemo(
    () => ({
      debugPose: null,
      prepare: (
        video: HTMLVideoElement,
        src: SrcRect,
        w: number,
        h: number,
        style: { fit: "cover" | "contain"; zoom: number; offsetX: number; offsetY: number }
      ) => {
        const cfg = retouchRef.current;
        if (!cfg.enabled) return null;
        if (!workRef.current) workRef.current = document.createElement("canvas");
        const cv = workRef.current;
        if (cv.width !== w || cv.height !== h) {
          cv.width = w;
          cv.height = h;
        }
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#04060c";
        ctx.fillRect(0, 0, w, h);
        // draw the camera half, applying the layer's own fit / zoom / offset
        const t = fitRect(src, 0, 0, w, h, style);
        try {
          ctx.drawImage(video, t.sx, t.sy, t.sw, t.sh, t.zx, t.zy, t.zw, t.zh);
        } catch {
          return null;
        }

        const lm = faceLmRef.current;
        let pose: FacePose | null = null;
        if (cfg.manual) {
          pose = poseFromBox(cfg.manualRect, { w, h });
        } else if (lm && lm.length > 400) {
          pose = poseFromLandmarks(lm, src, t);
        }
        poseRef.current = pose;
        if (!pose) return cv;

        if (!skinScratchRef.current) skinScratchRef.current = document.createElement("canvas");
        applyRetouch(ctx, skinScratchRef.current, pose, cfg);
        return cv;
      },
    }),
    []
  );

  const fast = layout.fastSpeed;
  const outDur = outDuration(segments, fast);
  const removed = removedDuration(segments);
  const spedUp = savedBySpeed(segments, fast);
  const selected = useMemo(
    () => segments.find((s) => s.id === selectedId) ?? null,
    [segments, selectedId]
  );
  const introOutro = useMemo(
    () =>
      segments
        .filter((s) => s.type === "intro" || s.type === "outro")
        .map((s) => ({ start: s.start, end: s.end })),
    [segments]
  );
  const bodySpan = useMemo(() => {
    const b = segments.filter((s) => s.type === "body" || s.type === "lead");
    return {
      start: b.length ? b[0].start : 0,
      end: b.length ? b[b.length - 1].end : duration,
    };
  }, [segments, duration]);

  /** level waveforms for the timeline's audio lanes (after a scan) */
  const timelineWaves = useMemo(() => {
    if (target === "youtube") {
      return env ? [{ lane: "full" as const, env, label: "mixed audio" }] : [];
    }
    const w: { lane: "top" | "bottom"; env: Envelope; label: string }[] = [];
    if (micEnv) w.push({ lane: "top", env: micEnv, label: "mic · comp/limiter" });
    if (contentEnv) w.push({ lane: "bottom", env: contentEnv, label: "content · auto-duck" });
    return w;
  }, [target, env, micEnv, contentEnv]);

  const isYT = target === "youtube";
  const aspect = dims.w > 0 && dims.h > 0 ? dims.w / dims.h : 0;
  const mismatchWide = isYT && aspect > 1.9;
  const mismatchNarrow = !isYT && aspect > 0 && aspect <= 1.9;

  /* ------------------------------------------------------ polish analysis */
  const reactionStart = useMemo(
    () => (contentEnv ? findContentStart(contentEnv, 2) : null),
    [contentEnv]
  );

  const disruptions = useMemo(() => {
    if (!contentEnv || bodySpan.end - bodySpan.start < 2) return null;
    return analyseDisruptions(contentEnv, bodySpan, disruptRules);
  }, [contentEnv, bodySpan, disruptRules]);

  const fillers = useMemo<FillerHit[]>(() => {
    if (!transcript?.timed) return [];
    const words = transcript.words.filter((w) =>
      introOutro.some((s) => w.end > s.start && w.start < s.end)
    );
    return [...findFillers(words, polish), ...findWordRepeats(words)];
  }, [transcript, introOutro, polish]);

  /** per-repeat choice: which occurrence of a repeated take stays ("a" = 1st) */
  const [takeKeeps, setTakeKeeps] = useState<Record<string, "a" | "b">>({});

  /** Mic repeats: long ones are extra takes (you pick the survivor), short ones are stumbles. */
  const micRepeats = useMemo(() => {
    if (!micEnv)
      return {
        takes: [] as { key: string; first: Region; second: Region }[],
        stutters: [] as Region[],
      };
    const all = findRepeats(micEnv, {
      minRepeat: polish.minRepeat,
      minSeparation: 0.3,
      trimDeadAir: false,
      deadAir: 999,
      keepDead: 0,
    });
    const inSolo = (r: Region) =>
      introOutro.some((s) => r.start >= s.start - 0.2 && r.end <= s.end + 0.2);
    const takes: { key: string; first: Region; second: Region }[] = [];
    const seen = new Set<string>();
    for (const r of all) {
      if (
        r.len >= polish.minTake &&
        r.b - (r.a + r.len) >= polish.takeGap &&
        inSolo({ start: r.a, end: r.b })
      ) {
        const key = `${r.a.toFixed(2)}:${r.b.toFixed(2)}`;
        if (!seen.has(key)) {
          seen.add(key);
          takes.push({
            key,
            first: { start: r.a, end: r.a + r.len },
            second: { start: r.b, end: r.b + r.len },
          });
        }
      }
    }
    const stutters = all
      .filter((r) => r.len < polish.minTake || r.b - (r.a + r.len) < polish.takeGap)
      .map((r) => ({ start: r.a + r.len, end: r.b }))
      .filter(inSolo);
    return { takes, stutters: mergeRegions(stutters) };
  }, [micEnv, polish, introOutro]);

  const polishDrops = useMemo(() => {
    const list: Region[] = [...micRepeats.stutters];
    for (const t of micRepeats.takes) {
      // default keeps the LAST take (the usual one); "a" keeps the first
      list.push(
        (takeKeeps[t.key] ?? "b") === "b"
          ? { start: t.first.start, end: t.second.start }
          : { start: t.second.start, end: t.second.end }
      );
    }
    const words = transcript?.words ?? [];
    for (const span of introOutro) {
      list.push(...findLongPauses(words, span, polish));
      if (transcript?.timed) {
        for (const f of fillers) {
          if (f.end > span.start && f.start < span.end) {
            list.push({ start: f.start, end: f.end });
          }
        }
      }
    }
    return mergeRegions(list).filter((r) => r.end - r.start > 0.08);
  }, [micRepeats, takeKeeps, transcript, introOutro, polish, fillers]);

  const polishSavings = useMemo(
    () => regionsTotal(polishDrops) + (disruptions?.wasted ?? 0),
    [polishDrops, disruptions]
  );

  useEffect(() => {
    const cv = previewRef.current;
    if (cv) {
      cv.width = 1280;
      cv.height = 720;
    }
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Record<string, unknown>;
        if (p.app === "reaction-studio" && typeof p.savedAt === "string") {
          setLastAutosaveInfo({
            savedAt: p.savedAt,
            sourceFile: String(p.sourceFile || "Untitled"),
            segmentCount: Array.isArray(p.segments) ? p.segments.length : 0,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    engine().update(audio);
  }, [audio]);

  useEffect(() => {
    engine().setMicChannel(audio.mic.channel);
  }, [audio.mic.channel]);

  useEffect(() => {
    engine().updateCloak(audioCloak);
  }, [audioCloak]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && !scanningRef.current) v.playbackRate = rate;
  }, [rate]);

  /** re-run detection whenever the tuning changes */
  useEffect(() => {
    if (env) setDetection(detectSpeech(env, cutOpts));
  }, [env, cutOpts]);

  /* ------------------------------------------------------------- actions */
  const seekSrc = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = clamp(t, 0, Math.max(0, durRef.current - 0.001));
    timeRef.current.src = v.currentTime;
    timeRef.current.out = srcToOut(segsRef.current, v.currentTime, layoutRef.current.fastSpeed);
  }, []);

  /**
   * Build the audio graph on a real user gesture.
   *
   * This used to happen in `onLoadedMetadata`, which is *not* a gesture, so
   * the AudioContext was born suspended — and a media element wired into a
   * suspended context is held back by the browser: `play()` resolved, the
   * button flipped to pause, and the picture never moved. Creating it here
   * (first play / scan / render — all clicks or key presses) starts it
   * running, and `unlock()` below guarantees it before we ask to play.
   */
  const ensureAudio = useCallback((v: HTMLVideoElement) => {
    const eng = engine();
    const had = eng.ready;
    try {
      // fail-safe: a graph that cannot be built hands the element its own
      // audio back instead of dragging `play()` into an exception
      eng.attach(v, audioRef.current.mic.channel);
    } catch {
      /* attach never throws — this is belt and braces */
    }
    if (!had && eng.ready) {
      eng.setDirect(targetRef.current === "youtube" || !!remoteRef.current);
      eng.update(audioRef.current);
      eng.updateCloak(audioCloakRef.current);
    }
    eng.resume();
    return eng;
  }, []);

  /** Resolve when a pending seek settles — a seek in flight aborts play(). */
  const waitSeek = useCallback((v: HTMLVideoElement) => {
    if (!v.seeking) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        v.removeEventListener("seeked", done);
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, 1500);
      v.addEventListener("seeked", done);
    });
  }, []);

  /**
   * Ask the preview element to play, working around the three ways browsers
   * refuse: a suspended AudioContext, a seek still in flight, and the
   * not-allowed-by-autoplay-policy rejection. Returns false only when the
   * picture genuinely cannot move; `playNote` then says why.
   */
  const startPlayback = useCallback(
    async (v: HTMLVideoElement): Promise<boolean> => {
      // The audio graph must never be able to stop the picture: if it cannot
      // be built the element keeps its own audio and we say so, but play()
      // still happens.
      let eng: AudioEngine | null = null;
      try {
        eng = ensureAudio(v);
        await eng.unlock();
      } catch {
        eng = null;
      }
      const audioNote = eng && !eng.ready ? eng.error : "";
      await waitSeek(v);
      try {
        await v.play();
        setPlayNote(audioNote);
        return true;
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "Error";
        if (name === "AbortError") {
          // a seek landed on top of us — one more go is almost always enough
          try {
            await v.play();
            setPlayNote(audioNote);
            return true;
          } catch (e2) {
            setPlayNote(
              `Playback was interrupted (${
                e2 instanceof DOMException ? e2.name : "error"
              }). Press play again.`
            );
            return false;
          }
        }
        // last resort: give the element its own audio back and try again
        try {
          eng?.detach();
        } catch {
          /* nothing left to detach */
        }
        try {
          await v.play();
          setPlayNote(
            "Playing without the audio mix — the browser blocked the audio graph. Reload the page to get it back."
          );
          return true;
        } catch {
          /* fall through to the message below */
        }
        setPlayNote(
          name === "NotAllowedError"
            ? "The browser blocked playback — press play once more (it nearly always works on the second press)."
            : `Playback could not start (${name}). Check the preview file and press play again.`
        );
        return false;
      }
    },
    [ensureAudio, waitSeek]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || scanningRef.current) return;
    const vd = Number.isFinite(v.duration) ? v.duration : 0;
    const d = durRef.current || vd || 0;
    if (!d) {
      // metadata hasn't landed yet — remember the request and start on arrival
      pendingPlay.current = true;
      setPlayNote("Waiting for the video…");
      return;
    }
    if (durRef.current <= 0 && d > 0) {
      durRef.current = d;
      setDuration(d);
    }
    setPlayNote("");
    if (v.paused || v.ended) {
      // parked at the very end, or inside a cut that runs to it: start over
      // instead of playing one frame and stopping
      const tail = activeSegment(segsRef.current, v.currentTime);
      const stuck = v.ended || v.currentTime >= d - 0.05 ||
        (!!tail && tail.type === "cut" && v.currentTime >= tail.end - 0.05);
      if (stuck) {
        v.currentTime = 0;
        timeRef.current.src = 0;
        timeRef.current.out = 0;
      }
      stallRef.current = { at: 0, t: -1, nudges: 0 };
      void startPlayback(v).then((ok) => setPlaying(ok));
    } else {
      v.pause();
      setPlaying(false);
    }
  }, [startPlayback]);

  const finish = useCallback(() => {
    exportingRef.current = false;
    setExporting(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.playbackRate = rateRef.current;
      setPlaying(false);
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
  }, []);

  /** Patreon = raw 32:9 capture with split audio; YouTube = finished 16:9 mixed render. */
  const switchTarget = useCallback((t: Target) => {
    if (targetRef.current === t) return;
    targetRef.current = t;
    setTarget(t);
    setLayoutH((l) => ({ ...l, sourceMode: t === "patreon" ? "split" : "single" }));
    engine().setDirect(t === "youtube" || !!remoteRef.current);
    engine().update(audioRef.current, 0);
    lastFastDb.current = 0;
    setLeftTab(t === "patreon" ? "polish" : "autocut");
    setRightTab(t === "patreon" ? "layout" : "video");
  }, [setLayoutH]);

  const loadFaceModel = useCallback(() => {
    const tr = (trackerRef.current ??= new FaceTracker());
    setTrackStatus("loading");
    setTrackError("");
    void tr.load().then((ok) => {
      setTrackStatus(tr.status);
      setTrackError(tr.error);
      if (ok) {
        const v = videoRef.current;
        if (v && v.readyState >= 2) void tr.warm(v);
      }
    });
  }, []);

  /* ------------------------------------------------------- animation loop */
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const cv = previewRef.current;
      if (!v || !cv || !v.videoWidth || v.readyState < 1) return;

      const segs = segsRef.current;
      const lay = layoutRef.current;
      const yt = targetRef.current === "youtube";
      const act = activeSegment(segs, v.currentTime);

      // removed segments are never decoded, shown or exported — jump past
      // them while playing (a paused playhead may park inside a cut)
      if (!v.paused && act && act.type === "cut" && v.currentTime < act.end - 0.02) {
        v.currentTime = Math.min(act.end + 0.002, durRef.current - 0.001);
      }

      // playback speed: the scanner owns it, otherwise follow the segment type
      // (fast-forward segments and cards that carry their own speed)
      if (!scanningRef.current) {
        const segRate = act ? segSpeed(act, lay.fastSpeed) : 1;
        const want = segRate > 1 ? segRate : exportingRef.current ? 1 : rateRef.current;
        if (Math.abs(v.playbackRate - want) > 0.02) v.playbackRate = want;
        const pitch = act?.type === "fast" ? !lay.chipmunk : true;
        if (v.preservesPitch !== pitch) v.preservesPitch = pitch;
      }

      timeRef.current.src = v.currentTime;
      timeRef.current.out = srcToOut(segs, v.currentTime, lay.fastSpeed);

      // ---- frame budget -----------------------------------------------------
      // Redraw only when the picture can change (playing / scrub / an edit),
      // skip entirely while paused-idle, and cap continuous playback at
      // ~30 fps. This is what keeps the main thread free for keys and clicks.
      const now = performance.now();
      const continuous = !v.paused && !v.ended;
      const timeChanged = Math.abs(v.currentTime - lastDrawRef.current.t) > 1e-4;
      // reference compare: every edit produces a fresh object, so a paused
      // edit (split / drag / undo / polish / project load) always repaints
      const imgEpoch = cardImageEpoch();
      const editChanged =
        segs !== lastDrawRef.current.segs ||
        lay !== lastDrawRef.current.layout ||
        videoCloakRef.current !== lastDrawRef.current.cloak ||
        retouchRef.current !== lastDrawRef.current.retouch ||
        stickerRef.current !== lastDrawRef.current.sticker ||
        showFaceBoxRef.current !== lastDrawRef.current.face ||
        imgEpoch !== lastDrawRef.current.img;

      // ---- playback watchdog ---------------------------------------------
      // Some engines report `paused === false` and still refuse to advance:
      // a context that never really resumed, a tunnel that stalled, a codec
      // the browser will not decode. Instead of leaving a frozen preview,
      // escalate: nudge play(), then pull the element out of the audio graph
      // (the classic culprit) and nudge again, and only then say so out loud.
      if (!v.paused && !v.ended && !v.seeking && !scanningRef.current) {
        const st = stallRef.current;
        if (Math.abs(v.currentTime - st.t) > 1e-3) {
          st.t = v.currentTime;
          st.at = now;
          st.nudges = 0;
        } else if (st.at && now - st.at > 1500 && st.nudges === 0 && v.readyState >= 2) {
          st.nudges = 1;
          st.at = now;
          void v.play().catch(() => {});
        } else if (st.at && now - st.at > 3000 && st.nudges === 1 && v.readyState >= 2) {
          st.nudges = 2;
          st.at = now;
          // the audio graph is the usual reason a media element refuses to
          // run — hand the element its own audio and push again
          engineRef.current?.detach();
          void v.play().catch(() => {});
        } else if (st.at && now - st.at > 6000 && st.nudges === 2) {
          st.nudges = 3;
          st.at = 0;
          setPlaying(false);
          setPlayNote(
            "The preview is not moving: the stream or codec stalled. Scrub the timeline to wake it, or reconnect the backend."
          );
        }
      }
      const busy = exportingRef.current || scanningRef.current;
      const throttled =
        (continuous || busy) && !exportingRef.current && !scanningRef.current &&
        now - lastDrawRef.current.at < 33;

      if ((continuous || timeChanged || editChanged || busy) && !throttled) {
        lastDrawRef.current.at = now;
        lastDrawRef.current.t = v.currentTime;
        lastDrawRef.current.segs = segs;
        lastDrawRef.current.layout = lay;
        lastDrawRef.current.cloak = videoCloakRef.current;
        lastDrawRef.current.retouch = retouchRef.current;
        lastDrawRef.current.sticker = stickerRef.current;
        lastDrawRef.current.face = showFaceBoxRef.current;
        lastDrawRef.current.img = imgEpoch;

        if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
        const scratch = scratchRef.current;

        const halves = sourceHalves(v.videoWidth, v.videoHeight, lay.sourceMode, lay.cameraSide);

        // face tracking runs on the raw video, independent of the layout.
        // Patreon mode only — the YouTube source has no separate camera layer.
        if (!yt && retouchRef.current.enabled && !retouchRef.current.manual) {
          const tr = (trackerRef.current ??= new FaceTracker());
          const camSrc =
            lay.sourceMode === "single"
              ? { x: 0, y: 0, w: 1, h: 1 }
              : lay.cameraSide === "left"
              ? { x: 0, y: 0, w: 0.5, h: 1 }
              : { x: 0.5, y: 0, w: 0.5, h: 1 };
          faceLmRef.current = tr.update(v, retouchRef.current, camSrc);
          if (tr.status !== trackStatusRef.current) {
            trackStatusRef.current = tr.status;
            setTrackStatus(tr.status);
            setTrackError(tr.error);
          }
          if (tr.fps !== trackFpsRef.current) {
            trackFpsRef.current = tr.fps;
            setTrackFps(tr.fps);
          }
        } else {
          faceLmRef.current = null;
        }

        const scene = yt
          ? buildPassthroughScene(
              segs,
              v.currentTime,
              halves.full,
              lay.fastSpeed,
              // the card covers the content rect this file was composed with…
              lay.content,
              videoCloakRef.current,
              // …and the camera corner is restored on top of it, so the card
              // can never bury the camera even when the rects overlap
              lay.cam,
              // user overlay image — reaction spans only (preview mirrors
              // the export: intro/outro stay clean)
              stickerRef.current
            )
          : buildScene(lay, segs, v.currentTime, halves);
        // intro/outro rule for the local audio cloak: clean spans bypass the
        // whole chain and play exactly as recorded (the Colab export does the
        // same with its run-based audio graph)
        {
          const activeSeg = yt
            ? segs.find((s) => v.currentTime >= s.start && v.currentTime < s.end)
            : undefined;
          engine().setCleanSpan(activeSeg?.type ?? null);
        }
        const hook = !yt && retouchRef.current.enabled ? retouchHook : null;
        if (hook) hook.debugPose = poseRef.current;

        const ctx = cv.getContext("2d");
        if (ctx) {
          renderScene(
            ctx,
            v,
            scene,
            lay,
            cv.width,
            cv.height,
            scratch,
            0.34,
            hook,
            showFaceBoxRef.current
          );
        }

        // quieter content audio while fast-forwarding
        const fastDb = act?.type === "fast" ? lay.fastGainDb : 0;
        if (fastDb !== lastFastDb.current) {
          lastFastDb.current = fastDb;
          engine().update(audioRef.current, fastDb);
        }

        if (exportingRef.current) {
          const ec = exportRef.current;
          const ectx = ec?.getContext("2d");
          if (ec && ectx) renderScene(ectx, v, scene, lay, ec.width, ec.height, scratch, 0.4, hook);
          const total = outDuration(segs, lay.fastSpeed);
          const p = total > 0 ? clamp(timeRef.current.out / total, 0, 1) : 0;
          if (Math.abs(p - lastProgress.current) > 0.002) {
            lastProgress.current = p;
            setProgress(p);
          }
          if (total - timeRef.current.out < 0.08 || v.ended) finish();
        }

        // in YouTube mode the file is already mixed, so mute / card silence everything;
        // intro & outro keep playing (the voice is baked into the mix)
        const contentMuted = act
          ? act.type === "cut" ||
            act.type === "mute" ||
            act.type === "card" ||
            (!yt && (act.type === "intro" || act.type === "outro") && lay.muteContentInSolo)
          : false;
        engine().tick(audioRef.current, contentMuted);
        engine().read();

        const nextMode: SceneMode =
          act && (act.type === "intro" || act.type === "outro")
            ? "solo"
            : act && act.type === "cut"
            ? "cut"
            : act && act.type === "card"
            ? "card"
            : act && act.type === "lead"
            ? "lead"
            : act && act.type === "fast"
            ? "fast"
            : "body";
        if (nextMode !== sceneModeRef.current) {
          sceneModeRef.current = nextMode;
          setSceneMode(nextMode);
        }
      }

      if (scanningRef.current) {
        const p = durRef.current > 0 ? clamp(v.currentTime / durRef.current, 0, 1) : 0;
        setScanProgress(p);
        if (v.ended || v.currentTime >= durRef.current - 0.05) stopScanRef.current();
      }

      if (v.ended && !exportingRef.current && !scanningRef.current) setPlaying(false);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [finish, retouchHook]);

  /* ------------------------------------------------------------ keyboard */
  const doSplit = useCallback(() => {
    withTxn(normalize(splitAt(segsRef.current, timeRef.current.src), durRef.current));
  }, [withTxn]);

  const doDelete = useCallback(() => {
    if (!selectedId) return;
    withTxn(normalize(removeSegment(segsRef.current, selectedId), durRef.current));
    setSelectedId(null);
  }, [selectedId, withTxn]);

  /** Turn a marked timeline range into a segment of `type` (cut / intro / …). */
  const applyRange = useCallback(
    (a: number, b: number, type: SegmentType) => {
      const s0 = Math.min(a, b);
      const s1 = Math.max(a, b);
      if (s1 - s0 < 0.05 || !durRef.current) return;
      const next = normalize(carve(segsRef.current, s0, s1, type), durRef.current);
      withTxn(next);
      const mid = (s0 + s1) / 2;
      const seg = next.find((x) => mid >= x.start && mid < x.end);
      setSelectedId(seg ? seg.id : null);
    },
    [withTxn]
  );

  /** Jump the playhead to the previous (dir<0) / next (dir>0) segment border. */
  const jumpBoundary = useCallback(
    (dir: 1 | -1) => {
      const t = timeRef.current.src;
      const bounds = Array.from(
        new Set(segsRef.current.flatMap((s) => [s.start, s.end]))
      ).sort((a, b) => a - b);
      const target =
        dir > 0
          ? bounds.find((b) => b > t + 0.02)
          : [...bounds].reverse().find((b) => b < t - 0.02);
      if (target != null) seekSrc(target);
    },
    [seekSrc]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.code === "Space" || e.key === " " || e.keyCode === 32) {
        e.preventDefault();
        if (e.repeat) return;
        // Space on a focused <button> would also fire that button's native
        // Space-click on keyup — blur it so the toggle doesn't fire twice
        const btn = t?.closest?.("button") as HTMLElement | null;
        if (btn) btn.blur();
        togglePlay();
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        seekSrc(timeRef.current.src - 10);
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        seekSrc(timeRef.current.src + 10);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
      } else if (e.key === "s" || e.key === "S") {
        doSplit();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        doDelete();
      } else if (e.key === ",") {
        e.preventDefault();
        jumpBoundary(-1);
      } else if (e.key === ".") {
        e.preventDefault();
        jumpBoundary(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekSrc(timeRef.current.src - (e.shiftKey ? 1 : 1 / 30));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekSrc(timeRef.current.src + (e.shiftKey ? 1 : 1 / 30));
      } else if (e.key === "Home") {
        seekSrc(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, doSplit, doDelete, seekSrc, jumpBoundary, undo, redo]);

  /* ------------------------------------------------------------ file load */
  const loadFile = useCallback((f: File) => {
    const v = videoRef.current;
    if (!v) return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(f);
    objectUrl.current = url;
    fileNameRef.current = f.name;
    setFileName(f.name);
    setResult(null);
    setEnv(null);
    setDetection(null);
    setPlaying(false);
    setPlayNote("");
    // the transcript is deliberately NOT cleared here: opening the same file
    // again keeps the words (onMeta drops them when the file really differs),
    // and autosave is held off until this source's metadata has landed
    loadingSource.current = true;
    v.removeAttribute("crossOrigin");
    v.src = url;
    v.muted = false;
    v.volume = 1;
    v.playbackRate = 1;
    v.load();
  }, []);

  const onMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const d = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
    if (d > 0) {
      setDuration(d);
      durRef.current = d;
    }
    setDims({ w: v.videoWidth, h: v.videoHeight });
    if (!d) {
      // No length in the header (a MediaRecorder blob, an MP4 written without
      // faststart, a stream Chrome only measures by scanning): nudge the
      // element once to the very end — `durationchange` then reports the real
      // number — instead of sitting on "Waiting for the video…" forever.
      try {
        if (v.seekable.length > 0) v.currentTime = 1e101;
      } catch {
        /* not seekable — nothing to force */
      }
    }
    const asp = v.videoWidth / Math.max(1, v.videoHeight);
    if (targetRef.current === "patreon") {
      setLayoutH((l) => ({ ...l, sourceMode: asp > 1.9 ? "split" : "single" }));
    }
    // keep a loaded project (clamped to this file), default only when fresh
    setSegments((s) => (s.length ? normalize(s, d) : defaultSegments(d)));
    clearHistory();
    setSelectedId(null);
    // Match an autosaved edit of this exact file. The transcript is the
    // expensive part (a whisper pass over the whole recording), so it comes
    // back with the file instead of waiting for the Restore banner — and it
    // is dropped only when the file really is a different one.
    const curName = fileNameRef.current || fileName;
    let saved: Record<string, unknown> | null = null;
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) saved = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      saved = null;
    }
    const matched =
      !!saved &&
      saved.app === "reaction-studio" &&
      (Boolean(curName && saved.sourceFile === curName) ||
        (d > 0 && Math.abs(Number(saved.sourceDuration ?? NaN) - d) < 2.0));
    if (matched && saved && typeof saved.savedAt === "string") {
      setRestoreOffer({
        savedAt: saved.savedAt,
        sourceFile: String(saved.sourceFile || curName),
      });
      const tr = saved.transcript as Transcript | undefined;
      if (tr && Array.isArray(tr.words) && tr.words.length) {
        setTranscript(tr);
        setProjectMsg(
          `Transcript restored — ${tr.words.length.toLocaleString()} words` +
            (tr.source ? ` (${tr.source})` : "") +
            ". Restore brings the whole edit back."
        );
      }
    } else {
      // a different file: the old words belong to something else
      setTranscript(null);
    }
    try {
      // the remote preview stream is always a mix, even in Patreon mode.
      // The graph itself is built on the first real gesture (see
      // ensureAudio) — a context created here would be born suspended and
      // hold the element back.
      engine().setDirect(targetRef.current === "youtube" || !!remoteRef.current);
      engine().update(audioRef.current);
      engine().updateCloak(audioCloakRef.current);
    } catch {
      /* audio graph not ready yet */
    }
    // a bus swap reloads the same file — restore the playhead instead of top
    const bs = busSwitchRef.current;
    busSwitchRef.current = null;
    if (bs) v.currentTime = bs.time;
    else seekSrc(0);
    // the source is fully known: autosave may write again
    loadingSource.current = false;
    // …and a play pressed while it was loading can finally start
    if (pendingPlay.current) {
      pendingPlay.current = false;
      setPlayNote("");
      void startPlayback(v).then((ok) => setPlaying(ok));
    }
  };

  /* one-click connect: the notebook prints a link with ?backend=<tunnel url> */
  /**
   * Keep `?backend=` in the address bar.
   *
   * It used to be stripped on connect, which meant a refresh (or a crash, or
   * the runtime being reclaimed) dropped you back to "paste the tunnel URL
   * from the notebook" — a round trip to Colab for every reload. Now the
   * link stays shareable and self-healing.
   */
  const syncBackendParam = useCallback((url: string) => {
    try {
      const u = new URL(window.location.href);
      if (url) u.searchParams.set(BACKEND_PARAM, url);
      else u.searchParams.delete(BACKEND_PARAM);
      window.history.replaceState({}, "", u.toString());
    } catch {
      /* non-standard location — nothing to preserve */
    }
  }, []);

  /* ------------------------------------------------------------- remote */
  /** wait for the preview proxy, then load it into the shared video element */
  const awaitProxy = useCallback(
    async (client: RemoteClient, token: number) => {
      for (;;) {
        if (connectToken.current !== token) return;
        const st = await client.state();
        if (connectToken.current !== token) return;
        setRemoteInfo(st);
        if (st.proxy.error) throw new ProxyError(st.proxy.error);
        if (st.proxy.ready) {
          const v = videoRef.current;
          if (!v) return;
          setProxyEta(0);
          fileNameRef.current = st.info.path;
          setFileName(st.info.path);
          setResult(null);
          setEnv(null);
          setDetection(null);
          setPlaying(false);
          setPlayNote("");
          setPreviewBus("mix");
          // see loadFile: the transcript survives a reconnect to the same
          // source, and autosave waits for this file's metadata
          loadingSource.current = true;
          // cache-bust so a re-transcoded proxy is never served stale
          v.crossOrigin = "anonymous";
          v.src = `${client.proxyUrl()}?t=${Date.now()}`;
          v.muted = false;
          v.volume = 1;
          v.playbackRate = 1;
          v.load();
          return;
        }
        const p = st.proxy.progress;
        setProxyProgress(p);
        if (p > 0.01 && p < 0.99) {
          if (!proxyStartRef.current) proxyStartRef.current = performance.now();
          const elapsed = (performance.now() - proxyStartRef.current) / 1000;
          setProxyEta((elapsed / p) * (1 - p));
        }
        await sleep(2000);
      }
    },
    []
  );

  /** swap the preview element between mix / mic-only / content-only streams */
  const switchPreviewBus = useCallback(
    (bus: "mix" | "mic" | "content") => {
      const v = videoRef.current;
      const client = remoteRef.current;
      if (!v || !client || bus === previewBus) return;
      setPreviewBus(bus);
      busSwitchRef.current = { time: v.currentTime };
      v.pause();
      v.crossOrigin = "anonymous";
      v.src = `${client.proxyUrl(bus)}?t=${Date.now()}`;
      v.load();
    },
    [previewBus]
  );

  /* keep the server's mic/channel mapping in sync with the Audio tab —
     switching it rebuilds the mic/content preview streams on the server */
  useEffect(() => {
    const client = remoteRef.current;
    if (!client) return;
    const server = remoteInfo?.mic_channel;
    if (!server || server === audio.mic.channel) return;
    void client.setMicChannel(audio.mic.channel).catch(() => {
      /* older server without the route — the mix preview is unaffected */
    });
  }, [remote, remoteInfo, audio.mic.channel]);

  const connectRemote = useCallback(
    async (raw: string) => {
      const token = ++connectToken.current;
      setConnecting(true);
      setRemoteError("");
      setProxyProgress(0);
      setProxyEta(0);
      proxyStartRef.current = 0;
      try {
        const client = new RemoteClient(raw);
        if (!client.base) throw new Error("Paste the tunnel URL from the notebook cell.");
        const st = await client.state();
        if (connectToken.current !== token) return;
        localStorage.setItem("remoteUrl", client.base);
        syncBackendParam(client.base);
        setRemote(client);
        setRemoteInfo(st);
        try {
          const s = await client.sources();
          if (connectToken.current !== token) return;
          setSources(s.sources);
        } catch {
          setSources([]);
        }
        try {
          const j = await client.job();
          if (connectToken.current === token && j.state !== "idle") setRemoteJob(j);
        } catch {
          /* older server without the job queue */
        }
        await awaitProxy(client, token);
        if (connectToken.current === token) setProxyFailed(false);
      } catch (e) {
        if (connectToken.current === token) {
          if (e instanceof ProxyError) {
            // the connection is fine, only the preview stream failed: keep
            // the client so the timeline and export still work, and let the
            // user rebuild the stream (a GPU-less runtime no longer ends the
            // session — it just falls back to the CPU encoder)
            setProxyFailed(true);
          } else {
            setRemote(null);
          }
          setRemoteError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (connectToken.current === token) setConnecting(false);
      }
    },
    [awaitProxy, syncBackendParam]
  );

  /** rebuild the preview stream after a failed transcode */
  const retryPreview = useCallback(async () => {
    const client = remoteRef.current;
    if (!client) return;
    const token = ++connectToken.current;
    setConnecting(true);
    setRemoteError("");
    setProxyFailed(false);
    setProxyProgress(0);
    setProxyEta(0);
    proxyStartRef.current = 0;
    try {
      await client.retryProxy();
      await awaitProxy(client, token);
    } catch (e) {
      if (connectToken.current === token) {
        if (e instanceof ProxyError) setProxyFailed(true);
        setRemoteError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (connectToken.current === token) setConnecting(false);
    }
  }, [awaitProxy]);

  const selectRemoteSource = useCallback(
    async (name: string, folder: "input" | "output" = "input") => {
      const client = remoteRef.current;
      if (!client) return;
      const token = ++connectToken.current;
      trToken.current++;
      setTrBusy(false);
      setConnecting(true);
      setRemoteError("");
      setProxyProgress(0);
      setProxyEta(0);
      proxyStartRef.current = 0;
      loadingSource.current = true;
      try {
        await client.setSource(name, folder);
        if (connectToken.current !== token) return;
        const s = await client.sources();
        if (connectToken.current !== token) return;
        setSources(s.sources);
        await awaitProxy(client, token);
        if (connectToken.current === token) setProxyFailed(false);
      } catch (e) {
        if (connectToken.current === token) {
          if (e instanceof ProxyError) setProxyFailed(true);
          setRemoteError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (connectToken.current === token) setConnecting(false);
      }
    },
    [awaitProxy, syncBackendParam]
  );

  const disconnectRemote = useCallback(() => {
    connectToken.current++;
    trToken.current++;
    setTrBusy(false);
    setTranscript(null);
    syncBackendParam("");
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    setRemote(null);
    setRemoteInfo(null);
    setRemoteError("");
    setSources([]);
    setRemoteJob(null);
    setFileName("");
    setDuration(0);
    setDims({ w: 0, h: 0 });
    setSegments([]);
    setPlaying(false);
  }, [syncBackendParam]);

  const switchEngine = useCallback(
    (m: "local" | "remote") => {
      if (m === engineMode) return;
      if (exportingRef.current || scanningRef.current) return;
      if (engineMode === "remote") disconnectRemote();
      if (engineMode === "local") {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.removeAttribute("src");
          v.load();
        }
        setFileName("");
        setDuration(0);
        setDims({ w: 0, h: 0 });
        setSegments([]);
        setPlaying(false);
        setResult(null);
        setTranscript(null);
      }
      setEngineMode(m);
      engine().setDirect(m === "remote" || targetRef.current === "youtube");
    },
    [engineMode, disconnectRemote]
  );

  /** the notebook's link (``…?backend=https://…``) connects on load */
  const autoBackend = useRef(false);
  useEffect(() => {
    if (autoBackend.current) return;
    autoBackend.current = true;
    const q = new URLSearchParams(window.location.search).get(BACKEND_PARAM);
    if (q) {
      setRemoteDraft(q);
      switchEngine("remote");
      void connectRemote(q);
    }
  }, [connectRemote, switchEngine]);

  const startRemoteExport = useCallback(async () => {
    const client = remoteRef.current;
    if (!client || !duration || remoteJob?.state === "running") return;
    setRemoteError("");
    try {
      const base = (fileName || "reaction").replace(/\.[^.]+$/, "");
      // YouTube = a straight cut of the already-finished Patreon render, so it
      // must keep the source's own resolution and frame rate (no scale / fps
      // conversion). Patreon is a fresh composite, where 1080/720 applies.
      const passthrough = targetRef.current === "youtube";
      const job = await client.renderProject({
        target: targetRef.current,
        name: `${base}_${targetRef.current}`,
        segments: segsRef.current.map((s) => ({
          type: s.type,
          start: s.start,
          end: s.end,
          ...(s.card ? { card: s.card } : {}),
          // per-block content mirror (Cloak tab → Mirroring → ticked blocks):
          // the ffmpeg render must mirror exactly the blocks the preview does
          ...(s.mirror ? { mirror: true } : {}),
        })),
        layout: layoutRef.current,
        audio: audioRef.current,
        retouch: retouchRef.current,
        audioCloak: audioCloakRef.current,
        videoCloak: videoCloakRef.current,
        sticker: stickerRef.current,
        crf: 23,
        webm: false,
        fps: passthrough ? null : fps,
        height: passthrough ? 0 : res === 1080 ? 1080 : 720,
        partTarget,
        stems: passthrough ? false : stems,
        audioFadeMs,
      });
      setRemoteJob(job);
      setRightTab("export");
      pollNowRef.current?.();
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    }
  }, [duration, fileName, fps, res, remoteJob?.state, partTarget, stems, audioFadeMs]);

  const cancelRemoteExport = useCallback(async () => {
    const client = remoteRef.current;
    if (!client) return;
    try {
      setRemoteJob(await client.cancelJob());
    } catch {
      /* tunnel hiccup — the next job poll will pick up the state */
    }
  }, []);

  /* finish a render that stopped with parts on disk */
  const resumeRemoteExport = useCallback(async () => {
    const client = remoteRef.current;
    const key = remoteJob?.resume?.key;
    if (!client || !key) return;
    setRemoteError("");
    try {
      setRemoteJob(await client.resume(key));
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    }
  }, [remoteJob?.resume?.key]);

  /* Poll a running remote render until it lands.

     A dead tunnel used to be swallowed silently, so the tab kept printing
     the last progress number forever — that is how a reclaimed runtime
     looked like a slow render. Three failed polls in a row now say so, and
     a tab that becomes visible polls immediately instead of waiting out the
     interval (background tabs throttle timers hard). */
  const pollNowRef = useRef<(() => void) | null>(null);
  const pollFails = useRef(0);
  useEffect(() => {
    if (!remote || remoteJob?.state !== "running") return;
    const tick = async () => {
      try {
        const j = await remote.job();
        pollFails.current = 0;
        setRemoteError("");
        setRemoteJob(j);
      } catch {
        pollFails.current += 1;
        if (pollFails.current === 3) {
          setRemoteError(
            "The backend stopped answering — this render is NOT running any " +
              "more. Re-run the notebook cell, then reconnect: the parts it " +
              "finished are on disk and the render can be resumed."
          );
        }
      }
    };
    pollNowRef.current = () => void tick();
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      pollNowRef.current = null;
    };
  }, [remote, remoteJob?.state]);

  useEffect(() => {
    if (autoBackend.current) return;
    autoBackend.current = true;
    const q = new URLSearchParams(window.location.search).get(BACKEND_PARAM);
    if (q) {
      setRemoteDraft(q);
      switchEngine("remote");
      void connectRemote(q);
    }
  }, [connectRemote, switchEngine]);

  /* --------------------------------------------------------------- scan */
  const stopScan = useCallback(() => {
    const v = videoRef.current;
    const res = engine().stopScan();
    scanningRef.current = false;
    setScanning(false);
    if (v) {
      v.pause();
      setPlaying(false);
      v.preservesPitch = true;
      v.playbackRate = rateRef.current;
    }
    if (res && res[0] && res[1] && durRef.current > 0) {
      const envelope = buildEnvelope(res[0], res[1], durRef.current);
      if (scanChannelRef.current === "mic") {
        setMicEnv(envelope);
        setEnv(envelope);
        setDetection(detectSpeech(envelope, cutRef.current));
      } else {
        setContentEnv(envelope);
      }
      seekSrc(0);
    }
  }, [seekSrc]);

  const stopScanRef = useRef(stopScan);
  stopScanRef.current = stopScan;
  const scanChannelRef = useRef<"mic" | "content">("mic");
  scanChannelRef.current = scanChannel;

  const startScan = useCallback(
    async (channel: "mic" | "content" = "mic") => {
      const v = videoRef.current;
      if (!v || !durRef.current) return;
      // the scanner taps the graph, so it has to exist first: build it on
      // this click (a user gesture) instead of silently doing nothing when
      // play has never been pressed
      const eng = ensureAudio(v);
      eng.resume();
      await eng.unlock();
      scanChannelRef.current = channel;
      setScanChannel(channel);
      const ok = eng.startScan(
        durRef.current,
        () => v.currentTime,
        () => v.playbackRate,
        channel
      );
      if (!ok) {
        setPlayNote(
          eng.error ||
            "The audio analysis could not start — this browser has no working " +
              "audio graph for the preview. Load the file in This-PC mode, or " +
              "run the analysis on the Colab side."
        );
        return;
      }
      setPlayNote("");
      if (channel === "mic") {
        setEnv(null);
        setDetection(null);
        setMicEnv(null);
      } else {
        setContentEnv(null);
      }
      setScanProgress(0);
      seekSrc(0);
      await new Promise((r) => window.setTimeout(r, 80));
      scanningRef.current = true;
      setScanning(true);
      v.preservesPitch = false;
      v.playbackRate = scanSpeedRef.current;
      try {
        await v.play();
        setPlaying(true);
      } catch {
        stopScanRef.current();
      }
    },
    [seekSrc]
  );

  /* ------------------------------------------------------ polish actions */
  const loadTranscript = useCallback((text: string) => {
    const t = parseTranscript(text);
    setTranscript(t);
  }, []);

  const onTranscriptFile = useCallback(
    (f: File) => {
      const r = new FileReader();
      r.onload = () => loadTranscript(String(r.result ?? ""));
      r.readAsText(f);
    },
    [loadTranscript]
  );

  const runTranscriptSpans = useCallback(async (spans: { start: number; end: number }[], errMsg: string) => {
    const client = remoteRef.current;
    if (!client || trBusy) return;
    if (!spans.length) {
      setTrError(errMsg);
      return;
    }
    const token = ++trToken.current;
    setTrBusy(true);
    setTrError("");
    setTrProgress(0);
    try {
      await client.transcribe(spans, trLang);
      for (;;) {
        if (trToken.current !== token) return;
        await sleep(2000);
        const j = await client.job();
        if (trToken.current !== token) return;
        if (j.kind !== "transcript") continue;
        setTrProgress(j.progress);
        if (j.state === "done") {
          if (j.result && j.result.words.length) {
            setTranscript({
              words: j.result.words,
              timed: true,
              source: `whisper (${j.result.lang})`,
            });
          } else {
            setTrError("No speech detected — check the mic channel.");
          }
          break;
        }
        if (j.state === "error") {
          setTrError(j.error || "Transcription failed.");
          break;
        }
        if (j.state === "cancelled") {
          setTrError("Transcription cancelled.");
          break;
        }
      }
    } catch (e) {
      if (trToken.current === token) {
        setTrError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (trToken.current === token) {
        setTrBusy(false);
        setTrProgress(0);
      }
    }
  }, [trBusy, trLang]);

  const runTranscript = useCallback(async () => {
    const spans = segsRef.current
      .filter((s) => s.type === "intro" || s.type === "outro")
      .map((s) => ({ start: s.start, end: s.end }));
    await runTranscriptSpans(spans, "No intro/outro segments on the timeline — nothing to transcribe.");
  }, [runTranscriptSpans]);

  const runTranscriptBody = useCallback(async () => {
    // For YouTube: transcribe the reaction body (where silent gaps matter)
    const spans = segsRef.current
      .filter((s) => s.type === "body" || s.type === "lead")
      .map((s) => ({ start: s.start, end: s.end }));
    const fallback = spans.length ? spans : [{ start: 0, end: durRef.current }];
    await runTranscriptSpans(fallback, "No reaction segments on the timeline — nothing to transcribe.");
  }, [runTranscriptSpans]);

  const doBuildSkeleton = useCallback(() => {
    if (reactionStart === null || !duration) return;
    withTxn(buildSkeleton(duration, reactionStart, leadCfg.leadIn, leadCfg.black).segments);
    setSelectedId(null);
  }, [reactionStart, duration, leadCfg, withTxn]);

  const doApplyPolish = useCallback(() => {
    if (!duration) return;
    withTxn(applyPolish(segsRef.current, polishDrops, duration));
    setSelectedId(null);
  }, [polishDrops, duration, withTxn]);

  const doApplyDisrupt = useCallback(() => {
    if (!disruptions || !duration) return;
    withTxn(applyDisrupt(segsRef.current, disruptions.drops, duration));
    setSelectedId(null);
  }, [disruptions, duration, withTxn]);

  const doApplyAllPolish = useCallback(() => {
    if (!duration) return;
    const base = reactionStart !== null
      ? buildSkeleton(duration, reactionStart, leadCfg.leadIn, leadCfg.black).segments
      : defaultSegments(duration);
    const withDrops = applyDisrupt(base, disruptions?.drops ?? [], duration);
    withTxn(applyPolish(withDrops, polishDrops, duration));
    setSelectedId(null);
  }, [duration, reactionStart, leadCfg, disruptions, polishDrops, withTxn]);

  const applyCut = useCallback(() => {
    if (!detection || !durRef.current) return;
    withTxn(buildCut(segsRef.current, detection.regions, cutRef.current, durRef.current));
    setSelectedId(null);
  }, [detection, withTxn]);

  const applyTranscriptCut = useCallback(() => {
    if (!transcript?.timed || !transcript.words.length || !durRef.current) return;
    // Use bodySpan if we have a meaningful reaction part, else whole file
    const span = bodySpan.end - bodySpan.start > 1 ? bodySpan : { start: 0, end: durRef.current };
    const next = buildTranscriptCut(
      segsRef.current,
      transcript.words,
      durRef.current,
      transcriptCutOpts,
      span
    );
    withTxn(next);
    setSelectedId(null);
  }, [transcript, bodySpan, transcriptCutOpts, withTxn]);

  const applyFairUseLimit = useCallback(() => {
    if (!durRef.current) return;
    const span = bodySpan.end - bodySpan.start > 1 ? bodySpan : { start: 0, end: durRef.current };
    const speech = transcript?.timed ? transcript.words : detection?.regions ?? null;
    const { segments: next } = buildFairUseLimit(
      segsRef.current,
      durRef.current,
      fairUseOpts,
      speech as any,
      span,
      detection?.regions ?? null,
      layoutRef.current.fastSpeed
    );
    withTxn(next);
    setSelectedId(null);
  }, [transcript, detection, bodySpan, fairUseOpts, withTxn]);

  const resetTimeline = useCallback(() => {
    const d = durRef.current;
    const intro = Math.min(4, d * 0.12);
    const outro = Math.min(4, d * 0.12);
    withTxn(
      normalize(
        [
          { id: uid(), type: "intro", start: 0, end: intro },
          { id: uid(), type: "body", start: intro, end: Math.max(intro, d - outro) },
          { id: uid(), type: "outro", start: Math.max(intro, d - outro), end: d },
        ],
        d
      )
    );
    setSelectedId(null);
  }, [withTxn]);

  /* -------------------------------------------------------------- claims */
  const doParse = () => {
    const segs = segsRef.current;
    const parsed = parseClaims(raw, duration).map((c) =>
      timeBase === "source"
        ? c
        : {
            ...c,
            start: outToSrc(segs, c.start, layoutRef.current.fastSpeed),
            end: outToSrc(segs, c.end, layoutRef.current.fastSpeed),
          }
    );
    setClaims(parsed);
    if (parsed.length) setSelectedClaim(parsed[0].id);
  };

  const applyClaim = useCallback(
    (c: Claim) => {
      if (c.action === "none") return;
      withTxn(
        normalize(
          carve(segsRef.current, c.start, c.end, c.action === "cut" ? "cut" : "mute"),
          durRef.current
        )
      );
    },
    [withTxn]
  );

  const onClaimAction = (id: string, action: Claim["action"]) => {
    const c = claims.find((x) => x.id === id);
    setClaims((cs) => cs.map((x) => (x.id === id ? { ...x, action } : x)));
    if (c) applyClaim({ ...c, action });
  };

  const edl = () => buildEDL(fileName || "untitled", segments, claims, fast);

  const downloadEDL = () => {
    const blob = new Blob([edl()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(fileName || "reaction").replace(/\.[^.]+$/, "")}-edl.txt`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  /** load a Reaction Studio EDL .txt back in (replaces the timeline — undoable) */
  const importEDL = useCallback(
    (f: File): Promise<string> =>
      new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => {
          const p = parseEDL(String(r.result ?? ""), durRef.current);
          if (!p) {
            resolve("No segment lines found — is this a Reaction Studio EDL?");
            return;
          }
          withTxn(p.segments);
          if (p.claims.length) setClaims(p.claims);
          setSelectedId(null);
          resolve(
            `Imported ${p.segments.length} segments` +
              (p.claims.length ? ` and ${p.claims.length} claims.` : ".")
          );
        };
        r.onerror = () => resolve("Could not read that file.");
        r.readAsText(f);
      }),
    [withTxn]
  );

  /* -------------------------------------------------------- project file */
  const [projectMsg, setProjectMsg] = useState("");
  const [restoreOffer, setRestoreOffer] = useState<{
    savedAt: string;
    sourceFile: string;
  } | null>(null);

  const projectData = () => ({
    app: "reaction-studio" as const,
    // 8 moves the card-opacity default to 96 % and adds the voice-changer
    // options (keep audio under cards); 7 added the mirroring block
    // (mode / scope / keep-bottom) and the per-segment `mirror` tick;
    // 6 added the transcript
    version: 8,
    savedAt: new Date().toISOString(),
    sourceFile: fileNameRef.current || fileName,
    sourceDuration: durRef.current || duration,
    target,
    segments,
    claims,
    layout,
    audio,
    retouch,
    audioCloak,
    videoCloak,
    sticker,
    cutOpts,
    transcriptCutOpts,
    fairUseOpts,
    polish,
    disruptRules,
    leadCfg,
    res,
    fps,
    transcript: transcript ?? undefined,
  });

  /** Apply a parsed project object (file load or autosave restore). */
  const applyProject = useCallback((p: Record<string, unknown>): string | null => {
    if (p.app !== "reaction-studio") return "Not a Reaction Studio project file.";
    if (p.target === "patreon" || p.target === "youtube") {
      switchTarget(p.target as Target);
    }
    if (Array.isArray(p.segments) && p.segments.length) {
      const clean = (p.segments as Segment[]).filter(
        (s) => s && typeof s.start === "number" && typeof s.end === "number" && s.end > s.start
      ).map((s) => ({
        id: typeof s.id === "string" ? s.id : uid(),
        type: (s.type in SEGMENT_META ? s.type : "body") as Segment["type"],
        start: s.start,
        end: s.end,
        // per-block content mirror (Cloak → Mirroring) survives a save/load
        ...(s.mirror ? { mirror: true } : {}),
        ...(s.card && typeof s.card === "object"
          ? { card: s.card as Segment["card"] }
          : {}),
      }));
      const d = durRef.current > 0 ? durRef.current : Number(p.sourceDuration) || 0;
      const normalized = d > 0 ? normalize(clean, d) : clean;
      setSegments(normalized);
      segsRef.current = normalized;
      clearHistory();
    }
    if (Array.isArray(p.claims)) setClaims(p.claims as Claim[]);
    if (p.layout) {
      const lay = p.layout as LayoutState;
      // v8: the card-opacity default moved 0.9 -> 0.96. Saved projects carry
      // the old default as an explicit number, so one that still says
      // exactly 0.9 gets the new default instead of the stale one.
      if (lay.card && lay.card.opacity === 0.9) {
        lay.card = { ...lay.card, opacity: 0.96 };
      }
      setLayout(lay);
      layoutRef.current = lay;
    }
    if (p.audio) {
      setAudio(p.audio as AudioState);
      audioRef.current = p.audio as AudioState;
      engine().update(p.audio as AudioState);
    }
    if (p.retouch) {
      setRetouch(p.retouch as Retouch);
      retouchRef.current = p.retouch as Retouch;
    }
    if (p.audioCloak) {
      const ac = p.audioCloak as Partial<AudioCloak>;
      // v5 and older had no voiceTarget: the voice changer was mic-only, so
      // an old project keeps meaning that instead of silently re-voicing the
      // show (the new default is "content")
      const legacyVoice = ac.voiceChanger === true && !ac.voiceTarget;
      const merged = {
        ...defaultAudioCloak,
        ...ac,
        ...(legacyVoice ? { voiceTarget: "mic" as const } : {}),
      } as AudioCloak;
      setAudioCloak(merged);
      audioCloakRef.current = merged;
      engine().updateCloak(merged);
    }
    if (p.videoCloak) {
      // merge over the defaults: a project saved before a field existed must
      // still come back with that field's default (mirrorMode & co.)
      const vc = { ...defaultVideoCloak, ...(p.videoCloak as VideoCloak) };
      setVideoCloak(vc);
      videoCloakRef.current = vc;
    }
    if (p.sticker) {
      const st = { ...defaultSticker, ...(p.sticker as Sticker) };
      setSticker(st);
      stickerRef.current = st;
    }
    if (p.cutOpts) {
      setCutOpts(p.cutOpts as CutOptions);
      cutRef.current = p.cutOpts as CutOptions;
    }
    if (p.transcriptCutOpts) setTranscriptCutOpts(p.transcriptCutOpts as TranscriptCutOptions);
    if (p.fairUseOpts)
      setFairUseOpts({ ...defaultFairUse, ...(p.fairUseOpts as FairUseOptions) });
    if (p.polish) setPolish(p.polish as PolishRules);
    if (p.disruptRules) setDisruptRules(p.disruptRules as DisruptRules);
    if (p.leadCfg) setLeadCfg(p.leadCfg as LeadConfig);
    if (p.res === 720 || p.res === 1080) setRes(p.res);
    if (p.fps === 24 || p.fps === 30 || p.fps === 60) setFps(p.fps);
    if (p.transcript && typeof p.transcript === "object" && Array.isArray((p.transcript as Transcript).words)) {
      setTranscript(p.transcript as Transcript);
    } else {
      setTranscript(null);
    }
    setSelectedId(null);
    return null;
  }, [switchTarget, clearHistory]);

  const saveProject = useCallback(() => {
    const blob = new Blob([JSON.stringify(projectData())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(fileName || "reaction").replace(/\.[^.]+$/, "")}.reaction.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    setProjectMsg(`Saved ${segments.length} segments + all settings.`);
  }, [
    fileName, duration, target, segments, claims, layout, audio, retouch,
    audioCloak, videoCloak, sticker, cutOpts, transcriptCutOpts, fairUseOpts, polish, disruptRules, leadCfg, res, fps, transcript,
  ]);

  const loadProjectFile = useCallback(
    (f: File) => {
      const r = new FileReader();
      r.onload = () => {
        try {
          const p = JSON.parse(String(r.result ?? "")) as Record<string, unknown>;
          const err = applyProject(p);
          if (err) {
            setProjectMsg(err);
            return;
          }
          const src = typeof p.sourceFile === "string" && p.sourceFile ? p.sourceFile : null;
          setProjectMsg(
            src
              ? `Loaded project for “${src}”.` +
                (fileName && src !== fileName ? " Current file differs — check the timeline." : "")
              : "Project loaded."
          );
        } catch (e) {
          setProjectMsg(e instanceof Error ? e.message : "Could not read that file.");
        }
      };
      r.readAsText(f);
    },
    [applyProject, fileName]
  );

  /* ------------------------------------------------------- autosave */
  /**
   * Write the edit to localStorage.
   *
   * Reassigned every render so the debounced timer always flushes the newest
   * state. Storage is small (~5 MB) and the overlay image alone can be
   * bigger than that, so a full write is followed by progressively slimmer
   * ones — losing the sticker beats losing the timeline — and any problem is
   * reported instead of being swallowed by an empty catch.
   */
  writeAutosaveRef.current = () => {
    if (!duration || !segments.length || loadingSource.current) return;
    const full = projectData();
    type Proj = typeof full;
    const put = (data: Proj) => {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
      setLastAutosaveInfo({
        savedAt: data.savedAt,
        sourceFile: String(data.sourceFile || "Untitled"),
        segmentCount: data.segments.length,
      });
    };
    try {
      put(full);
      setAutosaveNote("");
      return;
    } catch {
      /* storage full or unavailable — shed the heavy parts and retry */
    }
    const withoutSticker: Proj = {
      ...full,
      sticker: { ...full.sticker, src: "" },
    };
    try {
      put(withoutSticker);
      setAutosaveNote(
        "Browser storage is full: the edit is saved, but not the overlay image. Use Save project for a complete copy."
      );
      return;
    } catch {
      /* still too big */
    }
    try {
      put({ ...withoutSticker, transcript: undefined });
      setAutosaveNote(
        "Browser storage is full: the edit is saved without the overlay image and the transcript. Use Save project for a complete copy."
      );
    } catch {
      setAutosaveNote(
        "Autosave failed — browser storage is full. Use Save project to keep this edit."
      );
    }
  };

  /** Debounced: the whole edit lands in localStorage ~1.5 s after it stops. */
  useEffect(() => {
    if (!duration || !segments.length) return;
    const t = window.setTimeout(() => writeAutosaveRef.current(), 1500);
    return () => window.clearTimeout(t);
  }, [
    duration, segments, claims, fileName, target, layout, audio, retouch,
    audioCloak, videoCloak, sticker, cutOpts, transcriptCutOpts, fairUseOpts, polish, disruptRules, leadCfg, res, fps, transcript,
  ]);

  /**
   * Opening the Render panel is the moment people expect the work to be
   * safe (it is where the project file lives) — so flush right away instead
   * of waiting for the debounce, and again when the tab goes away.
   */
  useEffect(() => {
    if (rightTab === "export") writeAutosaveRef.current();
  }, [rightTab, duration, segments.length]);

  useEffect(() => {
    const flush = () => writeAutosaveRef.current();
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const doRestore = useCallback(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) throw new Error("empty");
      const p = JSON.parse(raw) as Record<string, unknown>;
      const err = applyProject(p);
      setProjectMsg(err ?? "Restored your autosaved edit.");
    } catch {
      setProjectMsg("Could not read the autosaved edit.");
    }
    setRestoreOffer(null);
  }, [applyProject]);

  /* ---------------------------------------------------- sticker overlay */
  /**
   * In Colab mode the overlay image lives on the notebook — `sticker.src` is
   * a name there, not a URL the browser can fetch, so the canvas silently
   * drew nothing. Hand the renderer the same resolver the panel thumbnail
   * uses and the preview shows what the render will paste in.
   */
  useEffect(() => {
    const client = remoteRef.current;
    setStickerResolver(client ? (src) => client.fileUrl(src) : null);
    return () => setStickerResolver(null);
  }, [remote, engineMode]);

  /* ------------------------------------------------------------ mirroring */
  /** Tick one block for the content mirror (Cloak tab → Mirroring). */
  const toggleSegmentMirror = useCallback(
    (id: string) => {
      withTxn(
        segsRef.current.map((s) =>
          s.id === id ? { ...s, mirror: !s.mirror } : s
        )
      );
    },
    [withTxn]
  );

  /** Tick every reaction block at once (or untick them all). */
  const setAllSegmentMirror = useCallback(
    (on: boolean) => {
      withTxn(
        segsRef.current.map((s) =>
          s.type === "intro" || s.type === "outro"
            ? s
            : { ...s, mirror: on }
        )
      );
    },
    [withTxn]
  );

  /* -------------------------------------------------------------- render */
  const startExport = async () => {
    const v = videoRef.current;
    const cv = exportRef.current;
    if (!v || !cv || !duration || !outDur || scanningRef.current) return;
    setResult(null);
    setProgress(0);
    lastProgress.current = 0;
    // YouTube: render at the source's own size — no resizing. Patreon: a
    // fresh composite, so the chosen 1080/720 resolution applies.
    if (targetRef.current === "youtube") {
      cv.width = v.videoWidth || 1920;
      cv.height = v.videoHeight || 1080;
    } else {
      cv.width = res === 1080 ? 1920 : 1280;
      cv.height = res === 1080 ? 1080 : 720;
    }

    const stream = cv.captureStream(fps);
    const eng = engine();
    if (eng.streamDest) {
      for (const t of eng.streamDest.stream.getAudioTracks()) stream.addTrack(t);
    }
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: bitrate * 1_000_000,
        // Constrain maxrate/bufsize to avoid bloat: 8M max, 16M buf

        audioBitsPerSecond: 192_000,
      });
    } catch {
      rec = new MediaRecorder(stream);
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const type = mime || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      setResult({ url: URL.createObjectURL(blob), size: blob.size });
      setProgress(1);
    };
    recorderRef.current = rec;

    setRate(1);
    v.preservesPitch = true;
    seekSrc(outToSrc(segsRef.current, 0, layoutRef.current.fastSpeed));
    await new Promise((resolve) => {
      const done = () => {
        v.removeEventListener("seeked", done);
        resolve(null);
      };
      v.addEventListener("seeked", done);
      window.setTimeout(done, 1500);
    });

    eng.resume();
    rec.start(500);
    exportingRef.current = true;
    setExporting(true);
    try {
      await v.play();
      setPlaying(true);
    } catch {
      finish();
    }
  };

  const addSegment = (type: SegmentType) => {
    const t = timeRef.current.src;
    const len = type === "cut" ? 4 : type === "card" ? 6 : 3;
    withTxn(normalize(carve(segsRef.current, t, Math.min(t + len, durRef.current), type), durRef.current));
  };

  const setRect = useCallback((key: "content" | "cam", rect: Rect) => {
    setLayoutH((l) => ({ ...l, [key]: rect }));
  }, []);

  const getLevels = useCallback(() => {
    const eng = engineRef.current;
    return eng ? eng.read() : { mic: -60, content: -60, reduction: 0, ducking: 0 };
  }, []);
  const getSrcTime = useCallback(() => timeRef.current.src, []);
  const getOutTime = useCallback(() => timeRef.current.out, []);
  const isPlaying = useCallback(() => playingRef.current, []);
  const empty = !duration;

  const estimate = detection
    ? outDuration(
        buildCut(segments, detection.regions, cutOpts, duration),
        fast
      )
    : outDur;

  // In a card span the render derives the card rect from the content
  // *picture* (fit + zoom + offset), which is not always the content box —
  // show it so the preview can't lie about where the card lands.
  const cardGuide =
    sceneMode === "card" && !isYT && !empty && dims.w > 0
      ? {
          rect: contentPicture(
            layout,
            sourceHalves(dims.w, dims.h, layout.sourceMode, layout.cameraSide).content
          ),
          name: "Card (auto)",
        }
      : null;

  const stageLayers: { key: "content" | "cam"; rect: Rect; name: string }[] =
    sceneMode === "cut"
      ? []
      : sceneMode === "solo" && !isYT
      ? [{ key: "cam", rect: { x: 0, y: 0, w: 1, h: 1 }, name: "Camera (full frame)" }]
      : [
          // YouTube mode shows the same two handles as Patreon: the card
          // covers `content` and the camera corner is restored from `cam`.
          // Seeing (and dragging) both against the real file is what makes the
          // card land exactly on the content instead of "one layout off" —
          // this used to be invisible in the YouTube tab.
          {
            key: "content",
            rect: layout.content,
            name: isYT
              ? "Card / content"
              : sceneMode === "card" || sceneMode === "lead"
              ? "Card"
              : "Content",
          },
          { key: "cam", rect: layout.cam, name: "Camera" },
        ];

  /* ----------------------------------------------------------------- ui */
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#070a12] text-slate-200 [font-feature-settings:'tnum']">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 bg-slate-950/70 px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-sky-400 to-violet-500 text-[13px] font-black text-slate-900">
            R
          </span>
          <h1 className="text-[13px] font-semibold tracking-tight text-white">
            Reaction Studio
          </h1>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
          }}
        />
        {!isRemote ? (
          <Btn onClick={() => fileInput.current?.click()}>
            {fileName ? "Change source" : isYT ? "Open Patreon render" : "Open recording"}
          </Btn>
        ) : !remote ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5 md:max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              void connectRemote(remoteDraft);
            }}
          >
            <input
              value={remoteDraft}
              onChange={(e) => setRemoteDraft(e.target.value)}
              placeholder="https://… — tunnel URL from the notebook"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-400/50"
            />
            <Btn variant="primary" disabled={connecting}>
              {connecting ? "…" : "Connect"}
            </Btn>
          </form>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <select
              value={
                sources.find((s) => s.current)
                  ? `${sources.find((s) => s.current)?.folder ?? "input"}:${sources.find((s) => s.current)?.name}`
                  : fileName
              }
              disabled={connecting || sources.length === 0}
              onChange={(e) => {
                const [folder, ...rest] = e.target.value.split(":");
                void selectRemoteSource(
                  rest.join(":"),
                  folder === "output" ? "output" : "input"
                );
              }}
              className="h-7 max-w-[220px] truncate rounded-lg border border-white/10 bg-black/40 px-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-400/50 disabled:opacity-50"
              title="Source file on the Colab side — the output folder holds finished renders, which is where the Patreon master you cut YouTube from lives"
            >
              {sources.length === 0 && <option value={fileName}>{fileName}</option>}
              {(["input", "output"] as const).map((folder) => {
                const list = sources.filter((s) => (s.folder ?? "input") === folder);
                if (list.length === 0) return null;
                return (
                  <optgroup
                    key={folder}
                    label={folder === "output" ? "renders (output)" : "recordings (raw)"}
                  >
                    {list.map((s) => (
                      <option key={`${folder}:${s.name}`} value={`${folder}:${s.name}`}>
                        {s.name} · {(s.size / 1073741824).toFixed(1)} GB
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <button
              type="button"
              onClick={() => switchEngine("local")}
              className="shrink-0 rounded-lg px-1.5 py-1 text-[11px] text-slate-500 hover:bg-white/10 hover:text-slate-200"
              title="Disconnect and go back to local files"
            >
              ✕
            </button>
          </span>
        )}
        {fileName && (
          <span className="hidden min-w-0 items-center gap-2 md:flex">
            <span className="truncate text-[11px] text-slate-400">{fileName}</span>
            <span className="shrink-0 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
              {dims.w}×{dims.h}
            </span>
          </span>
        )}

        {remote && !isYT && Object.keys(remoteInfo?.bus_proxies ?? {}).length > 0 && (
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5"
            title="Preview audio bus — the render always mixes both. Mic-only / content-only exist for files with two audio tracks."
          >
            {(["mix", "mic", "content"] as const).map((b) => {
              const st = b === "mix" ? { ready: true, progress: 1 } : remoteInfo?.bus_proxies?.[b];
              return (
                <button
                  key={b}
                  type="button"
                  disabled={!st?.ready}
                  onClick={() => switchPreviewBus(b)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    previewBus === b
                      ? "bg-sky-500/30 text-sky-100"
                      : "text-slate-500 hover:bg-white/10 hover:text-slate-300",
                    !st?.ready && "cursor-wait opacity-50"
                  )}
                >
                  {st?.ready || b === "mix" ? b : `${b} · ${Math.round((st?.progress ?? 0) * 100)}%`}
                </button>
              );
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* the receipt for the autosave — silence looked like "it never saved" */}
          {autosaveNote ? (
            <span
              className="hidden max-w-[260px] truncate rounded-lg border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-100 xl:block"
              title={autosaveNote}
            >
              autosave · storage full
            </span>
          ) : lastAutosaveInfo ? (
            <span
              className="hidden rounded-lg border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10px] text-emerald-300/80 xl:block"
              title={`Autosaved “${lastAutosaveInfo.sourceFile}” — ${lastAutosaveInfo.segmentCount} blocks at ${new Date(lastAutosaveInfo.savedAt).toLocaleString()}. Open that video again and the app offers to restore it.`}
            >
              saved{" "}
              {new Date(lastAutosaveInfo.savedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          ) : null}
          <span className="hidden rounded-lg border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10px] text-slate-400 xl:block">
            render <span className="text-sky-300">{fmtTime(outDur)}</span>
            {removed > 0.05 && <span className="text-rose-300"> · −{fmtTime(removed)}</span>}
            {spedUp > 0.05 && <span className="text-teal-300"> · ⇢{fmtTime(spedUp)}</span>}
          </span>
          <div
            className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5"
            title="This PC: the file on your disk, rendered in the browser. Colab: files on the notebook side, previewed as a light stream and rendered by the server."
          >
            {(
              [
                ["local", "This PC"],
                ["remote", "Colab"],
              ] as ["local" | "remote", string][]
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                disabled={exporting || scanning}
                onClick={() => switchEngine(m)}
                className={cn(
                  "rounded px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40",
                  engineMode === m
                    ? m === "remote"
                      ? "bg-emerald-500/25 text-emerald-100 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.4)]"
                      : "bg-white/15 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]"
                    : "text-slate-500 hover:text-slate-300"
                )}
              >
                {label}
                {m === "remote" && remote && (
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />
                )}
              </button>
            ))}
          </div>
          <div
            className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5"
            title="Patreon: cut the full version from the raw capture. YouTube: cut the short version from the finished Patreon render."
          >
            {(["patreon", "youtube"] as Target[]).map((t) => (
              <button
                key={t}
                type="button"
                title={TARGET_META[t].hint}
                onClick={() => switchTarget(t)}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-semibold transition-colors",
                  target === t
                    ? t === "patreon"
                      ? "bg-fuchsia-500/25 text-fuchsia-100 shadow-[inset_0_0_0_1px_rgba(232,121,249,0.4)]"
                      : "bg-sky-500/25 text-sky-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.4)]"
                    : "text-slate-500 hover:text-slate-300"
                )}
              >
                {TARGET_META[t].label}
              </button>
            ))}
          </div>
          <Btn
            variant="primary"
            onClick={() => setRightTab("export")}
            disabled={!duration}
            title="Go to render settings"
          >
            ● Render
          </Btn>
        </div>
      </header>

      {/* middle: left tools | preview | right inspector */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[292px] shrink-0 flex-col border-r border-white/10 bg-slate-950/40">
          <div
            className={cn(
              "shrink-0 border-b border-white/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
              isYT ? "bg-sky-500/10 text-sky-200" : "bg-fuchsia-500/10 text-fuchsia-200"
            )}
          >
            {isYT ? "YouTube · cut the Patreon render" : "Patreon · from the raw capture"}
          </div>
          <nav className="flex shrink-0 gap-0.5 border-b border-white/10 p-1.5">
            {LEFT_TABS[target].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setLeftTab(t.id)}
                className={cn(
                  "flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors",
                  leftTab === t.id
                    ? "bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
                    : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                )}
              >
                {t.label}
                {t.id === "claims" && claims.length > 0 && (
                  <span className="ml-1 rounded bg-rose-500/25 px-1 text-[9px] text-rose-200">
                    {claims.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {leftTab === "polish" && !isYT && (
              <PolishPanel
                hasSource={!!duration}
                duration={duration}
                scanning={scanning}
                scanProgress={scanProgress}
                scanChannel={scanChannel}
                micEnv={micEnv}
                contentEnv={contentEnv}
                disruptions={disruptions}
                transcript={transcript}
                fillers={fillers}
                pauses={polishDrops}
                takes={micRepeats.takes}
                takeKeeps={takeKeeps}
                onTakeKeep={(key, keep) =>
                  setTakeKeeps((m) => ({ ...m, [key]: keep }))
                }
                stutters={micRepeats.stutters}
                rules={polish}
                setRules={setPolishH}
                disruptRules={disruptRules}
                setDisruptRules={setDisruptH}
                lead={leadCfg}
                setLead={setLeadH}
                reactionStart={reactionStart}
                onScan={(ch) => void startScan(ch)}
                onStopScan={stopScan}
                onTranscriptFile={onTranscriptFile}
                onTranscriptText={loadTranscript}
                canTranscribe={isRemote && !!remote}
                trBusy={trBusy}
                trProgress={trProgress}
                trLang={trLang}
                setTrLang={setTrLang}
                onTranscribe={() => void runTranscript()}
                trError={trError}
                onApproxAlign={() =>
                  setTranscript((t) =>
                    t ? approxAlign(t, introOutro, polish.approxWps) : t
                  )
                }
                onBuildSkeleton={doBuildSkeleton}
                onApplyPolish={doApplyPolish}
                onApplyDisrupt={doApplyDisrupt}
                onApplyAll={doApplyAllPolish}
                savings={polishSavings}
                bodySpan={bodySpan}
              />
            )}
            {leftTab === "autocut" && isYT && (
              <AutoCut
                hasSource={!!duration}
                duration={duration}
                scanning={scanning}
                scanProgress={scanProgress}
                env={env}
                detection={detection}
                opts={cutOpts}
                setOpts={setCutOptsH}
                layout={layout}
                setLayout={setLayoutH}
                scanSpeed={scanSpeed}
                setScanSpeed={setScanSpeed}
                onScan={() => void startScan()}
                onStopScan={stopScan}
                onApply={applyCut}
                onReset={resetTimeline}
                estimate={estimate}
                getSrcTime={getSrcTime}
                introOutro={introOutro}
                browserOk={browserOk}
                mixed
                transcript={transcript}
                transcriptCutOpts={transcriptCutOpts}
                setTranscriptCutOpts={setTranscriptCutOptsH}
                onTranscriptFile={onTranscriptFile}
                onTranscriptText={loadTranscript}
                canTranscribe={isRemote && !!remote}
                trBusy={trBusy}
                trProgress={trProgress}
                trLang={trLang}
                setTrLang={setTrLang}
                onTranscribe={() => void runTranscriptBody()}
                trError={trError}
                onApplyTranscriptCut={applyTranscriptCut}
                bodySpan={bodySpan}
                segments={segments}
                fastSpeed={layout.fastSpeed}
                fairUseOpts={fairUseOpts}
                setFairUseOpts={setFairUseOptsH}
                onApplyFairUse={applyFairUseLimit}
                videoCloak={videoCloak}
                setVideoCloak={setVideoCloakH}
              />
            )}
            {leftTab === "claims" && (
              <ClaimsPanel
                raw={raw}
                setRaw={setRaw}
                claims={claims}
                timeBase={timeBase}
                setTimeBase={setTimeBase}
                onParse={doParse}
                onAction={onClaimAction}
                onApplyAll={() => claims.forEach(applyClaim)}
                onClear={() => setClaims([])}
                onCopyEDL={() => void navigator.clipboard?.writeText(edl())}
                onDownloadEDL={downloadEDL}
                onImportEDL={importEDL}
                segments={segments}
              />
            )}
          </div>
        </aside>

        <main
          className="relative flex min-w-0 flex-1 flex-col p-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) loadFile(f);
          }}
        >
          {mismatchWide && (
            <div className="mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-100">
              <span>
                This looks like the raw 32:9 capture — YouTube mode expects the finished 16:9
                Patreon render.
              </span>
              <button
                type="button"
                onClick={() => switchTarget("patreon")}
                className="ml-auto shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/20 px-2 py-1 text-[10px] font-semibold hover:bg-amber-500/30"
              >
                Switch to Patreon
              </button>
            </div>
          )}
          {mismatchNarrow && (
            <div className="mb-2 shrink-0 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400">
              16:9 file in Patreon mode — camera and content share the full frame. For the usual
              side-by-side capture, load the raw 3840×1080 recording.
            </div>
          )}

          {restoreOffer && (
            <div className="mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-100">
              <span>
                An autosaved edit of this file from{" "}
                <span className="font-mono text-emerald-200">
                  {new Date(restoreOffer.savedAt).toLocaleString()}
                </span>{" "}
                is available.
              </span>
              <Btn variant="primary" className="ml-auto shrink-0" onClick={doRestore}>
                Restore
              </Btn>
              <Btn className="shrink-0" onClick={() => setRestoreOffer(null)}>
                Discard
              </Btn>
            </div>
          )}

          <Stage
            canvasRef={previewRef}
            layout={layout}
            onRect={setRect}
            layers={stageLayers}
            guide={cardGuide}
            editLayer={editLayer}
            setEditLayer={setEditLayer}
            sceneMode={sceneMode}
            showGuides={showGuides}
            playing={playing}
            onTogglePlay={togglePlay}
            empty={empty}
            passthrough={isYT}
          />

          {empty && (
            <div className="absolute inset-3 z-40 flex items-center justify-center rounded-xl">
              <div className="w-full max-w-md rounded-2xl border border-dashed border-white/15 bg-slate-950/80 p-6 text-center backdrop-blur">
                {isRemote ? (
                  !remote ? (
                    <>
                      <p className="text-[15px] font-semibold text-white">
                        Connect the Colab backend
                      </p>
                      <p className="mx-auto mt-2 max-w-sm text-[11px] leading-relaxed text-slate-400">
                        Run the server cell in the notebook, paste its tunnel URL
                        {remoteDraft ? " above" : " below"} and press Connect. Your files stay on
                        the Colab side — the browser only previews a light stream, and the
                        finished render downloads straight from the server.
                      </p>
                      <form
                        className="mx-auto mt-4 flex max-w-sm gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void connectRemote(remoteDraft);
                        }}
                      >
                        <input
                          value={remoteDraft}
                          onChange={(e) => setRemoteDraft(e.target.value)}
                          placeholder="https://…tunnel URL…"
                          spellCheck={false}
                          className="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-400/50"
                        />
                        <Btn variant="primary" disabled={connecting}>
                          {connecting ? "…" : "Connect"}
                        </Btn>
                      </form>
                      {remoteError && (
                        <p className="mx-auto mt-3 max-w-sm rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-rose-200">
                          {remoteError}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-[15px] font-semibold text-white">
                        {remoteInfo?.proxy.ready ? "Loading preview…" : "Preparing preview…"}
                      </p>
                      <p className="mx-auto mt-2 max-w-sm text-[11px] leading-relaxed text-slate-400">
                        {remoteInfo?.proxy.ready
                          ? "The stream is ready — starting playback."
                          : "The server is transcoding a lightweight proxy of the source (once per file, cached). The timeline unlocks as soon as it arrives."}
                      </p>
                      {!remoteInfo?.proxy.ready && (
                        <div className="mx-auto mt-4 h-1.5 max-w-sm overflow-hidden rounded-full bg-black/60">
                          <div
                            className="h-full rounded-full bg-emerald-400 transition-[width]"
                            style={{ width: `${Math.round(proxyProgress * 100)}%` }}
                          />
                        </div>
                      )}
                      {!remoteInfo?.proxy.ready && proxyEta > 1 && (
                        <p className="mx-auto mt-2 font-mono text-[10px] text-slate-500">
                          about {fmtTime(proxyEta)} left
                        </p>
                      )}
                      {(proxyFailed || remoteError) && (
                        <div className="mx-auto mt-3 max-w-sm rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-2 text-left">
                          <p className="text-[11px] leading-relaxed text-rose-200">
                            The preview stream could not be built. Nothing is lost — your timeline
                            and the export still work on the server.
                          </p>
                          {remoteError && (
                            <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-rose-300/80">
                              {remoteError}
                            </p>
                          )}
                          <Btn
                            variant="primary"
                            className="mt-2"
                            disabled={connecting}
                            onClick={() => void retryPreview()}
                          >
                            {connecting ? "Rebuilding…" : "Rebuild preview stream"}
                          </Btn>
                        </div>
                      )}
                    </>
                  )
                ) : isYT ? (
                  <>
                    <p className="text-[15px] font-semibold text-white">
                      Drop your Patreon render here
                    </p>
                    <p className="mx-auto mt-2 max-w-sm text-[11px] leading-relaxed text-slate-400">
                      Load the finished 1920×1080 version with its mixed audio. It plays through
                      full-frame — mark what stays with auto-cut, claims or straight cuts, then
                      render the upload. Everything runs locally.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[15px] font-semibold text-white">
                      Drop your OBS recording here
                    </p>
                    <p className="mx-auto mt-2 max-w-sm text-[11px] leading-relaxed text-slate-400">
                      Built for the 3840×1080 side-by-side capture: webcam on one half, watched
                      content on the other, mic and desktop audio on separate channels. Polish the
                      intro and outro, repair the dropouts, compose the frame. Everything runs
                      locally — your 3 GB file never leaves the machine.
                    </p>
                  </>
                )}
                {!isRemote && (
                  <Btn
                    variant="primary"
                    className="mt-4 px-4 py-2 text-[12px]"
                    onClick={() => fileInput.current?.click()}
                  >
                    Choose a video file
                  </Btn>
                )}

                {!isRemote && lastAutosaveInfo && (
                  <div className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-2.5 text-left text-[11px] text-emerald-200">
                    <p className="font-semibold text-white">Previous autosaved session found</p>
                    <p className="text-slate-400 mt-0.5 truncate">
                      “{lastAutosaveInfo.sourceFile}” ({new Date(lastAutosaveInfo.savedAt).toLocaleString()})
                    </p>
                    <p className="text-slate-500 text-[10px] mt-0.5">
                      Open that video to restore your {lastAutosaveInfo.segmentCount} segments and settings.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {scanning && (
            <div className="absolute inset-x-3 top-3 z-40 flex items-center gap-3 rounded-xl border border-sky-400/30 bg-slate-950/90 px-3 py-2 backdrop-blur">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400" />
              <span className="text-[11px] text-sky-200">
                Analysing {isYT ? "mixed audio" : "your mic"} at {scanSpeed}× — {Math.round(scanProgress * 100)}%
              </span>
              <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-black/60">
                <div
                  className="h-full rounded-full bg-sky-400"
                  style={{ width: `${scanProgress * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* transport */}
          {playNote && (
            <div className="mt-2 flex shrink-0 items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-100">
              <span className="shrink-0 pt-[1px]">⚠</span>
              <span className="min-w-0 flex-1">{playNote}</span>
              <button
                type="button"
                onClick={() => setPlayNote("")}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-amber-200/70 hover:bg-amber-400/20 hover:text-amber-100"
                title="Hide"
              >
                ✕
              </button>
            </div>
          )}
          <div className="mt-2.5 flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.025] px-2.5 py-2">
            <button
              type="button"
              onClick={() => seekSrc(timeRef.current.src - 1 / 30)}
              className="rounded-lg px-2 py-1 text-[13px] text-slate-400 hover:bg-white/10 hover:text-white"
              title="Back one frame (←)"
            >
              ◀|
            </button>
            <button
              type="button"
              onClick={togglePlay}
              disabled={!duration}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-40"
              title="Play / pause (Space)"
            >
              {playing ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4 fill-current">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => seekSrc(timeRef.current.src + 1 / 30)}
              className="rounded-lg px-2 py-1 text-[13px] text-slate-400 hover:bg-white/10 hover:text-white"
              title="Forward one frame (→)"
            >
              |▶
            </button>

            <div className="ml-1 flex items-baseline gap-1.5 font-mono text-[12px] tabular-nums">
              <span className="text-sky-300">
                <LiveText get={() => fmtTime(getOutTime())} />
              </span>
              <span className="text-slate-600">/</span>
              <span className="text-slate-400">{fmtTime(outDur)}</span>
              <span className="ml-2 hidden text-[10px] text-slate-600 sm:inline">
                src <LiveText get={() => fmtTime(getSrcTime())} />
              </span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              {selected && (
                <span
                  className={cn(
                    "hidden rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase lg:inline",
                    SEGMENT_META[selected.type].chip
                  )}
                  title={SEGMENT_META[selected.type].text}
                >
                  {SEGMENT_META[selected.type].label} · {fmtTime(selected.end - selected.start)}
                  {selected.type === "fast" && ` @${fast}×`}
                </span>
              )}
              <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5">
                {[0.5, 1, 2].map((r) => (
                  <button
                    key={r}
                    type="button"
                    disabled={exporting || scanning}
                    onClick={() => setRate(r)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      rate === r
                        ? "bg-sky-500/20 text-sky-200"
                        : "text-slate-500 hover:text-slate-300",
                      (exporting || scanning) && "opacity-40"
                    )}
                  >
                    {r}×
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5">
                {[1, 2, 4, 8].map((z) => (
                  <button
                    key={z}
                    type="button"
                    onClick={() => setZoom(z)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      zoom === z
                        ? "bg-sky-500/20 text-sky-200"
                        : "text-slate-500 hover:text-slate-300"
                    )}
                  >
                    {z}×
                  </button>
                ))}
              </div>
            </div>
          </div>
        </main>

        <aside className="flex w-[320px] shrink-0 flex-col border-l border-white/10 bg-slate-950/40">
          <nav className="flex shrink-0 gap-0.5 border-b border-white/10 p-1.5">
            {RIGHT_TABS[target].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setRightTab(t.id)}
                className={cn(
                  "flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors",
                  rightTab === t.id
                    ? "bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
                    : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {rightTab === "layout" && !isYT && (
              <LayoutPanel
                layout={layout}
                setLayout={setLayoutH}
                editLayer={editLayer}
                setEditLayer={setEditLayer}
                dims={dims}
                fileName={fileName || "no source loaded"}
                showGuides={showGuides}
                setShowGuides={setShowGuides}
              />
            )}
            {rightTab === "retouch" && !isYT && (
              <RetouchPanel
                cfg={retouch}
                setCfg={setRetouchH}
                status={trackStatus}
                statusText={trackError}
                fps={trackFps}
                onLoad={loadFaceModel}
                showFaceBox={showFaceBox}
                setShowFaceBox={setShowFaceBox}
                manualBox={retouch.manualRect}
                setManualBox={(b) => setRetouchH((c) => ({ ...c, manualRect: { ...b } }))}
              />
            )}
            {rightTab === "video" && isYT && (
              <VideoPanel
                fileName={fileName || "no source loaded"}
                dims={dims}
                layout={layout}
                setLayout={setLayoutH}
              />
            )}
            {rightTab === "cloak" && isYT && (
              <CloakPanel
                audio={audioCloak}
                setAudio={setAudioCloakH}
                video={videoCloak}
                setVideo={setVideoCloakH}
                sticker={sticker}
                setSticker={setStickerH}
                remote={isRemote ? remoteRef.current : null}
                segments={segments}
                onToggleMirror={toggleSegmentMirror}
                onSetAllMirror={setAllSegmentMirror}
                onSeek={seekSrc}
              />
            )}
            {rightTab === "timeline" && (
              <SegmentsPanel
                segments={segments}
                layout={layout}
                setLayout={setLayoutH}
                selected={selected}
                onSelect={setSelectedId}
                onSeek={seekSrc}
                onCommit={(next) => withTxn(normalize(next, duration))}
                onSplit={doSplit}
              />
            )}
            {rightTab === "audio" && (
              <AudioPanel audio={audio} setAudio={setAudioH} getLevels={getLevels} direct={isYT} />
            )}
            {rightTab === "export" && (
              <ExportPanel
                res={res}
                setRes={setResH}
                fps={fps}
                setFps={setFpsH}
                bitrate={bitrate}
                setBitrate={setBitrate}
                exporting={exporting}
                progress={progress}
                resultUrl={result?.url ?? null}
                resultSize={result?.size ?? 0}
                fileName={fileName || "reaction"}
                onExport={() => void startExport()}
                onStop={finish}
                outDur={outDur}
                removed={removed}
                duration={duration}
                mime={mime}
                onSaveProject={saveProject}
                onLoadProject={loadProjectFile}
                onRestoreAutosave={doRestore}
                projectMsg={projectMsg}
                autosave={
                  lastAutosaveInfo
                    ? {
                        at: lastAutosaveInfo.savedAt,
                        blocks: lastAutosaveInfo.segmentCount,
                        sourceFile: lastAutosaveInfo.sourceFile,
                      }
                    : null
                }
                autosaveNote={autosaveNote}
                passthrough={isYT}
                partTarget={partTarget}
                setPartTarget={setPartTarget}
                stems={stems}
                setStems={setStems}
                audioFadeMs={audioFadeMs}
                setAudioFadeMs={setAudioFadeMs}
                remote={
                  isRemote
                    ? {
                        connected: !!remote,
                        job: remoteJob,
                        error: remoteError,
                        onExport: () => void startRemoteExport(),
                        onCancel: () => void cancelRemoteExport(),
                        onResume: () => void resumeRemoteExport(),
                        fileUrl: (n) => remote?.fileUrl(n) ?? "#",
                        encoder: remoteInfo?.encoder ?? null,
                      }
                    : null
                }
              />
            )}
          </div>
        </aside>
      </div>

      {/* timeline spans the full width, under everything */}
      <div className="flex h-[190px] shrink-0 flex-col border-t border-white/10">
        <Timeline
          segments={segments}
          claims={claims}
          selectedId={selectedId}
          selectedClaim={selectedClaim}
          duration={duration}
          zoom={zoom}
          fastSpeed={fast}
          playing={isPlaying}
          getSrcTime={getSrcTime}
          waves={timelineWaves}
          transcript={transcript}
          onSelect={setSelectedId}
          onSelectClaim={setSelectedClaim}
          onChange={(s) => setSegments(normalize(s, duration))}
          onEditStart={editStart}
          onEditEnd={editEnd}
          onSeek={seekSrc}
          onSplit={doSplit}
          onAddSegment={addSegment}
          onDelete={doDelete}
          onApplyRange={applyRange}
          canUndo={pastRef.current.length > 0}
          canRedo={futureRef.current.length > 0}
          onUndo={undo}
          onRedo={redo}
        />
      </div>

      <video
        ref={videoRef}
        className="pointer-events-none fixed -left-[9999px] top-0 h-1 w-1"
        playsInline
        preload="auto"
        onLoadedMetadata={onMeta}
        onLoadedData={() => {
          const v = videoRef.current;
          if (v && v.videoWidth && v.videoHeight) {
            setDims({ w: v.videoWidth, h: v.videoHeight });
          }
        }}
        onDurationChange={(e) => {
          const v = e.currentTarget;
          if (v.duration && Number.isFinite(v.duration) && v.duration > 0) {
            setDuration(v.duration);
            durRef.current = v.duration;
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          finish();
        }}
        onError={(e) => {
          // a source the browser refuses to load is not a mystery any more
          const code = e.currentTarget.error?.code;
          setPlaying(false);
          setPlayNote(
            code === 4
              ? "The browser cannot decode this file (unsupported codec or a " +
                "damaged stream). The Colab preview stream is MP4/H.264 — if " +
                "this is a local file, re-record or re-export it as MP4."
              : code === 2
              ? "The preview source could not be read (network error). " +
                "Reconnect the backend and try again."
              : "The preview source failed to load (media error " +
                (code ?? "?") +
                "). Reload the page, or reconnect the backend."
          );
        }}
      />
      <canvas
        ref={exportRef}
        className="pointer-events-none fixed -left-[9999px] top-0 h-1 w-1"
      />
    </div>
  );
}
