import type { Retouch } from "./types";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface RawLandmark {
  x: number;
  y: number;
  z?: number;
}

export type TrackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "tracking"
  | "lost"
  | "failed";

/**
 * Landmark tracker with a one-euro style temporal filter.
 *
 * Per-frame detection (rather than optical flow) is what actually keeps a mask
 * locked on: 478 landmarks are re-solved every frame, so a head turn, a lean
 * forward or a hand in front of the face is re-fitted instead of accumulating
 * drift. Optical flow alone drifts, and once it drifts it stays drifted. The
 * smoothing below only removes frame-to-frame jitter — it is adaptive, so a
 * quick head movement is followed at full speed while a still head is held
 * rock-steady.
 */
export class FaceTracker {
  status: TrackStatus = "idle";
  error = "";
  fps = 0;

  private landmarker: {
    detectForVideo: (
      v: HTMLVideoElement,
      t: number
    ) => { faceLandmarks: RawLandmark[][] };
    close?: () => void;
  } | null = null;
  private loading: Promise<boolean> | null = null;
  private smoothed: RawLandmark[] | null = null;
  private prev: RawLandmark[] | null = null;
  private prevTime = 0;
  private frame = 0;
  private lastDetect = 0;
  private fpsN = 0;
  private lastFpsAt = 0;

  /** Load the model. Resolves false when it can't be fetched. */
  load(): Promise<boolean> {
    if (this.landmarker) return Promise.resolve(true);
    if (this.loading) return this.loading;
    this.status = "loading";
    this.error = "";
    this.loading = (async () => {
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM);
        const lm = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
        this.landmarker = lm as unknown as FaceTracker["landmarker"];
        this.status = "ready";
        return true;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.status = "failed";
        return false;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Warm the model up so the first real frame doesn't stall. */
  async warm(video: HTMLVideoElement) {
    const ok = await this.load();
    if (!ok || !this.landmarker) return false;
    try {
      this.landmarker.detectForVideo(video, performance.now());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param camRect  the camera half of the source, in normalised source coords,
   *                 used to map full-frame landmarks into camera-space.
   */
  update(
    video: HTMLVideoElement,
    cfg: Retouch,
    camRect: { x: number; y: number; w: number; h: number }
  ): RawLandmark[] | null {
    if (!cfg.enabled) {
      this.status = this.landmarker ? "ready" : "idle";
      return null;
    }
    if (!this.landmarker) {
      void this.load();
      return this.smoothed;
    }

    this.frame++;
    const every = Math.max(1, Math.round(cfg.everyN));
    const now = performance.now();

    if (this.frame % every !== 0) return this.smoothed;
    if (now - this.lastDetect < 1000 / 120) return this.smoothed;
    this.lastDetect = now;

    let raw: RawLandmark[] | null = null;
    try {
      const res = this.landmarker.detectForVideo(video, now);
      raw = res.faceLandmarks?.[0] ?? null;
    } catch {
      raw = null;
    }

    if (now - this.lastFpsAt > 500) {
      this.fps = this.fpsN ? Math.round((this.fpsN * 1000) / (now - this.lastFpsAt)) : 0;
      this.lastFpsAt = now;
      this.fpsN = 0;
    }
    this.fpsN++;

    if (!raw || raw.length < 400) {
      this.status = "lost";
      // hold the last known pose for a moment rather than snapping away
      return this.smoothed;
    }
    this.status = "tracking";

    // map full-frame normalised coords into the camera half
    const cam = raw.map((p) => ({
      x: (p.x - camRect.x) / camRect.w,
      y: (p.y - camRect.y) / camRect.h,
      z: p.z,
    }));

    if (!this.smoothed || this.smoothed.length !== cam.length) {
      this.smoothed = cam;
      this.prev = cam;
      this.prevTime = now;
      return this.smoothed;
    }

    // adaptive smoothing: fast motion -> trust the new frame, slow -> average hard
    const dt = Math.max(1, now - this.prevTime) / 1000;
    this.prevTime = now;
    let motion = 0;
    for (let i = 0; i < cam.length; i += 7) {
      motion += Math.hypot(cam[i].x - (this.prev?.[i].x ?? cam[i].x), cam[i].y - (this.prev?.[i].y ?? cam[i].y));
    }
    const speed = motion / (cam.length / 7); // normalised units per second
    const base = 1 - Math.min(0.95, Math.max(0.05, cfg.smoothing / 100));
    // corner frequency rises with speed, so tracking stays tight when moving
    const alpha = Math.min(1, base + speed * 260 * dt + 0.12);

    for (let i = 0; i < cam.length; i++) {
      const s = this.smoothed[i];
      s.x += (cam[i].x - s.x) * alpha;
      s.y += (cam[i].y - s.y) * alpha;
    }
    this.prev = cam;
    return this.smoothed;
  }

  reset() {
    this.smoothed = null;
    this.prev = null;
    this.status = this.landmarker ? "ready" : "idle";
  }

  dispose() {
    try {
      this.landmarker?.close?.();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
    this.smoothed = null;
    this.status = "idle";
  }
}
