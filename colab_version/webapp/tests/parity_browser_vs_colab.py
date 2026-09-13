#!/usr/bin/env python3
"""Browser vs Colab parity: same layout, same options -> same numbers.

    cd colab_version
    python3 webapp/tests/parity_browser_vs_colab.py

The preview must be trustworthy: the browser editor (src/lib/*.ts) and the
render pipeline (compose.py / video_processor.py) implement the same math, and
this checks the pairs that decide where a card lands and what the Content-ID
limiter does:

* ``contentPicture()`` (TS) vs ``content_picture_rect()`` — where the content
  picture lands for a set of source sizes and content boxes, including the
  letterboxed (non 16:9 source) cases that used to make the card overrun the
  picture and leave a gap;
* ``buildFairUseLimit()`` (TS) vs ``build_fair_use_limit()`` — cards mode on a
  30 s talking stretch, trim mode on a 2 min reaction, and trim on a 30 min
  reaction with no speech info (the "keeps the first N minutes" case).

The TS side is bundled with esbuild, so this needs node + esbuild (the repo's
own dev dependency, installed by ``npm install``). Without them the script
prints SKIP and exits 0 — the two suites still cover the same invariants
separately (src/__tests__/render_geometry.test.mjs and test_render_parts.py).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLAB = HERE.parent.parent
ROOT = COLAB.parent
sys.path.insert(0, str(COLAB))

FAILS: list[str] = []
CHECKS = [0]


def check(cond: bool, what: str, extra: str = "") -> None:
    CHECKS[0] += 1
    print(f"  {'ok  ' if cond else 'FAIL'} {what}{(' | ' + extra) if extra else ''}")
    if not cond:
        FAILS.append(what)


# The JS half: bundle the same modules the editor uses and print the values.
NODE_DRIVER = r"""
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
const root = process.env.PARITY_ROOT;
const srcDir = path.resolve(root, "src", "lib");
globalThis.document = { createElement: () => ({ getContext: () => null, width: 1, height: 1 }) };
globalThis.Image = class { constructor() { this.naturalWidth = 0; this.naturalHeight = 0; } };
const ENTRY = `export * from "./fairUseCut";\nexport * from "./render";\nexport * from "./timeline";\nexport * from "./types";\n`;
const b = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: srcDir, loader: "ts", sourcefile: "entry.ts" },
  bundle: true, write: false, platform: "node", format: "esm",
});
const tmp = path.join(process.env.PARITY_TMP, "parity_bundle.mjs");
fs.writeFileSync(tmp, b.outputFiles[0].text);
const R = await import(tmp);
const out = { cards30: null, trim120: null, trim1800: null, picture: [] };
{
  const segs = [
    { id: "i", type: "intro", start: 0, end: 10 },
    { id: "b", type: "body", start: 10, end: 40 },
    { id: "o", type: "outro", start: 40, end: 50 },
  ];
  const speech = [{ start: 10, end: 40 }];
  const { segments } = R.buildFairUseLimit(segs, 50, R.defaultFairUse, speech, { start: 10, end: 40 }, null, 4);
  out.cards30 = segments.map((s) => [s.type, +s.start.toFixed(3), +s.end.toFixed(3), s.card?.variant ?? null, s.card?.speed ?? null]);
}
{
  const segs = [{ id: "b", type: "body", start: 0, end: 120 }];
  const speech = [];
  for (let t = 0; t < 120; t += 2) speech.push({ start: t, end: t + 1.2 });
  const opts = { ...R.defaultFairUse, mode: "trim", maxBodySec: 40, keepPad: 0.25 };
  const { segments } = R.buildFairUseLimit(segs, 120, opts, speech, { start: 0, end: 120 }, null, 4);
  out.trim120 = segments.map((s) => [s.type, +s.start.toFixed(3), +s.end.toFixed(3)]);
}
{
  const opts = { ...R.defaultFairUse, mode: "trim", maxBodySec: 600 };
  const { segments } = R.buildFairUseLimit([{ id: "b", type: "body", start: 0, end: 1800 }], 1800,
    opts, null, { start: 0, end: 1800 }, null, 4);
  const kept = segments.filter((s) => s.type !== "cut");
  out.trim1800 = { n: kept.length, first: +kept[0].start.toFixed(1),
                   lastEnd: +kept[kept.length - 1].end.toFixed(1),
                   keptSec: +kept.reduce((a, s) => a + (s.end - s.start), 0).toFixed(1) };
}
for (const [sw, sh] of [[3840, 1080], [1920, 1080], [1920, 2160], [960, 1080], [2560, 1440]]) {
  for (const box of [{ x: 0.294, y: 0.289, w: 0.7, h: 0.7 },
                     { x: 0.05, y: 0.25, w: 0.62, h: 0.7 },
                     { x: 0.3, y: 0.4, w: 0.5, h: 0.5 }]) {
    const r = R.contentPicture({ ...R.defaultLayout, content: box }, { x: 0, y: 0, w: sw, h: sh }, 16 / 9);
    out.picture.push([sw, sh, box.x, box.y, box.w, box.h,
                      +r.x.toFixed(6), +r.y.toFixed(6), +r.w.toFixed(6), +r.h.toFixed(6)]);
  }
}
console.log(JSON.stringify(out));
"""


def browser_side(tmp: Path):
    if not shutil.which("node"):
        return None
    if not (ROOT / "node_modules" / "esbuild").exists():
        return None
    import os
    env = {**os.environ, "PARITY_ROOT": str(ROOT), "PARITY_TMP": str(tmp)}
    # -e keeps the working directory (and so node_modules) at the repo root
    res = subprocess.run(["node", "--input-type=module", "-e", NODE_DRIVER],
                         capture_output=True, text=True, cwd=str(ROOT), env=env)
    if res.returncode != 0:
        print(res.stderr[-2000:])
        return None
    return json.loads(res.stdout)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="parity_"))
    browser = browser_side(tmp)
    if browser is None:
        print("SKIP — node + esbuild not available (npm install in the repo root)")
        return 0

    import compose as C  # noqa: E402
    import layouts as L  # noqa: E402
    import video_processor as V  # noqa: E402
    build = V.ReactionVideoProcessor.build_fair_use_limit

    print("fair-use limiter: cards mode (30 s of talk)")
    segs = [{"type": "intro", "start": 0, "end": 10},
            {"type": "body", "start": 10, "end": 40},
            {"type": "outro", "start": 40, "end": 50}]
    got = [[s["type"], round(float(s["start"]), 3), round(float(s["end"]), 3),
            (s.get("card") or {}).get("variant"), (s.get("card") or {}).get("speed")]
           for s in build(segs, 50, {"mode": "cards"}, [{"start": 10, "end": 40}],
                          {"start": 10, "end": 40}, None, 4.0)]
    check(got == browser["cards30"], "both engines place the same cards",
          f"py {got} ts {browser['cards30']}")

    print("fair-use limiter: trim mode (2 min reaction)")
    speech = [{"start": t, "end": t + 1.2} for t in range(0, 120, 2)]
    got = [[s["type"], round(float(s["start"]), 3), round(float(s["end"]), 3)]
           for s in build([{"type": "body", "start": 0, "end": 120}], 120,
                          {"mode": "trim", "maxBodySec": 40, "keepPad": 0.25},
                          speech, {"start": 0, "end": 120}, None, 4.0)]
    check(got == browser["trim120"], "both engines keep the same islands",
          f"py {len(got)} segs ts {len(browser['trim120'])} segs")

    print("fair-use limiter: trim mode (30 min, no speech info)")
    kept = [s for s in build([{"type": "body", "start": 0, "end": 1800}], 1800,
                             {"mode": "trim", "maxBodySec": 600}, None,
                             {"start": 0, "end": 1800}, None, 4.0)
            if s["type"] != "cut"]
    py = {"n": len(kept), "first": round(kept[0]["start"], 1),
          "lastEnd": round(kept[-1]["end"], 1),
          "keptSec": round(sum(s["end"] - s["start"] for s in kept), 1)}
    check(py == browser["trim1800"], "both engines spread the trim the same way",
          f"py {py} ts {browser['trim1800']}")

    print("content picture rect (where a card lands)")
    bad = 0
    for row in browser["picture"]:
        sw, sh, bx, by, bw, bh, rx, ry, rw, rh = row
        lay = L.LayoutState()
        lay.content = L.Rect(bx, by, bw, bh)
        r = C.content_picture_rect(lay, sw, sh, 1280, 720)
        if not all(abs(a - b) < 1e-3 for a, b in zip((r.x, r.y, r.w, r.h), (rx, ry, rw, rh))):
            bad += 1
            print(f"       src {sw}x{sh} box ({bx},{by},{bw},{bh}): "
                  f"py {tuple(round(v, 4) for v in (r.x, r.y, r.w, r.h))} "
                  f"ts {tuple(round(v, 4) for v in (rx, ry, rw, rh))}")
    check(bad == 0, f"all {len(browser['picture'])} source/box cases match",
          "" if bad == 0 else f"{bad} mismatches")

    print(f"\n{CHECKS[0]} checks, {len(FAILS)} failed")
    for f in FAILS:
        print(f"  FAILED: {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
