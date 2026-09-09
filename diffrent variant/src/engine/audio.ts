import { dbToLinear } from "../lib/format";
import type { AudioSettings, SourceKind } from "../types";

export class MixEngine {
  ctx: AudioContext;
  master: GainNode;
  micIn: GainNode;
  contentIn: GainNode;
  compressor: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
  makeup: GainNode;
  analyser: AnalyserNode;
  micMeter: AnalyserNode;
  contentMeter: AnalyserNode;
  recordDest: MediaStreamAudioDestinationNode;
  private merger: ChannelMergerNode;
  private duckGain: GainNode;
  private splitter: ChannelSplitterNode | null = null;
  private splitMicGain: GainNode;
  private splitContentGain: GainNode;
  private camMicGain: GainNode;
  private camContentGain: GainNode;
  private fileMicGain: GainNode;
  private fileContentGain: GainNode;
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private hooked = new WeakSet<HTMLMediaElement>();
  private timeData: Float32Array;
  private micTime: Float32Array;
  private contentTime: Float32Array;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.micIn = this.ctx.createGain();
    this.contentIn = this.ctx.createGain();
    this.compressor = this.ctx.createDynamicsCompressor();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.makeup = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.micMeter = this.ctx.createAnalyser();
    this.contentMeter = this.ctx.createAnalyser();
    this.duckGain = this.ctx.createGain();
    this.recordDest = this.ctx.createMediaStreamDestination();
    this.merger = this.ctx.createChannelMerger(2);
    this.splitMicGain = this.ctx.createGain();
    this.splitContentGain = this.ctx.createGain();
    this.camMicGain = this.ctx.createGain();
    this.camContentGain = this.ctx.createGain();
    this.fileMicGain = this.ctx.createGain();
    this.fileContentGain = this.ctx.createGain();

    this.analyser.fftSize = 2048;
    this.micMeter.fftSize = 1024;
    this.contentMeter.fftSize = 1024;
    this.timeData = new Float32Array(this.analyser.fftSize);
    this.micTime = new Float32Array(this.micMeter.fftSize);
    this.contentTime = new Float32Array(this.contentMeter.fftSize);

    this.splitMicGain.connect(this.micIn);
    this.camMicGain.connect(this.micIn);
    this.fileMicGain.connect(this.micIn);
    this.splitContentGain.connect(this.contentIn);
    this.camContentGain.connect(this.contentIn);
    this.fileContentGain.connect(this.contentIn);

    this.splitMicGain.gain.value = 1;
    this.splitContentGain.gain.value = 1;
    this.camMicGain.gain.value = 0;
    this.camContentGain.gain.value = 0;
    this.fileMicGain.gain.value = 0;
    this.fileContentGain.gain.value = 0;

