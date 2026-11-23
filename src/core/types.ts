// Shared types for all DiskDelta modules. Every module depends on this file; no module depends on another module's internals.
//
// Module map (each behind a small interface):
//   Scanner          src/scanner/   walks a folder tree and reports folders, files, links and skips to a ScanSink
//   GrowthDetector   src/growth/    turns file dates into "recent growth" for any window of N days
//   RulesEngine      src/rules/     labels a path: safe | check_first | do_not_touch (or unknown)
//   SnapshotStore    src/snapshot/  saves a small, versioned summary of each scan
//   DriveProvider    src/drives/    lists the drives on this PC
//   Core API         src/core/api.ts  the only thing the MCP layer and the UI talk to
//   MCP layer        src/mcp/       stdio MCP server, read-only tools
//   UI               src/ui/        local web server on 127.0.0.1 plus one self-contained page

export type Label = "safe" | "check_first" | "do_not_touch";

/** One file as reported by a Scanner. Times are epoch milliseconds. */
export interface FileEntry {
  /** Id of the folder that holds the file (as returned by ScanSink.folder). */
  dirId: number;
  name: string;
  /** Apparent size in bytes (the file's length). */
  size: number;
  /** Allocated size on disk in bytes, or null when the scanner cannot get it cheaply. */
  allocated: number | null;
  /** Creation (birth) time, or null when the file system does not record it. */
  created: number | null;
  modified: number;
}

export type SkipReason = "access_denied" | "path_too_long" | "in_use" | "not_found" | "error";

export interface SkippedItem {
  path: string;
  kind: "folder" | "file";
  reason: SkipReason;
  detail?: string;
}

/**
 * Receives what a Scanner finds. The Core API supplies the sink; the scanner never sees how results are stored.
 * Folder ids are assigned by the sink; a child folder is always reported after its parent, so ids grow with depth.
 */
export interface ScanSink {
  /** Report a folder. parentId is -1 for the scan root (name is then the full root path). Returns the folder id. */
  folder(parentId: number, name: string): number;
  file(entry: FileEntry): void;
  /** A symlink, junction or other reparse point that was NOT followed. */
  link(parentId: number, name: string): void;
  skipped(item: SkippedItem): void;
}

export interface ScanProgress {
  root: string;
  folders: number;
  files: number;
  bytes: number;
  skipped: number;
  links: number;
  /** Folder being read right now (for display only). */
  current: string;
  elapsedMs: number;
}

export interface ScanOptions {
  signal?: AbortSignal;
  /** Max file system operations in flight. */
  concurrency?: number;
  onProgress?: (p: ScanProgress) => void;
  /** Milliseconds between progress callbacks. */
  progressIntervalMs?: number;
}

export interface ScanStats {
  root: string;
  scanner: string;
  folders: number;
  files: number;
  bytes: number;
  allocatedBytes: number | null;
  links: number;
  skipped: number;
  /** Files seen more than once through hard links and counted only once. */
  hardLinkDuplicates: number;
  cancelled: boolean;
  startedAt: number;
  finishedAt: number;
}

/**
 * A Scanner walks one root and reports to a sink. Implementations: WalkScanner (folder walk with lstat),
 * DemoScanner (fictional tree). A future NTFS MFT reader only has to implement this interface.
 * Contract: read-only (never opens a file for writing, never changes attributes), never follows links or
 * junctions, reports every folder it could not read via sink.skipped, honours opts.signal.
 */
export interface Scanner {
  readonly name: string;
  /** What FileEntry.allocated means for this scanner, for labelling in the UI. */
  readonly sizeNote: string;
  scan(root: string, sink: ScanSink, opts?: ScanOptions): Promise<ScanStats>;
}

export type DriveType = "fixed" | "removable" | "network" | "cloud" | "optical" | "ram" | "unknown";

export interface DriveInfo {
  /** "C:\" */
  root: string;
  letter: string;
  label: string;
  type: DriveType;
  fileSystem: string;
  size: number;
  free: number;
  /** Network share path for mapped drives. */
  remotePath?: string;
  /** True for local fixed and removable drives; network, cloud and optical drives are only scanned when chosen. */
  scanByDefault: boolean;
}

export interface DriveProvider {
  list(): Promise<DriveInfo[]>;
}

