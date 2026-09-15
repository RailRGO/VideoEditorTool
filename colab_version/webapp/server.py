"""
Web editor backend — runs INSIDE Colab, opened as a normal web page.

One cell launches an HTTP server on the Colab VM plus a Cloudflare quick
tunnel (no account needed) and prints a public https:// URL. Open it in any
browser tab: you get the original app experience (smooth playback, draggable
camera/content boxes, timeline) while every heavy operation — exact WYSIWYG
stills, audio/video samples, full renders — runs on the Colab VM against the
real 3 GB file.

How playback stays smooth: the browser streams a small proxy transcode and
composites the layout live on <canvas>; the proxy is cached on Drive, so it
is generated once and reused across sessions.

Usage (in the notebook):
    from webapp.server import launch_webapp
    app = launch_webapp(proc)   # prints the public URL; keeps running

Stdlib only (no Flask/FastAPI needed).
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse, unquote, parse_qs

HERE = Path(__file__).resolve().parent          # .../colab_version/webapp
COLAB_DIR = HERE.parent                          # .../colab_version
if str(COLAB_DIR) not in sys.path:
    sys.path.insert(0, str(COLAB_DIR))

import compose as C  # noqa: E402
import layouts as L  # noqa: E402

RenderCancelled = C.RenderCancelled

INDEX_HTML = HERE / "index.html"
CLOUDFLARED = Path.home() / ".local" / "bin" / "cloudflared"

# a render whose journal has been silent this long has no live owner
LOST_AFTER_S = 90.0


def _fmt_dur(sec: float) -> str:
    sec = max(0, int(sec))
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}m{sec % 60:02d}s"
    return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"


def read_journal(out_dir: Path, key: str) -> Optional[Dict[str, Any]]:
    """One render journal by key (None when there is none)."""
    from video_processor import read_manifest
    try:
        return read_manifest(Path(out_dir), key)
    except Exception:  # noqa: BLE001
        return None


def unfinished_renders(out_dir: Path) -> List[Dict[str, Any]]:
    """Renders with parts on disk but no finished file — newest first.

    Used by the notebook cell so a reclaimed runtime is recoverable without
    opening the browser at all.
    """
    from video_processor import list_journals
    out = []
    for man in list_journals(Path(out_dir)):
        try:
            parts = int(man.get("parts") or 0)
            saved = len(man.get("done") or [])
        except (TypeError, ValueError):
            continue
        if parts <= 0 or saved <= 0 or saved >= parts:
            continue
        if man.get("finished") and Path(str(man.get("output") or "")).exists():
            continue
        out.append({"key": man.get("key"), "target": man.get("target"),
                    "name": (man.get("body") or {}).get("name") or man.get("key"),
                    "saved": saved, "parts": parts,
                    "silent_s": time.time() - float(man.get("updated") or 0),
                    "body": man.get("body") or {}})
    return out


def preflight_output(out_dir: Path, log=None) -> None:
    """Refuse to start a render that cannot possibly be written.

    A silently unmounted /content/drive turns a 40-minute render into an
    empty output folder, so check the mount and the write permission up
    front and say so in the log.
    """
    say = log or (lambda m: None)
    out = Path(out_dir)
    drive = None
    for part in out.parts:
        if part == "drive":
            drive = Path(*out.parts[:out.parts.index("drive") + 1])
            break
    if drive is not None and not drive.is_dir():
        raise RuntimeError(
            f"{drive} is not mounted — reconnect the Drive folder in the "
            "notebook (Files → Mount Drive) and render again")
    try:
        out.mkdir(parents=True, exist_ok=True)
        probe = out / ".write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as e:
        raise RuntimeError(f"the output folder is not writable ({out}): {e}")
    say(f"output folder ok: {out}")


class MountWatchdog:
    """Abort a render when the Drive mount disappears underneath it.

    Also keeps the FUSE mount warm — an idle mount is the usual reason a
    long render dies halfway.
    """

    def __init__(self, out_dir: Path, on_lost, every: float = 30.0):
        self.out = Path(out_dir)
        self.on_lost = on_lost
        self.every = float(every)
        self.stop = threading.Event()
        self.thread: Optional[threading.Thread] = None

    def start(self) -> "MountWatchdog":
        def loop():
            while not self.stop.wait(self.every):
                try:
                    self.out.stat()
                    (self.out.parent / ".").stat()
                except OSError:
                    if not self.stop.is_set():
                        self.on_lost()
                    return
        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()
        return self

    def close(self) -> None:
        self.stop.set()


# Live servers in THIS kernel: port -> {"server", "app", "tunnel_proc", "public"}.
# Lets re-running the launch cell reuse the server (and its state) instead of
# crashing with "Address already in use".
_SERVERS: Dict[int, Dict[str, Any]] = {}


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _is_ours_alive(port: int) -> bool:
    """Is OUR editor server currently answering on this port?"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state",
                                    timeout=4) as r:
            if r.status != 200:
                return False
            d = json.load(r)
            return isinstance(d, dict) and "layout" in d and "segments" in d
    except Exception:
        return False


# ---------------------------------------------------------------------------
# proxy transcode (cached on Drive, generated once)
# ---------------------------------------------------------------------------

_ENCODER_CACHE: Dict[str, bool] = {}


def _nvenc_ok() -> bool:
    """Can h264_nvenc ACTUALLY encode here? (smoke-tested, cached)

    Every static ffmpeg build *lists* h264_nvenc, and a GPU-less runtime dies
    the moment the encoder is opened with "Cannot load libcuda.so.1". That
    used to take the preview proxy down with it: the proxy failed, the browser
    never got a stream, and the play button did nothing at all. compose.py
    already runs a real one-frame encode to find out — the proxy asks the same
    question instead of trusting the encoder list.
    """
    try:
        return bool(C.nvenc_available(verbose=False))
    except Exception:
        return False


def _ffmpeg_has_encoder(name: str) -> bool:
    """True when this ffmpeg build can encode with *name* (cached)."""
    if name in _ENCODER_CACHE:
        return _ENCODER_CACHE[name]
    ok = False
    try:
        p = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                           capture_output=True, text=True, timeout=30)
        ok = f" {name} " in (p.stdout or "")
    except Exception:
        ok = False
    _ENCODER_CACHE[name] = ok
    return ok


def proxy_path_for(proc, width: int = 960) -> Path:
    src = Path(proc.input)
    try:
        st = src.stat()
        key = f"{src.stem}_{st.st_size}_{int(st.st_mtime)}_{width}"
    except OSError:
        key = f"{src.stem}_{width}"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
    d = Path(proc.out) / "proxy"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{safe}.mp4"


