#!/usr/bin/env node
// Builds the portable Windows exe with Node's single executable applications (SEA) feature:
//   1. esbuild bundles everything (dependencies included) into one CommonJS file
//   2. node --experimental-sea-config turns it into a blob
//   3. a copy of this machine's node.exe gets the blob injected with postject
// Then writes SHA-256 checksums for the exe and the npm package tarball. Output: dist/release/.
// The exe is unsigned.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const sea = "dist/sea";
const rel = "dist/release";
rmSync(sea, { recursive: true, force: true });
rmSync(rel, { recursive: true, force: true });
mkdirSync(sea, { recursive: true });
mkdirSync(rel, { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: `${sea}/diskdelta.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
});

writeFileSync(
  `${sea}/sea-config.json`,
  JSON.stringify({ main: `${sea}/diskdelta.cjs`, output: `${sea}/sea-prep.blob`, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2),
);
execFileSync(process.execPath, ["--experimental-sea-config", `${sea}/sea-config.json`], { stdio: "inherit" });

const exe = join(rel, `diskdelta-${pkg.version}-win-x64.exe`);
copyFileSync(process.execPath, exe);
const postject = join("node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", `${sea}/sea-prep.blob`, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });

// npm package tarball (npm pack only writes a file; nothing is published)
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--pack-destination", rel], { stdio: "inherit", shell: process.platform === "win32" });

const lines = [];
for (const name of readdirSync(rel).filter((n) => n.endsWith(".exe") || n.endsWith(".tgz")).sort()) {
  const buf = readFileSync(join(rel, name));
  lines.push(`${createHash("sha256").update(buf).digest("hex")}  ${name}`);
  console.log(`${name}  ${(statSync(join(rel, name)).size / 1024 / 1024).toFixed(1)} MB`);
}
writeFileSync(join(rel, "SHA256SUMS.txt"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
