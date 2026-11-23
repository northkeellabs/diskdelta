// Snapshot storage. The format (Snapshot in core/types.ts) is versioned: format "diskdelta-snapshot", version 1.
// encodeSnapshot/decodeSnapshot handle the bytes (gzipped JSON); a SnapshotStore decides where they live.
//   FileSnapshotStore    one .json.gz file per scan in a folder (default %LOCALAPPDATA%\DiskDelta\snapshots), keeps the newest N
//   MemorySnapshotStore  in memory only (demo mode and tests)
// v0 writes snapshots but does not compare them; comparison is a v1 feature.

import fs from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Snapshot, SnapshotInfo, SnapshotStore } from "../core/types.ts";

export const SNAPSHOT_FORMAT = "diskdelta-snapshot";
export const SNAPSHOT_VERSION = 1;

export function encodeSnapshot(s: Snapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(s), "utf8"));
}

export function decodeSnapshot(buf: Buffer): Snapshot {
  const s = JSON.parse(gunzipSync(buf).toString("utf8"));
  if (s?.format !== SNAPSHOT_FORMAT) throw new Error("Not a DiskDelta snapshot");
  if (s.version !== SNAPSHOT_VERSION) throw new Error(`Unsupported snapshot version ${s.version}`);
  return s as Snapshot;
}

const ID_RE = /^\d{8}T\d{6}\d{3}Z-[A-Z]-[0-9a-f]{6}$/;

function makeId(s: Snapshot): string {
  const t = s.createdAt.replace(/[-:.]/g, "");
  const drive = /^[A-Za-z]:/.test(s.root) ? s.root[0].toUpperCase() : "X";
  const rnd = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${t}-${drive}-${rnd}`;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(
    private readonly dir: string,
    private readonly keep = 10,
  ) {}

  async save(s: Snapshot): Promise<SnapshotInfo> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const id = makeId(s);
    const buf = encodeSnapshot(s);
    await fs.promises.writeFile(join(this.dir, `${id}.json.gz`), buf, { flag: "wx" });
    await this.prune();
    return { id, root: s.root, createdAt: s.createdAt, bytes: buf.length };
  }

  private async ids(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json.gz"))
      .map((n) => n.slice(0, -8))
      .filter((id) => ID_RE.test(id))
      .sort();
  }

  /** Deletes the oldest snapshots beyond `keep`. Only files this store wrote (matching its id pattern) are touched. */
  private async prune(): Promise<void> {
    const ids = await this.ids();
    for (const id of ids.slice(0, Math.max(0, ids.length - this.keep))) await fs.promises.unlink(join(this.dir, `${id}.json.gz`));
  }

  async list(): Promise<SnapshotInfo[]> {
    const out: SnapshotInfo[] = [];
    for (const id of (await this.ids()).reverse()) {
      const st = await fs.promises.stat(join(this.dir, `${id}.json.gz`));
      const s = await this.load(id);
      out.push({ id, root: s.root, createdAt: s.createdAt, bytes: st.size });
    }
    return out;
  }

  async load(id: string): Promise<Snapshot> {
    if (!ID_RE.test(id)) throw new Error("Bad snapshot id");
    return decodeSnapshot(await fs.promises.readFile(join(this.dir, `${id}.json.gz`)));
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly items = new Map<string, Buffer>();
  constructor(private readonly keep = 10) {}

  async save(s: Snapshot): Promise<SnapshotInfo> {
    const id = makeId(s);
    const buf = encodeSnapshot(s);
    this.items.set(id, buf);
    const ids = [...this.items.keys()].sort();
    for (const old of ids.slice(0, Math.max(0, ids.length - this.keep))) this.items.delete(old);
    return { id, root: s.root, createdAt: s.createdAt, bytes: buf.length };
  }

  async list(): Promise<SnapshotInfo[]> {
    return [...this.items.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([id, buf]) => {
        const s = decodeSnapshot(buf);
        return { id, root: s.root, createdAt: s.createdAt, bytes: buf.length };
      });
  }

  async load(id: string): Promise<Snapshot> {
    const buf = this.items.get(id);
    if (!buf) throw new Error("No such snapshot");
    return decodeSnapshot(buf);
  }
}
