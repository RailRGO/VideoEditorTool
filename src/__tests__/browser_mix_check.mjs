/**
 * Real-browser check for the preview audio mix (fix: "The preview audio mix
 * could not start (... already connected previously to a different
 * MediaElementSourceNode.)").
 *
 * A media element accepts exactly ONE MediaElementAudioSourceNode in its whole
 * life, and closing the AudioContext does not hand it back. The engine
 * therefore keeps one context + source node per element (`ELEMENT_GRAPH` in
 * src/lib/audio.ts), routes the element's own audio around the mix through a
 * bypass gain when it detaches, and re-wires that same source node when the
 * mix is rebuilt.
 *
 * This script drives the real app in Chromium and proves it:
 *   1. first play builds the mix,
 *   2. a play() rejection (the fallback path that detaches, same as the
 *      playback watchdog) hands the element its own audio back,
 *   3. a second createMediaElementSource() on that element throws the exact
 *      reported error — i.e. the old code could never rebuild the mix,
 *   4. the next play rebuilds the mix with no further source-node attempt and
 *      no new AudioContext,
 *   5. five more play/pause cycles stay clean,
 *   6. AudioEngine internals: detach keeps ctx + source, bypass gain 1;
 *      re-attach reuses them, gain 0; the context is never closed.
 *
 * Opt-in (not part of `npm test`: it needs a browser and a running dev server):
 *   npm i -D playwright && npx playwright install chromium
 *   npm run dev
 *   node src/__tests__/browser_mix_check.mjs http://localhost:5173/ ./clip.webm
 * CHROME_PATH=/path/to/chromium overrides the browser (with LD_LIBRARY_PATH
 * for a build that ships its own libs). The clip only has to be playable —
 * a VP9/Opus webm is always safe.
 */

import { existsSync } from "node:fs";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "This check needs Playwright (opt-in, not part of npm test):\n" +
      "  npm i -D playwright && npx playwright install chromium\n" +
      "then re-run it with the dev server up."
  );
  process.exit(2);
}

const APP = process.argv[2] || "http://localhost:5173/";
const CLIP = process.argv[3];
if (!CLIP || !existsSync(CLIP)) {
  console.error(
    `usage: node src/__tests__/browser_mix_check.mjs [appUrl] <clipFile>\n` +
      `  appUrl defaults to http://localhost:5173/ (start it with: npm run dev)\n` +
      (CLIP ? `  not a file: ${CLIP}` : "  a playable clip is required (e.g. ffmpeg -f lavfi ... clip.webm)")
  );
  process.exit(2);
}

let failed = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const launch = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // the point of the run is the audio graph, not the autoplay policy
    "--autoplay-policy=no-user-gesture-required",
  ],
};
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
if (process.env.LD_LIBRARY_PATH) launch.env = { ...process.env };
const browser = await chromium.launch(launch);
const page = await browser.newPage();

const noise = [];
page.on("pageerror", (e) => noise.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") noise.push("console.error: " + m.text());
});

// instrument the browser's own audio API: count contexts and
// createMediaElementSource() calls, and record every throw
await page.addInitScript(() => {
  window.__src = [];
  window.__ctxs = [];
  const Orig = window.AudioContext;
  window.AudioContext = class extends Orig {
    constructor(...a) {
      super(...a);
      window.__ctxs.push(this);
    }
    createMediaElementSource(el) {
      try {
        const n = super.createMediaElementSource(el);
        window.__src.push({ ok: true });
        return n;
      } catch (e) {
        window.__src.push({ ok: false, msg: String(e.message) });
        throw e;
      }
    }
  };
});

const PLAY = 'button[title="Play / pause (Space)"]';
const bodyText = () => page.evaluate(() => document.body.innerText);
const appState = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return {
      t: v.currentTime,
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      decoded: v.webkitAudioDecodedByteCount ?? -1,
      note: document.body.innerText,
      srcCalls: window.__src.length,
      srcThrows: window.__src.filter((c) => !c.ok).length,
      ctxCount: window.__ctxs.length,
      ctxStates: window.__ctxs.map((c) => c.state),
    };
  });

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.setInputFiles('input[type="file"]', CLIP);
await page.waitForFunction(
  () => {
    const v = document.querySelector("video");
    return !!v && v.readyState >= 2 && v.duration > 1;
  },
  null,
  { timeout: 30000 }
);

