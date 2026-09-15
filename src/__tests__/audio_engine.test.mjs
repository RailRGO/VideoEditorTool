#!/usr/bin/env node
/**
 * Preview audio graph: the attach → detach → attach cycle.
 *
 *     node src/__tests__/audio_engine.test.mjs
 *
 * This is the regression behind the note "The preview audio mix could not
 * start (Failed to execute 'createMediaElementSource' on 'AudioContext':
 * HTMLMediaElement already connected previously to a different
 * MediaElementSourceNode.) — playing with the file's own audio."
 *
 * A media element accepts ONE MediaElementAudioSourceNode for its whole life
 * and a closed AudioContext does not give it back. The engine used to close
 * its context on every `detach()` (the playback watchdog detaches on a stall,
 * the play-failure fallback detaches too), so the next `attach()` threw and
 * the preview lost its mix — compressor, ducking, voice changer — until the
 * page was reloaded.
 *
 * The fake AudioContext below is deliberately strict: like Chrome, it throws
 * if `createMediaElementSource` is called twice for the same element, and it
 * counts the calls. Every check is on the engine's observable behaviour:
 * does attach succeed, is the mix live, does the element get its own audio
 * back, and was the element wired only once.
 */
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "lib");

let fails = 0;
let checks = 0;
const check = (cond, what, extra = "") => {
  checks += 1;
  if (cond) console.log(`  ok   ${what}`);
  else {
    fails += 1;
    console.log(`  FAIL ${what}${extra ? ` | ${extra}` : ""}`);
  }
};

/* ------------------------------------------------ fake Web Audio --------- */
const param = () => ({
  value: 0,
  setTargetAtTime() {},
  setValueAtTime() {},
});
const node = (extra = {}) => ({
  connect() {},
  disconnect() {},
  ...extra,
});

let sourceCalls = 0;
let contexts = 0;
const boundElements = new WeakSet();
/** when set, the next N graph builds throw (simulating a broken build) */
let failNext = 0;

class FakeAudioContext {
  constructor() {
    contexts += 1;
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = node();
    /** what the element's own audio is currently connected to */
    this.outputs = [];
  }
  async resume() {}
  async close() {
    this.state = "closed";
  }
  createMediaElementSource(el) {
    sourceCalls += 1;
    if (boundElements.has(el)) {
      throw new Error(
        "Failed to execute 'createMediaElementSource' on 'AudioContext': " +
          "HTMLMediaElement already connected previously to a different " +
          "MediaElementSourceNode."
      );
    }
    boundElements.add(el);
    const n = node();
    n.__source = true;
    return n;
  }
  createChannelSplitter() {
    return node();
  }
  createChannelMerger() {
    return node();
  }
  createGain() {
    return node({ gain: param() });
  }
  createStereoPanner() {
    return node({ pan: param() });
  }
  createDynamicsCompressor() {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("simulated half-built graph");
    }
    return node({
      threshold: param(),
      ratio: param(),
      knee: param(),
      attack: param(),
      release: param(),
      reduction: 0,
    });
  }
  createAnalyser() {
    return node({
      fftSize: 0,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData() {},
    });
  }
  createMediaStreamDestination() {
    return node({ stream: {} });
  }
  createDelay() {
    return node({ delayTime: param() });
  }
  createOscillator() {
    return node({
      type: "",
      frequency: param(),
      started: false,
      start() {
        this.started = true;
      },
      stop() {
        this.started = false;
      },
    });
  }
  createBiquadFilter() {
    return node({ type: "", frequency: param(), Q: param(), gain: param() });
  }
  createWaveShaper() {
    return node({ curve: null, oversample: "none" });
  }
  createConvolver() {
    return node({ buffer: null });
  }
  createScriptProcessor() {
    return node({ onaudioprocess: null });
  }
  createBuffer(channels, length) {
    return {
      length,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
    };
  }
}

global.window = {
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
};

