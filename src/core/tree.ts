// ScanTree: the Core API's in-memory result of one scan. Implements ScanSink, so a Scanner fills it without
// knowing its layout. Internal to src/core; other modules only see the Core API's views.

import type { FileEntry, GrowthCounts, GrowthDetector, GrowthWindow, ScanSink, ScanStats, SkippedItem } from "./types.ts";
import { key, normalize } from "../util/winpath.ts";

export interface LargeFile {
  dirId: number;
  name: string;
  size: number;
  allocated: number | null;
  created: number | null;
  modified: number;
}

export interface RolledGrowth {
  window: GrowthWindow;
  newBytes: Float64Array;
  newFiles: Float64Array;
  changedBytes: Float64Array;
  changedFiles: Float64Array;
}

export class ScanTree implements ScanSink {
  readonly parent: number[] = [];
  readonly name: string[] = [];
  readonly ownBytes: number[] = [];
  readonly ownAlloc: number[] = [];
  readonly ownFiles: number[] = [];
  readonly ownLinks: number[] = [];
  readonly skippedItems: SkippedItem[] = [];
  readonly largeFiles: LargeFile[] = [];
  stats!: ScanStats;
  finishedAt = 0;

  // filled by finish()
  totalBytes: Float64Array = new Float64Array(0);
  totalAlloc: Float64Array = new Float64Array(0);
  totalFiles: Float64Array = new Float64Array(0);
  totalFolders: Float64Array = new Float64Array(0);
  children: number[][] = [];
  private paths: string[] = [];
  private index: Map<string, number> | null = null;
  private rolled = new Map<number, RolledGrowth>();

  constructor(
    readonly root: string,
    readonly growth: GrowthDetector,
    private readonly largeFileBytes: number,
  ) {}

  folder(parentId: number, name: string): number {
    const id = this.parent.length;
    this.parent.push(parentId);
    this.name.push(parentId === -1 ? normalize(name) : name);
    this.ownBytes.push(0);
    this.ownAlloc.push(0);
    this.ownFiles.push(0);
    this.ownLinks.push(0);
    return id;
  }

  file(f: FileEntry): void {
    this.ownBytes[f.dirId] += f.size;
    this.ownAlloc[f.dirId] += f.allocated ?? f.size;
    this.ownFiles[f.dirId] += 1;
    this.growth.observe(f);
    if (f.size >= this.largeFileBytes) this.largeFiles.push({ dirId: f.dirId, name: f.name, size: f.size, allocated: f.allocated, created: f.created, modified: f.modified });
  }

  link(parentId: number): void {
    this.ownLinks[parentId] += 1;
  }

  skipped(item: SkippedItem): void {
    this.skippedItems.push(item);
  }

  get count(): number {
    return this.parent.length;
  }

  finish(stats: ScanStats): void {
    this.stats = stats;
    this.finishedAt = stats.finishedAt;
    const n = this.count;
    this.totalBytes = Float64Array.from(this.ownBytes);
    this.totalAlloc = Float64Array.from(this.ownAlloc);
    this.totalFiles = Float64Array.from(this.ownFiles);
    this.totalFolders = new Float64Array(n);
    this.children = Array.from({ length: n }, () => []);
    for (let id = n - 1; id >= 1; id--) {
      const p = this.parent[id];
      if (p < 0) continue;
      this.totalBytes[p] += this.totalBytes[id];
      this.totalAlloc[p] += this.totalAlloc[id];
      this.totalFiles[p] += this.totalFiles[id];
      this.totalFolders[p] += this.totalFolders[id] + 1;
      this.children[p].push(id);
    }
    for (const c of this.children) c.reverse();
    this.paths = new Array(n);
    for (let id = 0; id < n; id++) {
      const p = this.parent[id];
      if (p < 0) this.paths[id] = this.name[id];
      else {
        const pp = this.paths[p];
        this.paths[id] = pp.endsWith("\\") ? pp + this.name[id] : `${pp}\\${this.name[id]}`;
      }
    }
    this.largeFiles.sort((a, b) => b.size - a.size);
  }

  path(id: number): string {
    return this.paths[id];
  }

  find(p: string): number | null {
    if (!this.index) {
      this.index = new Map();
      for (let id = 0; id < this.count; id++) this.index.set(this.paths[id].toLowerCase(), id);
    }
    return this.index.get(key(p)) ?? null;
  }

  isWithin(id: number, ancestor: number): boolean {
    let x = id;
    while (x >= 0) {
      if (x === ancestor) return true;
      x = this.parent[x];
    }
    return false;
  }

  /** Recent growth rolled up to every folder, for one window. Cached per window. */
  growthFor(days: number): RolledGrowth {
    const d = Math.max(1, Math.min(this.growth.maxDays, Math.floor(days)));
    const hit = this.rolled.get(d);
    if (hit) return hit;
    const window = this.growth.window(d);
    const n = this.count;
    const nb = new Float64Array(n);
    const nf = new Float64Array(n);
    const cb = new Float64Array(n);
    const cf = new Float64Array(n);
    for (const [id, c] of window.own) {
      nb[id] = c.newBytes;
      nf[id] = c.newFiles;
      cb[id] = c.changedBytes;
      cf[id] = c.changedFiles;
    }
    for (let id = n - 1; id >= 1; id--) {
      const p = this.parent[id];
      if (p < 0) continue;
      nb[p] += nb[id];
      nf[p] += nf[id];
      cb[p] += cb[id];
      cf[p] += cf[id];
    }
    const r: RolledGrowth = { window, newBytes: nb, newFiles: nf, changedBytes: cb, changedFiles: cf };
    if (this.rolled.size >= 4) this.rolled.delete(this.rolled.keys().next().value!);
    this.rolled.set(d, r);
    return r;
  }

  ownGrowth(id: number, g: RolledGrowth): GrowthCounts {
    return g.window.own.get(id) ?? { newBytes: 0, newFiles: 0, changedBytes: 0, changedFiles: 0 };
  }
}