/* -------- 1. first play: the mix must build ------------------------------ */
await page.click(PLAY);
await page.waitForTimeout(900);
let s = await appState();
ok("first play builds the preview mix", s.srcCalls === 1 && s.srcThrows === 0, `srcCalls=${s.srcCalls}`);
ok("no audio-mix error on screen", !/could not start/i.test(s.note), s.note.match(/[^\n]*could not start[^\n]*/i)?.[0] ?? "");
ok("picture runs", !s.paused && s.t > 0, `t=${s.t.toFixed(2)}`);
ok("element keeps its audio (not muted, decoding)", s.muted === false && s.decoded > 0, `decoded=${s.decoded}`);

/* -------- 2. the trigger: a play() rejection detaches the graph ---------- */
await page.click(PLAY); // pause
await page.waitForTimeout(250);
const beforeReject = (await appState()).ctxCount;
await page.evaluate(() => {
  const proto = HTMLMediaElement.prototype;
  const orig = proto.play;
  proto.play = function () {
    proto.play = orig;
    return Promise.reject(new DOMException("blocked by test", "NotAllowedError"));
  };
});
await page.click(PLAY); // play → play() rejects → fallback detaches → retry plays
await page.waitForTimeout(900);
s = await appState();
ok(
  "the blocked play hands the element its own audio (detach happened)",
  /without the audio mix/i.test(s.note) && !s.paused,
  s.note.match(/[^\n]*audio mix[^\n]*/i)?.[0] ?? "note missing"
);
ok("detach builds no new context (nothing was thrown away)", s.ctxCount === beforeReject, `ctx ${beforeReject} -> ${s.ctxCount}`);

/* -------- 3. the reported failure is real: the element is bound for good - */
const rebind = await page.evaluate(() => {
  const v = document.querySelector("video");
  try {
    new AudioContext().createMediaElementSource(v);
    return "no-throw";
  } catch (e) {
    return e.message;
  }
});
ok(
  "a second createMediaElementSource on the element throws the reported error",
  /already connected previously to a different MediaElementSourceNode/.test(rebind),
  rebind.slice(0, 90)
);
// the probe above is the harness's own call — do not count it as the app's
await page.evaluate(() => {
  window.__src.length = 0;
  window.__probeCtxs = window.__ctxs.length;
});

/* -------- 4. play again: the mix must come back -------------------------- */
const ctxBefore = (await appState()).ctxCount;
const probeCtxs = ctxBefore;
await page.click(PLAY); // pause
await page.waitForTimeout(250);
await page.click(PLAY); // play → attach again on the surviving context
await page.waitForTimeout(1000);
const a = await appState();
await page.waitForTimeout(700);
const b = await appState();
ok("second play rebuilds the mix (no error note)", !/could not start/i.test(b.note), b.note.match(/[^\n]*could not start[^\n]*/i)?.[0] ?? "");
ok("the mix graph was rebuilt, not re-bound", b.srcThrows === 0, `createMediaElementSource calls after the detach: ${b.srcCalls}, throws: ${b.srcThrows}`);
ok("no new AudioContext for the rebuild", b.ctxCount === probeCtxs, `app contexts=${probeCtxs - 1} -> ${b.ctxCount - 1} (the +1 is the harness probe) => ${b.ctxStates.join(",")}`);
ok("picture runs again", !b.paused && b.t > a.t, `t ${a.t.toFixed(2)} -> ${b.t.toFixed(2)}`);
ok("mix context still running", b.ctxStates[0] === "running", b.ctxStates.join(","));

