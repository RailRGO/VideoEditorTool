#!/usr/bin/env node
/**
 * Component test for the Export panel's server-render states.
 *
 *     node src/__tests__/export_panel.test.mjs
 *
 * Renders the real <ExportPanel/> (bundled with esbuild, no browser needed)
 * for every state the Colab backend can report and asserts what the user
 * sees. These are the states that used to be indistinguishable in the UI:
 * a render that is chunking, one that has gone quiet, one whose runtime was
 * reclaimed with parts still on disk, and one that finished.
 */
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "components");

const ENTRY = `
import React from "react";
export { ExportPanel } from "./Panels";
export const h = React.createElement;
`;

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

const bundle = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: srcDir, loader: "tsx", sourcefile: "entry.tsx" },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react-dom", "react-dom/client"],
  jsx: "automatic",
});
// the bundle must live inside the repo so `require("react")` resolves
const tmp = path.join(here, `.bundle_${process.pid}.cjs`);
fs.writeFileSync(tmp, bundle.outputFiles[0].text);
const mod = await import(`file://${tmp}`);
const { ExportPanel, h } = mod.default ?? mod;
const React = (await import("react")).default;

/* ---- minimal DOM so react-dom/client can mount and we can click ---------- */
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", {
  value: dom.window.navigator, configurable: true,
});
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const baseProps = {
  res: 1080,
  setRes: () => {},
  fps: 30,
  setFps: () => {},
  bitrate: 12,
  setBitrate: () => {},
  exporting: false,
  progress: 0,
  resultUrl: null,
  resultSize: 0,
  fileName: "reaction",
  onExport: () => {},
  onStop: () => {},
  outDur: 1284,
  removed: 0,
  duration: 1600,
  mime: "video/mp4",
  onSaveProject: () => {},
  onLoadProject: () => {},
  projectMsg: "",
  partTarget: 0,
  setPartTarget: () => {},
  stems: true,
  setStems: () => {},
};

const remoteWith = (job, handlers = {}) => ({
  connected: true,
  job,
  error: "",
  onExport: handlers.onExport ?? (() => {}),
  onCancel: handlers.onCancel ?? (() => {}),
  onResume: handlers.onResume ?? (() => {}),
  fileUrl: (n) => `/files/${n}`,
});

async function mount(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ExportPanel, props));
  });
  const text = host.textContent || "";
  const click = async (label) => {
    const btn = [...host.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes(label)
    );
    if (!btn) return false;
    await act(async () => {
      btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    return true;
  };
  return {
    host, text, click,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

console.log("export panel · server render states");

/* 1. running, chunked, with an ETA --------------------------------------- */
{
  const { text, unmount } = await mount({
    ...baseProps,
    remote: remoteWith({
      kind: "render", state: "running", progress: 0.223, files: {}, thumbs: [],
      loudness: {}, result: null, error: null, log: [],
      step: "encoding", part: 4, parts: 21, eta_s: 720, elapsed_s: 205,
      age_s: 3, bytes: 0,
    }),
  });
  check(/22\.3%/.test(text), "shows the percentage", text.slice(0, 80));
  check(/part 4 of 21/.test(text), "shows which part of how many");
  check(/~12 min left/.test(text), "shows an ETA from elapsed progress");
  check(/encoding/.test(text), "shows the current step");
  check(!/no encoder output/i.test(text), "no stall warning while the encoder talks");
  await unmount();
}

/* 2. running but the encoder went quiet ---------------------------------- */
{
  const { text, unmount } = await mount({
    ...baseProps,
    remote: remoteWith({
      kind: "render", state: "running", progress: 0.4, files: {}, thumbs: [],
      loudness: {}, result: null, error: null, log: [],
      step: "encoding", part: 8, parts: 21, eta_s: 0, elapsed_s: 900, age_s: 180,
    }),
  });
  check(/no encoder output for 3 min/i.test(text), "warns when the encoder is silent");
  check(/written parts are safe/i.test(text), "says the parts are safe");
  await unmount();
}

/* 3. runtime reclaimed: lost, parts on disk ------------------------------ */
{
  let resumed = null;
  const { text, click, unmount } = await mount({
    ...baseProps,
    remote: remoteWith(
      {
        kind: "render", state: "lost", progress: 0.14, files: {}, thumbs: [],
        loudness: {}, result: null,
        error: "stopped after 12m of silence with 3/21 parts saved — it did NOT finish",
        log: [], step: "lost", part: 3, parts: 21,
        resume: { key: "rec_patreon", target: "patreon", name: "rec_patreon", saved: 3, parts: 21 },
      },
      { onResume: (k) => (resumed = k) }
    ),
  });
  check(/did NOT finish/.test(text), "says plainly that it did not finish");
  check(/3 of 21 parts/.test(text), "says how many parts survived");
  check(await click("Resume render"), "offers a Resume button");
  check(resumed === "rec_patreon", `Resume posts the journal key (${resumed})`);
  check(await click("Start over"), "also offers to start over");
  await unmount();
}

/* 4. cancelled mid-chunk: still resumable -------------------------------- */
{
  const { text, unmount } = await mount({
    ...baseProps,
    remote: remoteWith({
      kind: "render", state: "cancelled", progress: 0.5, files: {}, thumbs: [],
      loudness: {}, result: null, error: null, log: [],
      resume: { key: "rec_patreon", saved: 9, parts: 21 },
    }),
  });
  check(/Render cancelled/.test(text), "a cancelled render says so");
  check(/9 of 21 parts/.test(text), "…and still offers its saved parts");
  await unmount();
}

/* 5. done ---------------------------------------------------------------- */
{
  const { text, unmount } = await mount({
    ...baseProps,
    remote: remoteWith({
      kind: "render", state: "done", progress: 1, thumbs: [], loudness: {},
      result: null, error: null, log: [],
      files: { mp4: "rec_patreon.mp4", stems: "mix,content,mic" },
      resume: null,
    }),
  });
  check(/Download rec_patreon\.mp4/.test(text), "offers the download");
  await unmount();
}

/* 6. idle: the long-render controls -------------------------------------- */
{
  let picked = null;
  const { text, click, unmount } = await mount({
    ...baseProps,
    setPartTarget: (v) => (picked = v),
    remote: remoteWith({
      kind: "render", state: "idle", progress: 0, files: {}, thumbs: [],
      loudness: {}, result: null, error: null, log: [],
    }),
  });
  check(/Long renders/.test(text), "shows the Long renders section");
  check(/reclaimed runtime costs one part/.test(text), "explains what chunking buys");
  check(/content & mic tracks/.test(text), "offers the content + mic tracks toggle");
  check(await click("4 min"), "part size is selectable");
  check(picked === 240, `picking 4 min sends ${picked}s per part`);
  await unmount();
}

/* 7. YouTube: no stems toggle (the cut reads them, it does not write them) - */
{
  const { text, unmount } = await mount({
    ...baseProps,
    passthrough: true,
    remote: remoteWith({
      kind: "render", state: "idle", progress: 0, files: {}, thumbs: [],
      loudness: {}, result: null, error: null, log: [],
    }),
  });
  check(!/content & mic tracks/.test(text), "no stems toggle on the YouTube cut");
  await unmount();
}

fs.rmSync(tmp, { force: true });
console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
