"""The whole Colab side of Reaction Studio, in one call.

`backend_colab.ipynb` is only a settings form — nothing in it needs editing, and
every decision behind it lives here so it can change without touching the
notebook: install what's missing, refresh the code, mount Drive, open the
capture and serve the editor (+ tunnel). Cutting and rendering happen in the
browser tab against the same server, so this module never builds a timeline.

From a cell:

    from colab_launch import start, tools
    start("/content/drive/MyDrive/raw", "/content/drive/MyDrive/reaction_output",
          "https://reaction-studio.onrender.com")
    tools("link + status")      # also: "renew the tunnel link", "stop the server",
                                #       "in-cell editor (no tunnel)",
                                #       "resume the unfinished render"

Re-runnable: deps are installed only when missing, the checkout is fast-
forwarded instead of re-cloned, and a live server is reused (your edit/state
survive) with a fresh link. Stdlib only.
"""
from __future__ import annotations

import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent            # .../VideoEditorTool/colab_version
REPO_URL = "https://github.com/RailRGO/VideoEditorTool"
REPO_DIR = Path("/content/VideoEditorTool")       # where the code is cloned
DRIVE = Path("/content/drive")                     # Colab's Drive mount point

# importable name -> pip package. mediapipe = retouch, faster_whisper = the
# Polish tab's transcription; all three are optional at runtime but cheap here.
DEPS: Dict[str, str] = {"numpy": "numpy", "cv2": "opencv-python",
                        "mediapipe": "mediapipe",
                        "faster_whisper": "faster-whisper"}

DEFAULTS: Dict[str, str] = {
    "video": "/content/drive/MyDrive/raw",
    "output": "/content/drive/MyDrive/reaction_output",
    "editor": "https://reaction-studio.onrender.com",
}

VID_EXT = (".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi")

# last launch, so the tools cell (and any other cell) can reach it
_WEB: Optional[Dict[str, Any]] = None
_EDITOR: str = ""


# --------------------------------------------------------------------------
# setup
# --------------------------------------------------------------------------

def install_deps(extra: Tuple[str, ...] = ()) -> List[str]:
    """pip-install whatever is missing (idempotent — a no-op on re-runs)."""
    import importlib.util
    names = [pkg for mod, pkg in DEPS.items()
             if importlib.util.find_spec(mod) is None]
    names += [e for e in extra if importlib.util.find_spec(e) is None]
    if not names:
        print("Dependencies already installed.")
        return []
    print(f"Installing {', '.join(names)} …")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *names],
                   check=True)
    return names


def refresh_code(branch: str = "master", update: bool = True,
                 repo: Optional[Path] = None) -> Path:
    """Make sure `colab_version` is on disk and current (clone once, then pull).

    The notebook's cell clones before it can import this module, so in the
    normal flow this only fast-forwards the checkout it was loaded from.
    """
    repo = Path(repo or REPO_DIR)
    if not (repo / ".git").exists():
        print(f"Cloning {REPO_URL} ({branch}) …")
        try:
            subprocess.run(["git", "clone", "-q", "--depth", "1", "-b", branch,
                            REPO_URL, str(repo)], check=True)
        except subprocess.CalledProcessError:
            print(f"\nBranch '{branch}' could not be cloned. Remote branches:")
            subprocess.run(["git", "ls-remote", "--heads", REPO_URL])
            raise
    elif update:
        try:
            subprocess.run(["git", "-C", str(repo), "fetch", "-q", "--depth",
                            "1", "origin", branch], check=True)
            subprocess.run(["git", "-C", str(repo), "reset", "-q", "--hard",
                            "FETCH_HEAD"], check=True)
        except subprocess.CalledProcessError:
            print(f"\n'{branch}' is not on the remote — available branches:")
            subprocess.run(["git", "-C", str(repo), "ls-remote", "--heads",
                            REPO_URL])
            raise
        print(f"Code refreshed to origin/{branch} — a running server keeps "
              "using what it loaded; Runtime > Restart to pick it up now.")
    else:
        print("Code not refreshed (checkbox off).")
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    return repo


