import { describe, expect, it } from "vitest";
import { ageDays, DateGrowthDetector, DAY_MS } from "../src/growth/detector.ts";
import type { FileEntry } from "../src/core/types.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const f = (dirId: number, size: number, created: number | null, modified: number, name = "x"): FileEntry => ({ dirId, name, size, allocated: null, created, modified });
const ago = (days: number, ms = 0) => NOW - days * DAY_MS - ms;

describe("ageDays", () => {
  it("rounds up to whole days; at or after now is 0", () => {
    expect(ageDays(NOW, NOW)).toBe(0);
    expect(ageDays(NOW, NOW + 5000)).toBe(0);
    expect(ageDays(NOW, ago(0, 1))).toBe(1);
    expect(ageDays(NOW, ago(30))).toBe(30);
    expect(ageDays(NOW, ago(30, 1))).toBe(31);
  });
});

describe("DateGrowthDetector window logic", () => {
  it("created within the window counts as new, even with an old modified date (copied or extracted files)", () => {
    const g = new DateGrowthDetector({ now: NOW });
    g.observe(f(1, 100, ago(2), ago(500)));
    const w = g.window(30);
    expect(w.own.get(1)).toEqual({ newBytes: 100, newFiles: 1, changedBytes: 0, changedFiles: 0 });
  });

  it("created before the window but modified within it counts as changed (growth unknown)", () => {
    const g = new DateGrowthDetector({ now: NOW });
    g.observe(f(1, 5000, ago(200), ago(3)));
    expect(g.window(30).own.get(1)).toEqual({ newBytes: 0, newFiles: 0, changedBytes: 5000, changedFiles: 1 });
    expect(g.window(365).own.get(1)).toEqual({ newBytes: 5000, newFiles: 1, changedBytes: 0, changedFiles: 0 });
  });

  it("no creation time: a recent modification counts as changed, never as new", () => {
    const g = new DateGrowthDetector({ now: NOW });
    g.observe(f(1, 10, null, ago(1)));
    expect(g.window(7).own.get(1)).toEqual({ newBytes: 0, newFiles: 0, changedBytes: 10, changedFiles: 1 });
  });

  it("boundary: exactly N days ago is inside, N days and 1 ms ago is outside", () => {
    const g = new DateGrowthDetector({ now: NOW });
    g.observe(f(1, 1, ago(7), ago(7)));
    g.observe(f(2, 1, ago(7, 1), ago(7, 1)));
    g.observe(f(3, 1, ago(400), ago(7)));
    g.observe(f(4, 1, ago(400), ago(7, 1)));
    const w = g.window(7);
    expect(w.own.get(1)?.newFiles).toBe(1);
    expect(w.own.has(2)).toBe(false);
    expect(w.own.get(3)?.changedFiles).toBe(1);
    expect(w.own.has(4)).toBe(false);
    expect(w.start).toBe(NOW - 7 * DAY_MS);
    expect(g.window(8).own.get(2)?.newFiles).toBe(1);
  });

  it("answers 1, 7, 30, 90 and 365 days from one pass without rescanning", () => {
    const g = new DateGrowthDetector({ now: NOW });
    for (const d of [0.5, 5, 20, 60, 200, 800]) g.observe(f(1, 1000, ago(d), ago(d)));
    const counts = [1, 7, 30, 90, 365].map((d) => g.window(d).own.get(1)?.newFiles ?? 0);
    expect(counts).toEqual([1, 2, 3, 4, 5]);
  });

  it("files older than maxDays are not stored; window is clamped to 1..maxDays", () => {
    const g = new DateGrowthDetector({ now: NOW, maxDays: 90 });
    g.observe(f(1, 1, ago(100), ago(100)));
    expect(g.window(1000).own.size).toBe(0);
    expect(g.window(1000).days).toBe(90);
    expect(g.window(0).days).toBe(1);
  });

  it("keeps files at or above the floor for drill-down, with new/changed kind", () => {
    const g = new DateGrowthDetector({ now: NOW, fileFloorBytes: 100 });
    g.observe(f(1, 99, ago(1), ago(1), "small"));
    g.observe(f(1, 100, ago(1), ago(1), "new"));
    g.observe(f(1, 500, ago(300), ago(1), "changed"));
    const files = g.window(30).files;
    expect(files.map((x) => [x.name, x.kind])).toEqual([
      ["new", "new"],
      ["changed", "changed"],
    ]);
    expect(g.window(30).own.get(1)?.newBytes).toBe(199);
  });

  it("counts new files per day for the timeline; changed older files are not in it", () => {
    const g = new DateGrowthDetector({ now: NOW });
    g.observe(f(1, 100, ago(0, 5), ago(0, 5)));
    g.observe(f(1, 7, NOW + 1000, NOW + 1000)); // future-dated: counted in the last 24 hours
    g.observe(f(2, 200, ago(2, 5), ago(2, 5)));
    g.observe(f(2, 300, ago(400), ago(1))); // changed, not new
    g.observe(f(3, 50, ago(9), ago(9))); // outside a 7-day window
    const byAge = g.newByAge(7);
    expect(byAge.length).toBe(8);
    expect(byAge[1]).toEqual({ bytes: 107, files: 2 });
    expect(byAge[3]).toEqual({ bytes: 200, files: 1 });
    expect(byAge.reduce((s, x) => s + x.bytes, 0)).toBe(307);
    expect(g.newByAge(7, (d) => d === 2)[3].bytes).toBe(200);
    expect(g.newByAge(7, (d) => d === 2)[1].bytes).toBe(0);
    expect(g.ownNewAtAge(1).get(1)?.newBytes).toBe(107);
    expect(g.ownNewAtAge(3).get(2)).toEqual({ newBytes: 200, newFiles: 1, changedBytes: 0, changedFiles: 0 });
    expect(g.ownNewAtAge(2).size).toBe(0);
  });

  it("caps the number of kept files, keeping the largest", () => {
    const g = new DateGrowthDetector({ now: NOW, fileFloorBytes: 1, maxFiles: 10 });
    for (let i = 1; i <= 100; i++) g.observe(f(1, i, ago(1), ago(1)));
    const files = g.window(30).files;
    expect(files.length).toBe(10);
    expect(Math.min(...files.map((x) => x.size))).toBe(91);
    expect(g.window(30).own.get(1)?.newFiles).toBe(100);
  });
});