def ensure_proxy(proc, width: int = 960,
                 status: Optional[Dict[str, Any]] = None) -> Path:
    """Return a streamable proxy, transcoding it once if needed."""
    out = proxy_path_for(proc, width)
    if out.exists() and out.stat().st_size > 1_000_000:
        if status is not None:
            status.update(ready=True, progress=1.0, path=str(out))
        return out
    if status is not None:
        status.update(ready=False, progress=0.0, path=str(out))
    # 32:9 source -> keep aspect (960x270); stereo AAC so scrubbing has sound.
    # Two-track OBS files would otherwise preview with the mic bus only, so
    # every audio stream is folded into the proxy mix (the render still uses
    # the real buses from the full-resolution source).
    try:
        n_audio = len(proc._probe_audio(str(proc.input)))
    except Exception:
        n_audio = 1
    vf = f"scale={width}:-2,setsar=1"
    # Candidates, most faithful first. A multi-track source (OBS mic+desktop,
    # or a Patreon master carrying mix/content/mic) is folded with amix so the
    # preview has sound from every track; `amix=inputs=N` alone is NOT valid
    # for N streams of one input — it needs N labels, which is the bug that
    # used to kill the proxy (and with it the play button) on stems sources.
    # Whatever fails, the next candidate is tried, so a weird stream layout
    # can never cost the user their preview.
    audio_plans: List[Tuple[str, List[str]]] = []
    if n_audio > 1:
        splits = ";".join(f"[0:a:{i}]aformat=channel_layouts=stereo[a{i}]"
                          for i in range(n_audio))
        labels = "".join(f"[a{i}]" for i in range(n_audio))
        audio_plans.append(("all tracks mixed", ["-filter_complex",
            f"[0:v]{vf}[v];{splits};"
            f"{labels}amix=inputs={n_audio}:duration=longest:normalize=0:"
            f"dropout_transition=0,alimiter=limit=-1dB:attack=5:release=50,"
            f"aformat=channel_layouts=stereo[a]",
            "-map", "[v]", "-map", "[a]"]))
    audio_plans.append(("first track", ["-vf", vf, "-map", "0:v:0",
                                        "-map", "0:a:0?", "-ac", "2"]))
    audio_plans.append(("silent", ["-vf", vf, "-map", "0:v:0", "-an"]))
    dur = max(1.0, float(proc.duration or 1.0))
    # a unique temp name per builder: /api/proxy/retry can start a second
    # worker while an old one is still finishing, and two ffmpeg processes
    # writing one file produce a corrupt proxy (the retry then has to fall
    # back to a worse audio plan to succeed at all)
    tmp = out.with_name(f"{out.stem}.{os.getpid()}.{threading.get_ident()}.tmp.mp4")

    tail: List[str] = []
    audio_args: List[str] = list(audio_plans[0][1])

    def build(use_gpu: bool) -> int:
        """One transcode attempt; returns the ffmpeg exit code."""
        tail.clear()
        # The proxy is a throwaway preview: speed over size. NVENC only when
        # it survived a real smoke encode (a GPU-less runtime lists it and
        # then dies on open), ultrafast x264 otherwise — both are far quicker
        # than the old `veryfast` CPU encode.
        if use_gpu:
            vcodec = ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "28",
                      "-b:v", "0", "-maxrate", "3M", "-bufsize", "6M"]
        else:
            vcodec = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                      "-tune", "fastdecode", "-maxrate", "3M", "-bufsize", "6M"]
        cmd = ["ffmpeg", "-y", "-v", "info", "-i", str(proc.input),
               *audio_args, *vcodec, "-c:a", "aac", "-b:a", "96k",
               "-movflags", "+faststart", str(tmp)]
        p = subprocess.Popen(cmd, stderr=subprocess.STDOUT,
                             stdout=subprocess.PIPE, text=True, bufsize=1)
        assert p.stdout is not None
        for line in p.stdout:
            tail.append(line.rstrip())
            del tail[:-25]
            m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
            if m and status is not None:
                t = (int(m.group(1)) * 3600 + int(m.group(2)) * 60
                     + float(m.group(3)))
                status["progress"] = max(0.0, min(0.99, t / dur))
        p.wait()
        return int(p.returncode or 0)

    gpu = _nvenc_ok()
    attempts = [(True, w, a) for w, a in audio_plans] + \
               [(False, w, a) for w, a in audio_plans] if gpu else \
               [(False, w, a) for w, a in audio_plans]
    rc = 1
    for i, (use_gpu, label, args) in enumerate(attempts):
        audio_args = args
        rc = build(use_gpu)
        if rc == 0 and tmp.exists():
            if i:
                print(f"Proxy: built with '{label}' audio"
                      f"{' on the GPU' if use_gpu else ' on the CPU'}.")
            break
        why = " | ".join(t.strip() for t in tail[-4:])[:300]
        print(f"Proxy attempt '{label}'"
              f"{' (GPU)' if use_gpu else ' (CPU)'} failed (exit {rc}): {why}")
        tmp.unlink(missing_ok=True)
        if status is not None:
            status.update(progress=0.0)
    if rc != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        why = "\n".join(tail[-6:]) or "no ffmpeg output"
        raise RuntimeError(
            f"preview proxy transcode failed (ffmpeg exit {rc}). Last words: "
            f"{why}")
    tmp.replace(out)
    if status is not None:
        status.update(ready=True, progress=1.0, path=str(out))
    return out


def bus_proxy_path_for(proc, bus: str, width: int = 960) -> Path:
    # the mic-channel setting is part of the cache key: switching it means
    # the mic/content mapping changes, so a different file is built
    src = Path(proc.input)
    try:
        st = src.stat()
        key = (f"{src.stem}_{st.st_size}_{int(st.st_mtime)}_{width}_{bus}_"
               f"{proc.audio_cfg.get('mic_channel', 'left')}")
    except OSError:
        key = f"{src.stem}_{width}_{bus}"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
    d = Path(proc.out) / "proxy"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{safe}.mp4"


def ensure_bus_proxy(proc, bus: str, mix_path: Path, width: int = 960,
                     status: Optional[Dict[str, Any]] = None) -> Path:
    """Channel-split preview: the mix proxy's VIDEO (stream copy, instant)
    plus one bus' audio, decoded from the full-resolution source."""
    out = bus_proxy_path_for(proc, bus, width)
    if out.exists() and out.stat().st_size > 1_000_000:
        if status is not None:
            status.update(ready=True, progress=1.0, path=str(out))
        return out
    if status is not None:
        status.update(ready=False, progress=0.0, path=str(out))
    kind, idx = proc._resolve_bus(str(proc.input), bus)
    a_args = (["-map", f"1:a:{idx}", "-ac", "1"] if kind == "stream"
              else ["-map", "1:a:0", "-af", f"pan=mono|c0=c{idx}", "-ac", "1"])
    dur = max(1.0, float(proc.duration or 1.0))
    tmp = out.with_suffix(".tmp.mp4")
    cmd = ["ffmpeg", "-y", "-v", "info",
           "-i", str(mix_path), "-i", str(proc.input),
           "-map", "0:v:0", *a_args,
           "-c:v", "copy", "-c:a", "aac", "-b:a", "96k",
           "-movflags", "+faststart", str(tmp)]
    p = subprocess.Popen(cmd, stderr=subprocess.STDOUT, stdout=subprocess.PIPE,
                         text=True, bufsize=1)
    assert p.stdout is not None
    for line in p.stdout:
        m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
        if m and status is not None:
            t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            status["progress"] = max(0.0, min(0.99, t / dur))
    p.wait()
    if p.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{bus} proxy build failed")
    tmp.replace(out)
    if status is not None:
        status.update(ready=True, progress=1.0, path=str(out))
    return out


# ---------------------------------------------------------------------------
# cloudflare quick tunnel (no account)
# ---------------------------------------------------------------------------

def _binary_ok(exe: str) -> bool:
    """True if *exe* actually runs (catches partial/broken downloads)."""
    try:
        p = subprocess.run([exe, "--version"], capture_output=True, text=True,
                           timeout=15)
        return p.returncode == 0 and "cloudflared" in (p.stdout + p.stderr)
    except Exception:
        return False


def _download(exe: Path, url: str) -> None:
    """Download *url* to *exe* via curl, then wget, then urllib (in that
    order — curl is what Colab always has and handles GitHub's S3 release
    redirects most reliably). Raises RuntimeError with the last error seen."""
    exe.parent.mkdir(parents=True, exist_ok=True)
    tmp = exe.with_suffix(exe.suffix + ".part")
    errors: List[str] = []
    if shutil.which("curl"):
        for attempt in (1, 2):
            p = subprocess.run(
                ["curl", "-fL", "--retry", "2", "--retry-delay", "2",
                 "--max-time", "600", "-o", str(tmp), url],
                capture_output=True, text=True)
            if p.returncode == 0 and tmp.exists() and tmp.stat().st_size > 5_000_000:
                break
            tmp.unlink(missing_ok=True)
            errors.append(f"curl: {(p.stderr or 'failed').strip()[-200:]}")
    if not (tmp.exists() and tmp.stat().st_size > 5_000_000) and shutil.which("wget"):
        p = subprocess.run(
            ["wget", "-q", "--tries=2", "--timeout=60", "-O", str(tmp), url],
            capture_output=True, text=True)
        if p.returncode == 0 and tmp.exists() and tmp.stat().st_size > 5_000_000:
            pass
        else:
            tmp.unlink(missing_ok=True)
            errors.append(f"wget: {(p.stderr or 'failed').strip()[-200:]}")
    if not (tmp.exists() and tmp.stat().st_size > 5_000_000):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            if not (tmp.exists() and tmp.stat().st_size > 5_000_000):
                raise RuntimeError("download too small")
        except Exception as e:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            errors.append(f"urllib: {e}")
    if not (tmp.exists() and tmp.stat().st_size > 5_000_000):
        tmp.unlink(missing_ok=True)
        raise RuntimeError("cloudflared download failed:\n    " +
                           "\n    ".join(errors[-3:]))
    tmp.replace(exe)
    exe.chmod(0o755)