def mount_drive() -> bool:
    """Mount Google Drive when it isn't mounted already (no-op elsewhere)."""
    if (DRIVE / "MyDrive").is_dir():
        return True
    try:
        from google.colab import drive          # only exists inside Colab
    except Exception:
        return False
    drive.mount(str(DRIVE))
    return (DRIVE / "MyDrive").is_dir()


def resolve_source(video: Optional[str]) -> Path:
    """A clip path, a folder (newest clip wins) or a bare name under Drive."""
    raw = str(video or "").strip() or DEFAULTS["video"]
    p = Path(raw).expanduser()
    if not p.is_absolute():
        for base in (DRIVE / "MyDrive", Path(DEFAULTS["video"]), DRIVE.parent):
            if (base / p).exists():
                p = base / p
                break
    if p.is_dir():
        clips = [f for f in p.iterdir() if f.is_file()
                 and f.suffix.lower() in VID_EXT]
        clips.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        if not clips:
            raise SystemExit(f"no video files in {p} "
                             f"({'/'.join(e[1:] for e in VID_EXT)}) — "
                             "put your capture there or type a full path")
        p = clips[0]
        print(f"Folder → newest clip: {p.name}")
        if len(clips) > 1:
            print("   others: " + ", ".join(f.name for f in clips[1:6]) +
                  "\n   (switch clips in the app header — no re-run needed)")
    if not p.exists():
        raise SystemExit(f"not found: {p}\n   a bare file name is looked up in "
                         f"{DRIVE / 'MyDrive'} and {DEFAULTS['video']}; or type the "
                         "full path to the clip / to the folder holding them")
    return p


# --------------------------------------------------------------------------
# launch
# --------------------------------------------------------------------------

def start(video: Optional[str] = "", output: Optional[str] = "",
          editor: Optional[str] = "",
          branch: str = "master", update_code: bool = True) -> Dict[str, Any]:
    """Install → mount → open the capture → serve the editor. Returns web info."""
    global _WEB, _EDITOR
    install_deps()
    refresh_code(branch, update_code)
    mount_drive()
    src = resolve_source(video)
    out = Path(str(output or "").strip() or DEFAULTS["output"])
    # None = not passed → hosted default; "" = passed empty → notebook UI only
    _EDITOR = (DEFAULTS["editor"] if editor is None
               else str(editor).strip().rstrip("/"))

    from video_processor import ReactionVideoProcessor
    proc = ReactionVideoProcessor(str(src), output_dir=str(out))
    from webapp.server import launch_webapp
    _WEB = launch_webapp(proc)
    show_link()
    return _WEB


def app() -> Any:
    """The live server's App (its .proc is the source currently in use)."""
    if not _WEB:
        raise SystemExit("nothing is running yet — run the first cell")
    return _WEB["app"]


def show_link(renew: bool = False) -> None:
    """Print the tunnel URL and the one-click hosted-editor link again."""
    global _WEB
    if renew:
        from webapp.server import launch_webapp
        _WEB = launch_webapp(app().proc)
    url = (_WEB or {}).get("public")
    print()
    if not url:
        print("No public URL — run the first cell again (it renews the tunnel).")
        return
    print(f"editor (this notebook's own UI):  {url}")
    if _EDITOR:
        q = urllib.parse.quote(url, safe="")
        print(f"or the hosted editor, already connected:  {_EDITOR}/?backend={q}")
    print("the link dies with the session; anyone who has it can view your video")


