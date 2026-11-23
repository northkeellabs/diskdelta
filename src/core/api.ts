// DiskDeltaCore: the Core API. The MCP layer and the UI use only this class and the view types it returns.
// It wires the modules together through their interfaces: a DriveProvider lists drives, a Scanner fills a ScanTree,
// a GrowthDetector answers "what is recent", the RulesEngine labels paths, a SnapshotStore keeps a summary per scan.
// All methods that answer questions are read-only. The only writes are the snapshot (SnapshotStore) and
// exportReport(), which writes a new file at a path the user chose and never overwrites.

import fs from "node:fs";
import { DateGrowthDetector } from "../growth/detector.ts";
import { formatBytes, isoDate } from "../util/format.ts";
import { basename, isAbsolute, join, key, normalize, parent as parentPath, within } from "../util/winpath.ts";
import { ScanTree } from "./tree.ts";
import { renderReport, type ReportData } from "./report.ts";
import type {
  Classification,
  DriveInfo,
  DriveProvider,
  GrowthCounts,
  GrowthDetector,
  Label,
  RulesEngine,
  ScanProgress,
  ScanStats,
  Scanner,
  SkippedItem,
  Snapshot,
  SnapshotStore,
} from "./types.ts";

export interface CoreDeps {
  drives: DriveProvider;
  scanner: Scanner;
  rules: RulesEngine;
  snapshots: SnapshotStore;
  /** "live" scans the real disk, "demo" the fictional PC. Shown in the UI and MCP answers. */
  mode: "live" | "demo";
  clock?: () => number;
  growthFactory?: (now: number) => GrowthDetector;
  /** Files at or above this size are listed individually (largest files, snapshot). Default 50 MB. */
  largeFileBytes?: number;
  concurrency?: number;
}

// ---------- views returned to the MCP layer and the UI (plain JSON) ----------

export interface DriveView extends DriveInfo {
  used: number;
  usedPct: number;
  scannedAt: string | null;
}

export interface JobView {
  id: number;
  state: "running" | "done" | "cancelled" | "error";
  targets: string[];
  index: number;
  progress: ScanProgress | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScanSummary {
  root: string;
  scanner: string;
  sizeNote: string;
  finishedAt: string;
  durationMs: number;
  folders: number;
  files: number;
  bytes: number;
  allocatedBytes: number | null;
  links: number;
  skipped: number;
  hardLinkDuplicates: number;
  cancelled: boolean;
  snapshotId: string | null;
}

export interface LabelView {
  label: Label;
  known: boolean;
  ruleId: string | null;
  category: string | null;
  what: string;
  reclaim: string;
  command: string | null;
  notes: string;
  owner: string | null;
  capped: boolean;
}

export interface GrowthView {
  newBytes: number;
  newFiles: number;
  changedBytes: number;
  changedFiles: number;
}

export interface FolderRow extends LabelView, GrowthView {
  path: string;
  name: string;
  bytes: number;
  allocated: number;
  files: number;
  folders: number;
}

export interface FileRow {
  path: string;
  name: string;
  size: number;
  created: string | null;
  modified: string;
  kind?: "new" | "changed";
}

export interface FolderView {
  path: string;
  name: string;
  parent: string | null;
  scanRoot: string;
  days: number;
  windowStart: string;
  self: FolderRow;
  own: { bytes: number; files: number; links: number } & GrowthView;
  children: FolderRow[];
  recentFiles: FileRow[];
  largeFiles: FileRow[];
  fileFloorBytes: number;
  largeFileBytes: number;
}

export interface HotspotRow extends LabelView, GrowthView {
  path: string;
  /** all = everything recent inside this folder; own = only files directly in it; rest = smaller subfolders together; group = sibling temp folders */
  scope: "all" | "own" | "rest" | "group";
  groupCount?: number;
}

export interface CandidateRow extends LabelView, GrowthView {
  path: string;
  bytes: number;
  files: number;
  reason: string;
  groupCount?: number;
  /** "rest": everything in this folder that is not listed as its own row above. */
  scope?: "rest";
}

export interface TreemapNode {
  name: string;
  path: string;
  bytes: number;
  label: Label;
  known: boolean;
  /** Rule category (for example personal), or null when unknown. */
  category: string | null;
  /** Bytes of files created in the window. */
  newBytes: number;
  /** Bytes of older files modified in the window (growth unknown). Never added to newBytes. */
  changedBytes: number;
  children?: TreemapNode[];
  /** Files directly in the folder plus folders too small to draw. */
  other?: boolean;
}

/** One bar of the growth timeline: new files created in a 24-hour period counted back from the scan time. */
export interface TimelineBar {
  /** 1 = the last 24 hours. */
  age: number;
  start: string;
  end: string;
  newBytes: number;
  newFiles: number;
}

/** Rolled-up growth per folder id (from a window or from one timeline day). */
interface GrowthSource {
  newBytes: Float64Array;
  newFiles: Float64Array;
  changedBytes: Float64Array;
  changedFiles: Float64Array;
  own(id: number): GrowthCounts;
}

export type CoreEvent = { type: "progress"; job: JobView } | { type: "job"; job: JobView };

export class CoreError extends Error {}

const DAY = 86_400_000;

function labelView(c: Classification): LabelView {
  return { label: c.label, known: c.known, ruleId: c.ruleId, category: c.category, what: c.what, reclaim: c.reclaim, command: c.command, notes: c.notes, owner: c.owner, capped: c.capped };
}

const zeroGrowth = (): GrowthView => ({ newBytes: 0, newFiles: 0, changedBytes: 0, changedFiles: 0 });

export class DiskDeltaCore {
  readonly mode: "live" | "demo";
  private readonly clock: () => number;
  private readonly trees: ScanTree[] = [];
  private readonly snapshotIds = new Map<ScanTree, string | null>();
  private current: { view: JobView; abort: AbortController; done: Promise<void> } | null = null;
  private jobSeq = 0;
  private listeners = new Set<(e: CoreEvent) => void>();
  private readonly largeFileBytes: number;