/* -------- 5. five more play/pause cycles (the watchdog repeats detach) --- */
for (let i = 0; i < 5; i++) {
  await page.click(PLAY); // pause
  await page.waitForTimeout(120);
  await page.click(PLAY); // play
  await page.waitForTimeout(320);
}
const cyc = await appState();
ok(
  "5 more play/pause cycles stay clean",
  cyc.srcCalls === 0 && cyc.srcThrows === 0 && !/could not start/i.test(cyc.note) && !cyc.paused,
  `srcCalls=${cyc.srcCalls} t=${cyc.t.toFixed(2)}`
);

/* -------- 6. AudioEngine internals against the real API ------------------ */
const internals = await page.evaluate(async () => {
  const mod = await import("/src/lib/audio.ts");
  const v = document.createElement("video");
  v.src = document.querySelector("video").currentSrc;
  v.loop = true;
  document.body.appendChild(v);
  await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));

  const eng = new mod.AudioEngine();
  const out = {};
  const srcBefore = window.__src.length;
  const ctxBefore = window.__ctxs.length;

  out.attach1 = eng.attach(v, 0);
  const ctx1 = eng.ctx;
  const srcNode1 = eng.source;
  out.bypassOnAttach = eng.bypassGain.gain.value;
  out.sourceToBypassConnections = srcNode1.numberOfOutputs;

  eng.detach();
  out.bypassAfterDetach = eng.bypassGain.gain.value;
  out.sameCtxAfterDetach = eng.ctx === ctx1;
  out.sameSourceAfterDetach = eng.source === srcNode1;
  out.readyAfterDetach = eng.ready;

  out.attach2 = eng.attach(v, 0);
  out.sameCtxAfterAttach = eng.ctx === ctx1;
  out.sameSourceAfterAttach = eng.source === srcNode1;
  out.bypassAfterAttach = eng.bypassGain.gain.value;
  out.error = eng.error;
  out.ctxState = ctx1.state;

  // the element must still produce sound in both states: play it and read
  // Chrome's decoded-audio counter
  v.muted = false;
  v.volume = 1;
  await v.play();
  await new Promise((r) => setTimeout(r, 700));
  out.decodedWhileMixed = v.webkitAudioDecodedByteCount;
  eng.detach();
  await new Promise((r) => setTimeout(r, 500));
  out.decodedWhileOwnAudio = v.webkitAudioDecodedByteCount;
  out.playing = !v.paused;

  v.pause();
  out.srcCallsTotal = window.__src.length - srcBefore;
  out.ctxsTotal = window.__ctxs.length - ctxBefore;
  out.ctxClosed = ctx1.state;
  v.remove();
  return out;
});
ok("attach() builds on a real Chromium context", internals.attach1 === true && internals.error === "", JSON.stringify({ e: internals.error }));
ok("detach() keeps the element's context and source node", internals.sameCtxAfterDetach && internals.sameSourceAfterDetach && internals.readyAfterDetach === false);
ok("detach() routes the element's own audio (bypass gain 1)", internals.bypassAfterDetach === 1, `gain=${internals.bypassAfterDetach}`);
ok("re-attach() reuses them and takes the mix over (gain 0)", internals.attach2 === true && internals.sameCtxAfterAttach && internals.sameSourceAfterAttach && internals.bypassAfterAttach === 0);
ok("exactly one createMediaElementSource for the element", internals.srcCallsTotal === 1, `calls=${internals.srcCallsTotal}`);
ok("exactly one AudioContext for the element", internals.ctxsTotal === 1, `contexts=${internals.ctxsTotal}`);
ok("detach() never closes the context", internals.ctxClosed !== "closed", internals.ctxClosed);
ok("audio decodes while mixed and after detach", internals.decodedWhileMixed > 0 && internals.decodedWhileOwnAudio > internals.decodedWhileMixed, `${internals.decodedWhileMixed} -> ${internals.decodedWhileOwnAudio}`);

/* -------- 7. no page errors anywhere ------------------------------------ */
const bad = noise.filter((n) => !/favicon|Autoplay|AudioContext was not allowed/i.test(n));
ok("no console errors during the whole run", bad.length === 0, bad.slice(0, 3).join(" | "));

await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall browser checks passed");
process.exit(failed ? 1 : 0);
