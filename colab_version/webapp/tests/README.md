# Tests

Three suites. None of them needs a browser or a GPU.

## Pipeline tests (chunked / resumable renders, stems, cards)

```bash
cd colab_version
python3 webapp/tests/test_render_parts.py        # ~126 checks, ~2.5 min
python3 webapp/tests/test_render_parts.py fast   # planning + card + limiter, <1 s, no ffmpeg
python3 webapp/tests/parity_browser_vs_colab.py  # preview == render (node + esbuild)
RENDER_TEST_DIR=/tmp/rt python3 webapp/tests/test_render_parts.py  # reuse fixtures
```

### Mirror tests (Cloak tab → Mirroring)

```bash
python3 webapp/tests/test_mirror.py        # ~80 checks, ~10 s
python3 webapp/tests/test_mirror.py fast   # resolve_mirror + planning, no ffmpeg
```

`resolve_mirror()` is the Python twin of `resolveMirror()` in
`src/lib/types.ts`: mode (`content` / `frame` / off), the per-block tick when
the scope is `blocks`, the legacy `flip`/`flipContent` flags of pre-v7
projects, and the 0…60 % clamp on the strip that stays readable. The tests
render real files and measure the pixels: the content rect swaps left/right,
the kept bottom strip does NOT (burned-in subtitles and the bottom of a short
card live there), a whole-picture mirror flips the frame and still draws the
card upright, intro/outro never flip, a ticked block flips while its unticked
neighbour does not — and the last check goes through
`POST /api/job/render` so the file the webapp hands back is the file the
preview promised, chunked renders included.

The `fast` half (part planning, card geometry, card speed, the fair-use
limiter, vignette parity) is pure math and needs no ffmpeg.
`parity_browser_vs_colab.py` bundles the browser's `src/lib/*.ts` with esbuild
and checks `contentPicture()`/`content_picture_rect()` and both limiter modes
against the Python twins, so the preview and the render cannot drift apart.

Builds its own fixtures (a 3840×1080 two-track capture and a 16:9
three-track master of pure sine tones), then proves on the finished files:
the part plan tiles the timeline exactly, a truncated part is rebuilt,
a killed render is reported as `lost` and resumes from its parts (through
both the HTTP API and `colab_launch.tools()`), chunked output has the same
frame count as a single pass, mute/card spans silence the content bus and
keep the mic (FFT of the real output), a Patreon master carries three
labelled tracks, the YouTube cut reads tracks 2+3, and the card covers the
content rect while the camera corner survives.

## Web app end-to-end test (jsdom, no browser needed)

Drives the real `index.html` against a live `server.py`: boot, sliders,
preset apply, timeline seek, box drag, claims, tab builds, exact stills —
12 checks, failing on any page error.

```bash
# 1) start the server with any test video (needs ffmpeg on PATH for proxy,
#    but the test also passes in stills mode)
cd ../../..                      # -> colab_version/
python3 webapp/server.py /path/to/video.mp4 8931 &

# 2) run the suite
cd webapp/tests
npm install          # once (jsdom only)
npm test             # or: WEBAPP_URL=http://127.0.0.1:8931 node e2e.mjs
```

The suite stubs `<canvas>`/`<video>` (pixel rendering isn't asserted —
that's covered by comparing `/api/frame` output against `compose.py`,
which share the same code path by construction). What it *does* prove:
the page boots against the real API, every control round-trips state to
the server, and no JS error is thrown anywhere along the way.