/* ------------------------------------------------------------- bundle ---- */
const bundle = await esbuild.build({
  stdin: {
    contents: 'export { AudioEngine } from "./audio";',
    resolveDir: srcDir,
    loader: "ts",
    sourcefile: "entry.ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const tmp = path.join(here, `.audio_bundle_${process.pid}.mjs`);
fs.writeFileSync(tmp, bundle.outputFiles[0].text);
const { AudioEngine } = await import(`file://${tmp}?t=${Date.now()}`);
fs.rmSync(tmp, { force: true });

/** stand-in for the preview <video> (only identity matters to the engine) */
const video = { src: "file.mp4", currentTime: 0 };

/* =============================== the cycle =============================== */
console.log("\n== attach / detach / attach");
{
  const eng = new AudioEngine();
  check(eng.attach(video, "left") === true, "the mix builds on the element");
  check(eng.ready === true, "the graph is live");
  check(eng.error === "", "no error is reported");
  check(sourceCalls === 1, "the element is wired exactly once");

  eng.detach();
  check(eng.ready === false, "detach takes the mix out of the path");
  check(eng.attach(video, "left") === true, "the mix rebuilds after a detach");
  check(eng.ready === true, "…and is live again");
  check(eng.error === "", "…with no error note for the user");
  check(
    sourceCalls === 1,
    "…without a second MediaElementAudioSourceNode",
    `createMediaElementSource called ${sourceCalls}×`
  );

  // the watchdog can detach repeatedly: every cycle must rebuild
  let ok = true;
  for (let i = 0; i < 5; i++) {
    eng.detach();
    ok = ok && eng.attach(video, "left") === true && eng.ready === true;
  }
  check(ok, "five detach / attach cycles all rebuild the mix");
  check(sourceCalls === 1, "…still one source node for the element");
  check(
    eng.error === "",
    "the stale 'could not start' note never comes back",
    eng.error
  );
}

/* ===================== a broken build cannot poison it =================== */
console.log("\n== a failed build keeps the element usable");
{
  const other = { src: "other.mp4" };
  const eng = new AudioEngine();
  failNext = 1; // the next build dies half-way (the old first-play crash)
  const before = sourceCalls;
  check(eng.attach(other, "left") === false, "a broken build reports failure");
  check(
    eng.error.startsWith("The preview audio mix could not start"),
    "…with the note the preview shows",
    eng.error
  );
  check(
    sourceCalls === before + 1,
    "…after wiring the element once (the source exists, so it must be routed)"
  );
  check(eng.ready === false, "no half-built graph is left live");

  // the element's own audio is routed around the graph, so the picture runs
  // with sound — and the next attempt can still rebuild the mix
  check(eng.attach(other, "left") === true, "the next attach builds the mix");
  check(eng.ready === true, "…and the mix is live");
  check(eng.error === "", "…and the error note is cleared");
  check(sourceCalls === before + 1, "…with no second source node");

  eng.detach();
  check(eng.attach(other, "left") === true, "detach after a failure still rebuilds");
}

/* ========================= a second element ============================== */
console.log("\n== the preview element is swapped");
{
  const a = { src: "a.mp4" };
  const b = { src: "b.mp4" };
  const eng = new AudioEngine();
  const ctxBefore = contexts;
  const srcBefore = sourceCalls;
  check(eng.attach(a, "left") === true, "the first element mixes");
  check(eng.attach(b, "left") === true, "a different element mixes too");
  check(eng.ready === true, "…and its graph is live");
  // each element keeps its own context and source node, so neither is
  // poisoned by the swap and both stay reusable
  check(
    contexts === ctxBefore + 2,
    "each element owns its context",
    `contexts=${contexts} (was ${ctxBefore})`
  );
  check(
    sourceCalls === srcBefore + 2,
    "each element owns its source node",
    `sources=${sourceCalls} (was ${srcBefore})`
  );
  eng.detach();
  check(eng.attach(a, "left") === true, "the first element can still be mixed again");
  check(eng.attach(b, "left") === true, "…and so can the second");
}

console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