def status() -> None:
    """What the server is looking at right now (proxy + render progress)."""
    a = app()
    st = a.state()
    info, proxy, job = st["info"], st["proxy"], st.get("job") or {}
    print(f"source  {info.get('path')}  {info.get('width')}x{info.get('height')} "
          f"@ {info.get('fps') or 0:.0f}fps  {info.get('duration') or 0:.0f}s "
          f"({'3840 split' if a.proc.is_side_by_side else 'single'})")
    print(f"timeline {len(st['segments'])} sections -> "
          f"{st.get('render_duration') or 0:.0f}s out   "
          f"mic bus: {st.get('mic_channel')}")
    if proxy.get("ready"):
        print("proxy   ready (smooth preview)")
    else:
        print(f"proxy   {proxy.get('progress', 0):.0%} — stills work meanwhile")
    if job.get("state") == "running":
        where = f" part {job.get('part')}/{job.get('parts')}" \
            if (job.get("parts") or 1) > 1 else ""
        eta = job.get("eta_s") or 0
        print(f"render  {job.get('progress', 0):.0%}{where} "
              f"{job.get('step') or ''}"
              + (f" — about {eta / 60:.0f} min left" if eta > 30 else "")
              + " — keep the tab open")
    elif job.get("state") in ("lost", "paused"):
        print(f"render  STOPPED: {job.get('error')}")
        r = job.get("resume") or {}
        print(f"        {r.get('saved')}/{r.get('parts')} parts are on disk — "
              f"tools('resume the unfinished render') finishes it")
    elif job.get("error"):
        print(f"render  FAILED: {job['error']}")
    elif job.get("files"):
        print(f"render  done: {', '.join(sorted(job['files']))} in {a.proc.out}")
    for r in unfinished():
        if job.get("state") not in ("lost", "paused"):
            print(f"parts   unfinished '{r['name']}': {r['saved']}/{r['parts']} "
                  f"on disk — tools('resume the unfinished render')")
    show_link()


def unfinished() -> List[Dict[str, Any]]:
    """Renders with parts on disk but no finished file (newest first)."""
    from webapp.server import unfinished_renders
    return unfinished_renders(app().proc.out)


def resume(key: str = "") -> Any:
    """Finish a stopped render from the parts already on disk.

    A reclaimed runtime kills the process but not the parts: each one is
    journalled as it lands, so resuming re-renders only what is missing.
    """
    pending = unfinished()
    if not pending:
        print("Nothing to resume — no render has parts waiting on disk.")
        return None
    if key:
        pick = next((r for r in pending if r["key"] == key), None)
        if pick is None:
            raise SystemExit(f"no unfinished render called {key!r} — "
                             f"have: {', '.join(r['key'] for r in pending)}")
    else:
        pick = pending[0]
        if len(pending) > 1:
            print("Resuming the most recent one; others still waiting: "
                  + ", ".join(r["key"] for r in pending[1:]))
    mins = int(pick["silent_s"] // 60)
    print(f"Resuming '{pick['name']}': {pick['saved']}/{pick['parts']} parts are "
          f"already on disk (stopped {mins} min ago) — only the rest is rendered.")
    job = app().resume_render(pick["key"])
    print(f"job state: {job.get('state')} — tools('link + status') shows progress, "
          "and the editor's Export tab has a Resume button too.")
    return job


def stop() -> None:
    """Kill the server + tunnel and free the port."""
    global _WEB
    from webapp.server import stop_webapp
    port = 8000
    if _WEB and _WEB.get("local"):
        try:
            port = int(urllib.parse.urlsplit(_WEB["local"]).port or 8000)
        except ValueError:
            pass
    stop_webapp(port)
    _WEB = None


def in_cell_editor() -> Any:
    """Fallback UI inside the notebook, for when no tunnel will verify."""
    install_deps(extra=("ipywidgets",))       # the widget editor needs them
    from editor_gui import launch_editor
    return launch_editor(app().proc)


TOOLS = {
    "link + status": status,
    "renew the tunnel link": lambda: show_link(renew=True),
    "resume the unfinished render": resume,
    "stop the server": stop,
    "in-cell editor (no tunnel)": in_cell_editor,
}


def tools(which: str = "link + status") -> Any:
    """One dropdown for everything you might want after the first cell."""
    fn = TOOLS.get(str(which))
    if fn is None:
        raise SystemExit(f"unknown tool: {which}")
    return fn()