def ensure_cloudflared() -> str:
    if shutil.which("cloudflared"):
        exe = str(shutil.which("cloudflared"))
        if _binary_ok(exe):
            return exe
        print(f"  (ignoring broken cloudflared in PATH: {exe})")
    if CLOUDFLARED.exists():
        if _binary_ok(str(CLOUDFLARED)):
            return str(CLOUDFLARED)
        print("  (removing broken cloudflared binary — re-downloading …)")
        CLOUDFLARED.unlink(missing_ok=True)
    url = ("https://github.com/cloudflare/cloudflared/releases/latest/download/"
           "cloudflared-linux-amd64")
    print("Downloading cloudflared (~30 MB) …")
    _download(CLOUDFLARED, url)
    if not _binary_ok(str(CLOUDFLARED)):
        CLOUDFLARED.unlink(missing_ok=True)
        raise RuntimeError(
            "cloudflared downloaded but does not run (file corrupted or\n"
            "blocked by the network). Re-run the cell to retry; if it\n"
            "persists the launch will try the built-in fallback tunnel.")
    return str(CLOUDFLARED)


def start_tunnel(port: int, timeout: float = 90.0,
                 protocol: Optional[str] = None,
                 _log: Optional[List[str]] = None) -> Tuple[str, subprocess.Popen]:
    """Start a quick tunnel; return (public_url, process).

    *protocol* forces cloudflared's transport ("http2" is the fallback when
    the default QUIC can't get out). cloudflared's recent log lines are
    appended to *_log* (for diagnostics when the tunnel won't come up).
    """
    exe = ensure_cloudflared()
    args = [exe, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"]
    if protocol:
        args += ["--protocol", protocol]
    if _log is None:
        _log = []
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1)
    assert p.stdout is not None
    url = None
    pat = re.compile(r"https://[A-Za-z0-9-]+\.trycloudflare\.com")

    def _note(line: str):
        _log.append(line.rstrip())
        del _log[:-60]

    # readline() blocks, so enforce the timeout with a killer timer instead
    killer = threading.Timer(timeout, lambda: p.poll() is None and p.kill())
    killer.daemon = True
    killer.start()
    try:
        for line in p.stdout:
            _note(line)
            m = pat.search(line)
            if m:
                url = m.group(0)
                break
    finally:
        killer.cancel()
    if url is None:
        try:
            p.terminate()
        except Exception:
            pass
        tail = " | ".join(l for l in _log[-6:] if l.strip()) or "(no output — the binary may be broken or blocked)"
        raise RuntimeError(
            "cloudflared did not print a tunnel URL in time.\n"
            f"    cloudflared said: {tail}\n"
            "Re-run the cell; if it persists, Colab may be blocking "
            "outbound tunnels right now (the launch will also try the\n"
            "built-in fallback tunnel).")
    # drain output in background so the pipe never blocks the tunnel
    def _drain():
        try:
            for line in p.stdout:
                _note(line)
        except Exception:
            pass
    threading.Thread(target=_drain, daemon=True).start()
    return url, p


def start_fallback_tunnel(port: int, timeout: float = 60.0,
                          ssh_port: int = 443,
                          _log: Optional[List[str]] = None) -> Tuple[str, subprocess.Popen]:
    """Fallback quick tunnel: ssh -R to localhost.run (no account needed).

    Used automatically when Cloudflare's quick tunnel can't get out — Colab
    blocks different egress paths at different times, and SSH over 443 to
    localhost.run is the classic workaround. Colab ships an ssh client.
    """
    if not shutil.which("ssh"):
        raise RuntimeError("no ssh client found (fallback tunnel needs it)")
    if _log is None:
        _log = []
    args = ["ssh", "-N", "-p", str(ssh_port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
            "-o", "ConnectTimeout=20",
            f"-R 80:localhost:{port}", "nokey@localhost.run"]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1)
    assert p.stdout is not None
    url = None
    pat = re.compile(r"https://[A-Za-z0-9-]+\.(?:lhr\.life|loca\.lt|localhost\.run)")

    def _note(line: str):
        _log.append(line.rstrip())
        del _log[:-60]

    killer = threading.Timer(timeout, lambda: p.poll() is None and p.kill())
    killer.daemon = True
    killer.start()
    try:
        for line in p.stdout:
            _note(line)
            m = pat.search(line)
            if m:
                url = m.group(0)
                break
    finally:
        killer.cancel()
    if url is None:
        try:
            p.terminate()
        except Exception:
            pass
        tail = " | ".join(l for l in _log[-6:] if l.strip()) or "(no output)"
        raise RuntimeError(
            "localhost.run did not hand out a URL in time.\n"
            f"    ssh said: {tail}")

    def _drain():
        try:
            for line in p.stdout:
                _note(line)
        except Exception:
            pass
    threading.Thread(target=_drain, daemon=True).start()
    return url, p


def _verify_public(url: str, timeout: float = 60.0) -> Tuple[bool, str]:
    """Poll the PUBLIC url until it serves our API (or give up).

    A printed tunnel URL is not always reachable yet (or at all, on a bad
    edge) — we only show the user a URL that demonstrably works.
    """
    deadline = time.time() + timeout
    last_err = "no attempt made"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + "/api/state", timeout=10) as r:
                if r.status == 200:
                    d = json.load(r)
                    if isinstance(d, dict) and "layout" in d:
                        return True, ""
                    last_err = "unexpected reply body"
                else:
                    last_err = f"HTTP {r.status}"
        except Exception as e:  # noqa: BLE001 — reported, then retried
            last_err = f"{type(e).__name__}: {e}".strip()[:160]
        time.sleep(4)
    return False, last_err


# ---------------------------------------------------------------------------
# Upload kit: chapters .srt + thumbnail candidates + EBU R128 loudness QC
# ---------------------------------------------------------------------------

_KIT_LABELS = {
    "body": "Watching", "intro": "Intro", "outro": "Outro",
    "fast": "Speed ramp", "mute": "No audio", "cut": "Cut",
    "card": "Card", "lead": "Lead-in", "start": "Start",
}


def _srt_ts(t: float) -> str:
    ms = max(0, int(round(t * 1000)))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _kit_chapters_srt(segments: List[Dict[str, Any]], fast: float,
                      total: float) -> str:
    """Chapter rows at structural boundaries (type changes), in OUTPUT time.

    YouTube needs a chapter starting at 0:00, so the first row is always
    emitted at t=0; rows closer than 1 s are merged (YouTube requirement).
    """
    # each chapter is labeled by the segment type STARTING at that moment
    rows: List[Tuple[float, str]] = []
    t = 0.0
    prev_label: Optional[str] = None
    for s in segments:
        ty = str(s.get("type", "body"))
        if ty == "cut":
            continue
        if prev_label is None or ty != prev_label:
            if not rows or t - rows[-1][0] >= 1.0:
                rows.append((t, ty))
        prev_label = ty
        ln = s["end"] - s["start"]
        t += ln / max(0.1, fast) if ty == "fast" else ln
    if not rows or rows[0][0] > 0.0:
        rows.insert(0, (0.0, "start"))
    if rows[-1][0] > total - 1.5:  # keep the last chapter meaningful
        rows.pop()
    lines: List[str] = []
    for i, (st, ty) in enumerate(rows):
        et = rows[i + 1][0] if i + 1 < len(rows) else max(total, st + 1.0)
        lines += [str(i + 1), f"{_srt_ts(st)} --> {_srt_ts(et)}",
                  _KIT_LABELS.get(ty, "Section"), ""]
    return "\n".join(lines).rstrip() + "\n"


def _kit_thumbs(final: Path, name: str, out_dir: Path, total: float,
                log) -> List[str]:
    """Five 1280×720 stills at 8/30/50/70/90 % of the finished video."""
    if total < 8:
        log("video too short for thumbnail candidates")
        return []
    names = []
    for i, frac in enumerate((0.08, 0.30, 0.50, 0.70, 0.90), 1):
        t = min(total - 0.5, total * frac)
        p = out_dir / f"{name}_thumb_{i}.jpg"
        r = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(final),
             "-frames:v", "1", "-vf", "scale=1280:720", str(p)],
            capture_output=True, text=True)
        if r.returncode == 0 and p.exists():
            names.append(p.name)
    return names


