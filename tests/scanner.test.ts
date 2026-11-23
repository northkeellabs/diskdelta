import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeBusyFiles, skipReason, WalkScanner } from "../src/scanner/walk.ts";
import { DemoScanner } from "../src/scanner/demo.ts";
import { DAY, isWindows, makeFile, RecordingSink, setCreated, tempDir } from "./helpers.ts";

const KB = 1024;
let root: string;
const now = Date.now();

beforeAll(() => {
  root = tempDir("walk");
  makeFile(join(root, "a.bin"), 10 * KB, now - 2 * DAY);
  makeFile(join(root, "sub", "b.bin"), 3 * KB, now - 40 * DAY);
  makeFile(join(root, "sub", "deep", "c.bin"), 7 * KB, now - 400 * DAY);
  makeFile(join(root, "empty-dir", ".keep"), 0);
  fs.mkdirSync(join(root, "target"), { recursive: true });
  makeFile(join(root, "target", "big.bin"), 50 * KB);
});

afterAll(() => {
  if (isWindows) {
    try {
      execFileSync("icacls", [join(root, "locked"), "/remove:d", process.env.USERNAME ?? "*S-1-1-0"], { stdio: "ignore" });
    } catch {
      // not created
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WalkScanner", () => {
  it("reports every folder and file with exact sizes and modified times", async () => {
    const sink = new RecordingSink();
    const stats = await new WalkScanner().scan(root, sink);
    const byName = Object.fromEntries(sink.files.map((f) => [f.name, f]));
    expect(byName["a.bin"].size).toBe(10 * KB);
    expect(byName["b.bin"].size).toBe(3 * KB);
    expect(byName["c.bin"].size).toBe(7 * KB);
    expect(Math.abs(byName["a.bin"].modified - (now - 2 * DAY))).toBeLessThan(2000);
    expect(Math.abs(byName["c.bin"].modified - (now - 400 * DAY))).toBeLessThan(2000);
    expect(stats.files).toBe(sink.files.length);
    expect(stats.bytes).toBe(sink.files.reduce((s, f) => s + f.size, 0));
    expect(stats.folders).toBe(sink.folders.length);
    expect(sink.folders.map((f) => f.slice(root.length))).toEqual(expect.arrayContaining(["", "\\sub", "\\sub\\deep", "\\empty-dir", "\\target"]));
    expect(stats.cancelled).toBe(false);
  });

  it("reports allocated size on Windows (cluster-rounded, at least the apparent size for non-resident files)", async () => {
    if (!isWindows) return;
    const sink = new RecordingSink();
    await new WalkScanner().scan(root, sink);
    const big = sink.files.find((f) => f.name === "big.bin")!;
    expect(big.allocated).not.toBeNull();
    expect(big.allocated!).toBeGreaterThanOrEqual(50 * KB);
    expect(big.allocated! % 512).toBe(0);
  });

  it("reads creation time; created can differ from modified (set with PowerShell, fs.utimes cannot set it)", async () => {
    if (!isWindows) return;
    const p = join(root, "created-test.bin");
    makeFile(p, KB, now - 1 * DAY);
    setCreated(p, now - 100 * DAY);
    const sink = new RecordingSink();
    await new WalkScanner().scan(root, sink);
    const f = sink.files.find((x) => x.name === "created-test.bin")!;
    expect(f.created).not.toBeNull();
    expect(Math.abs(f.created! - (now - 100 * DAY))).toBeLessThan(2000);
    expect(Math.abs(f.modified - (now - 1 * DAY))).toBeLessThan(2000);
    fs.unlinkSync(p);
  });

  it("does not follow junctions or symlinks; counts them as links", async () => {
    const dir = tempDir("links");
    try {
      makeFile(join(dir, "real", "x.bin"), 5 * KB);
      fs.symlinkSync(join(root, "target"), join(dir, "junction-to-target"), "junction");
      let fileLink = false;
      try {
        fs.symlinkSync(join(dir, "real", "x.bin"), join(dir, "file-link.bin"), "file");
        fileLink = true;
      } catch {
        // file symlinks need Developer Mode or admin on Windows; junctions do not
      }
      const sink = new RecordingSink();
      const stats = await new WalkScanner().scan(dir, sink);
      expect(sink.files.map((f) => f.name)).toEqual(["x.bin"]);
      expect(sink.files.some((f) => f.name === "big.bin")).toBe(false);
      expect(sink.links.some((l) => l.endsWith("junction-to-target"))).toBe(true);
      expect(stats.links).toBe(fileLink ? 2 : 1);
      expect(stats.bytes).toBe(5 * KB);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start at a junction", async () => {
    const dir = tempDir("rootlink");
    try {
      fs.symlinkSync(join(root, "target"), join(dir, "j"), "junction");
      await expect(new WalkScanner().scan(join(dir, "j"), new RecordingSink())).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a hard-linked file once", async () => {
    const dir = tempDir("hard");
    try {
      makeFile(join(dir, "one.bin"), 8 * KB);
      fs.mkdirSync(join(dir, "other"));
      fs.linkSync(join(dir, "one.bin"), join(dir, "other", "two.bin"));
      const sink = new RecordingSink();
      const stats = await new WalkScanner().scan(dir, sink);
      expect(stats.files).toBe(1);
      expect(stats.bytes).toBe(8 * KB);
      expect(stats.hardLinkDuplicates).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a folder it cannot read as skipped (access denied), and keeps going", async () => {
    if (!isWindows) return;
    const locked = join(root, "locked");
    makeFile(join(locked, "secret.bin"), KB);
    execFileSync("icacls", [locked, "/deny", `${process.env.USERNAME}:(RX)`], { stdio: "ignore" });
    try {
      const sink = new RecordingSink();
      const stats = await new WalkScanner().scan(root, sink);
      const s = sink.skips.find((x) => x.path === locked);
      expect(s).toBeDefined();
      expect(s!.reason).toBe("access_denied");
      expect(s!.kind).toBe("folder");
      expect(stats.skipped).toBeGreaterThanOrEqual(1);
      expect(sink.files.some((f) => f.name === "a.bin")).toBe(true);
    } finally {
      execFileSync("icacls", [locked, "/remove:d", process.env.USERNAME!], { stdio: "ignore" });
      fs.rmSync(locked, { recursive: true, force: true });
    }
  });

  it("maps error codes to skip reasons (too long, in use, not found)", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(skipReason(err("EACCES"))).toBe("access_denied");
    expect(skipReason(err("EPERM"))).toBe("access_denied");
    expect(skipReason(err("ENAMETOOLONG"))).toBe("path_too_long");
    expect(skipReason(err("EBUSY"))).toBe("in_use");
    expect(skipReason(err("ENOENT"))).toBe("not_found");
    expect(skipReason(err("EIO"))).toBe("error");
    // fail one folder with "path too long" and check it is reported as skipped with that reason
    const orig = fs.promises.readdir;
    const wrapped = vi.fn((p: any, o: any) => (String(p).endsWith("\\deep") ? Promise.reject(err("ENAMETOOLONG")) : orig.call(fs.promises, p, o)));
    (fs.promises as any).readdir = wrapped;
    try {
      const sink = new RecordingSink();
      await new WalkScanner().scan(root, sink);
      const s = sink.skips.find((x) => x.path.endsWith("\\sub\\deep"));
      expect(s?.reason).toBe("path_too_long");
    } finally {
      (fs.promises as any).readdir = orig;
    }
  });

  it("stops when cancelled and says so", async () => {
    const ac = new AbortController();
    ac.abort();
    const stats = await new WalkScanner().scan(root, new RecordingSink(), { signal: ac.signal });
    expect(stats.cancelled).toBe(true);
    expect(stats.files).toBe(0);
  });

  it("sends progress events", async () => {
    const seen: number[] = [];
    await new WalkScanner().scan(root, new RecordingSink(), { onProgress: (p) => seen.push(p.files), progressIntervalMs: 0 });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("sizes a file from its directory entry with PowerShell Get-Item (used for locked files)", async () => {
    if (!isWindows) return;
    const p = join(root, "a.bin");
    const m = await probeBusyFiles([p]);
    expect(m.get(p.toLowerCase())?.length).toBe(10 * KB);
  });
});

describe("read-only guarantee", () => {
  const WRITE_NAMES = /^(open|openSync|write|writeSync|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|truncate|truncateSync|ftruncate|chmod|chmodSync|lchmod|chown|chownSync|lchown|utimes|utimesSync|lutimes|futimes|symlink|symlinkSync|link|linkSync|opendir|opendirSync)$/;

  it("the scanner calls only readdir and lstat, and never opens anything for writing (every fs function spied)", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const restore: Array<() => void> = [];
    for (const [obj, prefix] of [
      [fs, "fs."],
      [fs.promises, "fs.promises."],
    ] as const) {
      for (const name of Object.keys(obj)) {
        const orig = (obj as any)[name];
        if (typeof orig !== "function" || /^[A-Z]/.test(name)) continue;
        try {
          (obj as any)[name] = function (this: unknown, ...args: unknown[]) {
            // record calls that touch the scanned tree (ignores the test runner's own file activity)
            if (args.some((a) => typeof a === "string" && a.toLowerCase().startsWith(root.toLowerCase()))) calls.push({ name: prefix + name, args });
            return orig.apply(this, args);
          };
          restore.push(() => ((obj as any)[name] = orig));
        } catch {
          // read-only property
        }
      }
    }
    try {
      await new WalkScanner({ probeBusyFiles: false }).scan(root, new RecordingSink());
    } finally {
      restore.forEach((r) => r());
    }
    const names = new Set(calls.map((c) => c.name));
    expect(calls.length).toBeGreaterThan(5);
    expect([...names].sort()).toEqual(["fs.promises.lstat", "fs.promises.readdir"]);
    for (const c of calls) {
      const short = c.name.split(".").pop()!;
      expect(WRITE_NAMES.test(short), c.name).toBe(false);
      // no call carried open flags or a write mode
      for (const a of c.args) if (a && typeof a === "object") expect(Object.keys(a as object)).not.toContain("flag");
    }
  });

  it("scanning leaves every file's size and modified time unchanged", async () => {
    const before = fs.readdirSync(root, { recursive: true }).map((n) => {
      const st = fs.lstatSync(join(root, String(n)));
      return [String(n), st.size, st.mtimeMs];
    });
    await new WalkScanner().scan(root, new RecordingSink());
    const after = fs.readdirSync(root, { recursive: true }).map((n) => {
      const st = fs.lstatSync(join(root, String(n)));
      return [String(n), st.size, st.mtimeMs];
    });
    expect(after).toEqual(before);
  });

  it("scanner source contains no write, delete, rename or attribute API", () => {
    for (const f of ["src/scanner/walk.ts", "src/scanner/demo.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\b(writeFile|appendFile|createWriteStream|unlink|rmdir|rmSync|\.rm\(|rename|copyFile|truncate|chmod|chown|utimes|mkdir|symlink|\.open\(|openSync|Set-ItemProperty|Remove-Item|Move-Item|Rename-Item|attrib)\b/);
    }
    const walk = fs.readFileSync("src/scanner/walk.ts", "utf8");
    const ps = walk.match(/"\$ErrorActionPreference[\s\S]*?ConvertTo-Json[^"]*"/)?.[0] ?? "";
    expect(ps).toContain("Get-Item");
    expect(ps).not.toMatch(/Set-|Remove-|Move-|New-Item|Out-File|>/);
  });
});

describe("DemoScanner", () => {
  it("produces the same fictional tree for the same clock and never touches the disk", async () => {
    const t = 1_800_000_000_000;
    const a = new RecordingSink();
    const b = new RecordingSink();
    await new DemoScanner(() => t).scan("C:\\", a);
    await new DemoScanner(() => t).scan("C:\\", b);
    expect(a.files.length).toBeGreaterThan(1000);
    expect(a.files.map((f) => f.size)).toEqual(b.files.map((f) => f.size));
    expect(a.skips.map((s) => s.reason)).toEqual(expect.arrayContaining(["access_denied", "path_too_long"]));
    expect(a.links.length).toBeGreaterThan(0);
    expect(a.files.every((f) => f.path.startsWith("C:\\"))).toBe(true);
  });

  it("scans a subfolder of the fictional PC and rejects a folder that does not exist", async () => {
    const s = new RecordingSink();
    await new DemoScanner().scan("C:\\Users\\demo\\.ollama", s);
    expect(s.files.some((f) => f.name.startsWith("sha256-"))).toBe(true);
    await expect(new DemoScanner().scan("C:\\Nope", new RecordingSink())).rejects.toThrow(/ENOENT/);
  });
});
