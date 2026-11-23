import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileEntry, ScanSink, SkippedItem } from "../src/core/types.ts";

export const DAY = 86_400_000;
export const isWindows = process.platform === "win32";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(join(tmpdir(), `dd-${prefix}-`));
}

/** Writes a file of `size` bytes and sets its modified (and accessed) time. */
export function makeFile(path: string, size: number, modifiedMs?: number): void {
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, Buffer.alloc(size, 1));
  if (modifiedMs !== undefined) fs.utimesSync(path, new Date(modifiedMs), new Date(modifiedMs));
}

/** Sets the creation time of a file (Windows only, via PowerShell). fs.utimes cannot set it. */
export function setCreated(path: string, createdMs: number): void {
  const iso = new Date(createdMs).toISOString();
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath $env:DD_P).CreationTimeUtc = [DateTime]::Parse($env:DD_T).ToUniversalTime()`], {
    env: { ...process.env, DD_P: path, DD_T: iso },
    windowsHide: true,
  });
}

/** A ScanSink that records everything, with full paths. */
export class RecordingSink implements ScanSink {
  folders: string[] = [];
  files: Array<FileEntry & { path: string }> = [];
  links: string[] = [];
  skips: SkippedItem[] = [];
  folder(parentId: number, name: string): number {
    const path = parentId < 0 ? name : `${this.folders[parentId].replace(/\\$/, "")}\\${name}`;
    this.folders.push(path);
    return this.folders.length - 1;
  }
  file(e: FileEntry): void {
    this.files.push({ ...e, path: `${this.folders[e.dirId]}\\${e.name}` });
  }
  link(parentId: number, name: string): void {
    this.links.push(`${this.folders[parentId]}\\${name}`);
  }
  skipped(item: SkippedItem): void {
    this.skips.push(item);
  }
}

export const FICTIONAL_ENV: Record<string, string> = {
  USERPROFILE: "C:\\Users\\alex",
  LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local",
  APPDATA: "C:\\Users\\alex\\AppData\\Roaming",
  TEMP: "C:\\Users\\alex\\AppData\\Local\\Temp",
  PROGRAMDATA: "C:\\ProgramData",
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  WINDIR: "C:\\Windows",
  SYSTEMDRIVE: "C:",
};