/** Recent-growth numbers for one folder (own files only, or rolled up). */
export interface GrowthCounts {
  /** Bytes of files created within the window. */
  newBytes: number;
  newFiles: number;
  /** Bytes of files created before the window (or with no creation time) but modified within it. Growth amount unknown. */
  changedBytes: number;
  changedFiles: number;
}

export interface RecentFile {
  dirId: number;
  name: string;
  size: number;
  created: number | null;
  modified: number;
  kind: "new" | "changed";
}

/** The result of asking a GrowthDetector about one window. */
export interface GrowthWindow {
  days: number;
  /** Window start, epoch ms. A file is in the window when created >= start or modified >= start. */
  start: number;
  /** Own (not rolled up) counts per folder id; folders with nothing recent are absent. */
  own: Map<number, GrowthCounts>;
  /** Recent files the detector kept (files at or above its size floor), all folders. */
  files: RecentFile[];
}

/**
 * Turns file dates into recent growth. observe() is called for every file during a scan; window() can then be
 * asked for any number of days up to maxDays without rescanning.
 */
export interface GrowthDetector {
  /** "Now" for the scan, epoch ms; ages are counted back from it. */
  readonly now: number;
  readonly maxDays: number;
  /** Smallest file kept for file-level drill-down (smaller files still count in the folder totals). */
  readonly fileFloorBytes: number;
  observe(file: FileEntry): void;
  window(days: number): GrowthWindow;
  /**
   * New files (created in the window) per age in days: index a holds files created between a and a-1 days before
   * now (index 0 is unused; files dated at or after now count in index 1). Older files that changed are not included.
   * `include` limits the count to some folders.
   */
  newByAge(days: number, include?: (dirId: number) => boolean): Array<{ bytes: number; files: number }>;
  /** Own new bytes per folder for files created at one age (1 = the last 24 hours). changedBytes is always 0. */
  ownNewAtAge(age: number): Map<number, GrowthCounts>;
}

export interface Classification {
  path: string;
  label: Label;
  /** False when no rule describes this path ("Unknown - check first"). */
  known: boolean;
  ruleId: string | null;
  category: string | null;
  what: string;
  reclaim: string;
  /** A command the user can copy to reclaim the space, when the rule has one. */
  command: string | null;
  notes: string;
  /** App that probably owns the folder, from its AppData / ProgramData / Program Files path. */
  owner: string | null;
  /** The folder (this path or an ancestor) the winning rule matched. */
  matchedPath: string | null;
  /** True when a "safe" label was lowered to check_first because the path is inside a personal folder. */
  capped: boolean;
  /** Whether this folder should be offered in a cleanup plan. */
  candidate: boolean;
  /** True when growth reports should look at the folders inside this one instead of reporting it as one unit. */
  descend: boolean;
  /** Set when the path is one of many sibling temp folders sharing a name prefix. */
  group?: { prefix: string; count: number };
}

export interface ClassifyContext {
  /** Names of the sibling entries in the same parent folder (enables repeated-temp-folder detection). */
  siblingNames?: string[];
}

export interface RulesEngine {
  classify(path: string, ctx?: ClassifyContext): Classification;
  /** Number of rules loaded. */
  readonly size: number;
}

/** Versioned snapshot of one scan: folder totals plus large files. */
export interface Snapshot {
  format: "diskdelta-snapshot";
  version: 1;
  createdAt: string;
  root: string;
  scanner: string;
  stats: ScanStats;
  thresholds: { folderMinBytes: number; fileMinBytes: number };
  /** [path, totalBytes, totalFiles] for folders at or above folderMinBytes. */
  folders: Array<[string, number, number]>;
  /** [path, bytes, createdMs or null, modifiedMs] for files at or above fileMinBytes. */
  files: Array<[string, number, number | null, number]>;
}

export interface SnapshotInfo {
  id: string;
  root: string;
  createdAt: string;
  bytes: number;
}

/** Where snapshots live. FileSnapshotStore (gzipped JSON on disk) and MemorySnapshotStore implement it. */
export interface SnapshotStore {
  save(s: Snapshot): Promise<SnapshotInfo>;
  list(): Promise<SnapshotInfo[]>;
  load(id: string): Promise<Snapshot>;
}
