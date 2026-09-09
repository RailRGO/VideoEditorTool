import { useCallback, useEffect, useRef, useState } from "react";
import { Inspector } from "./components/Inspector";
import { Preview } from "./components/Preview";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { TopBar } from "./components/TopBar";
import { MixEngine } from "./engine/audio";
import { composeFrame } from "./engine/compose";
import { buildAssembly, defaultAssembly } from "./engine/analyze";
import { BeautyEngine, beautyActive } from "./engine/beauty";
import { defaultAudio, defaultBeauty, defaultLayout, OUTPUT_H, OUTPUT_W } from "./lib/defaults";
import { uid } from "./lib/format";
import {
  clampSpanToBody,
  cutsFromKeeps,
  isInCut,
  skipCut,
  sourceToTimeline,
  stageAt,
  timelineDuration,
} from "./lib/timeline";
import type {
  AssemblyMarkers,
  AssemblyOptions,
  AssemblyReport,
  AudioSample,
  AudioSettings,
  BeautySettings,
  CameraHalf,
  InspectorTab,
  LayoutSettings,
  MediaInfo,
  MuteSpan,
  Selection,
  SourceKind,
  Span,
} from "./types";

export default function App() {
  const mainRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const contentRef = useRef<HTMLVideoElement>(null);
  const micRef = useRef<HTMLAudioElement>(null);
  const contentAudioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blurRef = useRef<HTMLCanvasElement | null>(null);
  const mixRef = useRef<MixEngine | null>(null);
  const camWorkRef = useRef<HTMLCanvasElement | null>(null);
  const beautyRef = useRef<BeautyEngine | null>(null);

  const [layout, setLayoutState] = useState<LayoutSettings>(defaultLayout);
  const [beauty, setBeautyState] = useState<BeautySettings>(defaultBeauty);
  const [faceLocked, setFaceLocked] = useState(false);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [audio, setAudioState] = useState<AudioSettings>(defaultAudio);
  const [kind, setKind] = useState<SourceKind>("ultrawide");
  const [cameraHalf, setCameraHalf] = useState<CameraHalf>("left");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [projectName, setProjectName] = useState("Untitled reaction");
  const [playing, setPlaying] = useState(false);
  const [currentSource, setCurrentSource] = useState(0);
  const [intro, setIntro] = useState(6);
  const [outro, setOutro] = useState(8);
  const [cuts, setCuts] = useState<Span[]>([]);
  const [keeps, setKeeps] = useState<Span[]>([]);
  const [mutes, setMutes] = useState<MuteSpan[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("layout");
  const [help, setHelp] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [micDb, setMicDb] = useState(-60);
  const [ducking, setDucking] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [cameraName, setCameraName] = useState<string | null>(null);
  const [contentName, setContentName] = useState<string | null>(null);
  const [micName, setMicName] = useState<string | null>(null);
  const [contentAudioName, setContentAudioName] = useState<string | null>(null);
  const [assemblyOpts, setAssemblyOpts] = useState<AssemblyOptions>(defaultAssembly);
  const [assemblyReport, setAssemblyReport] = useState<AssemblyReport | null>(null);
  const [markers, setMarkers] = useState<AssemblyMarkers | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  const layoutRef = useRef(layout);
  const beautySetRef = useRef(beauty);
  const audioRef = useRef(audio);
  const kindRef = useRef(kind);
  const halfRef = useRef(cameraHalf);
  const cutsRef = useRef(cuts);
  const mutesRef = useRef(mutes);
  const introRef = useRef(intro);
  const outroRef = useRef(outro);
  const playingRef = useRef(playing);
  const exportingRef = useRef(exporting);
  const scanningRef = useRef(scanning);
  const markersRef = useRef(markers);
  const assemblyOptsRef = useRef(assemblyOpts);
  layoutRef.current = layout;
  beautySetRef.current = beauty;
  audioRef.current = audio;
  kindRef.current = kind;
  halfRef.current = cameraHalf;
  cutsRef.current = cuts;
  mutesRef.current = mutes;
  introRef.current = intro;
  outroRef.current = outro;
  playingRef.current = playing;
  exportingRef.current = exporting;
  scanningRef.current = scanning;
  markersRef.current = markers;
  assemblyOptsRef.current = assemblyOpts;

  const duration = media?.duration ?? 0;

  const master = useCallback(() => {
    if (kindRef.current === "dual") {
      return cameraRef.current ?? contentRef.current ?? mainRef.current;
    }
    return mainRef.current;
  }, []);

  const slaves = useCallback(() => {
    const m = master();
    return [cameraRef.current, contentRef.current, micRef.current, contentAudioRef.current].filter(
      (el): el is HTMLMediaElement => !!el && el !== m && !!el.src,
    );
  }, [master]);

  const syncSlaves = useCallback(() => {
    const m = master();
    if (!m) return;
    const t = m.currentTime;
    for (const el of slaves()) {
      if (Math.abs(el.currentTime - t) > 0.12) el.currentTime = t;
    }
  }, [master, slaves]);

  const ensureMix = useCallback(async () => {
    if (!mixRef.current) mixRef.current = new MixEngine();
    const mix = mixRef.current;
    await mix.resume();
    mix.attach({
      main: mainRef.current,
      camera: cameraRef.current,
      content: contentRef.current,
      mic: micRef.current,
      contentAudio: contentAudioRef.current,
      kind: kindRef.current,
      settings: audioRef.current,
    });
  }, []);

  const seekSource = useCallback(
    (t: number) => {
      const m = master();
      if (!m) return;
      const next = skipCut(Math.max(0, Math.min(t, duration || m.duration || 0)), cutsRef.current);
      m.currentTime = next;
      setCurrentSource(next);
      syncSlaves();
    },
    [duration, master, syncSlaves],
  );

  const playAll = useCallback(async () => {
    await ensureMix();
    const m = master();
    if (!m?.src) {
      setPlaying(true);
      return;
    }
    if (isInCut(m.currentTime, cutsRef.current)) {
      m.currentTime = skipCut(m.currentTime, cutsRef.current);
    }
    await m.play();
    for (const el of slaves()) {
      el.currentTime = m.currentTime;
      el.play().catch(() => undefined);
    }
    setPlaying(true);
  }, [ensureMix, master, slaves]);

  const pauseAll = useCallback(() => {
    master()?.pause();
    slaves().forEach((el) => el.pause());
    setPlaying(false);
  }, [master, slaves]);

  const toggle = useCallback(() => {
    if (exportingRef.current || scanningRef.current) return;
    if (playingRef.current) pauseAll();
    else playAll();
  }, [pauseAll, playAll]);

  useEffect(() => {
    if (!blurRef.current) blurRef.current = document.createElement("canvas");
    if (!camWorkRef.current) camWorkRef.current = document.createElement("canvas");
    if (!beautyRef.current) beautyRef.current = new BeautyEngine();
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = OUTPUT_W;
      canvas.height = OUTPUT_H;
    }
    let raf = 0;
    let lastUi = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const ctx = canvasRef.current?.getContext("2d");
      const blur = blurRef.current;
      if (!ctx || !blur) return;
      const m = master();
      if (m && m.src) {
        if (
          playingRef.current &&
          !scanningRef.current &&
          isInCut(m.currentTime, cutsRef.current)
        ) {
          m.currentTime = skipCut(m.currentTime, cutsRef.current);
          syncSlaves();
        }
        const mix = mixRef.current;
        let meterDb = -60;
        let speaking = false;
        if (mix) {
          const t = m.currentTime;
          const mutedMic = mutesRef.current.some((x) => x.track === "mic" && t >= x.start && t < x.end);
          const mutedContent = mutesRef.current.some(
            (x) => x.track === "content" && t >= x.start && t < x.end,
          );
          mix.applySettings(audioRef.current, mutedMic, mutedContent);
          if (scanningRef.current) mix.master.gain.value = 0;
          const meter = mix.tickDucking(audioRef.current);
          meterDb = meter.db;
          speaking = meter.speaking;
        }
        const now = performance.now();
        if (now - lastUi > 80) {
          lastUi = now;
          setCurrentSource(m.currentTime);
          setMicDb(meterDb);
          setDucking(speaking);
          setFaceLocked(Boolean(beautyRef.current?.locked));
          if (exportingRef.current) {
            const d = m.duration || 0;
            const td = timelineDuration(d, cutsRef.current);
            const tt = sourceToTimeline(m.currentTime, d, cutsRef.current);
            if (td > 0) setExportProgress(Math.min(1, tt / td));
          }
        }
      }
      const sourceT = m?.currentTime ?? 0;
      const dur = m?.duration || duration || 0;
      const tDur = timelineDuration(dur, cutsRef.current);
      const tTime = sourceToTimeline(sourceT, dur, cutsRef.current);
      let stage = stageAt(tTime, tDur, introRef.current, outroRef.current);
      let contentBlack = false;
      const mk = markersRef.current;
      if (mk) {
        if (sourceT < mk.layoutSwitch) stage = "intro";
        else if (sourceT >= mk.outroAt) stage = "outro";
        else stage = "reaction";
        contentBlack = sourceT >= mk.layoutSwitch && sourceT < mk.contentReveal;
      }
      composeFrame({
        ctx,
        blurCanvas: blur,
        mode: stage,
        layout: layoutRef.current,
        kind: kindRef.current,
        cameraHalf: halfRef.current,
        main: mainRef.current,
        camera: cameraRef.current,
        content: contentRef.current,
        timeMs: performance.now(),
        contentBlack,
        camWork: camWorkRef.current ?? undefined,
        beauty: beautyRef.current,
        beautySettings: beautySetRef.current,
      });
      if (beautyActive(beautySetRef.current) && beautyRef.current && !beautyRef.current.ready && !beautyRef.current.loading) {
        void beautyRef.current.ensure().then(() => setFaceError(beautyRef.current?.error ?? null));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration, master, syncSlaves]);

  useEffect(() => {
    mixRef.current?.applyChannelMap(audio);
  }, [audio.swapChannels, audio.micChannel, audio.contentChannel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        seekSource((master()?.currentTime ?? 0) - (e.shiftKey ? 5 : 1));
      } else if (e.key === "ArrowRight") {
        seekSource((master()?.currentTime ?? 0) + (e.shiftKey ? 5 : 1));
      } else if (e.key === "Home") {
        seekSource(0);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selection && selection.end - selection.start > 0.05) liftSelection();
      } else if (e.key === "?") {
        setHelp((h) => !h);
      } else if (e.key === "Escape") {
        setHelp(false);
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seekSource, master, selection]);

  function loadInto(el: HTMLMediaElement | null, file: File, onMeta?: (v: HTMLMediaElement) => void) {
    if (!el) return;
    const url = URL.createObjectURL(file);
    el.src = url;
    el.onerror = () => {
      setLoadError(
        "This browser cannot decode that file. From OBS, remux or export MP4 (H.264). MKV and HEVC often fail in Chrome.",
      );
    };
    el.onloadedmetadata = () => {
      setLoadError(null);
      onMeta?.(el);
    };
  }

  function loadMain(file: File) {
    setProjectName(file.name.replace(/\.[^.]+$/, ""));
    loadInto(mainRef.current, file, (v) => {
      const width = (v as HTMLVideoElement).videoWidth || 0;
      const height = (v as HTMLVideoElement).videoHeight || 0;
      setMedia({
        name: file.name,
        width,
        height,
        duration: v.duration || 0,
        size: file.size,
      });
      if (width / Math.max(height, 1) > 2.3) {
        setKind("ultrawide");
      }
    });
  }

  function onPickMain() {
    pickFile("video/*", loadMain);
  }

  function liftSelection() {
    if (!selection) return;
    const clamped = clampSpanToBody(selection, duration, intro, outro);
    if (!clamped) return;
    setCuts((c) => [...c, { id: uid("cut"), ...clamped }]);
    setSelection(null);
  }

  function keepSelection() {
    if (!selection) return;
    const clamped = clampSpanToBody(selection, duration, intro, outro);
    if (!clamped) return;
    setKeeps((k) => [...k, { id: uid("keep"), ...clamped }]);
    setSelection(null);
  }

  function applyKeeps() {
    if (!keeps.length) return;
    setCuts(cutsFromKeeps(duration, intro, outro, keeps, () => uid("cut")));
  }

  function clearCutsAndKeeps() {
    setCuts([]);
    setKeeps([]);
    setMutes([]);
    setSelection(null);
    setMarkers(null);
  }

  function muteSelection(track: "mic" | "content") {
    if (!selection || selection.end - selection.start < 0.05) return;
    setMutes((m) => [...m, { id: uid("mute"), start: selection.start, end: selection.end, track }]);
  }

  async function scanRecording() {
    const m = master();
    if (!m?.src || scanning) return;
    pauseAll();
    setScanning(true);
    setScanProgress(0);
    scanningRef.current = true;
    setTab("auto");
    const samples: AudioSample[] = [];
    try {
      await ensureMix();
      const mix = mixRef.current;
      if (!mix) throw new Error("mix");
      await mix.resume();
      mix.master.gain.value = 0;
      const dur = m.duration || duration;
      m.pause();
      m.currentTime = 0;
      syncSlaves();
      const rate = Math.max(2, assemblyOptsRef.current.scanRate);
      m.playbackRate = rate;
      slaves().forEach((el) => {
        el.playbackRate = rate;
      });
      await m.play();
      for (const el of slaves()) {
        el.currentTime = m.currentTime;
        el.play().catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        const id = window.setInterval(() => {
          const pair = mix.rmsPair();
          samples.push({ t: m.currentTime, mic: pair.mic, content: pair.content });
          const p = dur > 0 ? m.currentTime / dur : 0;
          setScanProgress(Math.min(1, p));
          if (m.ended || m.currentTime >= dur - 0.08) {
            window.clearInterval(id);
            resolve();
          }
        }, 8);
      });
      const report = buildAssembly(samples, dur, assemblyOptsRef.current);
      setAssemblyReport(report);
    } catch {
      setAssemblyReport(null);
    } finally {
      m.pause();
      m.playbackRate = 1;
      slaves().forEach((el) => {
        el.pause();
        el.playbackRate = 1;
      });
      m.currentTime = 0;
      syncSlaves();
      scanningRef.current = false;
      setScanning(false);
      setScanProgress(1);
      setPlaying(false);
    }
  }

  function applyAssembly() {
    if (!assemblyReport) return;
    setCuts(assemblyReport.cuts.map((c) => ({ id: uid("cut"), start: c.start, end: c.end })));
    setMarkers(assemblyReport.markers);
    setIntro(assemblyReport.markers.layoutSwitch);
    setOutro(Math.max(0, duration - assemblyReport.markers.outroAt));
    setKeeps([]);
  }

  async function exportProgram() {
    const canvas = canvasRef.current;
    const m = master();
    if (!canvas || !m?.src || exporting) return;
    await ensureMix();
    const mix = mixRef.current;
    if (!mix) return;
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const stream = canvas.captureStream(30);
    const mixed = new MediaStream([
      ...stream.getVideoTracks(),
      ...mix.recordDest.stream.getAudioTracks(),
    ]);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(mixed, {
        mimeType: mime || undefined,
        videoBitsPerSecond: 12_000_000,
        audioBitsPerSecond: 192_000,
      } as MediaRecorderOptions);
    } catch {
      rec = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      const a = document.createElement("a");
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      a.href = URL.createObjectURL(blob);
      a.download = `${projectName || "twinframe"}.${ext}`;
      a.click();
      setExporting(false);
      setExportProgress(0);
      pauseAll();
    };
    setExporting(true);
    setExportProgress(0);
    const first = skipCut(0, cutsRef.current);
    m.currentTime = first;
    syncSlaves();
    rec.start(250);
    await playAll();
    const stopWhenDone = () => {
      const dur = m.duration || duration;
      const tDur = timelineDuration(dur, cutsRef.current);
      const tTime = sourceToTimeline(m.currentTime, dur, cutsRef.current);
      if (tTime >= tDur - 0.08 || m.ended) {
        rec.stop();
        m.removeEventListener("timeupdate", stopWhenDone);
        m.removeEventListener("ended", stopWhenDone);
      }
    };
    m.addEventListener("timeupdate", stopWhenDone);
    m.addEventListener("ended", stopWhenDone);
  }

  const tDur = timelineDuration(duration, cuts);
  let stage = stageAt(
    sourceToTimeline(currentSource, duration, cuts),
    tDur,
    intro,
    outro,
  );
  if (markers) {
    if (currentSource < markers.layoutSwitch) stage = "intro";
    else if (currentSource >= markers.outroAt) stage = "outro";
    else stage = "reaction";
  }

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-[#07080c] text-zinc-100"
      onDragOver={(e) => {
        e.preventDefault();
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropOver(false);
        const file = e.dataTransfer.files[0];
        if (file?.type.startsWith("video/")) loadMain(file);
      }}
    >
      <video
        ref={mainRef}
        className="pointer-events-none fixed -left-[9999px] h-[90px] w-[160px]"
        playsInline
        preload="auto"
        onEnded={() => {
          if (!exportingRef.current) setPlaying(false);
        }}
      />
      <video ref={cameraRef} className="pointer-events-none fixed -left-[9999px] h-[90px] w-[160px]" playsInline preload="auto" />
      <video ref={contentRef} className="pointer-events-none fixed -left-[9999px] h-[90px] w-[160px]" playsInline preload="auto" />
      <audio ref={micRef} className="hidden" preload="auto" />
      <audio ref={contentAudioRef} className="hidden" preload="auto" />

      <TopBar
        projectName={projectName}
        onExport={() => void exportProgram()}
        exporting={exporting}
        canExport={!!media}
        onHelp={() => setHelp(true)}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          media={media}
          kind={kind}
          cameraHalf={cameraHalf}
          onKind={setKind}
          onHalf={setCameraHalf}
          onPickMain={onPickMain}
          onPickCamera={() =>
            pickFile("video/*", (f) => {
              setCameraName(f.name);
              setKind("dual");
              loadInto(cameraRef.current, f, (v) => {
                if (!media) {
                  setMedia({
                    name: f.name,
                    width: (v as HTMLVideoElement).videoWidth,
                    height: (v as HTMLVideoElement).videoHeight,
                    duration: v.duration,
                    size: f.size,
                  });
                  setProjectName(f.name.replace(/\.[^.]+$/, ""));
                }
              });
            })
          }
          onPickContent={() =>
            pickFile("video/*", (f) => {
              setContentName(f.name);
              loadInto(contentRef.current, f);
            })
          }
          onPickMic={() =>
            pickFile("audio/*,video/*", (f) => {
              setMicName(f.name);
              loadInto(micRef.current, f);
            })
          }
          onPickContentAudio={() =>
            pickFile("audio/*,video/*", (f) => {
              setContentAudioName(f.name);
              loadInto(contentAudioRef.current, f);
            })
          }
          micName={micName}
          contentAudioName={contentAudioName}
          cameraName={cameraName}
          contentName={contentName}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Preview
            canvasRef={canvasRef}
            playing={playing}
            current={sourceToTimeline(currentSource, duration, cuts)}
            duration={tDur}
            stage={stage}
            onToggle={toggle}
            onStop={() => {
              pauseAll();
              seekSource(0);
            }}
            onSkip={(d) => seekSource((master()?.currentTime ?? 0) + d)}
            ducking={ducking}
            micDb={micDb}
            exporting={exporting}
            exportProgress={exportProgress}
            scanning={scanning}
            scanProgress={scanProgress}
            faceLocked={faceLocked}
          />
          <Timeline
            duration={duration > 0 ? duration : 60}
            currentSource={currentSource}
            cuts={cuts}
            keeps={keeps}
            mutes={mutes}
            intro={intro}
            outro={outro}
            selection={selection}
            onSeekSource={seekSource}
            onSelect={setSelection}
            onIntro={setIntro}
            onOutro={setOutro}
            markers={markers}
          />
        </div>

        <Inspector
          tab={tab}
          onTab={setTab}
          layout={layout}
          setLayout={(patch) => setLayoutState((l) => ({ ...l, ...patch }))}
          audio={audio}
          setAudio={(patch) =>
            setAudioState((a) => (typeof patch === "function" ? patch(a) : { ...a, ...patch }))
          }
          intro={intro}
          outro={outro}
          setIntro={setIntro}
          setOutro={setOutro}
          onLift={liftSelection}
          onMute={muteSelection}
          onKeep={keepSelection}
          onApplyKeeps={applyKeeps}
          onClearCuts={clearCutsAndKeeps}
          selection={selection}
          cutCount={cuts.length}
          muteCount={mutes.length}
          keepCount={keeps.length}
          programDuration={tDur}
          sourceBytes={media?.size ?? 0}
          loadError={loadError}
          assembly={{
            scanning,
            progress: scanProgress,
            report: assemblyReport,
            options: assemblyOpts,
            setOptions: (p) => setAssemblyOpts((o) => ({ ...o, ...p })),
            onScan: () => void scanRecording(),
            onApply: applyAssembly,
            hasMedia: Boolean(media),
          }}
          beauty={beauty}
          setBeauty={(patch) =>
            setBeautyState((b) => (typeof patch === "function" ? patch(b) : { ...b, ...patch }))
          }
          faceLocked={faceLocked}
          faceError={faceError}
        />
      </div>

      {dropOver ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/55">
          <div className="rounded-2xl border border-amber-200/40 bg-[#12151c] px-8 py-6 font-serif text-2xl text-amber-100">
            Drop recording to ingest
          </div>
        </div>
      ) : null}

      {help ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6"
          onClick={() => setHelp(false)}
        >
          <div
            className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#12151d] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-serif text-2xl text-zinc-100">Shortcuts & scope</div>
            <ul className="mt-4 space-y-2 font-mono text-sm text-zinc-400">
              <li>Space — play / pause</li>
              <li>← → — nudge 1s · Shift 5s</li>
              <li>Home — return to start</li>
              <li>Shift-drag — selection · Delete — lift</li>
              <li>? — this panel</li>
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-zinc-500">
              Auto assembly scans mic vs content audio on this machine: last intro take, pause cleanup, layout switch with a black content hold, stall/rewind cuts. Then export the Patreon master. YouTube keeps are optional after.
            </p>
            <button
              type="button"
              className="mt-5 rounded-xl bg-amber-200 px-4 py-2 text-sm font-semibold text-zinc-950"
              onClick={() => setHelp(false)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function pickFile(accept: string, cb: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) cb(file);
  };
  input.click();
}
