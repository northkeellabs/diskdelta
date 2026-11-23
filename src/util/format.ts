// Human-readable numbers. Sizes use 1024-based units with the labels Windows Explorer shows (KB, MB, GB, TB).

const UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "unknown";
  if (n < 1000) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  let v = n;
  let i = 0;
  // switch unit at 1000 so a value never shows four digits (1004 MB becomes 0.98 GB)
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function isoDate(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
