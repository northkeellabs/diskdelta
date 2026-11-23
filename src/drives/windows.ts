// WindowsDriveProvider: lists drives with one read-only CIM query (Win32_LogicalDisk) through PowerShell.
// No admin rights needed. If PowerShell is unavailable it falls back to fs.statfs on each drive letter
// (sizes only, type "unknown").
//
// Type detection: DriveType 2 removable, 3 fixed, 4 network, 5 optical, 6 RAM disk. Cloud drives (Google Drive for
// desktop, and others that mount as a drive letter) report as fixed or network; they are recognised by volume label
// or file system and marked "cloud". Network, cloud and optical drives are listed but not scanned unless chosen.

import { execFile } from "node:child_process";
import fs from "node:fs";
import type { DriveInfo, DriveProvider, DriveType } from "../core/types.ts";

const CLOUD_LABEL = /google drive|onedrive|dropbox|icloud|box drive|pcloud|mega/i;

interface CimDisk {
  DeviceID: string;
  VolumeName: string | null;
  DriveType: number;
  FileSystem: string | null;
  Size: number | null;
  FreeSpace: number | null;
  ProviderName: string | null;
}

export function driveFromCim(d: CimDisk): DriveInfo {
  const letter = d.DeviceID.slice(0, 1).toUpperCase();
  let type: DriveType =
    d.DriveType === 2 ? "removable" : d.DriveType === 3 ? "fixed" : d.DriveType === 4 ? "network" : d.DriveType === 5 ? "optical" : d.DriveType === 6 ? "ram" : "unknown";
  const label = d.VolumeName ?? "";
  if (CLOUD_LABEL.test(label) || /^(DriveFS|GoogleDriveFS)$/i.test(d.FileSystem ?? "")) type = "cloud";
  return {
    root: `${letter}:\\`,
    letter,
    label,
    type,
    fileSystem: d.FileSystem ?? "",
    size: Number(d.Size ?? 0),
    free: Number(d.FreeSpace ?? 0),
    ...(d.ProviderName ? { remotePath: d.ProviderName } : {}),
    scanByDefault: type === "fixed" || type === "removable",
  };
}

function cimQuery(): Promise<CimDisk[]> {
  const script =
    "Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,FileSystem,Size,FreeSpace,ProviderName | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const v = JSON.parse(stdout || "[]");
        resolve(Array.isArray(v) ? v : [v]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function statfsFallback(): Promise<DriveInfo[]> {
  const out: DriveInfo[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    try {
      const s = await fs.promises.statfs(`${letter}:\\`);
      out.push({ root: `${letter}:\\`, letter, label: "", type: "unknown", fileSystem: "", size: s.blocks * s.bsize, free: s.bavail * s.bsize, scanByDefault: true });
    } catch {
      // no drive here
    }
  }
  return out;
}

export class WindowsDriveProvider implements DriveProvider {
  async list(): Promise<DriveInfo[]> {
    try {
      const disks = await cimQuery();
      return disks.filter((d) => d && typeof d.DeviceID === "string").map(driveFromCim).sort((a, b) => a.letter.localeCompare(b.letter));
    } catch {
      return statfsFallback();
    }
  }
}
