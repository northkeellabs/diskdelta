// Demo mode: a fictional PC for screenshots, tests and trying the tool. Nothing here touches the real disk.
//   DemoScanner        implements Scanner over a generated in-memory tree (user "demo", invented apps and files)
//   DemoDriveProvider  implements DriveProvider with invented drives
//   DEMO_ENV           the environment the rules engine uses in demo mode
// The tree is deterministic for a given "now": sizes come from a seeded generator, dates are relative to now.

import type { DriveInfo, DriveProvider, ScanOptions, ScanSink, ScanStats, Scanner } from "../core/types.ts";
import { normalize, segments } from "../util/winpath.ts";

export const DEMO_ENV: Record<string, string> = {
  USERPROFILE: "C:\\Users\\demo",
  LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
  APPDATA: "C:\\Users\\demo\\AppData\\Roaming",
  TEMP: "C:\\Users\\demo\\AppData\\Local\\Temp",
  PROGRAMDATA: "C:\\ProgramData",
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  WINDIR: "C:\\Windows",
  SYSTEMDRIVE: "C:",
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86_400_000;

interface VFile {
  name: string;
  size: number;
  created: number;
  modified: number;
}
interface VDir {
  name: string;
  dirs: Map<string, VDir>;
  files: VFile[];
  links: string[];
  skip?: "access_denied" | "path_too_long";
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  /** Folder path relative to the drive root, e.g. "Users\\demo\\Videos". */
  dir: string;
  count: number;
  total: number;
  /** Created this many days ago (range). */
  created: [number, number];
  /** Modified this many days ago (range); defaults to the created age. Clamped to be no older than created. */
  modified?: [number, number];
  ext?: string;
  names?: string[];
}

const T = "Users\\demo\\AppData\\Local\\Temp";
const L = "Users\\demo\\AppData\\Local";
const R = "Users\\demo\\AppData\\Roaming";
const U = "Users\\demo";

const RANDOM_SUFFIXES = ["8f3k2a", "1a9b0c", "x7y6z5", "q2w3e4", "r5t6y7", "u8i9o0", "p1a2s3", "d4f5g6", "h7j8k9", "l0z1x2", "c3v4b5", "n6m7q8", "w9e8r7", "t6y5u4", "i3o2p1", "a0s9d8", "f7g6h5", "j4k3l2", "z1x0c9", "v8b7n6", "m5q4w3", "e2r1t0", "y9u8i7", "o6p5a4", "s3d2f1", "g0h9j8", "k7l6z5", "x4c3v2", "b1n0m9", "q8w7e6", "r5t4y3", "u2i1o0", "p9a8s7", "d6f5g4", "h3j2k1", "l0z9x8"];

const C_GENS: Gen[] = [
  { dir: "Windows\\System32", count: 420, total: 8.4 * GB, created: [300, 900], ext: ".dll" },
  { dir: "Windows\\System32\\drivers", count: 160, total: 0.6 * GB, created: [300, 900], ext: ".sys" },
  { dir: "Windows\\WinSxS", count: 380, total: 9.2 * GB, created: [200, 900], ext: ".cab" },
  { dir: "Windows\\Installer", count: 40, total: 3.1 * GB, created: [90, 700], ext: ".msi" },
  { dir: "Windows\\SoftwareDistribution\\Download", count: 24, total: 2.4 * GB, created: [4, 21], ext: ".esd" },
  { dir: "Windows\\Temp", count: 30, total: 0.35 * GB, created: [1, 9], ext: ".tmp" },
  { dir: "$Recycle.Bin\\S-1-5-21-1000", count: 18, total: 2.2 * GB, created: [2, 26], ext: ".zip" },
  { dir: "Program Files\\Contoso Office", count: 260, total: 4.1 * GB, created: [200, 400], ext: ".dll" },
  { dir: "Program Files\\Fictional Photo Studio", count: 180, total: 3.0 * GB, created: [150, 300], ext: ".dll" },
  { dir: "Program Files\\Northwind Player", count: 60, total: 0.45 * GB, created: [9, 10], ext: ".dll" },
  { dir: "Program Files\\nodejs\\node_modules\\npm", count: 90, total: 0.04 * GB, created: [60, 61], ext: ".js" },
  { dir: "Program Files (x86)\\Common Files", count: 120, total: 1.1 * GB, created: [300, 800], ext: ".dll" },
  { dir: "ProgramData\\Package Cache", count: 30, total: 3.2 * GB, created: [100, 500], ext: ".msi" },
  { dir: "ProgramData\\Microsoft\\Windows\\WER\\ReportArchive", count: 40, total: 0.8 * GB, created: [1, 28], ext: ".wer" },
  { dir: "ProgramData\\Zentrix Labs\\sync", count: 70, total: 1.3 * GB, created: [2, 18], ext: ".dat" },
  { dir: `${T}`, count: 45, total: 0.55 * GB, created: [0, 40], ext: ".tmp" },
  { dir: `${T}\\claude\\session-a\\scratchpad`, count: 30, total: 0.42 * GB, created: [0, 1], ext: ".json" },
  { dir: `${T}\\claude\\session-b\\tasks`, count: 20, total: 0.21 * GB, created: [0, 2], ext: ".log" },
  ...RANDOM_SUFFIXES.map((s, i): Gen => ({ dir: `${T}\\vitest-${s}`, count: 12, total: (35 + (i % 7) * 9) * MB, created: [1 + (i % 25), 1 + (i % 25)], ext: ".js" })),
  ...["k2j3h4l5", "a8xyzq01", "0b7c6d5e", "zz91kq2p", "w4e5r6t7", "y8u9i0o1", "h2g3f4d5"].map((s, i): Gen => ({ dir: `${T}\\tmp${s}`, count: 4, total: (18 + i * 4) * MB, created: [3 + i * 2, 3 + i * 2], ext: ".whl" })),
  { dir: `${L}\\Docker\\wsl\\disk`, count: 1, total: 48.6 * GB, created: [210, 210], modified: [0, 0], names: ["docker_data.vhdx"] },
  { dir: `${L}\\Packages\\CanonicalGroupLimited.Ubuntu22.04LTS_79rhkp1fndgsc\\LocalState`, count: 1, total: 22.3 * GB, created: [330, 330], modified: [1, 1], names: ["ext4.vhdx"] },
  { dir: `${L}\\Packages\\Contoso.NotesApp_8wekyb3d8bbwe\\LocalCache`, count: 60, total: 0.9 * GB, created: [5, 50], ext: ".db" },
  { dir: `${L}\\Microsoft\\Edge\\User Data\\Default\\Cache\\Cache_Data`, count: 600, total: 1.4 * GB, created: [0, 45], ext: "" },
  { dir: `${L}\\Microsoft\\Edge\\User Data\\Default`, count: 40, total: 0.6 * GB, created: [100, 400], modified: [0, 3], ext: ".db" },
  { dir: `${L}\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data`, count: 380, total: 0.9 * GB, created: [0, 60], ext: "" },
  { dir: `${L}\\npm-cache\\_cacache\\content-v2\\sha512`, count: 1200, total: 3.1 * GB, created: [0, 200], ext: "" },
  { dir: `${L}\\pip\\cache\\http-v2`, count: 300, total: 1.2 * GB, created: [10, 300], ext: "" },
  { dir: `${L}\\uv\\cache\\archive-v0`, count: 500, total: 4.6 * GB, created: [0, 35], ext: "" },
  { dir: `${L}\\Programs\\Microsoft VS Code`, count: 140, total: 0.62 * GB, created: [6, 7], ext: ".dll" },
  { dir: `${L}\\Fooware\\data`, count: 90, total: 2.3 * GB, created: [1, 20], ext: ".pak" },
  { dir: `${L}\\CrashDumps`, count: 6, total: 0.9 * GB, created: [2, 40], ext: ".dmp" },
  { dir: `${L}\\D3DSCache`, count: 80, total: 0.3 * GB, created: [0, 100], ext: "" },
  { dir: `${R}\\Claude\\vm_bundles\\claudevm.bundle`, count: 1, total: 9.6 * GB, created: [40, 40], modified: [0, 0], names: ["rootfs.vhdx"] },
  { dir: `${R}\\Claude\\logs`, count: 12, total: 0.05 * GB, created: [0, 30], ext: ".log" },
  { dir: `${R}\\Slack\\Cache\\Cache_Data`, count: 300, total: 0.7 * GB, created: [0, 90], ext: "" },
  { dir: `${R}\\Code\\CachedData`, count: 200, total: 0.9 * GB, created: [6, 120], ext: "" },
  { dir: `${U}\\.ollama\\models\\manifests\\registry.ollama.ai\\library`, count: 4, total: 0.00002 * GB, created: [3, 100], ext: "" },
  { dir: `${U}\\.cache\\huggingface\\hub\\models--some-org--some-model`, count: 6, total: 6.3 * GB, created: [60, 61], ext: ".safetensors" },
  { dir: `${U}\\.lmstudio\\models\\some-org\\some-model-GGUF`, count: 1, total: 7.9 * GB, created: [8, 8], names: ["some-model-Q4_K_M.gguf"] },
  { dir: `${U}\\.nuget\\packages`, count: 400, total: 2.1 * GB, created: [100, 600], ext: ".nupkg" },
  { dir: `${U}\\.vscode\\extensions`, count: 300, total: 1.1 * GB, created: [6, 300], ext: ".js" },
  { dir: `${U}\\Documents\\projects\\webapp\\node_modules`, count: 2500, total: 0.65 * GB, created: [15, 16], ext: ".js" },
  { dir: `${U}\\Documents\\projects\\webapp\\src`, count: 80, total: 0.004 * GB, created: [15, 200], modified: [0, 15], ext: ".ts" },
  { dir: `${U}\\Documents\\Reports`, count: 40, total: 0.3 * GB, created: [5, 700], ext: ".docx" },
  { dir: `${U}\\Videos\\Captures`, count: 14, total: 6.5 * GB, created: [0, 27], ext: ".mp4" },
  { dir: `${U}\\Pictures\\Camera Roll`, count: 2400, total: 12.4 * GB, created: [40, 1500], ext: ".jpg" },
  { dir: `${U}\\Downloads`, count: 26, total: 3.4 * GB, created: [1, 400], ext: ".exe" },
  { dir: `${U}\\Desktop`, count: 12, total: 0.08 * GB, created: [2, 300], ext: ".lnk" },
  { dir: "dev\\shop-api\\node_modules", count: 3000, total: 0.9 * GB, created: [3, 4], ext: ".js" },
  { dir: "dev\\shop-api\\src", count: 120, total: 0.003 * GB, created: [3, 400], modified: [0, 3], ext: ".ts" },
  { dir: "dev\\ml\\.venv\\Lib\\site-packages", count: 1500, total: 5.6 * GB, created: [20, 21], ext: ".pyd" },
];

const D_GENS: Gen[] = [
  { dir: "Renders\\final", count: 40, total: 31 * GB, created: [1, 29], ext: ".mov" },
  { dir: "Renders\\archive", count: 120, total: 88 * GB, created: [100, 600], ext: ".mov" },
  { dir: "SteamLibrary\\steamapps\\common\\Some Game", count: 300, total: 61 * GB, created: [200, 210], modified: [3, 3], ext: ".pak" },
  { dir: "Backups\\2025", count: 12, total: 210 * GB, created: [300, 330], ext: ".img" },
  { dir: "Projects\\video-edit", count: 60, total: 14 * GB, created: [5, 80], ext: ".prproj" },
  { dir: "$Recycle.Bin\\S-1-5-21-1000", count: 6, total: 4.1 * GB, created: [1, 12], ext: ".mov" },
];

const E_GENS: Gen[] = [
  { dir: "Photos 2024", count: 800, total: 9.5 * GB, created: [300, 600], ext: ".jpg" },
  { dir: "Transfer", count: 5, total: 3.2 * GB, created: [2, 6], ext: ".zip" },
];

function addPath(root: VDir, rel: string): VDir {
  let d = root;
  for (const s of rel.split("\\").filter(Boolean)) {
    let n = d.dirs.get(s.toLowerCase());
    if (!n) {
      n = { name: s, dirs: new Map(), files: [], links: [] };
      d.dirs.set(s.toLowerCase(), n);
    }
    d = n;
  }
  return d;
}

function buildTree(rootName: string, gens: Gen[], now: number, extra?: (root: VDir) => void): VDir {
  const root: VDir = { name: rootName, dirs: new Map(), files: [], links: [] };
  for (const g of gens) {
    const d = addPath(root, g.dir);
    const r = rng(hash(rootName + g.dir));
    const weights = Array.from({ length: g.count }, () => 0.3 + r());
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < g.count; i++) {
      const cAge = g.created[0] + r() * (g.created[1] - g.created[0]);
      const m = g.modified ?? g.created;
      let mAge = m[0] + r() * (m[1] - m[0]);
      if (mAge > cAge) mAge = cAge;
      const name = g.names?.[i] ?? `${(g.ext ? "file" : "f_") + String(i + 1).padStart(4, "0")}${g.ext ?? ""}`;
      d.files.push({ name, size: Math.round((g.total * weights[i]) / sum), created: Math.round(now - cAge * DAY - r() * 3600_000), modified: Math.round(now - mAge * DAY - r() * 600_000) });
    }
  }
  extra?.(root);
  return root;
}