  constructor(private readonly deps: CoreDeps) {
    this.mode = deps.mode;
    this.clock = deps.clock ?? Date.now;
    this.largeFileBytes = deps.largeFileBytes ?? 50 * 1024 * 1024;
  }

  get rulesCount(): number {
    return this.deps.rules.size;
  }

  // ---------- events ----------

  onEvent(fn: (e: CoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: CoreEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken listener must not stop the scan
      }
    }
  }

  // ---------- drives ----------

  async listDrives(): Promise<DriveView[]> {
    const drives = await this.deps.drives.list();
    return drives.map((d) => {
      const used = Math.max(0, d.size - d.free);
      const t = this.trees.filter((x) => key(x.root) === key(d.root)).at(-1);
      return { ...d, used, usedPct: d.size > 0 ? Math.round((1000 * used) / d.size) / 10 : 0, scannedAt: t ? new Date(t.finishedAt).toISOString() : null };
    });
  }

  // ---------- scanning ----------

  job(): JobView | null {
    return this.current ? { ...this.current.view } : null;
  }

  /** Starts scanning the given folders or drive roots one after another. Only one job runs at a time. */
  startScan(targetsIn: string[]): JobView {
    if (this.current?.view.state === "running") throw new CoreError("A scan is already running.");
    const targets = targetsIn.map((t) => {
      if (!isAbsolute(t)) throw new CoreError(`Not an absolute Windows path: ${t}`);
      return normalize(t);
    });
    if (targets.length === 0) throw new CoreError("Nothing to scan.");
    const abort = new AbortController();
    const view: JobView = { id: ++this.jobSeq, state: "running", targets, index: 0, progress: null, error: null, startedAt: new Date(this.clock()).toISOString(), finishedAt: null };
    const run = async () => {
      try {
        for (let i = 0; i < targets.length; i++) {
          view.index = i;
          await this.scanOne(targets[i], abort.signal, (p) => {
            view.progress = p;
            this.emit({ type: "progress", job: { ...view } });
          });
          if (abort.signal.aborted) break;
        }
        view.state = abort.signal.aborted ? "cancelled" : "done";
      } catch (e) {
        view.state = "error";
        view.error = e instanceof Error ? e.message : String(e);
      }
      view.finishedAt = new Date(this.clock()).toISOString();
      this.emit({ type: "job", job: { ...view } });
    };
    this.current = { view, abort, done: Promise.resolve() };
    this.current.done = run();
    this.emit({ type: "job", job: { ...view } });
    return { ...view };
  }

  cancelScan(): boolean {
    if (this.current?.view.state !== "running") return false;
    this.current.abort.abort();
    return true;
  }

  async waitForJob(): Promise<JobView | null> {
    if (!this.current) return null;
    await this.current.done;
    return { ...this.current.view };
  }

