// DateGrowthDetector: recent growth from file dates.
//
// A file is "in the window of N days" when it was created OR modified at or after (now - N days).
//   new      created within the window (this includes files copied or extracted here recently, which keep an old
//            modified date but get a new creation date)
//   changed  created before the window, or with no creation date, but modified within it. The file is counted at
//            its full current size, but how much it grew is unknown; the UI and MCP say so.
//
// To answer any N up to maxDays without rescanning, each folder keeps a sparse table of
// (created-age-in-days, modified-age-in-days) -> bytes, files. Age = ceil((now - t) / 1 day), so a file modified
// exactly N days ago has age N and is inside the window; one modified N days and 1 ms ago is outside.

import type { FileEntry, GrowthCounts, GrowthDetector, GrowthWindow, RecentFile } from "../core/types.ts";

export const DAY_MS = 86_400_000;

export interface DateGrowthOptions {
  /** "Now" for the whole scan, epoch ms. */
  now: number;
  /** Largest window that can be asked for. Default 365. */
  maxDays?: number;
  /** Files at or above this size are kept for file-level drill-down. Default 1 MB. */
  fileFloorBytes?: number;
  /** Cap on kept files; when exceeded, the smallest are dropped. Default 200,000. */
  maxFiles?: number;
}

/** Age in whole days, rounded up; 0 for times at or after now. */
export function ageDays(now: number, t: number): number {
  return Math.max(0, Math.ceil((now - t) / DAY_MS));
}

interface Kept {
  dirId: number;
  name: string;
  size: number;
  created: number | null;
  modified: number;
  cAge: number;
  mAge: number;
}

export class DateGrowthDetector implements GrowthDetector {
  readonly maxDays: number;
  readonly fileFloorBytes: number;
  readonly now: number;
  private readonly maxFiles: number;
  private readonly old: number;
  /** folder id -> (cAge * stride + mAge) -> [bytes, files] */
  private readonly table = new Map<number, Map<number, [number, number]>>();
  private kept: Kept[] = [];
  private readonly stride: number;

  constructor(opts: DateGrowthOptions) {
    this.now = opts.now;
    this.maxDays = opts.maxDays ?? 365;
    this.fileFloorBytes = opts.fileFloorBytes ?? 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 200_000;
    this.old = this.maxDays + 1;
    this.stride = this.maxDays + 2;
  }

  observe(f: FileEntry): void {
    const cAge = f.created === null ? this.old : Math.min(this.old, ageDays(this.now, f.created));
    const mAge = Math.min(this.old, ageDays(this.now, f.modified));
    if (cAge > this.maxDays && mAge > this.maxDays) return;
    let t = this.table.get(f.dirId);
    if (!t) this.table.set(f.dirId, (t = new Map()));
    const k = cAge * this.stride + mAge;
    const cell = t.get(k);
    if (cell) {
      cell[0] += f.size;
      cell[1] += 1;
    } else t.set(k, [f.size, 1]);
    if (f.size >= this.fileFloorBytes) {
      this.kept.push({ dirId: f.dirId, name: f.name, size: f.size, created: f.created, modified: f.modified, cAge, mAge });
      if (this.kept.length > this.maxFiles * 1.2) this.trim();
    }
  }

  private trim(): void {
    this.kept.sort((a, b) => b.size - a.size);
    this.kept.length = this.maxFiles;
  }

  newByAge(daysIn: number, include?: (dirId: number) => boolean): Array<{ bytes: number; files: number }> {
    const days = Math.max(1, Math.min(this.maxDays, Math.floor(daysIn)));
    const out = Array.from({ length: days + 1 }, () => ({ bytes: 0, files: 0 }));
    for (const [dirId, t] of this.table) {
      if (include && !include(dirId)) continue;
      for (const [k, [bytes, files]] of t) {
        const cAge = Math.floor(k / this.stride);
        if (cAge > days) continue;
        const slot = out[Math.max(1, cAge)];
        slot.bytes += bytes;
        slot.files += files;
      }
    }
    return out;
  }

  ownNewAtAge(age: number): Map<number, GrowthCounts> {
    const out = new Map<number, GrowthCounts>();
    for (const [dirId, t] of this.table) {
      let c: GrowthCounts | undefined;
      for (const [k, [bytes, files]] of t) {
        const cAge = Math.max(1, Math.floor(k / this.stride));
        if (cAge !== age) continue;
        if (!c) out.set(dirId, (c = { newBytes: 0, newFiles: 0, changedBytes: 0, changedFiles: 0 }));
        c.newBytes += bytes;
        c.newFiles += files;
      }
    }
    return out;
  }

  window(daysIn: number): GrowthWindow {
    const days = Math.max(1, Math.min(this.maxDays, Math.floor(daysIn)));
    if (this.kept.length > this.maxFiles) this.trim();
    const own = new Map<number, GrowthCounts>();
    for (const [dirId, t] of this.table) {
      let c: GrowthCounts | undefined;
      for (const [k, [bytes, files]] of t) {
        const cAge = Math.floor(k / this.stride);
        const mAge = k % this.stride;
        const isNew = cAge <= days;
        const isChanged = !isNew && mAge <= days;
        if (!isNew && !isChanged) continue;
        if (!c) c = { newBytes: 0, newFiles: 0, changedBytes: 0, changedFiles: 0 };
        if (isNew) {
          c.newBytes += bytes;
          c.newFiles += files;
        } else {
          c.changedBytes += bytes;
          c.changedFiles += files;
        }
      }
      if (c) own.set(dirId, c);
    }
    const files: RecentFile[] = [];
    for (const f of this.kept) {
      const isNew = f.cAge <= days;
      if (!isNew && f.mAge > days) continue;
      files.push({ dirId: f.dirId, name: f.name, size: f.size, created: f.created, modified: f.modified, kind: isNew ? "new" : "changed" });
    }
    return { days, start: this.now - days * DAY_MS, own, files };
  }
}
