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
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse, unquote

HERE = Path(__file__).resolve().parent          # .../colab_version/webapp
COLAB_DIR = HERE.parent                          # .../colab_version
if str(COLAB_DIR) not in sys.path:
    sys.path.insert(0, str(COLAB_DIR))

import compose as C  # noqa: E402
import layouts as L  # noqa: E402

INDEX_HTML = HERE / "index.html"
CLOUDFLARED = Path.home() / ".local" / "bin" / "cloudflared"

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
    # 32:9 source -> keep aspect (960x270); stereo AAC so scrubbing has sound
    cmd = ["ffmpeg", "-y", "-v", "info", "-i", str(proc.input),
           "-vf", f"scale={width}:-2", "-c:v", "libx264", "-preset", "veryfast",
           "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-ac", "2",
           "-movflags", "+faststart", str(out)]
    # run with progress parsed from the `time=` field
    dur = max(1.0, float(proc.duration or 1.0))
    tmp = out.with_suffix(".tmp.mp4")
    cmd[-1] = str(tmp)
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
        raise RuntimeError("proxy transcode failed (see ffmpeg output above)")
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
# HTTP app
# ---------------------------------------------------------------------------

class App:
    def __init__(self, proc):
        self.proc = proc
        self.drops: List[Tuple[float, float]] = []
        self.claims: List[Tuple[float, float, str]] = []
        self.proxy_status: Dict[str, Any] = {"ready": False, "progress": 0.0,
                                             "path": None}
        self.job: Dict[str, Any] = {"state": "idle", "progress": 0.0,
                                    "files": {}, "error": None, "log": []}
        self._job_lock = threading.Lock()

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
            "job": self.job_state(),
        }

    def job_state(self) -> Dict[str, Any]:
        with self._job_lock:
            return dict(self.job)

    # -- background full render ----------------------------------------------
    def start_render(self, name: str, crf: int, webm: bool) -> Dict[str, Any]:
        with self._job_lock:
            if self.job["state"] == "running":
                return dict(self.job)
            self.job = {"state": "running", "progress": 0.0, "files": {},
                        "error": None, "log": []}

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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")

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
                p = Path(app.proxy_status.get("path") or "")
                if not app.proxy_status.get("ready") or not p.exists():
                    self._json({"error": "proxy not ready yet"}, 503)
                    return
                self._send_file(p, "video/mp4")
            elif path == "/api/job":
                self._json(app.job_state())
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
                                       int(body.get("crf", 18)),
                                       bool(body.get("webm", True)))
                self._json(job)
            elif path == "/api/save_layout":
                # always a basename inside the output dir (no traversal)
                name = Path(str(body.get("path") or "layout.json")).name
                p = proc.layout.save(Path(proc.out) / name)
                self._json({"ok": True, "path": p})
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

def serve_forever(proc, port: int = 8000,
                 proxy_width: int = 960) -> Tuple[ThreadingHTTPServer, App]:
    app = App(proc)

    def _proxy_worker():
        try:
            print("Preparing streamable proxy (one-time, cached on Drive)…")
            ensure_proxy(proc, proxy_width, app.proxy_status)
            print(f"Proxy ready: {app.proxy_status['path']}")
        except Exception as e:
            app.proxy_status.update(ready=False, error=str(e)[:300])
            print(f"Proxy failed: {e} — exact stills still work.")

    threading.Thread(target=_proxy_worker, daemon=True).start()

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