    this.micIn.connect(this.micMeter);
    this.micIn.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.makeup);
    this.makeup.connect(this.analyser);
    this.analyser.connect(this.merger, 0, 0);
    this.analyser.connect(this.merger, 0, 1);

    this.contentIn.connect(this.duckGain);
    this.duckGain.connect(this.merger, 0, 0);
    this.duckGain.connect(this.merger, 0, 1);

    this.merger.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.master.connect(this.recordDest);
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  private sourceFor(el: HTMLMediaElement) {
    let node = this.sources.get(el);
    if (!node) {
      node = this.ctx.createMediaElementSource(el);
      this.sources.set(el, node);
    }
    return node;
  }

  attach(opts: {
    main: HTMLMediaElement | null;
    camera: HTMLMediaElement | null;
    content: HTMLMediaElement | null;
    mic: HTMLMediaElement | null;
    contentAudio: HTMLMediaElement | null;
    kind: SourceKind;
    settings: AudioSettings;
  }) {
    const hook = (el: HTMLMediaElement | null, connect: (node: MediaElementAudioSourceNode) => void) => {
      if (!el?.src || this.hooked.has(el)) return;
      connect(this.sourceFor(el));
      this.hooked.add(el);
    };

    hook(opts.main, (node) => {
      if (!this.splitter) this.splitter = this.ctx.createChannelSplitter(2);
      node.connect(this.splitter);
    });
    hook(opts.camera, (node) => node.connect(this.camMicGain));
    hook(opts.content, (node) => node.connect(this.camContentGain));
    hook(opts.mic, (node) => node.connect(this.fileMicGain));
    hook(opts.contentAudio, (node) => node.connect(this.fileContentGain));

    this.applyChannelMap(opts.settings);

    const hasMicFile = Boolean(opts.mic?.src);
    const hasContentFile = Boolean(opts.contentAudio?.src);
    const dual = opts.kind === "dual" && Boolean(opts.camera?.src || opts.content?.src);

    this.fileMicGain.gain.value = hasMicFile ? 1 : 0;
    this.camMicGain.gain.value = !hasMicFile && dual ? 1 : 0;
    this.splitMicGain.gain.value = !hasMicFile && !dual ? 1 : 0;

    this.fileContentGain.gain.value = hasContentFile ? 1 : 0;
    this.camContentGain.gain.value = !hasContentFile && dual ? 1 : 0;
    this.splitContentGain.gain.value = !hasContentFile && !dual ? 1 : 0;
  }

  applyChannelMap(settings: AudioSettings) {
    if (!this.splitter) return;
    const micCh = settings.swapChannels ? 1 - settings.micChannel : settings.micChannel;
    const contentCh = settings.swapChannels ? 1 - settings.contentChannel : settings.contentChannel;
    try {
      this.splitter.disconnect();
    } catch {
      /* ignore */
    }
    this.splitter.connect(this.splitMicGain, micCh);
    this.splitter.connect(this.splitContentGain, contentCh);
  }

  applySettings(settings: AudioSettings, mutedMic: boolean, mutedContent: boolean) {
    this.micIn.gain.value = mutedMic ? 0 : settings.micGain;
    this.contentIn.gain.value = mutedContent ? 0 : settings.contentGain;
    this.master.gain.value = settings.masterGain;

    const c = settings.compressor;
    this.compressor.threshold.value = c.enabled ? c.threshold : 0;
    this.compressor.ratio.value = c.enabled ? c.ratio : 1;
    this.compressor.attack.value = c.attack;
    this.compressor.release.value = c.release;
    this.compressor.knee.value = c.knee;
    this.makeup.gain.value = c.enabled ? dbToLinear(c.makeup) : 1;

    const l = settings.limiter;
    this.limiter.threshold.value = l.enabled ? l.threshold : 0;
    this.limiter.ratio.value = l.enabled ? 20 : 1;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.05;
    this.limiter.knee.value = 0.5;
  }

  tickDucking(settings: AudioSettings) {
    this.analyser.getFloatTimeDomainData(this.timeData as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    const db = 20 * Math.log10(rms + 1e-8);
    if (!settings.ducking.enabled) {
      this.duckGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
      return { rms, db, speaking: false, duck: 1 };
    }
    const speaking = db > settings.ducking.threshold;
    const depthLin = dbToLinear(-settings.ducking.depth);
    const target = speaking ? depthLin : 1;
    const tc = speaking
      ? Math.max(0.01, settings.ducking.attack)
      : Math.max(0.02, settings.ducking.release);
    this.duckGain.gain.setTargetAtTime(target, this.ctx.currentTime, tc);
    return { rms, db, speaking, duck: target };
  }

  rmsPair() {
    this.micMeter.getFloatTimeDomainData(this.micTime as Float32Array<ArrayBuffer>);
    this.contentMeter.getFloatTimeDomainData(this.contentTime as Float32Array<ArrayBuffer>);
    const rms = (buf: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    };
    return { mic: rms(this.micTime), content: rms(this.contentTime) };
  }
}
