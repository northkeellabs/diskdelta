#!/usr/bin/env node
// Builds docs/demo/index.html: the DiskDelta page running entirely in the browser on the fictional demo PC.
// One self-contained file (page, styles and the in-browser Core API), no server, no network, no external assets.
// Run after npm run gen (npm run build:demo does both).

import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const NONCE = "diskdelta-demo";

// Core modules import node:fs only for features the browser demo never calls (report export to disk).
const stubNodeFs = {
  name: "stub-node-fs",
  setup(b) {
    b.onResolve({ filter: /^node:fs$/ }, () => ({ path: "node-fs-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "const no = () => { throw new Error('No file system in the browser demo'); }; export default { existsSync: () => false, promises: { writeFile: no } };",
      loader: "js",
    }));
  },
};

const res = await build({
  entryPoints: ["src/ui/static-demo.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome110", "edge110", "firefox115", "safari16"],
  minify: true,
  write: false,
  legalComments: "none",
  plugins: [stubNodeFs],
  logLevel: "warning",
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

let page = readFileSync("src/ui/page.html", "utf8").replaceAll("__NONCE__", NONCE);
const csp = `default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'nonce-${NONCE}'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
page = page.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
page = page.replace("<title>DiskDelta</title>", "<title>DiskDelta demo</title>\n<!-- Static browser demo built by scripts/build-demo-site.mjs. All data is invented. -->");
const marker = `<script nonce="${NONCE}">`;
const at = page.indexOf(marker);
if (at < 0) throw new Error("page script not found");
page = page.slice(0, at) + `<script nonce="${NONCE}">${js}</script>\n` + page.slice(at);
mkdirSync("docs/demo", { recursive: true });
writeFileSync("docs/demo/index.html", page);
console.log(`docs/demo/index.html  ${(page.length / 1024).toFixed(0)} KB`);
