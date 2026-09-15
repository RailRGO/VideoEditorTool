import { defaultAudio, type AudioCloak, type AudioState } from "./types";

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
  /** the morph preset's preview numbers, while the engine is "morph" */
  private morphPreview: { pitch: number; lo: number; hi: number } | null = null;
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
  /** direct (mixed-file) path: source -> directGain -> cloak -> directTrim -> master */
  private directGain: GainNode | null = null;
  private directTrim: GainNode | null = null;
  private direct = false;

  /* --- anti-fingerprint cloak (direct path only) ------------------------- */
  private cloakIn: GainNode | null = null;
  private shiftDry: GainNode | null = null;
  private shiftWetA: GainNode | null = null;
  private shiftWetB: GainNode | null = null;
  private shiftSum: GainNode | null = null;
  private shiftDelayA: DelayNode | null = null;
  private shiftDelayB: DelayNode | null = null;
  private lfoSaw: OscillatorNode | null = null;
  private lfoSq: OscillatorNode | null = null;
  private depthA: GainNode | null = null;
  private depthB: GainNode | null = null;
  private xfadeA: GainNode | null = null;
  private xfadeB: GainNode | null = null;
  private chorusDry: GainNode | null = null;
  private chorusWet: GainNode | null = null;
  private chorusSum: GainNode | null = null;
  private chorusDelay: DelayNode | null = null;
  private chorusLfo: OscillatorNode | null = null;
  private chorusDepth: GainNode | null = null;
  private tiltLo: BiquadFilterNode | null = null;
  private tiltHi: BiquadFilterNode | null = null;
  private verbDry: GainNode | null = null;
  private verbWet: GainNode | null = null;
  private verbSum: GainNode | null = null;
  private verb: ConvolverNode | null = null;
  private haasSplit: ChannelSplitterNode | null = null;
  private haasMerge: ChannelMergerNode | null = null;
  private haasDelay: DelayNode | null = null;

  /* --- intro/outro clean-bypass gates (direct path) ---------------------- */
  private cloakDry: GainNode | null = null;
  private cloakGate: GainNode | null = null;
  private cloakClean = false;

  /* --- voice changer (complete voice transformation) -------------------- */
  private voiceIn: GainNode | null = null;
  private voiceDry: GainNode | null = null;
  private voiceWetA: GainNode | null = null;
  private voiceWetB: GainNode | null = null;
  private voiceSum: GainNode | null = null;
  private voiceDelayA: DelayNode | null = null;
  private voiceDelayB: DelayNode | null = null;
  private voiceLfoSaw: OscillatorNode | null = null;
  private voiceLfoSq: OscillatorNode | null = null;
  private voiceDepthA: GainNode | null = null;
  private voiceDepthB: GainNode | null = null;
  private voiceXfadeA: GainNode | null = null;
  private voiceXfadeB: GainNode | null = null;
  private voiceFormantLo: BiquadFilterNode | null = null;
  private voiceFormantHi: BiquadFilterNode | null = null;
  private voiceRobotFilter: BiquadFilterNode | null = null;
  private voiceDistort: WaveShaperNode | null = null;
  private voiceTremolo: GainNode | null = null;
  private voiceTremoloLfo: OscillatorNode | null = null;
  private voiceTremoloDepth: GainNode | null = null;
  private voiceOut: GainNode | null = null;

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
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    try {
      this.source = ctx.createMediaElementSource(video);
    } catch {
      /* already attached or failed */
      return;
    }
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
    this.buildCloak(ctx);
    this.source.connect(this.directGain);
    this.directGain.connect(this.cloakIn!);
    // intro/outro bypass: a dry path around the whole cloak chain plus a
    // gate on the chain's output. Default (dry=0, gate=1) is bit-neutral;
    // clean spans crossfade to the dry path so they play EXACTLY as recorded.
    this.cloakDry = ctx.createGain();
    this.cloakDry.gain.value = 0;
    this.cloakGate = ctx.createGain();
    this.cloakGate.gain.value = 1;
    this.directGain.connect(this.cloakDry);
    this.cloakDry.connect(this.directTrim);
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

  /**
   * Anti-fingerprint chain for the YouTube cut. Pitch shift (dual modulated
   * delay lines, tempo-preserving) -> chorus -> tilt EQ -> small-room reverb
   * -> Haas widening. Every stage has a dry path, so bypassing is click-free
   * and the chain is bit-neutral when the cloak is off.
   *
   * NEW: voice changer inserted right after cloakIn, before pitch shift.
   * When off it is a straight wire (dry=1, wet=0, filters neutral).
   * When on it does formant shift + extra pitch + robot distortion.
   */
  private buildCloak(ctx: AudioContext) {
    const D = 0.02; // pitch-shift delay depth, seconds
    this.cloakIn = ctx.createGain();

    // ---- voice changer ----
    this.voiceIn = ctx.createGain();
    this.voiceDry = ctx.createGain();
    this.voiceDry.gain.value = 1;
    this.voiceSum = ctx.createGain();
    this.voiceDelayA = ctx.createDelay(0.05);
    this.voiceDelayB = ctx.createDelay(0.05);
    this.voiceDelayA.delayTime.value = D / 2;
    this.voiceDelayB.delayTime.value = D / 2;
    this.voiceWetA = ctx.createGain();
    this.voiceWetB = ctx.createGain();
    this.voiceWetA.gain.value = 0;
    this.voiceWetB.gain.value = 0;
    this.voiceLfoSaw = ctx.createOscillator();
    this.voiceLfoSaw.type = "sawtooth";
    this.voiceLfoSaw.frequency.value = 2;
    this.voiceLfoSq = ctx.createOscillator();
    this.voiceLfoSq.type = "square";
    this.voiceLfoSq.frequency.value = 2;
    this.voiceDepthA = ctx.createGain();
    this.voiceDepthB = ctx.createGain();
    this.voiceDepthA.gain.value = 0;
    this.voiceDepthB.gain.value = 0;
    this.voiceXfadeA = ctx.createGain();
    this.voiceXfadeB = ctx.createGain();
    this.voiceXfadeA.gain.value = 0;
    this.voiceXfadeB.gain.value = 0;
    this.voiceFormantLo = ctx.createBiquadFilter();
    this.voiceFormantLo.type = "lowshelf";
    this.voiceFormantLo.frequency.value = 300;
    this.voiceFormantLo.gain.value = 0;
    this.voiceFormantHi = ctx.createBiquadFilter();
    this.voiceFormantHi.type = "highshelf";
    this.voiceFormantHi.frequency.value = 2500;
    this.voiceFormantHi.gain.value = 0;
    this.voiceRobotFilter = ctx.createBiquadFilter();
    this.voiceRobotFilter.type = "peaking";
    this.voiceRobotFilter.frequency.value = 1000;
    this.voiceRobotFilter.Q.value = 1;
    this.voiceRobotFilter.gain.value = 0;
    this.voiceDistort = ctx.createWaveShaper();
    this.voiceDistort.curve = makeDistortionCurve(0);
    this.voiceDistort.oversample = "2x";
    this.voiceTremolo = ctx.createGain();
    this.voiceTremolo.gain.value = 1;
    this.voiceTremoloLfo = ctx.createOscillator();
    this.voiceTremoloLfo.type = "sine";
    this.voiceTremoloLfo.frequency.value = 30;
    this.voiceTremoloDepth = ctx.createGain();
    this.voiceTremoloDepth.gain.value = 0;
    this.voiceOut = ctx.createGain();

    // wiring voice
    this.cloakIn.connect(this.voiceIn);
    this.voiceIn.connect(this.voiceFormantLo);
    this.voiceFormantLo.connect(this.voiceFormantHi);
    this.voiceFormantHi.connect(this.voiceDry);
    this.voiceFormantHi.connect(this.voiceDelayA);
    this.voiceFormantHi.connect(this.voiceDelayB);
    this.voiceDry.connect(this.voiceSum);
    this.voiceDelayA.connect(this.voiceWetA);
    this.voiceDelayB.connect(this.voiceWetB);
    this.voiceWetA.connect(this.voiceSum);
    this.voiceWetB.connect(this.voiceSum);
    this.voiceLfoSaw.connect(this.voiceDepthA);
    this.voiceLfoSaw.connect(this.voiceDepthB);
    this.voiceDepthA.connect(this.voiceDelayA.delayTime);
    this.voiceDepthB.connect(this.voiceDelayB.delayTime);
    this.voiceLfoSq.connect(this.voiceXfadeA);
    this.voiceLfoSq.connect(this.voiceXfadeB);
    this.voiceXfadeA.connect(this.voiceWetA.gain);
    this.voiceXfadeB.connect(this.voiceWetB.gain);
    this.voiceSum.connect(this.voiceRobotFilter);
    this.voiceRobotFilter.connect(this.voiceDistort);
    this.voiceDistort.connect(this.voiceTremolo);
    this.voiceTremolo.connect(this.voiceOut);
    this.voiceTremoloLfo.connect(this.voiceTremoloDepth);
    this.voiceTremoloDepth.connect(this.voiceTremolo.gain);

    // ---- existing pitch shift, now fed from voiceOut ----
    this.shiftDry = ctx.createGain();
    this.shiftSum = ctx.createGain();
    this.shiftDelayA = ctx.createDelay(0.05);
    this.shiftDelayB = ctx.createDelay(0.05);
    this.shiftDelayA.delayTime.value = D / 2;
    this.shiftDelayB.delayTime.value = D / 2;
    this.shiftWetA = ctx.createGain();
    this.shiftWetB = ctx.createGain();
    this.shiftWetA.gain.value = 0;
    this.shiftWetB.gain.value = 0;

    this.lfoSaw = ctx.createOscillator();
    this.lfoSaw.type = "sawtooth";
    this.lfoSaw.frequency.value = 2;
    this.lfoSq = ctx.createOscillator();
    this.lfoSq.type = "square";
    this.lfoSq.frequency.value = 2;
    this.depthA = ctx.createGain();
    this.depthB = ctx.createGain();
    this.depthA.gain.value = 0;
    this.depthB.gain.value = 0;
    this.xfadeA = ctx.createGain();
    this.xfadeB = ctx.createGain();
    this.xfadeA.gain.value = 0;
    this.xfadeB.gain.value = 0;

    this.voiceOut.connect(this.shiftDry);
    this.voiceOut.connect(this.shiftDelayA);
    this.voiceOut.connect(this.shiftDelayB);
    this.shiftDry.connect(this.shiftSum);
    this.shiftDelayA.connect(this.shiftWetA);
    this.shiftDelayB.connect(this.shiftWetB);
    this.shiftWetA.connect(this.shiftSum);
    this.shiftWetB.connect(this.shiftSum);
    this.lfoSaw.connect(this.depthA);
    this.lfoSaw.connect(this.depthB);
    this.depthA.connect(this.shiftDelayA.delayTime);
    this.depthB.connect(this.shiftDelayB.delayTime);
    this.lfoSq.connect(this.xfadeA);
    this.lfoSq.connect(this.xfadeB);
    this.xfadeA.connect(this.shiftWetA.gain);
    this.xfadeB.connect(this.shiftWetB.gain);

    this.chorusDry = ctx.createGain();
    this.chorusWet = ctx.createGain();
    this.chorusWet.gain.value = 0;
    this.chorusSum = ctx.createGain();
    this.chorusDelay = ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.012;
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfo.type = "sine";
    this.chorusLfo.frequency.value = 1.1;
    this.chorusDepth = ctx.createGain();
    this.chorusDepth.gain.value = 0.0035;
    this.shiftSum.connect(this.chorusDry);
    this.shiftSum.connect(this.chorusDelay);
    this.chorusDry.connect(this.chorusSum);
    this.chorusDelay.connect(this.chorusWet);
    this.chorusWet.connect(this.chorusSum);
    this.chorusLfo.connect(this.chorusDepth);
    this.chorusDepth.connect(this.chorusDelay.delayTime);

    this.tiltLo = ctx.createBiquadFilter();
    this.tiltLo.type = "lowshelf";
    this.tiltLo.frequency.value = 400;
    this.tiltHi = ctx.createBiquadFilter();
    this.tiltHi.type = "highshelf";
    this.tiltHi.frequency.value = 2500;
    this.chorusSum.connect(this.tiltLo);
    this.tiltLo.connect(this.tiltHi);

    this.verbDry = ctx.createGain();
    this.verbWet = ctx.createGain();
    this.verbWet.gain.value = 0;
    this.verbSum = ctx.createGain();
    this.verb = ctx.createConvolver();
    this.verb.buffer = makeImpulse(ctx, 1.4, 2.8);
    this.tiltHi.connect(this.verbDry);
    this.tiltHi.connect(this.verb);
    this.verbDry.connect(this.verbSum);
    this.verb.connect(this.verbWet);
    this.verbWet.connect(this.verbSum);

    this.haasSplit = ctx.createChannelSplitter(2);
    this.haasMerge = ctx.createChannelMerger(2);
    this.haasDelay = ctx.createDelay(0.05);
    this.haasDelay.delayTime.value = 0;
    this.verbSum.connect(this.haasSplit);
    this.haasSplit.connect(this.haasMerge, 0, 0);
    this.haasSplit.connect(this.haasDelay, 1, 0);
    this.haasDelay.connect(this.haasMerge, 0, 1);
    this.haasMerge.connect(this.cloakGate!);
    this.cloakGate!.connect(this.directTrim!);

    this.lfoSaw.start();
    this.lfoSq.start();
    this.chorusLfo.start();
    this.voiceLfoSaw.start();
    this.voiceLfoSq.start();
    this.voiceTremoloLfo.start();
  }

  /** Apply the YouTube audio-cloak settings to the direct chain. */
  updateCloak(c: AudioCloak) {
    const ctx = this.ctx;
    if (!ctx || !this.cloakIn || !this.voiceIn) return;
    const t = ctx.currentTime;
    const ramp = (p: AudioParam, v: number, tc = 0.03) => p.setTargetAtTime(v, t, tc);

    // ---- voice changer ----
    const vOn = !!(c as any).voiceChanger || !!(c as any).voiceOn;
    const mode = String((c as any).voiceMode || "morph").toLowerCase();
    // The preview is a WebAudio approximation: the real morph is a phase
    // vocoder + vocal-tract warp running on the export backend, and no
    // browser graph reproduces that sample for sample. What it can do is
    // move the pitch and the formants the same amount in the same direction,
    // so you hear the character you picked before you spend a render on it.
    let preset = String((c as any).voicePreset || "anon");
    let strength =
      Math.max(0, Math.min(100, (c as any).voiceStrength ?? 70)) / 100;
    let extraPitch = Number((c as any).voicePitch ?? 0) || 0;
    if (mode === "morph") {
      const mp = String((c as any).morphPreset || "incognito");
      const MORPH: Record<string, { pitch: number; lo: number; hi: number; robot?: boolean }> = {
        incognito: { pitch: -2.6, lo: 3, hi: -2.5 },
        deep: { pitch: -5.2, lo: 4.5, hi: -4 },
        bright: { pitch: 4.6, lo: -4, hi: 4.5 },
        warm: { pitch: -1.2, lo: 1.2, hi: -1 },
        radio: { pitch: -0.8, lo: 5.5, hi: -6, robot: true },
        robot: { pitch: -0.6, lo: 0.5, hi: 0.5, robot: true },
        alien: { pitch: 3.1, lo: 6, hi: -5.5, robot: true },
        custom: { pitch: 0, lo: 0, hi: 0 },
      };
      const m = MORPH[mp] ?? MORPH.incognito;
      strength = Math.max(0, Math.min(100, (c as any).morphStrength ?? 85)) / 100;
      extraPitch = mp === "custom" ? extraPitch : 0;
      // morphFormant moves the tract on top of the character (1 = as picked)
      const tract = Number((c as any).morphFormant ?? 1) || 1;
      const fd = Math.max(-6, Math.min(6, (tract - 1) * 12));
      preset = mp === "custom" ? "custom" : m.robot ? "robot" : "anon";
      this.morphPreview = { pitch: m.pitch, lo: m.lo + fd, hi: m.hi - fd };
    } else {
      this.morphPreview = null;
    }

    if (!vOn || strength < 0.01) {
      ramp(this.voiceWetA!.gain, 0, 0.05);
      ramp(this.voiceWetB!.gain, 0, 0.05);
      ramp(this.voiceXfadeA!.gain, 0, 0.05);
      ramp(this.voiceXfadeB!.gain, 0, 0.05);
      ramp(this.voiceDry!.gain, 1, 0.05);
      ramp(this.voiceFormantLo!.gain, 0, 0.05);
      ramp(this.voiceFormantHi!.gain, 0, 0.05);
      ramp(this.voiceRobotFilter!.gain, 0, 0.05);
      ramp(this.voiceTremoloDepth!.gain, 0, 0.05);
      ramp(this.voiceTremolo!.gain, 1, 0.05);
      this.voiceDistort!.curve = makeDistortionCurve(0);
    } else {
      // map preset to pitch + formant
      let basePitch = this.morphPreview?.pitch ?? 0;
      let formantLo = this.morphPreview?.lo ?? 0;
      let formantHi = this.morphPreview?.hi ?? 0;
      let robot = mode === "morph" && preset === "robot";
      switch (this.morphPreview ? "__morph__" : preset) {
        case "__morph__":
          break;
        case "deep":
          basePitch = -3.5;
          formantLo = 4;
          formantHi = -3;
          break;
        case "high":
          basePitch = 4.5;
          formantLo = -4;
          formantHi = 5;
          break;
        case "robot":
          basePitch = 0;
          formantLo = 0;
          formantHi = 0;
          robot = true;
          break;
        case "custom":
          basePitch = extraPitch;
          formantLo = extraPitch > 0 ? -2 : 2;
          formantHi = extraPitch > 0 ? 3 : -2;
          break;
        case "anon":
        default:
          basePitch = -2.2;
          formantLo = 3;
          formantHi = -2.5;
          break;
      }
      // blend with strength and extra pitch
      const pitchSt = (basePitch + extraPitch) * strength;
      const D = 0.02;
      const k = 1 - Math.pow(2, pitchSt / 12);
      const f = Math.min(12, Math.max(0.2, Math.abs(k) / D));
      this.voiceLfoSaw!.frequency.setValueAtTime(f, t);
      this.voiceLfoSq!.frequency.setValueAtTime(f, t);
      const s = k > 0 ? 1 : -1;
      this.voiceDepthA!.gain.setValueAtTime((s * D) / 2, t);
      this.voiceDepthB!.gain.setValueAtTime((-s * D) / 2, t);
      this.voiceXfadeA!.gain.setValueAtTime(0.5, t);
      this.voiceXfadeB!.gain.setValueAtTime(-0.5, t);
      this.voiceWetA!.gain.setValueAtTime(0.5, t);
      this.voiceWetB!.gain.setValueAtTime(0.5, t);
      ramp(this.voiceDry!.gain, 0, 0.05);

      ramp(this.voiceFormantLo!.gain, formantLo * strength, 0.05);
      ramp(this.voiceFormantHi!.gain, formantHi * strength, 0.05);

      if (robot) {
        ramp(this.voiceRobotFilter!.gain, 8 * strength, 0.05);
        this.voiceRobotFilter!.frequency.setValueAtTime(1200, t);
        this.voiceRobotFilter!.Q.setValueAtTime(8, t);
        this.voiceDistort!.curve = makeDistortionCurve(200 * strength);
        this.voiceTremoloLfo!.frequency.setValueAtTime(30, t);
        ramp(this.voiceTremoloDepth!.gain, 0.6 * strength, 0.05);
        ramp(this.voiceTremolo!.gain, 1, 0.05);
      } else {
        ramp(this.voiceRobotFilter!.gain, 0, 0.05);
        this.voiceDistort!.curve = makeDistortionCurve(15 * strength);
        ramp(this.voiceTremoloDepth!.gain, 0, 0.05);
        ramp(this.voiceTremolo!.gain, 1, 0.05);
      }
    }

    // tempo-preserving pitch shift: a delay ramped at k scales the pitch by (1 - k)
    const st = c.on ? c.pitch : 0;
    if (Math.abs(st) < 0.05) {
      // full bypass: kill both the wet bases and the crossfade LFO depth,
      // otherwise the parked 10 ms delays comb-filter the dry signal
      ramp(this.shiftWetA!.gain, 0, 0.05);
      ramp(this.shiftWetB!.gain, 0, 0.05);
      ramp(this.xfadeA!.gain, 0, 0.05);
      ramp(this.xfadeB!.gain, 0, 0.05);
      ramp(this.shiftDry!.gain, 1, 0.05);
    } else {
      const D = 0.02;
      const k = 1 - Math.pow(2, st / 12);
      const f = Math.min(12, Math.max(0.2, Math.abs(k) / D));
      this.lfoSaw!.frequency.setValueAtTime(f, t);
      this.lfoSq!.frequency.setValueAtTime(f, t);
      const s = k > 0 ? 1 : -1;
      this.depthA!.gain.setValueAtTime((s * D) / 2, t);
      this.depthB!.gain.setValueAtTime((-s * D) / 2, t);
      // re-arm the crossfade around the new ramps
      this.xfadeA!.gain.setValueAtTime(0.5, t);
      this.xfadeB!.gain.setValueAtTime(-0.5, t);
      this.shiftWetA!.gain.setValueAtTime(0.5, t);
      this.shiftWetB!.gain.setValueAtTime(0.5, t);
      ramp(this.shiftDry!.gain, 0, 0.05);
    }

    const chMix = c.on ? (c.chorus / 100) * 0.4 : 0;
    ramp(this.chorusWet!.gain, chMix);
    ramp(this.chorusDry!.gain, 1 - chMix * 0.5);
    ramp(this.verbWet!.gain, c.on ? (c.reverb / 100) * 0.33 : 0);
    ramp(this.tiltLo!.gain, c.on ? -c.tilt / 2 : 0);
    ramp(this.tiltHi!.gain, c.on ? c.tilt / 2 : 0);
    ramp(this.haasDelay!.delayTime, c.on ? c.widen / 1000 : 0, 0.01);
  }

  /**
   * Intro/outro rule for the local engine: while the playhead sits in a
   * clean span, the whole cloak chain (voice changer included) is bypassed
   * and the audio plays exactly as recorded. Call once per frame with the
   * active segment type; cheap when nothing changed.
   */
  setCleanSpan(type: string | null) {
    const clean = type === "intro" || type === "outro";
    if (clean === this.cloakClean) return;
    this.cloakClean = clean;
    const ctx = this.ctx;
    if (!ctx || !this.cloakDry || !this.cloakGate) return;
    const t = ctx.currentTime;
    this.cloakDry.gain.setTargetAtTime(clean ? 1 : 0, t, 0.03);
    this.cloakGate.gain.setTargetAtTime(clean ? 0 : 1, t, 0.03);
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

/** Small-room impulse: stereo noise with an exponential decay. */
function makeImpulse(ctx: AudioContext, dur: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * dur));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = Math.max(0, amount);
  if (k < 0.1) {
    // neutral: linear
    const c = new Float32Array(2);
    c[0] = -1;
    c[1] = 1;
    return c;
  }
  const n = 44100;
  const curve = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; ++i) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function peakDb(buf: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak > 0.00002 ? 20 * Math.log10(peak) : -60;
}
