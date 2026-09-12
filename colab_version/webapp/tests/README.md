# Tests

Two suites. Neither needs a browser or a GPU.

## Pipeline tests (chunked / resumable renders, stems, cards)

```bash
cd colab_version
python3 webapp/tests/test_render_parts.py        # ~126 checks, ~2.5 min
python3 webapp/tests/test_render_parts.py fast   # planning + card only, <1 s
RENDER_TEST_DIR=/tmp/rt python3 webapp/tests/test_render_parts.py  # reuse fixtures
```

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
