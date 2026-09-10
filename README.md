# Reaction Studio

A reaction-video editor with two deliverables: the full uncut **Patreon** version
(composited from the raw 3840×1080 OBS capture) and the shorter **YouTube** cut
(full-frame passthrough of the finished Patreon render, with an anti-fingerprint cloak).

## Two engines, one UI

| Engine | Source | Preview | Render |
|---|---|---|---|
| **This PC** | file on your disk | full-res, local canvas | in-browser MediaRecorder (WebM) |
| **Colab** | files on the notebook side | light proxy stream | server ffmpeg (MP4), full-res original |

Weak PC? Host this UI once (static site — `render.yaml` deploys it on Render's free
tier), run the notebook, paste its tunnel URL into the app's Colab mode, and edit.
Nothing uploads from your machine: the browser sends a small project JSON and gets
the finished MP4 back. Closing the tab mid-render is safe — reconnect and the
download is waiting in the Render tab.

## Develop

```bash
npm ci
npm run dev      # local UI on :5173
npm run build    # static bundle in dist/
```

## Colab backend

`colab_version/` holds the Python pipeline: WYSIWYG compositor (`compose.py`),
shared layout model (`layouts.py`), render/audio/retouch pipeline
(`video_processor.py`), the HTTP server + tunnel (`webapp/server.py`), and the
notebook (`video_editor_colab.ipynb`). See `colab_version/README.md`.