function cTree(now: number): VDir {
  return buildTree("C:\\", C_GENS, now, (root) => {
    const at = (days: number) => now - days * DAY;
    root.files.push(
      { name: "pagefile.sys", size: Math.round(16 * GB), created: at(420), modified: at(0.2) },
      { name: "hiberfil.sys", size: Math.round(12.7 * GB), created: at(420), modified: at(0.9) },
      { name: "swapfile.sys", size: 256 * MB, created: at(420), modified: at(0.2) },
    );
    const blobs = addPath(root, `${U}\\.ollama\\models\\blobs`);
    blobs.files.push(
      { name: "sha256-6a0746a1ec1a", size: Math.round(4.7 * GB), created: at(3), modified: at(3) },
      { name: "sha256-2bada8a74506", size: Math.round(8.1 * GB), created: at(12), modified: at(12) },
      { name: "sha256-dde5aa3fc5ff", size: Math.round(2.0 * GB), created: at(100), modified: at(100) },
      { name: "sha256-96c415656d37", size: Math.round(19.0 * GB), created: at(25), modified: at(25) },
    );
    addPath(root, "System Volume Information").skip = "access_denied";
    addPath(root, "Windows\\System32\\config").skip = "access_denied";
    addPath(root, `${L}\\ElevatedDiagnostics`).skip = "access_denied";
    addPath(root, `${U}\\Documents\\projects\\webapp\\node_modules\\.cache\\deeply-nested-generated-folder-name-that-goes-on`).skip = "path_too_long";
    addPath(root, `${U}\\Documents`).links.push("My Music", "My Pictures", "My Videos");
    addPath(root, `${U}`).links.push("Application Data", "Local Settings");
  });
}

