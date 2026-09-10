import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Stage from "./components/Stage";
import Timeline from "./components/Timeline";
import AutoCut from "./components/AutoCut";
import PolishPanel from "./components/Polish";
import RetouchPanel from "./components/RetouchPanel";
import { AudioPanel, ClaimsPanel, ExportPanel, LayoutPanel, VideoPanel } from "./components/Panels";
import { Btn, LiveText } from "./components/ui";
import { AudioEngine } from "./lib/audio";
import { FaceTracker, type TrackStatus } from "./lib/face";
import {
  applyRetouch,
  poseFromBox,
  poseFromLandmarks,
  type FacePose,
} from "./lib/retouch";
import type { RetouchHook, SrcRect } from "./lib/render";
import { buildEnvelope, detectSpeech, type Detection, type Envelope } from "./lib/analyze";
import {
  buildPassthroughScene,
  buildScene,
  pickRecorderMime,
  renderScene,
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
  removedDuration,
  removeSegment,
  savedBySpeed,
  splitAt,
  srcToOut,
  uid,
} from "./lib/timeline";
import {
  defaultAudio,
  defaultCut,
  defaultDisrupt,
  defaultLead,
  defaultLayout,
  defaultPolish,
  defaultRetouch,
  SEGMENT_META,
  TARGET_META,
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
  type Target,
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
    { id: "export", label: "Render" },
  ],
  youtube: [
    { id: "video", label: "Video" },
    { id: "audio", label: "Audio" },
    { id: "export", label: "Render" },
  ],
};

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
  const lastProgress = useRef(0);
  const lastFastDb = useRef(0);
  const trackStatusRef = useRef<TrackStatus>("idle");
  const trackFpsRef = useRef(0);

  const engine = () => (engineRef.current ??= new AudioEngine());

  /* --------------------------------------------------------------- state */
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [segments, setSegments] = useState<Segment[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [raw, setRaw] = useState("");
  const [timeBase, setTimeBase] = useState<"source" | "render">("source");
  const [layout, setLayout] = useState<LayoutState>(defaultLayout);
  const [audio, setAudio] = useState<AudioState>(defaultAudio);
  const [cutOpts, setCutOpts] = useState<CutOptions>(defaultCut);
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
  const [bitrate, setBitrate] = useState(12);
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

  /* auto-cut */
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanSpeed, setScanSpeed] = useState(4);
  const [env, setEnv] = useState<Envelope | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [sceneMode, setSceneMode] = useState<SceneMode>("body");

  /* polish */
  const [target, setTarget] = useState<Target>("patreon");
  const [scanChannel, setScanChannel] = useState<"mic" | "content">("mic");
  const [micEnv, setMicEnv] = useState<Envelope | null>(null);
  const [contentEnv, setContentEnv] = useState<Envelope | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [polish, setPolish] = useState<PolishRules>(defaultPolish);
  const [disruptRules, setDisruptRules] = useState<DisruptRules>(defaultDisrupt);
  const [leadCfg, setLeadCfg] = useState<LeadConfig>(defaultLead);
  const polishRef = useRef(polish);
  const disruptRef = useRef(disruptRules);
  polishRef.current = polish;
  disruptRef.current = disruptRules;
  const targetRef = useRef<Target>("patreon");
  targetRef.current = target;

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
        const sAsp = src.w / src.h;
        let dw = w;
        let dh = h;
        if (style.fit === "contain") {
          if (sAsp > 1) dh = w / sAsp;
          else dw = h * sAsp;
        }
        const zw = dw * style.zoom;
        const zh = dh * style.zoom;
        const zx = (w - zw) / 2 + style.offsetX * dw;
        const zy = (h - zh) / 2 + style.offsetY * dh;
        try {
          ctx.drawImage(video, src.x, src.y, src.w, src.h, zx, zy, zw, zh);
        } catch {
          return null;
        }

        const lm = faceLmRef.current;
        let pose: FacePose | null = null;
        if (cfg.manual) {
          pose = poseFromBox(cfg.manualRect, { w, h });
        } else if (lm && lm.length > 400) {
          pose = poseFromLandmarks(
            lm,
            { x: 0, y: 0, w, h },
            style.fit,
            style.zoom,
            style.offsetX,
            style.offsetY
          );
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

  /** Mic repeats: long ones are extra takes (keep the last), short ones are stumbles. */
  const micRepeats = useMemo(() => {
    if (!micEnv) return { takes: [] as Region[], stutters: [] as Region[] };
    const all = findRepeats(micEnv, {
      minRepeat: polish.minRepeat,
      minSeparation: 0.3,
      trimDeadAir: false,
      deadAir: 999,
      keepDead: 0,
    });
    const inSolo = (r: Region) =>
      introOutro.some((s) => r.start >= s.start - 0.2 && r.end <= s.end + 0.2);
    const takes = all
      .filter(
        (r) =>
          r.len >= polish.minTake &&
          r.b - (r.a + r.len) >= polish.takeGap &&
          inSolo({ start: r.a, end: r.b })
      )
      .map((r) => ({ start: r.a, end: r.b }));
    const stutters = all
      .filter((r) => r.len < polish.minTake || r.b - (r.a + r.len) < polish.takeGap)
      .map((r) => ({ start: r.a + r.len, end: r.b }))
      .filter(inSolo);
    return { takes: mergeRegions(takes), stutters: mergeRegions(stutters) };
  }, [micEnv, polish, introOutro]);

  const polishDrops = useMemo(() => {
    const list: Region[] = [...micRepeats.takes, ...micRepeats.stutters];
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
  }, [micRepeats, transcript, introOutro, polish, fillers]);

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
  }, []);

  useEffect(() => {
    engine().update(audio);
  }, [audio]);

  useEffect(() => {
    engine().setMicChannel(audio.mic.channel);
  }, [audio.mic.channel]);

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

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !durRef.current || scanningRef.current) return;
    engine().resume();
    if (v.paused) {
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

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
    setLayout((l) => ({ ...l, sourceMode: t === "patreon" ? "split" : "single" }));
    engine().setDirect(t === "youtube");
    engine().update(audioRef.current, 0);
    lastFastDb.current = 0;
    setLeftTab(t === "patreon" ? "polish" : "autocut");
    setRightTab(t === "patreon" ? "layout" : "video");
  }, []);

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
      if (!v || !cv || !v.videoWidth || v.readyState < 2) return;
      if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
      const scratch = scratchRef.current;

      const segs = segsRef.current;
      const lay = layoutRef.current;
      const yt = targetRef.current === "youtube";
      const act = activeSegment(segs, v.currentTime);

      // removed segments are never decoded, shown or exported
      if (act && act.type === "cut" && v.currentTime < act.end - 0.02) {
        v.currentTime = Math.min(act.end + 0.002, durRef.current - 0.001);
      }

      // playback speed: the scanner owns it, otherwise follow the segment type
      if (!scanningRef.current) {
        const want =
          act?.type === "fast"
            ? lay.fastSpeed
            : exportingRef.current
            ? 1
            : rateRef.current;
        if (Math.abs(v.playbackRate - want) > 0.02) v.playbackRate = want;
        const pitch = act?.type === "fast" ? !lay.chipmunk : true;
        if (v.preservesPitch !== pitch) v.preservesPitch = pitch;
      }

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
        ? buildPassthroughScene(segs, v.currentTime, halves.full, lay.fastSpeed)
        : buildScene(lay, segs, v.currentTime, halves);
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

      if (scanningRef.current) {
        const p = durRef.current > 0 ? clamp(v.currentTime / durRef.current, 0, 1) : 0;
        setScanProgress(p);
        if (v.ended || v.currentTime >= durRef.current - 0.05) stopScanRef.current();
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

      timeRef.current.src = v.currentTime;
      timeRef.current.out = srcToOut(segs, v.currentTime, lay.fastSpeed);
      if (v.ended && !exportingRef.current && !scanningRef.current) setPlaying(false);

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
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [finish, retouchHook]);

  /* ------------------------------------------------------------ keyboard */
  const doSplit = useCallback(() => {
    setSegments((s) => splitAt(s, timeRef.current.src));
  }, []);

  const doDelete = useCallback(() => {
    if (!selectedId) return;
    setSegments((s) => removeSegment(s, selectedId));
    setSelectedId(null);
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "s" || e.key === "S") {
        doSplit();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        doDelete();
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
  }, [togglePlay, doSplit, doDelete, seekSrc]);

  /* ------------------------------------------------------------ file load */
  const loadFile = useCallback((f: File) => {
    const v = videoRef.current;
    if (!v) return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(f);
    objectUrl.current = url;
    setFileName(f.name);
    setResult(null);
    setClaims([]);
    setEnv(null);
    setDetection(null);
    setPlaying(false);
    v.src = url;
    v.muted = false;
    v.volume = 1;
    v.playbackRate = 1;
    v.load();
  }, []);

  const onMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const d = v.duration || 0;
    setDuration(d);
    setDims({ w: v.videoWidth, h: v.videoHeight });
    durRef.current = d;
    const asp = v.videoWidth / Math.max(1, v.videoHeight);
    if (targetRef.current === "patreon") {
      setLayout((l) => ({ ...l, sourceMode: asp > 1.9 ? "split" : "single" }));
    }
    setSegments(defaultSegments(d));
    setSelectedId(null);
    try {
      engine().setDirect(targetRef.current === "youtube");
      engine().attach(v, audioRef.current.mic.channel);
      engine().update(audioRef.current);
    } catch {
      /* audio graph already bound to this element */
    }
    seekSrc(0);
  };

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
      const eng = engine();
      eng.resume();
      scanChannelRef.current = channel;
      setScanChannel(channel);
      const ok = eng.startScan(
        durRef.current,
        () => v.currentTime,
        () => v.playbackRate,
        channel
      );
      if (!ok) return;
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

  const doBuildSkeleton = useCallback(() => {
    if (reactionStart === null || !duration) return;
    setSegments(buildSkeleton(duration, reactionStart, leadCfg.leadIn, leadCfg.black).segments);
    setSelectedId(null);
  }, [reactionStart, duration, leadCfg]);

  const doApplyPolish = useCallback(() => {
    if (!duration) return;
    setSegments((s) => applyPolish(s, polishDrops, duration));
    setSelectedId(null);
  }, [polishDrops, duration]);

  const doApplyDisrupt = useCallback(() => {
    if (!disruptions || !duration) return;
    setSegments((s) => applyDisrupt(s, disruptions.drops, duration));
    setSelectedId(null);
  }, [disruptions, duration]);

  const doApplyAllPolish = useCallback(() => {
    if (!duration) return;
    const base = reactionStart !== null
      ? buildSkeleton(duration, reactionStart, leadCfg.leadIn, leadCfg.black).segments
      : defaultSegments(duration);
    const withDrops = applyDisrupt(base, disruptions?.drops ?? [], duration);
    setSegments(applyPolish(withDrops, polishDrops, duration));
    setSelectedId(null);
  }, [duration, reactionStart, leadCfg, disruptions, polishDrops]);

  const applyCut = useCallback(() => {
    if (!detection || !durRef.current) return;
    setSegments((s) => buildCut(s, detection.regions, cutRef.current, durRef.current));
    setSelectedId(null);
  }, [detection]);

  const resetTimeline = useCallback(() => {
    const d = durRef.current;
    const intro = Math.min(4, d * 0.12);
    const outro = Math.min(4, d * 0.12);
    setSegments(
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
  }, []);

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

  const applyClaim = useCallback((c: Claim) => {
    if (c.action === "none") return;
    setSegments((s) =>
      carve(s, c.start, c.end, c.action === "cut" ? "cut" : "mute")
    );
  }, []);

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

  /* -------------------------------------------------------------- render */
  const startExport = async () => {
    const v = videoRef.current;
    const cv = exportRef.current;
    if (!v || !cv || !duration || !outDur || scanningRef.current) return;
    setResult(null);
    setProgress(0);
    lastProgress.current = 0;
    cv.width = res === 1080 ? 1920 : 1280;
    cv.height = res === 1080 ? 1080 : 720;

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
    setSegments((s) => carve(s, t, Math.min(t + len, durRef.current), type));
  };

  const setRect = useCallback((key: "content" | "cam", rect: Rect) => {
    setLayout((l) => ({ ...l, [key]: rect }));
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

  const stageLayers: { key: "content" | "cam"; rect: Rect; name: string }[] =
    isYT || sceneMode === "cut"
      ? []
      : sceneMode === "solo"
      ? [{ key: "cam", rect: { x: 0, y: 0, w: 1, h: 1 }, name: "Camera (full frame)" }]
      : sceneMode === "card" || sceneMode === "lead"
      ? [
          { key: "cam", rect: layout.cam, name: "Camera" },
          { key: "content", rect: layout.content, name: "Card" },
        ]
      : [
          { key: "content", rect: layout.content, name: "Content" },
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
        <Btn onClick={() => fileInput.current?.click()}>
          {fileName ? "Change source" : isYT ? "Open Patreon render" : "Open recording"}
        </Btn>
        {fileName && (
          <span className="hidden min-w-0 items-center gap-2 md:flex">
            <span className="truncate text-[11px] text-slate-400">{fileName}</span>
            <span className="shrink-0 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
              {dims.w}×{dims.h}
            </span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded-lg border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10px] text-slate-400 xl:block">
            render <span className="text-sky-300">{fmtTime(outDur)}</span>
            {removed > 0.05 && <span className="text-rose-300"> · −{fmtTime(removed)}</span>}
            {spedUp > 0.05 && <span className="text-teal-300"> · ⇢{fmtTime(spedUp)}</span>}
          </span>
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
                stutters={micRepeats.stutters}
                rules={polish}
                setRules={setPolish}
                disruptRules={disruptRules}
                setDisruptRules={setDisruptRules}
                lead={leadCfg}
                setLead={setLeadCfg}
                reactionStart={reactionStart}
                onScan={(ch) => void startScan(ch)}
                onStopScan={stopScan}
                onTranscriptFile={onTranscriptFile}
                onTranscriptText={loadTranscript}
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
                setOpts={setCutOpts}
                layout={layout}
                setLayout={setLayout}
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

          <Stage
            canvasRef={previewRef}
            layout={layout}
            onRect={setRect}
            layers={stageLayers}
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
                {isYT ? (
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
                <Btn
                  variant="primary"
                  className="mt-4 px-4 py-2 text-[12px]"
                  onClick={() => fileInput.current?.click()}
                >
                  Choose a video file
                </Btn>
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
                setLayout={setLayout}
                editLayer={editLayer}
                setEditLayer={setEditLayer}
                dims={dims}
                fileName={fileName || "no source loaded"}
                showGuides={showGuides}
                setShowGuides={setShowGuides}
                selected={selected}
                onSegmentType={(t) =>
                  setSegments((s) => s.map((x) => (x.id === selectedId ? { ...x, type: t } : x)))
                }
              />
            )}
            {rightTab === "retouch" && !isYT && (
              <RetouchPanel
                cfg={retouch}
                setCfg={setRetouch}
                status={trackStatus}
                statusText={trackError}
                fps={trackFps}
                onLoad={loadFaceModel}
                showFaceBox={showFaceBox}
                setShowFaceBox={setShowFaceBox}
                manualBox={retouch.manualRect}
                setManualBox={(b) => setRetouch((c) => ({ ...c, manualRect: { ...b } }))}
              />
            )}
            {rightTab === "video" && isYT && (
              <VideoPanel
                fileName={fileName || "no source loaded"}
                dims={dims}
                layout={layout}
                setLayout={setLayout}
              />
            )}
            {rightTab === "audio" && (
              <AudioPanel audio={audio} setAudio={setAudio} getLevels={getLevels} direct={isYT} />
            )}
            {rightTab === "export" && (
              <ExportPanel
                res={res}
                setRes={setRes}
                fps={fps}
                setFps={setFps}
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
          onSelect={setSelectedId}
          onSelectClaim={setSelectedClaim}
          onChange={(s) => setSegments(normalize(s, duration))}
          onSeek={seekSrc}
          onSplit={doSplit}
          onAddSegment={addSegment}
          onDelete={doDelete}
        />
      </div>

      <video
        ref={videoRef}
        className="pointer-events-none fixed -left-[9999px] top-0 h-1 w-1"
        playsInline
        preload="auto"
        onLoadedMetadata={onMeta}
        onError={() => setFileName((n) => n)}
      />
      <canvas
        ref={exportRef}
        className="pointer-events-none fixed -left-[9999px] top-0 h-1 w-1"
      />
    </div>
  );
}
