/**
 * Thin client for the Colab backend (colab_version/webapp/server.py).
 *
 * In remote mode the browser never touches the full-resolution file: it
 * previews a light proxy stream, edits the same timeline/layout state, and
 * sends the whole project as JSON for the server to render. The finished
 * file downloads straight from the backend.
 */
import type {
  AudioCloak,
  AudioState,
  LayoutState,
  Retouch,
  Segment,
  Target,
  VideoCloak,
} from "./types";

export interface RemoteInfo {
  path: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
}

export interface RemoteProxy {
  ready: boolean;
  progress: number;
  path?: string | null;
  error?: string;
}

export interface TranscriptResult {
  words: { start: number; end: number; text: string }[];
  lang: string;
}

export interface RemoteLoudness {
  /** EBU R128 integrated loudness, LUFS */
  integrated?: number;
  /** true peak, dBTP */
  truePeak?: number;
}

/** A chunked render that stopped with parts on disk and can be finished. */
export interface RemoteResume {
  key: string;
  target: string;
  name: string;
  /** parts already on disk */
  saved: number;
  parts: number;
  /** how long the render has been silent, seconds */
  silent_s?: number;
  body?: Record<string, unknown>;
}

export interface RemoteJob {
  kind: "render" | "transcript";
  /**
   * lost = a render this server never owned (the runtime was reclaimed);
   * paused = a time budget stopped it between parts. Both are resumable.
   */
  state: "idle" | "running" | "done" | "error" | "cancelled" | "lost" | "paused";
  progress: number;
  files: Record<string, string>;
  /** upload kit from a finished render: chapters in `files`, thumbs here */
  thumbs: string[];
  loudness: RemoteLoudness;
  result: TranscriptResult | null;
  error: string | null;
  log: string[];
  /** where the render actually is: compositing / encoding / audio / joining */
  step?: string;
  part?: number;
  parts?: number;
  eta_s?: number;
  elapsed_s?: number;
  /** seconds since the encoder last said anything — a stall shows up here */
  age_s?: number;
  bytes?: number;
  updated?: number;
  /** present when a stopped render can be picked back up */
  resume?: RemoteResume | null;
}

export interface BusProxy {
  ready: boolean;
  progress: number;
  path?: string | null;
  error?: string | null;
}

export interface RemoteState {
  info: RemoteInfo;
  proxy: RemoteProxy;
  /** which channel of a 1-stereo-track OBS file holds the mic */
  mic_channel?: "left" | "right" | string;
  /** channel-split previews (missing when the source has one audio track) */
  bus_proxies?: Record<string, BusProxy>;
  job: RemoteJob;
}

export interface RemoteSource {
  name: string;
  size: number;
  mtime: number;
  current: boolean;
  /** "input" = the raw folder, "output" = finished renders (Patreon masters) */
  folder?: "input" | "output";
}

export interface ProjectBody {
  target: Target;
  name: string;
  segments: Pick<Segment, "type" | "start" | "end" | "card">[];
  layout: LayoutState;
  audio: AudioState;
  retouch: Retouch;
  audioCloak: AudioCloak;
  videoCloak: VideoCloak;
  crf: number;
  webm: boolean;
  fps: number | null;
  height: number;
  /** seconds of programme per part; 0 = automatic (short renders stay 1 pass) */
  partTarget?: number;
  /** stop the encoder when it goes quiet for this many minutes (0 = never) */
  stallMin?: number;
  /** stop politely at the next part after this many minutes (0 = no budget) */
  budgetMin?: number;
  /** Patreon master: also publish content-only and mic-only audio tracks */
  stems?: boolean;
  /** join-fade length in ms at cut/card/mute edges (0 = off, default 80) */
  audioFadeMs?: number;
}

const UNREACHABLE =
  "Backend unreachable — check the tunnel URL and that the notebook cell is still running.";

export class RemoteClient {
  readonly base: string;

  constructor(base: string) {
    this.base = RemoteClient.normalize(base);
  }

  static normalize(raw: string): string {
    let u = raw.trim().replace(/\/+$/, "");
    if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
    return u;
  }

  private url(p: string): string {
    return `${this.base}${p}`;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        ...init,
        headers: {
          "ngrok-skip-browser-warning": "true",
          ...(init?.headers ?? {}),
        },
      });
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      try {
        const j = JSON.parse(text) as { error?: string };
        throw new Error(j.error || `Backend error ${res.status}`);
      } catch (e) {
        if (e instanceof Error && e.message !== `Backend error ${res.status}`) throw e;
        throw new Error(
          text.includes("<!doctype") || text.includes("<html")
            ? "The tunnel answered with a web page, not the API — use the tunnel URL root (no /path) and confirm any tunnel warning page first."
            : `Backend error ${res.status}`
        );
      }
    }
    return (await res.json()) as T;
  }

  state = (): Promise<RemoteState> => this.req("/api/state");

  sources = (): Promise<{ sources: RemoteSource[]; current: string }> =>
    this.req("/api/sources");

  setSource = (name: string, folder: "input" | "output" = "input"): Promise<RemoteState> =>
    this.req("/api/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder }),
    });

  /** which channel of the stereo track carries the mic (rebuilds the
      mic/content preview streams in the background) */
  setMicChannel = (channel: string): Promise<{ ok: boolean }> =>
    this.req("/api/mic_channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });

  renderProject = (body: ProjectBody): Promise<RemoteJob> =>
    this.req("/api/job/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  transcribe = (
    spans: { start: number; end: number }[],
    lang: string
  ): Promise<RemoteJob> =>
    this.req("/api/job/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spans, lang }),
    });

  job = (): Promise<RemoteJob> => this.req("/api/job");

  /** finish a stopped render from the parts already on disk */
  resume = (key: string): Promise<RemoteJob> =>
    this.req("/api/job/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });

  cancelJob = (): Promise<RemoteJob> =>
    this.req("/api/job/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

  /** bus: "mix" (default), "mic" or "content" */
  proxyUrl = (bus: "mix" | "mic" | "content" = "mix"): string =>
    this.url("/api/proxy.mp4" + (bus === "mix" ? "" : `?bus=${bus}`));

  fileUrl = (name: string): string => this.url(`/files/${encodeURIComponent(name)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