  private async scanOne(root: string, signal: AbortSignal, onProgress: (p: ScanProgress) => void): Promise<ScanTree> {
    const now = this.clock();
    const growth = this.deps.growthFactory ? this.deps.growthFactory(now) : new DateGrowthDetector({ now });
    const tree = new ScanTree(root, growth, this.largeFileBytes);
    let stats: ScanStats;
    try {
      stats = await this.deps.scanner.scan(root, tree, { signal, onProgress, concurrency: this.deps.concurrency });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") throw new CoreError(`Folder not found: ${root}`);
      if (code === "EACCES" || code === "EPERM") throw new CoreError(`Access denied: ${root}`);
      throw e;
    }
    tree.finish(stats);
    if (stats.cancelled) return tree;
    // Newer scans replace older ones of the same root or of folders inside it.
    for (let i = this.trees.length - 1; i >= 0; i--) if (within(this.trees[i].root, root)) this.trees.splice(i, 1);
    this.trees.push(tree);
    let snapId: string | null = null;
    try {
      snapId = (await this.deps.snapshots.save(this.snapshotOf(tree))).id;
    } catch {
      snapId = null;
    }
    this.snapshotIds.set(tree, snapId);
    return tree;
  }

  private snapshotOf(t: ScanTree): Snapshot {
    const folderMinBytes = 10 * 1024 * 1024;
    const fileMinBytes = 100 * 1024 * 1024;
    const folders: Array<[string, number, number]> = [];
    for (let id = 0; id < t.count; id++) if (t.totalBytes[id] >= folderMinBytes) folders.push([t.path(id), t.totalBytes[id], t.totalFiles[id]]);
    const files = t.largeFiles.filter((f) => f.size >= fileMinBytes).map((f): [string, number, number | null, number] => [join(t.path(f.dirId), f.name), f.size, f.created, f.modified]);
    return { format: "diskdelta-snapshot", version: 1, createdAt: new Date(t.finishedAt).toISOString(), root: t.root, scanner: t.stats.scanner, stats: t.stats, thresholds: { folderMinBytes, fileMinBytes }, folders, files };
  }

  scans(): ScanSummary[] {
    return this.trees.map((t) => this.summary(t));
  }

  private summary(t: ScanTree): ScanSummary {
    const s = t.stats;
    return {
      root: t.root,
      scanner: s.scanner,
      sizeNote: this.deps.scanner.sizeNote,
      finishedAt: new Date(s.finishedAt).toISOString(),
      durationMs: s.finishedAt - s.startedAt,
      folders: s.folders,
      files: s.files,
      bytes: s.bytes,
      allocatedBytes: s.allocatedBytes,
      links: s.links,
      skipped: s.skipped,
      hardLinkDuplicates: s.hardLinkDuplicates,
      cancelled: s.cancelled,
      snapshotId: this.snapshotIds.get(t) ?? null,
    };
  }

  /** Makes sure `path` is covered by a scan no older than maxAgeMs; scans it if not. Used by the MCP tools. */
  async ensureScanned(pathIn: string, maxAgeMs = 15 * 60_000): Promise<ScanSummary> {
    const path = this.checkPath(pathIn);
    const hit = this.treeFor(path);
    if (hit && this.clock() - hit.finishedAt <= maxAgeMs) return this.summary(hit);
    if (this.current?.view.state === "running") {
      await this.current.done;
      const again = this.treeFor(path);
      if (again && this.clock() - again.finishedAt <= maxAgeMs) return this.summary(again);
    }
    const job = this.startScan([path]);
    const done = await this.waitForJob();
    if (!done || done.state !== "done") throw new CoreError(done?.error ?? `Scan of ${path} did not finish (job ${job.id}).`);
    const t = this.treeFor(path);
    if (!t) throw new CoreError(`Scan of ${path} produced no result.`);
    return this.summary(t);
  }

  // ---------- lookups ----------

  private checkPath(p: string): string {
    if (typeof p !== "string" || !isAbsolute(p)) throw new CoreError("Give an absolute Windows path, for example C:\\Users.");
    return normalize(p);
  }

  private treeFor(path: string): ScanTree | null {
    let best: ScanTree | null = null;
    for (const t of this.trees) if (within(path, t.root) && (!best || t.finishedAt >= best.finishedAt)) best = t;
    return best;
  }

  private locate(pathIn: string): { t: ScanTree; id: number; path: string } {
    const path = this.checkPath(pathIn);
    const t = this.treeFor(path);
    if (!t) throw new CoreError(`Not scanned yet: ${path}. Scan it (or a folder above it) first.`);
    const id = t.find(path);
    if (id === null) throw new CoreError(`Not found in the scan of ${t.root}: ${path}. It may be a file, a link, a skipped folder, or newer than the scan.`);
    return { t, id, path: t.path(id) };
  }