def _kit_loudness(final: Path, log) -> Dict[str, float]:
    """EBU R128 integrated loudness + true peak of the finished file (audio only)."""
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(final),
             "-vn", "-af", "ebur128", "-f", "null", "-"],
            capture_output=True, text=True, timeout=900)
    except Exception as e:  # noqa: BLE001 — QC must never fail the render
        log(f"loudness check failed: {e}")
        return {}
    text = r.stderr or ""
    integ = re.findall(r"I:\s+(-?\d+\.?\d*)\s+LUFS", text)
    tpeak = re.findall(r"Peak true:\s+(-?\d+\.?\d*)\s*dBTP", text) or \
        re.findall(r"Peak:\s+(-?\d+\.?\d*)\s*dBTP", text)
    out: Dict[str, float] = {}
    if integ:
        out["integrated"] = float(integ[-1])
    if tpeak:
        out["truePeak"] = float(tpeak[-1])
    if out:
        log(f"loudness: I {out.get('integrated')} LUFS · "
            f"true peak {out.get('truePeak')} dBTP (target ≈ −14…−16 LUFS, peak ≤ −1)")
    else:
        log("loudness: could not parse ebur128 output")
    return out


def _build_upload_kit(final: Path, name: str, segments: List[Dict[str, Any]],
                      fast: float, out_dir: Path, log) -> Dict[str, Any]:
    """Chapters + thumbs + loudness for the finished file. Never raises."""
    kit: Dict[str, Any] = {"chapters": None, "thumbs": [], "loudness": {}}
    if not final.exists():
        return kit
    try:
        total = C.render_duration(segments, fast)
        srt = _kit_chapters_srt(segments, fast, total)
        srt_path = out_dir / f"{name}_chapters.srt"
        srt_path.write_text(srt, encoding="utf-8")
        kit["chapters"] = srt_path.name
        log(f"chapters: {srt_path.name}")
        kit["thumbs"] = _kit_thumbs(final, name, out_dir, total, log)
        if kit["thumbs"]:
            log(f"thumbnails: {len(kit['thumbs'])} candidates")
        kit["loudness"] = _kit_loudness(final, log)
    except Exception as e:  # noqa: BLE001 — the render itself already succeeded
        log(f"upload kit: {e}")
    return kit


# ---------------------------------------------------------------------------
# HTTP app
# ---------------------------------------------------------------------------

