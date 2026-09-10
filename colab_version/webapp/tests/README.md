# Web app end-to-end test (jsdom, no browser needed)

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
