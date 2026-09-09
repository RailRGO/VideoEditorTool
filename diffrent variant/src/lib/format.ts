export function pad(n: number, w = 2) {
  return Math.floor(Math.abs(n)).toString().padStart(w, "0");
}

export function formatTimecode(seconds: number, withFrames = false, fps = 30) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * fps);
  const core = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return withFrames ? `${core}:${pad(f)}` : `${core}.${pad(Math.floor((seconds % 1) * 100))}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

export function linearToDb(lin: number) {
  return 20 * Math.log10(Math.max(lin, 1e-8));
}

export function uid(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