class App:
    def __init__(self, proc, proxy_width: int = 960):
        self.proc = proc
        self.drops: List[Tuple[float, float]] = []
        self.claims: List[Tuple[float, float, str]] = []
        self.proxy_status: Dict[str, Any] = {"ready": False, "progress": 0.0,
                                             "path": None}
        # which physical channel of a 1-stereo-track OBS file holds the mic
        self.mic_channel = "left"
        # channel-split preview streams ("mic" / "content"), built in the
        # background after the mix proxy; {} when the source is mono
        self.bus_proxies: Dict[str, Dict[str, Any]] = {}
        self.job: Dict[str, Any] = self._fresh_job("render")
        self._job_lock = threading.Lock()
        # wall clock of the last progress line — the UI turns a stale one
        # into "the encoder stopped answering" instead of a frozen bar
        self.job_beat = time.time()
        self.job_started = time.time()
        self.watchdog: Optional[MountWatchdog] = None
        # journal key of the render this server last ran (drives Resume
        # after a cancel or an error)
        self.last_render_key = ""
        self.proxy_width = proxy_width
        self.proxy_gen = 0  # orphaned workers (after a source switch) stand down
        # set by /api/job/cancel; polled by the running render/transcript worker
        self.cancel_requested = False

    def retry_proxy(self) -> Dict[str, Any]:
        """Rebuild the preview stream after a failure (idempotent)."""
        self.proxy_status.update(ready=False, progress=0.0, error=None)
        for bus in ("mic", "content"):
            st = self.bus_proxies.get(bus)
            if isinstance(st, dict):
                st.update(ready=False, progress=0.0, error=None)
        self.proxy_gen += 1
        _start_proxy_worker(self, self.proxy_width)
        return self.proxy_status

    # -- state ---------------------------------------------------------------
    def segments(self) -> List[Dict[str, Any]]:
        cc = self.proc.cuts_cfg
        claims = list(self.claims) + list(cc.get("claims", []))
        return C.build_segments(
            self.proc.duration, intro_end=cc.get("intro_end", 8.0),
            outro_start=cc.get("outro_start", -12.0),
            drops=list(self.drops), claims=claims,
            lead_in=cc.get("lead_in", 2.0), black=cc.get("black", 1.5))

    def state(self) -> Dict[str, Any]:
        segs = self.segments()
        return {
            "info": {**self.proc.info, "path": Path(self.proc.input).name},
            "layout": self.proc.layout.to_dict(),
            "audio": self.proc.audio_cfg,
            "retouch": self.proc.retouch_cfg,
            "cuts": self.proc.cuts_cfg,
            "drops": self.drops,
            "claims": self.claims,
            "segments": segs,
            "render_duration": C.render_duration(segs, self.proc.layout.fastSpeed),
            "proxy": self.proxy_status,
            "mic_channel": self.mic_channel,
            "bus_proxies": self.bus_proxies,
            "job": self.job_state(),
        }

    @staticmethod
    def _fresh_job(kind: str, state: str = "idle") -> Dict[str, Any]:
        return {"kind": kind, "state": state, "progress": 0.0, "files": {},
                "thumbs": [], "loudness": {}, "result": None, "error": None,
                "log": [],
                # honest progress: where the render actually is
                "step": "", "part": 0, "parts": 1, "eta_s": 0.0,
                "elapsed_s": 0.0, "age_s": 0.0, "bytes": 0, "updated": 0.0,
                # set when a chunked render can be picked back up
                "resume": None}

    def job_state(self) -> Dict[str, Any]:
        now = time.time()
        with self._job_lock:
            j = dict(self.job)
            if j["state"] == "running":
                j["age_s"] = now - self.job_beat
        if j["state"] == "idle":
            # a fresh server (or a reclaimed runtime) knows nothing about the
            # render that was running before it — but the parts on disk do
            lost = self._lost_render()
            if lost:
                return lost
        elif j["state"] in ("cancelled", "error") and not j.get("resume"):
            # a stopped render keeps its parts, so stopping is not the end:
            # offer to finish it instead of re-encoding everything
            r = self._open_journal_for(self.last_render_key)
            if r:
                j["resume"] = r
        return j

    def _open_journal_for(self, key: str) -> Optional[Dict[str, Any]]:
        if not key:
            return None
        return self._open_journal(read_journal(self.proc.out, key) or {})

    # -- resumes ------------------------------------------------------------
    def _journals(self) -> List[Dict[str, Any]]:
        from video_processor import list_journals
        try:
            return list_journals(self.proc.out)
        except Exception:  # noqa: BLE001
            return []

    @staticmethod
    def _open_journal(man: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """A journal with parts saved but no finished output = resumable."""
        try:
            parts = int(man.get("parts") or 0)
            done = len(man.get("done") or [])
        except (TypeError, ValueError):
            return None
        if parts <= 0 or done <= 0 or done >= parts:
            return None
        if man.get("finished") and Path(str(man.get("output") or "")).exists():
            return None
        return {"key": man.get("key"), "target": man.get("target", "patreon"),
                "name": (man.get("body") or {}).get("name") or man.get("key"),
                "saved": done, "parts": parts,
                "body": man.get("body") or {},
                "silent_s": time.time() - float(man.get("updated") or 0),
                "when": man.get("updated") or 0}

    def _lost_render(self) -> Optional[Dict[str, Any]]:
        for man in self._journals():
            r = self._open_journal(man)
            if not r or r["silent_s"] < LOST_AFTER_S:
                continue
            job = self._fresh_job("render", "lost")
            job.update(
                progress=r["saved"] / max(1, r["parts"]), part=r["saved"],
                parts=r["parts"], step="lost", resume=r, age_s=r["silent_s"],
                error=(f"stopped after {_fmt_dur(r['silent_s'])} of silence "
                       f"with {r['saved']}/{r['parts']} parts saved — it did "
                       "NOT finish"),
                log=[f"{r['target']} render '{r['name']}' stopped "
                     f"{_fmt_dur(r['silent_s'])} ago.",
                     f"{r['saved']} of {r['parts']} parts are on disk and can "
                     "be reused — press Resume to finish it."])
            return job
        return None

    def resume_render(self, key: str = "") -> Dict[str, Any]:
        """Re-run a stopped render; the parts still on disk are reused."""
        with self._job_lock:
            if self.job["state"] == "running":
                return dict(self.job)
        found = None
        for man in self._journals():
            r = self._open_journal(man)
            if r and (not key or r["key"] == key):
                found = r
                break
        if not found:
            raise ValueError("no unfinished render to resume")
        body = dict(found["body"])
        body.setdefault("target", found["target"])
        body["name"] = found["name"]
        return self.start_render_project(body)

    def cancel_job(self) -> Dict[str, Any]:
        """Ask the running render/transcript worker to stop at its next
        checkpoint. The worker sets the final state ('cancelled') itself."""
        with self._job_lock:
            if self.job["state"] == "running":
                self.cancel_requested = True
                self.job["log"].append("cancelling…")
        return self.job_state()

    # -- speech-to-text (drives the Polish tab's Transcribe button) -----------
    def start_transcript(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Transcribe speech spans (intro/outro) with word timings.

        Shares the single job slot with renders: returns the running job when
        busy instead of queueing, so the UI never stacks heavy work.
        """
        with self._job_lock:
            if self.job["state"] == "running":
                raise ValueError("the server is busy with another job — "
                                 "wait for it first")
            self.job = self._fresh_job("transcript", "running")
            self.cancel_requested = False

        def log(msg):
            with self._job_lock:
                self.job["log"].append(msg)

        def frac(d, t):
            with self._job_lock:
                self.job["progress"] = max(0.0, min(1.0, d / max(1e-6, t)))

        spans = body.get("spans") or []
        lang = str(body.get("lang", "auto") or "auto")

        def run():
            try:
                if not spans:
                    raise ValueError("no speech spans given")
                model = str(body.get("model", "small") or "small")
                res = self.proc.transcribe_spans(spans, lang=lang, model=model,
                                                 progress_cb=frac,
                                                 cancel_check=lambda: self.cancel_requested)
                with self._job_lock:
                    self.job.update(state="done", progress=1.0, result=res)
                log(f"{len(res['words'])} words ({res['lang']}).")
            except RenderCancelled:
                with self._job_lock:
                    self.job.update(state="cancelled", error=None)
                log("transcription cancelled by user.")
            except Exception as e:  # noqa: BLE001 — surfaced to the UI
                with self._job_lock:
                    self.job.update(state="error", error=str(e)[:500])
                log(f"ERROR: {e}")

        threading.Thread(target=run, daemon=True).start()
        return self.job_state()

    # -- project render (driven by the hosted React UI) -------------------------
    def start_render_project(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Render a full project posted by the new UI.

        body: {target, name, segments, layout, audio, retouch, audioCloak,
        videoCloak, crf, webm, fps, height, partTarget, stallMin, budgetMin,
        stems}. Patreon goes through the compositor; YouTube through the
        ffmpeg passthrough. Both render in parts with a journal on disk, so a
        reclaimed runtime costs one part instead of the whole render.
        """
        with self._job_lock:
            if self.job["state"] == "running":
                return dict(self.job)
            self.job = self._fresh_job("render", "running")
            self.cancel_requested = False
            self.job_beat = time.time()
            self.job_started = time.time()

        def log(msg):
            with self._job_lock:
                self.job["log"].append(msg)

        target = str(body.get("target", "patreon"))
        name = str(body.get("name", "youtube_final" if target == "youtube" else "render"))
        name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name) or "render"
        self.last_render_key = name
        def _clean_card(s: Dict[str, Any]) -> Optional[Dict[str, str]]:
            c = s.get("card")
            if not isinstance(c, dict):
                return None
            out = {}
            for k in ("title", "sub", "accent"):
                v = c.get(k)
                if isinstance(v, str) and v.strip():
                    out[k] = v.strip()
            if str(c.get("variant") or "").strip().lower() == "short":
                out["variant"] = "short"
            return out or None

        raw_segs = body.get("segments") or []
        segments = [
            {"type": str(s.get("type", "body")),
             "start": float(s.get("start", 0)), "end": float(s.get("end", 0)),
             "card": _clean_card(s)}
            for s in raw_segs
            if float(s.get("end", 0)) > float(s.get("start", 0))
        ]
        layout_d = body.get("layout") or {}
        fast = float(layout_d.get("fastSpeed", 4.0) or 4.0)
        _fade_ms = body.get("audioFadeMs", 80)
        audio_fade_s = 0.08 if _fade_ms is None else max(0.0, float(_fade_ms) / 1000.0)

        # optional knobs from the Export panel
        try:
            part_target = float(body.get("partTarget") or 0.0)
        except (TypeError, ValueError):
            part_target = 0.0
        try:
            budget_min = float(body.get("budgetMin") or 0.0)
        except (TypeError, ValueError):
            budget_min = 0.0
        try:
            stall_min = float(body.get("stallMin") or 30.0)
        except (TypeError, ValueError):
            stall_min = 30.0
        want_stems = body.get("stems")
        want_stems = None if want_stems is None else bool(want_stems)

        def prog(frac, info):
            """render_project progress -> the job fields the UI reads."""
            now = time.time()
            el = float(info.get("elapsed_s") or (now - self.job_started))
            with self._job_lock:
                self.job["progress"] = max(0.0, min(1.0, float(frac)))
                for k in ("step", "part", "parts", "bytes"):
                    if info.get(k) is not None:
                        self.job[k] = info[k]
                self.job["elapsed_s"] = el
                self.job["eta_s"] = (el * (1.0 - float(frac)) / float(frac)
                                     if float(frac) > 0.02 else 0.0)
                self.job["updated"] = now
                if info.get("reused"):
                    self.job["resume"] = {"saved": len(info["reused"]),
                                          "parts": info.get("parts", 0),
                                          "key": name}
            self.job_beat = now

        def run():
            wd = None
            try:
                from video_processor import (browser_audio_to_cfg,  # noqa
                                             RenderPaused, StallTimeout)
                if not segments:
                    raise ValueError("empty timeline — nothing to render")
                preflight_output(self.proc.out, log)
                wd = MountWatchdog(self.proc.out, self._mount_lost).start()
                self.watchdog = wd
                flat, master = browser_audio_to_cfg(body.get("audio") or {})
                # the posted browser layout is the truth: for Patreon it drives
                # the compositor, for YouTube its content rect is where the
                # card goes (that is the rect the source file was composed in)
                lay = L.LayoutState.from_dict(layout_d)
                self.proc.layout = lay
                if target != "youtube":
                    # the posted browser state drives the engine, exactly as
                    # the old single-pass path did
                    self.proc.audio_cfg.update(flat)
                    if isinstance(body.get("retouch"), dict):
                        self.proc.retouch_cfg.update(body["retouch"])
                log(f"{'YouTube passthrough' if target == 'youtube' else 'Patreon composite'}: "
                    f"{len(segments)} segments, "
                    f"{C.render_duration(segments, fast):.0f}s")
                sticker = body.get("sticker")
                if isinstance(sticker, dict):
                    sticker = {k: sticker.get(k)
                               for k in ("on", "src", "x", "y", "w", "opacity")
                               if sticker.get(k) is not None}
                else:
                    sticker = None
                outs = self.proc.render_project(
                    target=target, name=name, segments=segments,
                    layout=lay,
                    audio=(dict(self.proc.audio_cfg)
                           if target != "youtube" else None),
                    audio_cloak=body.get("audioCloak"),
                    video_cloak=body.get("videoCloak"),
                    sticker=sticker,
                    card=layout_d.get("card") or body.get("card") or {},
                    fast_speed=fast, master_gain_db=master,
                    crf=int(body.get("crf", 23)),
                    fps=body.get("fps") or None,
                    height=int(body.get("height", 0) or 0),
                    width=1920 if not int(body.get("height", 0) or 0)
                    or int(body.get("height", 0) or 0) >= 1080 else 1280,
                    webm=bool(body.get("webm", False)),
                    stems=want_stems, part_target=part_target,
                    audio_fade_s=audio_fade_s,
                    stall_min=stall_min, budget_min=budget_min,
                    progress_cb=prog, log=log, resume_body=dict(body),
                    cancel_check=lambda: self.cancel_requested)
                log("building upload kit (chapters · thumbnails · loudness) …")
                kit = _build_upload_kit(Path(outs.get("mp4") or
                                              next(iter(outs.values()))),
                                        name, segments, fast, self.proc.out, log)
                files = {k: Path(v).name for k, v in outs.items()
                         if k in ("mp4", "webm")}
                if kit["chapters"]:
                    files["chapters"] = kit["chapters"]
                if outs.get("stems"):
                    files["stems"] = outs["stems"]
                with self._job_lock:
                    self.job.update(state="done", progress=1.0, files=files,
                                    thumbs=kit["thumbs"],
                                    loudness=kit["loudness"], step="done",
                                    resume=None)
                log(f"done: {files.get('mp4')} in {self.proc.out}")
            except RenderCancelled:
                with self._job_lock:
                    self.job.update(state="cancelled", error=None,
                                    step="cancelled")
                log("render cancelled by user — finished parts are kept.")
            except RenderPaused as e:
                with self._job_lock:
                    self.job.update(state="paused", error=str(e), step="paused",
                                    resume={"key": name, "parts": 0,
                                            "saved": 0, "name": name,
                                            "target": target})
                log(f"paused: {e}")
            except StallTimeout as e:
                with self._job_lock:
                    self.job.update(state="error", error=str(e),
                                    step="stalled",
                                    resume={"key": name, "name": name,
                                            "target": target})
                log(f"ERROR: {e}")
            except Exception as e:  # noqa: BLE001 — surfaced to the UI
                with self._job_lock:
                    self.job.update(state="error", error=str(e))
                log(f"ERROR: {e}")
            finally:
                if wd is not None:
                    wd.close()
                    self.watchdog = None

        threading.Thread(target=run, daemon=True).start()
        return self.job_state()

    def _mount_lost(self) -> None:
        """Drive vanished mid-render: stop now, keep the parts, say why."""
        self.cancel_requested = True
        with self._job_lock:
            self.job["log"].append(
                "the Drive mount disappeared — stopping; finished parts are "
                "kept for resume")

    def set_input(self, name: str, folder: str = "input") -> Dict[str, Any]:
        """Switch the source file (basename inside the input or output folder).

        folder="output" is how the YouTube step opens the finished Patreon
        master without copying it back into raw/.
        """
        from video_processor import ReactionVideoProcessor  # noqa
        clean = Path(str(name or "")).name
        if not clean or clean.startswith("."):
            raise ValueError("bad file name")
        base = self._source_base(folder)
        cand = (base / clean).resolve()
        if base.resolve() not in cand.parents and cand.parent != base.resolve():
            raise ValueError("file is outside the media folder")
        if not cand.exists() or not cand.is_file():
            raise ValueError(f"file not found: {clean}")
        if cand.suffix.lower() not in self.VIDEO_EXT:
            raise ValueError("not a video file")
        with self._job_lock:
            if self.job["state"] == "running":
                raise ValueError("a render is running — wait for it first")
        old = self.proc
        proc = ReactionVideoProcessor(str(cand), work_dir=str(old.work),
                                      output_dir=str(old.out))
        proc.layout = old.layout
        proc.layout.sourceMode = "split" if proc.is_side_by_side else "single"
        proc.audio_cfg = old.audio_cfg
        proc.retouch_cfg = old.retouch_cfg
        proc.cuts_cfg = old.cuts_cfg
        C.invalidate_cache(str(old.input))
        self.proc = proc
        self.drops = []
        self.claims = []
        with self._job_lock:
            self.job = self._fresh_job("render")
        self.proxy_status.update(ready=False, progress=0.0, path=None)
        self.bus_proxies = {}
        self.mic_channel = str(old.audio_cfg.get("mic_channel", "left"))
        self.proxy_gen += 1
        _start_proxy_worker(self, self.proxy_width)
        return self.state()

    VIDEO_EXT = (".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi")

    def _source_base(self, folder: str = "input") -> Path:
        return self.proc.out if str(folder) == "output" \
            else Path(self.proc.input).parent

    def list_sources(self) -> List[Dict[str, Any]]:
        """Media in the input folder *and* the render output folder.

        The Patreon master is written to the output folder, so that is where
        you pick it up when cutting the YouTube version from it.
        """
        out = []
        cur = str(Path(self.proc.input).resolve())
        for folder in ("input", "output"):
            base = self._source_base(folder)
            try:
                names = sorted(p.name for p in base.iterdir()
                               if p.is_file()
                               and p.suffix.lower() in self.VIDEO_EXT
                               and not p.name.startswith("."))
            except OSError:
                names = []
            for nm in names[:200]:
                try:
                    st = (base / nm).stat()
                except OSError:
                    continue
                out.append({"name": nm, "size": st.st_size,
                            "mtime": st.st_mtime, "folder": folder,
                            "current": str((base / nm).resolve()) == cur})
        return out

    # -- background full render ----------------------------------------------
    def start_render(self, name: str, crf: int, webm: bool) -> Dict[str, Any]:
        with self._job_lock:
            if self.job["state"] == "running":
                return dict(self.job)
            self.job = self._fresh_job("render", "running")

        def log(msg):
            with self._job_lock:
                self.job["log"].append(msg)

        def cb(done, total):
            with self._job_lock:
                self.job["progress"] = done / max(1, total) * 0.9

        def run():
            try:
                segs = self.segments()
                log(f"{len(segs)} segments, render "
                    f"{C.render_duration(segs, self.proc.layout.fastSpeed):.0f}s")

                video_nc = self.proc.work / f"{name}_video.mp4"
                self.proc.compose_reaction(
                    output_path=str(video_nc), layout=self.proc.layout,
                    segments=segs, crf=int(crf))
                with self._job_lock:
                    self.job["progress"] = 0.9
                log("video done — mixing audio …")
                audio = self.proc.mix_audio(
                    output_path=str(self.proc.work / f"{name}_mix.wav"),
                    segments=segs, fast_speed=self.proc.layout.fastSpeed)
                outs = self.proc.mux(video_nc, audio,
                                     self.proc.out / f"{name}.mp4", webm=webm)
                with self._job_lock:
                    self.job.update(state="done", progress=1.0,
                                    files={k: Path(v).name for k, v in outs.items()})
                log("done.")
            except Exception as e:  # noqa: BLE001 — surfaced to the UI
                with self._job_lock:
                    self.job.update(state="error", error=str(e))
                log(f"ERROR: {e}")

        # NOTE: compose_reaction prints its own progress; wire fractional
        # updates by monkey-patching C.render_video's callback through closure:
        orig_render = C.render_video

        def patched(*a, **kw):
            kw["progress_cb"] = lambda d, t: cb(d, t)
            return orig_render(*a, **kw)

        C.render_video = patched  # type: ignore
        try:
            threading.Thread(target=self._run_guarded(run, orig_render),
                             daemon=True).start()
        except Exception:
            C.render_video = orig_render  # type: ignore
            raise
        return self.job_state()

    def _run_guarded(self, run, orig_render):
        def inner():
            try:
                run()
            finally:
                C.render_video = orig_render  # type: ignore
        return inner


class Handler(BaseHTTPRequestHandler):
    app: App  # set by serve()
    server_version = "ReactionWeb/1.0"

    # -- plumbing -------------------------------------------------------------
    def log_message(self, fmt, *args):
        pass  # keep the notebook output clean; errors go to JSON

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Range, ngrok-skip-browser-warning")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _json(self, obj: Any, code: int = 200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(min(n, 4_000_000))
        try:
            return json.loads(raw.decode() or "{}")
        except (ValueError, UnicodeDecodeError):
            return {}

    def _read_upload(self) -> Path:
        """multipart/form-data image upload -> a file inside the output dir.

        Feeds the sticker overlay (subscribe / like images) and any other
        asset the UI wants to hand to the renderer. Images only, 20 MB cap,
        sanitised basename — the /files/ route serves it right back.
        """
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype or "boundary=" not in ctype:
            raise ValueError("expected multipart/form-data")
        boundary = ctype.split("boundary=", 1)[1].strip().strip('"').encode()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise ValueError("empty upload")
        if length > 25_000_000:
            raise ValueError("file too large (max ~20 MB)")
        data = self.rfile.read(length)
        for part in data.split(b"--" + boundary):
            if b"filename=\"" not in part:
                continue
            head_end = part.find(b"\r\n\r\n")
            if head_end < 0:
                continue
            head = part[:head_end].decode("utf-8", "ignore")
            m = re.search(r'filename="([^"]*)"', head)
            body = part[head_end + 4:]
            if body.endswith(b"\r\n"):
                body = body[:-2]
            name = Path(m.group(1)).name if m else "upload"
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._") \
                or "upload"
            if not re.search(r"\.(png|jpe?g|webp|gif)$", name, re.I):
                name += ".png"
            ok_magic = (body.startswith(b"\x89PNG"),
                        body.startswith(b"\xff\xd8\xff"),
                        body[:4] == b"RIFF" and body[8:12] == b"WEBP",
                        body.startswith(b"GIF8"))
            if not any(ok_magic):
                raise ValueError(
                    "only PNG / JPEG / WebP / GIF images are accepted")
            saved = Path(self.app.proc.out) / f"u_{int(time.time())}_{name}"
            saved.write_bytes(body)
            return saved
        raise ValueError("no file field in the upload")

    def _send_file(self, path: Path, content_type: Optional[str] = None):
        """Serve a file with HTTP Range support (needed for <video> seeking)."""
        if not path.exists() or not path.is_file():
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        size = path.stat().st_size
        ctype = content_type or mimetypes.guess_type(str(path))[0] or \
            "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                a, b = m.groups()
                if a:
                    start = int(a)
                    end = int(b) if b else size - 1
                elif b:
                    start = max(0, size - int(b))
                start = max(0, min(start, size - 1))
                end = max(start, min(end, size - 1))
                code = 206
        length = end - start + 1
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    # -- routes -----------------------------------------------------------------
    def do_GET(self):
        app = self.app
        proc = app.proc
        url = urlparse(self.path)
        path = url.path
        try:
            if path in ("/", "/index.html"):
                if not INDEX_HTML.exists():
                    self._json({"error": "index.html missing"}, 500)
                    return
                self._send_file(INDEX_HTML, "text/html; charset=utf-8")
            elif path == "/api/state":
                self._json(app.state())
            elif path == "/api/timeline":
                segs = app.segments()
                self._json({"segments": segs,
                            "render_duration": C.render_duration(
                                segs, proc.layout.fastSpeed)})
            elif path == "/api/proxy_status":
                self._json(app.proxy_status)
            elif path == "/api/proxy.mp4":
                q = parse_qs(url.query)
                bus = (q.get("bus") or ["mix"])[0]
                if bus in ("mic", "content"):
                    st = app.bus_proxies.get(bus) or {}
                    p = Path(st.get("path") or "")
                    if not st.get("ready") or not p.exists():
                        self._json(
                            {"error": st.get("error") or "preview not ready yet"},
                            503)
                        return
                    self._send_file(p, "video/mp4")
                    return
                p = Path(app.proxy_status.get("path") or "")
                if not app.proxy_status.get("ready") or not p.exists():
                    self._json({"error": "proxy not ready yet"}, 503)
                    return
                self._send_file(p, "video/mp4")
            elif path == "/api/job":
                self._json(app.job_state())
            elif path == "/api/sources":
                self._json({"sources": app.list_sources(),
                            "current": Path(proc.input).name})
            elif path == "/api/content_start":
                t = proc.detect_content_start()
                self._json({"t": t})
            elif path.startswith("/files/"):
                name = unquote(path[len("/files/"):])
                if "/" in name or "\\" in name or name.startswith("."):
                    self._json({"error": "bad name"}, 400)
                    return
                self._send_file(Path(proc.out) / name)
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        app = self.app
        proc = app.proc
        url = urlparse(self.path)
        path = url.path
        try:
            if path == "/api/upload":
                # multipart — must be read before the JSON reader touches
                # the body
                saved = self._read_upload()
                self._json({"ok": True, "name": saved.name,
                            "url": f"/files/{saved.name}"})
                return
            body = self._read_json()
            if path == "/api/layout":
                proc.layout = L.LayoutState.from_dict(body.get("layout", {}))
                self._json({"ok": True})
            elif path == "/api/cuts":
                if "cuts" in body:
                    proc.cuts_cfg.update(body["cuts"])
                if "drops" in body:
                    app.drops = [(float(a), float(b)) for a, b in body["drops"]]
                if "claims" in body:
                    app.claims = [(float(a), float(b), str(c))
                                  for a, b, c in body["claims"]]
                segs = app.segments()
                self._json({"ok": True, "segments": segs,
                            "render_duration": C.render_duration(
                                segs, proc.layout.fastSpeed)})
            elif path == "/api/audio":
                proc.audio_cfg.update(body)
                self._json({"ok": True})
            elif path == "/api/retouch":
                proc.retouch_cfg.update(body)
                self._json({"ok": True})
            elif path == "/api/frame":
                t = float(body.get("t", 0))
                mode = str(body.get("mode", "body"))
                w = max(320, min(1280, int(body.get("w", 854))))
                if "layout" in body:
                    proc.layout = L.LayoutState.from_dict(body["layout"])
                hook = None
                if proc.retouch_cfg.get("enabled"):
                    try:
                        hook = proc._cam_hook()
                    except ImportError:
                        hook = None  # mediapipe missing: stills stay unretouched
                fr = C.preview(str(proc.input), t, proc.layout, mode=mode,
                               width=w, cam_hook=hook)
                if fr is None:
                    self._json({"error": "frame extraction failed"}, 500)
                    return
                data = C.to_jpeg(fr, quality=int(body.get("q", 78)))
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif path == "/api/detect":
                keep = proc.auto_cut_reaction(
                    silence_db=proc.cuts_cfg.get("silence_db", -40.0),
                    min_silence_sec=proc.cuts_cfg.get("min_silence", 2.0))
                ie = proc.cuts_cfg.get("intro_end", 8.0)
                os_ = proc.duration + proc.cuts_cfg.get("outro_start", -12.0)
                drops = []
                for d in proc.keeps_to_drops(keep, proc.duration):
                    s, e = max(d[0], ie), min(d[1], os_)
                    if e - s > 0.3:
                        drops.append([round(s, 2), round(e, 2)])
                app.drops = [(a, b) for a, b in drops]
                self._json({"drops": drops})
            elif path == "/api/audio_sample":
                import subprocess as sp
                t0 = max(0.0, float(body.get("t", 30)) - 5)
                clip = proc.work / "web_audio_sample_src.mp4"
                sp.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t0:.1f}",
                        "-t", "10", "-i", str(proc.input), "-c", "copy",
                        str(clip)], check=True)
                out = proc.mix_audio(
                    input_path=str(clip),
                    output_path=str(proc.out / "web_audio_sample.wav"))
                self._json({"file": Path(out).name})
            elif path == "/api/sample":
                outs = proc.render_sample(
                    float(body.get("t", 30)),
                    seconds=float(body.get("seconds", 12)),
                    mode=str(body.get("mode", "body")), layout=proc.layout,
                    name="web_sample")
                self._json({"file": Path(outs["mp4"]).name,
                            "size": Path(outs["mp4"]).stat().st_size})
            elif path == "/api/render_full":
                job = app.start_render(str(body.get("name", "youtube_final")),
                                       int(body.get("crf", 23)),
                                       bool(body.get("webm", True)))
                self._json(job)
            elif path == "/api/job/render":
                self._json(app.start_render_project(body))
            elif path == "/api/job/resume":
                try:
                    self._json(app.resume_render(str(body.get("key", ""))))
                except ValueError as e:
                    self._json({"error": str(e)}, 409)
            elif path == "/api/job/transcript":
                try:
                    self._json(app.start_transcript(body))
                except ValueError as e:
                    self._json({"error": str(e)}, 409)
            elif path == "/api/job/cancel":
                self._json(app.cancel_job())
            elif path == "/api/source":
                try:
                    self._json(app.set_input(str(body.get("name", "")),
                                             str(body.get("folder", "input"))))
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
            elif path == "/api/mic_channel":
                ch = str(body.get("channel", "left"))
                if ch not in ("left", "right"):
                    self._json({"error": "channel must be left or right"}, 400)
                    return
                proc.audio_cfg["mic_channel"] = ch
                app.mic_channel = ch
                # the mic/content mapping changed — rebuild the split previews
                mix = Path(app.proxy_status.get("path") or "")
                if app.proxy_status.get("ready") and mix.exists():
                    for bus in ("mic", "content"):
                        app.bus_proxies[bus] = {"ready": False,
                                                "progress": 0.0, "path": None,
                                                "error": None}
                    _start_bus_worker(app, app.proxy_width)
                self._json({"ok": True})
            elif path == "/api/save_layout":
                # always a basename inside the output dir (no traversal)
                name = Path(str(body.get("path") or "layout.json")).name
                p = proc.layout.save(Path(proc.out) / name)
                self._json({"ok": True, "path": p})
            elif path == "/api/proxy/retry":
                # a failed preview build used to be permanent: the worker set
                # proxy.error, the UI threw it, and the play button was dead
                # until the notebook was restarted. This just runs it again.
                self._json({"ok": True, "proxy": app.retry_proxy()})
            elif path == "/api/load_layout":
                name = str(body.get("path") or "").strip()
                if not name:
                    self._json({"error": "missing path"}, 400)
                    return
                # basenames resolve inside the output dir; absolute paths
                # elsewhere on Drive are allowed for power users
                src = name if Path(name).is_absolute() else \
                    str(Path(proc.out) / Path(name).name)
                proc.load_layout(src)
                self._json({"ok": True, "layout": proc.layout.to_dict()})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)


