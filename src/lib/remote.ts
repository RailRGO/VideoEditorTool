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

export interface RemoteJob {
  kind: "render" | "transcript";
  state: "idle" | "running" | "done" | "error";
  progress: number;
  files: Record<string, string>;
  result: TranscriptResult | null;
  error: string | null;
  log: string[];
}

export interface RemoteState {
  info: RemoteInfo;
  proxy: RemoteProxy;
  job: RemoteJob;
}

export interface RemoteSource {
  name: string;
  size: number;
  mtime: number;
  current: boolean;
}

export interface ProjectBody {
  target: Target;
  name: string;
  segments: Pick<Segment, "type" | "start" | "end">[];
  layout: LayoutState;
  audio: AudioState;
  retouch: Retouch;
  audioCloak: AudioCloak;
  videoCloak: VideoCloak;
  crf: number;
  webm: boolean;
  fps: number | null;
  height: number;
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

  setSource = (name: string): Promise<RemoteState> =>
    this.req("/api/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
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

  proxyUrl = (): string => this.url("/api/proxy.mp4");

  fileUrl = (name: string): string => this.url(`/files/${encodeURIComponent(name)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