  private classify(t: ScanTree, id: number): Classification {
    const p = t.parent[id];
    const siblingNames = p >= 0 ? t.children[p].map((c) => t.name[c]) : undefined;
    return this.deps.rules.classify(t.path(id), { siblingNames });
  }

  private growthView(t: ScanTree, id: number, days: number): GrowthView {
    const g = t.growthFor(days);
    return { newBytes: g.newBytes[id], newFiles: g.newFiles[id], changedBytes: g.changedBytes[id], changedFiles: g.changedFiles[id] };
  }

  private row(t: ScanTree, id: number, days: number, c?: Classification): FolderRow {
    const cls = c ?? this.classify(t, id);
    return {
      path: t.path(id),
      name: t.parent[id] < 0 ? t.path(id) : t.name[id],
      bytes: t.totalBytes[id],
      allocated: t.totalAlloc[id],
      files: t.totalFiles[id],
      folders: t.totalFolders[id],
      ...this.growthView(t, id, days),
      ...labelView(cls),
    };
  }

  private fileRow(t: ScanTree, f: { dirId: number; name: string; size: number; created: number | null; modified: number; kind?: "new" | "changed" }): FileRow {
    return { path: join(t.path(f.dirId), f.name), name: f.name, size: f.size, created: f.created === null ? null : new Date(f.created).toISOString(), modified: new Date(f.modified).toISOString(), ...(f.kind ? { kind: f.kind } : {}) };
  }

  private days(d: number | undefined): number {
    const n = Math.floor(Number(d ?? 30));
    if (!Number.isFinite(n) || n < 1 || n > 365) throw new CoreError("days must be a whole number from 1 to 365.");
    return n;
  }

  /** One folder with its subfolders (for drill-down), recent files and large files. */
  folder(pathIn: string, opts: { days?: number; limit?: number } = {}): FolderView {
    const days = this.days(opts.days);
    const { t, id, path } = this.locate(pathIn);
    const g = t.growthFor(days);
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const children = t.children[id].map((c) => this.row(t, c, days)).sort((a, b) => b.bytes - a.bytes).slice(0, limit);
    const own = t.ownGrowth(id, g);
    const recentFiles = g.window.files.filter((f) => f.dirId === id).sort((a, b) => b.size - a.size).slice(0, 200).map((f) => this.fileRow(t, f));
    const largeFiles = t.largeFiles.filter((f) => f.dirId === id).slice(0, 200).map((f) => this.fileRow(t, f));
    return {
      path,
      name: t.parent[id] < 0 ? path : t.name[id],
      parent: t.parent[id] < 0 ? parentPath(path) : t.path(t.parent[id]),
      scanRoot: t.root,
      days,
      windowStart: new Date(g.window.start).toISOString(),
      self: this.row(t, id, days),
      own: { bytes: t.ownBytes[id], files: t.ownFiles[id], links: t.ownLinks[id], ...own },
      children,
      recentFiles,
      largeFiles,
      fileFloorBytes: t.growth.fileFloorBytes,
      largeFileBytes: this.largeFileBytes,
    };
  }

  /**
   * Where recent growth is, as non-overlapping rows. Walks down from `path`: a folder that a rule describes as one
   * unit (a cache, a model store) is reported whole; otherwise growth is split into files directly in the folder,
   * the subfolders that hold a meaningful share, groups of sibling temp folders, and the rest.
   */
  whatGrew(pathIn: string, opts: { days?: number; limit?: number } = {}): { path: string; days: number; windowStart: string; total: GrowthView; rows: HotspotRow[] } {
    const days = this.days(opts.days);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const { t, id: start, path } = this.locate(pathIn);
    const g = t.growthFor(days);
    const src: GrowthSource = { ...g, own: (id) => t.ownGrowth(id, g) };
    const { total, rows } = this.hotspots(t, start, src);
    return { path, days, windowStart: new Date(g.window.start).toISOString(), total, rows: rows.slice(0, limit) };
  }