# ---------------------------------------------------------------------------
# launch
# ---------------------------------------------------------------------------

def _start_proxy_worker(app: App, proxy_width: int) -> None:
    gen = app.proxy_gen
    proc = app.proc

    def _proxy_worker():
        try:
            print("Preparing streamable proxy (one-time, cached on Drive)…")
            ensure_proxy(proc, proxy_width, app.proxy_status)
            if gen != app.proxy_gen:
                print("Proxy worker orphaned by a source switch — standing down.")
                return
            print(f"Proxy ready: {app.proxy_status['path']}")
            # channel-split previews for OBS files that carry two audio buses
            try:
                n_audio = len(proc._probe_audio(str(proc.input)))
            except Exception:
                n_audio = 1
            if n_audio >= 2 and gen == app.proxy_gen:
                for bus in ("mic", "content"):
                    app.bus_proxies[bus] = {"ready": False, "progress": 0.0,
                                            "path": None, "error": None}
                _start_bus_worker(app, proxy_width)
        except Exception as e:
            if gen != app.proxy_gen:
                return
            app.proxy_status.update(ready=False, progress=0.0,
                                    error=str(e)[:600])
            print(f"Proxy failed: {e} — exact stills still work, and "
                  f"POST /api/proxy/retry builds the stream again.")
            print(traceback.format_exc(limit=3))

    threading.Thread(target=_proxy_worker, daemon=True).start()


