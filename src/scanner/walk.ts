// WalkScanner: the default Scanner. An async folder walk with bounded concurrency.
//
// Read-only by construction: the only file system calls are fs.promises.readdir and fs.promises.lstat (looked up on
// the fs object at call time, so a test can spy on every call). Files that Windows keeps locked (pagefile.sys and
// similar, where even lstat fails with EBUSY) are sized afterwards with one PowerShell Get-Item call, which reads the
// directory entry and opens nothing.
//
// Links: lstat reports symlinks, junctions and app execution aliases as symbolic links. They are counted via
// sink.link and never descended into. Hard links: a file with more than one link is counted once (by file id).

import { execFile } from "node:child_process";
import fs from "node:fs";
import { join, normalize } from "../util/winpath.ts";
import type { ScanOptions, ScanSink, ScanStats, Scanner, SkipReason } from "../core/types.ts";

export interface WalkScannerOptions {
  /** Size locked files (EBUSY) with PowerShell Get-Item after the walk. Default: true on Windows. */
  probeBusyFiles?: boolean;
}

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

export function skipReason(err: unknown): SkipReason {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return "access_denied";
  if (code === "ENAMETOOLONG") return "path_too_long";
  if (code === "EBUSY") return "in_use";
  if (code === "ENOENT" || code === "ENOTDIR") return "not_found";
  return "error";
}

const errDetail = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err));

interface BusyFile {
  dirId: number;
  path: string;
  name: string;
}

export class WalkScanner implements Scanner {
  readonly name = "walk";
  readonly sizeNote = "Size is the file length (apparent size). Allocated size is the space the file takes on disk, from the file system's allocation size.";

  constructor(private readonly options: WalkScannerOptions = {}) {}

  async scan(rootIn: string, sink: ScanSink, opts: ScanOptions = {}): Promise<ScanStats> {
    const root = normalize(rootIn);
    const startedAt = Date.now();
    const sem = new Semaphore(Math.max(1, opts.concurrency ?? 32));
    const signal = opts.signal;
    const interval = opts.progressIntervalMs ?? 250;
    const seenIds = new Set<string>();
    const busy: BusyFile[] = [];
    const stats: ScanStats = {
      root,
      scanner: this.name,
      folders: 0,
      files: 0,
      bytes: 0,
      allocatedBytes: 0,
      links: 0,
      skipped: 0,
      hardLinkDuplicates: 0,
      cancelled: false,
      startedAt,
      finishedAt: 0,
    };
    let allocKnown = true;
    let lastProgress = 0;
    const progress = (current: string, force = false) => {
      if (!opts.onProgress) return;
      const now = Date.now();
      if (!force && now - lastProgress < interval) return;
      lastProgress = now;
      opts.onProgress({ root, folders: stats.folders, files: stats.files, bytes: stats.bytes, skipped: stats.skipped, links: stats.links, current, elapsedMs: now - startedAt });
    };

    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory()) throw new Error(`Not a folder: ${root}`);
    if (rootStat.isSymbolicLink()) throw new Error(`Refusing to scan a link or junction: ${root}`);

    const visit = async (dirId: number, dirPath: string): Promise<void> => {
      if (signal?.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = await sem.run(() => fs.promises.readdir(dirPath, { withFileTypes: true }));
      } catch (err) {
        stats.skipped++;
        sink.skipped({ path: dirPath, kind: "folder", reason: skipReason(err), detail: errDetail(err) });
        return;
      }
      progress(dirPath);
      const subdirs: Array<Promise<void>> = [];
      await Promise.all(
        entries.map(async (ent) => {
          if (signal?.aborted) return;
          const full = join(dirPath, ent.name);
          let st: fs.Stats;
          try {
            st = await sem.run(() => fs.promises.lstat(full));
          } catch (err) {
            const reason = skipReason(err);
            if (reason === "in_use" && !ent.isDirectory()) {
              busy.push({ dirId, path: full, name: ent.name });
              return;
            }
            stats.skipped++;
            sink.skipped({ path: full, kind: ent.isDirectory() ? "folder" : "file", reason, detail: errDetail(err) });
            return;
          }
          if (st.isSymbolicLink()) {
            stats.links++;
            sink.link(dirId, ent.name);
            return;
          }
          if (st.isDirectory()) {
            stats.folders++;
            const id = sink.folder(dirId, ent.name);
            subdirs.push(visit(id, full));
            return;
          }
          if (!st.isFile()) return;
          if (st.nlink > 1) {
            try {
              const big = await sem.run(() => fs.promises.lstat(full, { bigint: true }));
              const fileId = `${big.dev}:${big.ino}`;
              if (seenIds.has(fileId)) {
                stats.hardLinkDuplicates++;
                return;
              }
              seenIds.add(fileId);
            } catch {
              // fall through and count it
            }
          }
          const allocated = typeof st.blocks === "number" && Number.isFinite(st.blocks) ? st.blocks * 512 : null;
          if (allocated === null) allocKnown = false;
          else stats.allocatedBytes! += allocated;
          const created = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : null;
          stats.files++;
          stats.bytes += st.size;
          sink.file({ dirId, name: ent.name, size: st.size, allocated, created, modified: st.mtimeMs });
        }),
      );
      await Promise.all(subdirs);
    };

    stats.folders = 1;
    const rootId = sink.folder(-1, root);
    await visit(rootId, root);

    if (busy.length > 0 && !signal?.aborted) {
      const probe = this.options.probeBusyFiles ?? process.platform === "win32";
      const found = probe ? await probeBusyFiles(busy.map((b) => b.path)) : new Map<string, ProbedFile>();
      for (const b of busy) {
        const f = found.get(b.path.toLowerCase());
        if (f) {
          stats.files++;
          stats.bytes += f.length;
          allocKnown = false;
          sink.file({ dirId: b.dirId, name: b.name, size: f.length, allocated: null, created: f.created, modified: f.modified });
        } else {
          stats.skipped++;
          sink.skipped({ path: b.path, kind: "file", reason: "in_use", detail: "EBUSY" });
        }
      }
    }

    if (!allocKnown) stats.allocatedBytes = stats.allocatedBytes || null;
    stats.cancelled = !!signal?.aborted;
    stats.finishedAt = Date.now();
    progress(root, true);
    return stats;
  }
}

interface ProbedFile {
  length: number;
  created: number | null;
  modified: number;
}

/** Reads length and times of locked files from their directory entries (PowerShell Get-Item). Opens nothing. */
export function probeBusyFiles(paths: string[]): Promise<Map<string, ProbedFile>> {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$in=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
    "$out=@(foreach($p in $in){$i=Get-Item -LiteralPath $p -Force;if($i -and -not $i.PSIsContainer){" +
    "[pscustomobject]@{p=$p;l=$i.Length;c=([DateTimeOffset]$i.CreationTimeUtc).ToUnixTimeMilliseconds();m=([DateTimeOffset]$i.LastWriteTimeUtc).ToUnixTimeMilliseconds()}}});" +
    "ConvertTo-Json -InputObject $out -Compress";
  return new Promise((resolve) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map<string, ProbedFile>();
      if (err) return resolve(map);
      try {
        const rows = JSON.parse(stdout || "[]") as Array<{ p: string; l: number; c: number; m: number }>;
        for (const r of rows) map.set(r.p.toLowerCase(), { length: r.l, created: r.c > 0 ? r.c : null, modified: r.m });
      } catch {
        // ignore unparsable output; the files are reported as skipped
      }
      resolve(map);
    });
    child.stdin?.end(JSON.stringify(paths));
  });
}
