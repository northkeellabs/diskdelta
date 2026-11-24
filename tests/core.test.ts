import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore } from "../src/app.ts";
import { DiskDeltaCore } from "../src/core/api.ts";
import { DateGrowthDetector } from "../src/growth/detector.ts";
import { PatternRulesEngine, type RulesFile } from "../src/rules/engine.ts";
import { WalkScanner } from "../src/scanner/walk.ts";
import { MemorySnapshotStore } from "../src/snapshot/store.ts";
import type { DriveProvider } from "../src/core/types.ts";
import { DAY, isWindows, makeFile, setCreated, tempDir } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 23, 12);
let core: DiskDeltaCore;
const cleanup: string[] = [];

beforeAll(async () => {
  core = createCore({ demo: true, clock: () => NOW });
  core.startScan(["C:\\"]);
  const job = await core.waitForJob();
  expect(job?.state).toBe("done");
});
afterAll(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("Core API on the demo PC", () => {
  it("lists drives with used percent and marks the scanned one", async () => {
    const d = await core.listDrives();
    const c = d.find((x) => x.letter === "C")!;
    expect(c.usedPct).toBeGreaterThan(90);
    expect(c.scannedAt).not.toBeNull();
    expect(d.find((x) => x.type === "network")?.scanByDefault).toBe(false);
    expect(d.find((x) => x.type === "cloud")?.scanByDefault).toBe(false);
  });

  it("summarises the scan, with skipped folders and links counted", () => {
    const [s] = core.scans();
    expect(s.root).toBe("C:\\");
    expect(s.files).toBeGreaterThan(1000);
    expect(s.skipped).toBe(4);
    expect(s.links).toBe(5);
    expect(s.snapshotId).not.toBeNull();
  });

  it("whatGrew rows do not overlap and do not exceed the total", () => {
    const g = core.whatGrew("C:\\", { days: 30, limit: 200 });
    const sumNew = g.rows.reduce((a, r) => a + r.newBytes, 0);
    const sumChanged = g.rows.reduce((a, r) => a + r.changedBytes, 0);
    expect(sumNew).toBeLessThanOrEqual(g.total.newBytes + 1);
    expect(sumNew).toBeGreaterThan(g.total.newBytes * 0.9);
    expect(sumChanged).toBeLessThanOrEqual(g.total.changedBytes + 1);
    expect(sumChanged).toBeGreaterThan(g.total.changedBytes * 0.9);
    // rows are ranked by new bytes
    const news = g.rows.map((r) => r.newBytes);
    expect([...news].sort((a, b) => b - a)).toEqual(news);
    const unitRows = g.rows.filter((r) => r.scope === "all" || r.scope === "group");
    for (const a of unitRows) for (const b of unitRows) if (a !== b) expect(b.path.toLowerCase().startsWith(a.path.toLowerCase().replace(/\*$/, "") + "\\")).toBe(false);
  });

  it("whatGrew finds the model store, the Docker disk, the temp test-run group and the unknown app", () => {
    const rows = core.whatGrew("C:\\", { days: 30, limit: 50 }).rows;
    const find = (s: string) => rows.find((r) => r.path.endsWith(s));
    expect(find(".ollama\\models")?.label).toBe("check_first");
    expect(find(".ollama\\models")!.newBytes).toBeGreaterThan(30 * 1024 ** 3);
    const docker = find("Docker\\wsl")!;
    expect(docker.changedBytes).toBeGreaterThan(40 * 1024 ** 3);
    expect(docker.newBytes).toBe(0);
    const grp = rows.find((r) => r.scope === "group")!;
    expect(grp.path).toMatch(/Temp\\vitest-\*$/);
    expect(grp.label).toBe("safe");
    const vm = find("Claude\\vm_bundles")!;
    expect(vm.label).toBe("do_not_touch");
    const foo = rows.find((r) => r.path.includes("\\Fooware"))!;
    expect(foo.known).toBe(false);
    expect(foo.owner).toBe("Fooware");
  });

  it("never adds new and changed bytes together in any view or the report", async () => {
    const g = core.whatGrew("C:\\", { days: 30 });
    for (const o of [g.total, ...g.rows, core.folder("C:\\").self, ...core.cleanupPlan("C:\\").candidates]) expect(Object.keys(o)).not.toContain("recentBytes");
    const tm = core.treemap("C:\\");
    expect(Object.keys(tm)).not.toContain("recentBytes");
    for (const fmt of ["md", "html"] as const) expect(await core.report(fmt)).not.toMatch(/new or changed/i);
  });

  it("timeline bars add up to the new files of the window and the day view explains a bar", () => {
    const tl = core.timeline("C:\\", { days: 30 });
    expect(tl.bars.length).toBe(30);
    expect(tl.bars[0].age).toBe(30);
    expect(tl.bars.at(-1)!.age).toBe(1);
    const g = core.whatGrew("C:\\", { days: 30 });
    expect(tl.total.newBytes).toBe(g.total.newBytes);
    expect(Object.keys(tl.bars[0])).not.toContain("changedBytes");
    const biggest = [...tl.bars].sort((a, b) => b.newBytes - a.newBytes)[0];
    const d = core.timelineDay("C:\\", { age: biggest.age });
    expect(d.total.newBytes).toBe(biggest.newBytes);
    expect(d.total.changedBytes).toBe(0);
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.rows.reduce((s, r) => s + r.newBytes, 0)).toBeLessThanOrEqual(biggest.newBytes + 1);
    const sub = core.timeline("C:\\Users\\demo\\.ollama", { days: 30 });
    expect(sub.total.newBytes).toBe(core.whatGrew("C:\\Users\\demo\\.ollama", { days: 30 }).total.newBytes);
    expect(() => core.timelineDay("C:\\", { age: 0 })).toThrow(/age/);
  });

  it("treemap nodes carry the rule category, so personal folders can be coloured apart", () => {
    const tm = core.treemap("C:\\Users\\demo", { depth: 1 });
    expect(tm.children!.find((c) => c.name === "Videos")?.category).toBe("personal");
  });

  it("container nodes carry a per-label byte mix that covers the whole subtree, largest first; other nodes carry none", () => {
    const tm = core.treemap("C:\\", { depth: 2 });
    const users = tm.children!.find((c) => c.name === "Users")!;
    expect(users.category).toBe("container");
    const mix = users.mix!;
    expect(mix.reduce((s, m) => s + m.bytes, 0)).toBe(users.bytes);
    expect(mix.map((m) => m.bytes)).toEqual([...mix.map((m) => m.bytes)].sort((a, b) => b - a));
    expect(new Set(mix.map((m) => m.key)).size).toBe(mix.length);
    expect(mix.every((m) => ["safe", "check_first", "do_not_touch", "unknown", "personal", "loose"].includes(m.key))).toBe(true);
    // the mix is there even at the outermost drawn level
    const deep = core.treemap("C:\\", { depth: 3 }).children!.find((c) => c.name === "Users")!.children![0].children!.find((c) => c.name === "AppData")!;
    expect(deep.mix).toBeDefined();
    expect(deep.mix![0].key).toBe("check_first");
    expect(deep.mix![0].bytes / deep.bytes).toBeGreaterThanOrEqual(0.6);
    expect(core.treemap("C:\\Users\\demo\\Videos", { depth: 1 }).mix).toBeUndefined();
  });

  it("a shorter window shows less", () => {
    const a = core.whatGrew("C:\\", { days: 7 }).total.newBytes;
    const b = core.whatGrew("C:\\", { days: 90 }).total.newBytes;
    expect(a).toBeLessThan(b);
  });

  it("changedOld lists big old files that changed recently, with growth unknown", () => {
    const c = core.changedOld("C:\\", { days: 30 });
    const names = c.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["docker_data.vhdx", "ext4.vhdx", "rootfs.vhdx", "pagefile.sys"]));
    expect(c.files.every((f) => f.kind === "changed")).toBe(true);
  });

  it("cleanupPlan never offers do_not_touch or personal folders, ranks safe first, and groups temp folders", () => {
    const p = core.cleanupPlan("C:\\", { days: 30, limit: 200 });
    expect(p.candidates.length).toBeGreaterThan(5);
    expect(p.candidates.some((c) => c.label === "do_not_touch")).toBe(false);
    expect(p.candidates.some((c) => /\\(Documents|Pictures|Videos)$/i.test(c.path))).toBe(false);
    const ranks = p.candidates.map((c) => (!c.known ? 2 : c.label === "safe" ? 0 : 1));
    expect([...ranks].sort()).toEqual(ranks);
    expect(p.candidates.find((c) => c.path.endsWith("vitest-*"))?.groupCount).toBe(36);
    expect(p.candidates.find((c) => c.path.endsWith("Documents\\projects\\webapp\\node_modules"))?.label).toBe("check_first");
    expect(p.candidates.find((c) => c.path.endsWith("dev\\shop-api\\node_modules"))?.label).toBe("safe");
    expect(p.candidates.find((c) => c.path.endsWith("Fooware"))?.known).toBe(false);
    expect(p.candidates.find((c) => c.path.endsWith(".ollama\\models"))?.reclaim).toContain("ollama rm");
    expect(p.note).toMatch(/never deletes/);
  });

  it("folder view drills down with children sorted by size", () => {
    const f = core.folder("C:\\Users\\demo", { days: 30 });
    expect(f.children.length).toBeGreaterThan(3);
    const sizes = f.children.map((c) => c.bytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(f.self.bytes).toBe(f.children.reduce((s, c) => s + c.bytes, 0) + f.own.bytes);
    expect(f.parent).toBe("C:\\Users");
  });

  it("treemap children add up to the parent", () => {
    const t = core.treemap("C:\\", { depth: 2 });
    expect(t.children!.reduce((s, c) => s + c.bytes, 0)).toBeCloseTo(t.bytes, -1);
  });

  it("explain works with and without a scan", () => {
    const e = core.explain("C:\\Users\\demo\\AppData\\Roaming\\Claude\\vm_bundles");
    expect(e.scanned).toBe(true);
    expect(e.classification.label).toBe("do_not_touch");
    expect(e.size!.bytes).toBeGreaterThan(9 * 1024 ** 3);
    const n = core.explain("D:\\Renders");
    expect(n.scanned).toBe(false);
    expect(n.classification.known).toBe(false);
  });

  it("rejects relative paths, unscanned paths and bad windows with clear errors", () => {
    expect(() => core.whatGrew("Users\\demo")).toThrow(/absolute/);
    expect(() => core.whatGrew("D:\\")).toThrow(/Not scanned yet/);
    expect(() => core.whatGrew("C:\\", { days: 0 })).toThrow(/1 to 365/);
  });

  it("lists skipped folders with reasons", () => {
    const s = core.skipped();
    expect(s.byReason.access_denied).toBe(3);
    expect(s.byReason.path_too_long).toBe(1);
  });

  it("report renders Markdown and HTML; export writes a new file and never overwrites", async () => {
    const md = await core.report("md", { days: 30 });
    expect(md).toContain("# [DiskDelta](https://github.com/northkeellabs/diskdelta) report");
    expect(md).toContain("Made with [DiskDelta](https://github.com/northkeellabs/diskdelta) by [Northkeel Labs](https://northkeellabs.com) ([https://northkeellabs.com/diskdelta](https://northkeellabs.com/diskdelta)).");
    // no mention is left as plain text: strip every link, then no name remains outside the paths (backticked) and the heading
    expect(md.replace(/\[[^\]]*\]\(https:[^)]*\)/g, "").replace(/`[^`]*`/g, "")).not.toMatch(/DiskDelta|Northkeel Labs|northkeellabs\.com/);
    expect(md).toContain("DEMO data");
    expect(md).toContain("Changed recently, growth amount unknown");
    const html = await core.report("html");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/https?:\/\/(?!northkeellabs\.com|github\.com\/northkeellabs\/diskdelta)/);
    const A = ' target="_blank" rel="noopener noreferrer"';
    expect(html).toContain(`<h1><a href="https://github.com/northkeellabs/diskdelta"${A}>DiskDelta</a> report</h1>`);
    expect(html).toContain(`<p>Made with <a href="https://github.com/northkeellabs/diskdelta"${A}>DiskDelta</a> by <a href="https://northkeellabs.com"${A}>Northkeel Labs</a> (<a href="https://northkeellabs.com/diskdelta"${A}>https://northkeellabs.com/diskdelta</a>).</p>`);
    expect(html).toContain("<title>DiskDelta report</title>"); // the page title cannot hold a link
    // outside the <title>, every mention sits inside an <a>
    const bare = html.replace("<title>DiskDelta report</title>", "").replace(/<a [^>]*>[^<]*<\/a>/g, "");
    expect(bare).not.toMatch(/DiskDelta|Northkeel Labs|northkeellabs\.com/);
    const dir = tempDir("export");
    cleanup.push(dir);
    const target = join(dir, "r.md");
    const r = await core.exportReport("md", target);
    expect(r.bytes).toBeGreaterThan(500);
    await expect(core.exportReport("md", target)).rejects.toThrow(/already exists/);
    await expect(core.exportReport("html", join(dir, "r.txt"))).rejects.toThrow(/\.html/);
    await expect(core.exportReport("md", "relative.md")).rejects.toThrow(/full path/);
    await expect(core.exportReport("md", join(dir, "missing", "r.md"))).rejects.toThrow(/does not exist/);
  });

  it("refuses a second scan while one runs, and can cancel", async () => {
    const c2 = createCore({ demo: true, clock: () => NOW });
    c2.startScan(["C:\\", "D:\\"]);
    expect(() => c2.startScan(["E:\\"])).toThrow(/already running/);
    expect(c2.cancelScan()).toBe(true);
    const j = await c2.waitForJob();
    expect(j?.state).toBe("cancelled");
  });

  it("ensureScanned reuses a fresh scan that covers the path", async () => {
    const before = core.scans()[0].finishedAt;
    const s = await core.ensureScanned("C:\\Users\\demo\\AppData", 60 * 60_000 * 24 * 365 * 100);
    expect(s.root).toBe("C:\\");
    expect(core.scans()[0].finishedAt).toBe(before);
  });
});