def _start_bus_worker(app: "App", proxy_width: int) -> None:
    """Build the mic-only / content-only preview streams in the background.

    The video is a stream copy of the mix proxy (instant); only the audio
    comes from the full-resolution source, so this is far cheaper than a
    fresh transcode.
    """
    gen = app.proxy_gen
    proc = app.proc

    def _bus_worker():
        try:
            mix = Path(app.proxy_status.get("path") or "")
            if not mix.exists():
                return
            for bus in ("mic", "content"):
                if gen != app.proxy_gen:
                    return
                ensure_bus_proxy(proc, bus, mix, proxy_width,
                                 app.bus_proxies[bus])
            print("Bus proxies ready (mic / content).")
        except Exception as e:
            if gen != app.proxy_gen:
                return
            print(f"Bus proxy failed: {e} — the mix preview still works.")
            for bus in ("mic", "content"):
                app.bus_proxies[bus].update(ready=False, error=str(e)[:200])

    threading.Thread(target=_bus_worker, daemon=True).start()


def serve_forever(proc, port: int = 8000,
                 proxy_width: int = 960) -> Tuple[ThreadingHTTPServer, App]:
    app = App(proc, proxy_width)
    _start_proxy_worker(app, proxy_width)

    # per-server Handler subclass so two servers (two videos/ports) never
    # share one App through the class attribute
    handler_cls = type(f"Handler{port}", (Handler,), {"app": app})
    # must bind all interfaces so the tunnel can reach it
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler_cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"Web editor serving on 0.0.0.0:{port}")
    return httpd, app