  /** The hotspot walk behind whatGrew and timelineDay, over any rolled-up growth source. */
  private hotspots(t: ScanTree, start: number, src: GrowthSource): { total: GrowthView; rows: HotspotRow[] } {
    const gvOf = (id: number): GrowthView => ({ newBytes: src.newBytes[id], newFiles: src.newFiles[id], changedBytes: src.changedBytes[id], changedFiles: src.changedFiles[id] });
    const sum = (ids: number[]): GrowthView => {
      const out = zeroGrowth();
      for (const id of ids) {
        out.newBytes += src.newBytes[id];
        out.newFiles += src.newFiles[id];
        out.changedBytes += src.changedBytes[id];
        out.changedFiles += src.changedFiles[id];
      }
      return out;
    };
    const total = gvOf(start);
    // New and changed bytes are separate signals and are never added together: a place matters when its new bytes
    // or its changed bytes reach 0.5% of the respective total (at least 1 MB).
    const minNew = Math.max(1024 * 1024, total.newBytes * 0.005);
    const minChanged = Math.max(1024 * 1024, total.changedBytes * 0.005);
    const big = (gv: { newBytes: number; changedBytes: number }) => gv.newBytes >= minNew || gv.changedBytes >= minChanged;
    const bigId = (id: number) => src.newBytes[id] >= minNew || src.changedBytes[id] >= minChanged;
    const any = (id: number) => src.newBytes[id] > 0 || src.changedBytes[id] > 0;
    const rows: HotspotRow[] = [];
    const add = (p: string, scope: HotspotRow["scope"], gv: GrowthView, cls: Classification, groupCount?: number) => rows.push({ path: p, scope, ...gv, ...labelView(cls), ...(groupCount ? { groupCount } : {}) });

    const visit = (id: number, depth: number) => {
      if (!bigId(id)) return;
      const cls = this.classify(t, id);
      if (id !== start && cls.known && !cls.descend) return add(t.path(id), "all", gvOf(id), cls);
      const kids = t.children[id].filter(any);
      const own = src.own(id);
      // Sibling temp folders (many folders sharing a name prefix) are reported as one group row.
      const groups = new Map<string, { ids: number[]; cls: Classification; gv: GrowthView }>();
      for (const c of kids) {
        const cc = this.classify(t, c);
        if (!cc.group) continue;
        const k = cc.group.prefix.toLowerCase();
        const e = groups.get(k) ?? { ids: [], cls: cc, gv: zeroGrowth() };
        e.ids.push(c);
        groups.set(k, e);
      }
      const grouped = new Set<number>();
      const bigGroups: Array<{ ids: number[]; cls: Classification; gv: GrowthView }> = [];
      for (const e of groups.values()) {
        e.gv = sum(e.ids);
        if (!big(e.gv)) continue;
        bigGroups.push(e);
        e.ids.forEach((x) => grouped.add(x));
      }
      const bigKids = kids.filter((c) => !grouped.has(c) && bigId(c));
      if ((bigKids.length === 0 && bigGroups.length === 0) || depth > 40) return add(t.path(id), "all", gvOf(id), cls);
      const ownBig = big(own);
      if (ownBig) add(t.path(id), "own", { ...own }, cls);
      for (const e of bigGroups) add(`${t.path(id)}\\${e.cls.group!.prefix}*`, "group", e.gv, e.cls, e.ids.length);
      for (const c of bigKids) visit(c, depth + 1);
      const rv = sum(kids.filter((c) => !grouped.has(c) && !bigId(c)));
      if (!ownBig) {
        rv.newBytes += own.newBytes;
        rv.newFiles += own.newFiles;
        rv.changedBytes += own.changedBytes;
        rv.changedFiles += own.changedFiles;
      }
      if (big(rv)) add(t.path(id), "rest", rv, cls);
    };
    visit(start, 0);
    // Ranked by new bytes; rows with only changed files (growth unknown) follow, by their changed bytes.
    rows.sort((a, b) => b.newBytes - a.newBytes || b.changedBytes - a.changedBytes);
    return { total, rows };
  }

  /**
   * New files per day for the window, for a bar chart. Each bar is a 24-hour period counted back from the scan time.
   * Older files that changed are not included (how much they grew is unknown).
   */
  timeline(pathIn: string, opts: { days?: number } = {}): { path: string; days: number; scannedAt: string; total: { newBytes: number; newFiles: number }; bars: TimelineBar[] } {
    const days = this.days(opts.days);
    const { t, id, path } = this.locate(pathIn);
    const now = t.growth.now;
    const byAge = t.growth.newByAge(days, id === 0 ? undefined : (dirId) => t.isWithin(dirId, id));
    const bars: TimelineBar[] = [];
    for (let age = days; age >= 1; age--) bars.push({ age, start: new Date(now - age * DAY).toISOString(), end: new Date(now - (age - 1) * DAY).toISOString(), newBytes: byAge[age].bytes, newFiles: byAge[age].files });
    return { path, days, scannedAt: new Date(now).toISOString(), total: { newBytes: bars.reduce((s, b) => s + b.newBytes, 0), newFiles: bars.reduce((s, b) => s + b.newFiles, 0) }, bars };
  }

