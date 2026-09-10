import { defaultAudio, type AudioState } from "./types";

export interface Levels {
  mic: number;
  content: number;
  reduction: number;
  ducking: number;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);

/**
 * Web Audio graph for a stereo OBS recording where mic and content audio are
 * recorded as separate channels of one file:
 *
 *   source ──► splitter ─┬─ mic: gain ► pan ► compressor ► limiter ► makeup ─┬─ master
 *                        │                                                └► analyser
 *                        └─ content: gain ► duckGain ──────────────────────┬─ master
 *                                                                         └► analyser
 *
 * `duckGain` is driven from the post-compressor mic level (side-chain style).
 *
 * `direct` mode is for a finished, already-mixed stereo file (the YouTube job,
 * cut from the Patreon render): the source goes straight to master untouched,
 * and mute / card segments simply silence the programme.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  streamDest: MediaStreamAudioDestinationNode | null = null;

  private video: HTMLVideoElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private micIn: GainNode | null = null;
  private micPan: StereoPannerNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private makeup: GainNode | null = null;
  private micMeter: AnalyserNode | null = null;
  private contentIn: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private contentMeter: AnalyserNode | null = null;
  private master: GainNode | null = null;
  private safety: DynamicsCompressorNode | null = null;
  private fastTrim: GainNode | null = null;
  /** direct (mixed-file) path: source -> directGain -> directTrim -> master */
  private directGain: GainNode | null = null;
  private directTrim: GainNode | null = null;
  private direct = false;

  /* --- mic loudness scanner ------------------------------------------- */
  scanning = false;
  binMs = 50;
  scanBins = 0;
  private micChannel: "left" | "right" = "left";
  private lastState: AudioState = defaultAudio;
  private lastFastDb = 0;
  private scanSum: Float32Array | null = null;
  private scanCount: Float32Array | null = null;
  private scanNode: ScriptProcessorNode | null = null;
  private scanSink: GainNode | null = null;

  private micBuf = new Float32Array(1024);
  private contentBuf = new Float32Array(1024);
  private holdUntil = 0;
  private duckingNow = 0;
  private readonly levels: Levels = { mic: -60, content: -60, reduction: 0, ducking: 0 };

  attach(video: HTMLVideoElement, micChannel: "left" | "right") {
    if (this.video === video && this.ctx) {
      this.setMicChannel(micChannel);
      return;
    }
    this.video = video;
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.source = ctx.createMediaElementSource(video);
    this.splitter = ctx.createChannelSplitter(2);

    this.micIn = ctx.createGain();
    this.micPan = ctx.createStereoPanner();
    this.comp = ctx.createDynamicsCompressor();
    this.limiter = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();
    this.micMeter = ctx.createAnalyser();

    this.contentIn = ctx.createGain();
    this.duckGain = ctx.createGain();
    this.contentMeter = ctx.createAnalyser();

    this.master = ctx.createGain();
    this.safety = ctx.createDynamicsCompressor();
    this.streamDest = ctx.createMediaStreamDestination();

    for (const a of [this.micMeter, this.contentMeter]) {
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.2;
    }
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.06;
    this.safety.threshold.value = -1.5;
    this.safety.ratio.value = 12;
    this.safety.attack.value = 0.003;
    this.safety.release.value = 0.12;
    this.safety.knee.value = 0;

    this.source.connect(this.splitter);

    this.micIn.connect(this.micPan);
    this.micPan.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.makeup);
    this.makeup.connect(this.master);
    this.makeup.connect(this.micMeter);

    this.fastTrim = ctx.createGain();
    this.contentIn.connect(this.duckGain);
    this.duckGain.connect(this.fastTrim);
    this.fastTrim.connect(this.master);
    this.duckGain.connect(this.contentMeter);

    this.master.connect(this.safety);
    this.safety.connect(ctx.destination);
    this.safety.connect(this.streamDest);

    // mixed-file path, silent until direct mode is switched on
    this.directGain = ctx.createGain();
    this.directGain.gain.value = 0;
    this.directTrim = ctx.createGain();
    this.source.connect(this.directGain);
    this.directGain.connect(this.directTrim);
    this.directTrim.connect(this.master);
    this.directTrim.connect(this.micMeter);
    this.directTrim.connect(this.contentMeter);

    this.setMicChannel(micChannel);
  }

  setMicChannel(micChannel: "left" | "right") {
    this.micChannel = micChannel;
    if (!this.splitter || !this.micIn || !this.contentIn) return;
    try {
      this.splitter.disconnect();
    } catch {
      /* ignore */
    }
    const micIdx = micChannel === "left" ? 0 : 1;
    const contentIdx = micIdx === 0 ? 1 : 0;
    this.splitter.connect(this.micIn, micIdx, 0);
    this.splitter.connect(this.contentIn, contentIdx, 0);
  }

  /** true = mixed stereo file straight to master, false = split mic/content buses */
  setDirect(d: boolean) {
    this.direct = d;
  }

  get isDirect() {
    return this.direct;
  }

  resume() {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
  }

  /**
   * Pass 1 of the auto-cut: play the recording (fast, silently) and record the
   * RMS of the raw mic channel into fixed-size time bins. Every sample block is
   * accounted for, so short bursts of commentary aren't missed the way they
   * would be if we only polled a meter once per animation frame.
   */
  startScan(
    duration: number,
    getTime: () => number,
    getRate: () => number,
    channel: "mic" | "content" = "mic"
  ): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.splitter || !this.master) return false;
    if (typeof ctx.createScriptProcessor !== "function") return false;
    this.stopScan();

    const bins = Math.ceil((duration * 1000) / this.binMs) + 8;
    this.scanSum = new Float32Array(bins);
    this.scanCount = new Float32Array(bins);
    this.scanBins = bins;

    const node = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    // tap the raw channel straight off the splitter, before any processing
    const micIdx = this.micChannel === "left" ? 0 : 1;
    const tapIdx = channel === "mic" ? micIdx : micIdx === 0 ? 1 : 0;
    try {
      this.splitter.connect(node, tapIdx, 0);
    } catch {
      sink.disconnect();
      return false;
    }

    node.onaudioprocess = (e: AudioProcessingEvent) => {
      const sum = this.scanSum;
      const count = this.scanCount;
      if (!sum || !count) return;
      const d = e.inputBuffer.getChannelData(0);
      let ss = 0;
      for (let i = 0; i < d.length; i++) ss += d[i] * d[i];
      const rms = ss / d.length;
      const rate = Math.max(0.0625, getRate());
      // how much media time this real-time block covered
      const mediaDur = e.inputBuffer.duration / rate;
      const tEnd = getTime();
      const i0 = Math.max(0, Math.floor(((tEnd - mediaDur) * 1000) / this.binMs));
      const i1 = Math.min(sum.length - 1, Math.ceil((tEnd * 1000) / this.binMs));
      for (let i = i0; i <= i1; i++) {
        sum[i] += rms;
        count[i] += 1;
      }
    };

    this.scanNode = node;
    this.scanSink = sink;
    this.scanning = true;
    this.update(this.lastState, this.lastFastDb);
    return true;
  }

  stopScan(): Float32Array[] | null {
    this.scanning = false;
    const node = this.scanNode;
    if (node && this.splitter) {
      try {
        this.splitter.disconnect(node);
      } catch {
        /* ignore */
      }
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
      node.onaudioprocess = null;
    }
    if (this.scanSink) {
      try {
        this.scanSink.disconnect();
      } catch {
        /* ignore */
      }
      this.scanSink = null;
    }
    this.scanNode = null;
    const out = this.scanSum && this.scanCount ? [this.scanSum, this.scanCount] : null;
    this.scanSum = null;
    this.scanCount = null;
    this.update(this.lastState, this.lastFastDb);
    return out;
  }

  update(state: AudioState, fastGainDb = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.lastFastDb = fastGainDb;
    const t = ctx.currentTime;
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.02);

    ramp(this.micIn!.gain, this.direct ? 0 : dbToLin(state.mic.gain));
    ramp(this.micPan!.pan, state.mic.pan);
    ramp(this.contentIn!.gain, this.direct ? 0 : dbToLin(state.content.gain));
    ramp(this.fastTrim!.gain, dbToLin(fastGainDb));
    ramp(this.directGain!.gain, this.direct ? dbToLin(fastGainDb) : 0);
    // the scan plays at several times normal speed — don't blast it out loud
    ramp(this.master!.gain, this.scanning ? 0 : dbToLin(state.master.gain));

    const c = state.mic.comp;
    if (c.on) {
      ramp(this.comp!.threshold, c.threshold);
      ramp(this.comp!.ratio, c.ratio);
      ramp(this.comp!.knee, c.knee);
      ramp(this.comp!.attack, Math.max(0, c.attack) / 1000);
      ramp(this.comp!.release, Math.max(0, c.release) / 1000);
      ramp(this.limiter!.threshold, state.mic.limiter);
      ramp(this.makeup!.gain, dbToLin(c.makeup));
    } else {
      ramp(this.comp!.threshold, 0);
      ramp(this.comp!.ratio, 1);
      ramp(this.limiter!.threshold, 0);
      ramp(this.makeup!.gain, 1);
    }
  }

  /** Called every animation frame: reads the mic level and applies ducking. */
  tick(state: AudioState, contentMuted: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.duckGain) return this.levels;
    if (this.direct) {
      // mixed file: mute / card segments silence the whole programme
      this.duckingNow = 0;
      this.directTrim!.gain.setTargetAtTime(contentMuted ? 0 : 1, ctx.currentTime, 0.01);
      return this.levels;
    }
    const micDb = this.levels.mic;
    const duck = state.content.duck;
    const now = ctx.currentTime;

    let target = 1;
    let active = false;
    if (contentMuted) {
      target = 0;
    } else if (duck.on) {
      if (micDb > duck.threshold) {
        this.holdUntil = now + Math.max(0.01, duck.hold / 1000);
        active = true;
      } else if (now < this.holdUntil) {
        active = true;
      }
      if (active) target = dbToLin(-duck.depth);
    }
    this.duckingNow = active ? 1 : 0;

    const tc = Math.max(
      0.005,
      (active ? duck.attack : duck.release) / 3000
    );
    this.duckGain.gain.setTargetAtTime(target, now, tc);
    return this.levels;
  }

  read(): Levels {
    if (this.micMeter) {
      this.micMeter.getFloatTimeDomainData(this.micBuf);
      this.levels.mic = peakDb(this.micBuf);
    }
    if (this.contentMeter) {
      this.contentMeter.getFloatTimeDomainData(this.contentBuf);
      this.levels.content = peakDb(this.contentBuf);
    }
    this.levels.reduction = this.comp ? this.comp.reduction : 0;
    this.levels.ducking = this.duckingNow;
    return this.levels;
  }
}

function peakDb(buf: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak > 0.00002 ? 20 * Math.log10(peak) : -60;
}