def stop_webapp(port: int = 8000) -> None:
    """Shut down a launched server and its tunnel (frees the port)."""
    reg = _SERVERS.pop(port, None)
    if reg is None:
        print(f"No tracked server on port {port}.")
        return
    tp = reg.get("tunnel_proc")
    if tp is not None and tp.poll() is None:
        try:
            tp.terminate()
        except Exception:
            pass
    try:
        reg["server"].shutdown()
        reg["server"].server_close()
    except Exception:
        pass
    print(f"Stopped web server on port {port}.")


def _kill_proc(p) -> None:
    if p is not None and p.poll() is None:
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


def launch_webapp(proc, port: int = 8000, tunnel: bool = True,
                  proxy_width: int = 960, verify: bool = True) -> Dict[str, Any]:
    """Start the server (+ tunnel) and print the URL to open.

    Safe to re-run: a live server on *port* is reused (state kept) and only
    the tunnel is renewed. The printed URL is verified to serve traffic
    before it is shown; if the default transport fails, HTTP/2 is tried.

    Returns {"local": ..., "public": ..., "server": ..., "app": ...}.
    In Colab, open the *public* URL in a new browser tab.
    """
    if port in _SERVERS and _is_ours_alive(port):
        old_proc = _SERVERS[port]["app"].proc
        if str(getattr(old_proc, "input", "")) != str(proc.input):
            print("Different video than the running server — "
                  "restarting the server for the new file.")
            stop_webapp(port)
        else:
            print(f"Server already running on port {port} — reusing it "
                  f"(your layout/cuts/state are kept).")
    if port not in _SERVERS or not _is_ours_alive(port):
        _SERVERS.pop(port, None)
        use_port = port
        for _ in range(10):
            if _port_free(use_port):
                break
            use_port += 1
        if use_port != port:
            print(f"Port {port} is busy (not ours) — using port {use_port}.")
            port = use_port
        httpd, app = serve_forever(proc, port, proxy_width)
        _SERVERS[port] = {"server": httpd, "app": app,
                          "tunnel_proc": None, "public": None}

    reg = _SERVERS[port]
    info: Dict[str, Any] = {"local": f"http://127.0.0.1:{port}",
                            "public": None, "server": reg["server"],
                            "app": reg["app"]}
    if not tunnel:
        print(f"Serving locally: {info['local']}")
        return info

    _kill_proc(reg.get("tunnel_proc"))  # never stack tunnels on re-runs

    # Each entry: (label, start-fn) — tried in order until one verifies.
    attempts: List[Tuple[str, Any]] = [
        ("Cloudflare quick tunnel (default transport)",
         lambda log: start_tunnel(port, _log=log)),
        ("Cloudflare quick tunnel (http2 transport)",
         lambda log: start_tunnel(port, protocol="http2", _log=log)),
        ("Fallback tunnel via ssh → localhost.run (port 443, no account)",
         lambda log: start_fallback_tunnel(port, ssh_port=443, _log=log)),
        ("Fallback tunnel via ssh → localhost.run (port 22, no account)",
         lambda log: start_fallback_tunnel(port, ssh_port=22, _log=log)),
    ]
    url, tp, last_log = None, None, []
    download_error: Optional[Exception] = None
    for label, starter in attempts:
        _kill_proc(tp)
        last_log = []
        print(f"Starting {label} …")
        try:
            url, tp = starter(last_log)
        except RuntimeError as e:
            print(f"  ✗ {e}")
            url = None
            if "download" in str(e):
                download_error = e
            continue
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ unexpected: {type(e).__name__}: {e}")
            url = None
            continue
        if not verify:
            break
        print(f"  got {url} — checking it really serves traffic …")
        ok, err = _verify_public(url)
        if ok:
            print("  ✓ tunnel verified: reachable from the outside.")
            break
        print(f"  ✗ not reachable ({err})")
        url = None
    if url is None:
        print()
        print("None of the tunnels could be verified from the outside. "
              "The web site therefore won't open for now.")
        if last_log:
            print("Last tunnel log lines:")
            for line in last_log[-8:]:
                print("   |", line)
        if download_error is not None:
            print()
            print("The cloudflared download itself failed, which usually "
                  "means this session's network blocked GitHub releases.")
            print("Try:  !curl -fL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64  # then re-run this cell")
        print()
        print("Things to try, in order:")
        print("  1. Just re-run this cell (fresh tunnel + fresh edge).")
        print("  2. Runtime → Restart session, then run cells 1→3c again.")
        print("  3. Use the in-cell editor instead (no tunnel needed):")
        print("       from editor_gui import launch_editor; launch_editor(proc)")
        return info

    reg["tunnel_proc"] = tp
    reg["public"] = url
    info["public"] = url
    info["tunnel_proc"] = tp
    print()
    print("=" * 64)
    print("  OPEN THIS URL IN A NEW BROWSER TAB (verified working):")
    print(f"  {url}")
    print("=" * 64)
    print("Re-running this cell is safe: it keeps the server and makes a")
    print("fresh tunnel. The link dies with the session. Anyone with the")
    print("link can view, so don't share it publicly.")
    return info


if __name__ == "__main__":
    # Local dev: python server.py /path/to/video.mp4 [port]
    sys.path.insert(0, str(COLAB_DIR))
    from video_processor import ReactionVideoProcessor
    video = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fake3840.mp4"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    proc = ReactionVideoProcessor(video, output_dir="/tmp/web_out")
    httpd, app = serve_forever(proc, port)
    print(f"open http://127.0.0.1:{port}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
