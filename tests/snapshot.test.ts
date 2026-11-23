import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeSnapshot, encodeSnapshot, FileSnapshotStore, MemorySnapshotStore } from "../src/snapshot/store.ts";
import type { Snapshot } from "../src/core/types.ts";
import { tempDir } from "./helpers.ts";

const snap = (i: number): Snapshot => ({
  format: "diskdelta-snapshot",
  version: 1,
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
  root: "C:\\",
  scanner: "walk",
  stats: { root: "C:\\", scanner: "walk", folders: 1, files: 2, bytes: 3, allocatedBytes: 4, links: 0, skipped: 0, hardLinkDuplicates: 0, cancelled: false, startedAt: 0, finishedAt: 1 },
  thresholds: { folderMinBytes: 10, fileMinBytes: 100 },
  folders: [["C:\\", 3, 2]],
  files: [["C:\\big.bin", 200, null, 5]],
});

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("snapshot format", () => {
  it("round-trips through gzipped JSON", () => {
    expect(decodeSnapshot(encodeSnapshot(snap(1)))).toEqual(snap(1));
  });
  it("rejects other formats and other versions", () => {
    expect(() => decodeSnapshot(gzipSync(Buffer.from(JSON.stringify({ format: "x", version: 1 }))))).toThrow(/Not a DiskDelta snapshot/);
    expect(() => decodeSnapshot(gzipSync(Buffer.from(JSON.stringify({ ...snap(1), version: 2 }))))).toThrow(/version 2/);
  });
});

describe("FileSnapshotStore", () => {
  it("saves, lists newest first, loads, and keeps only the newest N", async () => {
    const dir = tempDir("snap");
    dirs.push(dir);
    const store = new FileSnapshotStore(dir, 10);
    for (let i = 0; i < 13; i++) await store.save(snap(i));
    const list = await store.list();
    expect(list.length).toBe(10);
    expect(list[0].createdAt).toBe(snap(12).createdAt);
    expect(list.at(-1)!.createdAt).toBe(snap(3).createdAt);
    expect(await store.load(list[0].id)).toEqual(snap(12));
    expect(fs.readdirSync(dir).length).toBe(10);
  });
  it("never touches files it did not write and refuses bad ids", async () => {
    const dir = tempDir("snap2");
    dirs.push(dir);
    fs.writeFileSync(`${dir}\\notes.txt`, "keep me");
    const store = new FileSnapshotStore(dir, 1);
    await store.save(snap(1));
    await store.save(snap(2));
    expect(fs.readFileSync(`${dir}\\notes.txt`, "utf8")).toBe("keep me");
    await expect(store.load("..\\..\\evil")).rejects.toThrow(/Bad snapshot id/);
  });
});

describe("MemorySnapshotStore", () => {
  it("implements the same interface in memory", async () => {
    const m = new MemorySnapshotStore(2);
    for (let i = 0; i < 3; i++) await m.save(snap(i));
    const list = await m.list();
    expect(list.length).toBe(2);
    expect((await m.load(list[0].id)).createdAt).toBe(snap(2).createdAt);
  });
});