function dTree(now: number): VDir {
  return buildTree("D:\\", D_GENS, now);
}
function eTree(now: number): VDir {
  return buildTree("E:\\", E_GENS, now);
}

export class DemoScanner implements Scanner {
  readonly name = "demo";
  readonly sizeNote = "Demo data: invented files on an invented PC. Allocated size is shown equal to size.";
  private trees = new Map<string, VDir>();

  /** delayMs: pause every 20 folders, so the progress screen can be seen (DISKDELTA_DEMO_DELAY_MS). */
  constructor(
    private readonly clock: () => number = Date.now,
    private readonly delayMs = 0,
  ) {}

  private tree(letter: string): VDir | null {
    const key = letter.toUpperCase();
    if (!this.trees.has(key)) {
      const now = this.clock();
      const t = key === "C" ? cTree(now) : key === "D" ? dTree(now) : key === "E" ? eTree(now) : null;
      if (!t) return null;
      this.trees.set(key, t);
    }
    return this.trees.get(key)!;
  }

  async scan(rootIn: string, sink: ScanSink, opts: ScanOptions = {}): Promise<ScanStats> {
    const root = normalize(rootIn);
    const startedAt = Date.now();
    const segs = segments(root);
    let node = this.tree(segs[0][0]);
    for (const s of segs.slice(1)) node = node?.dirs.get(s.toLowerCase()) ?? null;
    if (!node) {
      const e = new Error(`ENOENT: no such folder in the demo PC: ${root}`) as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    }
    const stats: ScanStats = { root, scanner: this.name, folders: 0, files: 0, bytes: 0, allocatedBytes: 0, links: 0, skipped: 0, hardLinkDuplicates: 0, cancelled: false, startedAt, finishedAt: 0 };
    let ops = 0;
    const walk = async (d: VDir, id: number, path: string): Promise<void> => {
      if (opts.signal?.aborted) return;
      if (++ops % 20 === 0) {
        await new Promise((r) => setTimeout(r, 1 + this.delayMs));
        opts.onProgress?.({ root, folders: stats.folders, files: stats.files, bytes: stats.bytes, skipped: stats.skipped, links: stats.links, current: path, elapsedMs: Date.now() - startedAt });
      }
      for (const f of d.files) {
        stats.files++;
        stats.bytes += f.size;
        stats.allocatedBytes! += f.size;
        sink.file({ dirId: id, name: f.name, size: f.size, allocated: f.size, created: f.created, modified: f.modified });
      }
      for (const l of d.links) {
        stats.links++;
        sink.link(id, l);
      }
      for (const c of d.dirs.values()) {
        const p = path.endsWith("\\") ? path + c.name : `${path}\\${c.name}`;
        if (c.skip) {
          stats.skipped++;
          sink.skipped({ path: p, kind: "folder", reason: c.skip, detail: c.skip === "access_denied" ? "EPERM" : "ENAMETOOLONG" });
          continue;
        }
        stats.folders++;
        await walk(c, sink.folder(id, c.name), p);
      }
    };
    stats.folders = 1;
    await walk(node, sink.folder(-1, root), root);
    stats.cancelled = !!opts.signal?.aborted;
    stats.finishedAt = Date.now();
    opts.onProgress?.({ root, folders: stats.folders, files: stats.files, bytes: stats.bytes, skipped: stats.skipped, links: stats.links, current: root, elapsedMs: stats.finishedAt - startedAt });
    return stats;
  }
}

export class DemoDriveProvider implements DriveProvider {
  async list(): Promise<DriveInfo[]> {
    return [
      { root: "C:\\", letter: "C", label: "Windows", type: "fixed", fileSystem: "NTFS", size: 476 * GB, free: Math.round(31.4 * GB), scanByDefault: true },
      { root: "D:\\", letter: "D", label: "Data", type: "fixed", fileSystem: "NTFS", size: 931 * GB, free: Math.round(482 * GB), scanByDefault: true },
      { root: "E:\\", letter: "E", label: "USB DRIVE", type: "removable", fileSystem: "exFAT", size: 58 * GB, free: Math.round(44.9 * GB), scanByDefault: true },
      { root: "G:\\", letter: "G", label: "Google Drive", type: "cloud", fileSystem: "FAT32", size: 100 * GB, free: Math.round(63.2 * GB), scanByDefault: false },
      { root: "Z:\\", letter: "Z", label: "media", type: "network", fileSystem: "NTFS", size: 3600 * GB, free: Math.round(1210 * GB), remotePath: "\\\\nas\\media", scanByDefault: false },
    ];
  }
}