  /** Which folders the new files of one timeline bar went to (same rows as whatGrew, for that day only). */
  timelineDay(pathIn: string, opts: { age: number; limit?: number }): { path: string; age: number; start: string; end: string; total: GrowthView; rows: HotspotRow[] } {
    const age = Math.floor(Number(opts.age));
    const { t, id: start, path } = this.locate(pathIn);
    if (!Number.isFinite(age) || age < 1 || age > t.growth.maxDays) throw new CoreError("age must be a whole number of days from 1.");
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    const own = t.growth.ownNewAtAge(age);
    const n = t.count;
    const nb = new Float64Array(n);
    const nf = new Float64Array(n);
    for (const [dirId, c] of own) {
      nb[dirId] = c.newBytes;
      nf[dirId] = c.newFiles;
    }
    for (let x = n - 1; x >= 1; x--) {
      const p = t.parent[x];
      if (p < 0) continue;
      nb[p] += nb[x];
      nf[p] += nf[x];
    }
    const zero = new Float64Array(n);
    const none = { newBytes: 0, newFiles: 0, changedBytes: 0, changedFiles: 0 };
    const src: GrowthSource = { newBytes: nb, newFiles: nf, changedBytes: zero, changedFiles: zero, own: (x) => own.get(x) ?? none };
    const { total, rows } = this.hotspots(t, start, src);
    const now = t.growth.now;
    return { path, age, start: new Date(now - age * DAY).toISOString(), end: new Date(now - (age - 1) * DAY).toISOString(), total, rows: rows.slice(0, limit) };
  }

  private sumGrowth(t: ScanTree, ids: number[], days: number): GrowthView {
    const out = zeroGrowth();
    for (const id of ids) {
      const v = this.growthView(t, id, days);
      out.newBytes += v.newBytes;
      out.newFiles += v.newFiles;
      out.changedBytes += v.changedBytes;
      out.changedFiles += v.changedFiles;
    }
    return out;
  }

  /** Large files created before the window but modified inside it: "changed recently, growth amount unknown". */
  changedOld(pathIn: string, opts: { days?: number; limit?: number; minBytes?: number } = {}): { path: string; days: number; minBytes: number; files: FileRow[] } {
    const days = this.days(opts.days);
    const { t, id } = this.locate(pathIn);
    const minBytes = Math.max(opts.minBytes ?? 50 * 1024 * 1024, t.growth.fileFloorBytes);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const g = t.growthFor(days);
    const files = g.window.files
      .filter((f) => f.kind === "changed" && f.size >= minBytes && t.isWithin(f.dirId, id))
      .sort((a, b) => b.size - a.size)
      .slice(0, limit)
      .map((f) => this.fileRow(t, f));
    return { path: t.path(id), days, minBytes, files };
  }

  /** Largest files (at or above the large-file size) under a folder. */
  largestFiles(pathIn: string, opts: { limit?: number } = {}): { path: string; minBytes: number; files: FileRow[] } {
    const { t, id } = this.locate(pathIn);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const files = t.largeFiles.filter((f) => t.isWithin(f.dirId, id)).slice(0, limit).map((f) => this.fileRow(t, f));
    return { path: t.path(id), minBytes: this.largeFileBytes, files };
  }

  /** Nested sizes for a treemap: `depth` levels, at most `maxChildren` per folder; the remainder is one "other" node. */
  treemap(pathIn: string, opts: { depth?: number; maxChildren?: number; days?: number } = {}): TreemapNode {
    const depth = Math.min(Math.max(opts.depth ?? 2, 1), 4);
    const maxChildren = Math.min(Math.max(opts.maxChildren ?? 40, 5), 200);
    const days = this.days(opts.days);
    const { t, id } = this.locate(pathIn);
    const g = t.growthFor(days);
    const build = (x: number, level: number): TreemapNode => {
      const cls = this.classify(t, x);
      const node: TreemapNode = { name: t.parent[x] < 0 ? t.path(x) : t.name[x], path: t.path(x), bytes: t.totalBytes[x], label: cls.label, known: cls.known, category: cls.category, newBytes: g.newBytes[x], changedBytes: g.changedBytes[x] };
      if (level >= depth) return node;
      const kids = [...t.children[x]].sort((a, b) => t.totalBytes[b] - t.totalBytes[a]);
      // too small to draw: under 0.2% of the parent or 0.05% of the whole map
      const minShare = Math.max(t.totalBytes[x] * 0.002, t.totalBytes[id] * 0.0005);
      const shown = kids.slice(0, maxChildren).filter((c) => t.totalBytes[c] > 0 && t.totalBytes[c] >= minShare);
      const children = shown.map((c) => build(c, level + 1));
      const other = t.totalBytes[x] - children.reduce((s, c) => s + c.bytes, 0);
      if (other > 0 && children.length > 0) children.push({ name: "Other files and small folders", path: t.path(x), bytes: other, label: cls.label, known: cls.known, category: cls.category, newBytes: 0, changedBytes: 0, other: true });
      if (children.length > 0) node.children = children;
      return node;
    };
    return build(id, 0);
  }