describe("Core API with the real folder walker", () => {
  it("scans a temp tree and reports growth per folder, labels and changed files", async () => {
    const root = tempDir("core");
    cleanup.push(root);
    const now = Date.now();
    makeFile(join(root, "node_modules", "lib.js"), 2 * 1024 * 1024, now - 2 * DAY);
    makeFile(join(root, "old", "archive.bin"), 3 * 1024 * 1024, now - 300 * DAY);
    if (isWindows) setCreated(join(root, "old", "archive.bin"), now - 300 * DAY);
    // created today with an old modified date (like a copied or extracted file): counts as new
    makeFile(join(root, "copied", "photo.jpg"), 4096, now - 500 * DAY);
    makeFile(join(root, "notes.txt"), 1024, now - 1 * DAY);
    const drives: DriveProvider = { list: async () => [] };
    const c = new DiskDeltaCore({
      mode: "live",
      drives,
      scanner: new WalkScanner(),
      rules: new PatternRulesEngine(JSON.parse(fs.readFileSync("rules/rules.json", "utf8")) as RulesFile, process.env),
      snapshots: new MemorySnapshotStore(),
      growthFactory: (n) => new DateGrowthDetector({ now: n }),
    });
    c.startScan([root]);
    expect((await c.waitForJob())?.state).toBe("done");
    const f = c.folder(root, { days: 30 });
    const nm = f.children.find((x) => x.name === "node_modules")!;
    expect(nm.label).toBe("safe");
    expect(nm.ruleId).toBe("node-modules");
    expect(nm.bytes).toBe(2 * 1024 * 1024);
    expect(f.self.bytes).toBe(5 * 1024 * 1024 + 1024 + 4096);
    if (isWindows) expect(f.children.find((x) => x.name === "old")!.newBytes + f.children.find((x) => x.name === "old")!.changedBytes).toBe(0);
    expect(f.children.find((x) => x.name === "copied")!.newBytes).toBe(4096);
    if (isWindows) expect(c.whatGrew(root, { days: 30 }).total.newBytes).toBe(2 * 1024 * 1024 + 1024 + 4096);
  });
});
