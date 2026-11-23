#!/usr/bin/env node
// Runs a TypeScript script: bundles it with esbuild into node_modules/.cache and imports it. Extra args pass through.
//   node scripts/run-ts.mjs scripts/eval-labels.ts [args]

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/run-ts.mjs <file.ts> [args]");
  process.exit(2);
}
mkdirSync("node_modules/.cache/run-ts", { recursive: true });
const outfile = resolve("node_modules/.cache/run-ts", basename(entry).replace(/\.ts$/, ".mjs"));
await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node22", outfile, packages: "external", logLevel: "warning" });
process.argv.splice(2, 1);
await import(pathToFileURL(outfile).href);