  /** Ranked cleanup candidates: what rules call safe, then check first, then large unknown folders. Proposes only. */
  cleanupPlan(pathIn: string, opts: { days?: number; limit?: number } = {}): { path: string; days: number; totalCandidateBytes: number; candidates: CandidateRow[]; note: string } {
    const days = this.days(opts.days);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const { t, id: start, path } = this.locate(pathIn);
    const unknownMin = 1024 ** 3;
    const out: CandidateRow[] = [];
    const reasonFor = (c: Classification, gv: GrowthView, bytes: number) => {
      const grew =
        (gv.newBytes > 0 ? ` ${formatBytes(gv.newBytes)} of it is new in the last ${days} days.` : "") +
        (gv.changedBytes > 0 ? ` Older files of ${formatBytes(gv.changedBytes)} were changed in that time (growth unknown).` : "");
      if (!c.known) return `Unknown folder of ${formatBytes(bytes)}${c.owner ? `, probably ${c.owner}` : ""}.${grew}`;
      return `${c.what}${grew}`;
    };
    // Items under 10 MB are not worth a row (the live run listed hundreds of tiny __pycache__ folders).
    const minCandidateBytes = 10 * 1024 * 1024;
    const push = (p: string, c: Classification, bytes: number, files: number, gv: GrowthView, groupCount?: number, rest = false) => {
      if (bytes < minCandidateBytes) return;
      const reason = rest ? `Everything else in this folder. ${reasonFor(c, gv, bytes)}` : reasonFor(c, gv, bytes);
      out.push({ path: p, bytes, files, ...gv, ...labelView(c), reason, ...(groupCount ? { groupCount } : {}), ...(rest ? { scope: "rest" as const } : {}) });
    };
    const visit = (id: number, parentKnown: boolean): number => {
      const cls = this.classify(t, id);
      const before = out.length;
      if (cls.known && !cls.descend) {
        if (cls.label === "do_not_touch") return 0;
        if (cls.candidate) {
          push(t.path(id), cls, t.totalBytes[id], t.totalFiles[id], this.growthView(t, id, days));
          return 1;
        }
        // known but not offered as a whole (for example Ollama's home folder): look inside
      }
      let found = 0;
      const groups = new Map<string, { ids: number[]; cls: Classification }>();
      for (const c of t.children[id]) {
        const cc = this.classify(t, c);
        if (cc.group) {
          const k = cc.group.prefix.toLowerCase();
          const e = groups.get(k) ?? { ids: [], cls: cc };
          e.ids.push(c);
          groups.set(k, e);
          continue;
        }
        found += visit(c, cls.known);
      }
      for (const [, e] of groups) {
        const bytes = e.ids.reduce((s, x) => s + t.totalBytes[x], 0);
        const files = e.ids.reduce((s, x) => s + t.totalFiles[x], 0);
        push(`${t.path(id)}\\${e.cls.group!.prefix}*`, e.cls, bytes, files, this.sumGrowth(t, e.ids, days), e.ids.length);
        found++;
      }
      if (!cls.known && found === 0 && parentKnown && id !== start && t.totalBytes[id] >= unknownMin) {
        push(t.path(id), cls, t.totalBytes[id], t.totalFiles[id], this.growthView(t, id, days));
        return 1;
      }
      // A folder a rule offers as a candidate but looks inside (the temp folder, Downloads): list what is left.
      const exact = cls.known && cls.matchedPath !== null && key(cls.matchedPath) === key(t.path(id));
      if (exact && cls.candidate && cls.descend) {
        const inside = out.slice(before);
        const gv = this.growthView(t, id, days);
        for (const r of inside) {
          gv.newBytes -= r.newBytes;
          gv.newFiles -= r.newFiles;
          gv.changedBytes -= r.changedBytes;
          gv.changedFiles -= r.changedFiles;
        }
        const bytes = t.totalBytes[id] - inside.reduce((s, r) => s + r.bytes, 0);
        const files = t.totalFiles[id] - inside.reduce((s, r) => s + r.files, 0);
        if (bytes > 0) {
          push(t.path(id), cls, bytes, files, gv, undefined, inside.length > 0);
          found++;
        }
      }
      return found;
    };
    visit(start, true);
    const rank = (r: CandidateRow) => (!r.known ? 2 : r.label === "safe" ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b) || b.bytes - a.bytes);
    const candidates = out.slice(0, limit);
    return {
      path,
      days,
      totalCandidateBytes: candidates.reduce((s, c) => s + c.bytes, 0),
      candidates,
      note: "Proposals only. DiskDelta v0 never deletes anything. Use each item's reclaim step, preferably the owning app's own command.",
    };
  }

  /** What a path is, who owns it, its label and how to reclaim it; plus sizes when it has been scanned. */
  explain(pathIn: string, opts: { days?: number } = {}): {
    path: string;
    scanned: boolean;
    classification: LabelView & { matchedPath: string | null; group?: { prefix: string; count: number } };
    size?: FolderRow;
    biggestInside?: FolderRow[];
    days: number;
  } {
    const days = this.days(opts.days);
    const path = this.checkPath(pathIn);
    const t = this.treeFor(path);
    const id = t ? t.find(path) : null;
    if (!t || id === null) {
      const c = this.deps.rules.classify(path);
      return { path, scanned: false, classification: { ...labelView(c), matchedPath: c.matchedPath }, days };
    }
    const c = this.classify(t, id);
    const inside = t.children[id].map((x) => this.row(t, x, days)).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    return { path: t.path(id), scanned: true, classification: { ...labelView(c), matchedPath: c.matchedPath, ...(c.group ? { group: c.group } : {}) }, size: this.row(t, id, days, c), biggestInside: inside, days };
  }

  skipped(opts: { path?: string; limit?: number } = {}): { total: number; byReason: Record<string, number>; items: SkippedItem[] } {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);
    let items: SkippedItem[] = [];
    for (const t of this.trees) items.push(...t.skippedItems);
    if (opts.path) {
      const p = this.checkPath(opts.path);
      items = items.filter((i) => within(i.path, p));
    }
    const byReason: Record<string, number> = {};
    for (const i of items) byReason[i.reason] = (byReason[i.reason] ?? 0) + 1;
    return { total: items.length, byReason, items: items.slice(0, limit) };
  }

  // ---------- report ----------

  async report(format: "md" | "html", opts: { days?: number } = {}): Promise<string> {
    const days = this.days(opts.days);
    const data: ReportData = {
      generatedAt: new Date(this.clock()).toISOString(),
      mode: this.mode,
      days,
      drives: await this.listDrives(),
      scans: this.scans(),
      growth: this.trees.map((t) => this.whatGrew(t.root, { days, limit: 25 })),
      changedOld: this.trees.map((t) => this.changedOld(t.root, { days, limit: 20 })),
      cleanup: this.trees.map((t) => this.cleanupPlan(t.root, { days, limit: 25 })),
      skipped: this.skipped({ limit: 50 }),
    };
    return renderReport(format, data);
  }

  /**
   * Writes the report to a new file. Refuses relative paths, wrong extensions, missing folders and existing files
   * (it never overwrites). This and the snapshot store are the only places DiskDelta writes.
   */
  async exportReport(format: "md" | "html", filePath: string, opts: { days?: number } = {}): Promise<{ path: string; bytes: number }> {
    if (!isAbsolute(filePath)) throw new CoreError("Give a full path, for example C:\\Users\\you\\Downloads\\diskdelta-report.md");
    const p = normalize(filePath);
    const ext = format === "md" ? ".md" : ".html";
    if (!p.toLowerCase().endsWith(ext)) throw new CoreError(`The file name must end in ${ext}.`);
    const dir = parentPath(p);
    if (!dir || !fs.existsSync(dir)) throw new CoreError(`Folder does not exist: ${dir ?? p}`);
    const text = await this.report(format, opts);
    try {
      await fs.promises.writeFile(p, text, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new CoreError(`A file with that name already exists: ${basename(p)}. Pick another name.`);
      throw new CoreError(`Could not write the report: ${(e as NodeJS.ErrnoException).code ?? e}`);
    }
    return { path: p, bytes: Buffer.byteLength(text) };
  }

  /** Default export location suggestion: the user's Downloads folder (live) or a placeholder (demo). */
  suggestedExportPath(format: "md" | "html", env: Record<string, string | undefined>): string {
    const date = isoDate(this.clock());
    const home = env.USERPROFILE;
    const dir = home ? `${normalize(home)}\\Downloads` : "C:\\";
    return `${dir}\\diskdelta-report-${date}.${format}`;
  }

  static readonly DAY_MS = DAY;
}
